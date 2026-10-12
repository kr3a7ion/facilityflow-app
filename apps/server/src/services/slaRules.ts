import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import { getSetting, slaFor, type SlaRow } from './settings.js';

/**
 * Specific response and resolve targets, layered over P1 to P4.
 *
 * A rule names a priority and narrows it to a trade, a place, or both. It may change the
 * response time, the resolve time and who a breach escalates to; anything it leaves blank
 * comes from the priority's default. When a job is raised, the most specific rule that
 * matches it wins:
 *
 *   1. a rule naming both the job's trade and its place (or a place above it),
 *   2. a rule naming only its place,
 *   3. a rule naming only its trade.
 *
 * Within the first two, the closer place wins: a rule on the floor beats one on the
 * block, which beats one on the site. That is the order a supervisor would reach for
 * them — "the plant room is different" is more specific than "electrical is different".
 */

export interface Ctx { propertyId: string; userId: string | null; displayName: string; ip?: string }
type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export interface SlaRule {
  id: string;
  priority: Priority;
  trade: string | null;
  location_id: string | null;
  location_name: string | null;
  respond_minutes: number | null;
  resolve_minutes: number | null;
  escalate_to_role: string | null;
  note: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

export interface RuleInput {
  priority: Priority;
  trade?: string | null;
  locationId?: string | null;
  respondMinutes?: number | null;
  resolveMinutes?: number | null;
  escalateToRole?: string | null;
  note?: string | null;
}

/** The targets a job actually gets, and the rule (if any) they came from. */
export interface ResolvedSla extends SlaRow {
  ruleId: string | null;
}

const SELECT = `
  SELECT r.id, r.priority, r.trade, r.location_id, l.name AS location_name,
         r.respond_minutes, r.resolve_minutes, r.escalate_to_role, r.note,
         r.updated_at, u.display_name AS updated_by_name
    FROM sla_rules r
    LEFT JOIN locations l ON l.id = r.location_id
    LEFT JOIN users u ON u.id = r.updated_by`;

export function list(db: Db, propertyId: string): SlaRule[] {
  return db.prepare(
    `${SELECT} WHERE r.property_id = ? AND r.deleted_at IS NULL
      ORDER BY r.priority, l.name IS NULL, l.name, r.trade IS NULL, r.trade`
  ).all(propertyId) as SlaRule[];
}

function getOne(db: Db, propertyId: string, id: string): SlaRule & { deleted_at?: string | null } {
  const row = db.prepare(`${SELECT} WHERE r.id = ? AND r.property_id = ?`).get(id, propertyId) as SlaRule | undefined;
  if (!row) throw new HttpError(404, 'not_found', 'That rule does not exist.');
  return row;
}

/* ------------------------------------------------------------------ checks ---- */

function clean(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function validate(db: Db, propertyId: string, input: RuleInput, exceptId?: string): {
  trade: string | null; locationId: string | null; respond: number | null; resolve: number | null;
  role: string | null; note: string | null;
} {
  const trade = clean(input.trade)?.toLowerCase() ?? null;
  const locationId = clean(input.locationId);
  const role = clean(input.escalateToRole);
  const respond = input.respondMinutes ?? null;
  const resolve = input.resolveMinutes ?? null;

  if (!trade && !locationId) {
    throw new HttpError(400, 'no_scope',
      'Pick a trade, a place, or both. A rule for every job of a priority is just that priority\'s default — change it in the table above.');
  }
  if (respond == null && resolve == null && !role) {
    throw new HttpError(400, 'no_change',
      'The rule has to change something: the response time, the resolve time, or who it escalates to.');
  }
  if (trade) {
    const trades = getSetting<string[]>(db, propertyId, 'trades', []).map((t) => t.toLowerCase());
    if (trades.length && !trades.includes(trade)) {
      throw new HttpError(400, 'unknown_trade', `"${trade}" is not one of this property's trades.`);
    }
  }
  if (locationId) {
    const loc = db.prepare('SELECT 1 FROM locations WHERE id = ? AND property_id = ?').get(locationId, propertyId);
    if (!loc) throw new HttpError(400, 'unknown_location', 'That place does not exist.');
  }
  if (role) {
    const r = db.prepare('SELECT 1 FROM roles WHERE key = ? AND property_id = ?').get(role, propertyId);
    if (!r) throw new HttpError(400, 'unknown_role', `There is no role "${role}" to escalate to.`);
  }
  // Judged against what the job would actually get, so a rule that only shortens the
  // resolve time cannot end up below the default response time.
  const base = slaFor(db, propertyId, input.priority);
  const effRespond = respond ?? base.respondMinutes;
  const effResolve = resolve ?? base.resolveMinutes;
  if (effResolve < effRespond) {
    throw new HttpError(400, 'resolve_before_respond',
      `That would give these jobs ${effResolve} minutes to fix but ${effRespond} to respond. Resolve has to be at least as long as respond.`);
  }

  const clash = db.prepare(
    `SELECT id FROM sla_rules
      WHERE property_id = ? AND priority = ? AND COALESCE(trade,'') = ? AND COALESCE(location_id,'') = ?
        AND deleted_at IS NULL AND id <> ?`
  ).get(propertyId, input.priority, trade ?? '', locationId ?? '', exceptId ?? '');
  if (clash) {
    throw new HttpError(409, 'duplicate_rule',
      'There is already a rule for that priority, trade and place. Edit that one instead.');
  }
  return { trade, locationId, respond, resolve, role, note: clean(input.note) };
}

/* ------------------------------------------------------------------ writes ---- */

export function create(db: Db, ctx: Ctx, input: RuleInput): SlaRule {
  const v = validate(db, ctx.propertyId, input);
  const id = ulid();
  const at = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sla_rules (id, property_id, priority, trade, location_id, respond_minutes,
         resolve_minutes, escalate_to_role, note, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ctx.propertyId, input.priority, v.trade, v.locationId, v.respond, v.resolve, v.role,
          v.note, ctx.userId, at, ctx.userId, at);
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: 'sla_rule.created', entityType: 'sla_rule', entityId: id,
      after: { priority: input.priority, ...v }, ip: ctx.ip,
    });
  })();
  return getOne(db, ctx.propertyId, id);
}

export function update(db: Db, ctx: Ctx, id: string, input: RuleInput): SlaRule {
  const before = getOne(db, ctx.propertyId, id) as SlaRule & { deleted_at?: string | null };
  const live = db.prepare('SELECT deleted_at FROM sla_rules WHERE id = ?').get(id) as { deleted_at: string | null };
  if (live.deleted_at) throw new HttpError(404, 'not_found', 'That rule has been deleted.');
  const v = validate(db, ctx.propertyId, input, id);
  const at = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE sla_rules SET priority = ?, trade = ?, location_id = ?, respond_minutes = ?,
              resolve_minutes = ?, escalate_to_role = ?, note = ?, updated_by = ?, updated_at = ?
        WHERE id = ?`
    ).run(input.priority, v.trade, v.locationId, v.respond, v.resolve, v.role, v.note,
          ctx.userId, at, id);
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: 'sla_rule.updated', entityType: 'sla_rule', entityId: id,
      before, after: { priority: input.priority, ...v }, ip: ctx.ip,
    });
  })();
  return getOne(db, ctx.propertyId, id);
}

export function remove(db: Db, ctx: Ctx, id: string): { ok: true; jobsKeepTheirDeadlines: number } {
  const before = getOne(db, ctx.propertyId, id);
  const at = nowIso();
  const used = (db.prepare('SELECT COUNT(*) n FROM work_orders WHERE sla_rule_id = ?').get(id) as { n: number }).n;
  db.transaction(() => {
    db.prepare('UPDATE sla_rules SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(at, ctx.userId, at, id);
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: 'sla_rule.deleted', entityType: 'sla_rule', entityId: id, before, ip: ctx.ip,
    });
  })();
  return { ok: true, jobsKeepTheirDeadlines: used };
}

/* ---------------------------------------------------------------- matching ---- */

export interface JobScope {
  trade?: string | null;
  locationId?: string | null;
  apartmentId?: string | null;
  assetId?: string | null;
}

/**
 * Where a job is, as the location tree sees it: its own place if it has one, otherwise
 * the place of its apartment or asset. Then every place above that, nearest first.
 */
function placesAbove(db: Db, propertyId: string, scope: JobScope): string[] {
  let start = scope.locationId ?? null;
  if (!start && scope.apartmentId) {
    start = (db.prepare('SELECT location_id FROM apartments WHERE id = ? AND property_id = ?')
      .get(scope.apartmentId, propertyId) as { location_id: string } | undefined)?.location_id ?? null;
  }
  if (!start && scope.assetId) {
    start = (db.prepare('SELECT location_id FROM assets WHERE id = ? AND property_id = ?')
      .get(scope.assetId, propertyId) as { location_id: string | null } | undefined)?.location_id ?? null;
  }
  if (!start) return [];
  const rows = db.prepare(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM locations WHERE id = ? AND property_id = ?
       UNION ALL
       SELECT l.id, l.parent_id, up.depth + 1 FROM locations l JOIN up ON l.id = up.parent_id
        WHERE up.depth < 32
     ) SELECT id FROM up ORDER BY depth`
  ).all(start, propertyId) as { id: string }[];
  return rows.map((r) => r.id);
}

function merge(base: SlaRow, rule: { id: string; respond_minutes: number | null;
  resolve_minutes: number | null; escalate_to_role: string | null } | null): ResolvedSla {
  if (!rule) return { ...base, ruleId: null };
  return {
    ...base,
    respondMinutes: rule.respond_minutes ?? base.respondMinutes,
    resolveMinutes: rule.resolve_minutes ?? base.resolveMinutes,
    escalateToRole: rule.escalate_to_role ?? base.escalateToRole,
    ruleId: rule.id,
  };
}

/** The targets a job raised now, with this priority, trade and place, would get. */
export function resolve(db: Db, propertyId: string, priority: string, scope: JobScope): ResolvedSla {
  const base = slaFor(db, propertyId, priority);
  const trade = clean(scope.trade)?.toLowerCase() ?? null;
  const places = placesAbove(db, propertyId, scope);

  const rules = db.prepare(
    `SELECT id, trade, location_id, respond_minutes, resolve_minutes, escalate_to_role
       FROM sla_rules WHERE property_id = ? AND priority = ? AND deleted_at IS NULL`
  ).all(propertyId, priority) as { id: string; trade: string | null; location_id: string | null;
    respond_minutes: number | null; resolve_minutes: number | null; escalate_to_role: string | null }[];

  let best: (typeof rules)[number] | null = null;
  let bestScore = -1;
  for (const r of rules) {
    if (r.trade && r.trade !== trade) continue;
    let depth = -1;
    if (r.location_id) {
      depth = places.indexOf(r.location_id);
      if (depth < 0) continue;               // a place this job is not in
    }
    // Both > place only > trade only; a nearer place beats a farther one.
    const nearness = depth >= 0 ? 100 - Math.min(depth, 99) : 0;
    const score = (r.trade && r.location_id ? 2000 : r.location_id ? 1000 : 0) + nearness;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return merge(base, best);
}

/**
 * The targets a job that already exists was raised under — the rule it took, as that rule
 * stands now, over the priority's current default. Used by escalation, so a breach tells
 * the person the job's own rule names. A rule deleted since still counts for the jobs that
 * took it; its deadlines were already set from it.
 */
export function forJob(db: Db, propertyId: string,
  wo: { priority: string; sla_rule_id?: string | null }): ResolvedSla {
  const base = slaFor(db, propertyId, wo.priority);
  if (!wo.sla_rule_id) return merge(base, null);
  const rule = db.prepare(
    `SELECT id, respond_minutes, resolve_minutes, escalate_to_role FROM sla_rules
      WHERE id = ? AND property_id = ?`
  ).get(wo.sla_rule_id, propertyId) as Parameters<typeof merge>[1] | undefined;
  return merge(base, rule ?? null);
}

/** A rule in a sentence, for the job card and the audit log. */
export function describe(db: Db, propertyId: string, ruleId: string): string | null {
  const r = db.prepare(
    `SELECT r.priority, r.trade, l.name AS location_name FROM sla_rules r
       LEFT JOIN locations l ON l.id = r.location_id WHERE r.id = ? AND r.property_id = ?`
  ).get(ruleId, propertyId) as { priority: string; trade: string | null; location_name: string | null } | undefined;
  if (!r) return null;
  return [r.priority, r.trade, r.location_name].filter(Boolean).join(' · ');
}
