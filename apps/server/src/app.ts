import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import type { Db } from './db/connection.js';
import type { Config } from './config.js';
import { COOKIE, principalFromSession, principalFromDevice, type Principal } from './auth/sessions.js';
import * as remote from './services/remote.js';
import { identify } from './services/devices.js';
import { isHttpError } from './lib/errors.js';
import { healthRoutes } from './routes/health.js';
import { setupRoutes } from './routes/setup.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { adminRoutes } from './routes/admin.js';
import { jobRoutes } from './routes/jobs.js';
import { registryRoutes } from './routes/registry.js';
import { peopleRoutes } from './routes/people.js';
import { ppmRoutes } from './routes/ppm.js';
import { powerRoutes } from './routes/power.js';
import { storeRoutes } from './routes/stores.js';
import { moneyRoutes } from './routes/money.js';
import { safetyRoutes } from './routes/safety.js';
import { reportRoutes } from './routes/reports.js';
import { attachmentRoutes } from './routes/attachments.js';
import { exportRoutes } from './routes/exports.js';
import { retireRoutes } from './routes/retire.js';
import { alertRoutes } from './routes/alerts.js';
import { dutyRoutes } from './routes/duty.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    appVersion: string;
  }
  interface FastifyRequest {
    principal: Principal | null;
    /**
     * Where this request came from: the property network, or through the tunnel from
     * outside it. Decided once per request from the socket, never from a header a caller
     * could set.
     */
    origin: remote.Origin;
    /** Set only when the caller is a paired phone rather than a browser. */
    deviceId: string | null;
  }
}

export const APP_VERSION = '0.1.0';

/**
 * The built client, if it has been built. Resolves the same from `dist` and from
 * `src` under tsx, so `npm run dev` and `npm start` behave identically.
 */
function clientDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const guess = path.resolve(here, '../../web/dist');
  return fs.existsSync(path.join(guess, 'index.html')) ? guess : null;
}

export async function buildApp(
  db: Db, config: Config,
  /** Present only for the second, HTTPS server. The HTTP one is built without it. */
  tls?: { key: string; cert: string }
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.FF_LOG_LEVEL ?? 'info' },
    trustProxy: false,
    bodyLimit: 2 * 1024 * 1024,
    ...(tls ? { https: { key: tls.key, cert: tls.cert } } : {}),
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('appVersion', APP_VERSION);
  app.decorateRequest('principal', null);
  app.decorateRequest('deviceId', null);

  await app.register(cookie);
  // 8 MB ceiling: the client resizes photos to roughly 250 KB before sending, so
  // anything near this is an unresized import rather than a phone camera.
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 6 } });

  /*
   * Resolve the signed-in principal once per request; guards read it from there.
   *
   * Two doors, one room. A browser presents a session cookie; a paired phone presents a
   * device token it was given at enrolment and has held ever since. Both end as the same
   * Principal with the same grants, so no permission can behave one way on the website
   * and another in the app.
   *
   * The cookie is tried first: on the host PC's own browser both could in principle be
   * present, and the session is the one with a password behind it.
   */
  app.addHook('onRequest', async (req) => {
    // Answered once per request, from the socket rather than a header, and carried for
    // the rest of the pipeline: the permission check below, the audit entry, and the
    // session list all need the same answer.
    req.origin = remote.originOf(req);

    const sid = req.cookies?.[COOKIE];
    if (sid) {
      req.principal = principalFromSession(db, sid);
      if (req.principal) return;
    }
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const who = identify(db, auth.slice(7).trim());
      req.principal = who ? principalFromDevice(db, who.userId) : null;
      // Carried so the event stream can mark this exact phone as connected, and so the
      // supervisor's screen can tell one of somebody's devices from another.
      if (who) req.deviceId = who.deviceId;
      return;
    }
    req.principal = null;
  });

  /**
   * The remote boundary.
   *
   * Runs after the principal is known and before any route. Four rules, in the order a
   * person hits them:
   *
   *  1. The door has to be open. A tunnel somebody left running reaches nothing while the
   *     department has remote access switched off.
   *  2. The person has to be allowed through it — `remote.access`.
   *  3. Changing anything needs `remote.write` as well, so a role can be given the ability
   *     to look from outside without the ability to approve from outside.
   *  4. An account still on its default password cannot come in from outside at all. A
   *     known password plus a public address is the one combination that must not exist.
   *
   * Everything on the property network is untouched by all of it.
   */
  app.addHook('preHandler', async (req, reply) => {
    if (req.origin !== 'remote') return;
    const me = req.principal;
    // Signing in and the health check have to work before there is a principal; the login
    // route applies the same rules itself.
    if (!me) return;

    if (!remote.state(db, me.propertyId).enabled) {
      return reply.code(403).send({
        error: 'remote_closed',
        message: 'Remote access to this property is switched off. It is turned on under Admin → Host PC.',
      });
    }
    if (!me.permissions.has('remote.access')) {
      return reply.code(403).send({
        error: 'remote_forbidden', required: 'remote.access',
        message: 'Your role can only be used on the property network.',
      });
    }
    if (me.mustChangePassword) {
      return reply.code(403).send({
        error: 'must_change_password',
        message: 'Change your password on the property network before signing in from outside.',
      });
    }
    if (remote.isWrite(req.method) && !me.permissions.has('remote.write')) {
      return reply.code(403).send({
        error: 'remote_read_only', required: 'remote.write',
        message: 'You can read from outside the property but not change anything. Do this on site.',
      });
    }
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    /*
     * A service refusal carries `status`; fastify's own errors carry `statusCode`. Only
     * the second was being read here, so an HttpError that reached this handler — any
     * route that threw without going through the `send` helper — came back as a 500 with
     * its message swallowed. The route was wrong, but silently turning a written-for-a-
     * person refusal into "something went wrong" is the kind of trap that costs an
     * afternoon, so the handler understands both now.
     */
    if (isHttpError(err)) {
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.code(status).send({
      error: status === 500 ? 'server_error' : (err.code ?? 'error'),
      message: status === 500 ? 'Something went wrong on the server. The error has been logged.' : err.message,
    });
  });

  // One process serves the API and the client, so a phone on the office wifi only
  // ever needs one address. In development the client runs on its own Vite port and
  // proxies /api here instead.
  const webDist = clientDir();
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, index: false, wildcard: false });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !webDist) {
      return reply.code(404).send({ error: 'not_found', message: `No route for ${req.method} ${req.url}` });
    }
    // Any other path is a client route: hand back the app and let the router decide.
    return reply.type('text/html').sendFile('index.html');
  });

  await app.register(healthRoutes);
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(adminRoutes);
  await app.register(registryRoutes);
  await app.register(peopleRoutes);
  await app.register(jobRoutes);
  await app.register(ppmRoutes);
  await app.register(powerRoutes);
  await app.register(storeRoutes);
  await app.register(moneyRoutes);
  await app.register(safetyRoutes);
  await app.register(reportRoutes);
  await app.register(attachmentRoutes);
  await app.register(exportRoutes);
  await app.register(retireRoutes);
  await app.register(alertRoutes);
  await app.register(dutyRoutes);

  return app;
}
