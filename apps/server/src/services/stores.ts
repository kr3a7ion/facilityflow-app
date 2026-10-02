import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nextRef } from '../lib/refs.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import { notifyRole } from './escalation.js';
import { rollupCosts } from './workOrders.js';

export interface Ctx { propertyId: string; userId: string | null; displayName: string; ip?: string }

export type MovementType = 'receipt' | 'issue' | 'return' | 'adjustment' | 'transfer' | 'count';

function item(db: Db, propertyId: string, itemId: string) {
  const it = db.prepare('SELECT * FROM stock_items WHERE id = ? AND property_id = ?')
    .get(itemId, propertyId) as {
      id: string; code: string; name: string; unit: string; current_qty: number;
      min_level: number; avg_cost_kobo: number;
    } | undefined;
  if (!it) throw new HttpError(404, 'not_found', 'That item is not in the store catalogue.');
  return it;
}

/**
 * Every movement is an append-only ledger row carrying the balance it produced, so
 * current_qty can always be recomputed and never has to be trusted on its own.
 */
export function move(
  db: Db, ctx: Ctx,
  input: { itemId: string; type: MovementType; qtyDelta: number; woId?: string;
           unitCostKobo?: number; ref?: string; note?: string; approvedBy?: string }
): { movementId: string; balance: number } {
  const it = item(db, ctx.propertyId, input.itemId);
  if (input.qtyDelta === 0) throw new HttpError(400, 'invalid', 'A movement of zero changes nothing.');

  const balance = round3(it.current_qty + input.qtyDelta);
  if (balance < 0) {
    throw new HttpError(409, 'insufficient_stock',
      `The store has ${it.current_qty} ${it.unit} of ${it.name}; you are trying to take ${Math.abs(input.qtyDelta)}.`);
  }

  const at = nowIso();
  const movementId = ulid();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_movements (id, property_id, item_id, at, type, qty_delta, balance_after, wo_id,
        ref, unit_cost_kobo, done_by, approved_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(movementId, ctx.propertyId, input.itemId, at, input.type, input.qtyDelta, balance,
          input.woId ?? null, input.ref ?? null, input.unitCostKobo ?? it.avg_cost_kobo,
          ctx.userId, input.approvedBy ?? null, input.note ?? null);

    // Weighted average cost, updated only when stock comes in at a stated price.
    let avg = it.avg_cost_kobo;
    if (input.type === 'receipt' && input.unitCostKobo != null && input.qtyDelta > 0) {
      const totalBefore = it.avg_cost_kobo * it.current_qty;
      const totalIn = input.unitCostKobo * input.qtyDelta;
      avg = balance > 0 ? Math.round((totalBefore + totalIn) / balance) : input.unitCostKobo;
    }
    db.prepare('UPDATE stock_items SET current_qty = ?, avg_cost_kobo = ?, updated_at = ? WHERE id = ?')
      .run(balance, avg, at, input.itemId);
  })();

  if (balance <= it.min_level && it.min_level > 0) {
    notifyRole(db, ctx.propertyId, 'storekeeper', {
      kind: 'stock_low',
      title: `${it.name} at or below minimum`,
      body: `${balance} ${it.unit} left, minimum is ${it.min_level}. Raise a requisition.`,
      entityType: 'stock_item', entityId: it.id,
    });
  }
  return { movementId, balance };
}

/** Issuing a part against a job number is the only honest route to a true job cost. */
export function issueToJob(
  db: Db, ctx: Ctx, woId: string, itemId: string, qty: number
): { movementId: string; balance: number; totalKobo: number } {
  if (qty <= 0) throw new HttpError(400, 'invalid', 'Quantity must be greater than zero.');
  const job = db.prepare('SELECT id, status, costs_frozen FROM work_orders WHERE id = ? AND property_id = ?')
    .get(woId, ctx.propertyId) as { id: string; status: string; costs_frozen: number } | undefined;
  if (!job) throw new HttpError(404, 'not_found', 'That job does not exist.');
  if (job.costs_frozen) {
    throw new HttpError(409, 'costs_frozen', 'This job has been verified — parts can no longer be added to it.');
  }
  const it = item(db, ctx.propertyId, itemId);
  const unit = it.avg_cost_kobo;
  const total = Math.round(unit * qty);

  const result = move(db, ctx, { itemId, type: 'issue', qtyDelta: -qty, woId, unitCostKobo: unit });

  db.transaction(() => {
    db.prepare(
      `INSERT INTO work_order_parts (id, wo_id, item_id, description, qty, unit_cost_kobo, total_kobo,
        stock_movement_id, issued_by, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ulid(), woId, itemId, `${it.code} · ${it.name}`, qty, unit, total,
          result.movementId, ctx.userId, nowIso());
    db.prepare(
      `INSERT INTO work_order_events (id, wo_id, at, actor_id, actor_name, event_type, from_status,
        to_status, note, meta_json) VALUES (?, ?, ?, ?, ?, 'part_issued', ?, ?, ?, ?)`
    ).run(ulid(), woId, nowIso(), ctx.userId, ctx.displayName, job.status, job.status,
          `${qty} × ${it.name}`, JSON.stringify({ itemId, qty, totalKobo: total }));
    rollupCosts(db, ctx.propertyId, woId);
  })();

  return { ...result, totalKobo: total };
}

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

export function raiseRequisition(
  db: Db, ctx: Ctx,
  input: { purpose?: string; woId?: string; lines: { itemId?: string; description: string; qty: number; estimatedKobo?: number }[] }
): { id: string; ref: string; estimatedKobo: number } {
  if (!input.lines?.length) throw new HttpError(400, 'no_lines', 'A requisition needs at least one line.');
  const at = nowIso();
  const id = ulid();
  const estimated = input.lines.reduce((sum, l) => sum + (l.estimatedKobo ?? 0), 0);

  const ref = db.transaction(() => {
    const r = nextRef(db, ctx.propertyId, 'RQ');
    db.prepare(
      `INSERT INTO requisitions (id, property_id, ref, raised_by, purpose, wo_id, status, estimated_kobo,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(id, ctx.propertyId, r, ctx.userId, input.purpose ?? null, input.woId ?? null, estimated, at, at);
    const ins = db.prepare(
      `INSERT INTO requisition_items (id, requisition_id, item_id, description, qty, estimated_kobo)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const l of input.lines) {
      ins.run(ulid(), id, l.itemId ?? null, l.description, l.qty, l.estimatedKobo ?? 0);
    }
    return r;
  })();

  notifyRole(db, ctx.propertyId, 'supervisor', {
    kind: 'requisition',
    title: `${ref} awaiting approval`,
    body: `${input.lines.length} line(s) raised by ${ctx.displayName}.`,
    entityType: 'requisition', entityId: id,
  });
  return { id, ref, estimatedKobo: estimated };
}

export function decideRequisition(
  db: Db, ctx: Ctx, id: string, decision: 'approved' | 'rejected', note?: string
) {
  const req = db.prepare('SELECT * FROM requisitions WHERE id = ? AND property_id = ?')
    .get(id, ctx.propertyId) as { id: string; ref: string; raised_by: string; status: string } | undefined;
  if (!req) throw new HttpError(404, 'not_found', 'That requisition does not exist.');
  if (req.status !== 'pending') {
    throw new HttpError(409, 'already_decided', `That requisition is already ${req.status}.`);
  }
  // The person who raises a requisition never approves it.
  if (req.raised_by === ctx.userId) {
    throw new HttpError(403, 'self_approval', 'You raised this requisition, so someone else has to approve it.');
  }
  const at = nowIso();
  db.transaction(() => {
    db.prepare(
      'UPDATE requisitions SET status = ?, approver_id = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?'
    ).run(decision, ctx.userId, at, note ?? null, at, id);
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: `requisition.${decision}`, entityType: 'requisition', entityId: id,
      after: { ref: req.ref, note }, ip: ctx.ip,
    });
  })();
  return { ok: true, status: decision };
}

export function lowStock(db: Db, propertyId: string) {
  return db.prepare(
    `SELECT id, code, name, unit, current_qty, min_level, reorder_qty FROM stock_items
      WHERE property_id = ? AND is_active = 1 AND min_level > 0 AND current_qty <= min_level
      ORDER BY (current_qty / NULLIF(min_level,0)) ASC`
  ).all(propertyId);
}

/** Rebuild current_qty from the ledger. The ledger is the truth; the column is a cache. */
export function recomputeBalances(db: Db, propertyId: string): number {
  const items = db.prepare('SELECT id FROM stock_items WHERE property_id = ?').all(propertyId) as { id: string }[];
  const at = nowIso();
  let fixed = 0;
  for (const it of items) {
    const sum = (db.prepare('SELECT COALESCE(SUM(qty_delta),0) AS q FROM stock_movements WHERE item_id = ?')
      .get(it.id) as { q: number }).q;
    const r = db.prepare('UPDATE stock_items SET current_qty = ?, updated_at = ? WHERE id = ? AND current_qty <> ?')
      .run(round3(sum), at, it.id, round3(sum));
    fixed += r.changes;
  }
  return fixed;
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }

// ---------------------------------------------------------------------------
// Stock counts
// ---------------------------------------------------------------------------

/**
 * A count is a snapshot plus a set of physical numbers. The snapshot is taken when the
 * count opens, not when it is posted: the store keeps moving while somebody walks the
 * shelves, and comparing a Tuesday count against Thursday's balance invents a variance
 * that never existed.
 */
export function openCount(db: Db, ctx: Ctx, note?: string): { id: string; lines: number } {
  const open = db.prepare(
    `SELECT id FROM stock_counts WHERE property_id = ? AND status = 'open' LIMIT 1`
  ).get(ctx.propertyId) as { id: string } | undefined;
  if (open) {
    throw new HttpError(409, 'count_already_open',
      'A stock count is already open. Post or cancel that one before starting another.');
  }

  const items = db.prepare(
    'SELECT id, current_qty FROM stock_items WHERE property_id = ? AND is_active = 1 ORDER BY code'
  ).all(ctx.propertyId) as { id: string; current_qty: number }[];
  if (!items.length) {
    throw new HttpError(409, 'nothing_to_count', 'There is nothing in the catalogue to count.');
  }

  const id = ulid();
  const at = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_counts (id, property_id, counted_at, counted_by, status, note)
       VALUES (?, ?, ?, ?, 'open', ?)`
    ).run(id, ctx.propertyId, at, ctx.userId, note ?? null);
    const ins = db.prepare(
      `INSERT INTO stock_count_lines (id, count_id, item_id, system_qty, counted_qty, variance)
       VALUES (?, ?, ?, ?, ?, 0)`
    );
    // counted_qty starts at the system figure so an untouched line posts no movement —
    // a half-finished count must not write off everything nobody got to.
    for (const it of items) ins.run(ulid(), id, it.id, it.current_qty, it.current_qty);
  })();

  audit(db, {
    propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
    action: 'stock.count.opened', entityType: 'stock_count', entityId: id,
    after: { lines: items.length }, ip: ctx.ip,
  });
  return { id, lines: items.length };
}

export function countDetail(db: Db, propertyId: string, id: string) {
  const count = db.prepare(
    `SELECT c.*, u.display_name AS counted_by_name, v.display_name AS verified_by_name
       FROM stock_counts c
       LEFT JOIN users u ON u.id = c.counted_by
       LEFT JOIN users v ON v.id = c.verified_by
      WHERE c.id = ? AND c.property_id = ?`
  ).get(id, propertyId);
  if (!count) throw new HttpError(404, 'not_found', 'That stock count does not exist.');
  return {
    count,
    lines: db.prepare(
      `SELECT l.*, i.code, i.name, i.unit, i.avg_cost_kobo, i.bin_location
         FROM stock_count_lines l JOIN stock_items i ON i.id = l.item_id
        WHERE l.count_id = ? ORDER BY i.code`
    ).all(id),
  };
}

export function recordCount(
  db: Db, ctx: Ctx, countId: string,
  lines: { lineId: string; countedQty: number; reason?: string }[]
): { recorded: number } {
  const c = db.prepare('SELECT status FROM stock_counts WHERE id = ? AND property_id = ?')
    .get(countId, ctx.propertyId) as { status: string } | undefined;
  if (!c) throw new HttpError(404, 'not_found', 'That stock count does not exist.');
  if (c.status !== 'open') {
    throw new HttpError(409, 'already_posted', 'That count has been posted and cannot be changed.');
  }
  const upd = db.prepare(
    `UPDATE stock_count_lines SET counted_qty = ?, variance = ? - system_qty, reason = ?
      WHERE id = ? AND count_id = ?`
  );
  db.transaction(() => {
    for (const l of lines) {
      if (l.countedQty < 0) {
        throw new HttpError(400, 'invalid', 'A counted quantity cannot be negative.');
      }
      upd.run(l.countedQty, l.countedQty, l.reason ?? null, l.lineId, countId);
    }
  })();
  return { recorded: lines.length };
}

/**
 * Posting turns the count into ledger movements — one per line that actually differs.
 * The balance is never written directly: it moves because a movement says so, which is
 * what keeps `recomputeBalances` able to rebuild it from scratch.
 */
export function postCount(
  db: Db, ctx: Ctx, countId: string
): { posted: number; adjustedKobo: number; unchanged: number } {
  const c = db.prepare('SELECT status, counted_by FROM stock_counts WHERE id = ? AND property_id = ?')
    .get(countId, ctx.propertyId) as { status: string; counted_by: string | null } | undefined;
  if (!c) throw new HttpError(404, 'not_found', 'That stock count does not exist.');
  if (c.status !== 'open') {
    throw new HttpError(409, 'already_posted', 'That count has already been posted.');
  }

  const lines = db.prepare(
    `SELECT l.id, l.item_id, l.counted_qty, l.variance, l.reason, i.name, i.avg_cost_kobo
       FROM stock_count_lines l JOIN stock_items i ON i.id = l.item_id
      WHERE l.count_id = ?`
  ).all(countId) as {
    id: string; item_id: string; counted_qty: number; variance: number;
    reason: string | null; name: string; avg_cost_kobo: number;
  }[];

  const changed = lines.filter((l) => Math.abs(l.variance) > 0.0001);
  let adjustedKobo = 0;
  const at = nowIso();

  db.transaction(() => {
    for (const l of changed) {
      // Re-read the balance inside the transaction: the shelf may have moved between the
      // snapshot and the posting, and the movement must land on the balance that is real.
      const current = (db.prepare('SELECT current_qty FROM stock_items WHERE id = ?')
        .get(l.item_id) as { current_qty: number }).current_qty;
      const balance = Math.round((current + l.variance) * 1000) / 1000;
      if (balance < 0) {
        throw new HttpError(409, 'would_go_negative',
          `Posting ${l.name} would take the balance below zero. Recount that line.`);
      }
      db.prepare(
        `INSERT INTO stock_movements (id, property_id, item_id, at, type, qty_delta, balance_after,
          unit_cost_kobo, ref, done_by, note)
         VALUES (?, ?, ?, ?, 'count', ?, ?, ?, ?, ?, ?)`
      ).run(ulid(), ctx.propertyId, l.item_id, at, l.variance, balance, l.avg_cost_kobo,
            `COUNT-${countId.slice(-6)}`, ctx.userId, l.reason ?? 'Stock count adjustment');
      db.prepare('UPDATE stock_items SET current_qty = ?, updated_at = ? WHERE id = ?')
        .run(balance, at, l.item_id);
      adjustedKobo += Math.round(l.variance * l.avg_cost_kobo);
    }
    db.prepare(`UPDATE stock_counts SET status = 'posted', verified_by = ? WHERE id = ?`)
      .run(ctx.userId, countId);
  })();

  audit(db, {
    propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
    action: 'stock.count.posted', entityType: 'stock_count', entityId: countId,
    after: { adjusted: changed.length, adjustedKobo, countedBy: c.counted_by }, ip: ctx.ip,
  });
  return { posted: changed.length, adjustedKobo, unchanged: lines.length - changed.length };
}
