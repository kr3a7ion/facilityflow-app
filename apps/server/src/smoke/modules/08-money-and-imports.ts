/**
 * Module checks, chapter 8 of 11:
 *  - Money is only for the people whose job it is
 *  - Taking something out of use
 *  - Ringing a device, and the emergency alert
 *  - Importing the unit list the department already has
 */
import { PW, app, check, db, get, heading, login, post } from './harness.js';
import type { Res } from './harness.js';
import { admin, femi, grace, halima, hod, ifeoma, musa, propertyId } from './01-setup.js';
import { coil, requisition } from './03-plant-and-stores.js';
import { chidi, civilTeam } from './06-first-run.js';

let r: Res;

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
export const ifeomaId = (db.prepare(`SELECT id FROM users WHERE username = 'ifeoma'`)
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

/*
 * Rings are stored as ISO text. The once-a-minute rule used to compare that against
 * SQLite's datetime('now'), whose space sorts before the ISO 'T' — so any ring earlier the
 * same day counted as "less than a minute ago" and the person could not be rung again
 * until midnight UTC.
 */
db.prepare('UPDATE ring_log SET at = ? WHERE id = ?')
  .run(new Date(Date.now() - 5 * 60_000).toISOString(), ringId);
r = await post(`/api/users/${ifeomaId}/ring`, grace, { reason: 'Again' });
check('a ring from five minutes ago does not block the next one',
  r.statusCode === 201, r.body.slice(0, 160));
const staleRing = r.json().id as string;
db.prepare('UPDATE ring_log SET at = ? WHERE id = ?')
  .run(new Date(Date.now() - 2 * 3600_000).toISOString(), staleRing);
check('and a ring left unanswered for two hours stops asking',
  !((await get('/api/me/rings', ifeoma)).json().rings as { id: string }[]).some((x) => x.id === staleRing));

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
const imp = r.json() as {
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
