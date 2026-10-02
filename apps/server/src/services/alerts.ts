import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import * as bus from './bus.js';
import type { Ctx } from '../routes/_helpers.js';

/**
 * Getting somebody's attention, and getting everybody's.
 *
 * Two things a supervisor does when something is wrong, and neither existed: ring one
 * person's device right now, and tell the whole department at once.
 *
 * The design rule for both is the same, and it is the only thing that makes them worth
 * building: **the sender finds out who heard it.** A broadcast nobody can audit is a
 * broadcast people learn to assume worked. Every ring records whether any device was
 * listening; every emergency keeps a live roll call of who has acknowledged and who has
 * not. In an incident the question is never "did I send it".
 */

export interface RingInput { userId: string; reason?: string }

export function ring(db: Db, ctx: Ctx, input: RingInput): {
  id: string; reached: number; name: string; message: string;
} {
  if (!ctx.userId) throw new HttpError(401, 'no_author', 'Sign in to ring somebody.');
  if (input.userId === ctx.userId) {
    throw new HttpError(400, 'self_ring', 'You cannot ring your own device.');
  }
  const target = db.prepare(
    'SELECT id, display_name, is_active FROM users WHERE id = ? AND property_id = ?'
  ).get(input.userId, ctx.propertyId) as
    { id: string; display_name: string; is_active: number } | undefined;
  if (!target) throw new HttpError(404, 'not_found', 'That account does not exist.');
  if (!target.is_active) {
    throw new HttpError(409, 'inactive', `${target.display_name}'s account is disabled.`);
  }

  /*
   * Not more than once a minute per person.
   *
   * Without this, a frustrated supervisor pressing the button repeatedly turns a
   * technician's phone into something they switch off — which is the opposite of what
   * the feature is for.
   */
  const recent = db.prepare(
    `SELECT COUNT(*) AS n FROM ring_log
      WHERE rung_user = ? AND at > datetime('now', '-60 seconds')`
  ).get(input.userId) as { n: number };
  if (recent.n > 0) {
    throw new HttpError(429, 'too_soon',
      `${target.display_name} was rung less than a minute ago. Give it a moment before trying again.`);
  }

  const id = ulid();
  const at = nowIso();
  // Counted before the publish, because the point of the number is what was listening at
  // the moment somebody pressed the button.
  const reached = bus.listenerCountFor(target.id);

  db.prepare(
    `INSERT INTO ring_log (id, property_id, rung_by, rung_user, reason, at, reached)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.propertyId, ctx.userId, target.id, input.reason?.trim() || null, at, reached);

  audit(db, {
    propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
    action: 'alert.rang', entityType: 'user', entityId: target.id,
    after: { reason: input.reason ?? null, reached }, ip: ctx.ip,
  });

  bus.publishTo(target.id, 'ring');

  return {
    id, reached, name: target.display_name,
    // Said plainly rather than a cheerful "sent". A ring that reached nothing is the one
    // outcome the person pressing the button most needs to know about.
    message: reached > 0
      ? `Ringing ${target.display_name} on ${reached} device${reached === 1 ? '' : 's'}.`
      : `${target.display_name} has nothing listening right now — no browser open and no phone app connected. Nothing rang.`,
  };
}

export function acknowledgeRing(db: Db, ctx: Ctx, id: string): { ok: true } {
  if (!ctx.userId) throw new HttpError(401, 'no_author', 'Sign in first.');
  const row = db.prepare(
    'SELECT rung_user, rung_by, acknowledged_at FROM ring_log WHERE id = ?'
  ).get(id) as { rung_user: string; rung_by: string; acknowledged_at: string | null } | undefined;
  if (!row) throw new HttpError(404, 'not_found', 'That ring does not exist.');
  if (row.rung_user !== ctx.userId) {
    throw new HttpError(403, 'not_yours', 'That ring was for somebody else.');
  }
  if (!row.acknowledged_at) {
    db.prepare('UPDATE ring_log SET acknowledged_at = ? WHERE id = ?').run(nowIso(), id);
    // The person who rang stops wondering.
    bus.publishTo(row.rung_by, 'ring');
  }
  return { ok: true };
}

/** What is ringing for me right now — unacknowledged, and recent enough to still matter. */
export function myRings(db: Db, propertyId: string, userId: string): unknown[] {
  return db.prepare(
    `SELECT r.id, r.reason, r.at, u.display_name AS rung_by_name
       FROM ring_log r JOIN users u ON u.id = r.rung_by
      WHERE r.rung_user = ? AND r.property_id = ? AND r.acknowledged_at IS NULL
        AND r.at > datetime('now', '-30 minutes')
      ORDER BY r.at DESC LIMIT 5`
  ).all(userId, propertyId);
}

// ---------------------------------------------------------------------------

export const EMERGENCY_CATEGORIES =
  ['fire', 'power', 'water', 'security', 'medical', 'other'] as const;
export type EmergencyCategory = (typeof EMERGENCY_CATEGORIES)[number];

export interface EmergencyInput {
  category: EmergencyCategory;
  message: string;
  locationId?: string;
}

export function raiseEmergency(db: Db, ctx: Ctx, input: EmergencyInput): {
  id: string; reached: number; message: string;
} {
  if (!ctx.userId) throw new HttpError(401, 'no_author', 'Sign in to raise an alert.');
  const message = input.message.trim();
  if (message.length < 3) {
    throw new HttpError(400, 'message_required',
      'Say what is happening. "Fire" on its own sends people looking in the wrong place.');
  }

  /*
   * One at a time per category.
   *
   * Two live fire alerts is two incidents as far as the roll call is concerned, and the
   * acknowledgements split between them. Stand the first one down, or add to it.
   */
  const open = db.prepare(
    `SELECT id FROM emergency_alerts
      WHERE property_id = ? AND category = ? AND stood_down_at IS NULL`
  ).get(ctx.propertyId, input.category) as { id: string } | undefined;
  if (open) {
    throw new HttpError(409, 'already_open',
      `There is already a live ${input.category} alert. Stand it down before raising another.`);
  }

  if (input.locationId) {
    const place = db.prepare('SELECT id FROM locations WHERE id = ? AND property_id = ?')
      .get(input.locationId, ctx.propertyId);
    if (!place) throw new HttpError(400, 'unknown_location', 'That place does not exist.');
  }

  const id = ulid();
  const at = nowIso();
  db.prepare(
    `INSERT INTO emergency_alerts (id, property_id, raised_by, category, message, location_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.propertyId, ctx.userId, input.category, message, input.locationId ?? null, at);

  // The person who raised it has seen it by definition. Recording that keeps the roll
  // call honest rather than showing the sender as unreached.
  db.prepare('INSERT INTO emergency_acks (alert_id, user_id, at, via) VALUES (?, ?, ?, ?)')
    .run(id, ctx.userId, at, 'raised');

  audit(db, {
    propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
    action: 'alert.emergency', entityType: 'emergency_alert', entityId: id,
    after: { category: input.category, message }, ip: ctx.ip,
  });

  const reached = bus.listenerCount().people;
  bus.publishAll('emergency');

  return {
    id, reached,
    message: `Alert sent. ${reached} ${reached === 1 ? 'device is' : 'devices are'} connected — watch who acknowledges.`,
  };
}

export function acknowledgeEmergency(
  db: Db, ctx: Ctx, id: string, via = 'browser'
): { ok: true } {
  if (!ctx.userId) throw new HttpError(401, 'no_author', 'Sign in first.');
  const alert = db.prepare(
    'SELECT id, stood_down_at FROM emergency_alerts WHERE id = ? AND property_id = ?'
  ).get(id, ctx.propertyId) as { id: string; stood_down_at: string | null } | undefined;
  if (!alert) throw new HttpError(404, 'not_found', 'That alert does not exist.');

  db.prepare(
    `INSERT INTO emergency_acks (alert_id, user_id, at, via) VALUES (?, ?, ?, ?)
     ON CONFLICT (alert_id, user_id) DO NOTHING`
  ).run(id, ctx.userId, nowIso(), via);

  // Everybody's roll call updates, not just the sender's: in an incident more than one
  // person is watching who has answered.
  bus.publishAll('emergency');
  return { ok: true };
}

export function standDown(db: Db, ctx: Ctx, id: string, note?: string): { ok: true } {
  if (!ctx.userId) throw new HttpError(401, 'no_author', 'Sign in first.');
  const alert = db.prepare(
    'SELECT id, category, stood_down_at FROM emergency_alerts WHERE id = ? AND property_id = ?'
  ).get(id, ctx.propertyId) as
    { id: string; category: string; stood_down_at: string | null } | undefined;
  if (!alert) throw new HttpError(404, 'not_found', 'That alert does not exist.');
  if (alert.stood_down_at) {
    throw new HttpError(409, 'already_down', 'That alert has already been stood down.');
  }
  const at = nowIso();
  db.prepare(
    `UPDATE emergency_alerts SET stood_down_at = ?, stood_down_by = ?, stand_down_note = ?
      WHERE id = ?`
  ).run(at, ctx.userId, note?.trim() || null, id);

  audit(db, {
    propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
    action: 'alert.stood_down', entityType: 'emergency_alert', entityId: id,
    after: { note: note ?? null }, ip: ctx.ip,
  });

  bus.publishAll('emergency');
  return { ok: true };
}

/**
 * Whatever is live, with the roll call attached.
 *
 * Everybody signed in may ask for this — an emergency that only supervisors can see is
 * not an emergency alert. The roll call comes with it for the same reason: the person
 * standing next to a fire door should be able to see that the plant room has not
 * answered.
 */
export function active(db: Db, propertyId: string): unknown[] {
  const alerts = db.prepare(
    `SELECT a.*, u.display_name AS raised_by_name, l.name AS location_name
       FROM emergency_alerts a
       JOIN users u ON u.id = a.raised_by
       LEFT JOIN locations l ON l.id = a.location_id
      WHERE a.property_id = ? AND a.stood_down_at IS NULL
      ORDER BY a.created_at DESC`
  ).all(propertyId) as { id: string }[];
  if (alerts.length === 0) return [];

  // Everybody who could possibly answer, so "not yet" is a name rather than a gap.
  const people = db.prepare(
    'SELECT id, display_name FROM users WHERE property_id = ? AND is_active = 1 ORDER BY display_name'
  ).all(propertyId) as { id: string; display_name: string }[];

  return alerts.map((a) => {
    const acks = db.prepare(
      'SELECT user_id, at, via FROM emergency_acks WHERE alert_id = ?'
    ).all(a.id) as { user_id: string; at: string; via: string | null }[];
    const by = new Map(acks.map((k) => [k.user_id, k]));
    return {
      ...a,
      rollCall: people.map((p) => ({
        userId: p.id, name: p.display_name,
        acknowledgedAt: by.get(p.id)?.at ?? null,
        via: by.get(p.id)?.via ?? null,
      })),
      acknowledged: acks.length,
      outstanding: people.length - acks.length,
    };
  });
}

/** The history, for the incident file. */
export function history(db: Db, propertyId: string, limit = 50): unknown[] {
  return db.prepare(
    `SELECT a.*, u.display_name AS raised_by_name, d.display_name AS stood_down_by_name,
            l.name AS location_name,
            (SELECT COUNT(*) FROM emergency_acks k WHERE k.alert_id = a.id) AS acknowledged
       FROM emergency_alerts a
       JOIN users u ON u.id = a.raised_by
       LEFT JOIN users d ON d.id = a.stood_down_by
       LEFT JOIN locations l ON l.id = a.location_id
      WHERE a.property_id = ? ORDER BY a.created_at DESC LIMIT ?`
  ).all(propertyId, limit);
}
