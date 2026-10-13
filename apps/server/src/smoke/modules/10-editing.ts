/**
 * Module checks, chapter 10 of 11:
 *  - Editing and deleting what was set up
 *  - A unit list imported twice
 *  - Specific response and resolve targets
 *  - Who is alerted, and the changeover
 */
import { remindDue } from '../../services/ppm.js';
import { tick } from '../../services/escalation.js';
import { PW, app, check, db, get, heading, iso, login, post } from './harness.js';
import type { Hdr, Res } from './harness.js';
import { admin, gen01, hod, ifeoma, plantId, propertyId, siteId, staffIds } from './01-setup.js';
import { ifeomaId } from './08-money-and-imports.js';
import { GRACE_PW } from './09-remote.js';

let r: Res;

// --------------------------------------------------------------------------
heading('Editing and deleting what was set up');
// --------------------------------------------------------------------------
/*
 * Retire is still how something leaves use. Delete is for the record that should never
 * have existed, and it is refused — naming what is in the way — whenever anything points
 * at the record.
 */
const patch = (url: string, headers: Hdr, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers, payload: payload as object });
const del = (url: string, headers: Hdr) => app.inject({ method: 'DELETE', url, headers });
const adminId = (db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: string }).id;

// ---- roles ------------------------------------------------------------------
const techRoleId = (db.prepare(`SELECT id FROM roles WHERE key = 'technician'`).get() as { id: string }).id;
r = await post('/api/admin/roles', admin,
  { name: 'Security Lead', description: 'Gate and patrol', copyFrom: techRoleId });
check('a role can be created as a copy of another', r.statusCode === 201, r.body.slice(0, 160));
const secRole = r.json().id as string;
check('its key is derived from the name', r.json().key === 'security_lead');
const grantsOf = (id: string) => db.prepare(
  'SELECT permission_code, scope FROM role_permissions WHERE role_id = ? ORDER BY permission_code').all(id);
check('and it carries the same grants, scopes included',
  JSON.stringify(grantsOf(secRole)) === JSON.stringify(grantsOf(techRoleId)));
r = await post('/api/admin/roles', admin, { name: 'security lead' });
check('a second role with the same name is refused', r.statusCode === 409);
r = await post('/api/admin/roles', ifeoma, { name: 'Sneaky' });
check('a technician cannot create roles', r.statusCode === 403);

r = await patch(`/api/admin/roles/${secRole}`, admin, { name: 'Security Supervisor', description: 'Runs the gate' });
check('a role can be renamed', r.statusCode === 200, r.body.slice(0, 140));
check('and its key does not move',
  (db.prepare('SELECT key FROM roles WHERE id = ?').get(secRole) as { key: string }).key === 'security_lead');
const adminRoleId = (db.prepare(`SELECT id FROM roles WHERE key = 'admin'`).get() as { id: string }).id;
r = await patch(`/api/admin/roles/${adminRoleId}`, admin, { name: 'Boss' });
check('the administrator role cannot be renamed', r.statusCode === 409);
r = await del(`/api/records/role/${techRoleId}`, admin);
check('a role that ships with the system cannot be deleted',
  r.statusCode === 409 && /ships with the system/.test(r.json().message), r.body.slice(0, 160));

r = await post('/api/admin/users', admin,
  { username: 'typo.guard', roleKey: 'security_lead', displayName: 'Typo Guard', password: PW });
check('an account can be given the new role', r.statusCode === 201, r.body.slice(0, 140));
const typoUser = r.json().id as string;
r = await get(`/api/records/role/${secRole}/deletable`, admin);
check('a role somebody holds is reported as not deletable before anyone tries',
  r.json().ok === false && /users/.test((r.json().blockers as string[]).join()), r.body.slice(0, 160));
r = await del(`/api/records/role/${secRole}`, admin);
check('and deleting it is refused, with the reason',
  r.statusCode === 409 && /Retire it instead/.test(r.json().message), r.body.slice(0, 160));

// ---- users ------------------------------------------------------------------
r = await del(`/api/records/user/${adminId}`, admin);
check('nobody can delete their own account', r.statusCode === 409, r.body.slice(0, 140));
r = await del(`/api/records/user/${ifeomaId}`, admin);
check('an account with a history cannot be deleted',
  r.statusCode === 409 && /audit log/.test(r.json().message), r.body.slice(0, 200));
r = await del(`/api/records/user/${typoUser}`, ifeoma);
check('a technician cannot delete accounts', r.statusCode === 403);
r = await del(`/api/records/user/${typoUser}`, admin);
check('an account created by mistake and never used is deleted', r.statusCode === 200, r.body.slice(0, 160));
check('and is gone', !db.prepare('SELECT 1 FROM users WHERE id = ?').get(typoUser));

r = await del(`/api/records/role/${secRole}`, admin);
check('once nobody holds it, the custom role can be deleted', r.statusCode === 200, r.body.slice(0, 160));
check('taking its grants with it', grantsOf(secRole).length === 0);

// ---- staff ------------------------------------------------------------------
r = await post('/api/staff', admin, { firstName: 'Dupli', lastName: 'Cate' });
const dupStaff = r.json().id as string;
r = await post(`/api/retire/staff/${dupStaff}`, admin, { active: false });
check('a person can be retired', r.statusCode === 200, r.body.slice(0, 140));
check('and drops out of the staff list',
  !((await get('/api/staff', admin)).json().staff as { id: string }[]).some((p) => p.id === dupStaff));
check('but the Staff tab can still find them',
  ((await get('/api/staff?all=1', admin)).json().staff as { id: string; is_active: number }[])
    .some((p) => p.id === dupStaff && p.is_active === 0));
r = await post(`/api/retire/staff/${dupStaff}`, admin, { active: true });
check('and bring them back', r.statusCode === 200);
r = await del(`/api/records/staff/${dupStaff}`, admin);
check('a person added twice by mistake is deleted', r.statusCode === 200, r.body.slice(0, 160));

const ifeomaStaffId = (db.prepare(`SELECT staff_id FROM users WHERE username = 'ifeoma'`)
  .get() as { staff_id: string }).staff_id;
r = await del(`/api/records/staff/${ifeomaStaffId}`, admin);
check('a person with a login and a history behind them is not deleted',
  r.statusCode === 409 && /Retire it instead/.test(r.json().message), r.body.slice(0, 200));

// ---- places -----------------------------------------------------------------
r = await post('/api/locations', admin, { type: 'block', code: 'BLK-X', name: 'Block X', parentId: siteId });
const blockX = r.json().id as string;
r = await post('/api/locations', admin, { type: 'floor', code: 'BLK-X-1', name: 'Floor 1', parentId: siteId });
const floorX = r.json().id as string;
r = await patch(`/api/locations/${floorX}`, admin, { parentId: blockX, name: 'First floor' });
check('a place can be renamed and moved', r.statusCode === 200, r.body.slice(0, 140));
check('and it lands where it was put',
  (db.prepare('SELECT parent_id FROM locations WHERE id = ?').get(floorX) as { parent_id: string })
    .parent_id === blockX);
r = await patch(`/api/locations/${blockX}`, admin, { parentId: floorX });
check('a place cannot be moved inside its own child', r.statusCode === 400 && r.json().error === 'cycle');
r = await patch(`/api/locations/${blockX}`, admin, { parentId: blockX });
check('nor inside itself', r.statusCode === 400);
r = await patch(`/api/locations/${blockX}`, admin, { code: 'PLANT-GEN' });
check('a code already in use is refused', r.statusCode === 409);
r = await patch(`/api/locations/${siteId}`, admin, { type: 'block' });
check('the site keeps its kind', r.statusCode === 409);
r = await patch(`/api/locations/${siteId}`, admin, { name: 'Harmony Court (main)' });
check('but can be renamed', r.statusCode === 200);

r = await del(`/api/records/location/${blockX}`, admin);
check('a place with places inside it is not deleted', r.statusCode === 409, r.body.slice(0, 160));
r = await del(`/api/records/location/${floorX}`, admin);
check('an empty place is deleted', r.statusCode === 200, r.body.slice(0, 160));
r = await del(`/api/records/location/${blockX}`, admin);
check('and then so is the one that held it', r.statusCode === 200);
r = await del(`/api/records/location/${siteId}`, admin);
check('the site can never be deleted', r.statusCode === 409);
r = await del(`/api/records/location/${plantId}`, admin);
check('a place with jobs or assets is not deleted', r.statusCode === 409, r.body.slice(0, 160));

r = await post('/api/locations', admin, { type: 'external', code: 'OLD-YARD', name: 'Old yard', parentId: siteId });
r = await post(`/api/retire/location/${r.json().id}`, admin, { active: false });
check('a retired place is hidden from pickers',
  !((await get('/api/locations', admin)).json().locations as { code: string }[]).some((l) => l.code === 'OLD-YARD'));
check('and listed for the Places tab with ?all=1',
  ((await get('/api/locations?all=1', admin)).json().locations as { code: string; is_active: number }[])
    .some((l) => l.code === 'OLD-YARD' && l.is_active === 0));

r = await del(`/api/records/spaceship/${blockX}`, admin);
check('an unknown kind is a 404, never a table name from the request', r.statusCode === 404);
r = await get('/api/admin/audit?limit=300', admin);
check('every deletion is audited',
  ((r.json().entries as { action: string }[]) ?? []).filter((e) => e.action === 'record.deleted').length >= 4,
  r.body.slice(0, 120));
check('and no password hash ever lands in the audit log',
  !db.prepare(`SELECT 1 FROM audit_log WHERE before_json LIKE '%password_hash%'`).get());

// --------------------------------------------------------------------------
heading('A unit list imported twice');
// --------------------------------------------------------------------------
/*
 * The real failure: a list imported once correctly, then again with the name column picked
 * as the unit number. Every row looked new, the register doubled, and jobs were raised
 * against the copies before anybody noticed.
 */
r = await post('/api/apartments/import', admin, {
  source: 'csv', units: [
    { unitNo: '101', block: 'DUP', name: 'Lisbon' },
    { unitNo: '102', block: 'DUP', name: 'Porto' },
    { unitNo: '103', block: 'DUP', name: 'Faro' },
    { unitNo: '104', block: 'DUP', name: 'Braga' },
  ],
});
check('the list goes in once', r.statusCode === 201 && r.json().created === 4, r.body.slice(0, 140));

r = await post('/api/apartments/import', admin, {
  source: 'csv', units: [
    { unitNo: 'Lisbon', block: 'DUP', name: 'Lisbon' },
    { unitNo: 'Porto', block: 'DUP', name: 'Porto' },
    { unitNo: 'Faro', block: 'DUP', name: 'Faro' },
  ],
});
check('a list whose unit numbers are all its names is refused outright',
  r.statusCode === 409 && r.json().error === 'names_as_numbers', r.body.slice(0, 160));

r = await post('/api/apartments/import/read', admin, {
  text: 'Block,Unit No,Name\nDUP,101,Lisbon\nDUP,102,Porto\n',
  mapping: { unit_no: 'Name', name: 'Name' },
});
check('the preview says so when number and name are the same column',
  r.statusCode === 200 && !!r.json().mappingProblem && r.json().wouldCreate === 0, r.body.slice(0, 200));

r = await post('/api/apartments/import', admin, {
  source: 'csv', units: [{ unitNo: 'Lisbon', block: 'DUP' }, { unitNo: '105', block: 'DUP', name: 'Evora' }],
});
check('a unit number that is an existing unit’s name is recognised as that unit',
  r.statusCode === 201 && r.json().created === 1, r.body.slice(0, 160));

// Make the mess the department actually had, the way it got made: straight into the table.
const aptRows = () => db.prepare(`SELECT id, unit_no, name, location_id FROM apartments WHERE block = 'DUP'`)
  .all() as { id: string; unit_no: string; name: string | null; location_id: string }[];
const site = siteId;
for (const name of ['Lisbon', 'Porto', 'Faro']) {
  const at = new Date().toISOString();
  const loc = `LOC-COPY-${name}`;
  db.prepare(`INSERT INTO locations (id, property_id, parent_id, type, code, name, created_at, updated_at)
              VALUES (?, ?, ?, 'apartment', ?, ?, ?, ?)`).run(loc, propertyId, site, loc, name, at, at);
  db.prepare(`INSERT INTO apartments (id, property_id, location_id, unit_no, block, name, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'DUP', ?, 'vacant_ready', ?, ?)`)
    .run(`APT-COPY-${name}`, propertyId, loc, name, name, at, at);
}
r = await post('/api/jobs', admin, {
  title: 'Dripping tap', apartmentId: 'APT-COPY-Porto', priority: 'P3', trade: 'plumbing',
});
check('a job can land on a copy, as it did on site', r.statusCode === 201, r.body.slice(0, 140));
const copyJob = r.json().job.id as string;

r = await get('/api/apartments/duplicates', admin);
const found = r.json().duplicates as { duplicate: { id: string }; target: { id: string; unitNo: string } | null; attached: number }[];
check('the copies are found', found.length === 3, JSON.stringify(found.map((d) => d.duplicate.id)));
check('each is paired with the unit it copies',
  found.find((d) => d.duplicate.id === 'APT-COPY-Porto')?.target?.unitNo === '102');
check('and the one with a job on it says so',
  found.find((d) => d.duplicate.id === 'APT-COPY-Porto')?.attached === 1);
r = await get('/api/apartments/duplicates', ifeoma);
check('a technician cannot see the clean-up', r.statusCode === 403);

r = await post('/api/records/apartment/delete-batch', admin, { ids: ['APT-COPY-Porto', 'APT-COPY-Faro'] });
check('a batch delete removes what it can', r.statusCode === 200 && r.json().deleted === 1, r.body.slice(0, 200));
check('and refuses the copy with a job on it, by name',
  r.json().refused === 1 && /work orders/.test(
    (r.json().results as { id: string; ok: boolean; message: string }[]).find((x) => !x.ok)?.message ?? ''),
  r.body.slice(0, 300));
check('a deleted unit takes its place with it',
  !db.prepare(`SELECT 1 FROM locations WHERE id = 'LOC-COPY-Faro'`).get());

const porto = aptRows().find((a) => a.unit_no === '102')!;
r = await post('/api/apartments/merge', admin, {
  pairs: [{ duplicateId: 'APT-COPY-Porto', targetId: porto.id }, { duplicateId: 'APT-COPY-Lisbon', targetId: 'nope' }],
});
check('copies are merged into the real units', r.statusCode === 200 && r.json().merged === 1, r.body.slice(0, 200));
check('a pair that cannot be merged is reported, not fatal', r.json().failed === 1);
check('the job moved onto the real unit',
  (db.prepare('SELECT apartment_id FROM work_orders WHERE id = ?').get(copyJob) as { apartment_id: string })
    .apartment_id === porto.id);
check('and the copy and its place are gone',
  !db.prepare(`SELECT 1 FROM apartments WHERE id = 'APT-COPY-Porto'`).get()
  && !db.prepare(`SELECT 1 FROM locations WHERE id = 'LOC-COPY-Porto'`).get());
r = await del(`/api/records/apartment/${porto.id}`, admin);
check('the real unit, now carrying the job, cannot be deleted', r.statusCode === 409);

r = await del('/api/records/apartment/APT-COPY-Lisbon', admin);
check('a copy with nothing on it deletes on its own', r.statusCode === 200, r.body.slice(0, 160));
check('leaving no duplicates behind',
  ((await get('/api/apartments/duplicates', admin)).json().duplicates as unknown[]).length === 0);
r = await post('/api/records/apartment/delete-batch', ifeoma, { ids: [porto.id] });
check('a technician cannot batch delete', r.statusCode === 403);

// --------------------------------------------------------------------------
heading('Specific response and resolve targets');
// --------------------------------------------------------------------------
{
  const mins = (job: { reported_at: string; respond_by: string }) =>
    Math.round((new Date(job.respond_by).getTime() - new Date(job.reported_at).getTime()) / 60000);
  const raise = async (trade: string, locationId: string, title: string) => {
    const res = await post('/api/jobs', admin, { title, trade, locationId, priority: 'P2' });
    if (res.statusCode !== 201) throw new Error(`could not raise ${title}: ${res.body}`);
    return res.json().job as { id: string; reported_at: string; respond_by: string; sla_rule_id: string | null };
  };

  r = await post('/api/locations', admin, { type: 'block', code: 'BLK-SLA', name: 'Block S', parentId: siteId });
  const blockS = r.json().id as string;
  r = await post('/api/locations', admin, { type: 'floor', code: 'BLK-SLA-3', name: 'Block S floor 3', parentId: blockS });
  const floorS3 = r.json().id as string;
  check('a block with a floor under it to aim rules at', !!blockS && !!floorS3);

  r = await post('/api/admin/sla-rules', ifeoma, { priority: 'P2', trade: 'electrical', respondMinutes: 30 });
  check('a technician cannot write a target rule', r.statusCode === 403);
  r = await post('/api/admin/sla-rules', admin, { priority: 'P2', respondMinutes: 30 });
  check('a rule with no trade and no place is refused — that is the default row',
    r.statusCode === 400 && r.json().error === 'no_scope', r.body.slice(0, 160));
  r = await post('/api/admin/sla-rules', admin, { priority: 'P2', trade: 'electrical' });
  check('a rule that changes nothing is refused',
    r.statusCode === 400 && r.json().error === 'no_change', r.body.slice(0, 160));
  r = await post('/api/admin/sla-rules', admin, { priority: 'P2', trade: 'welding', respondMinutes: 30 });
  check('a trade the property does not have is refused', r.statusCode === 400 && r.json().error === 'unknown_trade');
  r = await post('/api/admin/sla-rules', admin, { priority: 'P2', trade: 'electrical', resolveMinutes: 30 });
  check('resolving faster than the default response is refused, judged on what the job would get',
    r.statusCode === 400 && r.json().error === 'resolve_before_respond', r.body.slice(0, 200));
  r = await post('/api/admin/sla-rules', admin, { priority: 'P2', trade: 'electrical', escalateToRole: 'nobody' });
  check('escalating to a role that does not exist is refused', r.statusCode === 400 && r.json().error === 'unknown_role');

  r = await post('/api/admin/sla-rules', admin,
    { priority: 'P2', trade: 'Electrical', respondMinutes: 30, note: 'Lifts and DBs' });
  check('a trade rule is created', r.statusCode === 201, r.body.slice(0, 200));
  const tradeRule = r.json().rule as { id: string; trade: string };
  check('and its trade is stored the way jobs carry it', tradeRule.trade === 'electrical');
  r = await post('/api/admin/sla-rules', admin, { priority: 'P2', trade: 'electrical', respondMinutes: 45 });
  check('a second rule for the same priority, trade and place is refused',
    r.statusCode === 409 && r.json().error === 'duplicate_rule');

  const elecAtSite = await raise('electrical', siteId, 'SLA: electrical, no place rule');
  check('a P2 electrical job takes the trade rule (30 minutes, not 60)', mins(elecAtSite) === 30, String(mins(elecAtSite)));
  check('and records which rule it took', elecAtSite.sla_rule_id === tradeRule.id);
  r = await get(`/api/jobs/${elecAtSite.id}`, admin);
  check('the job card can say why', r.json().slaRule === 'P2 · electrical', String(r.json().slaRule));
  const plumbAtSite = await raise('plumbing', siteId, 'SLA: plumbing, nothing applies');
  check('a P2 plumbing job keeps the default', mins(plumbAtSite) === 60 && plumbAtSite.sla_rule_id === null);

  r = await post('/api/admin/sla-rules', admin,
    { priority: 'P2', locationId: blockS, respondMinutes: 20, escalateToRole: 'hod' });
  check('a place rule is created', r.statusCode === 201, r.body.slice(0, 200));
  const blockRule = r.json().rule as { id: string };
  const plumbOnFloor = await raise('plumbing', floorS3, 'SLA: plumbing on a floor of the block');
  check('a job on a floor takes the rule on the block above it', mins(plumbOnFloor) === 20, String(mins(plumbOnFloor)));
  const elecOnFloor = await raise('electrical', floorS3, 'SLA: electrical on a floor of the block');
  check('a place rule beats a trade rule', mins(elecOnFloor) === 20 && elecOnFloor.sla_rule_id === blockRule.id);

  r = await post('/api/admin/sla-rules', admin,
    { priority: 'P2', trade: 'electrical', locationId: blockS, respondMinutes: 10 });
  const bothRule = r.json().rule as { id: string };
  const elecOnFloor2 = await raise('electrical', floorS3, 'SLA: electrical on the floor, both rule');
  check('a rule naming both the trade and the place beats either alone', mins(elecOnFloor2) === 10 && elecOnFloor2.sla_rule_id === bothRule.id);

  r = await post('/api/admin/sla-rules', admin, { priority: 'P2', locationId: floorS3, respondMinutes: 25 });
  const floorRule = r.json().rule as { id: string };
  const plumbOnFloor2 = await raise('plumbing', floorS3, 'SLA: plumbing, floor rule and block rule');
  check('the nearer place wins: the floor\'s rule over the block\'s',
    mins(plumbOnFloor2) === 25 && plumbOnFloor2.sla_rule_id === floorRule.id);

  r = await get(`/api/admin/sla-rules/preview?priority=P2&trade=plumbing&locationId=${floorS3}`, admin);
  check('the preview gives the same answer the job got',
    r.json().respondMinutes === 25 && r.json().ruleId === floorRule.id, r.body.slice(0, 200));

  r = await get('/api/admin/sla-rules', admin);
  check('the list carries all four live rules', (r.json().rules as unknown[]).length === 4);

  r = await patch(`/api/admin/sla-rules/${tradeRule.id}`, admin,
    { priority: 'P2', trade: 'electrical', respondMinutes: 35, note: null });
  check('a rule can be edited', r.statusCode === 200 && r.json().rule.respond_minutes === 35, r.body.slice(0, 200));
  r = await patch(`/api/admin/sla-rules/${tradeRule.id}`, admin,
    { priority: 'P2', trade: 'electrical', locationId: blockS, respondMinutes: 35 });
  check('but not into a copy of another rule', r.statusCode === 409);
  const before = (db.prepare('SELECT respond_by FROM work_orders WHERE id = ?').get(elecAtSite.id) as { respond_by: string }).respond_by;
  check('editing a rule does not move a deadline already set', before === elecAtSite.respond_by);

  r = await del(`/api/admin/sla-rules/${tradeRule.id}`, admin);
  check('a rule can be deleted', r.statusCode === 200 && r.json().jobsKeepTheirDeadlines >= 1, r.body.slice(0, 160));
  const elecAfter = await raise('electrical', siteId, 'SLA: electrical after the rule went');
  check('new jobs go back to the default', mins(elecAfter) === 60 && elecAfter.sla_rule_id === null);
  check('the old job still points at the rule that set its deadline',
    (db.prepare('SELECT sla_rule_id FROM work_orders WHERE id = ?').get(elecAtSite.id) as { sla_rule_id: string }).sla_rule_id === tradeRule.id);
  r = await post('/api/admin/sla-rules', admin, { priority: 'P2', trade: 'electrical', respondMinutes: 40 });
  check('and the same rule can be made again once deleted', r.statusCode === 201, r.body.slice(0, 160));
  r = await patch(`/api/admin/sla-rules/${tradeRule.id}`, admin, { priority: 'P2', trade: 'electrical', respondMinutes: 50 });
  check('a deleted rule cannot be edited', r.statusCode === 404);

  // Escalation reaches the person the job's own rule names.
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
  db.prepare('UPDATE work_orders SET reported_at = ?, respond_by = ?, due_at = ? WHERE id = ?')
    .run(past, past, past, plumbOnFloor.id);
  const escalated = tick(db, propertyId).escalated.find((e) => e.id === plumbOnFloor.id);
  check('a breached job escalates to the role its rule names (hod), not the P2 default',
    escalated?.role === 'hod', JSON.stringify(escalated));

  r = await get('/api/admin/settings', admin);
  const matrix = r.json().settings.sla_matrix as { priority: string; escalateToRole: string }[];
  r = await post('/api/admin/settings', admin,
    { key: 'sla_matrix', value: matrix.map((m) => (m.priority === 'P3' ? { ...m, escalateToRole: 'nobody' } : m)) });
  check('the default table cannot escalate to a role that does not exist',
    r.statusCode === 400 && r.json().error === 'unknown_role', r.body.slice(0, 160));

  const logged = db.prepare(
    `SELECT action FROM audit_log WHERE entity_type = 'sla_rule' GROUP BY action ORDER BY action`
  ).all() as { action: string }[];
  check('rules are created, edited and deleted on the audit log',
    logged.map((l) => l.action).join(',') === 'sla_rule.created,sla_rule.deleted,sla_rule.updated',
    JSON.stringify(logged));
}

// --------------------------------------------------------------------------
heading('Who is alerted, and the changeover');
// --------------------------------------------------------------------------
{
  // Grace changed her password earlier in the suite, which ended her old session.
  const grace = await login('grace', GRACE_PW);
  const userOf = (u: string) => (db.prepare('SELECT id FROM users WHERE username = ?').get(u) as { id: string }).id;
  const latest = (u: string, kind: string) => db.prepare(
    `SELECT kind, title, body, level FROM notifications WHERE user_id = ? AND kind = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(userOf(u), kind) as { kind: string; title: string; body: string | null; level: string | null } | undefined;
  const count = (u: string, kind: string) => (db.prepare(
    'SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = ?'
  ).get(userOf(u), kind) as { n: number }).n;

  // ---- the catalogue and its settings
  r = await get('/api/admin/alert-routing', ifeoma);
  check('a technician cannot see or change alert routing', r.statusCode === 403);
  r = await get('/api/admin/alert-routing', admin);
  const events = r.json().events as { key: string; routing: { roles: string[]; level: string } }[];
  for (const k of ['wo.completed', 'ppm.due_soon', 'ppm.due_today', 'power.mains_off', 'power.genset_fault',
                   'fuel_low', 'fuel_delivered', 'stock_low']) {
    check(`the catalogue lists ${k}`, events.some((e) => e.key === k));
  }
  check('mains failing is urgent by default',
    events.find((e) => e.key === 'power.mains_off')?.routing.level === 'urgent');
  r = await app.inject({ method: 'PUT', url: '/api/admin/alert-routing/power.mains_off', headers: admin,
                         payload: { roles: ['nobody'] } });
  check('routing to a role that does not exist is refused', r.statusCode === 400 && r.json().error === 'unknown_role');
  r = await app.inject({ method: 'PUT', url: '/api/admin/alert-routing/power.mains_off', headers: admin,
                         payload: { roles: [], context: [] } });
  check('routing an event to nobody is refused', r.statusCode === 400 && r.json().error === 'nobody');
  r = await app.inject({ method: 'PUT', url: '/api/admin/alert-routing/power.mains_off', headers: admin,
                         payload: { context: ['@reporter'] } });
  check('a person an event cannot reach is refused', r.statusCode === 400 && r.json().error === 'bad_context');
  r = await app.inject({ method: 'PUT', url: '/api/admin/alert-routing/no.such', headers: admin, payload: {} });
  check('an unknown event is a 404', r.statusCode === 404);

  // ---- completion reaches whoever reported it; sign-off is good news
  r = await post('/api/jobs', admin, { title: 'Alerts: reported by the admin', trade: 'general',
                                       locationId: siteId, priority: 'P3' });
  const reported = r.json().job as { id: string; ref: string };
  r = await post(`/api/jobs/${reported.id}/assign`, grace, { staffId: staffIds['ifeoma']! });
  await post(`/api/jobs/${reported.id}/accept`, ifeoma);
  await post(`/api/jobs/${reported.id}/start`, ifeoma);
  r = await post(`/api/jobs/${reported.id}/complete`, ifeoma, { resolutionNotes: 'Done and tested.' });
  check('the job completes', r.statusCode === 200, r.body.slice(0, 160));
  check('whoever reported it is told it is done', latest('admin', 'wo.completed')?.title === `${reported.ref} is ready to verify`);
  check('and the supervisor still is', latest('grace', 'wo.completed')?.title === `${reported.ref} is ready to verify`);
  check('at the routed loudness', latest('grace', 'wo.completed')?.level === 'chime');
  check('the person who did it is not told about their own work',
    latest('ifeoma', 'wo.completed')?.title !== `${reported.ref} is ready to verify`);
  await post(`/api/jobs/${reported.id}/verify`, grace);
  check('sign-off reaches whoever did the work as good news', latest('ifeoma', 'wo.verified')?.level === 'good');

  // ---- escalations are finally loud
  check('escalations are stored as urgent',
    (db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'escalation' AND level = 'urgent'`).get() as { n: number }).n > 0);

  // ---- diesel delivered
  check('a diesel delivery puts a quiet line on the supervisor\'s bell',
    (db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'fuel_delivered' AND level = 'quiet'`).get() as { n: number }).n > 0);

  // ---- planned work coming due, then due today
  r = await post('/api/ppm/schedules', grace, {
    name: 'Alerts: weekly changeover test', scopeType: 'asset', assetId: gen01,
    triggerType: 'calendar', intervalValue: 7, intervalUnit: 'day', firstDueAt: iso(0), priority: 'P4',
  });
  const before = count('musa', 'ppm.due_soon');
  r = await post('/api/ppm/generate', grace);
  check('planned work coming due is generated', r.json().created.length >= 1, r.body.slice(0, 160));
  check('and the team lead is told it is coming', count('musa', 'ppm.due_soon') === before + 1);
  const dueToday = (db.prepare(
    `SELECT id, ref FROM work_orders WHERE source = 'ppm' AND title LIKE 'Alerts: weekly changeover test%'`
  ).get() as { id: string; ref: string });
  const n1 = remindDue(db, propertyId);
  check('a planned job due today is reminded about', n1 >= 1 && latest('grace', 'ppm.due_today') !== undefined, String(n1));
  check('naming the job', (db.prepare(
    `SELECT COUNT(*) n FROM notifications WHERE kind = 'ppm.due_today' AND entity_id = ?`).get(dueToday.id) as { n: number }).n > 0);
  check('and only once', remindDue(db, propertyId) === 0);

  // ---- the changeover
  r = await post('/api/power/changeover', grace, { event: 'mains_on' });
  check('mains cannot be restored while it is on', r.statusCode === 409 && r.json().error === 'already_on');
  r = await post('/api/power/changeover', grace, { event: 'mains_off', note: 'PHCN gone' });
  check('mains failing is recorded', r.statusCode === 201 && r.json().mains === 'off', r.body.slice(0, 200));
  check('technicians are told, urgently', latest('ifeoma', 'power.mains_off')?.level === 'urgent');
  check('with the time on the property\'s clock', /^Mains failed at \d\d:\d\d$/.test(latest('ifeoma', 'power.mains_off')?.title ?? ''));
  check('the person who recorded it is not told', latest('grace', 'power.mains_off') === undefined);
  r = await get('/api/status/plant', grace);
  check('the status strip shows mains off', r.json().utility.state === 'off');
  r = await post('/api/power/changeover', ifeoma, { event: 'mains_off' });
  check('mains cannot fail twice', r.statusCode === 409 && r.json().error === 'already_off');

  r = await post('/api/power/changeover', ifeoma, { event: 'genset_start' });
  check('a generator event has to say which set', r.statusCode === 400 && r.json().error === 'unknown_genset');
  r = await post('/api/power/changeover', ifeoma, { event: 'genset_start', gensetAssetId: gen01 });
  check('a technician records a set starting', r.statusCode === 201, r.body.slice(0, 200));
  r = await get('/api/status/plant', grace);
  const g01 = (r.json().gensets as { runningSince: string | null; tag: string }[]).find((g) => g.runningSince);
  check('the status strip knows it is running', !!g01);
  check('the team lead is told', /started$/.test(latest('musa', 'power.genset_start')?.title ?? ''));
  r = await post('/api/power/changeover', ifeoma, { event: 'genset_start', gensetAssetId: gen01 });
  check('a running set cannot start again', r.statusCode === 409 && r.json().error === 'already_running');

  r = await post('/api/power/changeover', grace, { event: 'mains_on' });
  check('mains is restored', r.statusCode === 201 && r.json().mains === 'on');
  check('and the message says the set is still running',
    /still running/.test(latest('musa', 'power.mains_on')?.body ?? ''), latest('musa', 'power.mains_on')?.body ?? '');
  r = await post('/api/power/changeover', ifeoma, { event: 'genset_stop', gensetAssetId: gen01 });
  check('the set is stopped, with how long it ran', r.statusCode === 201 && typeof r.json().ranMinutes === 'number');
  check('and asks for the run to be logged', /Log the run/.test(latest('grace', 'power.genset_stop')?.body ?? ''));
  r = await post('/api/power/changeover', ifeoma, { event: 'genset_stop', gensetAssetId: gen01 });
  check('a stopped set cannot stop again', r.statusCode === 409 && r.json().error === 'not_running');

  r = await post('/api/power/changeover', ifeoma, { event: 'genset_fault', gensetAssetId: gen01, note: 'Low oil pressure trip' });
  check('a fault is recorded', r.statusCode === 201);
  check('and takes the set out of service',
    (db.prepare('SELECT status FROM assets WHERE id = ?').get(gen01) as { status: string }).status === 'faulty');
  check('the head of department is told, urgently, with the reason',
    latest('hod', 'power.genset_fault')?.level === 'urgent' && /Low oil pressure/.test(latest('hod', 'power.genset_fault')?.body ?? ''));
  r = await post('/api/power/changeover', ifeoma, { event: 'genset_start', gensetAssetId: gen01 });
  check('a faulty set cannot be started', r.statusCode === 409 && r.json().error === 'not_available');
  r = await post('/api/power/changeover', ifeoma, { event: 'mains_off', at: iso(1) });
  check('a changeover cannot be recorded in the future', r.statusCode === 400 && r.json().error === 'future');

  r = await get('/api/power/now', grace);
  check('the changeover history is kept in order', (r.json().history as { event: string }[])
    .slice(0, 5).map((h) => h.event).join(',') === 'genset_fault,genset_stop,mains_on,genset_start,mains_off',
    JSON.stringify((r.json().history as { event: string }[]).map((h) => h.event)));

  // ---- routing changes take effect at once, and reset
  r = await app.inject({ method: 'PUT', url: '/api/admin/alert-routing/power.mains_off', headers: admin,
                         payload: { roles: ['supervisor'], level: 'chime' } });
  check('routing can be changed', r.statusCode === 200 && r.json().routing.level === 'chime');
  const techBefore = count('ifeoma', 'power.mains_off');
  await post('/api/power/changeover', hod, { event: 'mains_off' });
  check('a technician taken off the routing is no longer told', count('ifeoma', 'power.mains_off') === techBefore);
  check('and the supervisor hears it at the new loudness', latest('grace', 'power.mains_off')?.level === 'chime');
  r = await app.inject({ method: 'PUT', url: '/api/admin/alert-routing/power.mains_on', headers: admin,
                         payload: { off: true } });
  const supBefore = count('grace', 'power.mains_on');
  await post('/api/power/changeover', hod, { event: 'mains_on' });
  check('an event switched off tells nobody', count('grace', 'power.mains_on') === supBefore);
  r = await app.inject({ method: 'DELETE', url: '/api/admin/alert-routing/power.mains_off', headers: admin });
  check('routing resets to the default', r.statusCode === 200 && r.json().routing.level === 'urgent'
    && (r.json().routing.roles as string[]).includes('technician'));
  check('routing changes are audited',
    (db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'alert_routing.%'`).get() as { n: number }).n >= 3);

  // Leave the set as the rest of the suite found it.
  db.prepare(`UPDATE assets SET status = 'in_service' WHERE id = ?`).run(gen01);
}
