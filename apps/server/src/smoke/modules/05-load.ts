/**
 * Module checks, chapter 5 of 11:
 *  - Clamp readings and building load
 *  - Monthly scoping
 */
import { compute as computeLoad } from '../../services/load.js';
import { monthRange, shiftMonth, currentMonth } from '../../lib/time.js';
import { check, db, get, heading, iso, near, post } from './harness.js';
import type { Res } from './harness.js';
import { admin, femi, grace, hod, ifeoma, propertyId } from './01-setup.js';

let r: Res;

// --------------------------------------------------------------------------
heading('Clamp readings and building load');
// --------------------------------------------------------------------------

// The arithmetic first, held still, because everything downstream trusts it.
{
  const c = computeLoad({ l1Amps: 100, l2Amps: 100, l3Amps: 100, volts: 415, powerFactor: 0.8, phases: 3 });
  check('three balanced phases give the textbook three-phase kVA',
    near(c.kva, Math.sqrt(3) * 415 * 100 / 1000, 0.02), String(c.kva));
  check('and kW is kVA times the power factor', near(c.kw, c.kva * 0.8, 0.02), String(c.kw));
  check('a balanced board reads zero imbalance', c.imbalancePct === 0, String(c.imbalancePct));
}
{
  // 110/100/90: mean 100, worst departure 10 → 10%. Max-minus-min would say 20% and
  // have somebody chasing a board that is only mildly off.
  const c = computeLoad({ l1Amps: 110, l2Amps: 100, l3Amps: 90, volts: 415, powerFactor: 0.8, phases: 3 });
  check('imbalance is measured from the mean, not end to end',
    near(c.imbalancePct ?? -1, 10, 0.01), String(c.imbalancePct));
}
{
  const c = computeLoad({ l1Amps: 50, volts: 240, powerFactor: 0.9, phases: 1 });
  check('a single-phase supply does not get the √3',
    near(c.kva, 240 * 50 / 1000, 0.01) && c.imbalancePct === null, String(c.kva));
}
{
  const c = computeLoad({ l1Amps: 5, l2Amps: 5, l3Amps: 5, volts: 415, powerFactor: 0.8,
                          ctRatio: 100, phases: 3 });
  check('a CT ratio scales the reading', near(c.avgAmps, 500, 0.01), String(c.avgAmps));
}

r = await post('/api/power/sources', grace, {
  name: 'Utility incomer', kind: 'utility', phases: 3, nominalVolts: 415, defaultPf: 0.85,
  breakerAmps: 630,
});
check('a supervisor can set up a supply', r.statusCode === 201, r.body.slice(0, 120));
const incomerId = r.json().id as string;

r = await post('/api/power/sources', grace, { name: 'Block B riser', kind: 'feeder', breakerAmps: 250 });
const feederId = r.json().id as string;
check('a feeder is created', r.statusCode === 201);
check('and a feeder is never marked as an incomer, whatever was asked for',
  (db.prepare('SELECT is_incomer FROM power_sources WHERE id = ?').get(feederId) as
    { is_incomer: number }).is_incomer === 0);

r = await post('/api/power/sources', ifeoma, { name: 'Sneaky', kind: 'feeder' });
check('a technician cannot set up supplies', r.statusCode === 403);

r = await post('/api/power/clamp', ifeoma, { sourceId: incomerId, l1Amps: 240 });
check('a three-phase supply refuses a one-phase reading',
  r.statusCode === 400 && r.json().error === 'missing_phases', r.body.slice(0, 140));

r = await post('/api/power/clamp', ifeoma, {
  sourceId: incomerId, l1Amps: 262, l2Amps: 244, l3Amps: 238, neutralAmps: 26,
});
check('a technician can log a clamp reading', r.statusCode === 201, r.body.slice(0, 140));
const reading = r.json() as { kw: number; kva: number; imbalancePct: number; avgAmps: number };
check('the load is worked out from all three phases',
  near(reading.avgAmps, 248, 0.01), String(reading.avgAmps));
check('and it lands as a sensible kW figure for a 415 V board',
  reading.kw > 120 && reading.kw < 170, String(reading.kw));

r = await get('/api/power/load', grace);
check('the load endpoint answers', r.statusCode === 200);
let load = r.json() as {
  totalKw: number | null; totalKva: number | null; recommended: string | null; advice: string;
  sources: { id: string; counted: boolean; why: string }[];
  gensets: { assetId: string; tag: string; verdict: string; loadPct: number | null }[];
};
check('the fresh incomer reading is counted toward the building total',
  load.sources.find((s) => s.id === incomerId)?.counted === true);
check('and the total matches the reading',
  near(load.totalKw ?? 0, reading.kw, 0.02), String(load.totalKw));

// The double-count trap: a feeder carrying real current must not inflate the building.
await post('/api/power/clamp', ifeoma, { sourceId: feederId, l1Amps: 120, l2Amps: 96, l3Amps: 88 });
r = await get('/api/power/load', grace);
const after = r.json() as { totalKw: number | null; sources: { id: string; counted: boolean; why: string }[] };
check('a feeder reading never inflates the building total',
  near(after.totalKw ?? 0, load.totalKw ?? -1, 0.02), `${after.totalKw} vs ${load.totalKw}`);
check('and the screen says why it was left out',
  (after.sources.find((s) => s.id === feederId)?.why ?? '').includes('downstream'));

// Which set to start, against the gensets seeded earlier in this file.
r = await get('/api/power/load', grace);
load = r.json();
if (load.gensets.length >= 2) {
  const rec = load.gensets.find((g) => g.assetId === load.recommended);
  check('a generator is recommended for the current load', !!rec, load.advice);
  check('and it is not one that would run below a third of its rating',
    !rec || (rec.loadPct ?? 0) >= 30, `${rec?.tag} at ${rec?.loadPct}%`);
  check('and not one that would sit above ninety percent',
    !rec || (rec.loadPct ?? 0) <= 90, `${rec?.tag} at ${rec?.loadPct}%`);
  check('a faulty set is never recommended',
    !load.gensets.some((g) => g.verdict === 'unavailable' && g.assetId === load.recommended));
}

// The changeover trap: a set clamped during Saturday's test run must not be added to
// the utility reading and report a building drawing twice what it does.
{
  r = await post('/api/power/sources', grace, {
    name: 'Test set output', kind: 'genset', phases: 3, nominalVolts: 415, defaultPf: 0.8,
  });
  const testSet = r.json().id as string;
  const beforeSet = (await get('/api/power/load', grace)).json().totalKw as number;
  await post('/api/power/clamp', ifeoma, { sourceId: testSet, l1Amps: 180, l2Amps: 172, l3Amps: 168 });
  const withSet = (await get('/api/power/load', grace)).json() as {
    totalKw: number; sources: { id: string; counted: boolean; why: string }[];
  };
  check('a set clamped while the utility is on is not added to the building total',
    near(withSet.totalKw, beforeSet, 0.02), `${withSet.totalKw} vs ${beforeSet}`);
  check('and the reason names the changeover rather than leaving it a mystery',
    (withSet.sources.find((s) => s.id === testSet)?.why ?? '').includes('utility is on'),
    withSet.sources.find((s) => s.id === testSet)?.why);

  // Now take the utility away and the same set becomes what the building is drawing.
  r = await post('/api/outages', grace, { startedAt: iso(0), source: 'utility' });
  check('an outage is logged', r.statusCode === 201);
  const onGen = (await get('/api/power/load', grace)).json() as {
    utility: string; totalKw: number; sources: { id: string; counted: boolean }[];
  };
  check('with the utility off the generator reading becomes the building load',
    onGen.utility === 'off' && onGen.sources.find((s) => s.id === testSet)?.counted === true,
    String(onGen.totalKw));
  check('and the utility incomer stops being counted through a dead cable',
    onGen.sources.find((s) => s.id === incomerId)?.counted === false);

  db.prepare('UPDATE power_outages SET ended_at = ? WHERE property_id = ? AND ended_at IS NULL')
    .run(iso(0), propertyId);
  db.prepare('UPDATE power_sources SET is_active = 0 WHERE id = ?').run(testSet);
}

// A stale reading is history, not "now".
db.prepare('UPDATE clamp_readings SET taken_at = ? WHERE source_id = ?')
  .run(iso(-2), incomerId);
r = await get('/api/power/load', grace);
const stale = r.json() as { totalKw: number | null; sources: { id: string; stale: boolean; why: string }[] };
check('a two-day-old reading is not reported as the current load', stale.totalKw === null,
  String(stale.totalKw));
check('and it is marked stale rather than silently dropped',
  stale.sources.find((s) => s.id === incomerId)?.stale === true);

check('the mimic strip carries the load figure',
  (await get('/api/status/plant', grace)).json().load !== undefined);

// --------------------------------------------------------------------------
heading('Monthly scoping');
// --------------------------------------------------------------------------
{
  const m = monthRange('2026-03', 'Africa/Lagos');
  // Lagos is UTC+1 with no daylight saving, so local midnight on the 1st is 23:00 UTC
  // on the last day of February. Getting this wrong puts a whole day in the wrong month.
  check('a month starts at local midnight, not UTC midnight',
    m.from === '2026-02-28T23:00:00.000Z', m.from);
  check('and ends at local midnight on the first of the next month',
    m.to === '2026-03-31T23:00:00.000Z', m.to);
  check('the range is half-open, so nothing recorded in the last second is lost',
    m.to > m.from && m.to !== m.from);
  check('December steps into the next January', shiftMonth('2026-12', 1) === '2027-01');
  check('and January steps back into the previous December', shiftMonth('2026-01', -1) === '2025-12');
}

const thisMonth = currentMonth('Africa/Lagos');
const lastMonth = shiftMonth(thisMonth, -1);

r = await get(`/api/jobs?month=${thisMonth}`, hod);
const thisMonthJobs = r.json() as { jobs: { id: string; status: string }[];
                                    period: { month: string } | null; truncated: boolean };
check('the jobs board takes a month', r.statusCode === 200 && thisMonthJobs.period?.month === thisMonth);

r = await get(`/api/jobs?month=${lastMonth}`, hod);
const lastMonthJobs = r.json() as { jobs: { id: string; status: string }[] };
const live = lastMonthJobs.jobs.filter((j) => !['closed', 'cancelled'].includes(j.status));
check('an open job carries over into a month it was not raised in', live.length > 0,
  `${lastMonthJobs.jobs.length} rows`);

r = await get(`/api/jobs?month=${lastMonth}&period=strict`, hod);
const strict = r.json() as { jobs: unknown[]; period: { strict: boolean } };
check('and a strict month report drops the carry-over',
  strict.period.strict === true && strict.jobs.length <= lastMonthJobs.jobs.length,
  `${strict.jobs.length} strict vs ${lastMonthJobs.jobs.length} carried`);

r = await get(`/api/jobs?month=not-a-month`, hod);
check('a nonsense month falls back to the current one rather than failing',
  r.statusCode === 200);

r = await get(`/api/admin/audit?month=${thisMonth}`, admin);
check('the audit log is scoped to a month', r.statusCode === 200 && !!r.json().period);

r = await get(`/api/purchases?month=${lastMonth}`, femi);
check('purchases take a month', r.statusCode === 200 && r.json().period.month === lastMonth);

r = await get(`/api/exports/jobs?month=${thisMonth}`, hod);
check('an export can be scoped to a month', r.statusCode === 200);
check('and the file is named for the month, not for today',
  String(r.headers['content-disposition']).includes(thisMonth),
  String(r.headers['content-disposition']));

r = await get('/api/exports/assets?month=2026-01', hod);
check('a register export ignores a month it cannot honour', r.statusCode === 200);
check('and keeps a dated filename instead of pretending',
  !String(r.headers['content-disposition']).includes('2026-01'));

r = await get('/api/exports', hod);
check('the export list says which exports a month means anything for',
  (r.json().exports as { kind: string; dated: boolean }[]).some((e) => e.kind === 'jobs' && e.dated)
  && (r.json().exports as { kind: string; dated: boolean }[])
       .some((e) => e.kind === 'assets' && !e.dated));
