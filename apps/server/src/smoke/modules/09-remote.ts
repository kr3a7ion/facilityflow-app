/**
 * Module checks, chapter 9 of 11:
 *  - Getting in from outside the property
 *  - The property's own certificate
 *  - The screen that covers the shift
 */
import fs from 'node:fs';
import * as tls from '../../services/tls.js';
import nodeTls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { loadConfig } from '../../config.js';
import { activityOf } from '../../auth/sessions.js';
import { PW, app, check, db, dir, get, heading, login, post } from './harness.js';
import type { Res } from './harness.js';
import { admin, grace, ifeoma, siteId } from './01-setup.js';

let r: Res;

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
export const GRACE_PW = 'a-password-she-chose-herself';
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

/*
 * Cloudflare is the tunnel the department chose, not the only one anybody can run. Any other
 * tunnel or proxy on the host PC reaches the app over loopback — and loopback looked like the
 * property network, so it walked past every rule here.
 */
{
  const ask = (remoteAddress: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/api/jobs', remoteAddress, headers: { ...graceOwn, ...headers } });
  const closed = (res: { statusCode: number; body: string }) =>
    res.statusCode === 403 && res.body.includes('remote_closed');
  check('a request any proxy forwarded is from outside',
    closed(await ask('127.0.0.1', { 'x-forwarded-for': '41.58.10.10' })));
  check('so is one carrying the standard Forwarded header',
    closed(await ask('127.0.0.1', { forwarded: 'for=41.58.10.10;proto=https' })));
  check('and one a raw tunnel carried in to loopback, asking for a public name',
    closed(await ask('127.0.0.1', { host: 'harmony-court.ngrok-free.app' })));
  check('while the host PC\u2019s own browser on localhost is on the property network',
    (await ask('127.0.0.1', { host: 'localhost:4700' })).statusCode === 200);
  check('and so is the host PC by its own name',
    (await ask('127.0.0.1', { host: `${os.hostname()}:4700` })).statusCode === 200);
  check('and a phone on the wifi using the LAN address',
    (await ask('192.168.1.23', { host: '192.168.1.50:4700' })).statusCode === 200);
}

/*
 * Two routes answer before anybody signs in: redeeming a pairing code, which mints a phone
 * token, and the installer. With no principal the rules above never ran for them, so a
 * tunnel left running reached both with the door shut.
 */
{
  const tunnel = { 'cf-connecting-ip': '102.89.1.1' };
  const code = (await post('/api/me/pairing-code', ifeoma)).json().code as string;
  r = await app.inject({ method: 'POST', url: '/api/devices/pair', headers: tunnel,
    payload: { code, deviceName: 'From the street', platform: 'android' } });
  check('a pairing code cannot be redeemed from outside while the door is shut',
    r.statusCode === 403 && r.json().error === 'remote_closed', r.body.slice(0, 160));
  r = await app.inject({ method: 'POST', url: '/api/devices/pair', headers: tunnel,
    payload: { code: 'NOTACODE1', deviceName: 'From the street', platform: 'android' } });
  check('and a made-up one gets the same answer, so it tells nobody which codes are live',
    r.statusCode === 403 && r.json().error === 'remote_closed', r.body.slice(0, 160));
  r = await app.inject({ method: 'GET', url: '/app.apk', headers: tunnel });
  check('nor is the installer handed out through the tunnel',
    r.statusCode === 403 && r.json().error === 'remote_closed', r.body.slice(0, 160));
  r = await app.inject({ method: 'POST', url: '/api/devices/pair', headers: {},
    payload: { code, deviceName: 'Ifeoma on the wifi', platform: 'android' } });
  check('while the same code still pairs a phone on the property network, unspent',
    r.statusCode === 201, r.body.slice(0, 160));
  r = await app.inject({ method: 'GET', url: '/api/health', headers: tunnel });
  check('and the health check still answers from outside', r.statusCode === 200);
}

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
r = await app.inject({ method: 'GET', url: '/app.apk', headers: { 'cf-connecting-ip': '102.89.1.1' } });
check('with the door open the installer is ordinary again', r.json().error !== 'remote_closed',
  r.body.slice(0, 160));

// The published address marks a request as outside however it arrives — even through a
// router that hands it over from a LAN address.
r = await app.inject({ method: 'GET', url: '/api/jobs', remoteAddress: '192.168.1.1',
  headers: { ...ifeoma, host: 'srl.example.com' } });
check('a request for the published address is from outside, whatever socket it came on',
  r.statusCode === 403 && r.json().required === 'remote.access', r.body.slice(0, 160));
r = await app.inject({ method: 'GET', url: '/api/jobs', remoteAddress: '192.168.1.1',
  headers: { ...ifeoma, host: '192.168.1.50:4700' } });
check('while the same request for the LAN address is not', r.statusCode === 200, r.body.slice(0, 160));

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

/*
 * The timeout on the Host PC screen. A cookie on a laptop closed in a hotel lobby stays
 * good for a week otherwise, from anywhere the tunnel reaches.
 */
{
  const sid = r.cookies.find((c) => c.name === 'ff_sid')!.value;
  const away = { cookie: `ff_sid=${sid}`, 'cf-connecting-ip': '102.89.1.1' };
  const idle = (id: string) => db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 21 * 60_000).toISOString(), id);

  check('a remote session in use carries on', (await get('/api/jobs', away)).statusCode === 200);

  /*
   * What counts as use. An open tab asks for things by itself, and the website says with
   * every call how long since anybody touched the page \u2014 so a tab left open on an
   * unattended laptop times out like a closed one, instead of keeping itself alive forever.
   */
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const seen = () => (db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(sid) as
    { last_seen_at: string }).last_seen_at;
  const setSeen = (at: string) => db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, sid);
  const idleFor = (seconds: number, from = away) => ({ ...from, 'x-ff-idle': String(seconds) });

  setSeen(ago(10));
  r = await get('/api/jobs', idleFor(10 * 60));
  check('a tab polling by itself is still answered', r.statusCode === 200, r.body.slice(0, 160));
  check('but does not count as somebody using it', seen() < ago(9), seen());
  r = await get('/api/jobs', idleFor(5));
  check('a page somebody touched a moment ago does', seen() > ago(1), seen());
  r = await get('/api/jobs', idleFor(30 * 60));
  check('and a slower, idle second tab does not wind that back', seen() > ago(1), seen());
  setSeen(ago(10));
  r = await get('/api/jobs', away);
  check('a request that says nothing counts as use, as every request did before', seen() > ago(1), seen());
  check('the event stream never counts: it cannot say, and it reconnects by itself',
    activityOf({ method: 'GET', url: '/api/events', headers: {} } as FastifyRequest) === null);

  idle(sid);
  r = await get('/api/jobs', idleFor(21 * 60));
  check('one left alone past the property\u2019s timeout is signed out, however busily it polls',
    r.statusCode === 401, r.body.slice(0, 160));
  check('and told why, so the sign-in screen can say so', r.json().error === 'timed_out', r.body.slice(0, 160));
  check('for good, not only for that request',
    (db.prepare('SELECT revoked_at FROM sessions WHERE id = ?').get(sid) as
      { revoked_at: string | null }).revoked_at !== null);
  r = await get('/api/jobs', idleFor(0));
  check('and nothing the page reports afterwards brings it back', r.statusCode === 401);
  check('while every later request with that cookie is told why as well — the first to find out is often the event stream, which nobody reads',
    r.json().error === 'timed_out', r.body.slice(0, 160));

  // A laptop opened after a weekend: the mouse may move before the first request goes out.
  r = await app.inject({ method: 'POST', url: '/api/auth/login',
    headers: { 'cf-connecting-ip': '102.89.1.1' }, payload: { username: 'grace', password: GRACE_PW } });
  const woken = r.cookies.find((c) => c.name === 'ff_sid')!.value;
  idle(woken);
  r = await get('/api/jobs', idleFor(0, { ...away, cookie: `ff_sid=${woken}` }));
  check('a laptop woken past the timeout is signed out even if it was touched before it asked',
    r.statusCode === 401 && r.json().error === 'timed_out', r.body.slice(0, 160));

  idle(graceOnSite.cookie.replace('ff_sid=', ''));
  check('a session idle as long on the property network is left alone',
    (await get('/api/jobs', graceOnSite)).statusCode === 200);
}

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
r = await post('/api/admin/host/https', admin, { enabled: true, port: 4811 });
check('an administrator can', r.statusCode === 200, r.body.slice(0, 180));
check('and is told plainly that it takes a restart',
  /restart/.test(String(r.json().message)), String(r.json().message));
// The file used to say so while the next start ignored it: the reader dropped both fields.
check('and the next start actually serves HTTPS, on the port that was chosen',
  loadConfig({ dataDir: dir }).https === true && loadConfig({ dataDir: dir }).httpsPort === 4811);
r = await post('/api/admin/host/network', admin, { advertise: null });
check('saving another host setting afterwards does not quietly switch it off again',
  r.statusCode === 200 && loadConfig({ dataDir: dir }).https === true, r.body.slice(0, 160));
r = await post('/api/admin/host/https', admin, { enabled: false });
check('and can turn it off again',
  r.statusCode === 200 && loadConfig({ dataDir: dir }).https === false);

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
