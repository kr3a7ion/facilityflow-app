import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import * as ppm from '../services/ppm.js';
import { ctxOf, send } from './_helpers.js';

export async function ppmRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ppm/schedules', { preHandler: requirePermission('ppm.read') }, async (req) => ({
    schedules: app.db.prepare(
      `SELECT p.*, a.name AS asset_name, c.name AS category_name, l.name AS location_name
         FROM ppm_schedules p
         LEFT JOIN assets a ON a.id = p.asset_id
         LEFT JOIN asset_categories c ON c.id = p.asset_category_id
         LEFT JOIN locations l ON l.id = p.location_id
        WHERE p.property_id = ? ORDER BY p.is_active DESC, p.next_due_at`
    ).all(req.principal!.propertyId),
  }));

  app.post('/api/ppm/schedules', { preHandler: requirePermission('ppm.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(2).max(120),
      scopeType: z.enum(['asset', 'category', 'location']),
      assetId: z.string().optional(), assetCategoryId: z.string().optional(), locationId: z.string().optional(),
      triggerType: z.enum(['calendar', 'meter']),
      intervalValue: z.number().positive(),
      intervalUnit: z.enum(['day', 'week', 'month', 'year', 'hours', 'kwh']),
      leadDays: z.number().int().min(0).max(90).optional(),
      priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional(),
      defaultTrade: z.string().max(40).optional(), defaultTeamId: z.string().optional(),
      checklistTemplateId: z.string().optional(),
      estimatedMinutes: z.number().int().positive().optional(),
      firstDueAt: z.string().optional(), firstDueMeter: z.number().nonnegative().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const d = body.data; const me = req.principal!; const at = nowIso(); const id = ulid();

    const calendarUnit = ['day', 'week', 'month', 'year'].includes(d.intervalUnit);
    if ((d.triggerType === 'calendar') !== calendarUnit) {
      return reply.code(400).send({
        error: 'mismatched_trigger',
        message: d.triggerType === 'calendar'
          ? 'A calendar schedule needs a day, week, month or year interval.'
          : 'A meter schedule needs an hours or kWh interval.',
      });
    }

    const nextDueAt = d.triggerType === 'calendar'
      ? (d.firstDueAt ?? ppm.addInterval(at, d.intervalValue, d.intervalUnit))
      : null;
    let nextDueMeter = d.firstDueMeter ?? null;
    if (d.triggerType === 'meter' && nextDueMeter == null && d.assetId) {
      const a = app.db.prepare('SELECT current_meter FROM assets WHERE id = ?').get(d.assetId) as
        { current_meter: number | null } | undefined;
      nextDueMeter = (a?.current_meter ?? 0) + d.intervalValue;
    }

    try {
      app.db.prepare(
        `INSERT INTO ppm_schedules (id, property_id, name, scope_type, asset_id, asset_category_id, location_id,
          trigger_type, interval_value, interval_unit, lead_days, checklist_template_id, default_team_id,
          default_trade, priority, estimated_minutes, next_due_at, next_due_meter, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, d.name, d.scopeType, d.assetId ?? null, d.assetCategoryId ?? null,
            d.locationId ?? null, d.triggerType, d.intervalValue, d.intervalUnit, d.leadDays ?? 0,
            d.checklistTemplateId ?? null, d.defaultTeamId ?? null, d.defaultTrade ?? null,
            d.priority ?? 'P4', d.estimatedMinutes ?? null, nextDueAt, nextDueMeter, at, at);
    } catch (err) {
      return reply.code(400).send({
        error: 'invalid_scope',
        message: 'A schedule must name the asset, category or location it applies to.',
      });
    }
    return reply.code(201).send({ ok: true, id, nextDueAt, nextDueMeter });
  });

  /** Runs nightly in the host process; exposed so a supervisor can pull it forward. */
  app.post('/api/ppm/generate', { preHandler: requirePermission('ppm.manage') }, async (req, reply) =>
    send(reply, () => ppm.generateDue(app.db, ctxOf(req)), 201));

  app.get('/api/ppm/compliance', { preHandler: requirePermission('ppm.read') }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const to = q.to ?? nowIso();
    const from = q.from ?? new Date(new Date(to).getTime() - 90 * 86_400_000).toISOString();
    return { from, to, ...ppm.compliance(app.db, req.principal!.propertyId, from, to) };
  });

  // ---- checklists ------------------------------------------------------------
  app.get('/api/ppm/checklists', { preHandler: requirePermission('ppm.read') }, async (req) => {
    const me = req.principal!;
    const templates = app.db.prepare(
      `SELECT t.*, c.name AS category_name,
              (SELECT COUNT(*) FROM checklist_items i WHERE i.template_id = t.id) AS item_count
         FROM checklist_templates t
         LEFT JOIN asset_categories c ON c.id = t.asset_category_id
        WHERE t.property_id = ? AND t.is_active = 1 ORDER BY t.name`
    ).all(me.propertyId) as { id: string }[];
    return {
      templates: templates.map((t) => ({
        ...t,
        items: app.db.prepare(
          'SELECT id, seq, task, expected_value, requires_reading, requires_photo, is_critical FROM checklist_items WHERE template_id = ? ORDER BY seq'
        ).all(t.id),
      })),
    };
  });

  app.post('/api/ppm/checklists', { preHandler: requirePermission('ppm.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(2).max(120), assetCategoryId: z.string().optional(),
      items: z.array(z.object({
        task: z.string().min(2).max(300), expectedValue: z.string().max(120).optional(),
        requiresReading: z.boolean().optional(), requiresPhoto: z.boolean().optional(),
        isCritical: z.boolean().optional(),
      })).min(1).max(200),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid();
    app.db.transaction(() => {
      app.db.prepare(
        `INSERT INTO checklist_templates (id, property_id, name, asset_category_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, body.data.name, body.data.assetCategoryId ?? null, at, at);
      const ins = app.db.prepare(
        `INSERT INTO checklist_items (id, template_id, seq, task, expected_value, requires_reading,
          requires_photo, is_critical) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      body.data.items.forEach((it, i) => {
        ins.run(ulid(), id, i + 1, it.task, it.expectedValue ?? null,
                it.requiresReading ? 1 : 0, it.requiresPhoto ? 1 : 0, it.isCritical ? 1 : 0);
      });
    })();
    return reply.code(201).send({ ok: true, id, items: body.data.items.length });
  });

  app.post('/api/jobs/:id/checklist', { preHandler: requirePermission('wo.update') }, async (req, reply) => {
    const body = z.object({
      results: z.array(z.object({
        itemId: z.string(), result: z.enum(['pass', 'fail', 'na']),
        value: z.string().max(120).optional(), note: z.string().max(500).optional(),
      })).min(1),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const woId = (req.params as { id: string }).id; const at = nowIso();
    const ins = app.db.prepare(
      `INSERT INTO work_order_checklist_results (id, wo_id, item_id, result, value, note, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (wo_id, item_id) DO UPDATE SET result = excluded.result, value = excluded.value,
         note = excluded.note, recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at`
    );
    app.db.transaction(() => {
      for (const r of body.data.results) {
        ins.run(ulid(), woId, r.itemId, r.result, r.value ?? null, r.note ?? null, me.userId, at);
      }
    })();
    const failed = body.data.results.filter((r) => r.result === 'fail').length;
    return reply.code(201).send({
      ok: true, recorded: body.data.results.length,
      failed, note: failed ? `${failed} item(s) failed — consider raising a follow-up job.` : undefined,
    });
  });
}
