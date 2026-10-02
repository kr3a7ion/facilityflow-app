import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nowIso, addDays } from '../lib/time.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, revokeSession, revokeAllForUser, principalFromDevice, COOKIE } from '../auth/sessions.js';
import * as remote from '../services/remote.js';
import { requireSignedIn } from '../auth/guard.js';
import { audit } from '../audit.js';

const LoginBody = z.object({ username: z.string().min(1), password: z.string().min(1) });
const PasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10) });

const MAX_ATTEMPTS = 8;
const LOCK_MINUTES = 15;

interface UserRow {
  id: string; property_id: string; display_name: string; password_hash: string;
  is_active: number; failed_attempts: number; locked_until: string | null; must_change_password: number;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'Enter a username and password.' });
    const { username, password } = parsed.data;

    const user = app.db.prepare(
      `SELECT id, property_id, display_name, password_hash, is_active, failed_attempts, locked_until, must_change_password
         FROM users WHERE username = ?`
    ).get(username.toLowerCase()) as UserRow | undefined;

    // Same response for unknown user and wrong password: never confirm which usernames exist.
    const generic = { error: 'invalid_credentials', message: 'That username and password do not match.' };

    if (!user || user.is_active !== 1) return reply.code(401).send(generic);

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return reply.code(423).send({
        error: 'locked',
        message: `Too many attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString()}.`,
      });
    }

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      const attempts = user.failed_attempts + 1;
      const lock = attempts >= MAX_ATTEMPTS
        ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
        : null;
      app.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
        .run(attempts, lock, nowIso(), user.id);
      audit(app.db, {
        propertyId: user.property_id, userId: user.id, actorName: user.display_name,
        action: 'auth.login.failed', entityType: 'user', entityId: user.id,
        after: { attempts, locked: !!lock }, ip: req.ip,
      });
      return reply.code(401).send(generic);
    }

    const at = nowIso();
    app.db.prepare(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?'
    ).run(at, at, user.id);

    /*
     * Signing in from outside the property.
     *
     * Checked here rather than only in the request hook, because a session handed out and
     * then refused on every subsequent call is a worse experience than being told no at
     * the door — and because an account on its default password must never get a working
     * session from a public address, whatever it does with it afterwards.
     */
    if (req.origin === 'remote') {
      const gate = remote.state(app.db, user.property_id);
      // principalFromDevice resolves a user's role grants without needing a session,
      // which is exactly what is wanted before one has been handed out.
      const perms = principalFromDevice(app.db, user.id)?.permissions ?? new Set<string>();
      const refuse = !gate.enabled
        ? 'Remote access to this property is switched off.'
        : !perms.has('remote.access')
          ? 'This account can only be used on the property network.'
          : user.must_change_password
            ? 'Change your password on the property network before signing in from outside.'
            : null;
      if (refuse) {
        audit(app.db, {
          propertyId: user.property_id, userId: user.id, actorName: user.display_name,
          action: 'auth.login_refused_remote', entityType: 'user', entityId: user.id,
          ip: req.ip, origin: 'remote', after: { reason: refuse },
        });
        return reply.code(403).send({ error: 'remote_refused', message: refuse });
      }
    }

    const session = createSession(app.db, user.id, app.config.sessionDays, req.ip,
                                  req.headers['user-agent'], req.origin);
    audit(app.db, {
      propertyId: user.property_id, userId: user.id, actorName: user.display_name,
      action: 'auth.login', entityType: 'user', entityId: user.id, ip: req.ip,
      origin: req.origin,
    });

    reply.setCookie(COOKIE, session.id, {
      httpOnly: true, sameSite: 'lax', path: '/',
      // secure:false is deliberate — the LAN has no certificate. See the spec, §03.
      secure: false,
      expires: new Date(session.expiresAt),
    });

    return {
      ok: true,
      mustChangePassword: user.must_change_password === 1,
      expiresAt: session.expiresAt,
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies[COOKIE];
    if (sid) revokeSession(app.db, sid);
    if (req.principal) {
      audit(app.db, {
        propertyId: req.principal.propertyId, userId: req.principal.userId,
        actorName: req.principal.displayName, action: 'auth.logout',
        entityType: 'user', entityId: req.principal.userId, ip: req.ip,
      });
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', { preHandler: requireSignedIn() }, async (req, reply) => {
    const me = req.principal!;
    const parsed = PasswordBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', message: 'New password must be at least 10 characters.' });
    }
    const row = app.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(me.userId) as
      { password_hash: string } | undefined;
    if (!row || !(await verifyPassword(row.password_hash, parsed.data.currentPassword))) {
      return reply.code(403).send({ error: 'wrong_password', message: 'Your current password is not correct.' });
    }

    const digest = await hashPassword(parsed.data.newPassword);
    app.db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?'
    ).run(digest, nowIso(), me.userId);

    // Changing a password signs out every other device.
    const keep = req.cookies[COOKIE];
    revokeAllForUser(app.db, me.userId);
    if (keep) {
      const s = createSession(app.db, me.userId, app.config.sessionDays, req.ip, req.headers['user-agent']);
      reply.setCookie(COOKIE, s.id, {
        httpOnly: true, sameSite: 'lax', path: '/', secure: false, expires: new Date(s.expiresAt),
      });
    }

    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'auth.password.changed', entityType: 'user', entityId: me.userId, ip: req.ip,
    });
    return { ok: true, message: 'Password changed. Other devices have been signed out.' };
  });
}
