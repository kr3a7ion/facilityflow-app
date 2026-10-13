import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/connection.js';
import { sessionId } from '../lib/ids.js';
import { nowIso, addDays } from '../lib/time.js';

export const COOKIE = 'ff_sid';

export interface Principal {
  userId: string;
  propertyId: string;
  username: string;
  displayName: string;
  staffId: string | null;
  roleKey: string;
  roleId: string;
  /** The role's own words. Every screen that showed the key printed "hod" at somebody. */
  roleName: string;
  roleDescription: string;
  mustChangePassword: boolean;
  permissions: Set<string>;
  scopes: Record<string, string>;
}

/**
 * Whether the browser reached this host over TLS.
 *
 * Directly, on the HTTPS server; or through something on this PC that terminated TLS in
 * front of it — the Cloudflare tunnel, or a reverse proxy — which says so in
 * X-Forwarded-Proto. That header is believed only on a loopback connection: from anywhere
 * else it is whatever the caller typed.
 */
export function arrivedOverTls(req: FastifyRequest): boolean {
  if (req.protocol === 'https') return true;
  const socket = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  return (socket === '127.0.0.1' || socket === '::1') && req.headers['x-forwarded-proto'] === 'https';
}

/**
 * The session cookie's options.
 *
 * Secure whenever the browser came over TLS, so a session opened through the tunnel or on
 * the HTTPS address is never sent back over plain HTTP. Not Secure on the plain LAN
 * address, because there a Secure cookie would simply never be returned and nobody could
 * stay signed in.
 */
export function sessionCookie(req: FastifyRequest, expiresAt: string) {
  return {
    httpOnly: true, sameSite: 'lax' as const, path: '/',
    secure: arrivedOverTls(req), expires: new Date(expiresAt),
  };
}

export function createSession(
  db: Db, userId: string, days: number, ip?: string, userAgent?: string,
  origin: 'lan' | 'remote' = 'lan'
): { id: string; expiresAt: string } {
  const id = sessionId();
  const at = nowIso();
  const expiresAt = addDays(at, days);
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, at, expiresAt, at, ip ?? null, userAgent ?? null, origin);
  return { id, expiresAt };
}

interface Row {
  user_id: string; property_id: string; username: string; display_name: string;
  staff_id: string | null; role_id: string; role_key: string; must_change_password: number;
  role_name: string; role_description: string | null;
}

/**
 * A remote request on a session that has been quiet longer than the property allows.
 *
 * Judged by where this request comes from, not where the session was opened: a laptop
 * signed in at the office and opened again in a hotel is exactly the case the timeout is
 * for. Activity means any request, so a tab left open keeps itself alive by polling; what
 * this ends is the cookie on a closed laptop that otherwise stays good for days.
 */
function remoteIdleExpired(db: Db, propertyId: string, lastSeenAt: string, at: string): boolean {
  const row = db.prepare('SELECT idle_minutes FROM remote_access_state WHERE property_id = ?')
    .get(propertyId) as { idle_minutes: number } | undefined;
  const minutes = row?.idle_minutes ?? 20;
  return new Date(at).getTime() - new Date(lastSeenAt).getTime() > minutes * 60_000;
}

export function principalFromSession(
  db: Db, id: string, origin: 'lan' | 'remote' = 'lan'
): Principal | null {
  const row = db.prepare(
    `SELECT u.id AS user_id, u.property_id, u.username, u.display_name, u.staff_id,
            u.role_id, r.key AS role_key, r.name AS role_name,
            r.description AS role_description, u.must_change_password, s.last_seen_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
      WHERE s.id = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
        AND u.is_active = 1`
  ).get(id, nowIso()) as (Row & { last_seen_at: string }) | undefined;
  if (!row) return null;

  const at = nowIso();
  if (origin === 'remote' && remoteIdleExpired(db, row.property_id, row.last_seen_at, at)) {
    revokeSession(db, id);
    return null;
  }
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, id);

  const grants = db.prepare(
    'SELECT permission_code, scope FROM role_permissions WHERE role_id = ?'
  ).all(row.role_id) as { permission_code: string; scope: string }[];

  const permissions = new Set<string>();
  const scopes: Record<string, string> = {};
  for (const g of grants) {
    permissions.add(g.permission_code);
    scopes[g.permission_code] = g.scope;
  }

  return {
    userId: row.user_id,
    propertyId: row.property_id,
    username: row.username,
    displayName: row.display_name,
    staffId: row.staff_id,
    roleId: row.role_id,
    roleKey: row.role_key,
    roleName: row.role_name,
    roleDescription: row.role_description ?? '',
    mustChangePassword: row.must_change_password === 1,
    permissions,
    scopes,
  };
}

/**
 * The same principal, reached by a paired phone's token instead of a browser cookie.
 *
 * Deliberately built from the same row shape and the same grants as a session, so a
 * permission check cannot behave one way for the website and another for the app. The app
 * is a different door into the building, not a different set of rules.
 *
 * `mustChangePassword` is reported as false here on purpose: the app never shows a
 * password screen, and a phone that refused to ring because somebody had not yet changed
 * a temporary password on the website would be withholding the one thing it exists to do.
 * The website still enforces it.
 */
export function principalFromDevice(db: Db, userId: string): Principal | null {
  const row = db.prepare(
    `SELECT u.id AS user_id, u.property_id, u.username, u.display_name, u.staff_id,
            u.role_id, r.key AS role_key, r.name AS role_name,
            r.description AS role_description, u.must_change_password
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND u.is_active = 1`
  ).get(userId) as Row | undefined;
  if (!row) return null;

  const grants = db.prepare(
    'SELECT permission_code, scope FROM role_permissions WHERE role_id = ?'
  ).all(row.role_id) as { permission_code: string; scope: string }[];

  const permissions = new Set<string>();
  const scopes: Record<string, string> = {};
  for (const g of grants) {
    permissions.add(g.permission_code);
    scopes[g.permission_code] = g.scope;
  }

  return {
    userId: row.user_id,
    propertyId: row.property_id,
    username: row.username,
    displayName: row.display_name,
    staffId: row.staff_id,
    roleId: row.role_id,
    roleKey: row.role_key,
    roleName: row.role_name,
    roleDescription: row.role_description ?? '',
    mustChangePassword: false,
    permissions,
    scopes,
  };
}

export function revokeSession(db: Db, id: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id);
}

export function revokeAllForUser(db: Db, userId: string): number {
  const r = db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(nowIso(), userId);
  return r.changes;
}

/** Housekeeping: drop sessions that expired more than a week ago. */
export function pruneSessions(db: Db): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(addDays(nowIso(), -7)).changes;
}
