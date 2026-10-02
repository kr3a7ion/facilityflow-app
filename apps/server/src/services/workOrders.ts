import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nextRef } from '../lib/refs.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import { slaFor, labourRateKobo } from './settings.js';
import { isAvailable, propertyTimezone } from './roster.js';
import { notifyUser, notifyRole, notifyTeamLeadOf } from './escalation.js';
import * as bus from './bus.js';
import { localDate } from '../lib/time.js';

export interface Ctx { propertyId: string; userId: string | null; displayName: string; ip?: string }

export type Status =
  | 'draft' | 'open' | 'assigned' | 'accepted' | 'in_progress'
  | 'on_hold' | 'completed' | 'verified' | 'closed' | 'cancelled';

export interface WorkOrder {
  id: string; property_id: string; ref: string; source: string; title: string;
  priority: string; status: Status; trade: string | null;
  asset_id: string | null; location_id: string | null; apartment_id: string | null;
  assigned_to_staff_id: string | null; assigned_team_id: string | null;
  reported_at: string; respond_by: string | null; due_at: string | null;
  responded_at: string | null; started_at: string | null; held_at: string | null;
  held_minutes_total: number; completed_at: string | null; completed_by: string | null;
  verified_by: string | null; verified_at: string | null; closed_at: string | null;
  reopened_count: number; escalation_level: number; costs_frozen: number;
  labour_minutes: number; cost_labour_kobo: number; cost_parts_kobo: number; cost_vendor_kobo: number;
  ppm_schedule_id: string | null; hold_reason: string | null; resolution_notes: string | null;
}

/** Transitions the lifecycle allows. Anything not listed here is refused with a reason. */
const ALLOWED: Record<Status, Status[]> = {
  draft:       ['open', 'cancelled'],
  open:        ['assigned', 'cancelled'],
  assigned:    ['accepted', 'assigned', 'on_hold', 'cancelled'],
  accepted:    ['in_progress', 'on_hold', 'assigned', 'cancelled'],
  in_progress: ['on_hold', 'completed', 'assigned', 'cancelled'],
  on_hold:     ['in_progress', 'assigned', 'cancelled'],
  completed:   ['verified', 'in_progress'],
  verified:    ['closed', 'assigned'],
  closed:      [],
  cancelled:   [],
};

export function get(db: Db, propertyId: string, id: string): WorkOrder {
  const wo = db.prepare('SELECT * FROM work_orders WHERE id = ? AND property_id = ?')
    .get(id, propertyId) as WorkOrder | undefined;
  if (!wo) throw new HttpError(404, 'not_found', 'That job does not exist.');
  return wo;
}

function event(
  db: Db, ctx: Ctx, woId: string, type: string,
  from: string | null, to: string | null, note?: string | null, meta?: unknown
): void {
  db.prepare(
    `INSERT INTO work_order_events (id, wo_id, at, actor_id, actor_name, event_type, from_status, to_status, note, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ulid(), woId, nowIso(), ctx.userId, ctx.displayName, type, from, to, note ?? null,
        meta === undefined ? null : JSON.stringify(meta));

  // Every state change a board could be showing goes out as a nudge. One line, no
  // payload: the client refetches what that screen actually needs, so this never has to
  // know which columns anybody is looking at.
  bus.publishAll('jobs');
}

function guard(wo: WorkOrder, to: Status): void {
  if (!ALLOWED[wo.status].includes(to)) {
    throw new HttpError(409, 'bad_transition',
      `A job that is ${wo.status.replace('_', ' ')} cannot move to ${to.replace('_', ' ')}.`);
  }
}

function minutesBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export interface SlaState {
  respondBy: string | null;
  dueAt: string | null;
  /** due_at pushed out by every minute the job spent on hold */
  effectiveDueAt: string | null;
  heldMinutes: number;
  minutesRemaining: number | null;
  responseBreached: boolean;
  resolveBreached: boolean;
  state: 'on_time' | 'due_soon' | 'breached' | 'paused' | 'settled';
}

/**
 * Held time is excluded from the SLA. A technician is not penalised for a store
 * that has no filters, and a supervisor still sees the real elapsed time.
 */
export function slaState(wo: WorkOrder, at: string = nowIso()): SlaState {
  const held = wo.held_minutes_total + (wo.held_at ? minutesBetween(wo.held_at, at) : 0);
  const effective = wo.due_at
    ? new Date(new Date(wo.due_at).getTime() + held * 60000).toISOString()
    : null;
  const settled = ['completed', 'verified', 'closed', 'cancelled'].includes(wo.status);
  const remaining = effective ? minutesBetween(at, effective) : null;
  const responseBreached = !!wo.respond_by && !wo.responded_at && at > wo.respond_by;
  const resolveBreached = !settled && !!effective && at > effective;
  let state: SlaState['state'];
  if (settled) state = 'settled';
  else if (wo.status === 'on_hold') state = 'paused';
  else if (resolveBreached) state = 'breached';
  else if (remaining !== null && remaining <= 120) state = 'due_soon';
  else state = 'on_time';
  return {
    respondBy: wo.respond_by, dueAt: wo.due_at, effectiveDueAt: effective,
    heldMinutes: held, minutesRemaining: remaining, responseBreached, resolveBreached, state,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface CreateInput {
  title: string; description?: string; trade?: string;
  priority?: 'P1' | 'P2' | 'P3' | 'P4';
  source?: 'reactive' | 'ppm' | 'inspection' | 'project';
  assetId?: string | null; locationId?: string | null; apartmentId?: string | null;
  requestId?: string | null; ppmScheduleId?: string | null;
  chargeTo?: 'house' | 'owner' | 'tenant' | 'department';
  reportedAt?: string; dueAt?: string;
}

export function create(db: Db, ctx: Ctx, input: CreateInput): WorkOrder {
  if (!input.assetId && !input.locationId && !input.apartmentId) {
    throw new HttpError(400, 'no_target',
      'A job needs an asset, a location or an apartment — otherwise it can never be reported on.');
  }
  const priority = input.priority ?? 'P3';
  const sla = slaFor(db, ctx.propertyId, priority);
  const at = nowIso();
  const reportedAt = input.reportedAt ?? at;
  // The deadline is computed once, at creation, and stored. Recomputing it later
  // would let an SLA edit silently rewrite history.
  const respondBy = new Date(new Date(reportedAt).getTime() + sla.respondMinutes * 60000).toISOString();
  const dueAt = input.dueAt
    ?? new Date(new Date(reportedAt).getTime() + sla.resolveMinutes * 60000).toISOString();

  const id = ulid();
  const run = db.transaction(() => {
    const ref = nextRef(db, ctx.propertyId, 'WO');
    db.prepare(
      `INSERT INTO work_orders (id, property_id, ref, source, request_id, ppm_schedule_id, title, description,
        trade, priority, asset_id, location_id, apartment_id, status, reported_at, respond_by, due_at,
        charge_to, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ctx.propertyId, ref, input.source ?? 'reactive', input.requestId ?? null,
          input.ppmScheduleId ?? null, input.title, input.description ?? null, input.trade ?? null,
          priority, input.assetId ?? null, input.locationId ?? null, input.apartmentId ?? null,
          reportedAt, respondBy, dueAt, input.chargeTo ?? 'house', ctx.userId, at, at);
    event(db, ctx, id, 'created', null, 'open', input.title,
          { priority, respondBy, dueAt, source: input.source ?? 'reactive' });
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: 'wo.created', entityType: 'work_order', entityId: id,
      after: { ref, title: input.title, priority }, ip: ctx.ip,
    });
    return ref;
  });
  run();
  return get(db, ctx.propertyId, id);
}

/**
 * The account belonging to a person on the floor, if they have one.
 *
 * A job is assigned to a staff record, but a notification has to reach a login. Not
 * everybody on the staff list has one — a contractor, or somebody who has not been given
 * an account yet — and that is not an error: the job is still assigned, it simply cannot
 * chime at anybody, and the supervisor who assigned it is the one who will notice.
 */
function loginFor(db: Db, staffId: string): string | null {
  const row = db.prepare(
    'SELECT id FROM users WHERE staff_id = ? AND is_active = 1 LIMIT 1'
  ).get(staffId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Everyone with an account on a team, for a job handed to the team rather than a person. */
function loginsForTeam(db: Db, propertyId: string, teamId: string): string[] {
  return (db.prepare(
    `SELECT u.id FROM users u
       JOIN staff s ON s.id = u.staff_id AND s.is_active = 1
      WHERE u.property_id = ? AND u.is_active = 1 AND s.team_id = ?`
  ).all(propertyId, teamId) as { id: string }[]).map((r) => r.id);
}

export function assign(
  db: Db, ctx: Ctx, id: string, target: { staffId?: string; teamId?: string }, note?: string
): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  guard(wo, 'assigned');
  if (!target.staffId && !target.teamId) {
    throw new HttpError(400, 'no_assignee', 'Choose a technician or a team.');
  }
  if (target.staffId) {
    // This is the entire reason shifts exist in this system.
    if (!isAvailable(db, ctx.propertyId, target.staffId)) {
      const person = db.prepare('SELECT first_name, last_name FROM staff WHERE id = ?')
        .get(target.staffId) as { first_name: string; last_name: string } | undefined;
      const who = person ? `${person.first_name} ${person.last_name}` : 'That person';
      throw new HttpError(409, 'not_on_shift',
        `${who} is not marked present today, so the job cannot be assigned to them. ` +
        `Mark them present on the roster first, or choose someone who is on shift.`);
    }
  }
  const at = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE work_orders SET status = 'assigned', assigned_to_staff_id = ?, assigned_team_id = ?,
        assigned_by = ?, assigned_at = ?, updated_at = ? WHERE id = ?`
    ).run(target.staffId ?? null, target.teamId ?? null, ctx.userId, at, at, id);
    event(db, ctx, id, 'assigned', wo.status, 'assigned', note, target);
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: 'wo.assigned', entityType: 'work_order', entityId: id,
      before: { assignee: wo.assigned_to_staff_id }, after: target, ip: ctx.ip,
    });

    /*
     * Tell the person.
     *
     * Every notification in this system used to come from an SLA breach, which meant the
     * only way a technician learned a job was theirs was by opening the app and looking.
     * A P1 could sit unassigned-in-their-eyes for an hour and the first anyone heard of
     * it was the escalation — the system shouting about a deadline it never mentioned.
     *
     * Inside the transaction on purpose: if the assignment rolls back, so does the chime.
     */
    const body = `${wo.priority} · ${wo.title}`;
    if (target.staffId) {
      const login = loginFor(db, target.staffId);
      // Not for the supervisor who just did it — they are looking at the screen.
      if (login && login !== ctx.userId) {
        notifyUser(db, ctx.propertyId, login, {
          kind: 'wo.assigned', title: `${wo.ref} is yours`, body,
          entityType: 'work_order', entityId: id, at,
        });
      }
    } else if (target.teamId) {
      for (const login of loginsForTeam(db, ctx.propertyId, target.teamId)) {
        if (login === ctx.userId) continue;
        notifyUser(db, ctx.propertyId, login, {
          kind: 'wo.assigned', title: `${wo.ref} is with your team`, body,
          entityType: 'work_order', entityId: id, at,
        });
      }
    }

    // Taken off somebody: they must stop working on it.
    if (wo.assigned_to_staff_id && wo.assigned_to_staff_id !== target.staffId) {
      const previous = loginFor(db, wo.assigned_to_staff_id);
      if (previous && previous !== ctx.userId) {
        notifyUser(db, ctx.propertyId, previous, {
          kind: 'wo.reassigned', title: `${wo.ref} has been reassigned`,
          body: `${wo.title} — it is no longer on your board.`,
          entityType: 'work_order', entityId: id, at,
        });
      }
    }
  })();
  return get(db, ctx.propertyId, id);
}

export function accept(db: Db, ctx: Ctx, id: string): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  guard(wo, 'accepted');
  const at = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE work_orders SET status = 'accepted', responded_at = COALESCE(responded_at, ?), updated_at = ?
        WHERE id = ?`
    ).run(at, at, id);
    event(db, ctx, id, 'accepted', wo.status, 'accepted', null,
          { respondedInMinutes: minutesBetween(wo.reported_at, at) });
  })();
  return get(db, ctx.propertyId, id);
}

export function start(db: Db, ctx: Ctx, id: string): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  guard(wo, 'in_progress');
  const at = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE work_orders SET status = 'in_progress', started_at = COALESCE(started_at, ?),
        responded_at = COALESCE(responded_at, ?), updated_at = ? WHERE id = ?`
    ).run(at, at, at, id);
    event(db, ctx, id, 'started', wo.status, 'in_progress');
  })();
  return get(db, ctx.propertyId, id);
}

export function hold(db: Db, ctx: Ctx, id: string, reason: string, note?: string): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  guard(wo, 'on_hold');
  const at = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE work_orders SET status = ?, hold_reason = ?, held_at = ?, updated_at = ? WHERE id = ?')
      .run('on_hold', reason, at, at, id);
    event(db, ctx, id, 'hold', wo.status, 'on_hold', note, { reason });
  })();
  return get(db, ctx.propertyId, id);
}

export function resume(db: Db, ctx: Ctx, id: string): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  guard(wo, 'in_progress');
  const at = nowIso();
  const held = wo.held_at ? minutesBetween(wo.held_at, at) : 0;
  db.transaction(() => {
    db.prepare(
      `UPDATE work_orders SET status = 'in_progress', hold_reason = NULL, held_at = NULL,
        held_minutes_total = held_minutes_total + ?, updated_at = ? WHERE id = ?`
    ).run(held, at, id);
    event(db, ctx, id, 'resume', 'on_hold', 'in_progress', null, { heldMinutes: held });
  })();
  return get(db, ctx.propertyId, id);
}

export interface CompleteInput { resolutionNotes: string; failureCause?: string; downtimeMinutes?: number }

export function complete(db: Db, ctx: Ctx, id: string, input: CompleteInput): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  guard(wo, 'completed');
  if (!input.resolutionNotes?.trim()) {
    throw new HttpError(400, 'notes_required', 'Say what you did before marking the job complete.');
  }
  const at = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE work_orders SET status = 'completed', completed_at = ?, completed_by = ?,
        resolution_notes = ?, failure_cause = ?, downtime_minutes = ?, updated_at = ? WHERE id = ?`
    ).run(at, ctx.userId, input.resolutionNotes, input.failureCause ?? null,
          input.downtimeMinutes ?? null, at, id);
    event(db, ctx, id, 'completed', wo.status, 'completed', input.resolutionNotes,
          { failureCause: input.failureCause });
    rollupCosts(db, ctx.propertyId, id);

    // A completed job is not a finished one — it is a job waiting on somebody else, and
    // nobody was being told. Work sat in "awaiting verify" for days because the person
    // who could sign it off had no reason to look.
    const ready = {
      kind: 'wo.completed', title: `${wo.ref} is ready to verify`,
      body: `${wo.title} — completed by ${ctx.displayName}.`,
      entityType: 'work_order', entityId: id, at,
    };
    notifyRole(db, ctx.propertyId, 'supervisor', ready);
    // And the team lead, who holds wo.verify over their own team and is usually standing
    // closest to the work. They were left out: the permission said it was theirs to sign
    // off and nothing ever told them there was anything to sign.
    notifyTeamLeadOf(db, ctx.propertyId, wo.assigned_to_staff_id, ready, ctx.userId);
  })();
  return get(db, ctx.propertyId, id);
}

export function verify(db: Db, ctx: Ctx, id: string, note?: string): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  guard(wo, 'verified');
  // One click, two people. Otherwise completion figures are self-reported.
  if (wo.completed_by && wo.completed_by === ctx.userId) {
    throw new HttpError(403, 'self_verify',
      'You completed this job, so someone else has to verify it.');
  }
  const at = nowIso();
  db.transaction(() => {
    rollupCosts(db, ctx.propertyId, id);
    db.prepare(
      `UPDATE work_orders SET status = 'verified', verified_by = ?, verified_at = ?,
        costs_frozen = 1, updated_at = ? WHERE id = ?`
    ).run(ctx.userId, at, at, id);
    event(db, ctx, id, 'verified', wo.status, 'verified', note);
    /*
     * Tell the person who did the work that it was signed off.
     *
     * Until now verification was silent in the direction that matters most: a technician
     * finished a job, marked it complete, and never heard another word — so "was that
     * accepted?" was a question for the corridor. One line closes the loop, and it is the
     * only notification in the system that is purely good news.
     */
    if (wo.completed_by && wo.completed_by !== ctx.userId) {
      notifyUser(db, ctx.propertyId, wo.completed_by, {
        kind: 'wo.verified', title: `${wo.ref} was signed off`,
        body: note?.trim()
          ? `${wo.title} — verified by ${ctx.displayName}: ${note.trim()}`
          : `${wo.title} — verified by ${ctx.displayName}. Nothing further needed from you.`,
        entityType: 'work_order', entityId: id, at,
      });
    }
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: 'wo.verified', entityType: 'work_order', entityId: id,
      after: { ref: wo.ref, completedBy: wo.completed_by }, ip: ctx.ip,
    });
  })();
  return get(db, ctx.propertyId, id);
}

export function close(db: Db, ctx: Ctx, id: string): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  guard(wo, 'closed');
  const at = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE work_orders SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`)
      .run(at, at, id);
    event(db, ctx, id, 'closed', wo.status, 'closed');
  })();
  return get(db, ctx.propertyId, id);
}

export function reopen(db: Db, ctx: Ctx, id: string, reason: string): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  if (wo.status !== 'verified' && wo.status !== 'completed') {
    throw new HttpError(409, 'bad_transition', 'Only a completed or verified job can be reopened.');
  }
  const at = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE work_orders SET status = 'assigned', reopened_count = reopened_count + 1,
        completed_at = NULL, completed_by = NULL, verified_by = NULL, verified_at = NULL,
        costs_frozen = 0, updated_at = ? WHERE id = ?`
    ).run(at, id);
    event(db, ctx, id, 'reopened', wo.status, 'assigned', reason,
          { reopenedCount: wo.reopened_count + 1 });
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: 'wo.reopened', entityType: 'work_order', entityId: id,
      after: { reason, count: wo.reopened_count + 1 }, ip: ctx.ip,
    });

    // Being sent back is the notification that matters most to a technician, and the one
    // they were least likely to notice: the job simply reappeared on their board with no
    // word of why. The reason travels with it.
    if (wo.assigned_to_staff_id) {
      const login = loginFor(db, wo.assigned_to_staff_id);
      if (login && login !== ctx.userId) {
        notifyUser(db, ctx.propertyId, login, {
          kind: 'wo.reopened', title: `${wo.ref} has come back to you`,
          body: reason, entityType: 'work_order', entityId: id, at,
        });
      }
    }
  })();
  return get(db, ctx.propertyId, id);
}

export function cancel(db: Db, ctx: Ctx, id: string, reason: string): WorkOrder {
  const wo = get(db, ctx.propertyId, id);
  guard(wo, 'cancelled');
  if (!reason?.trim()) throw new HttpError(400, 'reason_required', 'Give a reason for cancelling.');
  const at = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE work_orders SET status = 'cancelled', cancelled_reason = ?, updated_at = ? WHERE id = ?`)
      .run(reason, at, id);
    event(db, ctx, id, 'cancelled', wo.status, 'cancelled', reason);
  })();
  return get(db, ctx.propertyId, id);
}

// ---------------------------------------------------------------------------
// Labour, parts, costing
// ---------------------------------------------------------------------------

export function logLabour(db: Db, ctx: Ctx, id: string, staffId: string, minutes: number): void {
  const wo = get(db, ctx.propertyId, id);
  if (wo.costs_frozen) {
    throw new HttpError(409, 'costs_frozen', 'This job has been verified — its costs are frozen.');
  }
  if (minutes <= 0) throw new HttpError(400, 'invalid', 'Minutes must be greater than zero.');
  const at = nowIso();
  const rate = labourRateKobo(db, ctx.propertyId, wo.trade, at);
  const cost = Math.round((rate * minutes) / 60);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO work_order_labour (id, wo_id, staff_id, minutes, rate_kobo, cost_kobo, logged_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ulid(), id, staffId, minutes, rate, cost, ctx.userId, at);
    event(db, ctx, id, 'labour_logged', wo.status, wo.status, null, { minutes, costKobo: cost });
    rollupCosts(db, ctx.propertyId, id);
  })();
}

/** Recompute the three cost buckets from their child tables. Refuses once frozen. */
export function rollupCosts(db: Db, propertyId: string, id: string): void {
  const wo = db.prepare('SELECT costs_frozen FROM work_orders WHERE id = ? AND property_id = ?')
    .get(id, propertyId) as { costs_frozen: number } | undefined;
  if (!wo) return;
  if (wo.costs_frozen === 1) return;
  const labour = db.prepare(
    'SELECT COALESCE(SUM(minutes),0) AS m, COALESCE(SUM(cost_kobo),0) AS c FROM work_order_labour WHERE wo_id = ?'
  ).get(id) as { m: number; c: number };
  const parts = db.prepare(
    'SELECT COALESCE(SUM(total_kobo),0) AS c FROM work_order_parts WHERE wo_id = ?'
  ).get(id) as { c: number };
  const vendor = db.prepare(
    'SELECT COALESCE(SUM(amount_kobo),0) AS c FROM purchases WHERE wo_id = ?'
  ).get(id) as { c: number };
  db.prepare(
    `UPDATE work_orders SET labour_minutes = ?, cost_labour_kobo = ?, cost_parts_kobo = ?,
      cost_vendor_kobo = ?, updated_at = ? WHERE id = ?`
  ).run(labour.m, labour.c, parts.c, vendor.c, nowIso(), id);
}

export function totalCostKobo(wo: WorkOrder): number {
  return wo.cost_labour_kobo + wo.cost_parts_kobo + wo.cost_vendor_kobo;
}

export function history(db: Db, woId: string): unknown[] {
  return db.prepare('SELECT * FROM work_order_events WHERE wo_id = ? ORDER BY at DESC, id DESC').all(woId);
}

export function todayFor(db: Db, propertyId: string): string {
  return localDate(propertyTimezone(db, propertyId));
}
