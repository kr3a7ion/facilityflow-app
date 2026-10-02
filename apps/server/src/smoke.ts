/**
 * End-to-end smoke test for Phase 0. Runs against a throwaway database using
 * fastify's inject() — no ports, no timing races, safe to run in CI.
 *   npm run smoke
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, integrityCheck } from './db/connection.js';
import { migrate, appliedVersions } from './db/migrate.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { runBackup, stageRestore, applyPendingRestore, PENDING } from './db/backup.js';
import { runDailyBackup } from './services/scheduler.js';
import { readHostFile, writeHostFile } from './config.js';
import { hostStatus, backupSummary } from './services/host.js';
import { nextRef } from './lib/refs.js';
import { ulid } from './lib/ids.js';
import { assertKobo, formatNaira, nairaToKobo } from './lib/money.js';
import { PERMISSIONS, ROLES, ALL_CODES } from './auth/permissions.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function throws(name: string, fn: () => unknown): void {
  try { fn(); check(name, false, 'expected it to throw'); }
  catch { check(name, true); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-smoke-'));
const config = loadConfig({ dataDir: dir });
const db = openDb(config.dbPath);

console.log(`\nFacilityFlow smoke test\ndata dir: ${dir}\n`);

// ---- schema -----------------------------------------------------------------
const ran = migrate(db);
check('migrations apply from empty', ran.length >= 2, ran.join(','));
check('migrations are idempotent', migrate(db).length === 0);
check('schema versions recorded', appliedVersions(db).length === ran.length);
check('foreign_keys pragma is ON', db.pragma('foreign_keys', { simple: true }) === 1);
check('journal_mode is WAL', String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal');

throws('foreign keys reject an orphan row', () =>
  db.prepare(`INSERT INTO settings (property_id, key, value_json, updated_at)
              VALUES ('nope', 'k', '1', '2026-01-01T00:00:00.000Z')`).run());

// ---- helpers ----------------------------------------------------------------
check('ulid is 26 chars and sorts by time', (() => {
  const a = ulid(1000); const b = ulid(2000);
  return a.length === 26 && b.length === 26 && a < b;
})());
throws('money rejects a non-integer kobo value', () => assertKobo(12.5));
check('money formats naira', formatNaira(nairaToKobo(4280.5)) === '₦4,280.50', formatNaira(nairaToKobo(4280.5)));

// ---- permission catalogue ---------------------------------------------------
check('permission codes are unique', new Set(ALL_CODES).size === PERMISSIONS.length);
check('every role grant names a real permission', ROLES.every(
  (r) => r.permissions === '*' || r.permissions.every((c) => ALL_CODES.includes(c))
), ROLES.flatMap((r) => r.permissions === '*' ? [] : r.permissions.filter((c) => !ALL_CODES.includes(c))).join(','));
check('no role except admin holds admin.users.manage', ROLES.filter(
  (r) => r.permissions !== '*' && r.permissions.includes('admin.users.manage')
).length === 0);
check('technician cannot be granted verify by definition', !(
  ROLES.find((r) => r.key === 'technician')!.permissions as string[]).includes('wo.verify'));

const app = await buildApp(db, config);

// ---- first run --------------------------------------------------------------
let r = await app.inject({ method: 'GET', url: '/api/health' });
check('health responds before setup', r.statusCode === 200 && r.json().setupComplete === false);

r = await app.inject({ method: 'POST', url: '/api/setup', payload: {
  property: { name: 'Harmony Court Serviced Residences', shortName: 'Harmony Court', timezone: 'Africa/Lagos' },
  admin: { displayName: 'System Administrator', username: 'admin', password: 'correct-horse-battery' },
} });
check('setup creates property, roles and admin', r.statusCode === 201, r.body.slice(0, 120));
check('setup seeds the full permission catalogue', r.json().permissionsSeeded === PERMISSIONS.length);
check('setup creates every system role', r.json().rolesCreated === ROLES.length);

r = await app.inject({ method: 'POST', url: '/api/setup', payload: {
  property: { name: 'Second Property', shortName: 'Second', timezone: 'Africa/Lagos' },
  admin: { displayName: 'Sneaky Admin', username: 'sneaky', password: 'correct-horse-battery' },
} });
check('setup refuses to run twice', r.statusCode === 409);

// ---- authentication ---------------------------------------------------------
r = await app.inject({ method: 'POST', url: '/api/auth/login',
  payload: { username: 'admin', password: 'wrong-password' } });
check('wrong password is rejected', r.statusCode === 401);
check('wrong password does not reveal the username exists', r.json().error === 'invalid_credentials');

r = await app.inject({ method: 'POST', url: '/api/auth/login',
  payload: { username: 'admin', password: 'correct-horse-battery' } });
check('correct password signs in', r.statusCode === 200);
const adminCookie = r.cookies.find((c) => c.name === 'ff_sid');
check('session cookie is httpOnly and lax', !!adminCookie && adminCookie.httpOnly === true && adminCookie.sameSite === 'Lax');
const admin = { cookie: `ff_sid=${adminCookie?.value}` };

r = await app.inject({ method: 'GET', url: '/api/me', headers: admin });
check('signed-in identity resolves', r.statusCode === 200 && r.json().user.role === 'admin');
check('admin holds every permission', r.json().permissions.length === PERMISSIONS.length);

r = await app.inject({ method: 'GET', url: '/api/me' });
check('no cookie means not signed in', r.statusCode === 401);

// ---- RBAC -------------------------------------------------------------------
r = await app.inject({ method: 'POST', url: '/api/admin/users', headers: admin, payload: {
  displayName: 'Ifeoma Bassey', username: 'ifeoma', password: 'another-long-password', roleKey: 'technician',
} });
check('admin can create a technician', r.statusCode === 201);

r = await app.inject({ method: 'POST', url: '/api/admin/users', headers: admin, payload: {
  displayName: 'Duplicate', username: 'ifeoma', password: 'another-long-password', roleKey: 'technician',
} });
check('duplicate usernames are refused', r.statusCode === 409);

r = await app.inject({ method: 'POST', url: '/api/auth/login',
  payload: { username: 'ifeoma', password: 'another-long-password' } });
check('new user can sign in', r.statusCode === 200);
check('new user must change their password', r.json().mustChangePassword === true);
const tech = { cookie: `ff_sid=${r.cookies.find((c) => c.name === 'ff_sid')?.value}` };

r = await app.inject({ method: 'GET', url: '/api/admin/users', headers: tech });
check('technician is refused the admin user list', r.statusCode === 403);
check('refusal names the missing permission', r.json().required === 'admin.users.manage');

r = await app.inject({ method: 'GET', url: '/api/me', headers: tech });
const techMe = r.json();
check('technician cannot verify jobs', !techMe.permissions.includes('wo.verify'));
check('technician can complete jobs', techMe.permissions.includes('wo.complete'));
check('technician cannot see job costs', !techMe.permissions.includes('wo.cost.read'));
check('technician job access is scoped to their own', techMe.scopes['wo.read'] === 'own');

// ---- audit ------------------------------------------------------------------
r = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: admin });
const actions = (r.json().entries as { action: string }[]).map((e) => e.action);
check('audit recorded the setup', actions.includes('setup.complete'));
check('audit recorded a successful sign-in', actions.includes('auth.login'));
check('audit recorded the failed sign-in', actions.includes('auth.login.failed'));
check('audit recorded the new user', actions.includes('user.created'));
throws('audit_log refuses UPDATE', () => db.prepare(`UPDATE audit_log SET action='tampered'`).run());
throws('audit_log refuses DELETE', () => db.prepare('DELETE FROM audit_log').run());

r = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: tech });
check('technician cannot read the audit log', r.statusCode === 403);

// ---- self-disable guard -----------------------------------------------------
const adminId = (await app.inject({ method: 'GET', url: '/api/me', headers: admin })).json().user.id;
r = await app.inject({ method: 'POST', url: `/api/admin/users/${adminId}/disable`, headers: admin });
check('an admin cannot disable their own account', r.statusCode === 400);

// ---- references -------------------------------------------------------------
const propertyId = (db.prepare('SELECT id FROM properties LIMIT 1').get() as { id: string }).id;
const first = nextRef(db, propertyId, 'WO', 2026);
const second = nextRef(db, propertyId, 'WO', 2026);
check('job references increment per year', first === 'WO-2026-0001' && second === 'WO-2026-0002', `${first} ${second}`);
check('references are namespaced by prefix', nextRef(db, propertyId, 'PTW', 2026) === 'PTW-2026-0001');

// ---- the host PC -------------------------------------------------------------
// The Admin screen reports on the machine it is served by, so what it reports has to
// be established rather than guessed — and a bad host.json must never stop a boot.
{
  const status = await hostStatus(config, '0.1.0');
  check('host status reports the port it is actually on', status.port === config.port);
  check('and always offers a localhost address',
    status.addresses.some((a) => a.kind === 'local' && a.url.includes(String(config.port))));
  check('uptime is a real number, not a placeholder', status.uptimeSeconds >= 0);
  check('nothing is pending when nothing has been changed', status.pendingPort === null);

  // Off Windows there is no scheduled task to query, and saying so is the answer.
  check('the boot service reports honestly rather than guessing',
    status.bootService.state === 'registered' || status.bootService.state === 'missing'
    || (status.bootService.state === 'unknown' && typeof status.bootService.why === 'string'),
    JSON.stringify(status.bootService));
  check('so does the firewall check',
    status.firewall.state === 'open' || status.firewall.state === 'missing'
    || (status.firewall.state === 'unknown' && typeof status.firewall.why === 'string'));

  writeHostFile(config.dataDir, { port: 4808 });
  check('a saved port is read back', readHostFile(config.dataDir).port === 4808);
  const after = await hostStatus(config, '0.1.0');
  check('and shows as pending until the host restarts, not as in force',
    after.pendingPort === 4808 && after.port === config.port, String(after.pendingPort));

  // The department cannot fix JSON at 6am. A host that will not start is the worse failure.
  fs.writeFileSync(path.join(config.dataDir, 'host.json'), '{ this is not json', 'utf8');
  check('a corrupt host file is ignored rather than fatal',
    readHostFile(config.dataDir).port === undefined);
  check('and the server still resolves a usable port',
    loadConfig({ dataDir: config.dataDir }).port > 0);

  fs.writeFileSync(path.join(config.dataDir, 'host.json'), JSON.stringify({ port: 80 }), 'utf8');
  check('a port the host could not bind is refused on read',
    readHostFile(config.dataDir).port === undefined);
  fs.rmSync(path.join(config.dataDir, 'host.json'), { force: true });
}

r = await app.inject({ method: 'GET', url: '/api/admin/host', headers: tech });
check('a technician cannot read the host status', r.statusCode === 403);

r = await app.inject({ method: 'POST', url: '/api/admin/host/port', headers: admin,
  payload: { port: 80 } });
check('a privileged port is refused with a reason', r.statusCode === 400,
  r.json().message?.slice(0, 60));

r = await app.inject({ method: 'POST', url: '/api/admin/host/port', headers: admin,
  payload: { port: 4811 } });
check('an administrator can save a new port', r.statusCode === 200 && r.json().port === 4811,
  r.body.slice(0, 120));
check('and is told plainly that it is not live yet', r.json().restartRequired === true);
check('the change is on the audit trail',
  (db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'host.port.changed'")
    .get() as { n: number }).n === 1);
fs.rmSync(path.join(config.dataDir, 'host.json'), { force: true });

// ---- backup -----------------------------------------------------------------
r = await app.inject({ method: 'POST', url: '/api/admin/backup', headers: admin });
check('backup runs and verifies its own integrity', r.statusCode === 200 && r.json().integrity === 'ok');
check('backup file exists on disk', fs.existsSync(r.json().file));
const direct = runBackup(db, config);
check('backup keeps snapshots in the backups folder', direct.file.startsWith(config.backupsDir));

// The restore path is only as good as the newest snapshot beside it, and nobody is
// going to remember to press the button every Friday.
{
  const before = fs.readdirSync(config.backupsDir).filter((f) => f.endsWith('.db')).length;
  const first = runDailyBackup(db, config);
  const second = runDailyBackup(db, config);
  const after = fs.readdirSync(config.backupsDir).filter((f) => f.endsWith('.db')).length;
  check('the daily backup skips a day that already has a snapshot',
    second === false, `first=${first} second=${second}`);
  check('so restarting the host six times a morning does not prune the folder empty',
    after <= before + 1, `${before} → ${after}`);
}

// ---- download, and the restore path -----------------------------------------
// A backup that cannot leave this PC survives a mistake but not a dead machine, and a
// backup nobody can restore is not a backup at all. Both are exercised here.
{
  const name = path.basename(direct.file);

  r = await app.inject({ method: 'GET', url: `/api/admin/backups/${name}`, headers: admin });
  check('a snapshot can be downloaded off the host',
    r.statusCode === 200
    && String(r.headers['content-disposition']).includes(name)
    && r.rawPayload.length === direct.bytes,
    `${r.statusCode} ${r.rawPayload?.length} vs ${direct.bytes}`);
  check('and the bytes are a real SQLite file',
    r.rawPayload.subarray(0, 15).toString() === 'SQLite format 3');

  // The filename reaches the server from a request, so it has to be treated as hostile.
  r = await app.inject({
    method: 'GET', url: '/api/admin/backups/..%2F..%2Ffacilityflow.db', headers: admin,
  });
  check('a traversal in the filename cannot reach outside the backups folder',
    r.statusCode === 404, String(r.statusCode));

  r = await app.inject({ method: 'POST', url: '/api/admin/restore', headers: admin,
                         payload: { file: name } });
  check('a restore without the typed confirmation is refused',
    r.statusCode === 400 && r.json().error === 'confirm_required');

  r = await app.inject({ method: 'POST', url: '/api/admin/restore', headers: admin,
                         payload: { file: 'nothing-here.db', confirm: 'RESTORE' } });
  check('restoring a snapshot that does not exist is refused', r.statusCode === 400);

  // A corrupt file restored over a working one loses everything the corruption had not
  // yet reached, so the snapshot is opened and checked before it is ever staged.
  const junk = path.join(config.backupsDir, 'facilityflow-corrupt.db');
  fs.writeFileSync(junk, Buffer.from('this is not a database, it is a text file'));
  r = await app.inject({ method: 'POST', url: '/api/admin/restore', headers: admin,
                         payload: { file: 'facilityflow-corrupt.db', confirm: 'RESTORE' } });
  check('a file that is not a database is refused before anything is staged',
    r.statusCode === 400 && r.json().error === 'restore_refused', JSON.stringify(r.json()));
  fs.unlinkSync(junk);

  r = await app.inject({ method: 'POST', url: '/api/admin/restore', headers: admin,
                         payload: { file: name, confirm: 'RESTORE' } });
  check('a good snapshot stages', r.statusCode === 201 && r.json().integrity === 'ok',
    JSON.stringify(r.json()));
  const safety = r.json().safetyCopy as string;
  check('and the live database is copied out of the way first',
    fs.existsSync(path.join(config.backupsDir, safety)), safety);
  check('the staged file waits beside the database rather than replacing it',
    fs.existsSync(path.join(config.dataDir, PENDING)));

  r = await app.inject({ method: 'GET', url: '/api/admin/backups', headers: admin });
  check('the screen can tell a restore is waiting', r.json().pending === true);

  // Nothing has actually moved yet: staging must be reversible right up to the restart.
  r = await app.inject({ method: 'DELETE', url: '/api/admin/restore', headers: admin });
  check('a staged restore can be cancelled', r.statusCode === 200 && r.json().cancelled === true);
  check('and the staged file is gone', !fs.existsSync(path.join(config.dataDir, PENDING)));

  // The whole point, proved end to end: stage, apply the way boot does, and read it back.
  const before = (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n;
  const staged = stageRestore(config, name);
  check('staging returns the snapshot it staged', staged.from === name);
  const applied = applyPendingRestore(config);
  check('applying moves it into place where the database lives', applied === config.dbPath);
  const reopened = openDb(config.dbPath);
  check('the restored database opens and passes its integrity check',
    integrityCheck(reopened) === 'ok');
  check('and it holds the records the snapshot held',
    (reopened.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n === before);
  reopened.close();
  check('applying again does nothing, because nothing is staged',
    applyPendingRestore(config) === null);
}

// ---- session lifecycle ------------------------------------------------------
r = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: admin });
check('logout succeeds', r.statusCode === 200);
r = await app.inject({ method: 'GET', url: '/api/me', headers: admin });
check('a revoked session stops working immediately', r.statusCode === 401);

await app.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
console.log('Phase 0 is sound.\n');
