/**
 * Module checks, chapter 1 of 11:
 *  - Setup and accounts
 *  - Registry — locations, apartments, assets
 *  - Roster — availability gates assignment
 */
import { PROPERTY_TZ, PW, check, day, db, get, heading, login, post } from './harness.js';
import type { Hdr } from './harness.js';

// --------------------------------------------------------------------------
heading('Setup and accounts');
// --------------------------------------------------------------------------
let r = await post('/api/setup', { cookie: '' } as Hdr, {
  property: { name: 'Harmony Court Serviced Residences', shortName: 'Harmony Court', timezone: PROPERTY_TZ },
  admin: { displayName: 'System Administrator', username: 'admin', password: PW },
});
check('property is configured', r.statusCode === 201, r.body.slice(0, 120));
export const admin = await login('admin', PW);

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
export const grace = await login('grace', PW);
export const musa = await login('musa', PW);
export const ifeoma = await login('ifeoma', PW);
export const halima = await login('halima', PW);
export const femi = await login('femi', PW);
export const hod = await login('hod', PW);
check('one account per role signs in', true);

export const propertyId = (db.prepare('SELECT id FROM properties LIMIT 1').get() as { id: string }).id;

// --------------------------------------------------------------------------
heading('Registry — locations, apartments, assets');
// --------------------------------------------------------------------------
// Setup already made the site; a second one on the same code is refused rather than
// quietly creating a parallel tree.
r = await post('/api/locations', admin, { type: 'site', code: 'SITE', name: 'Harmony Court' });
check('a duplicate site code is refused, not silently accepted',
  r.statusCode === 409 && r.json().error === 'duplicate_code', r.body.slice(0, 120));
export const siteId = rootSite!.id;

r = await post('/api/locations', admin, { type: 'plant_room', code: 'PLANT-GEN', name: 'Generator house', parentId: siteId });
export const plantId = r.json().id;
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
export const apt = (r.json().apartments as { id: string; unit_no: string }[]).find((a) => a.unit_no === 'A-1204')!;
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
export const gen01 = r.json().id;
check('asset created with a tag', r.statusCode === 201);

r = await post('/api/assets', admin, { assetTag: 'GEN-01', name: 'Duplicate', locationId: plantId });
check('a duplicate asset tag is refused', r.statusCode === 409);

r = await post('/api/assets', admin, {
  assetTag: 'AC-A1204-01', name: 'Split AC — A-1204', categoryId: acCategory, apartmentId: apt.id,
});
export const acAsset = r.json().id;
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
export const staffIds: Record<string, string> = {};
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
export const afternoon = r.json().id;
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
