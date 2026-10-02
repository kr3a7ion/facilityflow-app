/**
 * Clamp readings and building load.
 *
 * A clamp meter round is already part of the shift on most properties. What is missing
 * is the arithmetic afterwards: amps on three phases is not a load, and nobody standing
 * in a hot switchroom with a torch is going to work out √3 × 415 × 287 × 0.8 in their
 * head. This module does that sum, keeps the history, and answers the question the round
 * was really for — which set do we start.
 */
import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { notifyRole } from './escalation.js';

export interface Ctx { propertyId: string; userId: string | null; displayName: string; ip?: string }

/** A three-phase set carries √3 more than the single-phase sum suggests. */
const ROOT3 = Math.sqrt(3);

/**
 * Above this, the phases are far enough apart to be worth someone's attention: neutral
 * current climbs, motors run hot on the loaded phase, and a genset derates to its worst
 * phase rather than its average. Ten percent is the number most site standards settle on.
 */
export const IMBALANCE_WATCH_PCT = 10;
export const IMBALANCE_ACT_PCT = 20;

/**
 * A reading older than this is history, not a snapshot of what the building is drawing.
 * Four hours covers a shift's round without letting yesterday's figures masquerade as
 * "right now" on the screen.
 */
export const FRESH_MINUTES = 240;

/** Below a third of rating a diesel runs cold enough to glaze bores and wet-stack. */
export const MIN_HEALTHY_LOAD_PCT = 30;
/** Above this there is no headroom for a chiller or a lift starting. */
export const MAX_HEALTHY_LOAD_PCT = 80;
/** Beyond this the set is being asked to do more than it is rated for. */
export const MAX_USABLE_LOAD_PCT = 90;

export interface PhaseInput {
  l1Amps: number; l2Amps?: number | null; l3Amps?: number | null; neutralAmps?: number | null;
  volts: number; powerFactor: number; ctRatio?: number; phases: 1 | 3;
}

export interface Computed {
  phaseAmps: number[]; avgAmps: number; maxAmps: number; minAmps: number;
  imbalancePct: number | null; kva: number; kw: number; neutralAmps: number | null;
}

/**
 * The whole calculation, in one pure function so the tests can hold it still.
 *
 * Imbalance is the NEMA definition — the largest departure from the mean, as a
 * percentage of the mean — not max-minus-min, which reads roughly twice as alarming
 * and would have people chasing a balanced board.
 */
export function compute(input: PhaseInput): Computed {
  const ratio = input.ctRatio ?? 1;
  const raw = input.phases === 3
    ? [input.l1Amps, input.l2Amps, input.l3Amps]
    : [input.l1Amps];
  const phaseAmps = raw.filter((a): a is number => a != null && Number.isFinite(a))
    .map((a) => round2(a * ratio));
  if (phaseAmps.length === 0) throw new HttpError(400, 'invalid', 'Give at least one phase reading.');

  const avg = phaseAmps.reduce((s, a) => s + a, 0) / phaseAmps.length;
  const max = Math.max(...phaseAmps);
  const min = Math.min(...phaseAmps);

  // Imbalance only means something when all three phases were actually read.
  const imbalance = input.phases === 3 && phaseAmps.length === 3 && avg > 0
    ? round2((Math.max(max - avg, avg - min) / avg) * 100)
    : null;

  const kva = input.phases === 3
    ? (ROOT3 * input.volts * avg) / 1000
    : (input.volts * avg) / 1000;

  return {
    phaseAmps, avgAmps: round2(avg), maxAmps: round2(max), minAmps: round2(min),
    imbalancePct: imbalance,
    kva: round2(kva), kw: round2(kva * input.powerFactor),
    neutralAmps: input.neutralAmps == null ? null : round2(input.neutralAmps * ratio),
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface Source {
  id: string; property_id: string; name: string; kind: 'utility' | 'genset' | 'feeder';
  genset_asset_id: string | null; phases: number; nominal_volts: number; default_pf: number;
  ct_ratio: number; breaker_amps: number | null; is_incomer: number; sort_order: number;
  is_active: number;
}

export function sources(db: Db, propertyId: string, includeInactive = false): Source[] {
  return db.prepare(
    `SELECT * FROM power_sources WHERE property_id = ? AND (? = 1 OR is_active = 1)
      ORDER BY CASE kind WHEN 'utility' THEN 0 WHEN 'genset' THEN 1 ELSE 2 END, sort_order, name`
  ).all(propertyId, includeInactive ? 1 : 0) as Source[];
}

export interface SourceInput {
  name: string; kind: 'utility' | 'genset' | 'feeder'; gensetAssetId?: string;
  phases?: 1 | 3; nominalVolts?: number; defaultPf?: number; ctRatio?: number;
  breakerAmps?: number; isIncomer?: boolean; sortOrder?: number; isActive?: boolean;
}

export function saveSource(db: Db, ctx: Ctx, input: SourceInput, id?: string): { id: string } {
  const at = nowIso();
  if (input.kind === 'genset' && input.gensetAssetId) {
    const a = db.prepare('SELECT id FROM assets WHERE id = ? AND property_id = ?')
      .get(input.gensetAssetId, ctx.propertyId);
    if (!a) throw new HttpError(400, 'unknown_asset', 'That generator is not in the asset register.');
  }
  // A feeder that counted toward the total would double-count the incomer above it.
  const incomer = input.kind === 'feeder' ? 0 : (input.isIncomer === false ? 0 : 1);

  if (id) {
    const existing = db.prepare('SELECT id FROM power_sources WHERE id = ? AND property_id = ?')
      .get(id, ctx.propertyId);
    if (!existing) throw new HttpError(404, 'not_found', 'That supply does not exist.');
    db.prepare(
      `UPDATE power_sources SET name = ?, kind = ?, genset_asset_id = ?, phases = ?, nominal_volts = ?,
        default_pf = ?, ct_ratio = ?, breaker_amps = ?, is_incomer = ?, sort_order = ?, is_active = ?,
        updated_at = ? WHERE id = ?`
    ).run(input.name, input.kind, input.gensetAssetId ?? null, input.phases ?? 3,
          input.nominalVolts ?? 415, input.defaultPf ?? 0.8, input.ctRatio ?? 1,
          input.breakerAmps ?? null, incomer, input.sortOrder ?? 0,
          input.isActive === false ? 0 : 1, at, id);
    return { id };
  }

  const newId = ulid();
  db.prepare(
    `INSERT INTO power_sources (id, property_id, name, kind, genset_asset_id, phases, nominal_volts,
      default_pf, ct_ratio, breaker_amps, is_incomer, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId, ctx.propertyId, input.name, input.kind, input.gensetAssetId ?? null,
        input.phases ?? 3, input.nominalVolts ?? 415, input.defaultPf ?? 0.8, input.ctRatio ?? 1,
        input.breakerAmps ?? null, incomer, input.sortOrder ?? 0,
        input.isActive === false ? 0 : 1, at, at);
  return { id: newId };
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

export interface ClampInput {
  sourceId: string; l1Amps: number; l2Amps?: number; l3Amps?: number; neutralAmps?: number;
  volts?: number; powerFactor?: number; takenAt?: string; note?: string;
}

export interface ClampResult extends Computed {
  id: string; sourceName: string; takenAt: string;
  overBreaker: boolean; breakerAmps: number | null; imbalanceFlag: 'ok' | 'watch' | 'act' | null;
}

export function recordClamp(db: Db, ctx: Ctx, input: ClampInput): ClampResult {
  const src = db.prepare('SELECT * FROM power_sources WHERE id = ? AND property_id = ?')
    .get(input.sourceId, ctx.propertyId) as Source | undefined;
  if (!src) throw new HttpError(404, 'not_found', 'That supply does not exist.');
  if (!src.is_active) throw new HttpError(400, 'inactive', 'That supply is no longer in use.');

  const volts = input.volts ?? src.nominal_volts;
  const pf = input.powerFactor ?? src.default_pf;
  const phases = src.phases === 1 ? 1 : 3;

  if (phases === 3 && (input.l2Amps == null || input.l3Amps == null)) {
    throw new HttpError(400, 'missing_phases',
      `${src.name} is a three-phase supply. Read all three phases — a load worked out from one ` +
      `phase is wrong by however far the board is out of balance, which is the thing worth knowing.`);
  }

  const c = compute({
    l1Amps: input.l1Amps, l2Amps: input.l2Amps, l3Amps: input.l3Amps,
    neutralAmps: input.neutralAmps, volts, powerFactor: pf,
    ctRatio: src.ct_ratio, phases,
  });

  const at = input.takenAt ?? nowIso();
  const id = ulid();
  db.prepare(
    `INSERT INTO clamp_readings (id, property_id, source_id, taken_at, l1_amps, l2_amps, l3_amps,
      neutral_amps, volts, power_factor, ct_ratio, avg_amps, max_amps, imbalance_pct, kva, kw,
      taken_by, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.propertyId, src.id, at, input.l1Amps, input.l2Amps ?? null, input.l3Amps ?? null,
        input.neutralAmps ?? null, volts, pf, src.ct_ratio, c.avgAmps, c.maxAmps,
        c.imbalancePct, c.kva, c.kw, ctx.userId, input.note ?? null, nowIso());

  const overBreaker = src.breaker_amps != null && c.maxAmps > src.breaker_amps;
  const flag: 'ok' | 'watch' | 'act' | null = c.imbalancePct == null ? null
    : c.imbalancePct >= IMBALANCE_ACT_PCT ? 'act'
    : c.imbalancePct >= IMBALANCE_WATCH_PCT ? 'watch' : 'ok';

  if (flag === 'act') {
    notifyRole(db, ctx.propertyId, 'supervisor', {
      kind: 'phase_imbalance',
      title: `${src.name} is ${c.imbalancePct}% out of balance`,
      body: `Phases read ${c.phaseAmps.join(' / ')} A. Move single-phase loads between phases ` +
            `before the heaviest one trips or a motor cooks.`,
      entityType: 'power_source', entityId: src.id,
    });
  }
  if (overBreaker) {
    notifyRole(db, ctx.propertyId, 'supervisor', {
      kind: 'over_breaker',
      title: `${src.name} is drawing above its breaker rating`,
      body: `${c.maxAmps} A on the heaviest phase against a ${src.breaker_amps} A breaker.`,
      entityType: 'power_source', entityId: src.id,
    });
  }

  return { id, sourceName: src.name, takenAt: at, ...c,
           overBreaker, breakerAmps: src.breaker_amps, imbalanceFlag: flag };
}

export interface ReadingRow {
  id: string; source_id: string; source_name: string; kind: string; taken_at: string;
  l1_amps: number; l2_amps: number | null; l3_amps: number | null; neutral_amps: number | null;
  volts: number; power_factor: number; ct_ratio: number; avg_amps: number; max_amps: number;
  imbalance_pct: number | null; kva: number; kw: number; taken_by_name: string | null; note: string | null;
}

export function readings(
  db: Db, propertyId: string, opts: { sourceId?: string; from?: string; to?: string; limit?: number } = {}
): ReadingRow[] {
  return db.prepare(
    `SELECT c.*, s.name AS source_name, s.kind, u.display_name AS taken_by_name
       FROM clamp_readings c
       JOIN power_sources s ON s.id = c.source_id
       LEFT JOIN users u ON u.id = c.taken_by
      WHERE c.property_id = ?
        AND (? IS NULL OR c.source_id = ?)
        AND (? IS NULL OR c.taken_at >= ?)
        AND (? IS NULL OR c.taken_at < ?)
      ORDER BY c.taken_at DESC LIMIT ?`
  ).all(propertyId, opts.sourceId ?? null, opts.sourceId ?? null,
        opts.from ?? null, opts.from ?? null, opts.to ?? null, opts.to ?? null,
        Math.min(opts.limit ?? 100, 500)) as ReadingRow[];
}

// ---------------------------------------------------------------------------
// What is the building drawing, and which set should run
// ---------------------------------------------------------------------------

export interface LiveSource {
  id: string; name: string; kind: string; isIncomer: boolean;
  takenAt: string | null; ageMinutes: number | null; stale: boolean; counted: boolean;
  phaseAmps: number[]; avgAmps: number | null; maxAmps: number | null;
  imbalancePct: number | null; imbalanceFlag: 'ok' | 'watch' | 'act' | null;
  kva: number | null; kw: number | null;
  breakerAmps: number | null; breakerPct: number | null;
  why: string;
}

export interface GensetOption {
  assetId: string; tag: string; name: string; status: string; kvaRating: number;
  loadPct: number | null; verdict: 'good' | 'light' | 'tight' | 'over' | 'unavailable';
  expectedLph: number | null; note: string;
}

export interface LoadNow {
  at: string;
  utility: 'on' | 'off';
  totalKw: number | null; totalKva: number | null;
  sources: LiveSource[];
  worstImbalance: { name: string; pct: number } | null;
  gensets: GensetOption[];
  recommended: string | null;
  advice: string;
  freshMinutes: number;
}

/**
 * The load right now, from the most recent clamp reading on each incomer.
 *
 * Three rules keep the total honest, and each of them exists because breaking it would
 * produce a confidently wrong number rather than an obviously missing one.
 *
 *  - A feeder never counts. It sits below an incomer that is already counted, so adding
 *    it counts the same amps twice.
 *  - A reading older than FRESH_MINUTES is history. It is shown, marked stale, and left
 *    out — a comfortable figure from last Tuesday is worse than no figure at all.
 *  - Only one side of the changeover counts at a time. A building fed through a
 *    changeover is drawing from the utility or from a set, never from both, so a
 *    generator clamped during Saturday's test run must not be added to Monday's utility
 *    reading and report a building drawing twice what it does. The outage log decides
 *    which side is live; when nothing fresh exists on that side the other is used and
 *    the screen says so.
 */
export function loadNow(db: Db, propertyId: string, at = nowIso()): LoadNow {
  const outage = db.prepare(
    `SELECT started_at FROM power_outages WHERE property_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`
  ).get(propertyId) as { started_at: string } | undefined;
  const utility: 'on' | 'off' = outage ? 'off' : 'on';

  const rows = db.prepare(
    `SELECT s.id, s.name, s.kind, s.is_incomer, s.breaker_amps, s.phases,
            c.taken_at, c.avg_amps, c.max_amps, c.imbalance_pct, c.kva, c.kw,
            c.l1_amps, c.l2_amps, c.l3_amps, c.ct_ratio
       FROM power_sources s
       LEFT JOIN clamp_readings c ON c.id = (
         SELECT id FROM clamp_readings WHERE source_id = s.id ORDER BY taken_at DESC LIMIT 1)
      WHERE s.property_id = ? AND s.is_active = 1
      ORDER BY CASE s.kind WHEN 'utility' THEN 0 WHEN 'genset' THEN 1 ELSE 2 END, s.sort_order, s.name`
  ).all(propertyId) as {
    id: string; name: string; kind: string; is_incomer: number; breaker_amps: number | null;
    phases: number; taken_at: string | null; avg_amps: number | null; max_amps: number | null;
    imbalance_pct: number | null; kva: number | null; kw: number | null;
    l1_amps: number | null; l2_amps: number | null; l3_amps: number | null; ct_ratio: number | null;
  }[];

  const nowMs = new Date(at).getTime();
  const ageOf = (takenAt: string | null): number | null =>
    takenAt ? Math.round((nowMs - new Date(takenAt).getTime()) / 60000) : null;

  /** Fresh, an incomer, and actually carrying something. */
  const usable = (r: typeof rows[number]): boolean => {
    const age = ageOf(r.taken_at);
    return r.is_incomer === 1 && age != null && age <= FRESH_MINUTES && (r.kw ?? 0) > 0;
  };

  // Which side of the changeover the building is being fed from. The outage log is the
  // stated fact; readings only decide it when that side has nothing fresh to offer.
  const preferred: 'utility' | 'genset' = utility === 'off' ? 'genset' : 'utility';
  const havePreferred = rows.some((r) => r.kind === preferred && usable(r));
  const other: 'utility' | 'genset' = preferred === 'utility' ? 'genset' : 'utility';
  const haveOther = rows.some((r) => r.kind === other && usable(r));
  const feeding: 'utility' | 'genset' = havePreferred ? preferred : haveOther ? other : preferred;
  const fellBack = !havePreferred && haveOther;

  const live: LiveSource[] = rows.map((r) => {
    const age = ageOf(r.taken_at);
    const stale = age == null || age > FRESH_MINUTES;
    const isIncomer = r.is_incomer === 1;
    const ratio = r.ct_ratio ?? 1;
    const phaseAmps = [r.l1_amps, r.l2_amps, r.l3_amps]
      .filter((a): a is number => a != null).map((a) => round2(a * ratio));

    const counted = usable(r) && r.kind === feeding;
    let why: string;
    if (!isIncomer) why = 'downstream of an incomer — shown for diagnosis, never added to the total';
    else if (age == null) why = 'never clamped';
    else if (stale) why = `last read ${age} min ago — too old to call current`;
    else if ((r.kw ?? 0) <= 0) why = 'reading zero — not carrying load';
    else if (counted) why = 'counted toward the building total';
    else if (r.kind === 'utility') why = 'utility is recorded as off — the building is on generator';
    else why = 'utility is on, so this set is not carrying the building';

    const flag: 'ok' | 'watch' | 'act' | null = r.imbalance_pct == null ? null
      : r.imbalance_pct >= IMBALANCE_ACT_PCT ? 'act'
      : r.imbalance_pct >= IMBALANCE_WATCH_PCT ? 'watch' : 'ok';

    return {
      id: r.id, name: r.name, kind: r.kind, isIncomer,
      takenAt: r.taken_at, ageMinutes: age, stale, counted,
      phaseAmps, avgAmps: r.avg_amps, maxAmps: r.max_amps,
      imbalancePct: r.imbalance_pct, imbalanceFlag: flag,
      kva: r.kva, kw: r.kw,
      breakerAmps: r.breaker_amps,
      breakerPct: r.breaker_amps && r.max_amps ? round2((r.max_amps / r.breaker_amps) * 100) : null,
      why,
    };
  });

  const counted = live.filter((s) => s.counted);
  const totalKw = counted.length ? round2(counted.reduce((s, x) => s + (x.kw ?? 0), 0)) : null;
  const totalKva = counted.length ? round2(counted.reduce((s, x) => s + (x.kva ?? 0), 0)) : null;

  const imbalanced = live.filter((s) => s.imbalancePct != null && !s.stale)
    .sort((a, b) => (b.imbalancePct ?? 0) - (a.imbalancePct ?? 0))[0];
  const worstImbalance = imbalanced && (imbalanced.imbalancePct ?? 0) >= IMBALANCE_WATCH_PCT
    ? { name: imbalanced.name, pct: imbalanced.imbalancePct! } : null;

  const gensets = gensetOptions(db, propertyId, totalKva);
  const pick = recommend(gensets);

  // Said out loud rather than left for somebody to work out from a total that does not
  // match what they can see on the panel.
  const fallbackNote = fellBack
    ? feeding === 'genset'
      ? ' The utility is recorded as on, but only a generator has a current reading, so the load is taken from there.'
      : ' No generator has a current reading, so the load is taken from the utility incomer.'
    : '';

  return {
    at, utility, totalKw, totalKva, sources: live, worstImbalance,
    gensets, recommended: pick.assetId,
    advice: totalKva == null
      ? 'No current clamp reading on any incomer. Take one and the load and set recommendation appear here.'
      : pick.advice + fallbackNote,
    freshMinutes: FRESH_MINUTES,
  };
}

interface GensetRow {
  id: string; asset_tag: string; name: string; status: string; kva_rating: number;
  expected_lph_at_50pct: number | null; expected_lph_at_75pct: number | null;
  expected_lph_at_100pct: number | null;
}

export function gensetOptions(db: Db, propertyId: string, totalKva: number | null): GensetOption[] {
  const rows = db.prepare(
    `SELECT a.id, a.asset_tag, a.name, a.status, g.kva_rating, g.expected_lph_at_50pct,
            g.expected_lph_at_75pct, g.expected_lph_at_100pct
       FROM assets a JOIN genset_profiles g ON g.asset_id = a.id
      WHERE a.property_id = ? AND a.is_active = 1
      ORDER BY g.kva_rating`
  ).all(propertyId) as GensetRow[];

  return rows.map((g) => {
    const usable = g.status === 'in_service' || g.status === 'standby';
    // One decimal: a load percentage is a judgement, not a measurement, and "57.09%"
    // implies a precision the power factor assumption does not support.
    const loadPct = totalKva != null && g.kva_rating > 0
      ? Math.round((totalKva / g.kva_rating) * 1000) / 10 : null;

    let verdict: GensetOption['verdict'] = 'good';
    let note = '';
    if (!usable) {
      verdict = 'unavailable';
      note = `Marked ${g.status.replace(/_/g, ' ')} — not a set to plan around.`;
    } else if (loadPct == null) {
      verdict = 'good'; note = `Rated ${g.kva_rating} kVA. No current load reading to judge it against.`;
    } else if (loadPct > MAX_USABLE_LOAD_PCT) {
      verdict = 'over';
      note = `Would sit at ${loadPct}% of rating. Too close to the limit — one lift or chiller ` +
             `starting takes it over.`;
    } else if (loadPct > MAX_HEALTHY_LOAD_PCT) {
      verdict = 'tight';
      note = `${loadPct}% of rating. It will carry it, with nothing left for a starting load.`;
    } else if (loadPct < MIN_HEALTHY_LOAD_PCT) {
      verdict = 'light';
      note = `Only ${loadPct}% of rating. Running this cold glazes the bores and wet-stacks the ` +
             `exhaust — the repair costs more than the diesel saved.`;
    } else {
      note = `${loadPct}% of rating — the band a diesel is happiest in.`;
    }

    return {
      assetId: g.id, tag: g.asset_tag, name: g.name, status: g.status,
      kvaRating: g.kva_rating, loadPct, verdict,
      expectedLph: loadPct == null ? null : lphAt(g, loadPct / 100), note,
    };
  });
}

/**
 * Smallest set that carries the load without running cold. Smallest, because every kVA
 * of headroom you do not need is diesel burned to make heat.
 */
function recommend(options: GensetOption[]): { assetId: string | null; advice: string } {
  const ok = options.filter((o) => o.verdict === 'good');
  if (ok.length) {
    const pick = ok[0]!;
    return { assetId: pick.assetId,
             advice: `Start ${pick.tag} — ${pick.kvaRating} kVA at ${pick.loadPct}% of rating` +
                     (pick.expectedLph != null ? `, about ${pick.expectedLph} L/h.` : '.') };
  }
  const tight = options.filter((o) => o.verdict === 'tight');
  if (tight.length) {
    const pick = tight[0]!;
    return { assetId: pick.assetId,
             advice: `${pick.tag} is the only set that carries this, at ${pick.loadPct}% of rating. ` +
                     `Shed something before a large motor starts.` };
  }
  const light = options.filter((o) => o.verdict === 'light');
  if (light.length) {
    // Every available set is oversized for the load. The smallest is still the answer,
    // but somebody should hear that it is the wrong shape of problem.
    const pick = light[0]!;
    return { assetId: pick.assetId,
             advice: `Every available set is oversized for this load. ${pick.tag} is the smallest at ` +
                     `${pick.loadPct}% of rating — run it, keep the run short, and load-bank it ` +
                     `periodically.` };
  }
  const over = options.filter((o) => o.verdict === 'over');
  if (over.length) {
    const biggest = over[over.length - 1]!;
    return { assetId: null,
             advice: `No single set carries this load. The largest available, ${biggest.tag}, would ` +
                     `sit at ${biggest.loadPct}% of rating. Shed non-essential load or synchronise.` };
  }
  return { assetId: null, advice: 'No generator is available — every set is out of service.' };
}

function lphAt(g: GensetRow, fraction: number): number | null {
  const pts: [number, number][] = [];
  if (g.expected_lph_at_50pct != null) pts.push([0.5, g.expected_lph_at_50pct]);
  if (g.expected_lph_at_75pct != null) pts.push([0.75, g.expected_lph_at_75pct]);
  if (g.expected_lph_at_100pct != null) pts.push([1.0, g.expected_lph_at_100pct]);
  if (!pts.length) return null;
  if (pts.length === 1) return pts[0]![1];
  if (fraction <= pts[0]![0]) return pts[0]![1];
  const last = pts[pts.length - 1]!;
  if (fraction >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1]!;
    const [x2, y2] = pts[i]!;
    if (fraction <= x2) return round2(y1 + ((fraction - x1) / (x2 - x1)) * (y2 - y1));
  }
  return last[1];
}

/** A month of load on one source, for the trend on the Power screen. */
export function loadTrend(
  db: Db, propertyId: string, from: string, to: string, sourceId?: string
): { takenAt: string; kw: number; imbalancePct: number | null; sourceName: string }[] {
  return db.prepare(
    `SELECT c.taken_at AS takenAt, c.kw, c.imbalance_pct AS imbalancePct, s.name AS sourceName
       FROM clamp_readings c JOIN power_sources s ON s.id = c.source_id
      WHERE c.property_id = ? AND c.taken_at >= ? AND c.taken_at < ?
        AND (? IS NULL OR c.source_id = ?)
      ORDER BY c.taken_at`
  ).all(propertyId, from, to, sourceId ?? null, sourceId ?? null) as
    { takenAt: string; kw: number; imbalancePct: number | null; sourceName: string }[];
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
