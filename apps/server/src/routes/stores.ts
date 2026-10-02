import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission, scopeOf } from '../auth/guard.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import * as stores from '../services/stores.js';
import { ctxOf, monthOf, send, seesMoney, withoutMoney } from './_helpers.js';

export async function storeRoutes(app: FastifyInstance): Promise<void> {
  /*
   * `SELECT *` here was how the store's valuation reached every technician: avg_cost_kobo
   * is a column on stock_items, and stock.read is granted to anybody who may need to know
   * whether a part is on the shelf. Checking stock and knowing what the stock is worth are
   * two different rights, so the cost column now leaves the server only for cost.read.
   */
  app.get('/api/stock', { preHandler: requirePermission('stock.read') }, async (req) => {
    const me = req.principal!;
    const items = app.db.prepare(
      `SELECT * FROM stock_items WHERE property_id = ? AND is_active = 1 ORDER BY code`
    ).all(me.propertyId) as Record<string, unknown>[];
    return {
      items: withoutMoney(req, items, ['avg_cost_kobo']),
      lowStock: stores.lowStock(app.db, me.propertyId),
      // So the screen knows to drop the columns rather than draw empty ones.
      showsCost: seesMoney(req),
    };
  });

  app.post('/api/stock', { preHandler: requirePermission('stock.receive') }, async (req, reply) => {
    const body = z.object({
      code: z.string().min(1).max(40), name: z.string().min(1).max(120),
      unit: z.string().max(12).optional(), category: z.string().max(60).optional(),
      binLocation: z.string().max(40).optional(), minLevel: z.number().nonnegative().optional(),
      reorderQty: z.number().nonnegative().optional(), avgCostKobo: z.number().int().nonnegative().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;
    try {
      app.db.prepare(
        `INSERT INTO stock_items (id, property_id, code, name, category, unit, bin_location, min_level,
          reorder_qty, avg_cost_kobo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, d.code, d.name, d.category ?? null, d.unit ?? 'pcs',
            d.binLocation ?? null, d.minLevel ?? 0, d.reorderQty ?? 0, d.avgCostKobo ?? 0, at, at);
    } catch {
      return reply.code(409).send({ error: 'duplicate_code', message: `Item code "${d.code}" already exists.` });
    }
    return reply.code(201).send({ ok: true, id });
  });

  app.post('/api/stock/:id/movement', { preHandler: requirePermission('stock.receive') }, async (req, reply) => {
    const body = z.object({
      type: z.enum(['receipt', 'return', 'adjustment', 'transfer', 'count']),
      qtyDelta: z.number(), unitCostKobo: z.number().int().nonnegative().optional(),
      ref: z.string().max(60).optional(), note: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    if (body.data.type === 'adjustment' && !req.principal!.permissions.has('stock.adjust')) {
      return reply.code(403).send({
        error: 'forbidden', required: 'stock.adjust',
        message: 'Adjusting stock outside a receipt or issue needs the stock.adjust permission.',
      });
    }
    return send(reply, () => stores.move(app.db, ctxOf(req), {
      itemId: (req.params as { id: string }).id, ...body.data,
    }), 201);
  });

  // A fast-moving item accumulates thousands of movements. One month at a time keeps
  // the card card-sized; the running balance still comes from the item row, which is
  // computed over every movement, so a scoped view never misreports what is in stock.
  app.get('/api/stock/:id/movements', { preHandler: requirePermission('stock.read') }, async (req) => {
    const period = monthOf(app, req);
    const movements = app.db.prepare(
      `SELECT m.*, u.display_name AS done_by_name, w.ref AS wo_ref FROM stock_movements m
         LEFT JOIN users u ON u.id = m.done_by
         LEFT JOIN work_orders w ON w.id = m.wo_id
        WHERE m.item_id = ? AND m.at >= ? AND m.at < ? ORDER BY m.at DESC LIMIT 500`
    ).all((req.params as { id: string }).id, period.from, period.to) as Record<string, unknown>[];
    return {
      period,
      movements: withoutMoney(req, movements, ['unit_cost_kobo']),
      showsCost: seesMoney(req),
    };
  });

  app.post('/api/stock/recompute', { preHandler: requirePermission('stock.adjust') }, async (req) => ({
    ok: true,
    corrected: stores.recomputeBalances(app.db, req.principal!.propertyId),
    note: 'Balances rebuilt from the movement ledger, which is the source of truth.',
  }));

  // ---- stock counts ----------------------------------------------------------
  app.get('/api/stock/counts', { preHandler: requirePermission('stock.read') }, async (req) => ({
    counts: app.db.prepare(
      `SELECT c.*, u.display_name AS counted_by_name, v.display_name AS verified_by_name,
              (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id) AS lines,
              (SELECT COUNT(*) FROM stock_count_lines l
                WHERE l.count_id = c.id AND ABS(l.variance) > 0.0001) AS variances
         FROM stock_counts c
         LEFT JOIN users u ON u.id = c.counted_by
         LEFT JOIN users v ON v.id = c.verified_by
        WHERE c.property_id = ? ORDER BY c.counted_at DESC LIMIT 50`
    ).all(req.principal!.propertyId),
  }));

  // The count sheet joins stock_items for the unit and bin, and picked up avg_cost_kobo
  // with them. A count is a quantity exercise; whoever is walking the shelves does not
  // need the valuation to do it.
  app.get('/api/stock/counts/:id', { preHandler: requirePermission('stock.read') }, async (req, reply) =>
    send(reply, () => {
      const detail = stores.countDetail(app.db, req.principal!.propertyId,
                                        (req.params as { id: string }).id);
      return {
        ...detail,
        lines: withoutMoney(req, detail.lines as Record<string, unknown>[], ['avg_cost_kobo']),
        showsCost: seesMoney(req),
      };
    }));

  app.post('/api/stock/counts', { preHandler: requirePermission('stock.adjust') }, async (req, reply) => {
    const body = z.object({ note: z.string().max(300).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    return send(reply, () => stores.openCount(app.db, ctxOf(req), body.data.note), 201);
  });

  app.post('/api/stock/counts/:id/lines', { preHandler: requirePermission('stock.adjust') },
    async (req, reply) => {
      const body = z.object({
        lines: z.array(z.object({
          lineId: z.string(), countedQty: z.number().nonnegative(), reason: z.string().max(200).optional(),
        })).min(1).max(500),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      return send(reply, () => stores.recordCount(app.db, ctxOf(req),
                                                  (req.params as { id: string }).id, body.data.lines), 201);
    });

  app.post('/api/stock/counts/:id/post', { preHandler: requirePermission('stock.adjust') },
    async (req, reply) =>
      send(reply, () => stores.postCount(app.db, ctxOf(req), (req.params as { id: string }).id)));

  // ---- requisitions ----------------------------------------------------------
  /*
   * This list used to be guarded by `stock.read`, which is granted to every technician so
   * they can check the shelf. The effect was that a technician could read every
   * requisition in the property, including what each one was estimated to cost. Two
   * different rights wearing one permission code.
   *
   * Now it takes `requisition.read`, granted at 'own' scope to the people who raise them
   * and 'all' to the people who decide, fulfil and pay. The scope is applied in SQL, not
   * in the client — a filtered list that was fetched whole is not a filtered list.
   */
  app.get('/api/requisitions', { preHandler: requirePermission('requisition.read') }, async (req) => {
    const me = req.principal!;
    const mineOnly = scopeOf(req, 'requisition.read') !== 'all';
    const args: unknown[] = [me.propertyId];
    let where = 'r.property_id = ?';
    if (mineOnly) {
      // No userId means a paired device acting without an account behind it; it gets
      // nothing rather than everything.
      where += ' AND r.raised_by = ?';
      args.push(me.userId ?? '');
    }
    const requisitions = app.db.prepare(
      `SELECT r.*, u.display_name AS raised_by_name, a.display_name AS approver_name, w.ref AS wo_ref
         FROM requisitions r
         LEFT JOIN users u ON u.id = r.raised_by
         LEFT JOIN users a ON a.id = r.approver_id
         LEFT JOIN work_orders w ON w.id = r.wo_id
        WHERE ${where} ORDER BY r.status, r.created_at DESC LIMIT 200`
    ).all(...args) as Record<string, unknown>[];

    // An approver deciding on a requisition needs to see what is actually being asked for.
    const ids = requisitions.map((r) => r['id'] as string);
    const lines = ids.length === 0 ? [] : app.db.prepare(
      `SELECT i.requisition_id, i.id, i.description, i.qty, i.estimated_kobo, s.unit
         FROM requisition_items i
         LEFT JOIN stock_items s ON s.id = i.item_id
        WHERE i.requisition_id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids) as Record<string, unknown>[];

    const visibleLines = withoutMoney(req, lines, ['estimated_kobo']);
    const byReq = new Map<string, unknown[]>();
    for (const l of visibleLines) {
      const key = l['requisition_id'] as string;
      const bucket = byReq.get(key) ?? [];
      bucket.push(l);
      byReq.set(key, bucket);
    }
    return {
      requisitions: withoutMoney(req, requisitions, ['estimated_kobo'])
        .map((r) => ({ ...r, lines: byReq.get(r['id'] as string) ?? [] })),
      scope: mineOnly ? 'own' : 'all',
      showsCost: seesMoney(req),
    };
  });

  app.post('/api/requisitions', { preHandler: requirePermission('requisition.create') }, async (req, reply) => {
    const body = z.object({
      purpose: z.string().max(300).optional(), woId: z.string().optional(),
      lines: z.array(z.object({
        itemId: z.string().optional(), description: z.string().min(1).max(200),
        qty: z.number().positive(), estimatedKobo: z.number().int().nonnegative().optional(),
      })).min(1).max(100),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    return send(reply, () => stores.raiseRequisition(app.db, ctxOf(req), body.data), 201);
  });

  app.post('/api/requisitions/:id/decide', { preHandler: requirePermission('requisition.approve') },
    async (req, reply) => {
      const body = z.object({
        decision: z.enum(['approved', 'rejected']), note: z.string().max(500).optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      return send(reply, () => stores.decideRequisition(
        app.db, ctxOf(req), (req.params as { id: string }).id, body.data.decision, body.data.note));
    });
}
