import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission, scopeOf } from '../auth/guard.js';
import * as jobs from '../services/jobs.js';
import { availableStaff } from '../services/roster.js';
import { issueToJob } from '../services/stores.js';
import { ulid } from '../lib/ids.js';
import { nextRef } from '../lib/refs.js';
import { nowIso } from '../lib/time.js';
import { ctxOf, monthOf, send } from './_helpers.js';

/**
 * The money columns on a work order. Named once so a new one cannot be added to the table
 * and quietly start appearing in two list responses.
 */
const WO_COST_COLUMNS = ['cost_labour_kobo', 'cost_parts_kobo', 'cost_vendor_kobo'] as const;

/** withoutMoney, but for job money, which is gated on wo.cost.read rather than cost.read. */
function withoutMoneyIf<T extends Record<string, unknown>>(
  allowed: boolean, rows: T[], keys: string[]
): Partial<T>[] {
  if (allowed) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const k of keys) delete out[k];
    return out as Partial<T>;
  });
}

const Create = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(4000).optional(),
  trade: z.string().max(40).optional(),
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional(),
  source: z.enum(['reactive', 'ppm', 'inspection', 'project']).optional(),
  assetId: z.string().optional(), locationId: z.string().optional(), apartmentId: z.string().optional(),
  requestId: z.string().optional(),
  chargeTo: z.enum(['house', 'owner', 'tenant', 'department']).optional(),
});

interface ChecklistLine {
  id: string; seq: number; task: string; expected_value: string | null;
  requires_reading: number; requires_photo: number; is_critical: number;
  result: string | null; value: string | null; note: string | null;
  recorded_at: string | null; recorded_by_name: string | null;
}

/**
 * The template comes from the PPM schedule that raised the job; the results come from
 * whatever has been recorded so far. Returning them merged means the client renders one
 * list and never has to guess which item a saved result belongs to.
 */
function checklistFor(db: FastifyInstance['db'], wo: { id: string; ppm_schedule_id: string | null }) {
  if (!wo.ppm_schedule_id) return null;
  const tpl = db.prepare(
    `SELECT t.id, t.name FROM ppm_schedules p
       JOIN checklist_templates t ON t.id = p.checklist_template_id
      WHERE p.id = ?`
  ).get(wo.ppm_schedule_id) as { id: string; name: string } | undefined;
  if (!tpl) return null;

  const items = db.prepare(
    `SELECT i.id, i.seq, i.task, i.expected_value, i.requires_reading, i.requires_photo, i.is_critical,
            r.result, r.value, r.note, r.recorded_at, u.display_name AS recorded_by_name
       FROM checklist_items i
       LEFT JOIN work_order_checklist_results r ON r.item_id = i.id AND r.wo_id = ?
       LEFT JOIN users u ON u.id = r.recorded_by
      WHERE i.template_id = ? ORDER BY i.seq`
  ).all(wo.id, tpl.id) as ChecklistLine[];

  const done = items.filter((i) => i.result).length;
  const failedCritical = items.filter((i) => i.result === 'fail' && i.is_critical).length;
  return { templateId: tpl.id, name: tpl.name, items, done, total: items.length, failedCritical };
}

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  // ---- board -----------------------------------------------------------------
  app.get('/api/jobs', { preHandler: requirePermission('wo.read') }, async (req) => {
    const me = req.principal!;
    const q = req.query as { status?: string; priority?: string; view?: string;
                             limit?: string; month?: string; period?: string };
    const limit = Math.min(Number(q.limit) || 100, 500);
    const scope = scopeOf(req, 'wo.read');

    const where: string[] = ['w.property_id = ?'];
    const args: unknown[] = [me.propertyId];

    // The board is scoped to a month so a property years in is not shipping its whole
    // history to draw one table. Open work is never hidden by it, though: a P1 raised
    // last month and still running is exactly the job somebody must not lose sight of,
    // so anything the board would call live carries over into every month's view until
    // it is closed. `period=strict` turns that off for a month-by-month report.
    const period = monthOf(app, req);
    const strict = q.period === 'strict';
    if (q.month || strict) {
      if (strict) {
        where.push('w.created_at >= ? AND w.created_at < ?');
        args.push(period.from, period.to);
      } else {
        where.push(`((w.created_at >= ? AND w.created_at < ?)
                     OR w.status NOT IN ('closed','cancelled'))`);
        args.push(period.from, period.to);
      }
    }

    if (scope === 'own' && me.staffId) { where.push('w.assigned_to_staff_id = ?'); args.push(me.staffId); }
    else if (scope === 'own') { where.push('w.created_by = ?'); args.push(me.userId); }
    else if (scope === 'team' && me.staffId) {
      where.push(`(w.assigned_to_staff_id = ? OR w.assigned_team_id =
        (SELECT team_id FROM staff WHERE id = ?))`);
      args.push(me.staffId, me.staffId);
    } else if (scope === 'team') {
      // A team lead whose account was never linked to a staff record has no team to be
      // narrowed to. Falling through with no clause at all would have quietly widened a
      // team-scoped grant into the whole property, so it narrows to what they raised
      // instead: wrong in the harmless direction, and visible on the Users tab as the
      // missing link it actually is.
      where.push('w.created_by = ?');
      args.push(me.userId);
    }
    if (q.status) { where.push('w.status = ?'); args.push(q.status); }
    else if (q.view !== 'all') { where.push(`w.status NOT IN ('closed','cancelled')`); }
    if (q.priority) { where.push('w.priority = ?'); args.push(q.priority); }

    const rows = app.db.prepare(
      `SELECT w.*, a.unit_no, s.asset_tag, s.name AS asset_name,
              st.first_name || ' ' || st.last_name AS assignee
         FROM work_orders w
         LEFT JOIN apartments a ON a.id = w.apartment_id
         LEFT JOIN assets s ON s.id = w.asset_id
         LEFT JOIN staff st ON st.id = w.assigned_to_staff_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE w.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
                 w.due_at ASC LIMIT ?`
    ).all(...args, limit) as (jobs.WorkOrder & Record<string, unknown>)[];

    /*
     * `SELECT w.*` carries the three cost columns off the work order. The job card below
     * is careful to gate them on wo.cost.read and the list was handing them to everybody
     * who could read a job — which is every technician. Same gate, both places.
     */
    const costs = req.principal!.permissions.has('wo.cost.read');
    const visible = costs ? rows
      : rows.map((w) => {
          const o = { ...w } as Record<string, unknown>;
          for (const k of WO_COST_COLUMNS) delete o[k];
          return o as typeof w;
        });

    return {
      jobs: visible.map((w) => ({ ...w, sla: jobs.slaState(w) })),
      showsCost: costs,
      scope,
      period: q.month || strict ? { ...period, strict } : null,
      // Says out loud when the list was cut short, rather than quietly showing 500 of 900.
      truncated: rows.length === limit,
      limit,
    };
  });

  app.get('/api/jobs/:id', { preHandler: requirePermission('wo.read') }, async (req, reply) => {
    const me = req.principal!;
    return send(reply, () => {
      const wo = jobs.get(app.db, me.propertyId, (req.params as { id: string }).id);
      const costs = me.permissions.has('wo.cost.read');
      // The `cost` block below was gated from the start; the raw `job` row beside it was
      // not, and it carries the same three columns. A gate with a door next to it.
      const job = costs ? wo : (() => {
        const o: Record<string, unknown> = { ...wo };
        for (const k of WO_COST_COLUMNS) delete o[k];
        return o;
      })();
      return {
        job,
        showsCost: costs,
        sla: jobs.slaState(wo),
        // A planned job carries the sheet its schedule attached, with whatever has already
        // been recorded merged in — otherwise the technician has an empty form every visit.
        checklist: checklistFor(app.db, wo),
        history: jobs.history(app.db, wo.id),
        // What was fitted and how long it took are the technician's own record and stay
        // visible. What it cost does not.
        parts: withoutMoneyIf(costs, app.db.prepare(
          'SELECT * FROM work_order_parts WHERE wo_id = ? ORDER BY issued_at'
        ).all(wo.id) as Record<string, unknown>[], ['unit_cost_kobo', 'total_kobo']),
        labour: withoutMoneyIf(costs, app.db.prepare(
          'SELECT * FROM work_order_labour WHERE wo_id = ? ORDER BY created_at'
        ).all(wo.id) as Record<string, unknown>[], ['rate_kobo', 'cost_kobo']),
        cost: me.permissions.has('wo.cost.read')
          ? { labourKobo: wo.cost_labour_kobo, partsKobo: wo.cost_parts_kobo,
              vendorKobo: wo.cost_vendor_kobo, totalKobo: jobs.totalCostKobo(wo), frozen: !!wo.costs_frozen }
          : null,
      };
    });
  });

  // ---- lifecycle -------------------------------------------------------------
  app.post('/api/jobs', { preHandler: requirePermission('wo.create') }, async (req, reply) => {
    const parsed = Create.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    return send(reply, () => ({ job: jobs.create(app.db, ctxOf(req), parsed.data) }), 201);
  });

  app.get('/api/jobs/assignable', { preHandler: requirePermission('wo.assign') }, async (req) => {
    const me = req.principal!;
    const staff = availableStaff(app.db, me.propertyId);
    return {
      staff,
      note: staff.length ? undefined
        : 'Nobody is marked present today. Mark the shift on the roster before assigning work.',
    };
  });

  app.post('/api/jobs/:id/assign', { preHandler: requirePermission('wo.assign') }, async (req, reply) => {
    const body = z.object({ staffId: z.string().optional(), teamId: z.string().optional(), note: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const { staffId, teamId, note } = body.data;
    return send(reply, () => ({
      job: jobs.assign(app.db, ctxOf(req), (req.params as { id: string }).id, { staffId, teamId }, note),
    }));
  });

  app.post('/api/jobs/:id/accept', { preHandler: requirePermission('wo.accept') }, async (req, reply) =>
    send(reply, () => ({ job: jobs.accept(app.db, ctxOf(req), (req.params as { id: string }).id) })));

  app.post('/api/jobs/:id/start', { preHandler: requirePermission('wo.update') }, async (req, reply) =>
    send(reply, () => ({ job: jobs.start(app.db, ctxOf(req), (req.params as { id: string }).id) })));

  app.post('/api/jobs/:id/hold', { preHandler: requirePermission('wo.hold') }, async (req, reply) => {
    const body = z.object({
      reason: z.enum(['awaiting_parts', 'awaiting_access', 'awaiting_vendor', 'awaiting_approval']),
      note: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    return send(reply, () => ({
      job: jobs.hold(app.db, ctxOf(req), (req.params as { id: string }).id, body.data.reason, body.data.note),
    }));
  });

  app.post('/api/jobs/:id/resume', { preHandler: requirePermission('wo.hold') }, async (req, reply) =>
    send(reply, () => ({ job: jobs.resume(app.db, ctxOf(req), (req.params as { id: string }).id) })));

  app.post('/api/jobs/:id/complete', { preHandler: requirePermission('wo.complete') }, async (req, reply) => {
    const body = z.object({
      resolutionNotes: z.string().min(3).max(4000),
      failureCause: z.string().max(60).optional(),
      downtimeMinutes: z.number().int().nonnegative().optional(),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid', message: 'Say what you did before marking it complete.' });
    }
    const id = (req.params as { id: string }).id;

    // A planned job whose critical steps were never ticked is the exact case a checklist
    // exists to prevent: signed off as serviced, with no record that the thing that fails
    // in an outage was ever looked at. Non-critical steps can be left; these cannot.
    const sheet = checklistFor(app.db, jobs.get(app.db, req.principal!.propertyId, id));
    if (sheet) {
      const missing = sheet.items.filter((i) => i.is_critical && !i.result);
      if (missing.length) {
        return reply.code(409).send({
          error: 'checklist_incomplete',
          message: `${missing.length} critical step${missing.length === 1 ? '' : 's'} on the ${sheet.name} `
                 + `sheet ${missing.length === 1 ? 'has' : 'have'} not been recorded: `
                 + `${missing.map((i) => i.task).slice(0, 3).join('; ')}`
                 + `${missing.length > 3 ? `; and ${missing.length - 3} more` : ''}.`,
        });
      }
    }

    return send(reply, () => ({
      job: jobs.complete(app.db, ctxOf(req), id, body.data),
    }));
  });

  app.post('/api/jobs/:id/verify', { preHandler: requirePermission('wo.verify') }, async (req, reply) => {
    const note = (req.body as { note?: string } | undefined)?.note;
    return send(reply, () => ({ job: jobs.verify(app.db, ctxOf(req), (req.params as { id: string }).id, note) }));
  });

  app.post('/api/jobs/:id/reopen', { preHandler: requirePermission('wo.assign') }, async (req, reply) => {
    const body = z.object({ reason: z.string().min(3).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'Give a reason for reopening.' });
    return send(reply, () => ({
      job: jobs.reopen(app.db, ctxOf(req), (req.params as { id: string }).id, body.data.reason),
    }));
  });

  app.post('/api/jobs/:id/cancel', { preHandler: requirePermission('wo.cancel') }, async (req, reply) => {
    const body = z.object({ reason: z.string().min(3).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'Give a reason for cancelling.' });
    return send(reply, () => ({
      job: jobs.cancel(app.db, ctxOf(req), (req.params as { id: string }).id, body.data.reason),
    }));
  });

  // ---- labour, parts, comments ----------------------------------------------
  app.post('/api/jobs/:id/labour', { preHandler: requirePermission('wo.update') }, async (req, reply) => {
    const me = req.principal!;
    const body = z.object({ minutes: z.number().int().positive().max(24 * 60), staffId: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const staffId = body.data.staffId ?? me.staffId;
    if (!staffId) return reply.code(400).send({ error: 'no_staff', message: 'This account is not linked to a staff record.' });
    return send(reply, () => {
      jobs.logLabour(app.db, ctxOf(req), (req.params as { id: string }).id, staffId, body.data.minutes);
      return { job: jobs.get(app.db, me.propertyId, (req.params as { id: string }).id) };
    });
  });

  app.post('/api/jobs/:id/parts', { preHandler: requirePermission('stock.issue') }, async (req, reply) => {
    const body = z.object({ itemId: z.string(), qty: z.number().positive() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    return send(reply, () =>
      issueToJob(app.db, ctxOf(req), (req.params as { id: string }).id, body.data.itemId, body.data.qty), 201);
  });

  app.post('/api/jobs/:id/comment', { preHandler: requirePermission('wo.update') }, async (req, reply) => {
    const me = req.principal!;
    const body = z.object({ note: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'Write something first.' });
    return send(reply, () => {
      const wo = jobs.get(app.db, me.propertyId, (req.params as { id: string }).id);
      app.db.prepare(
        `INSERT INTO work_order_events (id, wo_id, at, actor_id, actor_name, event_type, from_status, to_status, note)
         VALUES (?, ?, ?, ?, ?, 'comment', ?, ?, ?)`
      ).run(ulid(), wo.id, nowIso(), me.userId, me.displayName, wo.status, wo.status, body.data.note);
      return { ok: true };
    }, 201);
  });

  // ---- fault intake from other departments -----------------------------------
  app.post('/api/requests', { preHandler: requirePermission('wo.create') }, async (req, reply) => {
    const me = req.principal!;
    const body = z.object({
      description: z.string().min(5).max(2000),
      urgency: z.enum(['emergency', 'high', 'normal', 'low']).optional(),
      apartmentId: z.string().optional(), locationId: z.string().optional(), assetId: z.string().optional(),
      channel: z.enum(['portal', 'phone', 'walk_in', 'inspection', 'ppm']).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });

    const id = ulid();
    const at = nowIso();
    const ref = app.db.transaction(() => {
      const r = nextRef(app.db, me.propertyId, 'RQST');
      app.db.prepare(
        `INSERT INTO job_requests (id, property_id, ref, reported_by, reporter_name, channel, location_id,
          apartment_id, asset_id, description, urgency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, r, me.userId, me.displayName, body.data.channel ?? 'portal',
            body.data.locationId ?? null, body.data.apartmentId ?? null, body.data.assetId ?? null,
            body.data.description, body.data.urgency ?? 'normal', at, at);
      return r;
    })();
    return reply.code(201).send({ ok: true, id, ref });
  });

  app.get('/api/requests', { preHandler: requirePermission('wo.read') }, async (req) => {
    const me = req.principal!;
    const own = scopeOf(req, 'wo.read') === 'own';
    const rows = own
      ? app.db.prepare(
          `SELECT * FROM job_requests WHERE property_id = ? AND reported_by = ? ORDER BY created_at DESC LIMIT 200`
        ).all(me.propertyId, me.userId)
      : app.db.prepare(
          `SELECT * FROM job_requests WHERE property_id = ? ORDER BY status, created_at DESC LIMIT 200`
        ).all(me.propertyId);
    return { requests: rows };
  });

  app.post('/api/requests/:id/convert', { preHandler: requirePermission('wo.create') }, async (req, reply) => {
    const me = req.principal!;
    const body = z.object({
      title: z.string().min(3).max(200),
      priority: z.enum(['P1', 'P2', 'P3', 'P4']),
      trade: z.string().max(40).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });

    const id = (req.params as { id: string }).id;
    const r = app.db.prepare('SELECT * FROM job_requests WHERE id = ? AND property_id = ?')
      .get(id, me.propertyId) as Record<string, string | null> | undefined;
    if (!r) return reply.code(404).send({ error: 'not_found', message: 'That request does not exist.' });
    if (r.status !== 'new') {
      return reply.code(409).send({ error: 'already_handled', message: `That request is already ${r.status}.` });
    }
    return send(reply, () => {
      const job = jobs.create(app.db, ctxOf(req), {
        title: body.data.title, description: r.description ?? undefined, trade: body.data.trade,
        priority: body.data.priority, source: 'reactive', requestId: id,
        assetId: r.asset_id, locationId: r.location_id, apartmentId: r.apartment_id,
      });
      app.db.prepare(
        `UPDATE job_requests SET status = 'converted', converted_wo_id = ?, updated_at = ? WHERE id = ?`
      ).run(job.id, nowIso(), id);
      return { job };
    }, 201);
  });
}
