/**
 * Module checks, chapter 6 of 11:
 *  - A brand-new install can be set up from the browser alone
 *  - The system explains itself
 *  - Changing a role instead of deleting the person
 *  - A person can change their own password
 *  - The status strip shows only what the reader may see
 *  - Which network address the department is given
 */
import { buildView } from '../../services/network.js';
import { PW, app, check, db, get, heading, login, post } from './harness.js';
import type { Hdr, Res } from './harness.js';
import { admin, grace, ifeoma, siteId } from './01-setup.js';

let r: Res;

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
export const civilTeam = r.json().id as string;

r = await post('/api/teams', admin, { name: 'Civil' });
check('and a duplicate team name is refused', r.statusCode === 409);

r = await post('/api/staff', admin, {
  firstName: 'Chidi', lastName: 'Obi', trade: 'civil', teamId: civilTeam,
  phone: '0803 000 0009', staffNo: 'ST-090',
});
check('a person can be added to the floor', r.statusCode === 201, r.body.slice(0, 140));
export const chidi = r.json().id as string;

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
export const chidiUser = (db.prepare('SELECT id FROM users WHERE username = ?').get('chidi') as
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
export const chidiSession = await login('chidi', PW);
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
const blessing = await login('blessing', PW, { asIssued: true });
check('and the flag reaches the client that has to act on it',
  ((await get('/api/me', blessing)).json().user as { mustChangePassword: boolean })
    .mustChangePassword === true);

// The browser draws a wall here; the server holds it too, so the wall is not only as good
// as the client drawing it.
r = await post('/api/requests', blessing, { description: 'Lift stuck on the third floor' });
check('until it is changed, the account cannot raise anything on the property network',
  r.statusCode === 403 && r.json().error === 'must_change_password', r.body.slice(0, 140));
r = await get('/api/jobs', blessing);
check('or read anything', r.statusCode === 403);
r = await get('/api/events', blessing);
check('or listen for anything', r.statusCode === 403);

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
check('and with it, the account can get on with its work',
  (await get('/api/jobs', stillHere)).statusCode === 200);
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
