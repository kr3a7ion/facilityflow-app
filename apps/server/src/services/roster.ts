import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nowIso, localDate } from '../lib/time.js';
import { audit } from '../audit.js';
import { HttpError } from '../lib/errors.js';

export interface Ctx { propertyId: string; userId: string | null; displayName: string; ip?: string }

export function propertyTimezone(db: Db, propertyId: string): string {
  const row = db.prepare('SELECT timezone FROM properties WHERE id = ?').get(propertyId) as
    { timezone: string } | undefined;
  return row?.timezone ?? 'Africa/Lagos';
}

export interface AvailableStaff {
  staff_id: string; first_name: string; last_name: string; trade: string | null;
  team_id: string | null; shift_name: string | null;
}

/**
 * The one question the job board needs the roster to answer.
 * Assignment only offers people whose roster status for today is `present`.
 */
export function availableStaff(db: Db, propertyId: string, workDate?: string): AvailableStaff[] {
  const date = workDate ?? localDate(propertyTimezone(db, propertyId));
  return db.prepare(
    `SELECT s.id AS staff_id, s.first_name, s.last_name, s.trade, s.team_id, sp.name AS shift_name
       FROM roster_entries r
       JOIN staff s ON s.id = r.staff_id AND s.is_active = 1
       LEFT JOIN shift_patterns sp ON sp.id = r.shift_pattern_id
      WHERE r.property_id = ? AND r.work_date = ? AND r.status = 'present'
      ORDER BY s.first_name`
  ).all(propertyId, date) as AvailableStaff[];
}

export function isAvailable(db: Db, propertyId: string, staffId: string, workDate?: string): boolean {
  const date = workDate ?? localDate(propertyTimezone(db, propertyId));
  const row = db.prepare(
    `SELECT 1 FROM roster_entries WHERE property_id = ? AND staff_id = ? AND work_date = ? AND status = 'present'`
  ).get(propertyId, staffId, date);
  return !!row;
}

export type Mark = 'present' | 'absent';

export function mark(
  db: Db, ctx: Ctx, staffId: string, workDate: string, status: Mark,
  reason?: 'sick' | 'off' | 'permission' | 'training' | 'unexplained' | 'other', note?: string
): { ok: true } {
  const at = nowIso();
  const entry = db.prepare(
    'SELECT id, status FROM roster_entries WHERE property_id = ? AND staff_id = ? AND work_date = ?'
  ).get(ctx.propertyId, staffId, workDate) as { id: string; status: string } | undefined;
  if (!entry) throw new HttpError(404, 'not_rostered', 'That person is not on the roster for that day.');
  if (entry.status === 'off') throw new HttpError(409, 'off_duty', 'That person is off duty on that day.');

  db.transaction(() => {
    db.prepare('UPDATE roster_entries SET status = ?, marked_by = ?, marked_at = ?, updated_at = ? WHERE id = ?')
      .run(status, ctx.userId, at, at, entry.id);
    if (status === 'absent') {
      db.prepare(
        `INSERT INTO absences (id, property_id, staff_id, work_date, reason, note, marked_by, marked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (staff_id, work_date) DO UPDATE SET reason = excluded.reason, note = excluded.note,
           marked_by = excluded.marked_by, marked_at = excluded.marked_at`
      ).run(ulid(), ctx.propertyId, staffId, workDate, reason ?? 'unexplained', note ?? null, ctx.userId, at);
    } else {
      db.prepare('DELETE FROM absences WHERE staff_id = ? AND work_date = ?').run(staffId, workDate);
    }
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: `roster.${status}`, entityType: 'roster_entry', entityId: entry.id,
      before: { status: entry.status }, after: { status, workDate, reason }, ip: ctx.ip,
    });
  })();
  return { ok: true };
}
