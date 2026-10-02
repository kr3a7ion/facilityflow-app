import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/connection.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import type { Ctx } from '../routes/_helpers.js';

/**
 * Telling the property network apart from everywhere else.
 *
 * The whole system assumes it is on a LAN. Once a tunnel is pointed at it that assumption
 * is no longer free, so the one question every request now has a definite answer to is
 * *where did this come from* — and the answer drives three things: whether the person may
 * be here at all, whether they may change anything, and what the audit log records.
 *
 * The test is the socket's own remote address, not a header. `X-Forwarded-For` is set by
 * whatever is in front, and the thing in front of a tunnel is the tunnel: trusting it
 * would let anybody who can reach the host claim to be on the LAN by typing a header.
 */

const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^127\./,
  // Link-local, which is what a machine gives itself when DHCP has not answered.
  /^169\.254\./,
];

export type Origin = 'lan' | 'remote';

/**
 * Where this connection came from.
 *
 * `cloudflared` runs on the host and connects to the app over the loopback interface, so
 * a tunnelled request arrives from 127.0.0.1 and looks local. The tunnel sets
 * `CF-Connecting-IP` on everything it forwards, and its presence — not its value — is
 * what gives it away. A header cannot be used to claim the *more* trusted side, only the
 * less trusted one, which is the safe direction for a header to be able to move you in.
 */
export function originOf(req: FastifyRequest): Origin {
  const viaTunnel = !!(req.headers['cf-connecting-ip'] ?? req.headers['cf-ray']);
  if (viaTunnel) return 'remote';

  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!ip) return 'remote';
  if (ip === '::1') return 'lan';
  // IPv6 unique-local and link-local, for a property running v6 on its own network.
  if (/^f[cd]/i.test(ip) || /^fe80:/i.test(ip)) return 'lan';
  return PRIVATE_V4.some((re) => re.test(ip)) ? 'lan' : 'remote';
}

export interface RemoteState {
  enabled: boolean;
  publicHost: string | null;
  idleMinutes: number;
  changedBy: string | null;
  changedAt: string | null;
}

export function state(db: Db, propertyId: string): RemoteState {
  const row = db.prepare(
    `SELECT s.enabled, s.public_host, s.idle_minutes, s.changed_at, u.display_name AS changed_by
       FROM remote_access_state s LEFT JOIN users u ON u.id = s.changed_by
      WHERE s.property_id = ?`
  ).get(propertyId) as {
    enabled: number; public_host: string | null; idle_minutes: number;
    changed_at: string | null; changed_by: string | null;
  } | undefined;
  if (!row) {
    return { enabled: false, publicHost: null, idleMinutes: 20, changedBy: null, changedAt: null };
  }
  return {
    enabled: !!row.enabled,
    publicHost: row.public_host,
    idleMinutes: row.idle_minutes,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  };
}

export function setState(
  db: Db, ctx: Ctx, next: { enabled?: boolean; publicHost?: string | null; idleMinutes?: number }
): RemoteState {
  const now = state(db, ctx.propertyId);
  const at = nowIso();

  if (next.idleMinutes !== undefined && (next.idleMinutes < 5 || next.idleMinutes > 240)) {
    throw new HttpError(400, 'bad_timeout',
      'A remote session should time out somewhere between 5 minutes and 4 hours.');
  }

  db.prepare(
    `INSERT INTO remote_access_state (property_id, enabled, public_host, idle_minutes,
        changed_by, changed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (property_id) DO UPDATE SET
       enabled = excluded.enabled, public_host = excluded.public_host,
       idle_minutes = excluded.idle_minutes, changed_by = excluded.changed_by,
       changed_at = excluded.changed_at`
  ).run(
    ctx.propertyId,
    (next.enabled ?? now.enabled) ? 1 : 0,
    next.publicHost === undefined ? now.publicHost : (next.publicHost?.trim() || null),
    next.idleMinutes ?? now.idleMinutes,
    ctx.userId, at, at
  );

  audit(db, {
    propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
    // Opening the door is the single most consequential setting in the system, so it gets
    // its own action rather than being one more "settings changed".
    action: (next.enabled ?? now.enabled) ? 'remote.opened' : 'remote.closed',
    entityType: 'property', entityId: ctx.propertyId,
    before: { enabled: now.enabled, publicHost: now.publicHost },
    after: { enabled: next.enabled ?? now.enabled, publicHost: next.publicHost ?? now.publicHost },
    ip: ctx.ip,
  });

  return state(db, ctx.propertyId);
}

/**
 * The methods that change something.
 *
 * Read-only verbs are allowed from anywhere a session is allowed at all; everything else
 * is what `remote.write` governs. Checked by method rather than by listing routes, because
 * a list of routes is a list somebody will forget to add to.
 */
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isWrite(method: string): boolean {
  return !READ_ONLY.has(method.toUpperCase());
}
