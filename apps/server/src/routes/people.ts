import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../audit.js';
import { availableStaff, mark, propertyTimezone } from '../services/roster.js';
import { localDate } from '../lib/time.js';
import { ctxOf, send } from './_helpers.js';

export async function peopleRoutes(app: FastifyInstance): Promise<void> {
  // `?all=1` adds people who have left, for the Staff tab that can bring them back. Every
  // other caller — pickers, the roster — leaves it off and only ever sees who is here.
  app.get('/api/staff', { preHandler: requirePermission('staff.read') }, async (req) => ({
    staff: app.db.prepare(
      `SELECT s.*, t.name AS team_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id
        WHERE s.property_id = ? AND (? OR s.is_active = 1) ORDER BY s.first_name`
    ).all(req.principal!.propertyId, (req.query as { all?: string }).all === '1' ? 1 : 0),
    teams: app.db.prepare(
      `SELECT t.*,
              l.first_name || ' ' || l.last_name AS team_lead_name,
              v.first_name || ' ' || v.last_name AS supervisor_name,
              (SELECT COUNT(*) FROM staff s WHERE s.team_id = t.id AND s.is_active = 1) AS people
         FROM teams t
         LEFT JOIN staff l ON l.id = t.team_lead_staff_id
         LEFT JOIN staff v ON v.id = t.supervisor_staff_id
        WHERE t.property_id = ? AND t.is_active = 1 ORDER BY t.name`)
      .all(req.principal!.propertyId),
  }));

  // ---- staff and teams -------------------------------------------------------
  // A staff record is not the same thing as a login. Somebody who works a shift needs a
  // staff record so they can be rostered and assigned; whether they ever sign in is a
  // separate question, and plenty of hands on a property never will.
  app.post('/api/teams', { preHandler: requirePermission('staff.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(60), defaultTrade: z.string().max(40).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid();
    try {
      app.db.prepare(
        `INSERT INTO teams (id, property_id, name, default_trade, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, body.data.name, body.data.defaultTrade ?? null, at, at);
    } catch {
      return reply.code(409).send({ error: 'duplicate', message: `There is already a team called "${body.data.name}".` });
    }
    return reply.code(201).send({ ok: true, id });
  });

  /**
   * Who leads a team, and who supervises it.
   *
   * These two columns existed from the first migration and could only ever be filled in by
   * the demo seed — a property that set itself up through the browser had teams with no
   * lead, which silently switched off everything that depends on one: the escalation that
   * goes to a team lead first when nobody accepts a job, and the notice that tells them
   * their team has finished something and it is waiting on their signature.
   */
  app.patch('/api/teams/:id', { preHandler: requirePermission('staff.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(60).optional(),
      defaultTrade: z.string().max(40).nullable().optional(),
      teamLeadStaffId: z.string().nullable().optional(),
      supervisorStaffId: z.string().nullable().optional(),
      isActive: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const { id } = req.params as { id: string };
    const team = app.db.prepare('SELECT * FROM teams WHERE id = ? AND property_id = ?')
      .get(id, me.propertyId) as Record<string, unknown> | undefined;
    if (!team) return reply.code(404).send({ error: 'not_found', message: 'That team does not exist.' });

    const d = body.data;
    // A lead or supervisor has to be a real, active person on this property, or the join
    // that looks for them at escalation time quietly returns nobody and the alert is lost.
    for (const [field, value] of [['teamLeadStaffId', d.teamLeadStaffId],
                                  ['supervisorStaffId', d.supervisorStaffId]] as const) {
      if (value) {
        const person = app.db.prepare(
          'SELECT id FROM staff WHERE id = ? AND property_id = ? AND is_active = 1'
        ).get(value, me.propertyId);
        if (!person) {
          return reply.code(400).send({
            error: 'unknown_staff',
            message: `The person named as ${field === 'teamLeadStaffId' ? 'team lead' : 'supervisor'} is not on the staff list.`,
          });
        }
      }
    }

    const at = nowIso();
    try {
      app.db.prepare(
        `UPDATE teams SET name = ?, default_trade = ?, team_lead_staff_id = ?,
                supervisor_staff_id = ?, is_active = ?, updated_at = ?
          WHERE id = ? AND property_id = ?`
      ).run(d.name ?? team['name'],
            d.defaultTrade === undefined ? team['default_trade'] : d.defaultTrade,
            d.teamLeadStaffId === undefined ? team['team_lead_staff_id'] : d.teamLeadStaffId,
            d.supervisorStaffId === undefined ? team['supervisor_staff_id'] : d.supervisorStaffId,
            d.isActive === undefined ? team['is_active'] : (d.isActive ? 1 : 0),
            at, id, me.propertyId);
    } catch {
      return reply.code(409).send({
        error: 'duplicate', message: `There is already a team called "${d.name}".`,
      });
    }
    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'team.updated', entityType: 'team', entityId: id,
      before: { name: team['name'], lead: team['team_lead_staff_id'] },
      after: { name: d.name ?? team['name'],
               lead: d.teamLeadStaffId === undefined ? team['team_lead_staff_id'] : d.teamLeadStaffId },
      ip: req.ip,
    });
    return { ok: true };
  });

  const StaffBody = z.object({
    firstName: z.string().min(1).max(60), lastName: z.string().min(1).max(60),
    trade: z.string().max(40).nullable().optional(), teamId: z.string().nullable().optional(),
    phone: z.string().max(40).nullable().optional(), staffNo: z.string().max(40).nullable().optional(),
    employmentType: z.enum(['permanent', 'contract', 'casual', 'vendor']).optional(),
    isActive: z.boolean().optional(),
  });

  app.post('/api/staff', { preHandler: requirePermission('staff.manage') }, async (req, reply) => {
    const body = StaffBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;
    if (d.teamId) {
      const team = app.db.prepare('SELECT id FROM teams WHERE id = ? AND property_id = ?')
        .get(d.teamId, me.propertyId);
      if (!team) return reply.code(400).send({ error: 'unknown_team', message: 'That team does not exist.' });
    }
    try {
      app.db.prepare(
        `INSERT INTO staff (id, property_id, staff_no, first_name, last_name, phone, trade, team_id,
                            employment_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, d.staffNo ?? null, d.firstName, d.lastName, d.phone ?? null,
            d.trade ?? null, d.teamId ?? null, d.employmentType ?? 'permanent', at, at);
    } catch {
      return reply.code(409).send({
        error: 'duplicate_staff_no', message: `Staff number "${d.staffNo}" is already in use.`,
      });
    }
    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'staff.created', entityType: 'staff', entityId: id,
      after: { name: `${d.firstName} ${d.lastName}`, trade: d.trade ?? null }, ip: req.ip,
    });
    return reply.code(201).send({ ok: true, id });
  });

  app.patch('/api/staff/:id', { preHandler: requirePermission('staff.manage') }, async (req, reply) => {
    const body = StaffBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const id = (req.params as { id: string }).id; const d = body.data;
    const existing = app.db.prepare('SELECT * FROM staff WHERE id = ? AND property_id = ?')
      .get(id, me.propertyId) as Record<string, unknown> | undefined;
    if (!existing) return reply.code(404).send({ error: 'not_found', message: 'That person is not on the list.' });

    /*
     * A partial update, which is what PATCH promised and this did not do.
     *
     * Every column was being overwritten from the request whether or not the caller sent
     * it, so `?? null` turned "I did not mention the team" into "this person is in no
     * team". The browser form always sends every field, which is why nobody noticed — but
     * anything else that touched one field quietly emptied the rest, and a person dropped
     * out of their team is a person their team lead stops being told about.
     *
     * Undefined now means leave it; an explicit null means clear it.
     */
    const keep = <T>(sent: T | null | undefined, current: unknown): unknown =>
      sent === undefined ? current : sent;

    if (d.teamId) {
      const team = app.db.prepare('SELECT id FROM teams WHERE id = ? AND property_id = ?')
        .get(d.teamId, me.propertyId);
      if (!team) return reply.code(400).send({ error: 'unknown_team', message: 'That team does not exist.' });
    }

    app.db.prepare(
      `UPDATE staff SET first_name = ?, last_name = ?, phone = ?, trade = ?, team_id = ?,
        staff_no = ?, employment_type = ?, is_active = ?, updated_at = ? WHERE id = ?`
    ).run(d.firstName, d.lastName,
          keep(d.phone, existing['phone']),
          keep(d.trade, existing['trade']),
          keep(d.teamId, existing['team_id']),
          keep(d.staffNo, existing['staff_no']),
          d.employmentType ?? existing['employment_type'] ?? 'permanent',
          d.isActive === undefined ? existing['is_active'] : (d.isActive ? 1 : 0),
          nowIso(), id);
    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'staff.updated', entityType: 'staff', entityId: id,
      before: { name: `${existing['first_name']} ${existing['last_name']}`, teamId: existing['team_id'],
                trade: existing['trade'], isActive: !!existing['is_active'] },
      after: { name: `${d.firstName} ${d.lastName}`, teamId: keep(d.teamId, existing['team_id']),
               trade: keep(d.trade, existing['trade']),
               isActive: d.isActive === undefined ? !!existing['is_active'] : d.isActive },
      ip: req.ip,
    });
    return reply.code(200).send({ ok: true, id });
  });

  // ---- shift patterns: any number, any times, nothing hard-coded --------------
  app.get('/api/shift-patterns', { preHandler: requirePermission('roster.read') }, async (req) => ({
    patterns: app.db.prepare(
      'SELECT * FROM shift_patterns WHERE property_id = ? AND is_active = 1 ORDER BY sort_order, start_time'
    ).all(req.principal!.propertyId),
  }));

  app.post('/api/shift-patterns', { preHandler: requirePermission('admin.settings.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(40),
      startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/),
      weekdays: z.string().regex(/^[1-7]{1,7}$/).optional(), colour: z.string().max(20).optional(),
      sortOrder: z.number().int().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const d = body.data; const me = req.principal!; const at = nowIso(); const id = ulid();
    const crosses = d.endTime <= d.startTime ? 1 : 0;
    try {
      app.db.prepare(
        `INSERT INTO shift_patterns (id, property_id, name, start_time, end_time, crosses_midnight,
          weekdays, colour, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, d.name, d.startTime, d.endTime, crosses,
            d.weekdays ?? '1234567', d.colour ?? null, d.sortOrder ?? 0, at, at);
    } catch {
      return reply.code(409).send({ error: 'duplicate', message: `A shift called "${d.name}" already exists.` });
    }
    return reply.code(201).send({ ok: true, id, crossesMidnight: !!crosses });
  });

  // ---- roster ----------------------------------------------------------------
  app.get('/api/roster', { preHandler: requirePermission('roster.read') }, async (req) => {
    const me = req.principal!;
    const q = req.query as { from?: string; to?: string };
    const today = localDate(propertyTimezone(app.db, me.propertyId));
    const from = q.from ?? today;
    const to = q.to ?? new Date(new Date(`${from}T00:00:00Z`).getTime() + 6 * 86_400_000)
      .toISOString().slice(0, 10);
    return {
      from, to, today,
      entries: app.db.prepare(
        `SELECT r.*, s.first_name, s.last_name, s.trade, sp.name AS shift_name, sp.colour,
                ab.reason AS absence_reason
           FROM roster_entries r
           JOIN staff s ON s.id = r.staff_id
           LEFT JOIN shift_patterns sp ON sp.id = r.shift_pattern_id
           LEFT JOIN absences ab ON ab.staff_id = r.staff_id AND ab.work_date = r.work_date
          WHERE r.property_id = ? AND r.work_date BETWEEN ? AND ?
          ORDER BY s.first_name, r.work_date`
      ).all(me.propertyId, from, to),
      onShiftToday: availableStaff(app.db, me.propertyId, today),
    };
  });

  app.post('/api/roster', { preHandler: requirePermission('roster.edit') }, async (req, reply) => {
    const body = z.object({
      entries: z.array(z.object({
        staffId: z.string(), workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        shiftPatternId: z.string().nullable().optional(),
        status: z.enum(['scheduled', 'off']).optional(),
      })).min(1).max(500),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso();

    const written = app.db.transaction(() => {
      const ins = app.db.prepare(
        `INSERT INTO roster_entries (id, property_id, staff_id, work_date, shift_pattern_id, status,
          created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (staff_id, work_date) DO UPDATE SET
           shift_pattern_id = excluded.shift_pattern_id, status = excluded.status, updated_at = excluded.updated_at`
      );
      let n = 0;
      for (const e of body.data.entries) {
        const status = e.status ?? (e.shiftPatternId ? 'scheduled' : 'off');
        ins.run(ulid(), me.propertyId, e.staffId, e.workDate,
                status === 'off' ? null : e.shiftPatternId ?? null, status, me.userId, at, at);
        n++;
      }
      return n;
    })();
    return reply.code(201).send({ ok: true, written });
  });

  app.post('/api/roster/publish', { preHandler: requirePermission('roster.publish') }, async (req, reply) => {
    const body = z.object({ from: z.string(), to: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso();
    const r = app.db.prepare(
      `UPDATE roster_entries SET published_at = ?, updated_at = ?
        WHERE property_id = ? AND work_date BETWEEN ? AND ? AND published_at IS NULL`
    ).run(at, at, me.propertyId, body.data.from, body.data.to);
    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'roster.published', entityType: 'roster', entityId: null,
      after: { from: body.data.from, to: body.data.to, entries: r.changes }, ip: req.ip,
    });
    return { ok: true, published: r.changes };
  });

  /** Availability only. This is what the job board needs and all this stores. */
  app.post('/api/roster/mark', { preHandler: requirePermission('roster.mark') }, async (req, reply) => {
    const body = z.object({
      staffId: z.string(), workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      status: z.enum(['present', 'absent']),
      reason: z.enum(['sick', 'off', 'permission', 'training', 'unexplained', 'other']).optional(),
      note: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const d = body.data;
    return send(reply, () => mark(app.db, ctxOf(req), d.staffId, d.workDate, d.status, d.reason, d.note));
  });

  // ---- handover --------------------------------------------------------------
  /** The system fills in the facts it already holds; the human writes only judgement. */
  app.get('/api/handover/draft', { preHandler: requirePermission('handover.write') }, async (req) => {
    const me = req.principal!; const at = nowIso();
    const carried = app.db.prepare(
      `SELECT ref, title, priority, status, hold_reason FROM work_orders
        WHERE property_id = ? AND status IN ('open','assigned','accepted','in_progress','on_hold')
        ORDER BY CASE priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END`
    ).all(me.propertyId);
    const tanks = app.db.prepare(
      `SELECT name, current_level_l, capacity_l, min_level_l FROM fuel_tanks
        WHERE property_id = ? AND is_active = 1`
    ).all(me.propertyId);
    const gensets = app.db.prepare(
      `SELECT a.asset_tag, a.name, a.status, a.current_meter FROM assets a
        JOIN genset_profiles g ON g.asset_id = a.id WHERE a.property_id = ?`
    ).all(me.propertyId);
    const openPermits = app.db.prepare(
      `SELECT ref, type, valid_to FROM permits WHERE property_id = ? AND status = 'issued'`
    ).all(me.propertyId);
    const outage = app.db.prepare(
      `SELECT started_at FROM power_outages WHERE property_id = ? AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`
    ).get(me.propertyId) as { started_at: string } | undefined;

    return {
      at,
      plantState: { tanks, gensets, utilityOffSince: outage?.started_at ?? null },
      carriedJobs: carried,
      openPermits,
      note: 'Confirm or correct the facts above, then write only what the system cannot know.',
    };
  });

  app.post('/api/handover', { preHandler: requirePermission('handover.write') }, async (req, reply) => {
    const body = z.object({
      fromShiftPatternId: z.string().optional(), toShiftPatternId: z.string().optional(),
      fromStaffId: z.string().optional(), toStaffId: z.string().optional(),
      plantState: z.unknown().optional(), carriedJobs: z.unknown().optional(),
      notes: z.string().max(5000).optional(), openPermits: z.string().max(1000).optional(),
      keysHeld: z.string().max(1000).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;
    app.db.prepare(
      `INSERT INTO shift_handovers (id, property_id, at, from_shift_pattern_id, to_shift_pattern_id,
        from_staff_id, to_staff_id, plant_state_json, carried_jobs_json, notes, open_permits, keys_held,
        status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`
    ).run(id, me.propertyId, at, d.fromShiftPatternId ?? null, d.toShiftPatternId ?? null,
          d.fromStaffId ?? null, d.toStaffId ?? null,
          d.plantState ? JSON.stringify(d.plantState) : null,
          d.carriedJobs ? JSON.stringify(d.carriedJobs) : null,
          d.notes ?? null, d.openPermits ?? null, d.keysHeld ?? null, at, at);
    return reply.code(201).send({ ok: true, id });
  });

  /** Acknowledgement is a gate, not a courtesy. */
  app.post('/api/handover/:id/acknowledge', { preHandler: requirePermission('handover.acknowledge') },
    async (req, reply) => {
      const me = req.principal!; const id = (req.params as { id: string }).id; const at = nowIso();
      const h = app.db.prepare('SELECT status, from_staff_id FROM shift_handovers WHERE id = ? AND property_id = ?')
        .get(id, me.propertyId) as { status: string; from_staff_id: string | null } | undefined;
      if (!h) return reply.code(404).send({ error: 'not_found', message: 'That handover does not exist.' });
      if (h.status === 'acknowledged') {
        return reply.code(409).send({ error: 'already_acknowledged', message: 'This handover is already acknowledged.' });
      }
      if (h.from_staff_id && me.staffId && h.from_staff_id === me.staffId) {
        return reply.code(403).send({
          error: 'self_acknowledge',
          message: 'You wrote this handover — the incoming shift has to acknowledge it.',
        });
      }
      app.db.prepare(
        `UPDATE shift_handovers SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?, updated_at = ?
          WHERE id = ?`
      ).run(me.userId, at, at, id);
      return { ok: true };
    });

  app.get('/api/handover', { preHandler: requirePermission('handover.write') }, async (req) => ({
    handovers: app.db.prepare(
      `SELECT h.*, fs.first_name || ' ' || fs.last_name AS from_name,
              ts.first_name || ' ' || ts.last_name AS to_name
         FROM shift_handovers h
         LEFT JOIN staff fs ON fs.id = h.from_staff_id
         LEFT JOIN staff ts ON ts.id = h.to_staff_id
        WHERE h.property_id = ? ORDER BY h.at DESC LIMIT 50`
    ).all(req.principal!.propertyId),
  }));

  app.get('/api/notifications', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'not_signed_in' });
    const me = req.principal;
    return {
      notifications: app.db.prepare(
        'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
      ).all(me.userId),
      unread: (app.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
        .get(me.userId) as { n: number }).n,
    };
  });

  app.post('/api/notifications/read', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'not_signed_in' });
    const r = app.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(nowIso(), req.principal.userId);
    return { ok: true, marked: r.changes };
  });
}
