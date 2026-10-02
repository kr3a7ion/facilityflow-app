import type { Db } from '../db/connection.js';
import { nowIso } from '../lib/time.js';
import { compliance } from './ppm.js';
import { slaState, type WorkOrder } from './workOrders.js';
import { costPerKwh } from './fuel.js';
import { loadNow } from './load.js';

/**
 * Build each module's headline numbers with the module, not in a reporting phase at
 * the end. A module with no report is a data-entry chore, and the staff feel it.
 */

const OPEN = ['open', 'assigned', 'accepted', 'in_progress', 'on_hold'];

export interface Aging { onTime: number; dueSoon: number; breached: number; paused: number; total: number }

export function openAging(db: Db, propertyId: string, at = nowIso()): Aging {
  const jobs = db.prepare(
    `SELECT * FROM work_orders WHERE property_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`
  ).all(propertyId, ...OPEN) as WorkOrder[];
  const a: Aging = { onTime: 0, dueSoon: 0, breached: 0, paused: 0, total: jobs.length };
  for (const j of jobs) {
    const s = slaState(j, at);
    if (s.state === 'breached') a.breached++;
    else if (s.state === 'paused') a.paused++;
    else if (s.state === 'due_soon') a.dueSoon++;
    else a.onTime++;
  }
  return a;
}

export function agingBuckets(db: Db, propertyId: string, at = nowIso()) {
  const jobs = db.prepare(
    `SELECT reported_at FROM work_orders WHERE property_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`
  ).all(propertyId, ...OPEN) as { reported_at: string }[];
  const buckets = { under24h: 0, d1to3: 0, d3to7: 0, over7d: 0 };
  const now = new Date(at).getTime();
  for (const j of jobs) {
    const days = (now - new Date(j.reported_at).getTime()) / 86_400_000;
    if (days < 1) buckets.under24h++;
    else if (days < 3) buckets.d1to3++;
    else if (days < 7) buckets.d3to7++;
    else buckets.over7d++;
  }
  return buckets;
}

export interface Mttr { jobs: number; meanResolveMinutes: number | null; meanResponseMinutes: number | null }

/** Held time is excluded — a job stuck waiting for a filter is not slow work. */
export function mttr(db: Db, propertyId: string, from: string, to: string, priority?: string): Mttr {
  const rows = db.prepare(
    `SELECT reported_at, responded_at, completed_at, held_minutes_total FROM work_orders
      WHERE property_id = ? AND completed_at IS NOT NULL AND completed_at BETWEEN ? AND ?
        AND (? IS NULL OR priority = ?)`
  ).all(propertyId, from, to, priority ?? null, priority ?? null) as
    { reported_at: string; responded_at: string | null; completed_at: string; held_minutes_total: number }[];

  if (!rows.length) return { jobs: 0, meanResolveMinutes: null, meanResponseMinutes: null };
  let resolve = 0, response = 0, responded = 0;
  for (const r of rows) {
    resolve += (new Date(r.completed_at).getTime() - new Date(r.reported_at).getTime()) / 60000 - r.held_minutes_total;
    if (r.responded_at) {
      response += (new Date(r.responded_at).getTime() - new Date(r.reported_at).getTime()) / 60000;
      responded++;
    }
  }
  return {
    jobs: rows.length,
    meanResolveMinutes: Math.round(resolve / rows.length),
    meanResponseMinutes: responded ? Math.round(response / responded) : null,
  };
}

export function slaBreachRate(db: Db, propertyId: string, from: string, to: string) {
  const rows = db.prepare(
    `SELECT priority, due_at, completed_at, held_minutes_total FROM work_orders
      WHERE property_id = ? AND completed_at IS NOT NULL AND completed_at BETWEEN ? AND ?`
  ).all(propertyId, from, to) as
    { priority: string; due_at: string | null; completed_at: string; held_minutes_total: number }[];

  const byPriority: Record<string, { total: number; breached: number }> = {};
  for (const r of rows) {
    const b = (byPriority[r.priority] ??= { total: 0, breached: 0 });
    b.total++;
    if (r.due_at) {
      const effective = new Date(r.due_at).getTime() + r.held_minutes_total * 60000;
      if (new Date(r.completed_at).getTime() > effective) b.breached++;
    }
  }
  return Object.entries(byPriority).map(([priority, v]) => ({
    priority, total: v.total, breached: v.breached,
    breachPct: v.total ? Math.round((v.breached / v.total) * 1000) / 10 : 0,
  })).sort((a, b) => a.priority.localeCompare(b.priority));
}

/** A fast response with a slow fix is a different problem from the reverse. */
export function firstTimeFix(db: Db, propertyId: string, from: string, to: string) {
  const row = db.prepare(
    `SELECT COUNT(*) AS verified, COALESCE(SUM(CASE WHEN reopened_count > 0 THEN 1 ELSE 0 END),0) AS reopened
       FROM work_orders WHERE property_id = ? AND verified_at BETWEEN ? AND ?`
  ).get(propertyId, from, to) as { verified: number; reopened: number };
  return {
    verified: row.verified, reopened: row.reopened,
    firstTimeFixPct: row.verified ? Math.round(((row.verified - row.reopened) / row.verified) * 1000) / 10 : null,
  };
}

/** Reactive against planned. A department dominated by reactive work is firefighting. */
export function reactiveVsPlanned(db: Db, propertyId: string, from: string, to: string) {
  const rows = db.prepare(
    `SELECT source, COUNT(*) AS n FROM work_orders
      WHERE property_id = ? AND reported_at BETWEEN ? AND ? GROUP BY source`
  ).all(propertyId, from, to) as { source: string; n: number }[];
  const total = rows.reduce((s, r) => s + r.n, 0);
  const reactive = rows.find((r) => r.source === 'reactive')?.n ?? 0;
  return {
    total, bySource: rows,
    reactivePct: total ? Math.round((reactive / total) * 1000) / 10 : 0,
  };
}

export function costPerApartment(db: Db, propertyId: string, from: string, to: string, limit = 20) {
  return db.prepare(
    `SELECT a.unit_no, a.block, COUNT(w.id) AS jobs,
            COALESCE(SUM(w.cost_labour_kobo + w.cost_parts_kobo + w.cost_vendor_kobo),0) AS cost_kobo
       FROM work_orders w JOIN apartments a ON a.id = w.apartment_id
      WHERE w.property_id = ? AND w.completed_at BETWEEN ? AND ?
      GROUP BY a.id ORDER BY cost_kobo DESC LIMIT ?`
  ).all(propertyId, from, to, limit);
}

/** Past roughly half of replacement value, the repair-or-replace argument writes itself. */
export function topAssetsByCost(db: Db, propertyId: string, from: string, to: string, limit = 10) {
  return db.prepare(
    `SELECT s.asset_tag, s.name, s.replacement_cost_kobo, COUNT(w.id) AS jobs,
            COALESCE(SUM(w.cost_labour_kobo + w.cost_parts_kobo + w.cost_vendor_kobo),0) AS cost_kobo,
            CASE WHEN s.replacement_cost_kobo > 0
                 THEN ROUND(100.0 * COALESCE(SUM(w.cost_labour_kobo + w.cost_parts_kobo + w.cost_vendor_kobo),0)
                            / s.replacement_cost_kobo, 1)
                 ELSE NULL END AS pct_of_replacement
       FROM work_orders w JOIN assets s ON s.id = w.asset_id
      WHERE w.property_id = ? AND w.completed_at BETWEEN ? AND ?
      GROUP BY s.id ORDER BY cost_kobo DESC LIMIT ?`
  ).all(propertyId, from, to, limit);
}

export function budgetVsActual(db: Db, propertyId: string, fiscalYear: number, month: number) {
  return db.prepare(
    `SELECT c.code, c.name,
            COALESCE(b.amount_kobo, 0) AS budget_kobo,
            COALESCE((SELECT SUM(p.amount_kobo) FROM purchases p
                       WHERE p.cost_centre_id = c.id
                         AND CAST(strftime('%Y', p.purchased_at) AS INTEGER) = ?
                         AND CAST(strftime('%m', p.purchased_at) AS INTEGER) = ?), 0)
          + COALESCE((SELECT SUM(e.amount_kobo) FROM expenses e
                       WHERE e.cost_centre_id = c.id AND e.status IN ('approved','paid')
                         AND CAST(strftime('%Y', e.spent_at) AS INTEGER) = ?
                         AND CAST(strftime('%m', e.spent_at) AS INTEGER) = ?), 0) AS actual_kobo
       FROM cost_centres c
       LEFT JOIN budgets b ON b.cost_centre_id = c.id AND b.fiscal_year = ? AND b.period_month = ?
      WHERE c.property_id = ? AND c.is_active = 1
      ORDER BY c.code`
  ).all(fiscalYear, month, fiscalYear, month, fiscalYear, month, propertyId);
}

export function contractsExpiring(db: Db, propertyId: string, withinDays = 60, at = nowIso()) {
  const limit = new Date(new Date(at).getTime() + withinDays * 86_400_000).toISOString().slice(0, 10);
  return db.prepare(
    `SELECT c.id, c.title, c.type, c.end_date, v.name AS vendor
       FROM contracts c JOIN vendors v ON v.id = c.vendor_id
      WHERE c.property_id = ? AND c.is_active = 1 AND c.end_date <= ?
      ORDER BY c.end_date`
  ).all(propertyId, limit);
}

export function warrantiesExpiring(db: Db, propertyId: string, withinDays = 60, at = nowIso()) {
  const limit = new Date(new Date(at).getTime() + withinDays * 86_400_000).toISOString().slice(0, 10);
  return db.prepare(
    `SELECT asset_tag, name, warranty_expiry FROM assets
      WHERE property_id = ? AND is_active = 1 AND warranty_expiry IS NOT NULL AND warranty_expiry <= ?
      ORDER BY warranty_expiry`
  ).all(propertyId, limit);
}

export function dashboard(db: Db, propertyId: string, from: string, to: string, at = nowIso()) {
  return {
    generatedAt: at,
    period: { from, to },
    openJobs: openAging(db, propertyId, at),
    aging: agingBuckets(db, propertyId, at),
    mttr: mttr(db, propertyId, from, to),
    slaBreach: slaBreachRate(db, propertyId, from, to),
    firstTimeFix: firstTimeFix(db, propertyId, from, to),
    workMix: reactiveVsPlanned(db, propertyId, from, to),
    ppm: compliance(db, propertyId, from, to),
    power: costPerKwh(db, propertyId, from, to),
    contractsExpiring: contractsExpiring(db, propertyId, 60, at),
    warrantiesExpiring: warrantiesExpiring(db, propertyId, 60, at),
  };
}

export interface PlantStatus {
  at: string;
  utility: { state: 'on' | 'off'; since: string | null; minutes: number | null };
  gensets: { tag: string; name: string; status: string; hours: number | null; lastLph: number | null }[];
  tanks: { id: string; name: string; kind: string; litres: number | null; capacity: number;
           minLevel: number; pctFull: number | null; belowMinimum: boolean }[];
  openP1: { total: number; breached: number };
  onShift: { present: number; scheduled: number; shiftNames: string[] };
  load: { kw: number | null; kva: number | null; stale: boolean; recommendedTag: string | null;
          worstImbalancePct: number | null };
}

/**
 * Everything the status strip shows, in one call. It sits above every screen, so it
 * must be cheap enough to poll.
 */
export function plantStatus(db: Db, propertyId: string, today: string, at = nowIso()): PlantStatus {
  const outage = db.prepare(
    `SELECT started_at FROM power_outages WHERE property_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`
  ).get(propertyId) as { started_at: string } | undefined;

  const gensets = (db.prepare(
    `SELECT a.asset_tag, a.name, a.status, a.current_meter,
            (SELECT actual_lph FROM generator_runs r WHERE r.genset_asset_id = a.id
              ORDER BY r.started_at DESC LIMIT 1) AS last_lph
       FROM assets a JOIN genset_profiles g ON g.asset_id = a.id
      WHERE a.property_id = ? AND a.is_active = 1 ORDER BY a.asset_tag`
  ).all(propertyId) as { asset_tag: string; name: string; status: string;
                         current_meter: number | null; last_lph: number | null }[])
    .map((g) => ({ tag: g.asset_tag, name: g.name, status: g.status,
                   hours: g.current_meter, lastLph: g.last_lph }));

  const tanks = (db.prepare(
    `SELECT id, name, kind, capacity_l, min_level_l, current_level_l FROM fuel_tanks
      WHERE property_id = ? AND is_active = 1 ORDER BY kind DESC, name`
  ).all(propertyId) as { id: string; name: string; kind: string; capacity_l: number;
                         min_level_l: number; current_level_l: number | null }[])
    .map((t) => ({
      id: t.id, name: t.name, kind: t.kind, litres: t.current_level_l, capacity: t.capacity_l,
      minLevel: t.min_level_l,
      pctFull: t.current_level_l == null ? null : Math.round((t.current_level_l / t.capacity_l) * 1000) / 10,
      belowMinimum: t.current_level_l != null && t.current_level_l < t.min_level_l,
    }));

  const p1 = db.prepare(
    `SELECT * FROM work_orders WHERE property_id = ? AND priority = 'P1'
       AND status IN ('open','assigned','accepted','in_progress','on_hold')`
  ).all(propertyId) as WorkOrder[];

  const shift = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN r.status = 'present' THEN 1 ELSE 0 END),0) AS present,
            COALESCE(SUM(CASE WHEN r.status <> 'off' THEN 1 ELSE 0 END),0) AS scheduled
       FROM roster_entries r WHERE r.property_id = ? AND r.work_date = ?`
  ).get(propertyId, today) as { present: number; scheduled: number };

  const now = loadNow(db, propertyId, at);

  const shiftNames = (db.prepare(
    `SELECT DISTINCT sp.name FROM roster_entries r JOIN shift_patterns sp ON sp.id = r.shift_pattern_id
      WHERE r.property_id = ? AND r.work_date = ? AND r.status = 'present' ORDER BY sp.start_time`
  ).all(propertyId, today) as { name: string }[]).map((s) => s.name);

  return {
    at,
    utility: {
      state: outage ? 'off' : 'on',
      since: outage?.started_at ?? null,
      minutes: outage ? Math.round((new Date(at).getTime() - new Date(outage.started_at).getTime()) / 60000) : null,
    },
    gensets, tanks,
    openP1: { total: p1.length, breached: p1.filter((j) => slaState(j, at).resolveBreached).length },
    onShift: { present: shift.present, scheduled: shift.scheduled, shiftNames },
    load: {
      kw: now.totalKw, kva: now.totalKva,
      // Every incomer clamped too long ago to trust. The strip says so rather than
      // showing a comfortable number from last Tuesday.
      stale: now.totalKw == null && now.sources.some((x) => x.isIncomer && x.takenAt != null),
      recommendedTag: now.recommended
        ? now.gensets.find((g) => g.assetId === now.recommended)?.tag ?? null
        : null,
      worstImbalancePct: now.worstImbalance?.pct ?? null,
    },
  };
}
