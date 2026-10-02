import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.js';
import { ulid } from '../lib/ids.js';
import { nextRef } from '../lib/refs.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../audit.js';
import { rollupCosts } from '../services/workOrders.js';
import { budgetVsActual, contractsExpiring } from '../services/reports.js';
import { monthOf } from './_helpers.js';

/**
 * Departmental cost tracking and budget control only. It reconciles with nothing
 * outside the department, so there is no PO/GRN/invoice chain and no tax handling —
 * a requisition is approved, a purchase is recorded, and the cost lands on a job.
 */
export async function moneyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/vendors', { preHandler: requirePermission('vendor.read') }, async (req) => ({
    vendors: app.db.prepare('SELECT * FROM vendors WHERE property_id = ? AND is_active = 1 ORDER BY name')
      .all(req.principal!.propertyId),
    contracts: app.db.prepare(
      `SELECT c.*, v.name AS vendor_name FROM contracts c JOIN vendors v ON v.id = c.vendor_id
        WHERE c.property_id = ? AND c.is_active = 1 ORDER BY c.end_date`
    ).all(req.principal!.propertyId),
    expiringSoon: contractsExpiring(app.db, req.principal!.propertyId, 60),
  }));

  app.post('/api/vendors', { preHandler: requirePermission('vendor.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(120), category: z.string().max(60).optional(),
      contactPerson: z.string().max(80).optional(), phone: z.string().max(40).optional(),
      email: z.string().max(120).optional(), address: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;
    try {
      app.db.prepare(
        `INSERT INTO vendors (id, property_id, name, category, contact_person, phone, email, address,
          created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, d.name, d.category ?? null, d.contactPerson ?? null, d.phone ?? null,
            d.email ?? null, d.address ?? null, at, at);
    } catch {
      return reply.code(409).send({ error: 'duplicate', message: `"${d.name}" is already on the vendor list.` });
    }
    return reply.code(201).send({ ok: true, id });
  });

  app.post('/api/contracts', { preHandler: requirePermission('vendor.manage') }, async (req, reply) => {
    const body = z.object({
      vendorId: z.string(), title: z.string().min(2).max(160),
      type: z.enum(['AMC', 'service', 'supply']),
      startDate: z.string(), endDate: z.string(),
      valueKobo: z.number().int().nonnegative().optional(),
      renewalReminderDays: z.number().int().min(0).max(365).optional(),
      scope: z.string().max(1000).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const d = body.data;
    if (d.endDate <= d.startDate) {
      return reply.code(400).send({ error: 'invalid_dates', message: 'The end date must be after the start date.' });
    }
    const me = req.principal!; const at = nowIso(); const id = ulid();
    app.db.prepare(
      `INSERT INTO contracts (id, property_id, vendor_id, title, type, start_date, end_date, value_kobo,
        renewal_reminder_days, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, me.propertyId, d.vendorId, d.title, d.type, d.startDate, d.endDate, d.valueKobo ?? 0,
          d.renewalReminderDays ?? 60, d.scope ?? null, at, at);
    return reply.code(201).send({ ok: true, id });
  });

  // ---- cost centres and budgets ---------------------------------------------
  app.get('/api/cost-centres', { preHandler: requirePermission('finance.read') }, async (req) => ({
    costCentres: app.db.prepare('SELECT * FROM cost_centres WHERE property_id = ? ORDER BY code')
      .all(req.principal!.propertyId),
  }));

  app.post('/api/cost-centres', { preHandler: requirePermission('finance.budget.edit') }, async (req, reply) => {
    const body = z.object({ code: z.string().min(1).max(20), name: z.string().min(1).max(80) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const id = ulid();
    try {
      app.db.prepare(
        'INSERT INTO cost_centres (id, property_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(id, me.propertyId, body.data.code, body.data.name, nowIso());
    } catch {
      return reply.code(409).send({ error: 'duplicate', message: `Cost centre "${body.data.code}" already exists.` });
    }
    return reply.code(201).send({ ok: true, id });
  });

  app.post('/api/budgets', { preHandler: requirePermission('finance.budget.edit') }, async (req, reply) => {
    const body = z.object({
      costCentreId: z.string(), fiscalYear: z.number().int().min(2000).max(2100),
      periodMonth: z.number().int().min(1).max(12), amountKobo: z.number().int().nonnegative(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const d = body.data;
    app.db.prepare(
      `INSERT INTO budgets (id, property_id, fiscal_year, period_month, cost_centre_id, amount_kobo,
        approved_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (cost_centre_id, fiscal_year, period_month) DO UPDATE SET
         amount_kobo = excluded.amount_kobo, approved_by = excluded.approved_by, updated_at = excluded.updated_at`
    ).run(ulid(), me.propertyId, d.fiscalYear, d.periodMonth, d.costCentreId, d.amountKobo, me.userId, at, at);
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/budgets/vs-actual', { preHandler: requirePermission('finance.read') }, async (req) => {
    const q = req.query as { year?: string; month?: string };
    const now = new Date();
    const year = Number(q.year) || now.getUTCFullYear();
    const month = Number(q.month) || now.getUTCMonth() + 1;
    return { year, month, lines: budgetVsActual(app.db, req.principal!.propertyId, year, month) };
  });

  // ---- purchases and expenses -----------------------------------------------
  app.post('/api/purchases', { preHandler: requirePermission('purchase.record') }, async (req, reply) => {
    const body = z.object({
      description: z.string().min(2).max(300), amountKobo: z.number().int().nonnegative(),
      requisitionId: z.string().optional(), vendorId: z.string().optional(),
      woId: z.string().optional(), costCentreId: z.string().optional(),
      purchasedAt: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;

    if (d.woId) {
      const frozen = app.db.prepare('SELECT costs_frozen FROM work_orders WHERE id = ? AND property_id = ?')
        .get(d.woId, me.propertyId) as { costs_frozen: number } | undefined;
      if (!frozen) return reply.code(404).send({ error: 'not_found', message: 'That job does not exist.' });
      if (frozen.costs_frozen) {
        return reply.code(409).send({
          error: 'costs_frozen', message: 'That job has been verified — its costs are frozen.',
        });
      }
    }

    const ref = app.db.transaction(() => {
      const r = nextRef(app.db, me.propertyId, 'PU');
      app.db.prepare(
        `INSERT INTO purchases (id, property_id, ref, requisition_id, vendor_id, purchased_at, description,
          amount_kobo, wo_id, cost_centre_id, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, r, d.requisitionId ?? null, d.vendorId ?? null, d.purchasedAt ?? at,
            d.description, d.amountKobo, d.woId ?? null, d.costCentreId ?? null, me.userId, at);
      if (d.requisitionId) {
        app.db.prepare(`UPDATE requisitions SET status = 'purchased', updated_at = ? WHERE id = ? AND status = 'approved'`)
          .run(at, d.requisitionId);
      }
      if (d.woId) rollupCosts(app.db, me.propertyId, d.woId);
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'purchase.recorded', entityType: 'purchase', entityId: id,
        after: { ref: r, amountKobo: d.amountKobo, woId: d.woId }, ip: req.ip,
      });
      return r;
    })();
    return reply.code(201).send({ ok: true, id, ref });
  });

  // Spend is already read a month at a time — the budget it is measured against is set
  // per calendar month, so anything else would compare a quarter of spend to a month of
  // budget and read as a disaster.
  app.get('/api/purchases', { preHandler: requirePermission('finance.read') }, async (req) => {
    const period = monthOf(app, req);
    return {
      period,
      purchases: app.db.prepare(
        `SELECT p.*, v.name AS vendor_name, c.code AS cost_centre, w.ref AS wo_ref FROM purchases p
           LEFT JOIN vendors v ON v.id = p.vendor_id
           LEFT JOIN cost_centres c ON c.id = p.cost_centre_id
           LEFT JOIN work_orders w ON w.id = p.wo_id
          WHERE p.property_id = ? AND p.purchased_at >= ? AND p.purchased_at < ?
          ORDER BY p.purchased_at DESC LIMIT 500`
      ).all(req.principal!.propertyId, period.from, period.to),
    };
  });

  app.post('/api/expenses', { preHandler: requirePermission('finance.expense.create') }, async (req, reply) => {
    const body = z.object({
      costCentreId: z.string(), amountKobo: z.number().int().nonnegative(),
      description: z.string().min(2).max(300), spentAt: z.string().optional(),
      category: z.string().max(60).optional(), vendorId: z.string().optional(), woId: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;
    app.db.prepare(
      `INSERT INTO expenses (id, property_id, spent_at, cost_centre_id, category, amount_kobo, vendor_id,
        wo_id, description, raised_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, me.propertyId, d.spentAt ?? at, d.costCentreId, d.category ?? null, d.amountKobo,
          d.vendorId ?? null, d.woId ?? null, d.description, me.userId, at, at);
    return reply.code(201).send({ ok: true, id });
  });

  app.get('/api/expenses', { preHandler: requirePermission('finance.read') }, async (req) => {
    const period = monthOf(app, req);
    return {
      period,
      expenses: app.db.prepare(
        `SELECT e.*, c.code AS cost_centre, v.name AS vendor_name, w.ref AS wo_ref,
                u.display_name AS raised_by_name, a.display_name AS approved_by_name
           FROM expenses e
           LEFT JOIN cost_centres c ON c.id = e.cost_centre_id
           LEFT JOIN vendors v ON v.id = e.vendor_id
           LEFT JOIN work_orders w ON w.id = e.wo_id
           LEFT JOIN users u ON u.id = e.raised_by
           LEFT JOIN users a ON a.id = e.approved_by
          WHERE e.property_id = ?
            AND (
              (e.spent_at >= ? AND e.spent_at < ?)
              -- An expense still waiting on somebody's approval is outstanding work,
              -- not history. It stays visible until it is dealt with.
              OR e.status = 'pending'
            )
          ORDER BY e.status, e.spent_at DESC LIMIT 500`
      ).all(req.principal!.propertyId, period.from, period.to),
    };
  });

  app.post('/api/expenses/:id/approve', { preHandler: requirePermission('finance.expense.approve') },
    async (req, reply) => {
      const me = req.principal!; const id = (req.params as { id: string }).id;
      const e = app.db.prepare('SELECT raised_by, status FROM expenses WHERE id = ? AND property_id = ?')
        .get(id, me.propertyId) as { raised_by: string; status: string } | undefined;
      if (!e) return reply.code(404).send({ error: 'not_found', message: 'That expense does not exist.' });
      if (e.raised_by === me.userId) {
        return reply.code(403).send({
          error: 'self_approval', message: 'You raised this expense, so someone else has to approve it.',
        });
      }
      if (e.status !== 'pending') {
        return reply.code(409).send({ error: 'already_decided', message: `That expense is already ${e.status}.` });
      }
      const at = nowIso();
      app.db.prepare(
        `UPDATE expenses SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`
      ).run(me.userId, at, at, id);
      return { ok: true };
    });

  app.post('/api/labour-rates', { preHandler: requirePermission('finance.budget.edit') }, async (req, reply) => {
    const body = z.object({
      trade: z.string().min(1).max(40), hourlyRateKobo: z.number().int().nonnegative(),
      effectiveFrom: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso();
    app.db.prepare(
      `INSERT INTO labour_rates (id, property_id, trade, effective_from, hourly_rate_kobo, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (property_id, trade, effective_from) DO UPDATE SET hourly_rate_kobo = excluded.hourly_rate_kobo`
    ).run(ulid(), me.propertyId, body.data.trade, body.data.effectiveFrom ?? at,
          body.data.hourlyRateKobo, at);
    return reply.code(201).send({ ok: true });
  });
}
