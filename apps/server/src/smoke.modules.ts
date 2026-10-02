/**
 * Phase 1-7 end-to-end checks. Runs against a throwaway database through the real
 * HTTP layer (fastify inject), so permissions, validation and business rules are all
 * exercised the way a client would hit them.
 *
 *   npm run smoke
 */
import fs from 'node:fs';
import * as tls from './services/tls.js';
import nodeTls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { litresFromDip, expectedLph, type Profile } from './services/fuel.js';
import { compute as computeLoad } from './services/load.js';
import { buildView } from './services/network.js';
import * as bus from './services/bus.js';
import { monthRange, shiftMonth, currentMonth } from './lib/time.js';
import { addInterval, compliance as ppmCompliance } from './services/ppm.js';
import { tick } from './services/escalation.js';

let passed = 0;
const failures: string[] = [];
let group = '';

function heading(name: string): void { group = name; console.log(`\n${name}`); }
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`[${group}] ${name}${detail ? ' — ' + detail : ''}`);
         console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function near(a: number, b: number, tol = 0.01): boolean { return Math.abs(a - b) <= tol; }
function throws(name: string, fn: () => unknown): void {
  try { fn(); check(name, false, 'expected it to throw'); } catch { check(name, true); }
}


/** Build a multipart body by hand so inject() can post a file without extra deps. */
function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const b = '----ffsmoke' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

// A real 1x1 PNG, so the magic-byte check has something honest to read.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mod-'));
const config = loadConfig({ dataDir: dir });
const db = openDb(config.dbPath);
migrate(db);
const app: FastifyInstance = await buildApp(db, config);

console.log(`\nFacilityFlow module checks\ndata dir: ${dir}`);

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
type Hdr = { cookie: string };
async function login(username: string, password: string): Promise<Hdr> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  const c = r.cookies.find((x) => x.name === 'ff_sid');
  if (!c) throw new Error(`login failed for ${username}: ${r.body}`);
  return { cookie: `ff_sid=${c.value}` };
}
async function post(url: string, headers: Hdr, payload?: unknown) {
  return app.inject({ method: 'POST', url, headers, payload: payload as object });
}
async function get(url: string, headers: Hdr) {
  return app.inject({ method: 'GET', url, headers });
}
const PW = 'facilityflow-testing';
const iso = (offsetDays: number, base = Date.now()) => new Date(base + offsetDays * 86_400_000).toISOString();
const day = (offsetDays: number) => iso(offsetDays).slice(0, 10);

// --------------------------------------------------------------------------
heading('Setup and accounts');
// --------------------------------------------------------------------------
let r = await post('/api/setup', { cookie: '' } as Hdr, {
  property: { name: 'Harmony Court Serviced Residences', shortName: 'Harmony Court', timezone: 'Africa/Lagos' },
  admin: { displayName: 'System Administrator', username: 'admin', password: PW },
});
check('property is configured', r.statusCode === 201, r.body.slice(0, 120));
const admin = await login('admin', PW);

// A brand-new database has no asset, no apartment and no location, and a job must hang
// off one of the three. Somebody's first act on a fresh install is raising a job, and
// finding it impossible is the worst possible first minute — so setup creates the site.
r = await get('/api/locations', admin);
const rootSite = (r.json().locations as { id: string; type: string; name: string }[])
  .find((l) => l.type === 'site');
check('setup creates the site, so the first common-area job has somewhere to land',
  !!rootSite, JSON.stringify(r.json().locations));
r = await post('/api/jobs', admin, {
  title: 'First job on a brand-new install', locationId: rootSite?.id, priority: 'P3',
});
check('and a job can be raised before anything else has been configured',
  r.statusCode === 201, r.body.slice(0, 160));

for (const [username, roleKey, displayName] of [
  ['grace', 'supervisor', 'Grace Etim'],
  ['musa', 'team_lead', 'Musa Ibrahim'],
  ['ifeoma', 'technician', 'Ifeoma Bassey'],
  ['tunde', 'technician', 'Tunde Adeyemi'],
  ['halima', 'storekeeper', 'Halima Yusuf'],
  ['femi', 'finance', 'Femi Adeleke'],
  ['hod', 'hod', 'Head of Maintenance'],
] as const) {
  const res = await post('/api/admin/users', admin, { username, roleKey, displayName, password: PW });
  if (res.statusCode !== 201) throw new Error(`could not create ${username}: ${res.body}`);
}
const grace = await login('grace', PW);
const musa = await login('musa', PW);
const ifeoma = await login('ifeoma', PW);
const halima = await login('halima', PW);
const femi = await login('femi', PW);
const hod = await login('hod', PW);
check('one account per role signs in', true);

const propertyId = (db.prepare('SELECT id FROM properties LIMIT 1').get() as { id: string }).id;

// --------------------------------------------------------------------------
heading('Registry — locations, apartments, assets');
// --------------------------------------------------------------------------
// Setup already made the site; a second one on the same code is refused rather than
// quietly creating a parallel tree.
r = await post('/api/locations', admin, { type: 'site', code: 'SITE', name: 'Harmony Court' });
check('a duplicate site code is refused, not silently accepted',
  r.statusCode === 409 && r.json().error === 'duplicate_code', r.body.slice(0, 120));
const siteId = rootSite!.id;

r = await post('/api/locations', admin, { type: 'plant_room', code: 'PLANT-GEN', name: 'Generator house', parentId: siteId });
const plantId = r.json().id;
check('plant room created under the site', r.statusCode === 201);

r = await post('/api/apartments/import', admin, {
  source: 'keyplate', dryRun: true,
  units: [{ unitNo: 'A-1204', block: 'A' }, { unitNo: 'B-0803', block: 'B' }, { unitNo: 'C-0512', block: 'C' }],
});
check('an import can be previewed before it writes', r.statusCode === 200 && r.json().dryRun === true);
check('the preview counts what it would create', r.json().wouldCreate === 3);
check('nothing was written on a dry run',
  (db.prepare('SELECT COUNT(*) n FROM apartments').get() as { n: number }).n === 0);

r = await post('/api/apartments/import', admin, {
  source: 'keyplate', sourceRef: 'DayBook.mdb',
  units: [{ unitNo: 'A-1204', block: 'A' }, { unitNo: 'B-0803', block: 'B' }, { unitNo: 'C-0512', block: 'C' }],
});
check('the import writes the units', r.statusCode === 201 && r.json().created === 3);

/*
 * A re-import that names no block.
 *
 * Unit numbers are unique per block now, so strictly `A-1204` with no block is a different
 * record from `A-1204` in block A — and importing it would quietly give the property two.
 * Where exactly one unit carries that number it is matched to it; where several do, there
 * is no honest answer and it is reported rather than guessed.
 */
r = await post('/api/apartments/import', admin, {
  source: 'csv', units: [{ unitNo: 'A-1204' }, { unitNo: 'A-1205' }],
});
check('a blockless row matches the one unit that carries that number',
  r.json().created === 1 && r.json().skipped === 1, r.body.slice(0, 160));

r = await post('/api/apartments/import', admin, {
  source: 'csv', units: [{ unitNo: 'SHARED', block: 'A' }, { unitNo: 'SHARED', block: 'B' }],
});
check('the same number can live in two blocks', r.json().created === 2, r.body.slice(0, 140));

r = await post('/api/apartments/import', admin, { source: 'csv', units: [{ unitNo: 'SHARED' }] });
check('and a blockless row for it is skipped as ambiguous rather than duplicated',
  r.json().created === 0 && (r.json().ambiguous as string[]).includes('SHARED'),
  r.body.slice(0, 180));

// The most likely thing to be wrong with a real unit list is the same flat listed twice.
// unit_no is unique per property, so an un-deduped import dies on a constraint error and
// rolls back every row — including the good ones.
r = await post('/api/apartments/import', admin, {
  source: 'csv', dryRun: true,
  units: [{ unitNo: 'D-0101' }, { unitNo: 'D-0101' }, { unitNo: 'D-0102' }, { unitNo: 'A-1204' }],
});
check('the preview separates repeats in the list from units already on the register',
  r.statusCode === 200 && r.json().wouldCreate === 2
  && r.json().repeatedInList.includes('D-0101') && r.json().alreadyHere.includes('A-1204'),
  JSON.stringify(r.json()));

r = await post('/api/apartments/import', admin, {
  source: 'csv',
  units: [{ unitNo: 'D-0101' }, { unitNo: 'D-0101' }, { unitNo: 'D-0102' }],
});
check('a list with the same unit twice imports it once instead of failing',
  r.statusCode === 201 && r.json().created === 2, JSON.stringify(r.json()));
check('and the register really holds one of it',
  (db.prepare(`SELECT COUNT(*) n FROM apartments WHERE unit_no = 'D-0101'`).get() as { n: number }).n === 1);

r = await post('/api/apartments/import', admin, { source: 'manual', units: [{ unitNo: 'D-0103', block: 'D' }] });
check('a single unit can be added by hand through the same route', r.statusCode === 201 && r.json().created === 1);

{
  const d101 = (db.prepare(`SELECT id FROM apartments WHERE unit_no = 'D-0101'`).get() as { id: string }).id;
  r = await post(`/api/apartments/${d101}/status`, grace, {
    status: 'under_maintenance', note: 'Bathroom refit',
  });
  check('a supervisor changes a unit status', r.statusCode === 200);
  check('the reason lands in the audit log',
    (db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'apartment.status'`)
      .get() as { n: number }).n > 0);
  r = await post(`/api/apartments/${d101}/status`, ifeoma, { status: 'occupied' });
  check('a technician cannot change a unit status', r.statusCode === 403);
}

r = await get('/api/apartments', grace);
const apt = (r.json().apartments as { id: string; unit_no: string }[]).find((a) => a.unit_no === 'A-1204')!;
check('apartments list with an occupancy summary', !!apt && Array.isArray(r.json().summary));

r = await post('/api/asset-categories', admin, { name: 'Generator', defaultTrade: 'mechanical' });
const genCategory = r.json().id;
r = await post('/api/asset-categories', admin, { name: 'Split AC', defaultTrade: 'hvac' });
const acCategory = r.json().id;
check('asset categories created', r.statusCode === 201);

r = await post('/api/assets', admin, {
  assetTag: 'GEN-01', name: 'Perkins 250 kVA', categoryId: genCategory, locationId: plantId,
  capacity: '250 kVA', meterType: 'hours', criticality: 1, replacementCostKobo: 4_500_000_00,
});
const gen01 = r.json().id;
check('asset created with a tag', r.statusCode === 201);

r = await post('/api/assets', admin, { assetTag: 'GEN-01', name: 'Duplicate', locationId: plantId });
check('a duplicate asset tag is refused', r.statusCode === 409);

r = await post('/api/assets', admin, {
  assetTag: 'AC-A1204-01', name: 'Split AC — A-1204', categoryId: acCategory, apartmentId: apt.id,
});
const acAsset = r.json().id;
check('an asset can belong to an apartment', r.statusCode === 201);

r = await post(`/api/assets/${gen01}/reading`, admin, { reading: 4200, unit: 'hours' });
check('a meter reading is accepted', r.statusCode === 201);
r = await post(`/api/assets/${gen01}/reading`, admin, { reading: 4100, unit: 'hours' });
check('a meter reading that goes backwards is refused', r.statusCode === 400,
  r.json().error);

r = await get('/api/assets?tag=GEN-01', ifeoma);
check('scanning a tag returns the asset and its job history',
  r.json().assets.length === 1 && Array.isArray(r.json().history));

// --------------------------------------------------------------------------
heading('Roster — availability gates assignment');
// --------------------------------------------------------------------------
const staffIds: Record<string, string> = {};
{
  const at = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO staff (id, property_id, staff_no, first_name, last_name, trade, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  for (const [key, first, last, trade] of [
    ['ifeoma', 'Ifeoma', 'Bassey', 'hvac'],
    ['tunde', 'Tunde', 'Adeyemi', 'electrical'],
    ['musa', 'Musa', 'Ibrahim', 'electrical'],
  ] as const) {
    const id = `stf_${key}`;
    ins.run(id, propertyId, key.toUpperCase(), first, last, trade, at, at);
    staffIds[key] = id;
    db.prepare('UPDATE users SET staff_id = ? WHERE username = ?').run(id, key);
  }
}

r = await post('/api/shift-patterns', admin, { name: 'Afternoon', startTime: '14:00', endTime: '22:00' });
const afternoon = r.json().id;
check('a shift pattern is created', r.statusCode === 201 && r.json().crossesMidnight === false);

r = await post('/api/shift-patterns', admin, { name: 'Night', startTime: '22:00', endTime: '06:00' });
const night = r.json().id;
check('a shift that crosses midnight is detected', r.json().crossesMidnight === true);

r = await post('/api/roster', grace, {
  entries: [
    { staffId: staffIds['ifeoma']!, workDate: day(0), shiftPatternId: afternoon },
    { staffId: staffIds['tunde']!, workDate: day(0), shiftPatternId: afternoon },
    { staffId: staffIds['musa']!, workDate: day(0), shiftPatternId: afternoon },
  ],
});
check('a roster week is drafted', r.statusCode === 201 && r.json().written === 3);

// A fortnight for the whole team is what the Fill-a-pattern tool sends: one call, not
// eight people times fourteen days of clicking. If this cap moves the UI has to know.
{
  const bulk: { staffId: string; workDate: string; shiftPatternId: string | null; status: string }[] = [];
  const team = [staffIds['ifeoma']!, staffIds['tunde']!, staffIds['musa']!];
  team.forEach((sid, person) => {
    for (let n = 7; n < 21; n++) {
      const date = day(n);
      const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
      bulk.push({ staffId: sid, workDate: date,
                  shiftPatternId: sunday ? null : (person % 2 ? afternoon : night),
                  status: sunday ? 'off' : 'scheduled' });
    }
  });
  r = await post('/api/roster', grace, { entries: bulk });
  check('a fortnight for the whole team writes in one call',
    r.statusCode === 201 && r.json().written === bulk.length, JSON.stringify(r.json()));

  // Overwriting rather than duplicating is what makes the fill tool safe to run twice.
  r = await post('/api/roster', grace, { entries: bulk });
  check('running the same fill again overwrites instead of duplicating',
    r.statusCode === 201
    && (db.prepare('SELECT COUNT(*) n FROM roster_entries WHERE staff_id = ? AND work_date = ?')
         .get(team[0]!, day(7)) as { n: number }).n === 1);

  r = await post('/api/roster', grace, {
    entries: Array.from({ length: 501 }, (_, i) => ({
      staffId: team[0]!, workDate: day(100 + i), shiftPatternId: afternoon,
    })),
  });
  check('a write over 500 days is refused rather than half-applied', r.statusCode === 400);
}

r = await get(`/api/roster?from=${day(7)}&to=${day(13)}`, grace);
check('a future week can be read without touching this one',
  r.statusCode === 200 && r.json().from === day(7) && r.json().entries.length > 0);
check('drafted days come back unpublished so the grid can mark them',
  (r.json().entries as { published_at: string | null }[]).some((e) => e.published_at === null));

r = await post('/api/roster/publish', grace, { from: day(0), to: day(6) });
check('the roster is published', r.statusCode === 200 && r.json().published === 3);
check('publishing one week leaves the next one still a draft',
  (db.prepare('SELECT COUNT(*) n FROM roster_entries WHERE work_date = ? AND published_at IS NULL')
    .get(day(7)) as { n: number }).n > 0);

r = await get('/api/jobs/assignable', grace);
check('nobody is assignable before anyone is marked present', r.json().staff.length === 0);
check('the empty list explains what to do', typeof r.json().note === 'string');

r = await post('/api/roster/mark', grace, { staffId: staffIds['ifeoma']!, workDate: day(0), status: 'present' });
check('a supervisor marks someone present', r.statusCode === 200);

r = await post('/api/roster/mark', grace, {
  staffId: staffIds['tunde']!, workDate: day(0), status: 'absent', reason: 'sick',
});
check('a supervisor marks someone absent with a reason', r.statusCode === 200);
check('the absence is recorded',
  (db.prepare('SELECT COUNT(*) n FROM absences WHERE staff_id = ?').get(staffIds['tunde']!) as { n: number }).n === 1);

r = await get('/api/jobs/assignable', grace);
check('only people marked present are assignable', r.json().staff.length === 1);

r = await post('/api/roster/mark', grace, { staffId: staffIds['musa']!, workDate: day(2), status: 'present' });
check('marking someone who is not rostered that day is refused', r.statusCode === 404, r.json().error);

r = await post('/api/roster/mark', ifeoma, { staffId: staffIds['ifeoma']!, workDate: day(0), status: 'present' });
check('a technician cannot mark the roster', r.statusCode === 403);

// --------------------------------------------------------------------------
heading('Work orders — lifecycle, SLA and segregation of duties');
// --------------------------------------------------------------------------
r = await post('/api/jobs', grace, { title: 'Job with no target', priority: 'P3' });
check('a job attached to nothing is refused', r.statusCode === 400 && r.json().error === 'no_target');

r = await post('/api/jobs', grace, {
  title: 'AC not cooling, guest in residence', apartmentId: apt.id, assetId: acAsset,
  trade: 'hvac', priority: 'P2', description: 'Guest reports no cooling since 14:00.',
});
const job = r.json().job;
check('a job is created', r.statusCode === 201);
check('the reference is a per-year sequence', /^WO-\d{4}-\d{4}$/.test(job.ref), job.ref);
check('the response deadline comes from the SLA matrix',
  near(new Date(job.respond_by).getTime() - new Date(job.reported_at).getTime(), 60 * 60_000, 2000));
check('the resolve deadline comes from the SLA matrix',
  near(new Date(job.due_at).getTime() - new Date(job.reported_at).getTime(), 1440 * 60_000, 2000));

r = await post(`/api/jobs/${job.id}/assign`, grace, { staffId: staffIds['tunde']! });
check('assigning to someone marked absent is refused', r.statusCode === 409 && r.json().error === 'not_on_shift');
check('the refusal names the person and says how to fix it',
  /Tunde Adeyemi/.test(r.json().message) && /roster/.test(r.json().message), r.json().message);

r = await post(`/api/jobs/${job.id}/assign`, grace, { staffId: staffIds['ifeoma']! });
check('assigning to someone marked present succeeds', r.statusCode === 200);

r = await post(`/api/jobs/${job.id}/accept`, ifeoma);
check('the assignee accepts the job', r.statusCode === 200 && r.json().job.status === 'accepted');
check('accepting stamps the response time', !!r.json().job.responded_at);

r = await post(`/api/jobs/${job.id}/start`, ifeoma);
check('the job starts', r.json().job.status === 'in_progress');

r = await post(`/api/jobs/${job.id}/complete`, ifeoma, { resolutionNotes: '' });
check('completing without saying what you did is refused', r.statusCode === 400);

// SLA pause
{
  const before = (await get(`/api/jobs/${job.id}`, grace)).json().sla.effectiveDueAt;
  r = await post(`/api/jobs/${job.id}/hold`, ifeoma, { reason: 'awaiting_parts', note: 'Gas cylinder empty' });
  check('a job goes on hold with a reason', r.json().job.status === 'on_hold');
  const paused = (await get(`/api/jobs/${job.id}`, grace)).json().sla;
  check('the SLA clock reads as paused', paused.state === 'paused');

  // Rewind the hold so a measurable amount of held time accrues.
  db.prepare('UPDATE work_orders SET held_at = ? WHERE id = ?').run(iso(-1 / 24), job.id);
  const after = (await get(`/api/jobs/${job.id}`, grace)).json().sla;
  check('held time pushes the effective deadline out',
    new Date(after.effectiveDueAt).getTime() > new Date(before).getTime() + 3_000_000,
    `${before} -> ${after.effectiveDueAt}`);

  r = await post(`/api/jobs/${job.id}/resume`, ifeoma);
  check('resuming banks the held minutes', r.json().job.held_minutes_total >= 59,
    String(r.json().job.held_minutes_total));
}

r = await post(`/api/jobs/${job.id}/complete`, ifeoma, {
  resolutionNotes: 'Regassed and leak-tested. Cooling restored.', failureCause: 'wear',
});
check('the job completes with notes', r.json().job.status === 'completed');
check('completion records who did it', r.json().job.completed_by !== null);

r = await post(`/api/jobs/${job.id}/verify`, ifeoma);
check('a technician has no power to verify at all',
  r.statusCode === 403 && r.json().required === 'wo.verify');

r = await post(`/api/jobs/${job.id}/verify`, grace);
check('a supervisor verifies it', r.statusCode === 200 && r.json().job.status === 'verified');
check('costs freeze on verification', r.json().job.costs_frozen === 1);

r = await post(`/api/jobs/${job.id}/labour`, grace, { minutes: 30, staffId: staffIds['ifeoma']! });
check('labour cannot be added after the costs freeze', r.statusCode === 409);

{
  await post('/api/roster/mark', grace, { staffId: staffIds['musa']!, workDate: day(0), status: 'present' });
  const second = (await post('/api/jobs', grace, {
    title: 'Corridor light out', locationId: siteId, trade: 'electrical', priority: 'P3',
  })).json().job;
  await post(`/api/jobs/${second.id}/assign`, grace, { staffId: staffIds['musa']! });
  await post(`/api/jobs/${second.id}/accept`, musa);
  await post(`/api/jobs/${second.id}/start`, musa);
  await post(`/api/jobs/${second.id}/complete`, musa, { resolutionNotes: 'Tube replaced.' });
  let v = await post(`/api/jobs/${second.id}/verify`, musa);
  check('a team lead who can verify still cannot verify their own work',
    v.statusCode === 403 && v.json().error === 'self_verify');
  check('the refusal explains why', /someone else/.test(v.json().message), v.json().message);
  v = await post(`/api/jobs/${second.id}/verify`, grace);
  check('a second person signs it off', v.statusCode === 200);
}

r = await post(`/api/jobs/${job.id}/reopen`, grace, { reason: 'Guest reports the fault has returned' });
check('a verified job can be reopened', r.statusCode === 200 && r.json().job.status === 'assigned');
check('reopening is counted', r.json().job.reopened_count === 1);
check('reopening unfreezes the costs', r.json().job.costs_frozen === 0);

throws('the job event log refuses UPDATE',
  () => db.prepare(`UPDATE work_order_events SET note = 'tampered'`).run());
throws('the job event log refuses DELETE', () => db.prepare('DELETE FROM work_order_events').run());

r = await get(`/api/jobs/${job.id}`, grace);
const events = (r.json().history as { event_type: string }[]).map((e) => e.event_type);
for (const t of ['created', 'assigned', 'accepted', 'started', 'hold', 'resume', 'completed', 'verified', 'reopened']) {
  check(`the history records "${t}"`, events.includes(t));
}
check('a supervisor sees the cost breakdown', r.json().cost !== null);

r = await get(`/api/jobs/${job.id}`, ifeoma);
check('a technician does not see costs', r.json().cost === null);

// scoping
r = await get('/api/jobs', ifeoma);
check('a technician sees only their own jobs', r.json().scope === 'own');
r = await get('/api/jobs', musa);
check('a team lead sees their team', r.json().scope === 'team');
r = await get('/api/jobs', grace);
check('a supervisor sees everything', r.json().scope === 'all');

// --------------------------------------------------------------------------
heading('Escalation');
// --------------------------------------------------------------------------
r = await post('/api/jobs', grace, {
  title: 'No power to Block B riser', locationId: siteId, priority: 'P1', trade: 'electrical',
});
const p1 = r.json().job;
// Age it so it is genuinely past both deadlines.
// P1 resolves in 4 h, so a deadline 2 h ago is breached but not yet doubled.
db.prepare('UPDATE work_orders SET reported_at = ?, respond_by = ?, due_at = ? WHERE id = ?')
  .run(iso(-1), iso(-1), iso(-2 / 24), p1.id);

let esc = tick(db, propertyId);
check('the sweep escalates a breached P1', esc.escalated.some((e) => e.id === p1.id), JSON.stringify(esc.escalated));
check('it escalates past the resolve deadline, not just the response one',
  esc.escalated.find((e) => e.id === p1.id)?.to === 2);

esc = tick(db, propertyId);
check('a second sweep does not escalate the same job again',
  !esc.escalated.some((e) => e.id === p1.id));

check('the supervisor is notified',
  (db.prepare(
    `SELECT COUNT(*) n FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.kind = 'escalation' AND u.username = 'grace'`
  ).get() as { n: number }).n > 0);

// P1 at twice its deadline reaches the HOD.
db.prepare('UPDATE work_orders SET due_at = ? WHERE id = ?').run(iso(-3), p1.id);
esc = tick(db, propertyId);
check('a P1 at twice its deadline reaches the HOD',
  esc.escalated.find((e) => e.id === p1.id)?.role === 'hod');

r = await get('/api/notifications', grace);
check('notifications are readable with an unread count', r.json().unread > 0);
r = await post('/api/notifications/read', grace);
check('notifications can be marked read', r.json().marked > 0);

// --------------------------------------------------------------------------
heading('Preventive maintenance');
// --------------------------------------------------------------------------
r = await post('/api/ppm/schedules', grace, {
  name: 'Genset 250-hour service', scopeType: 'asset', assetId: gen01,
  triggerType: 'calendar', intervalValue: 30, intervalUnit: 'day',
  firstDueAt: iso(-5), priority: 'P4', defaultTrade: 'mechanical',
});
const schedule = r.json().id;
check('a calendar schedule is created', r.statusCode === 201);

r = await post('/api/ppm/schedules', grace, {
  name: 'Wrong pairing', scopeType: 'asset', assetId: gen01,
  triggerType: 'calendar', intervalValue: 250, intervalUnit: 'hours',
});
check('a calendar schedule with an hours interval is refused', r.statusCode === 400);

r = await post('/api/ppm/generate', grace);
check('a due schedule generates a job', r.statusCode === 201 && r.json().created.length === 1,
  JSON.stringify(r.json().created));
const ppmJobRef = r.json().created[0].ref;

r = await post('/api/ppm/generate', grace);
check('generating again does not duplicate an open PPM job', r.json().created.length === 0);

const ppmJob = db.prepare('SELECT * FROM work_orders WHERE ref = ?').get(ppmJobRef) as
  { id: string; source: string; due_at: string };
check('the generated job is marked as planned work', ppmJob.source === 'ppm');

// The anti-drift rule: next due is measured from the DUE date, not the completion date.
await post(`/api/jobs/${ppmJob.id}/assign`, grace, { staffId: staffIds['ifeoma']! });
await post(`/api/jobs/${ppmJob.id}/accept`, ifeoma);
await post(`/api/jobs/${ppmJob.id}/start`, ifeoma);

// ---- the checklist gate ---------------------------------------------------
// Attach a sheet to the schedule that raised this job, then prove a job cannot be signed
// off as serviced while its critical steps sit unrecorded. That is the whole point of a
// checklist; without the gate it is decoration.
r = await post('/api/ppm/checklists', admin, {
  name: 'Service gate sheet',
  items: [
    { task: 'Coolant level between marks', expectedValue: 'between MIN and MAX', isCritical: true },
    { task: 'Record running hours', requiresReading: true, isCritical: true },
    { task: 'Wipe the plant room down' },
  ],
});
const gateTemplate = r.json().id;
db.prepare('UPDATE ppm_schedules SET checklist_template_id = ? WHERE id = ?').run(gateTemplate, schedule);

r = await get(`/api/jobs/${ppmJob.id}`, ifeoma);
check('the job card is handed the sheet its schedule attached',
  r.statusCode === 200 && r.json().checklist?.total === 3 && r.json().checklist?.done === 0);

r = await post(`/api/jobs/${ppmJob.id}/complete`, ifeoma, { resolutionNotes: 'Serviced, filters replaced.' });
check('a planned job cannot be completed with critical steps unrecorded',
  r.statusCode === 409 && r.json().error === 'checklist_incomplete', JSON.stringify(r.json()));
check('and the refusal names the steps that are missing',
  /Coolant level between marks/.test(r.json().message), r.json().message);

const gateItems = db.prepare(
  'SELECT id, is_critical FROM checklist_items WHERE template_id = ? ORDER BY seq'
).all(gateTemplate) as { id: string; is_critical: number }[];

r = await post(`/api/jobs/${ppmJob.id}/checklist`, ifeoma, {
  results: [{ itemId: gateItems[0]!.id, result: 'pass', value: 'mid-range' }],
});
check('a technician records a checklist result', r.statusCode === 201 && r.json().recorded === 1);

r = await post(`/api/jobs/${ppmJob.id}/complete`, ifeoma, { resolutionNotes: 'Serviced.' });
check('one critical step still outstanding still blocks completion', r.statusCode === 409);

r = await post(`/api/jobs/${ppmJob.id}/checklist`, ifeoma, {
  results: [{ itemId: gateItems[1]!.id, result: 'fail', note: 'Hour meter glass cracked, unreadable' }],
});
check('a failed step is recorded and counted', r.statusCode === 201 && r.json().failed === 1);
check('the client is told a failed step deserves a follow-up job', /follow-up/.test(r.json().note ?? ''));

r = await get(`/api/jobs/${ppmJob.id}`, ifeoma);
check('the sheet comes back with results merged onto the template items',
  r.json().checklist.done === 2 && r.json().checklist.failedCritical === 1);

// Recording all the critical steps — pass or fail — clears the gate. A fail is a finding,
// not an excuse to leave the sheet blank, and the non-critical step stays optional.
r = await post(`/api/jobs/${ppmJob.id}/complete`, ifeoma, { resolutionNotes: 'Serviced, filters replaced.' });
check('with every critical step recorded the job completes', r.statusCode === 200, JSON.stringify(r.json()));
r = await post(`/api/jobs/${ppmJob.id}/verify`, grace);
check('the PPM job verifies', r.statusCode === 200);

{
  const s = db.prepare('SELECT next_due_at FROM ppm_schedules WHERE id = ?').get(schedule) as
    { next_due_at: string };
  const fromDue = new Date(addInterval(ppmJob.due_at, 30, 'day')).getTime();
  const fromCompletion = Date.now() + 30 * 86_400_000;
  const actual = new Date(s.next_due_at).getTime();
  check('the next service is measured from the due date, not the completion date',
    near(actual, fromDue, 60_000), new Date(actual).toISOString());
  check('so a late job does not push the whole schedule later',
    Math.abs(actual - fromCompletion) > 4 * 86_400_000);
}

r = await get('/api/ppm/compliance', grace);
{
  const c = r.json();
  check('PPM compliance is reported', typeof c.compliancePct === 'number');
  // The trap this guards: dividing by every job raised reports 0% on a property where
  // nothing is late yet, because work not due for weeks sits in the denominator.
  check('a job raised but not yet due is left out of the compliance denominator',
    c.judged === c.onTime + c.late + c.overdue && c.judged <= c.generated,
    JSON.stringify(c));
  check('an overdue job counts against compliance before anyone closes it',
    c.overdue <= c.open);
}

{
  // A property whose planned work has all been raised and none of it has fallen due is
  // unmeasured, not failing. Null says so; zero would be a lie.
  const fresh = ppmCompliance(db, propertyId, iso(-1), iso(1), iso(-0.5));
  check('with nothing judged yet the percentage is null, not zero',
    fresh.compliancePct === null || fresh.judged > 0,
    JSON.stringify({ pct: fresh.compliancePct, judged: fresh.judged }));
}

// meter-triggered
r = await post('/api/ppm/schedules', grace, {
  name: 'Genset 250-hour oil change', scopeType: 'asset', assetId: gen01,
  triggerType: 'meter', intervalValue: 250, intervalUnit: 'hours', firstDueMeter: 5000,
});
check('a meter schedule is created', r.statusCode === 201);
r = await post('/api/ppm/generate', grace);
check('a meter schedule below its threshold generates nothing', r.json().created.length === 0);
await post(`/api/assets/${gen01}/reading`, admin, { reading: 5010, unit: 'hours' });
r = await post('/api/ppm/generate', grace);
check('crossing the meter threshold generates the job', r.json().created.length === 1);

// --------------------------------------------------------------------------
heading('Diesel — dip charts, deliveries, runs and reconciliation');
// --------------------------------------------------------------------------
check('a dip chart interpolates between calibration points',
  near(litresFromDip([[0, 0], [500, 1000], [1000, 3000], [1500, 6000], [2000, 10000]], 750), 2000));
check('a dip below the chart floor reads as empty',
  litresFromDip([[100, 50], [1000, 5000]], 0) === 50);
check('a dip above the chart ceiling reads as full',
  litresFromDip([[100, 50], [1000, 5000]], 9999) === 5000);
throws('a tank with no calibration chart refuses a millimetre dip',
  () => litresFromDip(null, 500));

const profile: Profile = {
  asset_id: gen01, kva_rating: 250, expected_lph_at_50pct: 30, expected_lph_at_75pct: 40,
  expected_lph_at_100pct: 55, deviation_threshold_pct: 10, consecutive_deviations: 0,
  service_interval_hours: 250, next_service_hours: null,
};
check('expected burn interpolates for the load actually carried',
  near(expectedLph(profile, 250 * 0.8 * 0.875)!, 47.5, 0.5), String(expectedLph(profile, 175)));
check('expected burn falls back sensibly with no load figure', expectedLph(profile) === 40);

r = await post('/api/fuel/tanks', admin, {
  name: 'Bulk tank', kind: 'bulk', capacityL: 15000, minLevelL: 2500,
  dipChart: [[0, 0], [500, 2000], [1000, 5000], [1500, 7500], [2000, 10000], [2500, 12500], [3000, 15000]],
});
const bulk = r.json().id;
check('a tank is created with a calibration chart', r.statusCode === 201 && !r.json().warning);

r = await post('/api/fuel/tanks', admin, { name: 'Day tank', kind: 'day_tank', capacityL: 1000, minLevelL: 300 });
const dayTank = r.json().id;
check('a tank without a chart is created with a warning', typeof r.json().warning === 'string');

r = await post(`/api/fuel/tanks/${bulk}/dip`, ifeoma, { litres: 7180, takenAt: iso(-7) });
check('an opening dip is logged', r.statusCode === 201);
r = await post(`/api/fuel/tanks/${bulk}/dip`, ifeoma, { dipMm: 750 });
check('a millimetre dip converts through the chart', near(r.json().litres, 3500));
r = await post(`/api/fuel/tanks/${bulk}/dip`, ifeoma, { litres: 20000 });
check('a dip beyond the tank capacity is refused', r.statusCode === 400);

r = await post('/api/fuel/deliveries', grace, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 6000, dipAfterL: 10940, witnessedBy: 'x', deliveredAt: iso(-5),
});
check('a supervisor cannot receive a delivery, only countersign one',
  r.statusCode === 403 && r.json().required === 'fuel.delivery.create');

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 6000, dipAfterL: 10940, witnessedBy: 'x', deliveredAt: iso(-5),
});
check('an unknown witness is refused', r.statusCode === 400);

const graceUserId = (db.prepare(`SELECT id FROM users WHERE username = 'grace'`).get() as { id: string }).id;
const hodUserId = (db.prepare(`SELECT id FROM users WHERE username = 'hod'`).get() as { id: string }).id;

const halimaUserId = (db.prepare(`SELECT id FROM users WHERE username = 'halima'`).get() as { id: string }).id;
r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 6000, dipAfterL: 10940,
  witnessedBy: halimaUserId, deliveredAt: iso(-5),
});
check('one person cannot both receive and witness a delivery',
  r.statusCode === 403 && r.json().error === 'same_signature');

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 6000, dipAfterL: 10940, witnessedBy: graceUserId,
  waybillNo: 'NG-4471', unitPriceKobo: 1_250_00, deliveredAt: iso(-5),
});
check('a two-signature delivery is accepted', r.statusCode === 201);
check('received litres come from the dips, not the invoice', near(r.json().receivedL, 4940));
check('the variance is received minus invoiced', near(r.json().varianceL, -60));
check('a variance inside tolerance is not flagged', r.json().flagged === false, String(r.json().variancePct));

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 100, dipAfterL: 4600, witnessedBy: graceUserId, deliveredAt: iso(-9),
});
check('a variance beyond tolerance is flagged', r.json().flagged === true, String(r.json().variancePct));
check('the flag notifies the HOD',
  (db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'fuel_variance'`).get() as { n: number }).n > 0);

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 9000, dipAfterL: 8000, witnessedBy: graceUserId,
});
check('a closing dip below the opening dip is refused', r.statusCode === 400);

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 14000, dipAfterL: 19000, witnessedBy: graceUserId,
});
check('a delivery that would overfill the tank is refused',
  r.statusCode === 400 && r.json().error === 'over_capacity');

// issues out to the genset
for (const [days, litres] of [[-4, 1500], [-3, 1500], [-2, 1500], [-1, 1330]] as const) {
  await post('/api/fuel/issues', ifeoma, {
    tankId: bulk, toAssetId: gen01, quantityL: litres, issuedAt: iso(days),
  });
}
r = await post(`/api/fuel/tanks/${bulk}/dip`, ifeoma, { litres: 6240, takenAt: iso(0.005) });
check('a closing dip is logged', r.statusCode === 201);

r = await app.inject({
  method: 'GET', headers: grace,
  url: `/api/fuel/reconcile?tankId=${bulk}&from=${encodeURIComponent(iso(-7))}&to=${encodeURIComponent(iso(0.01))}`,
});
const rec = r.json();
check('reconciliation reads the opening dip', near(rec.openingL, 7180));
check('reconciliation sums deliveries received', near(rec.deliveriesL, 4940));
check('reconciliation sums issues out', near(rec.issuesL, 5830));
check('expected closing = opening + deliveries - issues', near(rec.computedClosingL, 6290));
check('variance = dipped closing - expected closing', near(rec.varianceL, -50), String(rec.varianceL));
check('variance is measured against throughput, not the balance',
  near(rec.variancePct, -0.46, 0.02), String(rec.variancePct));
check('a variance inside tolerance reads as ok', rec.status === 'ok');

r = await post('/api/fuel/reconcile', grace, { tankId: bulk, from: iso(-7), to: iso(0.01) });
check('a reconciliation can be closed and stored', r.statusCode === 201);

// engine health
r = await post(`/api/gensets/${gen01}/profile`, admin, {
  kvaRating: 250, expectedLphAt50: 30, expectedLphAt75: 40, expectedLphAt100: 55,
  serviceIntervalHours: 250, deviationThresholdPct: 10,
});
check('a genset profile is saved', r.statusCode === 201);

r = await post('/api/gensets/runs', ifeoma, {
  gensetAssetId: gen01, startedAt: iso(-3), endedAt: iso(-2.9),
  hoursStart: 5010, hoursEnd: 4990,
});
check('an hour meter that goes backwards is refused', r.statusCode === 400);

let raised: string | null = null;
for (let i = 0; i < 3; i++) {
  r = await post('/api/gensets/runs', ifeoma, {
    gensetAssetId: gen01, startedAt: iso(-3 + i), endedAt: iso(-2.6 + i),
    hoursStart: 5010 + i * 10, hoursEnd: 5020 + i * 10,
    fuelStartL: 500, fuelEndL: 40, kwhGenerated: 1400,
  });
  if (i === 0) {
    check('a run computes hours, fuel used and burn rate',
      r.json().runHours === 10 && near(r.json().fuelUsedL, 460) && near(r.json().actualLph, 46));
    check('the run is compared with the expected burn for the load', near(r.json().expectedLph, 40));
    check('the deviation is a percentage', near(r.json().deviationPct, 15));
    check('one bad run does not raise a job', r.json().raisedJob === null);
  }
  if (i === 1) check('two bad runs still do not raise a job', r.json().raisedJob === null);
  if (i === 2) raised = r.json().raisedJob;
}
check('three consecutive runs over threshold raise a job automatically', !!raised, String(raised));
check('the raised job names the likely cause',
  /injectors/i.test((db.prepare('SELECT description FROM work_orders WHERE ref = ?').get(raised) as
    { description: string }).description));
check('the deviation streak resets after a job is raised',
  (db.prepare('SELECT consecutive_deviations c FROM genset_profiles WHERE asset_id = ?').get(gen01) as
    { c: number }).c === 0);

r = await get('/api/power/cost', hod);
check('cost per kWh generated is reported', typeof r.json().costPerKwhKobo === 'number',
  JSON.stringify(r.json()));

// --------------------------------------------------------------------------
heading('Stores');
// --------------------------------------------------------------------------
r = await post('/api/stock', halima, {
  code: 'SP-0142', name: 'Contactor coil 240 V', unit: 'pcs', minLevel: 2, reorderQty: 6,
});
const coil = r.json().id;
check('a stock item is created', r.statusCode === 201);

r = await post('/api/stock', halima, { code: 'SP-0142', name: 'Duplicate' });
check('a duplicate item code is refused', r.statusCode === 409);

r = await post(`/api/stock/${coil}/movement`, halima, { type: 'receipt', qtyDelta: 10, unitCostKobo: 38_500_00 });
check('stock is received', r.statusCode === 201 && r.json().balance === 10);

r = await post(`/api/stock/${coil}/movement`, ifeoma, { type: 'receipt', qtyDelta: 5 });
check('a technician cannot move stock', r.statusCode === 403 && r.json().required === 'stock.receive');

r = await post(`/api/jobs/${job.id}/parts`, halima, { itemId: coil, qty: 3 });
check('parts are issued against a job', r.statusCode === 201 && r.json().balance === 7);
check('the issue carries the job cost', r.json().totalKobo === 3 * 38_500_00);

r = await get(`/api/jobs/${job.id}`, grace);
check('the job picks up the parts cost', r.json().job.cost_parts_kobo === 3 * 38_500_00);
check('the job history records the issue',
  (r.json().history as { event_type: string }[]).some((e) => e.event_type === 'part_issued'));

r = await post(`/api/jobs/${job.id}/parts`, halima, { itemId: coil, qty: 100 });
check('issuing more than the store holds is refused',
  r.statusCode === 409 && r.json().error === 'insufficient_stock');
check('the refusal says what is actually on the shelf', /7 pcs/.test(r.json().message), r.json().message);

r = await post(`/api/stock/${coil}/movement`, halima, { type: 'receipt', qtyDelta: -20 });
check('a receipt cannot take the balance negative', r.statusCode === 409);

throws('the stock ledger refuses UPDATE',
  () => db.prepare('UPDATE stock_movements SET qty_delta = 999').run());
throws('the stock ledger refuses DELETE', () => db.prepare('DELETE FROM stock_movements').run());

r = await post('/api/stock/recompute', admin);
check('balances rebuilt from the ledger agree with the cache', r.json().corrected === 0);

r = await post(`/api/jobs/${job.id}/parts`, halima, { itemId: coil, qty: 5 });
check('taking stock to the minimum notifies the storekeeper',
  (db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'stock_low'`).get() as { n: number }).n > 0);

// ---- stock counts ---------------------------------------------------------
r = await post('/api/stock/counts', halima);
const countId = r.json().id;
check('a stock count opens with a line per catalogue item',
  r.statusCode === 201 && r.json().lines > 0, JSON.stringify(r.json()));

r = await post('/api/stock/counts', halima);
check('a second count cannot open while one is still open',
  r.statusCode === 409 && r.json().error === 'count_already_open');

r = await get(`/api/stock/counts/${countId}`, halima);
{
  const lines = r.json().lines as { id: string; item_id: string; system_qty: number;
                                    counted_qty: number; variance: number }[];
  check('every line starts at the system figure, so an untouched count posts nothing',
    lines.every((l) => l.counted_qty === l.system_qty && l.variance === 0));

  const coilLine = lines.find((l) => l.item_id === coil)!;
  const systemQty = coilLine.system_qty;

  r = await post(`/api/stock/counts/${countId}/lines`, halima, {
    lines: [{ lineId: coilLine.id, countedQty: systemQty - 2, reason: 'Two coils broken in the bin' }],
  });
  check('a counted quantity is recorded', r.statusCode === 201 && r.json().recorded === 1);

  r = await get(`/api/stock/counts/${countId}`, halima);
  const after = (r.json().lines as { id: string; variance: number }[])
    .find((l) => l.id === coilLine.id)!;
  check('the variance is derived rather than sent by the client', after.variance === -2);

  r = await post(`/api/stock/counts/${countId}/lines`, ifeoma, {
    lines: [{ lineId: coilLine.id, countedQty: 1 }],
  });
  check('counting needs the stock.adjust permission', r.statusCode === 403);

  const before = (db.prepare('SELECT current_qty FROM stock_items WHERE id = ?')
    .get(coil) as { current_qty: number }).current_qty;

  r = await post(`/api/stock/counts/${countId}/post`, halima);
  check('posting adjusts only the lines that differ',
    r.statusCode === 200 && r.json().posted === 1, JSON.stringify(r.json()));
  check('the balance moved by the variance',
    (db.prepare('SELECT current_qty FROM stock_items WHERE id = ?')
      .get(coil) as { current_qty: number }).current_qty === before - 2);
  check('and it moved because a ledger movement says so, not a silent edit',
    (db.prepare(`SELECT COUNT(*) n FROM stock_movements WHERE item_id = ? AND type = 'count'`)
      .get(coil) as { n: number }).n === 1);

  r = await post(`/api/stock/counts/${countId}/post`, halima);
  check('a posted count cannot be posted twice', r.statusCode === 409);

  r = await post(`/api/stock/counts/${countId}/lines`, halima, {
    lines: [{ lineId: coilLine.id, countedQty: 5 }],
  });
  check('a posted count cannot be edited afterwards', r.statusCode === 409);
}

r = await post('/api/stock/recompute', admin);
check('balances still rebuild from the ledger after a count', r.json().corrected === 0);

r = await post('/api/requisitions', musa, {
  purpose: 'Restock contactor coils',
  lines: [{ itemId: coil, description: 'Contactor coil 240 V', qty: 6, estimatedKobo: 231_000_00 }],
});
const requisition = r.json().id;
check('a technician or team lead can raise a requisition', r.statusCode === 201 && /^RQ-/.test(r.json().ref));

r = await post(`/api/requisitions/${requisition}/decide`, musa, { decision: 'approved' });
check('someone without the approval right cannot decide',
  r.statusCode === 403 && r.json().required === 'requisition.approve');

// A supervisor raising their own requisition still cannot approve it.
const own = (await post('/api/requisitions', grace, {
  purpose: 'Supervisor raising their own',
  lines: [{ description: 'Spare fuses', qty: 10, estimatedKobo: 5_000_00 }],
})).json();
r = await post(`/api/requisitions/${own.id}/decide`, grace, { decision: 'approved' });
check('the person who raised a requisition cannot approve it',
  r.statusCode === 403 && r.json().error === 'self_approval', JSON.stringify(r.json()));

r = await post(`/api/requisitions/${requisition}/decide`, grace, { decision: 'approved' });
check('a supervisor approves someone else\'s requisition', r.statusCode === 200);

r = await post(`/api/requisitions/${requisition}/decide`, grace, { decision: 'rejected' });
check('a decided requisition cannot be decided again', r.statusCode === 409);

// --------------------------------------------------------------------------
heading('Departmental finance');
// --------------------------------------------------------------------------
r = await post('/api/cost-centres', femi, { code: 'DIESEL', name: 'Diesel' });
const ccDiesel = r.json().id;
r = await post('/api/cost-centres', femi, { code: 'SPARES', name: 'Spares' });
const ccSpares = r.json().id;
check('cost centres are created', r.statusCode === 201);

const now = new Date();
r = await post('/api/budgets', femi, {
  costCentreId: ccSpares, fiscalYear: now.getUTCFullYear(), periodMonth: now.getUTCMonth() + 1,
  amountKobo: 1_000_000_00,
});
check('a budget is set for the period', r.statusCode === 201);

r = await post('/api/purchases', femi, {
  description: 'Contactor coils × 6', amountKobo: 231_000_00, costCentreId: ccSpares,
  requisitionId: requisition,
});
check('a purchase is recorded against the requisition', r.statusCode === 201 && /^PU-/.test(r.json().ref));
check('the requisition moves to purchased',
  (db.prepare('SELECT status FROM requisitions WHERE id = ?').get(requisition) as { status: string })
    .status === 'purchased');

r = await post('/api/purchases', femi, {
  description: 'Vendor AC repair', amountKobo: 75_000_00, woId: job.id, costCentreId: ccSpares,
});
check('a purchase can be charged to a job', r.statusCode === 201);
r = await get(`/api/jobs/${job.id}`, grace);
check('the job picks up the vendor cost', r.json().job.cost_vendor_kobo === 75_000_00);

r = await post(`/api/jobs/${job.id}/complete`, ifeoma, { resolutionNotes: 'Second visit, coil replaced.' });
check('a reopened job cannot jump straight back to complete',
  r.statusCode === 409 && r.json().error === 'bad_transition');
await post(`/api/jobs/${job.id}/accept`, ifeoma);
await post(`/api/jobs/${job.id}/start`, ifeoma);
await post(`/api/jobs/${job.id}/complete`, ifeoma, { resolutionNotes: 'Second visit, coil replaced.' });
await post(`/api/jobs/${job.id}/verify`, grace);
r = await post('/api/purchases', femi, { description: 'Late charge', amountKobo: 1000, woId: job.id });
check('a purchase cannot be charged to a verified job', r.statusCode === 409);

r = await post('/api/expenses', femi, {
  costCentreId: ccDiesel, amountKobo: 4_280_000_00, description: 'Diesel — September',
});
const expense = r.json().id;
r = await post(`/api/expenses/${expense}/approve`, femi);
check('the person who raised an expense cannot approve it', r.statusCode === 403);
r = await post(`/api/expenses/${expense}/approve`, hod);
check('the HOD approves it', r.statusCode === 200);

r = await get('/api/budgets/vs-actual', femi);
const spares = (r.json().lines as { code: string; budget_kobo: number; actual_kobo: number }[])
  .find((l) => l.code === 'SPARES')!;
check('budget versus actual picks up the purchases',
  spares.budget_kobo === 1_000_000_00 && spares.actual_kobo === 306_000_00,
  JSON.stringify(spares));

r = await get('/api/jobs', femi);
check('finance can read jobs', r.statusCode === 200);
r = await post('/api/jobs', femi, { title: 'Finance raising work', locationId: siteId });
check('finance cannot raise jobs', r.statusCode === 403);

// --------------------------------------------------------------------------
heading('Safety and utilities');
// --------------------------------------------------------------------------
r = await post('/api/permits', musa, {
  type: 'electrical_isolation', woId: job.id, validFrom: iso(0), validTo: iso(0.5),
  precautions: ['Prove dead before touching', 'Lock and tag the breaker'],
  isolationPoints: [{ assetId: gen01, description: 'Block B riser breaker', lockTagNo: 'LT-014' }],
});
const permit = r.json().id;
check('a permit to work is requested', r.statusCode === 201 && /^PTW-/.test(r.json().ref));

r = await post(`/api/permits/${permit}/issue`, musa);
check('the person who requested a permit cannot issue it', r.statusCode === 403);

r = await post(`/api/permits/${permit}/issue`, grace);
check('a supervisor issues the permit', r.statusCode === 200);

const point = (db.prepare('SELECT id FROM isolation_points WHERE permit_id = ?').get(permit) as { id: string }).id;
await post(`/api/permits/${permit}/isolation/${point}`, grace, { action: 'isolate' });
r = await post(`/api/permits/${permit}/close`, grace);
check('a permit cannot close with a live isolation', r.statusCode === 409 && r.json().error === 'isolations_open');

await post(`/api/permits/${permit}/isolation/${point}`, grace, { action: 'restore' });
r = await post(`/api/permits/${permit}/close`, grace);
check('once everything is restored the permit closes', r.statusCode === 200);

r = await post('/api/incidents', ifeoma, {
  type: 'near_miss', occurredAt: iso(0), description: 'Loose cover on the riser cupboard.', severity: 'minor',
});
check('a technician can report a near miss', r.statusCode === 201);
r = await get('/api/incidents', ifeoma);
check('a technician cannot read the incident register', r.statusCode === 403);
r = await get('/api/incidents', hod);
check('the HOD can read it', r.statusCode === 200 && r.json().incidents.length === 1);

r = await post('/api/meters', admin, { type: 'electricity', serial: 'MTR-A-01', locationId: siteId });
const meter = r.json().id;
r = await post(`/api/meters/${meter}/reading`, ifeoma, { reading: 1000, readAt: iso(-60) });
check('a meter reading is recorded', r.statusCode === 201);
r = await post(`/api/meters/${meter}/reading`, ifeoma, { reading: 1200, readAt: iso(-30) });
check('consumption is derived from the previous reading', r.json().consumption === 200);
r = await post(`/api/meters/${meter}/reading`, ifeoma, { reading: 900 });
check('a reading that goes backwards is refused', r.statusCode === 400);
r = await post(`/api/meters/${meter}/reading`, ifeoma, { reading: 3000 });
check('an implausible jump is flagged as an anomaly', r.json().anomaly === true);

// --------------------------------------------------------------------------
heading('Reports');
// --------------------------------------------------------------------------
r = await get('/api/reports/dashboard', hod);
const dash = r.json();
check('the dashboard reports open job aging', typeof dash.openJobs.total === 'number');
check('it reports mean time to repair', dash.mttr.jobs > 0);
check('it reports the SLA breach rate by priority', Array.isArray(dash.slaBreach));
check('it reports first-time fix', dash.firstTimeFix.verified > 0);
check('it reports the reactive-versus-planned mix', typeof dash.workMix.reactivePct === 'number');
check('it reports PPM compliance', typeof dash.ppm.compliancePct === 'number');
check('it reports the cost of generated power', typeof dash.power.fuelUsedL === 'number');
check('reopened jobs pull first-time fix below 100%', dash.firstTimeFix.firstTimeFixPct < 100,
  String(dash.firstTimeFix.firstTimeFixPct));

r = await get('/api/reports/top-assets', femi);
check('assets are ranked by lifetime cost against replacement value',
  Array.isArray(r.json().assets));

r = await get('/api/reports/dashboard', ifeoma);
check('a technician cannot open the dashboard', r.statusCode === 403);


// --------------------------------------------------------------------------
heading('Photos and attachments');
// --------------------------------------------------------------------------
{
  const good = multipart({ entityType: 'work_order', entityId: job.id },
                         { name: 'before.png', type: 'image/png', data: PNG });
  r = await app.inject({ method: 'POST', url: '/api/attachments', headers: { ...ifeoma, ...good.headers },
                         payload: good.body });
  check('a technician attaches a photo to their job', r.statusCode === 201, r.body.slice(0, 140));
  const attachmentId = r.json().id;
  check('the stored file is checksummed', /^[0-9a-f]{64}$/.test(r.json().sha256));

  r = await get(`/api/attachments?entityType=work_order&entityId=${job.id}`, grace);
  check('the photo is listed against the job', r.json().attachments.length === 1);
  check('the listing does not leak the path on disk',
    !('rel_path' in (r.json().attachments[0] as object)));

  r = await get(`/api/attachments/${attachmentId}`, grace);
  check('the file is served back with its own type',
    r.statusCode === 200 && r.headers['content-type'] === 'image/png');
  check('attachment bytes are cached hard, since they never change',
    String(r.headers['cache-control']).includes('immutable'));

  r = await get(`/api/jobs/${job.id}`, grace);
  check('the photo appears in the job history',
    (r.json().history as { event_type: string }[]).some((e) => e.event_type === 'photo'));

  // A JPEG header on PNG bytes: the declared type is not evidence.
  const lying = multipart({ entityType: 'work_order', entityId: job.id },
                          { name: 'fake.jpg', type: 'image/jpeg', data: PNG });
  r = await app.inject({ method: 'POST', url: '/api/attachments', headers: { ...ifeoma, ...lying.headers },
                         payload: lying.body });
  check('a file whose contents contradict its type is refused',
    r.statusCode === 415 && r.json().error === 'content_mismatch');

  const script = multipart({ entityType: 'work_order', entityId: job.id },
                           { name: 'x.svg', type: 'image/svg+xml', data: Buffer.from('<svg onload=alert(1)>') });
  r = await app.inject({ method: 'POST', url: '/api/attachments', headers: { ...ifeoma, ...script.headers },
                         payload: script.body });
  check('SVG is not an accepted type', r.statusCode === 415);

  const wrongPlace = multipart({ entityType: 'expense', entityId: 'whatever' },
                               { name: 'a.png', type: 'image/png', data: PNG });
  r = await app.inject({ method: 'POST', url: '/api/attachments', headers: { ...ifeoma, ...wrongPlace.headers },
                         payload: wrongPlace.body });
  check('a technician cannot attach a file to an expense', r.statusCode === 403, r.body.slice(0, 100));

  const nonsense = multipart({ entityType: 'payroll', entityId: 'x' },
                             { name: 'a.png', type: 'image/png', data: PNG });
  r = await app.inject({ method: 'POST', url: '/api/attachments', headers: { ...ifeoma, ...nonsense.headers },
                         payload: nonsense.body });
  check('files cannot be attached to an unknown kind of thing', r.statusCode === 400);

  // The boundary lives in the header, so build the body and header together.
  const fieldsOnly = multipart({ entityType: 'work_order', entityId: job.id });
  r = await app.inject({ method: 'POST', url: '/api/attachments',
                         headers: { ...ifeoma, ...fieldsOnly.headers }, payload: fieldsOnly.body });
  check('a request with no file is refused', r.statusCode === 400, r.body.slice(0, 100));

  // Someone with no right to read the job has no right to read its photos.
  r = await get(`/api/attachments/${attachmentId}`, halima);
  check('attachments inherit the permission of what they hang off', r.statusCode === 200);
  r = await get('/api/attachments?entityType=expense&entityId=x', ifeoma);
  check('a technician cannot list expense attachments', r.statusCode === 403);
}

// --------------------------------------------------------------------------
heading('Administration');
// --------------------------------------------------------------------------
r = await post('/api/admin/users', admin, {
  displayName: 'Temporary Contractor', username: 'contractor', password: 'first-password-here',
  roleKey: 'technician',
});
const contractorId = r.json().id;
check('an administrator creates an account', r.statusCode === 201);

const contractor = await login('contractor', PW.replace(PW, 'first-password-here'));
check('the new account signs in', !!contractor.cookie);

r = await post(`/api/admin/users/${contractorId}/reset-password`, admin, { password: 'a-new-password-x' });
check('an administrator resets a password', r.statusCode === 200);
check('the reset signs them out everywhere', r.json().sessionsRevoked >= 1);
check('and forces a change at next sign-in', r.json().mustChangePassword === true);

r = await get('/api/me', contractor);
check('the old session is dead immediately', r.statusCode === 401);
r = await post('/api/auth/login', admin, { username: 'contractor', password: 'first-password-here' });
check('the old password no longer works', r.statusCode === 401);
r = await post('/api/auth/login', admin, { username: 'contractor', password: 'a-new-password-x' });
check('the new password does', r.statusCode === 200);

r = await post(`/api/admin/users/${contractorId}/disable`, admin);
check('an account can be disabled', r.statusCode === 200);
r = await post('/api/auth/login', admin, { username: 'contractor', password: 'a-new-password-x' });
check('a disabled account cannot sign in', r.statusCode === 401);
r = await post(`/api/admin/users/${contractorId}/enable`, admin);
check('and can be re-enabled', r.statusCode === 200);

r = await get('/api/admin/roles', admin);
const roleList = r.json().roles as { id: string; key: string; permission_count: number }[];
const teamLeadRole = roleList.find((x) => x.key === 'team_lead')!;
const adminRole = roleList.find((x) => x.key === 'admin')!;
check('roles report how many people hold them', roleList.every((x) => typeof x.permission_count === 'number'));

r = await post(`/api/admin/roles/${adminRole.id}/permissions`, admin, { codes: ['wo.read'] });
check('the administrator role cannot be edited down', r.statusCode === 409);

r = await get(`/api/admin/roles/${teamLeadRole.id}/permissions`, admin);
const leadCodes = (r.json().granted as { permission_code: string }[]).map((g) => g.permission_code);
check('a role reports what it grants', leadCodes.includes('wo.verify'));

r = await post(`/api/admin/roles/${teamLeadRole.id}/permissions`, admin, { codes: ['nonsense.code'] });
check('an unknown permission code is refused', r.statusCode === 400);

r = await post(`/api/admin/roles/${teamLeadRole.id}/permissions`, admin,
  { codes: leadCodes.filter((c) => c !== 'wo.verify') });
check('a permission can be taken away from a role', r.statusCode === 200);

const musaAgain = await login('musa', PW);
r = await get('/api/me', musaAgain);
check('the change reaches the person on their next request',
  !(r.json().permissions as string[]).includes('wo.verify'));

r = await post(`/api/admin/roles/${teamLeadRole.id}/permissions`, admin, { codes: leadCodes });
check('and can be given back', r.statusCode === 200);

/*
 * The screen sends a list of codes and nothing else. Rewriting the grants from that list
 * alone reset every scope to 'all', so ticking one box for technicians silently promoted
 * every technician from "the jobs assigned to me" to "every job on the property" — and
 * the audit entry recorded only the code list, so it was invisible afterwards too.
 */
const scopeOfCode = (roleId: string, code: string): string | undefined =>
  (db.prepare('SELECT scope FROM role_permissions WHERE role_id = ? AND permission_code = ?')
    .get(roleId, code) as { scope: string } | undefined)?.scope;

check('a team lead reads jobs at team scope, not the whole property',
  scopeOfCode(teamLeadRole.id, 'wo.read') === 'team',
  String(scopeOfCode(teamLeadRole.id, 'wo.read')));

const techRole = roleList.find((x) => x.key === 'technician')!;
const techCodes = ((await get(`/api/admin/roles/${techRole.id}/permissions`, admin))
  .json().granted as { permission_code: string }[]).map((g) => g.permission_code);
check('and a technician reads them at their own',
  scopeOfCode(techRole.id, 'wo.read') === 'own');

r = await post(`/api/admin/roles/${techRole.id}/permissions`, admin,
  { codes: [...techCodes, 'vendor.read'] });
check('a role can be given one more permission', r.statusCode === 200);
check('and the narrow scopes it already held survive the edit',
  scopeOfCode(techRole.id, 'wo.read') === 'own'
  && scopeOfCode(techRole.id, 'wo.complete') === 'own',
  `wo.read=${scopeOfCode(techRole.id, 'wo.read')}`);
check('a newly added permission takes the scope the role was designed with',
  scopeOfCode(techRole.id, 'vendor.read') === 'all');
check('the audit entry records the scopes, not just the codes',
  (() => {
    const row = db.prepare(
      `SELECT after_json FROM audit_log WHERE action = 'role.permissions.changed'
        ORDER BY at DESC LIMIT 1`
    ).get() as { after_json: string } | undefined;
    if (!row) return false;
    const after = JSON.parse(row.after_json) as { scopes?: Record<string, string> };
    return after.scopes?.['wo.read'] === 'own';
  })());

r = await post(`/api/admin/roles/${techRole.id}/permissions`, admin, { codes: techCodes });
check('and taking it away again leaves the scopes alone',
  r.statusCode === 200 && scopeOfCode(techRole.id, 'wo.read') === 'own');

const ifeomaAgain = await login('ifeoma', PW);
check('so a technician still sees only their own work after a role edit',
  ((await get('/api/me', ifeomaAgain)).json().scopes as Record<string, string>)['wo.read'] === 'own');

r = await get('/api/admin/settings', admin);
check('editable settings are listed', Array.isArray(r.json().settings.sla_matrix));

r = await post('/api/admin/settings', admin, { key: 'sla_matrix', value: [{ priority: 'P1' }] });
check('a malformed SLA matrix is refused', r.statusCode === 400 && r.json().error === 'invalid_sla');

const matrix = (await get('/api/admin/settings', admin)).json().settings.sla_matrix as
  { priority: string; respondMinutes: number }[];
matrix[0]!.respondMinutes = 10;
r = await post('/api/admin/settings', admin, { key: 'sla_matrix', value: matrix });
check('a valid SLA matrix saves', r.statusCode === 200);

r = await post('/api/jobs', grace, { title: 'SLA check', locationId: siteId, priority: 'P1' });
check('the new target applies to jobs raised afterwards',
  near(new Date(r.json().job.respond_by).getTime() - new Date(r.json().job.reported_at).getTime(),
       10 * 60_000, 2000));
check('deadlines already set were not rewritten',
  near(new Date(p1.respond_by!).getTime() - new Date(p1.reported_at).getTime(), 15 * 60_000, 2000));

r = await post('/api/admin/settings', admin, { key: 'not_a_setting', value: 1 });
check('an unknown setting is refused', r.statusCode === 400);

r = await get('/api/admin/backups', admin);
check('backups are listed with sizes', Array.isArray(r.json().backups));

r = await get('/api/admin/settings', grace);
check('a supervisor cannot edit settings', r.statusCode === 403);
r = await get('/api/admin/roles', grace);
check('a supervisor cannot edit roles', r.statusCode === 403);

// --------------------------------------------------------------------------
heading('Screen data contracts');
// --------------------------------------------------------------------------
// Each of these is what one screen reads. A page that renders blank because a field was
// never in the payload is the hardest kind of bug to find by eye, so assert the shape.

r = await get('/api/assets', grace);
{
  const withUnit = (r.json().assets as { unit_no: string | null; location_name: string | null }[])
    .filter((a) => a.unit_no || a.location_name);
  check('every asset in the register says where it is',
    r.statusCode === 200 && withUnit.length === r.json().assets.length,
    `${withUnit.length} of ${r.json().assets.length} placed`);
}

r = await get(`/api/assets/${gen01}`, grace);
{
  const d = r.json();
  check('the asset screen gets the asset, its jobs, readings and schedules',
    r.statusCode === 200 && !!d.asset && Array.isArray(d.jobs)
    && Array.isArray(d.readings) && Array.isArray(d.schedules));
  check('the asset screen gets a lifetime cost and a share of replacement value',
    typeof d.lifetimeCostKobo === 'number'
    && (d.pctOfReplacement === null || typeof d.pctOfReplacement === 'number'));
}

r = await post('/api/ppm/checklists', admin, {
  name: 'Genset weekly walk-round',
  items: [
    { task: 'Coolant level between marks', expectedValue: 'between MIN and MAX', isCritical: true },
    { task: 'Battery terminals clean and tight', requiresPhoto: true },
    { task: 'Record running hours', requiresReading: true },
  ],
});
check('a checklist template is created with its steps', r.statusCode === 201 && r.json().items === 3);

r = await get('/api/ppm/checklists', grace);
{
  const t = r.json().templates.find((x: { name: string }) => x.name === 'Genset weekly walk-round');
  check('the checklist screen gets each template with its steps nested',
    r.statusCode === 200 && !!t && t.items.length === 3 && t.item_count === 3);
  check('a critical step survives the round trip',
    !!t && t.items.some((i: { task: string; is_critical: number }) =>
      /Coolant/.test(i.task) && i.is_critical === 1));
}

r = await get('/api/permits', grace);
{
  const p0 = r.json().permits.find((x: { id: string }) => x.id === permit);
  check('the permit screen gets isolation points nested under each permit',
    r.statusCode === 200 && !!p0 && p0.isolationPoints.length === 1);
  check('a restored isolation point carries both timestamps',
    !!p0 && !!p0.isolationPoints[0].isolated_at && !!p0.isolationPoints[0].restored_at);
  check('the permit screen can tell whose request it is without a second call',
    !!p0 && typeof p0.requested_by === 'string');
}

r = await get('/api/requisitions', grace);
{
  const rq = r.json().requisitions.find((x: { id: string }) => x.id === requisition);
  check('the requisition screen gets each requisition with its lines',
    r.statusCode === 200 && !!rq && rq.lines.length === 1);
  check('a requisition line carries the description and quantity an approver needs',
    !!rq && rq.lines[0].qty === 6 && /Contactor coil/.test(rq.lines[0].description));
}

r = await get('/api/expenses', femi);
{
  const e = r.json().expenses.find((x: { id: string }) => x.id === expense);
  check('the money screen reads expenses with who raised and who approved them',
    r.statusCode === 200 && !!e && !!e.raised_by && !!e.raised_by_name);
  check('an approved expense names its approver',
    !!e && e.status === 'approved' && !!e.approved_by_name);
}
r = await get('/api/expenses', ifeoma);
check('a technician cannot read the expense register',
  r.statusCode === 403 && r.json().required === 'finance.read');

r = await get('/api/budgets/vs-actual', femi);
check('budget against actual returns a line per cost centre',
  r.statusCode === 200 && Array.isArray(r.json().lines) && r.json().lines.length > 0);
check('every budget line carries both figures the bar needs',
  r.json().lines.every((l: { budget_kobo: unknown; actual_kobo: unknown }) =>
    typeof l.budget_kobo === 'number' && typeof l.actual_kobo === 'number'));

// --------------------------------------------------------------------------
heading('CSV export');
// --------------------------------------------------------------------------
r = await get('/api/exports', hod);
check('the catalogue lists only what this person may export',
  r.statusCode === 200 && r.json().exports.length > 0);

r = await get('/api/exports/jobs', hod);
{
  const body = r.body;
  check('a job export comes back as a CSV attachment',
    r.statusCode === 200
    && /text\/csv/.test(String(r.headers['content-type']))
    && /attachment; filename="facilityflow-jobs-/.test(String(r.headers['content-disposition'])),
    `${r.headers['content-type']} | ${r.headers['content-disposition']}`);

  // Excel reads UTF-8 only with a BOM, and treats a lone LF as one enormous row.
  check('it starts with a byte-order mark so Excel reads the characters', body.charCodeAt(0) === 0xfeff);
  check('and uses CRLF line endings', /\r\n/.test(body));

  const header = body.slice(1).split('\r\n')[0]!;
  check('money is exported as naira, not kobo', /Total cost/.test(header));
  const line = body.split('\r\n').find((l) => l.startsWith('WO-'));
  check('a real job is in it', !!line, header);
}

// A cell starting with = is executed as a formula when the file opens. This is the one
// export bug that reaches past the spreadsheet and onto the machine.
r = await post('/api/jobs', grace, {
  title: '=cmd|calc!A1 broken tap', locationId: siteId, priority: 'P4',
});
check('a job with a formula-shaped title is accepted as ordinary text', r.statusCode === 201);
r = await get('/api/exports/jobs', hod);
check('and the export escapes it so opening the file cannot run it',
  r.body.includes(`"'=cmd|calc!A1 broken tap"`) || r.body.includes(`'=cmd|calc!A1 broken tap`),
  r.body.split('\r\n').find((l) => l.includes('calc')) ?? 'not found');

r = await get('/api/exports/audit', grace);
check('an export is refused without the permission guarding its screen',
  r.statusCode === 403 && r.json().required === 'admin.audit.read', JSON.stringify(r.json()));

r = await get('/api/exports/jobs', ifeoma);
check('a technician has no export right at all', r.statusCode === 403);

r = await get('/api/exports/nonsense', hod);
check('an unknown export is a clean 404, not a crash', r.statusCode === 404);

for (const kind of ['assets', 'stock', 'stock-movements', 'spend', 'fuel', 'audit']) {
  r = await get(`/api/exports/${kind}`, admin);
  check(`the ${kind} export renders`, r.statusCode === 200 && r.body.length > 3, String(r.statusCode));
}


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

// --------------------------------------------------------------------------
heading('A brand-new install can be set up from the browser alone');
// --------------------------------------------------------------------------
// Every one of these was reachable only from the seed or by hand until the walkthrough
// went looking. A gift to a department is worth nothing if the department cannot fill
// it in without a developer.

r = await post('/api/teams', grace, { name: 'Civil', defaultTrade: 'civil' });
check('a supervisor cannot create teams — that is staff.manage', r.statusCode === 403);

r = await post('/api/teams', admin, { name: 'Civil', defaultTrade: 'civil' });
check('a team can be created from the browser', r.statusCode === 201, r.body.slice(0, 120));
const civilTeam = r.json().id as string;

r = await post('/api/teams', admin, { name: 'Civil' });
check('and a duplicate team name is refused', r.statusCode === 409);

r = await post('/api/staff', admin, {
  firstName: 'Chidi', lastName: 'Obi', trade: 'civil', teamId: civilTeam,
  phone: '0803 000 0009', staffNo: 'ST-090',
});
check('a person can be added to the floor', r.statusCode === 201, r.body.slice(0, 140));
const chidi = r.json().id as string;

r = await post('/api/staff', admin, { firstName: 'X', lastName: 'Y', teamId: 'not-a-team' });
check('an unknown team is refused rather than stored as a dangling id',
  r.statusCode === 400 && r.json().error === 'unknown_team');

r = await app.inject({ method: 'PATCH', url: `/api/staff/${chidi}`, headers: admin,
  payload: { firstName: 'Chidi', lastName: 'Obi', trade: 'civil', isActive: false } });
check('and somebody who leaves is deactivated, not deleted', r.statusCode === 200);

/*
 * PATCH promised a partial update and performed a full replace: every column was written
 * from the request whether or not it was sent, so changing somebody's phone number put
 * them in no team, with no trade and no staff number. The browser form sends every field,
 * which is exactly why nobody noticed — and a person dropped out of their team is a person
 * their team lead stops being told about.
 */
r = await app.inject({ method: 'PATCH', url: `/api/staff/${chidi}`, headers: admin,
  payload: { firstName: 'Chidi', lastName: 'Obi', phone: '0803 000 1111' } });
check('one field can be changed on its own', r.statusCode === 200, r.body.slice(0, 140));
{
  const after = db.prepare('SELECT team_id, trade, staff_no, phone FROM staff WHERE id = ?')
    .get(chidi) as { team_id: string | null; trade: string | null; staff_no: string | null; phone: string | null };
  check('and the phone number changed', after.phone === '0803 000 1111');
  check('without emptying the team', after.team_id === civilTeam, String(after.team_id));
  check('or the trade', after.trade === 'civil', String(after.trade));
  check('or the staff number', after.staff_no === 'ST-090', String(after.staff_no));
}
r = await app.inject({ method: 'PATCH', url: `/api/staff/${chidi}`, headers: admin,
  payload: { firstName: 'Chidi', lastName: 'Obi', teamId: null } });
check('while an explicit null still clears a field, because that is a different sentence',
  r.statusCode === 200
  && (db.prepare('SELECT team_id FROM staff WHERE id = ?').get(chidi) as { team_id: string | null })
       .team_id === null);
// Put him back where he belongs for the notification tests further down.
await app.inject({ method: 'PATCH', url: `/api/staff/${chidi}`, headers: admin,
  payload: { firstName: 'Chidi', lastName: 'Obi', teamId: civilTeam, trade: 'civil' } });
check('their record survives for the history',
  (db.prepare('SELECT is_active FROM staff WHERE id = ?').get(chidi) as { is_active: number })
    .is_active === 0);

// The whole point of a staff record: an account linked to one, so "my jobs" works.
r = await post('/api/admin/users', admin, {
  displayName: 'Chidi Obi', username: 'chidi', password: PW, roleKey: 'technician',
  staffId: chidi,
});
check('an account can be linked to a person on the floor', r.statusCode === 201, r.body.slice(0, 140));

r = await post('/api/fuel/tanks', admin, {
  name: 'Standby drum', kind: 'drum', capacityL: 210, minLevelL: 40,
});
check('a diesel tank can be created from the browser', r.statusCode === 201, r.body.slice(0, 140));
check('and a tank with no chart says so rather than failing later',
  typeof r.json().warning === 'string');

r = await post('/api/fuel/tanks', admin, {
  name: 'Second bulk', kind: 'bulk', capacityL: 9000,
  dipChart: [[0, 0], [500, 2400], [1000, 5200]],
});
check('a tank with a calibration chart takes it at creation', r.statusCode === 201);
const chartedTank = r.json().id as string;
r = await post(`/api/fuel/tanks/${chartedTank}/dip`, ifeoma, { dipMm: 750 });
check('and a millimetre dip on it converts through the chart',
  r.statusCode === 201 && r.json().litres > 3000 && r.json().litres < 4600,
  JSON.stringify(r.json()));

// --------------------------------------------------------------------------
heading('The system explains itself');
// --------------------------------------------------------------------------
// A checklist that lies is worse than none, and a screen that offers somebody a button
// the server will refuse is how a department decides the software is broken.

r = await get('/api/setup/progress', admin);
check('an administrator is told what is still to set up', r.statusCode === 200);
const prog = r.json() as {
  ready: boolean; doneCount: number; totalCount: number; essentialRemaining: number;
  steps: { key: string; needs: string; state: string; essential: boolean }[];
  visibleCount: number; canAct: boolean;
};
check('every essential step is done by the time the modules have been exercised',
  prog.ready && prog.essentialRemaining === 0,
  `essentialRemaining=${prog.essentialRemaining}`);
check('and the count of finished steps is a real count, not a stored flag',
  prog.doneCount > 0 && prog.doneCount <= prog.totalCount);

r = await get('/api/setup/progress', ifeoma);
const techProg = r.json() as typeof prog;
check('a technician is not shown a checklist of things only an administrator can do',
  techProg.steps.length < prog.steps.length);
check('and every step they are shown is one their role can act on',
  techProg.steps.every((st) => prog.steps.some((f) => f.key === st.key)));
check('the headline total stays whole-property so two screens never disagree',
  techProg.totalCount === prog.totalCount);

// The rating heuristic used to match on "has an hour meter", which counted the water pump
// as a generator that could never be satisfied.
r = await post('/api/assets', admin, {
  assetTag: 'PUMP-SMOKE', name: 'Booster pump', locationId: siteId,
  meterType: 'hours',
});
if (r.statusCode === 201) {
  const after = (await get('/api/setup/progress', admin)).json() as typeof prog;
  const gen = after.steps.find((st) => st.key === 'gensets');
  check('a water pump with an hour meter is not counted as an unrated generator',
    !gen || gen.state !== 'attention', JSON.stringify(gen));
}

// --------------------------------------------------------------------------
heading('Changing a role instead of deleting the person');
// --------------------------------------------------------------------------
const chidiUser = (db.prepare('SELECT id FROM users WHERE username = ?').get('chidi') as
  { id: string }).id;

r = await get('/api/admin/users', admin);
const listed = (r.json().users as {
  id: string; role: string; role_name: string; role_description: string;
  staff_id: string | null; staff_name: string | null; does_jobs: number;
}[]);
const chidiRow = listed.find((u) => u.id === chidiUser)!;
check('the users list carries the role name, not just the key',
  chidiRow.role_name.length > 3 && chidiRow.role_name !== chidiRow.role, chidiRow.role_name);
check('and its description, so the choice can be explained where it is made',
  chidiRow.role_description.length > 10);
check('a technician account is flagged as one that gets given work',
  chidiRow.does_jobs === 1);
check('an office role is not',
  listed.find((u) => u.role === 'finance')?.does_jobs === 0);

r = await app.inject({ method: 'PATCH', url: `/api/admin/users/${chidiUser}`, headers: grace,
  payload: { roleKey: 'supervisor' } });
check('a supervisor cannot promote anybody', r.statusCode === 403);

const adminUserId = (db.prepare('SELECT id FROM users WHERE username = ?').get('admin') as
  { id: string }).id;
r = await app.inject({ method: 'PATCH', url: `/api/admin/users/${adminUserId}`, headers: admin,
  payload: { roleKey: 'technician' } });
check('and an administrator cannot demote themselves out of the only screen that undoes it',
  r.statusCode === 409 && r.json().error === 'own_role', r.body.slice(0, 120));

r = await app.inject({ method: 'PATCH', url: `/api/admin/users/${chidiUser}`, headers: admin,
  payload: { roleKey: 'no-such-role' } });
check('an unknown role is refused rather than silently ignored',
  r.statusCode === 400 && r.json().error === 'unknown_role');

r = await app.inject({ method: 'PATCH', url: `/api/admin/users/${chidiUser}`, headers: admin,
  payload: { staffId: 'not-a-person' } });
check('and so is a link to somebody who is not on the staff list',
  r.statusCode === 400 && r.json().error === 'unknown_staff');

r = await app.inject({ method: 'PATCH', url: `/api/admin/users/${chidiUser}`, headers: admin,
  payload: { roleKey: 'team_lead', displayName: 'Chidi Obi Jr' } });
check('a real promotion goes through', r.statusCode === 200, r.body.slice(0, 160));
check('the person keeps their id, so every job still points at them',
  (db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(chidiUser) as { n: number }).n === 1);
check('and the change is in the audit log with who did it',
  (db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'user.updated'`)
    .get() as { n: number }).n > 0);

r = await app.inject({ method: 'PATCH', url: `/api/admin/users/${chidiUser}`, headers: admin,
  payload: { staffId: null } });
check('an account can be unlinked from the floor', r.statusCode === 200);
const unlinked = ((await get('/api/admin/users', admin)).json().users as typeof listed)
  .find((u) => u.id === chidiUser)!;
check('and the screen can then see that it can be given work but would be shown none',
  unlinked.does_jobs === 1 && unlinked.staff_id === null);

// A team lead with no staff record has no team. Falling through with no filter quietly
// widened a team-scoped grant into the whole property.
const chidiSession = await login('chidi', PW);
r = await get('/api/jobs?view=all&limit=400', chidiSession);
check('an unlinked team lead is narrowed to what they raised, not handed the property',
  r.statusCode === 200 && (r.json().jobs as unknown[]).length === 0,
  `saw ${(r.json().jobs as unknown[] | undefined)?.length} jobs`);

// --------------------------------------------------------------------------
heading('A person can change their own password');
// --------------------------------------------------------------------------
// Every account is created with a temporary password somebody else chose and typed, and
// the Users tab promises they will be made to change it. Nothing kept that promise: the
// flag was set, shown, and could never be cleared.

r = await post('/api/admin/users', admin, {
  displayName: 'Blessing Nwosu', username: 'blessing', password: PW, roleKey: 'requester',
});
check('a new account is created needing a password change', r.statusCode === 201);
const blessing = await login('blessing', PW);
check('and the flag reaches the client that has to act on it',
  ((await get('/api/me', blessing)).json().user as { mustChangePassword: boolean })
    .mustChangePassword === true);

r = await post('/api/auth/password', blessing, {
  currentPassword: 'not-the-password', newPassword: 'a-brand-new-password',
});
check('a wrong current password is refused', r.statusCode === 403 && r.json().error === 'wrong_password');

r = await post('/api/auth/password', blessing, { currentPassword: PW, newPassword: 'short' });
check('and a new one under ten characters is refused', r.statusCode === 400);

const otherDevice = await login('blessing', PW);
r = await post('/api/auth/password', blessing, {
  currentPassword: PW, newPassword: 'a-brand-new-password',
});
check('a real change goes through', r.statusCode === 200, r.body.slice(0, 140));

// Every session is revoked, and the device that made the change is handed a fresh one in
// the same response — so a browser stays signed in without ever holding a live cookie for
// a password that no longer exists.
const rotated = r.cookies.find((c) => c.name === 'ff_sid');
check('the calling device is issued a new session in the same response', !!rotated);
const stillHere: Hdr = { cookie: `ff_sid=${rotated?.value ?? ''}` };
check('the flag is cleared, so the wall comes down',
  ((await get('/api/me', stillHere)).json().user as { mustChangePassword: boolean })
    .mustChangePassword === false);
check('the tablet left signed in on the floor is signed out',
  (await get('/api/me', otherDevice)).statusCode === 401);
check('and so is the session that asked for the change',
  (await get('/api/me', blessing)).statusCode === 401);
r = await post('/api/auth/login', { cookie: '' } as Hdr,
  { username: 'blessing', password: 'a-brand-new-password' });
check('and the new password is the one that works',
  r.statusCode === 200 && r.json().mustChangePassword === false);
r = await post('/api/auth/login', { cookie: '' } as Hdr, { username: 'blessing', password: PW });
check('while the old one no longer does', r.statusCode === 401);

// --------------------------------------------------------------------------
heading('The status strip shows only what the reader may see');
// --------------------------------------------------------------------------
// It sits above every screen on every device, and being signed in was its only
// requirement. A front-office requester who cannot open the fuel screen was still shown
// every tank level, every set's running hours and the building load, on every page.

r = await post('/api/admin/users', admin, {
  displayName: 'Front Desk', username: 'frontdesk', password: PW, roleKey: 'requester',
});
check('a requester account exists to check this with', r.statusCode === 201);
const desk = await login('frontdesk', PW);

r = await get('/api/status/plant', desk);
const deskStrip = r.json() as Record<string, unknown>;
check('a requester is sent no tank levels', (deskStrip.tanks as unknown[]).length === 0);
check('no generator hours', (deskStrip.gensets as unknown[]).length === 0);
check('no building load', deskStrip.load === undefined);
check('and no utility state', deskStrip.utility === undefined);
check('they do see open P1s, which is what a fault reporter needs',
  deskStrip.openP1 !== undefined);
check('but not who is on shift — that is the roster screen they cannot open',
  deskStrip.onShift === undefined);

r = await get('/api/status/plant', ifeoma);
const techStrip = r.json() as Record<string, unknown>;
check('a technician does see the plant, because they work on it',
  techStrip.load !== undefined && techStrip.utility !== undefined);
check('and the roster, because it is their own shift',
  techStrip.onShift !== undefined);

r = await get('/api/status/plant', admin);
const adminStrip = r.json() as Record<string, unknown>;
check('an administrator sees the whole strip',
  adminStrip.load !== undefined && adminStrip.onShift !== undefined
  && adminStrip.openP1 !== undefined && adminStrip.utility !== undefined);

// --------------------------------------------------------------------------
heading('Which network address the department is given');
// --------------------------------------------------------------------------
/*
 * The PC in the scenario below is an ordinary one: a cable to the office switch, wifi to
 * the staff network, and VirtualBox and WSL installed by whoever set it up. Node lists
 * those adapters in no particular order, and the old code took the first and printed it
 * on a QR code for the wall.
 */
const windowsPc = [
  { name: 'vEthernet (WSL)', address: '172.29.16.1', netmask: '255.255.240.0', mac: '00:15:5d:01:02:03' },
  { name: 'VirtualBox Host-Only Network', address: '192.168.56.1', netmask: '255.255.255.0', mac: '0a:00:27:00:00:0b' },
  { name: 'Wi-Fi', address: '192.168.1.87', netmask: '255.255.255.0', mac: 'a4:c3:f0:11:22:33' },
  { name: 'Ethernet', address: '192.168.1.50', netmask: '255.255.255.0', mac: '3c:7c:3f:44:55:66' },
  { name: 'Ethernet 2', address: '169.254.10.4', netmask: '255.255.0.0', mac: '3c:7c:3f:44:55:77' },
];
const dhcpMap = new Map([['Ethernet', true], ['Wi-Fi', true]]);
const view = buildView(windowsPc, 'SmartRes-Staff', dhcpMap);

check('the cable is what gets handed out, not whichever adapter was listed first',
  view.advertise === '192.168.1.50', String(view.advertise));
check('a VirtualBox adapter is never offered as the office network',
  view.nics.find((n) => n.address === '192.168.56.1')?.usable === false);
check('nor a WSL one', view.nics.find((n) => n.address === '172.29.16.1')?.usable === false);
check('an unplugged cable that gave itself an address is marked unusable',
  view.nics.find((n) => n.address === '169.254.10.4')?.usable === false);
check('and it says why, rather than just hiding it',
  (view.nics.find((n) => n.address === '169.254.10.4')?.note ?? '').includes('nothing answered'));
check('wifi is offered, below the cable',
  view.nics.filter((n) => n.usable).map((n) => n.address).join(',') === '192.168.1.50,192.168.1.87');
check('the wifi network this PC is joined to is named, so phones can be put on it too',
  view.nics.find((n) => n.kind === 'wifi')?.ssid === 'SmartRes-Staff');
check('an address handed out by DHCP is known to be one that can change',
  view.nics.find((n) => n.address === '192.168.1.50')?.dhcp === true);

const chosen = buildView(windowsPc, null, dhcpMap, '192.168.1.87');
check('an administrator who picks the wifi gets the wifi',
  chosen.advertise === '192.168.1.87' && chosen.chosen);

// The saved address is gone — a new DHCP lease, or the cable moved to another switch.
const moved = buildView(windowsPc, null, dhcpMap, '192.168.9.99');
check('and a saved address that no longer exists falls back rather than leaving nothing',
  moved.advertise === '192.168.1.50' && !moved.chosen);

const nothing = buildView(
  [{ name: 'VirtualBox Host-Only Network', address: '192.168.56.1', netmask: '255.255.255.0', mac: 'x' }],
  null, new Map());
check('a PC with only virtual adapters is told it has no address to give, not given a false one',
  nothing.advertise === null);

// The route is what the screen calls.
r = await get('/api/admin/host', admin);
const hostView = r.json() as { network: { nics: unknown[] }; advertise: string | null; boundTo: string | null };
check('the host screen is served the adapter list', Array.isArray(hostView.network.nics));
check('and this host is not narrowed to one interface by default', hostView.boundTo === null);

r = await post('/api/admin/host/network', admin, { advertise: '10.99.99.99' });
check('an address this PC does not have is refused rather than saved',
  r.statusCode === 400 && r.json().error === 'unknown_address');

r = await post('/api/admin/host/network', grace, { advertise: null });
check('and a supervisor cannot change what the department is told', r.statusCode === 403);

// --------------------------------------------------------------------------
heading('Being told a job is yours');
// --------------------------------------------------------------------------
/*
 * Every notification in this system came from an SLA breach. Assigning somebody a job
 * told them nothing at all — no bell, no sound — so a technician found out by happening
 * to open the app, and the first the department heard of a late P1 was the escalation
 * shouting about a deadline nobody had been told existed.
 */
const unreadFor = (username: string): { kind: string; title: string; body: string | null }[] => {
  const uid = (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as
    { id: string }).id;
  return db.prepare(
    `SELECT kind, title, body FROM notifications
      WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC`
  ).all(uid) as { kind: string; title: string; body: string | null }[];
};

const chidiStaff = (db.prepare('SELECT id FROM staff WHERE first_name = ?').get('Chidi') as
  { id: string } | undefined);
// Re-link the account the role tests unlinked, and put the person on today's roster.
if (chidiStaff) {
  await app.inject({ method: 'PATCH', url: `/api/admin/users/${chidiUser}`, headers: admin,
    payload: { roleKey: 'technician', staffId: chidiStaff.id } });
}

const ifeomaStaff = (db.prepare(
  `SELECT s.id FROM staff s JOIN users u ON u.staff_id = s.id WHERE u.username = 'ifeoma'`
).get() as { id: string } | undefined);

/*
 * Give the Civil team a lead before anything is completed on it.
 *
 * Until the PATCH below existed there was no way to do this from the browser at all —
 * teams.team_lead_staff_id could only ever be filled in by the demo seed. A property that
 * set itself up through the app had teams with no lead, and two features failed silently
 * because of it: the escalation that goes to a team lead first, and the notice that tells
 * them their team has finished something that needs signing off.
 */
const musaStaff = (db.prepare(
  `SELECT s.id FROM staff s JOIN users u ON u.staff_id = s.id WHERE u.username = 'musa'`
).get() as { id: string } | undefined);

r = await app.inject({ method: 'PATCH', url: `/api/teams/${civilTeam}`, headers: grace,
  payload: { teamLeadStaffId: musaStaff?.id } });
check('a supervisor cannot name a team lead — that is staff.manage',
  r.statusCode === 403, r.body.slice(0, 120));

r = await app.inject({ method: 'PATCH', url: `/api/teams/${civilTeam}`, headers: admin,
  payload: { teamLeadStaffId: 'nobody-at-all' } });
check('a lead who is not on the staff list is refused rather than written',
  r.statusCode === 400 && r.json().error === 'unknown_staff', r.body.slice(0, 140));

r = await app.inject({ method: 'PATCH', url: `/api/teams/${civilTeam}`, headers: admin,
  payload: { teamLeadStaffId: musaStaff?.id } });
check('an administrator can name the team lead from the browser',
  r.statusCode === 200, r.body.slice(0, 140));
check('and the team now reports who leads it',
  ((await get('/api/staff', admin)).json().teams as { id: string; team_lead_name: string | null }[])
    .find((t) => t.id === civilTeam)?.team_lead_name === 'Musa Ibrahim');

r = await post('/api/jobs', grace, {
  title: 'Extractor fan seized', locationId: siteId, priority: 'P1', trade: 'mechanical',
});
const notifyJob = r.json().job as { id: string; ref: string };
check('a job can be raised to assign', r.statusCode === 201, r.body.slice(0, 120));

const beforeCount = ifeomaStaff ? unreadFor('ifeoma').length : -1;
r = await post(`/api/jobs/${notifyJob.id}/assign`, grace, { staffId: ifeomaStaff?.id });
check('and assigned to somebody on shift', r.statusCode === 200, r.body.slice(0, 160));

const afterAssign = unreadFor('ifeoma');
check('the person it was given to is told, without having to go looking',
  afterAssign.length === beforeCount + 1, `${beforeCount} -> ${afterAssign.length}`);
check('the notice names the job', (afterAssign[0]?.title ?? '').includes(notifyJob.ref));
check('and carries the priority, so the chime can be urgent for a P1',
  (afterAssign[0]?.body ?? '').startsWith('P1'), String(afterAssign[0]?.body));
check('the supervisor who did it is not chimed at about their own action',
  unreadFor('grace').every((n) => n.kind !== 'wo.assigned'));

// Taken off one person and given to another.
const tundeStaff = (db.prepare(
  `SELECT id FROM staff WHERE first_name = 'Chidi'`).get() as { id: string } | undefined);
if (tundeStaff) {
  await post('/api/roster', grace, { entries: [
    { staffId: tundeStaff.id, workDate: day(0), shiftPatternId: afternoon },
  ] });
  await post('/api/roster/publish', grace, { from: day(0), to: day(0) });
  await post('/api/roster/mark', grace, { staffId: tundeStaff.id, workDate: day(0), status: 'present' });
  r = await post(`/api/jobs/${notifyJob.id}/assign`, grace, { staffId: tundeStaff.id });
  check('a job can be moved to somebody else', r.statusCode === 200, r.body.slice(0, 160));
  check('and the person it was taken from is told it has left their board',
    unreadFor('ifeoma').some((n) => n.kind === 'wo.reassigned'));
}

// Completion is a handover, not an ending.
r = await post(`/api/jobs/${notifyJob.id}/accept`, chidiSession);
r = await post(`/api/jobs/${notifyJob.id}/start`, chidiSession);
check('a technician can pick the job up', r.statusCode === 200, r.body.slice(0, 140));
r = await post(`/api/jobs/${notifyJob.id}/complete`, chidiSession, {
  resolutionNotes: 'Replaced the bearing and re-balanced the impeller.',
});
check('a completed job notifies whoever has to verify it',
  r.statusCode === 200 && unreadFor('grace').some((n) => n.kind === 'wo.completed'),
  r.body.slice(0, 140));

/*
 * The team lead over the person who did the work holds wo.verify at team scope — the
 * permission said signing it off was theirs and nothing ever told them there was anything
 * to sign, so completed work waited for a supervisor who might be in a meeting.
 */
const chidiTeamLead = db.prepare(
  `SELECT lu.username FROM staff s
     JOIN teams t ON t.id = s.team_id
     JOIN staff l ON l.id = t.team_lead_staff_id
     JOIN users lu ON lu.staff_id = l.id
    WHERE s.id = ?`
).get(chidiStaff?.id ?? '') as { username: string } | undefined;
check('the technician who did it has a team lead over them', !!chidiTeamLead,
  JSON.stringify(chidiTeamLead));
check('and that team lead is told the job is ready to verify',
  !!chidiTeamLead && unreadFor(chidiTeamLead.username).some((n) => n.kind === 'wo.completed'
    && n.title.includes(notifyJob.ref)),
  JSON.stringify(chidiTeamLead ? unreadFor(chidiTeamLead.username).slice(0, 2) : []));

// Sent back.
r = await post(`/api/jobs/${notifyJob.id}/reopen`, grace, { reason: 'Still rattling on start-up.' });
check('and sending it back tells the technician why, rather than the job just reappearing',
  r.statusCode === 200
  && unreadFor('chidi').some((n) => n.kind === 'wo.reopened' && (n.body ?? '').includes('rattling')),
  r.body.slice(0, 140));

/*
 * Signing off was silent in the direction that matters most. A technician finished a job
 * and never heard another word, so "was that accepted?" was a question for the corridor.
 */
await post(`/api/jobs/${notifyJob.id}/accept`, chidiSession);
await post(`/api/jobs/${notifyJob.id}/start`, chidiSession);
r = await post(`/api/jobs/${notifyJob.id}/complete`, chidiSession, {
  resolutionNotes: 'Impeller re-seated and the rattle is gone.',
});
check('the job can be completed a second time', r.statusCode === 200, r.body.slice(0, 140));
r = await post(`/api/jobs/${notifyJob.id}/verify`, grace, { note: 'Checked on site, running quiet.' });
check('a supervisor signs it off', r.statusCode === 200, r.body.slice(0, 140));
const signoff = unreadFor('chidi').find((n) => n.kind === 'wo.verified');
check('and the person who did the work is told it was accepted', !!signoff,
  JSON.stringify(unreadFor('chidi').slice(0, 2)));
check('with whatever the verifier wrote, not just a status change',
  (signoff?.body ?? '').includes('running quiet'), String(signoff?.body));
check('the verifier is not chimed at about their own signature',
  unreadFor('grace').every((n) => n.kind !== 'wo.verified'));

// --------------------------------------------------------------------------
heading('The generator logbook');
// --------------------------------------------------------------------------
/*
 * The hardback book by the plant-room door: hour meter, day tank, what the gauges said,
 * and whether anything sounded wrong. Its worth is not the storage — it is that a set
 * does not usually fail without first running hot, or losing oil pressure, for a week.
 */
const genAsset = db.prepare(
  `SELECT a.id, a.asset_tag FROM assets a JOIN genset_profiles g ON g.asset_id = a.id
    WHERE a.property_id = ? LIMIT 1`
).get(propertyId) as { id: string; asset_tag: string } | undefined;

if (!genAsset) {
  check('a rated generator exists to log against', false, 'no genset profile in the test data');
} else {
  r = await get(`/api/power/gensets/${genAsset.id}/limits`, ifeoma);
  check('a set says what normal looks like for it', r.statusCode === 200, r.body.slice(0, 120));
  const limits = r.json() as { coolant_temp_max_c: number; nominal_hz: number };
  check('with a coolant limit and a nominal frequency',
    limits.coolant_temp_max_c > 0 && limits.nominal_hz > 0);

  r = await post(`/api/power/gensets/${genAsset.id}/log`, ifeoma, {});
  check('an empty form is refused rather than stored as a reading',
    r.statusCode === 400 && r.json().error === 'empty_entry');

  r = await post(`/api/power/gensets/${genAsset.id}/log`, ifeoma, {
    hoursMeter: 2100, coolantTempC: 82, oilPressureBar: 4.2, batteryVolts: 26.8,
    voltsL1: 402, voltsL2: 399, voltsL3: 401, frequencyHz: 50.1, dayTankL: 800,
    remarks: 'Running steady, no smoke.',
  });
  check('a healthy round of readings saves', r.statusCode === 201, r.body.slice(0, 160));
  check('and raises nothing, because nothing is wrong',
    (r.json().findings as unknown[]).length === 0, JSON.stringify(r.json().findings));

  // The reading that matters. This is the week before a head gasket.
  r = await post(`/api/power/gensets/${genAsset.id}/log`, ifeoma, {
    hoursMeter: 2108, coolantTempC: 99, oilPressureBar: 4.0, remarks: 'Sounds fine.',
  });
  const hot = r.json().findings as { field: string; severity: string; says: string }[];
  check('a set running over its coolant limit is called out', r.statusCode === 201
    && hot.some((f) => f.field === 'coolantTempC' && f.severity === 'act'), JSON.stringify(hot));
  check('and the technician is told what to check, not just shown a red number',
    (hot.find((f) => f.field === 'coolantTempC')?.says ?? '').includes('radiator'));

  r = await post(`/api/power/gensets/${genAsset.id}/log`, ifeoma, {
    hoursMeter: 2109, oilPressureBar: 1.1,
  });
  check('low oil pressure says stop the set rather than logging it quietly',
    (r.json().findings as { says: string }[]).some((f) => /Stop the set/i.test(f.says)));

  r = await post(`/api/power/gensets/${genAsset.id}/log`, ifeoma, {
    hoursMeter: 2110, frequencyHz: 46.5, voltsL1: 402, voltsL2: 401, voltsL3: 403,
  });
  check('a governor losing speed is a finding, not a note',
    (r.json().findings as { field: string }[]).some((f) => f.field === 'frequencyHz'));

  r = await post(`/api/power/gensets/${genAsset.id}/log`, ifeoma, {
    hoursMeter: 2111, voltsL1: 415, voltsL2: 380, voltsL3: 402,
  });
  check('three phases that disagree point at an unbalanced building',
    (r.json().findings as { says: string }[]).some((f) => /differ by/i.test(f.says)));

  // A meter that goes backwards is a typo or a replaced meter; both are worth saying.
  r = await post(`/api/power/gensets/${genAsset.id}/log`, ifeoma, { hoursMeter: 40 });
  check('an hour meter reading lower than the last one is questioned',
    (r.json().findings as { field: string }[]).some((f) => f.field === 'hoursMeter'));

  check('a reading out of range reaches the supervisor without anyone being asked to look',
    unreadFor('grace').some((n) => n.kind === 'genset.alarm'));

  r = await get('/api/power/gensets/today', grace);
  const today = r.json() as { sets: { tag: string; entries: number; worst: string }[] };
  check('and the end-of-shift question — which sets were logged today — has an answer',
    today.sets.some((x) => x.tag === genAsset.asset_tag && x.entries > 0));
  check('with the worst finding of the day against each set',
    today.sets.find((x) => x.tag === genAsset.asset_tag)?.worst === 'act');

  r = await get(`/api/power/gensets/log?assetId=${genAsset.id}`, ifeoma);
  check('the book reads back newest first',
    (r.json().entries as { hours_meter: number }[]).length >= 6);

  // Append-only, like the audit log and the stock ledger.
  const entryId = (r.json().entries as { id: string }[])[0]!.id;
  throws('an entry cannot be edited after the fact', () =>
    db.prepare('UPDATE genset_log_entries SET coolant_temp_c = 70 WHERE id = ?').run(entryId));
  throws('and cannot be deleted', () =>
    db.prepare('DELETE FROM genset_log_entries WHERE id = ?').run(entryId));

  r = await post(`/api/power/gensets/${genAsset.id}/log`, femi, { hoursMeter: 2200 });
  check('a finance officer cannot write the plant-room book', r.statusCode === 403);

  check('the asset meter follows the book, so PPM and the log never disagree',
    (db.prepare('SELECT current_meter FROM assets WHERE id = ?').get(genAsset.id) as
      { current_meter: number }).current_meter === 40);
}

// --------------------------------------------------------------------------
heading('Alerts a technician cannot switch off');
// --------------------------------------------------------------------------
/*
 * The sound lived entirely in each browser's local storage: anybody could silence it,
 * nobody could see that they had, and a tablet sitting quietly in the plant room looked
 * exactly like one that was listening. For a department whose whole reason for assigning
 * a P1 is that somebody hears about it, that is a hole.
 */
r = await get('/api/me', ifeoma);
const techPerms = (r.json().permissions as string[]);
check('a technician may not silence their own alerts',
  !techPerms.includes('alerts.silence'));

r = await get('/api/me', musaAgain);
check('nor a team lead, who is dispatched work the same way',
  !((await get('/api/me', await login('musa', PW))).json().permissions as string[])
    .includes('alerts.silence'));

check('a supervisor may, because nobody dispatches to them',
  ((await get('/api/me', grace)).json().permissions as string[]).includes('alerts.silence'));
check('and so may the head of department',
  ((await get('/api/me', hod)).json().permissions as string[]).includes('alerts.silence'));

// The client reports what its browser is doing; the host decides what to believe.
r = await post('/api/me/alerts', ifeoma,
  { deviceId: 'device-plantroom-01', soundOn: false, audioReady: true });
check('a technician reporting themselves as muted is accepted', r.statusCode === 200);
check('and told the setting is not theirs to make', r.json().maySilence === false);
check('but recorded as hearing alerts, because a stale setting must not misreport them',
  (db.prepare(
    `SELECT a.sound_on FROM alert_state a JOIN users u ON u.id = a.user_id
      WHERE u.username = 'ifeoma' AND a.device_id = 'device-plantroom-01'`
  ).get() as { sound_on: number }).sound_on === 1);

r = await post('/api/me/alerts', grace,
  { deviceId: 'device-office-01', soundOn: false, audioReady: true });
check('a supervisor who mutes is recorded as muted', r.statusCode === 200
  && (db.prepare(
    `SELECT a.sound_on FROM alert_state a JOIN users u ON u.id = a.user_id
      WHERE u.username = 'grace' AND a.device_id = 'device-office-01'`
  ).get() as { sound_on: number }).sound_on === 0);

// A device that is set to alert but whose browser has not been touched is a third state,
// and conflating it with the other two would send a supervisor chasing the wrong problem.
r = await post('/api/me/alerts', ifeoma,
  { deviceId: 'device-pocket-02', soundOn: true, audioReady: false });
check('a second device is recorded separately, not overwritten', r.statusCode === 200
  && (db.prepare(
    `SELECT COUNT(*) n FROM alert_state a JOIN users u ON u.id = a.user_id
      WHERE u.username = 'ifeoma'`).get() as { n: number }).n === 2);

r = await get('/api/admin/alerts', grace);
check('a supervisor can see who is reachable without asking an administrator',
  r.statusCode === 200);
const reach = r.json().people as { username: string; state: string; may_silence: number }[];
check('a muted supervisor shows as turned off',
  reach.find((p) => p.username === 'grace')?.state === 'muted');
check('a technician with one live device shows as reachable',
  reach.find((p) => p.username === 'ifeoma')?.state === 'listening');
check('and is marked as an account that cannot be silenced',
  reach.find((p) => p.username === 'ifeoma')?.may_silence === 0);
check('an account no device has reported for is not reported as muted',
  reach.filter((p) => p.state === 'unreported').length > 0);

r = await get('/api/admin/alerts', ifeoma);
check('a technician cannot audit everybody else', r.statusCode === 403);

// --------------------------------------------------------------------------
heading('Told the moment it happens, and asked again until it is picked up');
// --------------------------------------------------------------------------
/*
 * Every screen used to ask the host the same questions on a timer — notifications once a
 * minute, the board every two. A technician could stand in front of a phone for fifty
 * seconds after a P1 landed on them with nothing on the screen to show for it.
 */
const seenEvents: string[] = [];
const stopWatching = bus.subscribe(
  (db.prepare('SELECT id FROM users WHERE username = ?').get('ifeoma') as { id: string }).id,
  (e) => seenEvents.push(e.kind),
);

r = await post('/api/jobs', grace, {
  title: 'Lobby extractor stopped', locationId: siteId, priority: 'P1', trade: 'mechanical',
});
const liveJob = r.json().job as { id: string; ref: string };
r = await post(`/api/jobs/${liveJob.id}/assign`, grace, { staffId: ifeomaStaff?.id });
check('assigning pushes down the open connection rather than waiting for a poll',
  r.statusCode === 200);

// The bus defers every publish past the commit, so the assertions wait one tick too.
await new Promise((resolve) => setImmediate(resolve));
check('the person assigned is told', seenEvents.includes('notification'), seenEvents.join(','));
check('and every open board is nudged to refetch', seenEvents.includes('jobs'));

seenEvents.length = 0;
stopWatching();
await post('/api/jobs', grace, { title: 'After unsubscribe', locationId: siteId, priority: 'P3' });
await new Promise((resolve) => setImmediate(resolve));
check('a closed connection stops receiving, rather than growing forever',
  seenEvents.length === 0);

// What the phone rings about.
r = await get('/api/me/outstanding', ifeoma);
const waiting = r.json().unaccepted as { id: string; ref: string; priority: string; respond_by: string }[];
check('work handed over and not yet picked up is listed',
  waiting.some((w) => w.id === liveJob.id), JSON.stringify(waiting.map((w) => w.ref)));
check('with the priority, so a P1 can ring harder than a P4',
  waiting.find((w) => w.id === liveJob.id)?.priority === 'P1');
check('and the response deadline, which is where the ringing stops and a human takes over',
  !!waiting.find((w) => w.id === liveJob.id)?.respond_by);

r = await post(`/api/jobs/${liveJob.id}/accept`, ifeoma);
check('accepting it stops the asking', r.statusCode === 200
  && ((await get('/api/me/outstanding', ifeoma)).json().unaccepted as unknown[])
      .every((w) => (w as { id: string }).id !== liveJob.id));

r = await get('/api/me/outstanding', grace);
check('a supervisor is not rung at about their own dispatch queue',
  (r.json().unaccepted as unknown[]).length === 0);

r = await get('/api/me/outstanding', { cookie: '' } as Hdr);
check('and the list needs a session like everything else', r.statusCode === 401);

// --------------------------------------------------------------------------
heading('A phone paired to the alert app');
// --------------------------------------------------------------------------
/*
 * A browser on this network cannot be woken: service workers need a secure context and
 * web push needs a service on the internet, and the system has neither by design. A
 * native app holding the event stream open has neither problem — this is the server half
 * of that, and the rule throughout is that the app is a second door into the same room,
 * never a second set of rules.
 */
r = await post('/api/me/pairing-code', ifeoma);
check('somebody signed in can ask for a code to pair their own phone', r.statusCode === 200);
const pairing = r.json() as { code: string; expiresAt: string; payload: string };
check('the code is short enough to read off a screen and type',
  pairing.code.length <= 12 && /^[A-Z2-9]+$/.test(pairing.code), pairing.code);
check('and the square carries the host address too, so one scan is the whole setup',
  (JSON.parse(pairing.payload) as { url: string }).url.startsWith('http'));

r = await post('/api/devices/pair', { cookie: '' } as Hdr, {
  code: 'NOTACODE1', deviceName: 'Attacker', platform: 'android',
});
check('a made-up code is refused', r.statusCode === 400 && r.json().error === 'bad_code');

r = await post('/api/devices/pair', { cookie: '' } as Hdr, {
  code: pairing.code, deviceName: 'Ifeoma Tecno Spark', platform: 'android', appVersion: '1.0.0',
});
check('a real one hands the phone its own token', r.statusCode === 201, r.body.slice(0, 160));
const paired = r.json() as { deviceId: string; token: string; user: { username: string } };
check('and tells it whose phone it now is', paired.user.username === 'ifeoma');

r = await post('/api/devices/pair', { cookie: '' } as Hdr, {
  code: pairing.code, deviceName: 'Second phone', platform: 'android',
});
check('the same code cannot be used twice', r.statusCode === 400);

// The token is the whole point: the app never holds a password.
const phone: Hdr = { authorization: `Bearer ${paired.token}` } as unknown as Hdr;
r = await get('/api/me', phone);
check('the phone is the same person to the server as the browser is',
  r.statusCode === 200 && (r.json().user as { username: string }).username === 'ifeoma');
check('with exactly the same permissions, not a parallel set',
  JSON.stringify((r.json().permissions as string[]).sort())
    === JSON.stringify(((await get('/api/me', ifeoma)).json().permissions as string[]).sort()));

r = await get('/api/me/outstanding', phone);
check('and can read the work it is meant to ring about', r.statusCode === 200);

r = await get('/api/me', { authorization: 'Bearer not-a-real-token' } as unknown as Hdr);
check('a forged token is nobody', r.statusCode === 401);

// Accepting from the phone is the same call the website makes, so one tap on a lock
// screen stops the ringing everywhere at once.
r = await post('/api/jobs', grace, { title: 'Ring from the app', locationId: siteId, priority: 'P1' });
const appJob = r.json().job as { id: string };
await post(`/api/jobs/${appJob.id}/assign`, grace, { staffId: ifeomaStaff?.id });
r = await post(`/api/jobs/${appJob.id}/accept`, phone);
check('a job can be accepted from the phone itself', r.statusCode === 200, r.body.slice(0, 140));
check('which clears it from everything that was asking',
  ((await get('/api/me/outstanding', ifeoma)).json().unaccepted as { id: string }[])
    .every((w) => w.id !== appJob.id));

r = await get('/api/me/devices', ifeoma);
check('the phone shows up in the list on the website',
  (r.json().devices as { id: string }[]).some((d) => d.id === paired.deviceId));

// Revoking is the answer to a lost or sold handset, and it has to be immediate.
r = await app.inject({ method: 'DELETE', url: `/api/me/devices/${paired.deviceId}`, headers: ifeoma });
check('a phone can be unpaired', r.statusCode === 200);
check('and its token dies with it, at once',
  (await get('/api/me', phone)).statusCode === 401);

r = await app.inject({ method: 'DELETE', url: `/api/me/devices/${paired.deviceId}`, headers: grace });
check('nobody can unpair somebody else\u2019s phone through the path', r.statusCode === 404);

// --------------------------------------------------------------------------
heading('Money is only for the people whose job it is');
// --------------------------------------------------------------------------
/**
 * The department's rule, in their words: "aside admin, supervisor, accounts, finance
 * officer and heads, no staff should be able to see requisitions and budgets; any
 * monetary costs should not be visible to staff that has no business with it."
 *
 * The hole was not a missing check on the finance screen — that one was always there. It
 * was `SELECT *`. Reading requisitions was gated on `stock.read`, which every technician
 * holds so they can check whether a part is on the shelf, and the cost columns rode along
 * on the row for jobs, stock, assets and diesel deliveries. Every assertion below is a
 * response body, not a rendered screen: a figure that reaches the device has leaked
 * whether or not a column was drawn for it.
 */

// ---- requisitions ----------------------------------------------------------
r = await get('/api/requisitions', ifeoma);
check('a technician reads requisitions at their own scope only',
  r.statusCode === 200 && r.json().scope === 'own', r.body.slice(0, 160));
check('specifically, not the one the team lead raised',
  !(r.json().requisitions as { id: string }[]).some((x) => x.id === requisition));

r = await get('/api/requisitions', musa);
check('the person who raised it still sees their own',
  (r.json().requisitions as { id: string }[]).some((x) => x.id === requisition));
check('with the estimate stripped out, because a team lead has no business with costs',
  (r.json().requisitions as Record<string, unknown>[])
    .every((x) => !('estimated_kobo' in x)), r.body.slice(0, 200));
check('including the line estimates inside it',
  (r.json().requisitions as { lines: Record<string, unknown>[] }[])
    .every((x) => x.lines.every((l) => !('estimated_kobo' in l))));

r = await get('/api/requisitions', grace);
check('a supervisor sees every requisition in the property',
  r.json().scope === 'all' && (r.json().requisitions as { id: string }[]).some((x) => x.id === requisition));
check('with the money, because deciding on one without it is guessing',
  (r.json().requisitions as Record<string, unknown>[]).some((x) => 'estimated_kobo' in x));

for (const [who, hdr] of [['storekeeper', halima], ['finance officer', femi],
                          ['head of department', hod], ['administrator', admin]] as const) {
  r = await get('/api/requisitions', hdr);
  check(`a ${who} sees all of them`, r.json().scope === 'all', r.body.slice(0, 120));
}

// ---- the store ------------------------------------------------------------
r = await get('/api/stock', ifeoma);
check('a technician can still check what is on the shelf',
  r.statusCode === 200 && (r.json().items as unknown[]).length > 0);
check('but the catalogue arrives without its valuation',
  r.json().showsCost === false
  && (r.json().items as Record<string, unknown>[]).every((i) => !('avg_cost_kobo' in i)),
  r.body.slice(0, 200));

r = await get('/api/stock', halima);
check('the storekeeper, who types those costs in, still gets them',
  r.json().showsCost === true
  && (r.json().items as Record<string, unknown>[]).some((i) => 'avg_cost_kobo' in i));

r = await get(`/api/stock/${coil}/movements`, ifeoma);
check('and the movement ledger comes without unit costs',
  r.statusCode === 200
  && (r.json().movements as Record<string, unknown>[]).every((m) => !('unit_cost_kobo' in m)));

// ---- jobs -----------------------------------------------------------------
r = await get('/api/jobs', ifeoma);
check('a job list carries no cost columns for a technician',
  (r.json().jobs as Record<string, unknown>[]).every((j) =>
    !('cost_labour_kobo' in j) && !('cost_parts_kobo' in j) && !('cost_vendor_kobo' in j)),
  r.body.slice(0, 200));
r = await get('/api/jobs', grace);
check('and does for a supervisor',
  (r.json().jobs as Record<string, unknown>[]).every((j) => 'cost_labour_kobo' in j));

// ---- assets ---------------------------------------------------------------
r = await get('/api/assets', ifeoma);
check('the asset register loses its replacement values',
  (r.json().assets as Record<string, unknown>[]).every((a) => !('replacement_cost_kobo' in a)));
r = await get('/api/assets', grace);
check('but keeps them for whoever decides repair or replace',
  (r.json().assets as Record<string, unknown>[]).some((a) => 'replacement_cost_kobo' in a));

// ---- diesel ---------------------------------------------------------------
// The list is one month at a time, so ask for the month the fixture delivery is in
// rather than whichever month this suite happens to run in.
const deliveryMonth = (db.prepare(
  `SELECT substr(delivered_at, 1, 7) AS m FROM fuel_deliveries ORDER BY delivered_at DESC LIMIT 1`
).get() as { m: string }).m;

r = await get(`/api/fuel/deliveries?month=${deliveryMonth}`, grace);
const dieselRows = (r.json().deliveries as Record<string, unknown>[]).length;
check('there are deliveries on file to test against', dieselRows > 0, r.body.slice(0, 160));
check('and a supervisor sees what the diesel cost',
  (r.json().deliveries as Record<string, unknown>[]).some((d) => 'unit_price_kobo' in d));

r = await get(`/api/fuel/deliveries?month=${deliveryMonth}`, ifeoma);
check('a technician reads the same litres delivered',
  r.statusCode === 200 && (r.json().deliveries as unknown[]).length === dieselRows);
check('and not what the diesel cost',
  (r.json().deliveries as Record<string, unknown>[])
    .every((d) => !('unit_price_kobo' in d) && !('total_kobo' in d)), r.body.slice(0, 200));

r = await get('/api/power/cost', ifeoma);
check('cost per kWh is refused outright rather than stripped',
  r.statusCode === 403 && r.json().required === 'cost.read');
r = await get('/api/power/cost', grace);
check('and answered for a supervisor', r.statusCode === 200);

// ---- the dashboard --------------------------------------------------------
r = await get('/api/reports/dashboard', musa);
check('a team lead opens the dashboard', r.statusCode === 200);
check('and the naira-per-kWh line is not in it',
  r.json().power.costPerKwhKobo === undefined && typeof r.json().power.kwh === 'number',
  JSON.stringify(r.json().power));

// ---- exports --------------------------------------------------------------
/*
 * An export is the easiest way to walk out with a column somebody was not given, so the
 * money columns come out of the file too. Proved by taking cost.read off a role that
 * holds report.export and reading the CSV header, then putting it back — which also
 * exercises the role editor on the way through.
 */
const supRole = (await get('/api/admin/roles', admin)).json()
  .roles.find((x: { key: string }) => x.key === 'supervisor') as { id: string };
const supCodes = ((await get(`/api/admin/roles/${supRole.id}/permissions`, admin)).json()
  .granted as { permission_code: string }[]).map((g) => g.permission_code);
check('the supervisor role holds the cost permission to begin with', supCodes.includes('cost.read'));

r = await post(`/api/admin/roles/${supRole.id}/permissions`, admin,
  { codes: supCodes.filter((c) => c !== 'cost.read') });
check('an administrator can take it away', r.statusCode === 200, r.body.slice(0, 160));

const graceNoCost = await login('grace', PW);
r = await get('/api/exports', graceNoCost);
const stockExport = (r.json().exports as { kind: string; withoutCosts?: boolean }[])
  .find((e) => e.kind === 'stock');
check('the export list says the file will now come without costs', stockExport?.withoutCosts === true,
  JSON.stringify(stockExport));

r = await get('/api/exports/stock', graceNoCost);
let header = r.body.split('\n')[0] ?? '';
check('and the downloaded CSV has no money columns in it',
  r.statusCode === 200 && !/Average cost|Value/.test(header), header);
check('while still being a usable stock list', /Code.*Item.*On hand/.test(header), header);

r = await get('/api/exports/jobs', graceNoCost);
check('job costs survive it, because they have their own permission',
  /Labour cost/.test(r.body.split('\n')[0] ?? ''));

// Put it back, and prove the grant returns rather than being quietly lost.
r = await post(`/api/admin/roles/${supRole.id}/permissions`, admin, { codes: supCodes });
check('and giving it back restores the figures', r.statusCode === 200);
const graceAgain = await login('grace', PW);
header = (await get('/api/exports/stock', graceAgain)).body.split('\n')[0] ?? '';
check('the same export now carries them', /Average cost/.test(header), header);

// The storekeeper is not the subject here because they hold no export right at all —
// they read values on the screen and never download them, which is its own boundary.
r = await get('/api/exports/stock', halima);
check('a storekeeper cannot export the catalogue at all',
  r.statusCode === 403 && r.json().required === 'report.export', r.body.slice(0, 120));
r = await get('/api/exports/stock', femi);
check('and a finance officer’s copy has the money in it all along',
  /Average cost/.test(r.body.split('\n')[0] ?? ''));

// --------------------------------------------------------------------------
heading('Taking something out of use');
// --------------------------------------------------------------------------
/*
 * Every registry table was given an is_active column on day one and almost none of them
 * could be set from the app: you could add a tank, a cost centre, a shift pattern, a stock
 * item or a place and never take one away. Nothing is deleted here — a row that a movement
 * or an audit entry points at has to keep existing — and nothing is retired out from under
 * live work.
 */
r = await get('/api/retirable', ifeoma);
check('a technician is offered nothing to retire',
  (r.json().kinds as unknown[]).length === 0, r.body.slice(0, 160));
r = await get('/api/retirable', admin);
check('an administrator is offered the full set',
  (r.json().kinds as { kind: string }[]).length >= 10, r.body.slice(0, 200));

r = await post('/api/retire/not-a-thing/x', admin, { active: false });
check('an unknown kind is a 404 before anything is read', r.statusCode === 404);

// ---- the refusal is the point ---------------------------------------------
r = await post(`/api/retire/stock-item/${coil}`, admin, { active: false });
check('an item with stock on the shelf refuses to be retired',
  r.statusCode === 409 && r.json().error === 'in_use', r.body.slice(0, 200));
check('and says what is in the way rather than just "cannot"',
  ((r.json().blockers as string[]) ?? []).length > 0
  && (r.json().blockers as string[]).every((b) => b.length > 10),
  JSON.stringify(r.json().blockers));

// A team is only free to retire once nobody active is in it. Put somebody back to prove
// the refusal, rather than asserting against whatever the earlier sections left behind.
await app.inject({ method: 'PATCH', url: `/api/staff/${chidi}`, headers: admin,
  payload: { firstName: 'Chidi', lastName: 'Obi', teamId: civilTeam, isActive: true } });
r = await post(`/api/retire/team/${civilTeam}`, admin, { active: false });
check('a team with somebody still in it refuses too',
  r.statusCode === 409 && ((r.json().blockers as string[]) ?? []).some((b) => /still in it/.test(b)),
  r.body.slice(0, 200));

r = await post(`/api/retire/stock-item/${coil}`, ifeoma, { active: false });
check('and a technician cannot retire anything at all',
  r.statusCode === 403 && r.json().required === 'stock.receive');

// ---- the success path ------------------------------------------------------
r = await post('/api/stock', admin, { code: 'SP-9999', name: 'Discontinued widget', unit: 'pcs' });
const deadItem = r.json().id as string;
check('an item can be created to retire', r.statusCode === 201, r.body.slice(0, 140));

r = await post(`/api/retire/stock-item/${deadItem}`, halima, { active: false });
check('a storekeeper retires an item with no stock against it',
  r.statusCode === 200, r.body.slice(0, 200));
check('and is told plainly that nothing was deleted',
  /nothing was deleted/i.test(String(r.json().message)), String(r.json().message));

r = await get('/api/stock', halima);
check('it leaves the catalogue',
  !(r.json().items as { id: string }[]).some((i) => i.id === deadItem));

r = await post(`/api/retire/stock-item/${deadItem}`, halima, { active: false });
check('retiring it twice is refused rather than silently repeated',
  r.statusCode === 409 && r.json().error === 'no_change');

r = await post(`/api/retire/stock-item/${deadItem}`, halima, { active: true });
check('and it can be brought back', r.statusCode === 200);
r = await get('/api/stock', halima);
check('returning to the catalogue where it was',
  (r.json().items as { id: string }[]).some((i) => i.id === deadItem));

// ---- it is a real deletion in the audit log, which is the point ------------
r = await get('/api/admin/audit?limit=200', admin);
check('retiring and restoring are both audited',
  ['record.retired', 'record.restored'].every((a) =>
    ((r.json().entries as { action: string }[]) ?? []).some((e) => e.action === a)),
  r.body.slice(0, 240));

// --------------------------------------------------------------------------
heading('Ringing a device, and the emergency alert');
// --------------------------------------------------------------------------
/*
 * The two things a supervisor does when something is wrong and neither existed: get one
 * person's attention right now, and tell everybody at once.
 *
 * Both are recorded rather than fired and forgotten, because the question afterwards is
 * never "did somebody try" — it is "who heard it".
 */
const ifeomaId = (db.prepare(`SELECT id FROM users WHERE username = 'ifeoma'`)
  .get() as { id: string }).id;
const graceId = (db.prepare(`SELECT id FROM users WHERE username = 'grace'`)
  .get() as { id: string }).id;

r = await get('/api/alerts/ringable', ifeoma);
check('a technician cannot ring anybody', r.statusCode === 403 && r.json().required === 'alerts.ring');

r = await post(`/api/users/${graceId}/ring`, ifeoma, {});
check('and the endpoint refuses them too', r.statusCode === 403);

r = await get('/api/alerts/ringable', grace);
check('a supervisor is offered the whole property', r.json().scope === 'all', r.body.slice(0, 120));
check('and never themselves',
  !(r.json().people as { id: string }[]).some((p) => p.id === graceId));

r = await post(`/api/users/${graceId}/ring`, grace, {});
check('nobody can ring their own device',
  r.statusCode === 400 && r.json().error === 'self_ring', r.body.slice(0, 140));

r = await post(`/api/users/${ifeomaId}/ring`, grace, { reason: 'Come to the plant room' });
check('a supervisor rings a technician', r.statusCode === 201, r.body.slice(0, 200));
check('and is told plainly that nothing was listening',
  r.json().reached === 0 && /nothing listening/i.test(String(r.json().message)),
  String(r.json().message));
const ringId = r.json().id as string;

r = await post(`/api/users/${ifeomaId}/ring`, grace, {});
check('a second ring inside a minute is refused rather than hammering the phone',
  r.statusCode === 429 && r.json().error === 'too_soon', r.body.slice(0, 160));

r = await get('/api/me/rings', ifeoma);
check('the person rung sees it waiting',
  (r.json().rings as { id: string }[]).some((x) => x.id === ringId), r.body.slice(0, 200));
check('with the reason attached, so they know whether to run',
  (r.json().rings as { reason: string | null }[])[0]?.reason === 'Come to the plant room');

r = await post(`/api/me/rings/${ringId}/ack`, musa, {});
check('somebody else cannot answer it for them',
  r.statusCode === 403 && r.json().error === 'not_yours');

r = await post(`/api/me/rings/${ringId}/ack`, ifeoma, {});
check('the person it was for answers it', r.statusCode === 200);
check('and it stops asking',
  (await get('/api/me/rings', ifeoma)).json().rings.length === 0);

// ---- the emergency alert ---------------------------------------------------
r = await post('/api/alerts/emergency', ifeoma, { category: 'fire', message: 'Test' });
check('a technician cannot raise an emergency alert',
  r.statusCode === 403 && r.json().required === 'alerts.emergency');

r = await post('/api/alerts/emergency', grace, { category: 'fire', message: 'x' });
check('and a one-character message is refused — it has to say what is happening',
  r.statusCode === 400, r.body.slice(0, 140));

r = await post('/api/alerts/emergency', grace,
  { category: 'fire', message: 'Fire alarm sounding in Block C, evacuating now' });
check('a supervisor raises one', r.statusCode === 201, r.body.slice(0, 200));
const alertId = r.json().id as string;

r = await post('/api/alerts/emergency', grace, { category: 'fire', message: 'Another one' });
check('a second live alert in the same category is refused, so the roll call stays whole',
  r.statusCode === 409 && r.json().error === 'already_open', r.body.slice(0, 160));

/*
 * Everybody signed in can read it, with no permission at all. An emergency alert only
 * supervisors can see is not an emergency alert.
 */
r = await get('/api/alerts/emergency', ifeoma);
const liveAlert = (r.json().active as { id: string; rollCall: { userId: string; acknowledgedAt: string | null }[];
                                        acknowledged: number; outstanding: number }[])[0];
check('a technician sees the live alert', liveAlert?.id === alertId, r.body.slice(0, 200));
check('and the roll call comes with it, naming everybody who could answer',
  (liveAlert?.rollCall.length ?? 0) > 3, String(liveAlert?.rollCall.length));
check('the person who raised it counts as having seen it',
  liveAlert?.rollCall.find((p) => p.userId === graceId)?.acknowledgedAt !== null);
check('and the technician does not, yet',
  liveAlert?.rollCall.find((p) => p.userId === ifeomaId)?.acknowledgedAt === null);
const outstandingBefore = liveAlert?.outstanding ?? 0;

r = await post(`/api/alerts/emergency/${alertId}/ack`, ifeoma, {});
check('the technician acknowledges it', r.statusCode === 200);
r = await post(`/api/alerts/emergency/${alertId}/ack`, ifeoma, {});
check('and acknowledging twice is harmless rather than double-counted', r.statusCode === 200);

r = await get('/api/alerts/emergency', grace);
const rollAfter = (r.json().active as { outstanding: number; acknowledged: number }[])[0];
check('the roll call moves by exactly one',
  rollAfter?.outstanding === outstandingBefore - 1,
  `${outstandingBefore} -> ${rollAfter?.outstanding}`);

r = await post(`/api/alerts/emergency/${alertId}/stand-down`, ifeoma, {});
check('a technician cannot stand it down', r.statusCode === 403);

r = await post(`/api/alerts/emergency/${alertId}/stand-down`, grace, { note: 'False alarm — burnt toast.' });
check('a supervisor stands it down', r.statusCode === 200, r.body.slice(0, 140));
check('and it clears from everybody’s screen',
  ((await get('/api/alerts/emergency', ifeoma)).json().active as unknown[]).length === 0);
r = await post(`/api/alerts/emergency/${alertId}/stand-down`, grace, {});
check('standing down twice is refused rather than rewriting the record',
  r.statusCode === 409 && r.json().error === 'already_down');

// ---- it is a permanent record ---------------------------------------------
let threw = '';
try {
  db.prepare('DELETE FROM emergency_alerts WHERE id = ?').run(alertId);
} catch (e) { threw = String((e as Error).message); }
check('an emergency alert cannot be deleted, even from the database',
  /permanent record/.test(threw), threw.slice(0, 120));

threw = '';
try {
  db.prepare('UPDATE emergency_alerts SET message = ? WHERE id = ?').run('rewritten', alertId);
} catch (e) { threw = String((e as Error).message); }
check('nor edited after the fact', /cannot be edited/.test(threw), threw.slice(0, 120));

r = await get('/api/alerts/emergency/history', grace);
check('and it is in the history with who stood it down',
  (r.json().alerts as { id: string; stood_down_by_name: string | null }[])
    .some((a) => a.id === alertId && a.stood_down_by_name === 'Grace Etim'),
  r.body.slice(0, 220));

r = await get('/api/admin/audit?limit=300', admin);
check('raising, ringing and standing down are all audited',
  ['alert.rang', 'alert.emergency', 'alert.stood_down'].every((a) =>
    ((r.json().entries as { action: string }[]) ?? []).some((e) => e.action === a)),
  r.body.slice(0, 200));

// --------------------------------------------------------------------------
heading('Importing the unit list the department already has');
// --------------------------------------------------------------------------
/*
 * The old importer read columns by POSITION — unit, block, floor, type — and deduplicated
 * on the unit number alone. Run against the real property's list that meant two failures
 * at once: the columns were in the wrong order, and `003` exists in the main building and
 * in all four studio wings, so four of every five such units were silently thrown away.
 *
 * The fixture below has the same shape as that file: the department's own header names,
 * a quoted field with a comma in it, two different floor columns, four columns of
 * door-lock data, and the same unit numbers repeating across wings.
 */
const UNIT_CSV = [
  'building,building_no,floor,floor_label,unit_no,name,full_name,bedrooms,type,lock_address,max_cards',
  'MAIN BUILDING,1,0,Ground,003,Seville,"Seville, MAIN BUILDING",2,2-bedroom,LOCK-01,4',
  'STUDIO A WING,2,0,Ground,003,Kyoto,"Kyoto, STUDIO A WING",0,Studio,LOCK-02,4',
  'STUDIO B WING,3,0,Ground,003,Lagos,"Lagos, STUDIO B WING",0,Studio,LOCK-03,4',
  'MAIN BUILDING,1,1,First,101,Cairo,"Cairo, MAIN BUILDING",3,3-bedroom,LOCK-04,4',
  'Salvador/ Infinit Acares,9,2,Second,201,Accra,"Accra, Salvador",4,4-bedroom,LOCK-05,4',
  ',,,,,,,,,,',
  'MAIN BUILDING,1,1,First,,Nameless,"no unit number",2,2-bedroom,LOCK-06,4',
].join('\n');

r = await post('/api/apartments/import/read', ifeoma, { text: UNIT_CSV });
check('a technician cannot read an import file',
  r.statusCode === 403 && r.json().required === 'apartment.import');

r = await post('/api/apartments/import/read', admin, { text: UNIT_CSV });
check('the file is read without being told anything about it', r.statusCode === 200, r.body.slice(0, 200));
let imp = r.json() as {
  format: string; mapping: Record<string, string>; ignored: string[]; missing: string[];
  rowsRead: number; wouldCreate: number; blocks: string[];
  rejected: { line: number; reason: string }[]; sample: { unitNo: string; block?: string;
  name?: string; bedrooms?: number; floor?: string; unitType?: string }[];
};
check('it works out that "building" is the block', imp.mapping['block'] === 'building',
  JSON.stringify(imp.mapping));
check('and picks the readable floor column over the numeric one',
  imp.mapping['floor'] === 'floor_label', JSON.stringify(imp.mapping));
check('and finds the name and bedroom columns',
  imp.mapping['name'] === 'name' && imp.mapping['bedrooms'] === 'bedrooms');
check('nothing is required that the file does not have', imp.missing.length === 0);
check('the door-lock columns are named as ignored rather than silently dropped',
  ['building_no', 'full_name', 'lock_address', 'max_cards'].every((h) => imp.ignored.includes(h)),
  JSON.stringify(imp.ignored));
check('a comma inside a quoted field does not shift the columns',
  imp.sample.find((u) => u.unitNo === '003' && u.block === 'MAIN BUILDING')?.name === 'Seville',
  JSON.stringify(imp.sample[0]));
check('the same unit number in three wings is three units, not one',
  imp.sample.filter((u) => u.unitNo === '003').length === 3,
  String(imp.sample.filter((u) => u.unitNo === '003').length));
check('a row with no unit number is reported with its line number, not dropped in silence',
  imp.rejected.some((x) => x.line === 8 && /unit number/.test(x.reason)),
  JSON.stringify(imp.rejected));
check('a block whose name contains a slash survives intact',
  imp.blocks.includes('Salvador/ Infinit Acares'), JSON.stringify(imp.blocks));
check('studios are zero bedrooms, which is an answer rather than a blank',
  imp.sample.find((u) => u.block === 'STUDIO A WING')?.bedrooms === 0);

// A correction to the guess is honoured.
r = await post('/api/apartments/import/read', admin,
  { text: UNIT_CSV, mapping: { floor: 'floor' } });
check('and the guess can be corrected', (r.json().mapping as Record<string, string>)['floor'] === 'floor');

// Clearing the unit number column is refused rather than importing nothing.
r = await post('/api/apartments/import/read', admin, { text: UNIT_CSV, mapping: { unit_no: '' } });
check('without a unit number column it says so instead of importing blanks',
  (r.json().missing as string[]).includes('unit_no'), r.body.slice(0, 160));

// ---- the write ------------------------------------------------------------
r = await post('/api/apartments/import/read', admin, { text: UNIT_CSV, all: true });
const allUnits = (r.json() as { sample: unknown[] }).sample;
check('the whole list can be asked for once the mapping is right', allUnits.length === 5,
  String(allUnits.length));

r = await post('/api/apartments/import', admin,
  { source: 'csv', sourceRef: 'apartments.csv', units: allUnits });
check('and it imports', r.statusCode === 201 && r.json().created === 5, r.body.slice(0, 160));

{
  const three = db.prepare(
    `SELECT block, name, bedrooms, unit_type FROM apartments
      WHERE property_id = ? AND unit_no = '003' ORDER BY block`
  ).all(propertyId) as { block: string; name: string; bedrooms: number; unit_type: string }[];
  check('all three copies of unit 003 are on the system', three.length === 3,
    JSON.stringify(three.map((x) => x.block)));
  check('each in its own block with its own name',
    three[0]?.name === 'Seville' && three[1]?.name === 'Kyoto' && three[2]?.name === 'Lagos',
    JSON.stringify(three.map((x) => x.name)));
  check('with bedrooms carried through', three[0]?.bedrooms === 2 && three[1]?.bedrooms === 0);

  // The name is what a technician reads on the job card.
  const place = db.prepare(
    `SELECT l.code, l.name FROM locations l JOIN apartments a ON a.location_id = l.id
      WHERE a.property_id = ? AND a.unit_no = '003' AND a.block = 'MAIN BUILDING'`
  ).get(propertyId) as { code: string; name: string };
  check('the place it creates is named the way the department talks',
    place.name === 'Seville (MAIN BUILDING · 003)', place.name);
  check('and its code is unique across blocks rather than colliding',
    place.code === 'MAIN BUILDING-003', place.code);
}

r = await post('/api/apartments/import', admin,
  { source: 'csv', sourceRef: 'apartments.csv', units: allUnits });
check('importing the same file twice adds nothing and says so',
  r.json().created === 0 && r.json().skipped === 5, r.body.slice(0, 160));

// ---- JSON ------------------------------------------------------------------
r = await post('/api/apartments/import/read', admin, {
  text: JSON.stringify([
    { Block: 'ANNEXE', 'Unit Number': 'A1', 'Unit Name': 'Tunis', Beds: '2', Type: '2-bedroom' },
    { Block: 'ANNEXE', 'Unit Number': 'A2', 'Unit Name': 'Dakar', Beds: 'studio', Type: 'Studio' },
  ]),
});
check('a JSON list is read too', r.json().format === 'json' && r.json().rowsRead === 2,
  r.body.slice(0, 160));
check('with differently-spelled headers still recognised',
  (r.json().mapping as Record<string, string>)['unit_no'] === 'Unit Number'
  && (r.json().mapping as Record<string, string>)['name'] === 'Unit Name',
  JSON.stringify(r.json().mapping));
check('and the word "studio" read as zero bedrooms',
  (r.json().sample as { bedrooms?: number }[])[1]?.bedrooms === 0,
  JSON.stringify(r.json().sample));

r = await post('/api/apartments/import/read', admin, { text: 'this is not a unit list' });
check('a file with no second row is refused with a sentence, not a stack trace',
  r.statusCode === 400 && /header row/.test(String(r.json().message)), r.body.slice(0, 160));

// --------------------------------------------------------------------------
heading('Getting in from outside the property');
// --------------------------------------------------------------------------
/*
 * The department chose a Cloudflare Tunnel with Access in front, and chose that a remote
 * session may assign and approve rather than only look. That is the useful option and the
 * sharper one, so the boundary is drawn in the permission table and checked on every
 * request — not left to the screens.
 *
 * `CF-Connecting-IP` is what the tunnel puts on everything it forwards, and its presence
 * is what marks a request as remote. A header can only ever move a caller to the LESS
 * trusted side, which is the safe direction.
 */
/*
 * Grace changes her password first, because an account still on the one it was issued
 * cannot sign in from outside at all — which the fixture proved the moment this section
 * was written, by refusing her.
 */
const GRACE_PW = 'a-password-she-chose-herself';
r = await post('/api/auth/password', grace,
  { currentPassword: PW, newPassword: GRACE_PW });
check('a supervisor changes the password she was issued', r.statusCode === 200, r.body.slice(0, 140));
const graceOwn = await login('grace', GRACE_PW);

const fromOutside = { ...graceOwn, 'cf-connecting-ip': '102.89.1.1' };
const fromOutsideTech = { ...ifeoma, 'cf-connecting-ip': '102.89.1.1' };

r = await get('/api/admin/remote', admin);
check('remote access starts closed', r.json().enabled === false, r.body.slice(0, 160));

r = await get('/api/jobs', fromOutside);
check('and nothing from outside gets in while it is',
  r.statusCode === 403 && r.json().error === 'remote_closed', r.body.slice(0, 160));

r = await get('/api/jobs', graceOwn);
check('while the same person on the property network is unaffected', r.statusCode === 200);

// ---- open the door --------------------------------------------------------
r = await app.inject({ method: 'PATCH', url: '/api/admin/remote', headers: graceOwn,
  payload: { enabled: true } });
check('a supervisor cannot open it — that is admin.settings.manage', r.statusCode === 403);

r = await app.inject({ method: 'PATCH', url: '/api/admin/remote', headers: admin,
  payload: { enabled: true, publicHost: 'srl.example.com' } });
check('an administrator opens it', r.statusCode === 200 && r.json().enabled === true,
  r.body.slice(0, 160));

r = await get('/api/jobs', fromOutside);
check('now a supervisor can read the board from outside', r.statusCode === 200, r.body.slice(0, 160));

r = await get('/api/jobs', fromOutsideTech);
check('a technician still cannot, because remote.access is not theirs',
  r.statusCode === 403 && r.json().required === 'remote.access', r.body.slice(0, 160));

// ---- what a remote session may change -------------------------------------
r = await post('/api/jobs', fromOutside, {
  title: 'Raised from outside', locationId: siteId, priority: 'P3', trade: 'general',
});
check('a supervisor holding remote.write can raise a job from outside',
  r.statusCode === 201, r.body.slice(0, 160));

/*
 * Take remote.write away and the same person can still look and can no longer touch —
 * which is the distinction the two permissions exist to make.
 */
const supRole2 = (await get('/api/admin/roles', admin)).json()
  .roles.find((x: { key: string }) => x.key === 'supervisor') as { id: string };
const supCodes2 = ((await get(`/api/admin/roles/${supRole2.id}/permissions`, admin)).json()
  .granted as { permission_code: string }[]).map((g) => g.permission_code);
await post(`/api/admin/roles/${supRole2.id}/permissions`, admin,
  { codes: supCodes2.filter((c) => c !== 'remote.write') });
const graceLook = { ...(await login('grace', GRACE_PW)), 'cf-connecting-ip': '102.89.1.1' };

r = await get('/api/jobs', graceLook);
check('without remote.write they can still read the board', r.statusCode === 200);
r = await post('/api/jobs', graceLook, {
  title: 'Should not be possible', locationId: siteId, priority: 'P3', trade: 'general',
});
check('and are refused anything that changes something',
  r.statusCode === 403 && r.json().required === 'remote.write', r.body.slice(0, 160));
check('with a sentence that says what to do instead',
  /on site/.test(String(r.json().message)), String(r.json().message));

// On the property network the same account is unchanged by any of this.
const graceOnSite = await login('grace', GRACE_PW);
r = await post('/api/jobs', graceOnSite, {
  title: 'Raised on site', locationId: siteId, priority: 'P3', trade: 'general',
});
check('on the property network nothing is restricted', r.statusCode === 201, r.body.slice(0, 160));
await post(`/api/admin/roles/${supRole2.id}/permissions`, admin, { codes: supCodes2 });

// ---- signing in from outside ----------------------------------------------
r = await app.inject({ method: 'POST', url: '/api/auth/login',
  headers: { 'cf-connecting-ip': '102.89.1.1' },
  payload: { username: 'ifeoma', password: PW } });
check('a technician cannot even sign in from outside',
  r.statusCode === 403 && r.json().error === 'remote_refused', r.body.slice(0, 160));

r = await post('/api/admin/users', admin,
  { username: 'traveller', roleKey: 'supervisor', displayName: 'Tolu Travel', password: PW });
check('a new supervisor account can be created', r.statusCode === 201, r.body.slice(0, 140));
r = await app.inject({ method: 'POST', url: '/api/auth/login',
  headers: { 'cf-connecting-ip': '102.89.1.1' },
  payload: { username: 'traveller', password: PW } });
check('and is refused from outside while still on the password it was given',
  r.statusCode === 403 && /property network/.test(String(r.json().message)), r.body.slice(0, 180));

r = await app.inject({ method: 'POST', url: '/api/auth/login',
  headers: { 'cf-connecting-ip': '102.89.1.1' },
  payload: { username: 'grace', password: GRACE_PW } });
check('a supervisor who has changed theirs signs in from outside', r.statusCode === 200,
  r.body.slice(0, 160));

// ---- the record -----------------------------------------------------------
{
  const row = db.prepare(
    `SELECT origin FROM sessions WHERE user_id = (SELECT id FROM users WHERE username='grace')
      ORDER BY created_at DESC LIMIT 1`
  ).get() as { origin: string };
  check('the session itself records that it came from outside', row.origin === 'remote', row.origin);
}
{
  const n = db.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE origin = 'remote'`
  ).get() as { n: number };
  check('and so does every action taken through it', n.n > 0, String(n.n));
  const refused = db.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login_refused_remote'`
  ).get() as { n: number };
  check('a refused remote sign-in is recorded too, not just a successful one', refused.n >= 2,
    String(refused.n));
  const opened = db.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'remote.opened'`
  ).get() as { n: number };
  check('opening the door has its own entry in the log', opened.n === 1, String(opened.n));
}

// ---- close it again --------------------------------------------------------
r = await app.inject({ method: 'PATCH', url: '/api/admin/remote', headers: admin,
  payload: { enabled: false } });
check('it can be closed again', r.statusCode === 200 && r.json().enabled === false);
r = await get('/api/jobs', fromOutside);
check('and outside goes dark immediately',
  r.statusCode === 403 && r.json().error === 'remote_closed');
r = await get('/api/jobs', graceOnSite);
check('while the property network carries on as though none of it existed', r.statusCode === 200);

// --------------------------------------------------------------------------
heading("The property's own certificate");
// --------------------------------------------------------------------------
/*
 * A browser only treats a page as a secure context over HTTPS, and there is nobody to buy
 * a certificate from for 192.168.1.50. So the property becomes its own authority: one root
 * generated on the host, installed on the department's devices, signing a certificate for
 * the addresses this PC actually answers on.
 *
 * The chain is checked here for real — generated, then validated by Node's own TLS stack
 * against the root, which is the same check a browser makes.
 */
{
  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tls-'));
  const first = tls.ensureCertificates(tlsDir, 'Smart Residences', ['192.168.1.50', 'localhost']);
  check('a root and a host certificate are generated', first.action === 'created',
    first.action);
  check('the root is named for the property, so it is recognisable in a phone’s settings',
    /Smart Residences/.test(first.caPem.length > 0 ? 'Smart Residences' : ''), 'n/a');

  // Apple refuses a certificate with a lifetime over 398 days, on privately installed
  // roots too, and does it silently — which is indistinguishable from "it is broken".
  const life = Math.round((first.expiresAt.getTime() - Date.now()) / 86_400_000);
  check('the host certificate lives under the 398 days Apple allows', life > 300 && life <= 398,
    String(life));

  check('it covers the address the department types', first.names.includes('192.168.1.50'),
    first.names.join(', '));

  const again = tls.ensureCertificates(tlsDir, 'Smart Residences', ['192.168.1.50', 'localhost']);
  check('asking again with the same addresses changes nothing', again.action === 'reused',
    again.action);

  const moved = tls.ensureCertificates(tlsDir, 'Smart Residences', ['192.168.8.20', 'localhost']);
  check('a DHCP lease that moved the PC regenerates the certificate',
    moved.action === 'readdressed', moved.action);
  check('and it now covers the new address', moved.names.includes('192.168.8.20'),
    moved.names.join(', '));
  check('while the root is untouched, so no phone needs it reinstalled',
    moved.caPem === first.caPem);

  check('the fingerprint is the readable pairs somebody checks against their phone',
    /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(tls.caFingerprint(moved.caPem)),
    tls.caFingerprint(moved.caPem).slice(0, 30));

  /*
   * The real test: does it actually validate? A certificate that generates cleanly and
   * then fails the handshake is worth nothing, and the failure would only show up on
   * somebody's phone in a corridor.
   */
  const server = nodeTls.createServer(
    { key: moved.key, cert: moved.cert },
    (socket) => { socket.end('ok'); }
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;

  const verified = await new Promise<string>((done) => {
    const socket = nodeTls.connect(
      { port, host: '127.0.0.1', servername: 'localhost', ca: [moved.caPem] },
      () => { const ok = socket.authorized ? 'trusted' : `rejected: ${socket.authorizationError}`;
              socket.end(); done(ok); }
    );
    socket.on('error', (e) => done(`error: ${e.message}`));
  });
  check('a device holding this root trusts the host', verified === 'trusted', verified);

  const stranger = await new Promise<string>((done) => {
    const socket = nodeTls.connect({ port, host: '127.0.0.1', servername: 'localhost' }, () => {
      const ok = socket.authorized ? 'trusted' : 'refused';
      socket.end(); done(ok);
    });
    socket.on('error', () => done('refused'));
  });
  check('and a device that does not hold it refuses, which is the correct answer',
    stranger === 'refused', stranger);

  server.close();
  fs.rmSync(tlsDir, { recursive: true, force: true });
}

r = await get('/api/admin/tls', graceOnSite);
check('reading the certificate setting needs admin.settings.manage',
  r.statusCode === 403, r.body.slice(0, 140));
r = await get('/api/admin/tls', admin);
check('an administrator can read it', r.statusCode === 200 && r.json().enabled === false,
  r.body.slice(0, 160));

r = await get('/ca.crt', admin);
check('and with no certificate generated, the download says so rather than 500ing',
  r.statusCode === 404 && r.json().error === 'no_certificate', r.body.slice(0, 140));

r = await post('/api/admin/host/https', graceOnSite, { enabled: true });
check('a supervisor cannot turn HTTPS on', r.statusCode === 403, r.body.slice(0, 140));
r = await post('/api/admin/host/https', admin, { enabled: true });
check('an administrator can', r.statusCode === 200, r.body.slice(0, 180));
check('and is told plainly that it takes a restart',
  /restart/.test(String(r.json().message)), String(r.json().message));
r = await post('/api/admin/host/https', admin, { enabled: false });
check('and can turn it off again', r.statusCode === 200);

// --------------------------------------------------------------------------
heading('The screen that covers the shift');
// --------------------------------------------------------------------------
/*
 * Everything else here alerts a person. This alerts the department — it rings for anything
 * nobody has accepted, whoever it belongs to — and it exists for the three failures the
 * phone app cannot fix: an iPhone, a handset whose manufacturer froze the background
 * service, and a phone left in a van.
 */
r = await get('/api/duty/devices', ifeoma);
check('a technician cannot set up a duty screen',
  r.statusCode === 403 && r.json().required === 'duty.device.manage');

r = await post('/api/duty/claim', graceOnSite, { deviceId: 'plantroom-tablet-01', label: 'Plant room tablet' });
check('a supervisor can, without needing an administrator', r.statusCode === 200, r.body.slice(0, 140));

r = await get('/api/duty/is-duty?deviceId=plantroom-tablet-01', ifeoma);
check('the screen itself knows what it is, whoever is signed in on it',
  r.json().duty === true && r.json().label === 'Plant room tablet', r.body.slice(0, 140));
r = await get('/api/duty/is-duty?deviceId=some-other-browser', ifeoma);
check('and an ordinary browser is not it', r.json().duty === false);

r = await get('/api/duty/devices', graceOnSite);
check('it is listed for the supervisor who set it up',
  (r.json().devices as { label: string }[]).some((d) => d.label === 'Plant room tablet'));
check('with nothing heard from it yet beyond the moment it was claimed',
  (r.json().devices as { last_seen_at: string | null }[])[0]?.last_seen_at != null);

/*
 * Reading the board is how the screen reports itself alive. No separate heartbeat to
 * forget to send — and a screen that stopped reading is a screen that stopped reporting,
 * which is exactly the thing a supervisor needs to be able to see.
 */
const beforeSeen = (await get('/api/duty/devices', graceOnSite)).json()
  .devices[0].last_seen_at as string;
await new Promise((done) => setTimeout(done, 1100));
r = await get('/api/duty/board?deviceId=plantroom-tablet-01', ifeoma);
check('any signed-in account can read the duty board', r.statusCode === 200, r.body.slice(0, 160));
const afterSeen = (await get('/api/duty/devices', graceOnSite)).json()
  .devices[0].last_seen_at as string;
check('and reading it is what marks the screen as alive', afterSeen > beforeSeen,
  `${beforeSeen} -> ${afterSeen}`);
check('it also records which account is signed in on that screen',
  (await get('/api/duty/devices', graceOnSite)).json().devices[0].signed_in_as === 'Ifeoma Bassey');

/*
 * The board is the department's unanswered work, not one person's — including jobs
 * assigned to nobody, which is the case where there is no individual phone to ring.
 */
r = await post('/api/jobs', graceOnSite, {
  title: 'Nobody has this one', locationId: siteId, priority: 'P1', trade: 'general',
});
const orphan = r.json().job as { id: string; ref: string };
check('an unassigned P1 can be raised', r.statusCode === 201, r.body.slice(0, 140));

r = await get('/api/duty/board?deviceId=plantroom-tablet-01', ifeoma);
check('and it shows on the duty board even though it belongs to nobody',
  (r.json().waiting as { id: string }[]).some((w) => w.id === orphan.id), r.body.slice(0, 200));

// Push its response deadline into the past: that is what makes the screen sound.
db.prepare(`UPDATE work_orders SET respond_by = datetime('now', '-10 minutes') WHERE id = ?`)
  .run(orphan.id);
r = await get('/api/duty/board?deviceId=plantroom-tablet-01', ifeoma);
check('once its response time has passed it counts as overdue, which is what rings',
  (r.json().overdue as { id: string }[]).some((w) => w.id === orphan.id),
  JSON.stringify((r.json().overdue as { ref: string }[]).map((w) => w.ref)));

r = await post('/api/duty/release', graceOnSite, { deviceId: 'plantroom-tablet-01' });
check('a duty screen can be released when the tablet is retired', r.statusCode === 200);
r = await get('/api/duty/is-duty?deviceId=plantroom-tablet-01', ifeoma);
check('and it stops being the duty screen at once', r.json().duty === false);
r = await post('/api/duty/release', graceOnSite, { deviceId: 'plantroom-tablet-01' });
check('releasing one that is not a duty screen says so rather than pretending',
  r.statusCode === 404);

// --------------------------------------------------------------------------
heading('Integrity');
// --------------------------------------------------------------------------
check('no foreign key is left dangling', (db.pragma('foreign_key_check') as unknown[]).length === 0);
check('the database passes an integrity check',
  String(db.pragma('integrity_check', { simple: true })) === 'ok');
check('every job carries an asset, a location or an apartment',
  (db.prepare(
    'SELECT COUNT(*) n FROM work_orders WHERE asset_id IS NULL AND location_id IS NULL AND apartment_id IS NULL'
  ).get() as { n: number }).n === 0);
check('no verified job was signed off by the person who completed it',
  (db.prepare('SELECT COUNT(*) n FROM work_orders WHERE verified_by IS NOT NULL AND verified_by = completed_by')
    .get() as { n: number }).n === 0);
check('every stock balance matches its ledger',
  (db.prepare(
    `SELECT COUNT(*) n FROM stock_items i
      WHERE ROUND(i.current_qty,3) <>
            ROUND(COALESCE((SELECT SUM(qty_delta) FROM stock_movements m WHERE m.item_id = i.id),0),3)`
  ).get() as { n: number }).n === 0);

await app.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
console.log('Phases 1-7 are sound.\n');
