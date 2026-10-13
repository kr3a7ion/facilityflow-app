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
 * for. Quiet means nobody has used it: see `lookupSession` for what counts.
 */
function remoteIdleExpired(db: Db, propertyId: string, lastSeenAt: string, at: string): boolean {
  const row = db.prepare('SELECT idle_minutes FROM remote_access_state WHERE property_id = ?')
    .get(propertyId) as { idle_minutes: number } | undefined;
  const minutes = row?.idle_minutes ?? 20;
  return new Date(at).getTime() - new Date(lastSeenAt).getTime() > minutes * 60_000;
}

/** Sent by the website with every call: whole seconds since somebody last touched the page. */
export const IDLE_HEADER = 'x-ff-idle';

/**
 * When this request says the page was last used, for `lookupSession`.
 *
 * The event stream never counts: EventSource cannot send the website's report, and it
 * reconnects by itself every time a proxy drops it. A request with no report — a copy of
 * the website cached from before it sent one, a script — counts as use, as every request
 * did before.
 */
export function activityOf(req: FastifyRequest, now = Date.now()): string | null {
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/events') return null;
  const raw = req.headers[IDLE_HEADER];
  const idle = typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
  return new Date(now - idle * 1000).toISOString();
}

/*
 * Sessions the remote timeout ended lately, so every request still carrying one is told why.
 * Not only the first: that is often the event stream reconnecting, where nobody reads the
 * answer, and the screen would then send somebody to sign in without saying what happened.
 * Held in memory, so a restart forgets them; the cost is a sign-in screen without the note.
 */
const timedOutLately = new Map<string, number>();
const TIMED_OUT_KEPT_MS = 24 * 60 * 60_000;

function rememberTimedOut(id: string): void {
  const now = Date.now();
  for (const [k, at] of timedOutLately) if (now - at > TIMED_OUT_KEPT_MS) timedOutLately.delete(k);
  timedOutLately.set(id, now);
}

export interface SessionLookup {
  principal: Principal | null;
  /** Ended for sitting idle from outside past the property's timeout. */
  timedOut: boolean;
}

/**
 * The person behind a session cookie.
 *
 * `activeAt` is when somebody last used the page, as opposed to when it last asked for
 * something. They differ because an open tab polls by itself: the board every minute, the
 * event stream reconnecting whenever a proxy drops it. Counting those as use meant a tab
 * left open on an unattended laptop outside the property never timed out at all — the one
 * case the remote timeout exists for. Null means the request says nothing about anyone
 * being there, and the clock does not move.
 *
 * The idle check itself reads only the stored time, never `activeAt`: a laptop woken after
 * a weekend whose mouse moved before its first request must still find the session gone.
 * On the property network there is no timeout, and the stored time stays "last seen".
 */
export function lookupSession(
  db: Db, id: string, origin: 'lan' | 'remote' = 'lan', activeAt: string | null = nowIso()
): SessionLookup {
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
  if (!row) return { principal: null, timedOut: timedOutLately.has(id) };

  const at = nowIso();
  if (origin === 'remote') {
    if (remoteIdleExpired(db, row.property_id, row.last_seen_at, at)) {
      revokeSession(db, id);
      rememberTimedOut(id);
      return { principal: null, timedOut: true };
    }
    // Forward only: a slow poll from a second, idle tab must not wind back the first.
    if (activeAt && activeAt > row.last_seen_at) {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(activeAt, id);
    }
  } else {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

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
    principal: {
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
    },
    timedOut: false,
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
