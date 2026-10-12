import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import { getSetting, setSetting } from './settings.js';
import * as bus from './bus.js';

/**
 * Who is told about what, and how loudly.
 *
 * Every event that puts something on somebody's bell is listed here once, with who it
 * goes to by default and how much noise it makes. An administrator can change both from
 * Admin → Settings without a code change; what they set is stored as overrides on top of
 * these defaults, so an event added in a later version arrives with sensible recipients
 * rather than reaching nobody.
 *
 * Recipients are roles, plus a few that only make sense for one event — "the team lead
 * of whoever did the job", "whoever reported it" — which the caller supplies.
 *
 * Loudness:
 *   quiet  — on the bell, no sound
 *   chime  — the ordinary two-note chime
 *   good   — the settled chime: good news, nothing to do
 *   urgent — the urgent tone: stop and look
 */

export type Level = 'quiet' | 'chime' | 'good' | 'urgent';
export const LEVELS: Level[] = ['quiet', 'chime', 'good', 'urgent'];

export type Context = '@team_lead' | '@reporter' | '@assignee' | '@completer';
export const CONTEXT_LABELS: Record<Context, string> = {
  '@team_lead': 'Their team lead',
  '@reporter': 'Whoever reported it',
  '@assignee': 'Whoever it is assigned to',
  '@completer': 'Whoever did the work',
};

export interface EventDef {
  key: string;
  group: 'Jobs' | 'Planned work' | 'Power' | 'Diesel' | 'Stores';
  label: string;
  /** When it fires, in a sentence, for the settings screen. */
  when: string;
  roles: string[];
  /** The context recipients this event can reach at all. */
  context: Context[];
  /** Which of those are on by default. */
  contextOn: Context[];
  level: Level;
}

export const EVENTS: EventDef[] = [
  { key: 'wo.completed', group: 'Jobs', label: 'Job completed',
    when: 'A job is marked complete and is waiting to be verified.',
    roles: ['supervisor'], context: ['@team_lead', '@reporter'], contextOn: ['@team_lead', '@reporter'],
    level: 'chime' },
  { key: 'wo.verified', group: 'Jobs', label: 'Job signed off',
    when: 'Somebody verifies a completed job.',
    roles: [], context: ['@completer', '@reporter'], contextOn: ['@completer'], level: 'good' },
  { key: 'ppm.due_soon', group: 'Planned work', label: 'Planned work coming due',
    when: 'Scheduled maintenance reaches its lead time and its job is created.',
    roles: ['supervisor', 'team_lead'], context: [], contextOn: [], level: 'chime' },
  { key: 'ppm.due_today', group: 'Planned work', label: 'Planned work due today',
    when: 'A planned job is due today and is not finished. Once per job.',
    roles: ['supervisor'], context: ['@assignee'], contextOn: ['@assignee'], level: 'chime' },

  { key: 'power.mains_off', group: 'Power', label: 'Mains failed',
    when: 'Somebody records that utility power has gone.',
    roles: ['supervisor', 'team_lead', 'technician'], context: [], contextOn: [], level: 'urgent' },
  { key: 'power.mains_on', group: 'Power', label: 'Mains restored',
    when: 'Somebody records that utility power is back.',
    roles: ['supervisor', 'team_lead', 'technician'], context: [], contextOn: [], level: 'chime' },
  { key: 'power.genset_start', group: 'Power', label: 'Generator started',
    when: 'A generator is recorded as started and carrying load.',
    roles: ['supervisor', 'team_lead'], context: [], contextOn: [], level: 'chime' },
  { key: 'power.genset_stop', group: 'Power', label: 'Generator stopped',
    when: 'A running generator is recorded as stopped.',
    roles: ['supervisor', 'team_lead'], context: [], contextOn: [], level: 'chime' },
  { key: 'power.genset_fault', group: 'Power', label: 'Generator fault',
    when: 'A generator is recorded as tripped or faulty.',
    roles: ['supervisor', 'team_lead', 'hod'], context: [], contextOn: [], level: 'urgent' },
  { key: 'genset.alarm', group: 'Power', label: 'Generator log out of range',
    when: 'A generator log reading (oil, temperature, voltage…) is outside its limits.',
    roles: ['supervisor'], context: [], contextOn: [], level: 'urgent' },
  { key: 'power.load', group: 'Power', label: 'Building load out of limits',
    when: 'A clamp reading shows a phase imbalance or a draw above the breaker rating.',
    roles: ['supervisor'], context: [], contextOn: [], level: 'chime' },

  { key: 'fuel_low', group: 'Diesel', label: 'Tank below minimum',
    when: 'A dip or delivery leaves a tank below its minimum level.',
    roles: ['supervisor'], context: [], contextOn: [], level: 'urgent' },
  { key: 'fuel_delivered', group: 'Diesel', label: 'Diesel delivered',
    when: 'A diesel delivery is recorded.',
    roles: ['supervisor'], context: [], contextOn: [], level: 'quiet' },
  { key: 'fuel_variance', group: 'Diesel', label: 'Delivery short or over',
    when: 'A delivery differs from its invoice by more than the tolerance.',
    roles: ['hod', 'supervisor'], context: [], contextOn: [], level: 'chime' },
  { key: 'genset_efficiency', group: 'Diesel', label: 'Generator burning too much',
    when: 'Three runs in a row burn more diesel than the set should; a job is raised.',
    roles: ['supervisor'], context: [], contextOn: [], level: 'chime' },

  { key: 'requisition', group: 'Stores', label: 'Requisition raised',
    when: 'A requisition for parts or materials is raised and needs approving.',
    roles: ['supervisor'], context: [], contextOn: [], level: 'chime' },
  { key: 'stock_low', group: 'Stores', label: 'Stock at or below minimum',
    when: 'An item is issued or counted down to its minimum level.',
    roles: ['storekeeper', 'supervisor'], context: [], contextOn: [], level: 'chime' },
];

const BY_KEY = new Map(EVENTS.map((e) => [e.key, e]));

export interface Routing { roles: string[]; context: Context[]; level: Level; off: boolean }
type Overrides = Record<string, Partial<Routing>>;

const SETTING = 'alert_routing';

export function routingFor(db: Db, propertyId: string, key: string): Routing {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`unknown alert event ${key}`);
  const o = getSetting<Overrides>(db, propertyId, SETTING, {})[key] ?? {};
  return {
    roles: o.roles ?? def.roles,
    // Only context recipients this event can actually reach.
    context: (o.context ?? def.contextOn).filter((c) => def.context.includes(c)),
    level: o.level && LEVELS.includes(o.level) ? o.level : def.level,
    off: o.off ?? false,
  };
}

export function allRouting(db: Db, propertyId: string) {
  return EVENTS.map((e) => ({
    ...e,
    contextLabels: e.context.map((c) => ({ key: c, label: CONTEXT_LABELS[c] })),
    routing: routingFor(db, propertyId, e.key),
    isDefault: !getSetting<Overrides>(db, propertyId, SETTING, {})[e.key],
  }));
}

export interface Ctx { propertyId: string; userId: string | null; displayName: string; ip?: string }

export function setRouting(db: Db, ctx: Ctx, key: string, r: Partial<Routing> | null): Routing {
  const def = BY_KEY.get(key);
  if (!def) throw new HttpError(404, 'unknown_event', 'There is no alert by that name.');
  const all = getSetting<Overrides>(db, ctx.propertyId, SETTING, {});
  const before = routingFor(db, ctx.propertyId, key);
  if (r === null) {
    delete all[key];
  } else {
    if (r.roles) {
      const known = new Set((db.prepare('SELECT key FROM roles WHERE property_id = ?')
        .all(ctx.propertyId) as { key: string }[]).map((x) => x.key));
      const bad = r.roles.filter((x) => !known.has(x));
      if (bad.length) throw new HttpError(400, 'unknown_role', `No such role: ${bad.join(', ')}.`);
    }
    if (r.context && r.context.some((c) => !def.context.includes(c))) {
      throw new HttpError(400, 'bad_context', `"${def.label}" cannot reach that person.`);
    }
    const next = { ...routingFor(db, ctx.propertyId, key), ...r };
    if (!next.off && next.roles.length === 0 && next.context.length === 0) {
      throw new HttpError(400, 'nobody',
        `"${def.label}" would reach nobody. Pick at least one role or person, or switch it off.`);
    }
    all[key] = { roles: next.roles, context: next.context, level: next.level, off: next.off };
  }
  setSetting(db, ctx.propertyId, SETTING, all, nowIso(), ctx.userId ?? undefined);
  const after = routingFor(db, ctx.propertyId, key);
  audit(db, {
    propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
    action: r === null ? 'alert_routing.reset' : 'alert_routing.changed',
    entityType: 'alert_event', entityId: key, before, after, ip: ctx.ip,
  });
  return after;
}

/* ---------------------------------------------------------------- sending ---- */

export interface Notice {
  title: string; body?: string; entityType?: string; entityId?: string; at?: string;
}

export interface Who {
  /** Staff id of the person whose team lead should hear about it. */
  teamLeadOfStaffId?: string | null;
  reporterUserId?: string | null;
  assigneeStaffId?: string | null;
  completerUserId?: string | null;
  /** Nobody needs the bell for what they just did themselves. */
  exceptUserId?: string | null;
}

function usersWithRoles(db: Db, propertyId: string, roles: string[]): string[] {
  if (roles.length === 0) return [];
  return (db.prepare(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.property_id = ? AND u.is_active = 1 AND r.key IN (${roles.map(() => '?').join(',')})`
  ).all(propertyId, ...roles) as { id: string }[]).map((r) => r.id);
}

function contextUsers(db: Db, propertyId: string, context: Context[], who: Who): string[] {
  const out: string[] = [];
  for (const c of context) {
    if (c === '@team_lead' && who.teamLeadOfStaffId) {
      out.push(...(db.prepare(
        `SELECT u.id FROM staff s
           JOIN teams t ON t.id = s.team_id
           JOIN staff l ON l.id = t.team_lead_staff_id
           JOIN users u ON u.staff_id = l.id
          WHERE s.id = ? AND s.property_id = ? AND u.is_active = 1`
      ).all(who.teamLeadOfStaffId, propertyId) as { id: string }[]).map((r) => r.id));
    }
    if (c === '@assignee' && who.assigneeStaffId) {
      out.push(...(db.prepare(
        'SELECT id FROM users WHERE staff_id = ? AND property_id = ? AND is_active = 1'
      ).all(who.assigneeStaffId, propertyId) as { id: string }[]).map((r) => r.id));
    }
    if (c === '@reporter' && who.reporterUserId) out.push(who.reporterUserId);
    if (c === '@completer' && who.completerUserId) out.push(who.completerUserId);
  }
  return out;
}

/**
 * Put an event on the bell of everybody it is routed to, once each, at its loudness.
 * Returns how many people were told. Safe inside a transaction: the live nudge is
 * deferred until after commit by the bus.
 */
export function alert(db: Db, propertyId: string, key: string, n: Notice, who: Who = {}): number {
  const r = routingFor(db, propertyId, key);
  if (r.off) return 0;
  const people = new Set([
    ...usersWithRoles(db, propertyId, r.roles),
    ...contextUsers(db, propertyId, r.context, who),
  ]);
  if (who.exceptUserId) people.delete(who.exceptUserId);
  const at = n.at ?? nowIso();
  const ins = db.prepare(
    `INSERT INTO notifications (id, property_id, user_id, kind, title, body, entity_type, entity_id,
                                created_at, level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const userId of people) {
    ins.run(ulid(), propertyId, userId, key, n.title, n.body ?? null,
            n.entityType ?? null, n.entityId ?? null, at, r.level);
    bus.publishTo(userId, 'notification');
  }
  return people.size;
}
