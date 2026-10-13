import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
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

/**
 * A digest to check a password against when the username does not exist.
 *
 * Without it an unknown name answered at once and a real one only after argon2 had run, so
 * the time a refusal took said which usernames were real — the very thing the identical
 * message was there to hide. Made once, from a password nobody knows.
 */
let decoy: Promise<string> | null = null;
const decoyDigest = (): Promise<string> =>
  (decoy ??= hashPassword(crypto.randomBytes(24).toString('base64url')));

/**
 * Failed sign-ins per source, across every username.
 *
 * The per-account lock stops somebody guessing one person's password; it does nothing
 * about trying one common password against every account, and it hands anybody on the
 * network a way to lock the administrator out by typing badly on purpose. A source that
 * fails this often in this long is refused before any account is looked at.
 */
const SOURCE_LIMIT = 30;
const SOURCE_WINDOW_MS = 15 * 60_000;
const failuresBySource = new Map<string, { n: number; since: number }>();

/**
 * Who is asking, for counting purposes.
 *
 * Through the tunnel every request reaches the app from cloudflared on this PC, so the
 * socket alone would count every outside caller as one — one attacker would lock out
 * every travelling supervisor. The tunnel's header separates them, and it is believed only
 * on a loopback connection, so nobody on the network can rename themselves to dodge the count.
 */
function sourceOf(req: FastifyRequest): string {
  const socket = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const forwarded = req.headers['cf-connecting-ip'];
  if ((socket === '127.0.0.1' || socket === '::1') && typeof forwarded === 'string' && forwarded) {
    return `tunnel:${forwarded}`;
  }
  return socket || 'unknown';
}

/** Minutes until this source may try again, or 0. */
function sourceBlockedFor(source: string, now: number): number {
  const f = failuresBySource.get(source);
  if (!f || now - f.since > SOURCE_WINDOW_MS) return 0;
  return f.n >= SOURCE_LIMIT ? Math.ceil((f.since + SOURCE_WINDOW_MS - now) / 60_000) : 0;
}

function recordSourceFailure(source: string, now: number): void {
  const f = failuresBySource.get(source);
  if (!f || now - f.since > SOURCE_WINDOW_MS) failuresBySource.set(source, { n: 1, since: now });
  else f.n += 1;
  // A long-running host must not keep every address it has ever seen.
  if (failuresBySource.size > 1000) {
    for (const [k, v] of failuresBySource) if (now - v.since > SOURCE_WINDOW_MS) failuresBySource.delete(k);
  }
}

interface UserRow {
  id: string; property_id: string; display_name: string; password_hash: string;
  is_active: number; failed_attempts: number; locked_until: string | null; must_change_password: number;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'Enter a username and password.' });
    const { username, password } = parsed.data;

    const source = sourceOf(req);
    const wait = sourceBlockedFor(source, Date.now());
    if (wait) {
      return reply.code(429).send({
        error: 'too_many_attempts',
        message: `Too many failed sign-ins from this device. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`,
      });
    }

    const user = app.db.prepare(
      `SELECT id, property_id, display_name, password_hash, is_active, failed_attempts, locked_until, must_change_password
         FROM users WHERE username = ?`
    ).get(username.toLowerCase()) as UserRow | undefined;

    // Same response for unknown user and wrong password: never confirm which usernames exist.
    const generic = { error: 'invalid_credentials', message: 'That username and password do not match.' };

    if (!user || user.is_active !== 1) {
      await verifyPassword(await decoyDigest(), password);
      recordSourceFailure(source, Date.now());
      return reply.code(401).send(generic);
    }

    const ok = await verifyPassword(user.password_hash, password);
    const locked = !!user.locked_until && new Date(user.locked_until) > new Date();

    if (locked) {
      // Only somebody who knows the password learns the account is locked. Anybody else
      // gets the answer any wrong password gets, so a lock confirms no username to a
      // stranger, and guessing during it neither extends it nor gets anywhere.
      if (!ok) {
        recordSourceFailure(source, Date.now());
        audit(app.db, {
          propertyId: user.property_id, userId: user.id, actorName: user.display_name,
          action: 'auth.login.failed', entityType: 'user', entityId: user.id,
          after: { attempts: user.failed_attempts, locked: true, duringLock: true }, ip: req.ip,
        });
        return reply.code(401).send(generic);
      }
      return reply.code(423).send({
        error: 'locked',
        message: `Too many attempts. Try again after ${new Date(user.locked_until!).toLocaleTimeString()}.`,
      });
    }

    if (!ok) {
      recordSourceFailure(source, Date.now());
      // A lock that has run out starts the count again. Carrying the old total forward
      // meant every single mistake after the first lock locked the account for another
      // fifteen minutes.
      const attempts = (user.locked_until ? 0 : user.failed_attempts) + 1;
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
      // Same origin as the request, so a password changed from outside is still marked remote.
      const s = createSession(app.db, me.userId, app.config.sessionDays, req.ip,
                              req.headers['user-agent'], req.origin);
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
