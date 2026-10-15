import os from 'node:os';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/connection.js';
import { lanAddresses } from '../config.js';
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
 * Headers something in front of the app adds on the way through.
 *
 * Browsers never send these themselves; tunnels and reverse proxies do — Cloudflare its own
 * pair, ngrok, nginx, Caddy, frp and Tailscale the X-Forwarded family or the standard
 * Forwarded. Any one of them marks a request as having come through something, and so from
 * outside. A header can only move a caller to the less trusted side, which is the safe
 * direction for a header to be able to move anybody.
 */
const FORWARDING_HEADERS = [
  'cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'forwarded', 'x-real-ip', 'true-client-ip',
];

/** The name a request asked for, lower case, without the port. */
function requestedHost(req: FastifyRequest): string {
  const raw = String(req.headers.host ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));   // [::1]:4700
  return raw.replace(/:\d+$/, '');
}

/** A name this PC answers to on its own network: never a public one. */
function isLocalName(host: string): boolean {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (PRIVATE_V4.some((re) => re.test(host))) return true;
  if (/^f[cd]/.test(host) || host.startsWith('fe80:')) return true;
  const me = os.hostname().toLowerCase();
  if (host === me || host === `${me}.local`) return true;
  return lanAddresses().includes(host);
}

/** The address the tunnel publishes, as set under Admin → Host PC, reduced to a host name. */
function publishedHost(db: Db): string | null {
  const row = db.prepare(
    'SELECT public_host FROM remote_access_state WHERE public_host IS NOT NULL LIMIT 1'
  ).get() as { public_host: string } | undefined;
  if (!row?.public_host) return null;
  const v = row.public_host.trim().toLowerCase();
  try {
    return new URL(v.includes('://') ? v : `http://${v}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Where this request came from.
 *
 * Decided from what the request carries and the socket it arrived on, never from a header
 * that could claim the *more* trusted side. Three signals mark it as outside the property,
 * any one of them enough:
 *
 *  1. **Something forwarded it.** Every tunnel and proxy in common use says so in a header.
 *  2. **It asked for the published address.** A browser outside asks for the name the tunnel
 *     publishes, and keeps asking for it however many hops carry the bytes — including a raw
 *     TCP tunnel that adds no headers at all. Set that name under Admin → Host PC.
 *  3. **It arrived on loopback asking for a name that is not this PC's.** Something running on
 *     this PC carried it in. The host's own browser asks for localhost or a LAN address.
 *
 * Otherwise the socket decides: the property's private ranges are the property network,
 * anything else is outside.
 *
 * What none of this can see is a tunnel on this PC that rewrites the Host header to localhost
 * and adds no forwarding header. Say so wherever remote access is switched on.
 */
export function originOf(req: FastifyRequest, db?: Db): Origin {
  if (FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined)) return 'remote';

  const host = requestedHost(req);
  if (db && host && host === publishedHost(db)) return 'remote';

  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!ip) return 'remote';
  if (ip === '::1' || /^127\./.test(ip)) return isLocalName(host) ? 'lan' : 'remote';
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

/**
 * Whether remote access is switched off, for a request that has nobody signed in to say
 * which property it is for. There is one property per host.
 */
export function closedToAnonymous(db: Db): boolean {
  const property = db.prepare('SELECT id FROM properties LIMIT 1').get() as { id: string } | undefined;
  return !property || !state(db, property.id).enabled;
}

export function isWrite(method: string): boolean {
  return !READ_ONLY.has(method.toUpperCase());
}
