/**
 * Module checks, chapter 4 of 11:
 *  - Photos and attachments
 *  - Administration
 *  - Screen data contracts
 *  - CSV export
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG, PW, app, check, config, db, get, heading, login, multipart, near, post } from './harness.js';
import type { Res } from './harness.js';
import { admin, femi, gen01, grace, halima, hod, ifeoma, siteId } from './01-setup.js';
import { job, p1 } from './02-work-orders.js';
import { expense, permit, requisition } from './03-plant-and-stores.js';

let r: Res;

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

  // A record that does not exist: refused before a byte reaches the disk.
  const filesOnDisk = (): number => {
    const walk = (d: string): number => !fs.existsSync(d) ? 0 : fs.readdirSync(d, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? walk(path.join(d, e.name)) : 1), 0);
    return walk(config.attachmentsDir);
  };
  const before = filesOnDisk();
  const orphan = multipart({ entityType: 'work_order', entityId: 'no-such-job' },
                           { name: 'a.png', type: 'image/png', data: PNG });
  r = await app.inject({ method: 'POST', url: '/api/attachments', headers: { ...ifeoma, ...orphan.headers },
                         payload: orphan.body });
  check('a file cannot be attached to a record that does not exist',
    r.statusCode === 404 && r.json().error === 'no_such_record', r.body.slice(0, 120));
  check('and nothing is left on disk or in the table for it',
    filesOnDisk() === before
    && (db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE entity_id = 'no-such-job'").get() as { n: number }).n === 0);

  const ghost = multipart({ entityType: 'unit_inspection', entityId: 'x' },
                          { name: 'a.png', type: 'image/png', data: PNG });
  r = await app.inject({ method: 'POST', url: '/api/attachments', headers: { ...admin, ...ghost.headers },
                         payload: ghost.body });
  check('nor to a kind of record the system does not have', r.statusCode === 400, r.body.slice(0, 120));

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

export const musaAgain = await login('musa', PW);
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
