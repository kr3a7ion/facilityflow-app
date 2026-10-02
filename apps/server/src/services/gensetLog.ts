/**
 * The generator logbook, and the judgement that makes it worth keeping.
 *
 * Recording a temperature is easy. The value is in the system knowing that 96 °C on this
 * set, with this radiator, is the beginning of a failure — and saying so to the person
 * holding the phone, while they are still standing in front of the machine and can do
 * something about it.
 *
 * So every entry is checked against that set's own limits as it is saved, and the verdict
 * is stored with it. Two reasons it is stored rather than recomputed: the limits can be
 * edited later, and a month of history must keep saying what it said at the time; and a
 * supervisor scanning a month of entries for trouble should not be re-deriving a hundred
 * judgements to draw one screen.
 */
import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import { notifyRole } from './escalation.js';

/** Matches the shared route context, whose userId is nullable for scheduled work. */
export interface Ctx {
  propertyId: string; userId: string | null; displayName: string; ip?: string;
}

export interface Limits {
  coolant_temp_max_c: number;
  coolant_temp_min_c: number;
  oil_pressure_min_bar: number;
  battery_volts_min: number;
  nominal_volts: number;
  nominal_hz: number;
  day_tank_min_l: number | null;
  kva_rating: number;
}

export interface Reading {
  state?: 'running' | 'stopped';
  takenAt?: string;
  hoursMeter?: number;
  dayTankL?: number;
  dayTankPct?: number;
  coolantTempC?: number;
  oilPressureBar?: number;
  batteryVolts?: number;
  voltsL1?: number; voltsL2?: number; voltsL3?: number;
  ampsL1?: number; ampsL2?: number; ampsL3?: number;
  frequencyHz?: number;
  loadKw?: number;
  remarks?: string;
}

/** One thing wrong, in the words a technician would use to somebody on the phone. */
export interface Finding {
  field: string;
  severity: 'watch' | 'act';
  says: string;
}

/** Voltage this far from nominal is a fault, not drift. */
const VOLT_TOLERANCE_PCT = 10;
/** Frequency is governed; a whole hertz out is the governor, not the load. */
const HZ_TOLERANCE = 1.5;
/** Past this the set is working harder than it should for hours on end. */
const LOAD_WARN_PCT = 80;

export function limitsFor(db: Db, assetId: string): Limits | null {
  return db.prepare(
    `SELECT coolant_temp_max_c, coolant_temp_min_c, oil_pressure_min_bar, battery_volts_min,
            nominal_volts, nominal_hz, day_tank_min_l, kva_rating
       FROM genset_profiles WHERE asset_id = ?`
  ).get(assetId) as Limits | null;
}

/**
 * Read the entry against the set's limits.
 *
 * Only what was actually entered is judged. A blank oil-pressure box means the gauge was
 * unreadable or the person could not safely get to it, and inventing a finding from a
 * missing number would train everybody to ignore the findings that matter.
 */
export function assess(r: Reading, lim: Limits | null): Finding[] {
  const out: Finding[] = [];
  const running = (r.state ?? 'running') === 'running';
  if (!lim) return out;

  if (r.coolantTempC != null && running) {
    if (r.coolantTempC >= lim.coolant_temp_max_c) {
      out.push({ field: 'coolantTempC', severity: 'act',
        says: `Running at ${r.coolantTempC} °C against a limit of ${lim.coolant_temp_max_c} °C. Check the radiator, the belt and the coolant level before it runs again under load.` });
    } else if (r.coolantTempC >= lim.coolant_temp_max_c - 5) {
      out.push({ field: 'coolantTempC', severity: 'watch',
        says: `${r.coolantTempC} °C is close to the ${lim.coolant_temp_max_c} °C limit. Worth watching on the next round.` });
    } else if (r.coolantTempC < lim.coolant_temp_min_c) {
      out.push({ field: 'coolantTempC', severity: 'watch',
        says: `${r.coolantTempC} °C is cold for a loaded set — a thermostat stuck open wastes fuel and glazes bores.` });
    }
  }

  if (r.oilPressureBar != null && running && r.oilPressureBar < lim.oil_pressure_min_bar) {
    out.push({ field: 'oilPressureBar', severity: 'act',
      says: `Oil pressure ${r.oilPressureBar} bar, below the ${lim.oil_pressure_min_bar} bar minimum. Stop the set rather than run it — this is how an engine is lost.` });
  }

  if (r.batteryVolts != null && r.batteryVolts < lim.battery_volts_min) {
    out.push({ field: 'batteryVolts', severity: running ? 'act' : 'watch',
      says: running
        ? `${r.batteryVolts} V while running means the alternator is not charging. The set will not start next time.`
        : `${r.batteryVolts} V at rest is low. A set that will not crank during an outage is the same as no set at all.` });
  }

  const volts = [r.voltsL1, r.voltsL2, r.voltsL3].filter((v): v is number => v != null);
  if (volts.length > 0 && running) {
    const lo = lim.nominal_volts * (1 - VOLT_TOLERANCE_PCT / 100);
    const hi = lim.nominal_volts * (1 + VOLT_TOLERANCE_PCT / 100);
    const worst = volts.find((v) => v < lo || v > hi);
    if (worst != null) {
      out.push({ field: 'volts', severity: 'act',
        says: `${worst} V against a nominal ${lim.nominal_volts} V. Out by more than ${VOLT_TOLERANCE_PCT}% damages motors and electronics across the building.` });
    }
    // Three phases that disagree is the classic sign of an unbalanced building load.
    if (volts.length === 3) {
      const spread = Math.max(...volts) - Math.min(...volts);
      if (spread > lim.nominal_volts * 0.05) {
        out.push({ field: 'volts', severity: 'watch',
          says: `The three phases differ by ${Math.round(spread)} V. Something is loaded far harder than the others — worth clamping.` });
      }
    }
  }

  if (r.frequencyHz != null && running && Math.abs(r.frequencyHz - lim.nominal_hz) > HZ_TOLERANCE) {
    out.push({ field: 'frequencyHz', severity: 'act',
      says: `${r.frequencyHz} Hz against ${lim.nominal_hz} Hz. The governor is not holding speed; clocks, motors and compressors all suffer.` });
  }

  if (r.loadKw != null && lim.kva_rating > 0) {
    // kW against a kVA plate at the usual 0.8 power factor.
    const pct = Math.round((r.loadKw / (lim.kva_rating * 0.8)) * 100);
    if (pct > 100) {
      out.push({ field: 'loadKw', severity: 'act',
        says: `${r.loadKw} kW is beyond what this set is rated for. Shed load now.` });
    } else if (pct > LOAD_WARN_PCT) {
      out.push({ field: 'loadKw', severity: 'watch',
        says: `${r.loadKw} kW is ${pct}% of rating. There is nothing left for a lift or a chiller starting.` });
    }
  }

  if (r.dayTankL != null && lim.day_tank_min_l != null && r.dayTankL < lim.day_tank_min_l) {
    out.push({ field: 'dayTankL', severity: 'act',
      says: `Day tank at ${r.dayTankL} L, below the ${lim.day_tank_min_l} L minimum. Fill it before the next outage, not during one.` });
  }
  if (r.dayTankPct != null && r.dayTankPct < 25) {
    out.push({ field: 'dayTankPct', severity: r.dayTankPct < 10 ? 'act' : 'watch',
      says: `Day tank about ${Math.round(r.dayTankPct)}% full.` });
  }

  return out;
}

export function record(
  db: Db, ctx: Ctx, assetId: string, r: Reading, timezone: string,
): { id: string; findings: Finding[] } {
  const asset = db.prepare(
    `SELECT a.id, a.asset_tag, a.name FROM assets a
      WHERE a.id = ? AND a.property_id = ? AND a.is_active = 1`
  ).get(assetId, ctx.propertyId) as { id: string; asset_tag: string; name: string } | undefined;
  if (!asset) throw new HttpError(404, 'not_found', 'That generator is not on the register.');

  // The whole worth of a logbook is that every line has somebody's name against it. An
  // unattributable entry is refused rather than stored with a blank author: when a set
  // fails, "who read this gauge, and when" is the first question asked.
  if (!ctx.userId) {
    throw new HttpError(400, 'no_author', 'A log entry has to be recorded by a named person.');
  }

  const lim = limitsFor(db, assetId);
  const at = r.takenAt ?? nowIso();
  const findings = assess(r, lim);
  const id = ulid();

  // The local date, because "today's log" is a question about the property's day, not UTC.
  const workDate = new Date(at).toLocaleDateString('en-CA', { timeZone: timezone });

  // An hour meter that has gone backwards is either a typo or a replaced meter, and both
  // are worth saying out loud rather than quietly storing a negative run.
  if (r.hoursMeter != null) {
    const last = db.prepare(
      `SELECT hours_meter FROM genset_log_entries
        WHERE genset_asset_id = ? AND hours_meter IS NOT NULL
        ORDER BY taken_at DESC LIMIT 1`
    ).get(assetId) as { hours_meter: number } | undefined;
    if (last && r.hoursMeter < last.hours_meter) {
      findings.push({ field: 'hoursMeter', severity: 'watch',
        says: `The hour meter reads ${r.hoursMeter}, lower than the ${last.hours_meter} logged before. Check the reading, or note in remarks that the meter was changed.` });
    }
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO genset_log_entries (
         id, property_id, genset_asset_id, taken_at, work_date, state, hours_meter,
         day_tank_l, day_tank_pct, coolant_temp_c, oil_pressure_bar, battery_volts,
         volts_l1, volts_l2, volts_l3, amps_l1, amps_l2, amps_l3, frequency_hz, load_kw,
         remarks, out_of_range, logged_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, ctx.propertyId, assetId, at, workDate, r.state ?? 'running', r.hoursMeter ?? null,
      r.dayTankL ?? null, r.dayTankPct ?? null, r.coolantTempC ?? null,
      r.oilPressureBar ?? null, r.batteryVolts ?? null,
      r.voltsL1 ?? null, r.voltsL2 ?? null, r.voltsL3 ?? null,
      r.ampsL1 ?? null, r.ampsL2 ?? null, r.ampsL3 ?? null,
      r.frequencyHz ?? null, r.loadKw ?? null,
      r.remarks ?? null,
      findings.length ? JSON.stringify(findings) : null,
      ctx.userId, nowIso(),
    );

    // Also keep the asset's own meter current, so the PPM service interval and the
    // status strip do not disagree with the book.
    if (r.hoursMeter != null) {
      db.prepare('UPDATE assets SET current_meter = ?, updated_at = ? WHERE id = ?')
        .run(r.hoursMeter, nowIso(), assetId);
    }

    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: 'genset.logged', entityType: 'asset', entityId: assetId,
      after: { entryId: id, findings: findings.length }, ip: ctx.ip,
    });

    // Anything at 'act' is a reading somebody has to see today, not at the next review.
    const urgent = findings.filter((f) => f.severity === 'act');
    if (urgent.length > 0) {
      notifyRole(db, ctx.propertyId, 'supervisor', {
        kind: 'genset.alarm',
        title: `${asset.asset_tag} logged out of range`,
        body: urgent.map((f) => f.says).join(' '),
        entityType: 'asset', entityId: assetId, at,
      });
    }
  })();

  return { id, findings };
}

export interface LogRow {
  id: string; taken_at: string; work_date: string; state: string;
  hours_meter: number | null; day_tank_l: number | null; day_tank_pct: number | null;
  coolant_temp_c: number | null; oil_pressure_bar: number | null; battery_volts: number | null;
  volts_l1: number | null; volts_l2: number | null; volts_l3: number | null;
  amps_l1: number | null; amps_l2: number | null; amps_l3: number | null;
  frequency_hz: number | null; load_kw: number | null;
  remarks: string | null; out_of_range: string | null;
  asset_tag: string; asset_name: string; logged_by_name: string;
}

export function entries(
  db: Db, propertyId: string, opts: { assetId?: string; from?: string; to?: string; limit?: number },
): LogRow[] {
  const where = ['e.property_id = ?'];
  const args: unknown[] = [propertyId];
  if (opts.assetId) { where.push('e.genset_asset_id = ?'); args.push(opts.assetId); }
  if (opts.from) { where.push('e.taken_at >= ?'); args.push(opts.from); }
  if (opts.to) { where.push('e.taken_at < ?'); args.push(opts.to); }
  args.push(Math.min(opts.limit ?? 200, 500));
  return db.prepare(
    `SELECT e.*, a.asset_tag, a.name AS asset_name, u.display_name AS logged_by_name
       FROM genset_log_entries e
       JOIN assets a ON a.id = e.genset_asset_id
       LEFT JOIN users u ON u.id = e.logged_by
      WHERE ${where.join(' AND ')}
      ORDER BY e.taken_at DESC LIMIT ?`
  ).all(...args) as LogRow[];
}

/**
 * Which sets have been logged today, and which have not.
 *
 * The question a supervisor actually has at the end of a shift, and one the paper book
 * could only answer by walking to the plant room and opening it.
 */
export function todayStatus(db: Db, propertyId: string, workDate: string): {
  assetId: string; tag: string; name: string; entries: number;
  lastAt: string | null; worst: 'ok' | 'watch' | 'act';
}[] {
  const rows = db.prepare(
    `SELECT a.id AS assetId, a.asset_tag AS tag, a.name,
            COUNT(e.id) AS entries,
            MAX(e.taken_at) AS lastAt,
            MAX(CASE WHEN e.out_of_range LIKE '%"act"%' THEN 2
                     WHEN e.out_of_range IS NOT NULL THEN 1 ELSE 0 END) AS worst
       FROM assets a
       JOIN genset_profiles g ON g.asset_id = a.id
       LEFT JOIN genset_log_entries e
              ON e.genset_asset_id = a.id AND e.work_date = ?
      WHERE a.property_id = ? AND a.is_active = 1
      GROUP BY a.id ORDER BY a.asset_tag`
  ).all(workDate, propertyId) as {
    assetId: string; tag: string; name: string; entries: number;
    lastAt: string | null; worst: number;
  }[];
  return rows.map((r) => ({
    ...r,
    worst: r.worst === 2 ? 'act' as const : r.worst === 1 ? 'watch' as const : 'ok' as const,
  }));
}
