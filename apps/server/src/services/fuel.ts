import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nextRef } from '../lib/refs.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import { fuelTolerancePct } from './settings.js';
import { notifyRole } from './escalation.js';
import * as workOrders from './workOrders.js';

export interface Ctx { propertyId: string; userId: string | null; displayName: string; ip?: string }

/**
 * A horizontal cylindrical tank is not linear. Treating millimetres as proportional
 * to litres is a standing 5-8% error — larger than the loss you are trying to detect.
 * The chart is a list of [mm, litres] points; we interpolate between them.
 */
export function litresFromDip(chart: [number, number][] | null, mm: number): number {
  if (!chart || chart.length < 2) {
    throw new HttpError(400, 'no_dip_chart',
      'This tank has no calibration chart, so a dip in millimetres cannot be converted to litres. ' +
      'Add the chart in Admin, or record the reading in litres.');
  }
  const points = [...chart].sort((a, b) => a[0] - b[0]);
  if (mm <= points[0]![0]) return points[0]![1];
  const last = points[points.length - 1]!;
  if (mm >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]!;
    const [x2, y2] = points[i]!;
    if (mm <= x2) return y1 + ((mm - x1) / (x2 - x1)) * (y2 - y1);
  }
  return last[1];
}

function tank(db: Db, propertyId: string, tankId: string) {
  const t = db.prepare('SELECT * FROM fuel_tanks WHERE id = ? AND property_id = ?')
    .get(tankId, propertyId) as {
      id: string; name: string; capacity_l: number; min_level_l: number;
      dip_chart_json: string | null; current_level_l: number | null;
    } | undefined;
  if (!t) throw new HttpError(404, 'not_found', 'That tank does not exist.');
  return t;
}

function setLevel(db: Db, tankId: string, litres: number, at: string): void {
  db.prepare('UPDATE fuel_tanks SET current_level_l = ?, current_level_at = ?, updated_at = ? WHERE id = ?')
    .run(litres, at, at, tankId);
}

// ---------------------------------------------------------------------------
// Dips
// ---------------------------------------------------------------------------

export function logDip(
  db: Db, ctx: Ctx, tankId: string,
  input: { litres?: number; dipMm?: number; takenAt?: string; shiftPatternId?: string; note?: string }
): { id: string; litres: number; belowMinimum: boolean } {
  const t = tank(db, ctx.propertyId, tankId);
  const at = input.takenAt ?? nowIso();
  let litres = input.litres;
  if (litres == null) {
    if (input.dipMm == null) throw new HttpError(400, 'invalid', 'Give a dip in millimetres or a level in litres.');
    litres = litresFromDip(t.dip_chart_json ? JSON.parse(t.dip_chart_json) : null, input.dipMm);
  }
  if (litres < 0 || litres > t.capacity_l * 1.02) {
    throw new HttpError(400, 'out_of_range',
      `${Math.round(litres)} L is outside what a ${Math.round(t.capacity_l)} L tank can hold. Check the reading.`);
  }
  const id = ulid();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO fuel_dips (id, tank_id, taken_at, shift_pattern_id, dip_mm, litres, taken_by, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, tankId, at, input.shiftPatternId ?? null, input.dipMm ?? null, litres, ctx.userId,
          input.note ?? null, nowIso());
    setLevel(db, tankId, litres, at);
  })();

  const belowMinimum = litres < t.min_level_l;
  if (belowMinimum) {
    notifyRole(db, ctx.propertyId, 'supervisor', {
      kind: 'fuel_low',
      title: `${t.name} below minimum`,
      body: `${Math.round(litres)} L against a minimum of ${Math.round(t.min_level_l)} L. Order diesel.`,
      entityType: 'fuel_tank', entityId: tankId,
    });
  }
  return { id, litres, belowMinimum };
}

// ---------------------------------------------------------------------------
// Deliveries — the two-signature record
// ---------------------------------------------------------------------------

export interface DeliveryInput {
  tankId: string; deliveredAt?: string; vendorId?: string; waybillNo?: string;
  truckReg?: string; driverName?: string; orderedL?: number; invoicedL: number;
  dipBeforeL: number; dipAfterL: number; unitPriceKobo?: number;
  witnessedBy: string; notes?: string;
}

export function recordDelivery(db: Db, ctx: Ctx, input: DeliveryInput) {
  const t = tank(db, ctx.propertyId, input.tankId);
  if (input.witnessedBy === ctx.userId) {
    throw new HttpError(403, 'same_signature',
      'The person who receives a delivery cannot also sign it off. Get a second person to witness it.');
  }
  const witness = db.prepare('SELECT id FROM users WHERE id = ? AND property_id = ? AND is_active = 1')
    .get(input.witnessedBy, ctx.propertyId);
  if (!witness) throw new HttpError(400, 'unknown_witness', 'That witness is not an active user.');
  if (input.dipAfterL < input.dipBeforeL) {
    throw new HttpError(400, 'invalid_dips', 'The dip after the discharge cannot be lower than the dip before it.');
  }
  if (input.dipAfterL > t.capacity_l * 1.02) {
    throw new HttpError(400, 'over_capacity',
      `A closing dip of ${Math.round(input.dipAfterL)} L exceeds the tank's ${Math.round(t.capacity_l)} L capacity.`);
  }

  const received = round2(input.dipAfterL - input.dipBeforeL);
  const variance = round2(received - input.invoicedL);
  const variancePct = round2((variance / input.invoicedL) * 100);
  const tolerance = fuelTolerancePct(db, ctx.propertyId);
  const flagged = Math.abs(variancePct) > tolerance;
  const at = input.deliveredAt ?? nowIso();
  const price = input.unitPriceKobo ?? 0;
  const id = ulid();

  const ref = db.transaction(() => {
    const r = nextRef(db, ctx.propertyId, 'FD');
    db.prepare(
      `INSERT INTO fuel_deliveries (id, property_id, ref, tank_id, delivered_at, vendor_id, waybill_no,
        truck_reg, driver_name, ordered_l, invoiced_l, dip_before_l, dip_after_l, received_l, variance_l,
        variance_pct, flagged, unit_price_kobo, total_kobo, received_by, witnessed_by, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ctx.propertyId, r, input.tankId, at, input.vendorId ?? null, input.waybillNo ?? null,
          input.truckReg ?? null, input.driverName ?? null, input.orderedL ?? null, input.invoicedL,
          input.dipBeforeL, input.dipAfterL, received, variance, variancePct, flagged ? 1 : 0,
          price, Math.round(price * input.invoicedL), ctx.userId, input.witnessedBy,
          input.notes ?? null, nowIso());
    setLevel(db, input.tankId, input.dipAfterL, at);
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: 'fuel.delivery', entityType: 'fuel_delivery', entityId: id,
      after: { ref: r, invoicedL: input.invoicedL, receivedL: received, variancePct, flagged }, ip: ctx.ip,
    });
    return r;
  })();

  if (flagged) {
    notifyRole(db, ctx.propertyId, 'hod', {
      kind: 'fuel_variance',
      title: `Delivery ${ref} is ${variancePct > 0 ? 'over' : 'short'} by ${Math.abs(variance)} L`,
      body: `Invoiced ${input.invoicedL} L, received ${received} L (${variancePct}%). Tolerance is ${tolerance}%.`,
      entityType: 'fuel_delivery', entityId: id,
    });
  }
  return { id, ref, receivedL: received, varianceL: variance, variancePct, flagged, tolerancePct: tolerance };
}

export function issue(
  db: Db, ctx: Ctx,
  input: { tankId: string; toAssetId?: string; toTankId?: string; quantityL: number;
           method?: 'pump' | 'manual' | 'auto_topup'; issuedAt?: string; note?: string }
) {
  const t = tank(db, ctx.propertyId, input.tankId);
  if (input.quantityL <= 0) throw new HttpError(400, 'invalid', 'Quantity must be greater than zero.');
  if (!input.toAssetId && !input.toTankId) {
    throw new HttpError(400, 'no_destination', 'Say which genset or tank the fuel went to.');
  }
  const at = input.issuedAt ?? nowIso();
  const id = ulid();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO fuel_issues (id, tank_id, to_asset_id, to_tank_id, issued_at, quantity_l, method,
        issued_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.tankId, input.toAssetId ?? null, input.toTankId ?? null, at, input.quantityL,
          input.method ?? 'pump', ctx.userId, input.note ?? null, nowIso());
    if (t.current_level_l != null) setLevel(db, input.tankId, round2(t.current_level_l - input.quantityL), at);
    if (input.toTankId) {
      const dest = tank(db, ctx.propertyId, input.toTankId);
      if (dest.current_level_l != null) {
        setLevel(db, input.toTankId, round2(dest.current_level_l + input.quantityL), at);
      }
    }
  })();
  return { id, quantityL: input.quantityL };
}

// ---------------------------------------------------------------------------
// Runs and engine health
// ---------------------------------------------------------------------------

export interface RunInput {
  gensetAssetId: string; startedAt: string; endedAt: string;
  hoursStart: number; hoursEnd: number;
  fuelStartL?: number; fuelEndL?: number; fuelTopupL?: number;
  avgLoadKw?: number; kwhGenerated?: number;
  reason?: 'utility_outage' | 'weekly_test' | 'load_test' | 'maintenance' | 'load_shedding';
  outageId?: string; notes?: string;
}

export interface Profile {
  asset_id: string; kva_rating: number;
  expected_lph_at_50pct: number | null; expected_lph_at_75pct: number | null;
  expected_lph_at_100pct: number | null; deviation_threshold_pct: number;
  consecutive_deviations: number; service_interval_hours: number | null; next_service_hours: number | null;
}

/** Interpolate the expected burn for the load actually carried. */
export function expectedLph(p: Profile, avgLoadKw?: number): number | null {
  const at50 = p.expected_lph_at_50pct, at75 = p.expected_lph_at_75pct, at100 = p.expected_lph_at_100pct;
  if (at50 == null && at75 == null && at100 == null) return null;
  if (avgLoadKw == null || !p.kva_rating) return at75 ?? at50 ?? at100;
  // kVA at 0.8 power factor gives usable kW.
  const loadPct = Math.max(0, Math.min(1, avgLoadKw / (p.kva_rating * 0.8)));
  const pts: [number, number][] = [];
  if (at50 != null) pts.push([0.5, at50]);
  if (at75 != null) pts.push([0.75, at75]);
  if (at100 != null) pts.push([1.0, at100]);
  if (pts.length === 1) return pts[0]![1];
  if (loadPct <= pts[0]![0]) return pts[0]![1];
  const last = pts[pts.length - 1]!;
  if (loadPct >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1]!;
    const [x2, y2] = pts[i]!;
    if (loadPct <= x2) return round2(y1 + ((loadPct - x1) / (x2 - x1)) * (y2 - y1));
  }
  return last[1];
}

export function recordRun(db: Db, ctx: Ctx, input: RunInput) {
  if (input.hoursEnd < input.hoursStart) {
    throw new HttpError(400, 'meter_went_backwards',
      'The hour meter reading at the end is lower than at the start. Check the readings.');
  }
  const runHours = round2(input.hoursEnd - input.hoursStart);
  const topup = input.fuelTopupL ?? 0;
  const fuelUsed = input.fuelStartL != null && input.fuelEndL != null
    ? round2(input.fuelStartL + topup - input.fuelEndL)
    : null;
  const actualLph = fuelUsed != null && runHours > 0 ? round2(fuelUsed / runHours) : null;

  const profile = db.prepare('SELECT * FROM genset_profiles WHERE asset_id = ?')
    .get(input.gensetAssetId) as Profile | undefined;
  const expected = profile ? expectedLph(profile, input.avgLoadKw) : null;
  const deviation = expected != null && actualLph != null && expected > 0
    ? round2(((actualLph - expected) / expected) * 100)
    : null;

  const at = nowIso();
  const id = ulid();
  let raisedJob: string | null = null;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO generator_runs (id, property_id, genset_asset_id, outage_id, started_at, ended_at,
        hours_start, hours_end, run_hours, reason, fuel_start_l, fuel_end_l, fuel_topup_l, fuel_used_l,
        actual_lph, expected_lph, deviation_pct, avg_load_kw, kwh_generated, logged_by, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ctx.propertyId, input.gensetAssetId, input.outageId ?? null, input.startedAt, input.endedAt,
          input.hoursStart, input.hoursEnd, runHours, input.reason ?? 'utility_outage',
          input.fuelStartL ?? null, input.fuelEndL ?? null, topup, fuelUsed, actualLph, expected,
          deviation, input.avgLoadKw ?? null, input.kwhGenerated ?? null, ctx.userId,
          input.notes ?? null, at);

    // The hour meter is the asset's meter.
    db.prepare('UPDATE assets SET current_meter = ?, current_meter_at = ?, updated_at = ? WHERE id = ?')
      .run(input.hoursEnd, input.endedAt, at, input.gensetAssetId);
    db.prepare(
      `INSERT INTO asset_meter_readings (id, asset_id, read_at, reading, unit, source, read_by, created_at)
       VALUES (?, ?, ?, ?, 'hours', 'run_log', ?, ?)`
    ).run(ulid(), input.gensetAssetId, input.endedAt, input.hoursEnd, ctx.userId, at);
  })();

  // Rising burn at unchanged load is mechanical: injectors, air filter, fuel filter.
  // Three consecutive runs over the threshold raise a job before the set fails during an outage.
  if (profile && deviation != null) {
    const over = deviation > profile.deviation_threshold_pct;
    const streak = over ? profile.consecutive_deviations + 1 : 0;
    db.prepare('UPDATE genset_profiles SET consecutive_deviations = ?, updated_at = ? WHERE asset_id = ?')
      .run(streak, at, input.gensetAssetId);

    if (streak >= 3) {
      const asset = db.prepare('SELECT name FROM assets WHERE id = ?').get(input.gensetAssetId) as
        { name: string } | undefined;
      const job = workOrders.create(db, ctx, {
        title: `${asset?.name ?? 'Generator'} — fuel burn ${deviation}% above expected`,
        description:
          `Three consecutive runs above the ${profile.deviation_threshold_pct}% deviation threshold ` +
          `(latest ${actualLph} L/h against an expected ${expected} L/h). ` +
          `Check injectors, air filter and fuel filter before the set is needed in an outage.`,
        trade: 'mechanical', priority: 'P2', source: 'ppm', assetId: input.gensetAssetId,
      });
      raisedJob = job.ref;
      db.prepare('UPDATE genset_profiles SET consecutive_deviations = 0 WHERE asset_id = ?')
        .run(input.gensetAssetId);
      notifyRole(db, ctx.propertyId, 'supervisor', {
        kind: 'genset_efficiency',
        title: `${job.ref} raised — ${asset?.name ?? 'genset'} burning ${deviation}% over`,
        body: 'Three consecutive runs above threshold. Job raised automatically.',
        entityType: 'work_order', entityId: job.id,
      });
    }
  }

  return { id, runHours, fuelUsedL: fuelUsed, actualLph, expectedLph: expected, deviationPct: deviation,
           costPerKwhKobo: null as number | null, raisedJob };
}

// ---------------------------------------------------------------------------
// Reconciliation — the part that makes the module worth building
// ---------------------------------------------------------------------------

export interface Reconciliation {
  tankId: string; tankName: string; periodStart: string; periodEnd: string;
  openingL: number; deliveriesL: number; issuesL: number; throughputL: number;
  computedClosingL: number; dippedClosingL: number;
  varianceL: number; variancePct: number; tolerancePct: number;
  status: 'ok' | 'flagged';
}

export function reconcile(
  db: Db, propertyId: string, tankId: string, periodStart: string, periodEnd: string
): Reconciliation {
  const t = tank(db, propertyId, tankId);

  const opening = db.prepare(
    'SELECT litres FROM fuel_dips WHERE tank_id = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1'
  ).get(tankId, periodStart) as { litres: number } | undefined;
  const closing = db.prepare(
    'SELECT litres FROM fuel_dips WHERE tank_id = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1'
  ).get(tankId, periodEnd) as { litres: number } | undefined;

  if (!opening || !closing) {
    throw new HttpError(400, 'missing_dips',
      'A reconciliation needs a dip at the start and a dip at the end of the period.');
  }

  const deliveries = (db.prepare(
    'SELECT COALESCE(SUM(received_l),0) AS l FROM fuel_deliveries WHERE tank_id = ? AND delivered_at > ? AND delivered_at <= ?'
  ).get(tankId, periodStart, periodEnd) as { l: number }).l;

  const issues = (db.prepare(
    'SELECT COALESCE(SUM(quantity_l),0) AS l FROM fuel_issues WHERE tank_id = ? AND issued_at > ? AND issued_at <= ?'
  ).get(tankId, periodStart, periodEnd) as { l: number }).l;

  const computed = round2(opening.litres + deliveries - issues);
  const variance = round2(closing.litres - computed);
  // Measured against throughput, not against the closing balance: a 50 L variance on
  // 6,000 L moved is noise; on 200 L moved it is not.
  //
  // When nothing was recorded as moving, throughput is not a usable denominator — a
  // 1,260 L drop against zero recorded movement would read as -126,000%. In that case
  // the honest comparison is against the opening stock, which is what actually left.
  const throughput = deliveries + issues;
  const denominator = throughput > 1 ? throughput : opening.litres;
  const variancePct = denominator > 0 ? round2((variance / denominator) * 100) : 0;
  const tolerance = fuelTolerancePct(db, propertyId);

  return {
    tankId, tankName: t.name, periodStart, periodEnd,
    openingL: opening.litres, deliveriesL: round2(deliveries), issuesL: round2(issues),
    throughputL: round2(throughput),
    computedClosingL: computed, dippedClosingL: closing.litres,
    varianceL: variance, variancePct, tolerancePct: tolerance,
    status: Math.abs(variancePct) > tolerance ? 'flagged' : 'ok',
  };
}

export function saveReconciliation(db: Db, ctx: Ctx, r: Reconciliation): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO fuel_reconciliations (id, property_id, tank_id, period_start, period_end, opening_l,
      deliveries_l, issues_l, computed_closing_l, dipped_closing_l, variance_l, variance_pct, status,
      created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tank_id, period_start, period_end) DO UPDATE SET
       opening_l = excluded.opening_l, deliveries_l = excluded.deliveries_l, issues_l = excluded.issues_l,
       computed_closing_l = excluded.computed_closing_l, dipped_closing_l = excluded.dipped_closing_l,
       variance_l = excluded.variance_l, variance_pct = excluded.variance_pct, status = excluded.status`
  ).run(id, ctx.propertyId, r.tankId, r.periodStart, r.periodEnd, r.openingL, r.deliveriesL, r.issuesL,
        r.computedClosingL, r.dippedClosingL, r.varianceL, r.variancePct, r.status, ctx.userId, nowIso());
  return id;
}

/** Cost per kWh generated, against the grid tariff. The number to take upstairs. */
export function costPerKwh(db: Db, propertyId: string, from: string, to: string): {
  fuelUsedL: number; kwh: number; fuelCostKobo: number; costPerKwhKobo: number | null;
} {
  const runs = db.prepare(
    `SELECT COALESCE(SUM(fuel_used_l),0) AS l, COALESCE(SUM(kwh_generated),0) AS k
       FROM generator_runs WHERE property_id = ? AND started_at BETWEEN ? AND ?`
  ).get(propertyId, from, to) as { l: number; k: number };

  const price = db.prepare(
    `SELECT unit_price_kobo FROM fuel_deliveries WHERE property_id = ? AND unit_price_kobo > 0
      ORDER BY delivered_at DESC LIMIT 1`
  ).get(propertyId) as { unit_price_kobo: number } | undefined;

  const perLitre = price?.unit_price_kobo ?? 0;
  const cost = Math.round(runs.l * perLitre);
  return {
    fuelUsedL: round2(runs.l), kwh: round2(runs.k), fuelCostKobo: cost,
    costPerKwhKobo: runs.k > 0 ? Math.round(cost / runs.k) : null,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
