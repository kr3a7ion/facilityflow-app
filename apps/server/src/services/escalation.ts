import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import * as bus from './bus.js';
import { nowIso } from '../lib/time.js';
import { slaFor } from './settings.js';
import { slaState, type WorkOrder } from './workOrders.js';

/**
 * "Follow-up by supervisors" only works if the system knows a job is late and says so
 * unprompted. This runs every few minutes in the host process.
 *
 * Level 1  past the response deadline           -> team lead
 * Level 2  past the resolve deadline            -> supervisor
 * Level 3  a P1 at twice its resolve deadline   -> HOD
 *
 * Levels only ever go up, so a job is never escalated twice for the same reason.
 */
export interface EscalationResult {
  scanned: number;
  escalated: { id: string; ref: string; from: number; to: number; role: string }[];
}

const OPEN_STATES = ['open', 'assigned', 'accepted', 'in_progress'];

export function tick(db: Db, propertyId: string, at: string = nowIso()): EscalationResult {
  const jobs = db.prepare(
    `SELECT * FROM work_orders WHERE property_id = ? AND status IN (${OPEN_STATES.map(() => '?').join(',')})`
  ).all(propertyId, ...OPEN_STATES) as WorkOrder[];

  const escalated: EscalationResult['escalated'] = [];

  for (const wo of jobs) {
    const sla = slaFor(db, propertyId, wo.priority);
    const s = slaState(wo, at);
    let level = 0;
    let role = sla.escalateToRole;

    if (s.responseBreached) { level = 1; role = 'team_lead'; }
    if (s.resolveBreached) { level = 2; role = sla.escalateToRole; }
    if (s.resolveBreached && wo.priority === 'P1' && s.effectiveDueAt) {
      const doubled = new Date(new Date(s.effectiveDueAt).getTime() + sla.resolveMinutes * 60000).toISOString();
      if (at > doubled) { level = 3; role = 'hod'; }
    }

    if (level <= wo.escalation_level) continue;

    db.transaction(() => {
      db.prepare('UPDATE work_orders SET escalation_level = ?, updated_at = ? WHERE id = ?')
        .run(level, at, wo.id);
      db.prepare(
        `INSERT INTO work_order_events (id, wo_id, at, actor_name, event_type, from_status, to_status, note, meta_json)
         VALUES (?, ?, ?, 'System', 'escalated', ?, ?, ?, ?)`
      ).run(ulid(), wo.id, at, wo.status, wo.status,
            level === 1 ? 'Response deadline passed'
              : level === 2 ? 'Resolve deadline passed'
              : 'P1 at twice its resolve deadline',
            JSON.stringify({ level, role, minutesLate: s.minutesRemaining }));
      notifyRole(db, propertyId, role, {
        kind: 'escalation',
        title: `${wo.ref} · ${wo.priority} escalated`,
        body: `${wo.title} — ${level === 1 ? 'nobody has accepted it' : 'past its deadline'}.`,
        entityType: 'work_order',
        entityId: wo.id,
        at,
      });
    })();

    escalated.push({ id: wo.id, ref: wo.ref, from: wo.escalation_level, to: level, role });
  }

  return { scanned: jobs.length, escalated };
}

export interface Notice {
  kind: string; title: string; body?: string;
  entityType?: string; entityId?: string; at?: string;
}

/** In-app bell only — there is no mail server on this network, and none is needed. */
export function notifyRole(db: Db, propertyId: string, roleKey: string, n: Notice): number {
  const users = db.prepare(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.property_id = ? AND r.key = ? AND u.is_active = 1`
  ).all(propertyId, roleKey) as { id: string }[];
  const at = n.at ?? nowIso();
  const ins = db.prepare(
    `INSERT INTO notifications (id, property_id, user_id, kind, title, body, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const u of users) {
    ins.run(ulid(), propertyId, u.id, n.kind, n.title, n.body ?? null,
            n.entityType ?? null, n.entityId ?? null, at);
    bus.publishTo(u.id, 'notification');
  }
  return users.length;
}

/**
 * The team lead over a particular person, if there is one with an account.
 *
 * notifyRole('team_lead') reaches every team lead on the property, which is right for an
 * escalation — somebody must pick it up — and wrong for "your team finished a job",
 * which is one person's business. Returns the number told, so a caller can fall back.
 */
export function notifyTeamLeadOf(
  db: Db, propertyId: string, staffId: string | null, n: Notice, exceptUserId?: string | null
): number {
  if (!staffId) return 0;
  const leads = db.prepare(
    `SELECT u.id FROM staff s
       JOIN teams t ON t.id = s.team_id
       JOIN staff l ON l.id = t.team_lead_staff_id
       JOIN users u ON u.staff_id = l.id
      WHERE s.id = ? AND s.property_id = ? AND u.is_active = 1`
  ).all(staffId, propertyId) as { id: string }[];
  let told = 0;
  for (const lead of leads) {
    // Nobody needs the bell to tell them what they just did themselves.
    if (exceptUserId && lead.id === exceptUserId) continue;
    notifyUser(db, propertyId, lead.id, n);
    told += 1;
  }
  return told;
}

export function notifyUser(db: Db, propertyId: string, userId: string, n: Notice): void {
  db.prepare(
    `INSERT INTO notifications (id, property_id, user_id, kind, title, body, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ulid(), propertyId, userId, n.kind, n.title, n.body ?? null,
        n.entityType ?? null, n.entityId ?? null, n.at ?? nowIso());
  // Deferred until after the transaction commits — see the bus.
  bus.publishTo(userId, 'notification');
}
