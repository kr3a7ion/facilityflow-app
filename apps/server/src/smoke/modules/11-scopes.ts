/**
 * Module checks, chapter 11 of 11:
 *  - Who may touch which job
 *  - Every call the screens make has a route behind it
 *  - The client is served from the same address
 *  - The API reference
 *  - Integrity
 */
import fs from 'node:fs';
import path from 'node:path';
import { API_DOC, apiReference } from '../../apiReference.js';
import { PW, SRC, app, check, day, db, get, heading, login, post } from './harness.js';
import type { Res } from './harness.js';
import { admin, afternoon, siteId } from './01-setup.js';
import { GRACE_PW } from './09-remote.js';

let r: Res;

// --------------------------------------------------------------------------
heading('Who may touch which job');
// --------------------------------------------------------------------------
/*
 * The scopes were in the role table from the start and only the board applied them. A
 * technician could accept, start and complete somebody else's job by id; a team lead could
 * dispatch work to another team and sign off another team's. Decided with the department:
 * a technician works the jobs in their own name — a team-pool job has to be put in somebody's
 * name first — and a team lead works within their own team in both directions.
 */
{
  // Signed in afresh: the remote section above changed Grace's password, which ends every
  // session she had.
  const sup = await login('grace', GRACE_PW);
  const team = async (name: string) => (await post('/api/teams', admin, { name })).json().id as string;
  const teamA = await team('Scope Team A');
  const teamB = await team('Scope Team B');
  const person = async (first: string, teamId: string) =>
    (await post('/api/staff', admin, { firstName: first, lastName: 'Scope', trade: 'general', teamId })).json().id as string;
  const leadA = await person('Lola', teamA);
  const techA = await person('Ade', teamA);
  const techA2 = await person('Bisi', teamA);
  const techB = await person('Kunle', teamB);
  for (const [username, roleKey, staffId] of [
    ['scope.lead', 'team_lead', leadA], ['scope.ade', 'technician', techA],
    ['scope.bisi', 'technician', techA2], ['scope.kunle', 'technician', techB],
  ] as const) {
    const res = await post('/api/admin/users', admin,
      { username, roleKey, displayName: `${username} account`, password: PW, staffId });
    if (res.statusCode !== 201) throw new Error(`could not create ${username}: ${res.body}`);
  }
  await post('/api/roster', sup, { entries: [leadA, techA, techA2, techB].map((staffId) =>
    ({ staffId, workDate: day(0), shiftPatternId: afternoon })) });
  await post('/api/roster/publish', sup, { from: day(0), to: day(0) });
  for (const staffId of [leadA, techA, techA2, techB]) {
    await post('/api/roster/mark', sup, { staffId, workDate: day(0), status: 'present' });
  }
  const lead = await login('scope.lead', PW);
  const ade = await login('scope.ade', PW);
  const bisi = await login('scope.bisi', PW);
  const kunle = await login('scope.kunle', PW);

  const raise = async (title: string) =>
    (await post('/api/jobs', sup, { title, locationId: siteId, priority: 'P3' })).json().job.id as string;
  const bisiJob = await raise('Scope: Bisi has this one');
  await post(`/api/jobs/${bisiJob}/assign`, sup, { staffId: techA2 });
  const kunleJob = await raise('Scope: Kunle has this one');
  await post(`/api/jobs/${kunleJob}/assign`, sup, { staffId: techB });
  const poolJob = await raise('Scope: with Team A, nobody named');
  await post(`/api/jobs/${poolJob}/assign`, sup, { teamId: teamA });
  const openJob = await raise('Scope: nobody has this yet');
  const adeJob = await raise('Scope: Ade has this one');
  await post(`/api/jobs/${adeJob}/assign`, sup, { staffId: techA });

  // ---- a technician: jobs in their own name, and nothing else ----------------------
  r = await get(`/api/jobs/${bisiJob}`, ade);
  check('a technician cannot open a colleague’s job',
    r.statusCode === 403 && r.json().error === 'out_of_scope', r.body.slice(0, 160));
  r = await post(`/api/jobs/${bisiJob}/accept`, ade);
  check('or accept it', r.statusCode === 403, r.body.slice(0, 160));
  check('and the job is left exactly as it was',
    ((await get(`/api/jobs/${bisiJob}`, sup)).json().job as { status: string }).status === 'assigned');
  for (const [what, url, body] of [
    ['start it', `/api/jobs/${bisiJob}/start`, {}],
    ['put it on hold', `/api/jobs/${bisiJob}/hold`, { reason: 'awaiting_parts' }],
    ['complete it', `/api/jobs/${bisiJob}/complete`, { resolutionNotes: 'Not mine to finish' }],
    ['comment on it', `/api/jobs/${bisiJob}/comment`, { note: 'Not mine to comment on' }],
    ['log time to it', `/api/jobs/${bisiJob}/labour`, { minutes: 30 }],
  ] as const) {
    r = await post(url, ade, body);
    check(`or ${what}`, r.statusCode === 403, `${r.statusCode} ${r.body.slice(0, 120)}`);
  }
  r = await get(`/api/attachments?entityType=work_order&entityId=${bisiJob}`, ade);
  check('or look at its photos', r.statusCode === 403, r.body.slice(0, 120));
  r = await get(`/api/jobs/${poolJob}`, ade);
  check('a job with their team but in nobody’s name is not theirs to take either',
    r.statusCode === 403, r.body.slice(0, 160));
  r = await post(`/api/jobs/${adeJob}/accept`, ade);
  check('while the job in their own name is theirs to accept', r.statusCode === 200, r.body.slice(0, 160));
  r = await get('/api/jobs', ade);
  check('and their board shows exactly the jobs in their name',
    (r.json().jobs as { id: string }[]).map((j) => j.id).join() === adeJob,
    (r.json().jobs as { title: string }[]).map((j) => j.title).join(' | '));

  // ---- a team lead: their own team, in both directions -----------------------------
  r = await get('/api/jobs', lead);
  {
    const ids = (r.json().jobs as { id: string }[]).map((j) => j.id);
    check('a team lead’s board carries their team’s work, by name or by team',
      [bisiJob, poolJob, adeJob].every((id) => ids.includes(id)), ids.length + ' jobs');
    check('and the jobs nobody has yet, which are theirs to dispatch', ids.includes(openJob));
    check('but not another team’s', !ids.includes(kunleJob));
  }
  check('a team lead can open a job one of their people holds',
    (await get(`/api/jobs/${bisiJob}`, lead)).statusCode === 200);
  r = await get(`/api/jobs/${kunleJob}`, lead);
  check('but not one another team holds', r.statusCode === 403, r.body.slice(0, 160));

  r = await get('/api/jobs/assignable', lead);
  {
    const offered = (r.json().staff as { staff_id: string }[]).map((x) => x.staff_id);
    check('the people offered for assignment are their own team',
      [leadA, techA, techA2].every((id) => offered.includes(id)) && !offered.includes(techB),
      JSON.stringify(offered));
  }
  r = await post(`/api/jobs/${openJob}/assign`, lead, { staffId: techB });
  check('a team lead cannot hand work to somebody on another team',
    r.statusCode === 403 && r.json().error === 'out_of_scope', r.body.slice(0, 160));
  r = await post(`/api/jobs/${openJob}/assign`, lead, { teamId: teamB });
  check('or to another team', r.statusCode === 403, r.body.slice(0, 160));
  r = await post(`/api/jobs/${openJob}/assign`, lead, { staffId: techA2 });
  check('and dispatches an unassigned job to their own people', r.statusCode === 200, r.body.slice(0, 160));
  r = await post(`/api/jobs/${kunleJob}/assign`, lead, { staffId: techA });
  check('but cannot take a job off another team — that is a supervisor’s call',
    r.statusCode === 403, r.body.slice(0, 160));

  // Each technician finishes their own; the lead may sign off only their team's.
  for (const [who, id] of [[bisi, bisiJob], [kunle, kunleJob]] as const) {
    await post(`/api/jobs/${id}/accept`, who);
    await post(`/api/jobs/${id}/start`, who);
    r = await post(`/api/jobs/${id}/complete`, who, { resolutionNotes: 'Done and tested.' });
    if (r.statusCode !== 200) throw new Error(`could not complete ${id}: ${r.body}`);
  }
  r = await post(`/api/jobs/${kunleJob}/verify`, lead);
  check('a team lead cannot verify another team’s work', r.statusCode === 403, r.body.slice(0, 160));
  r = await post(`/api/jobs/${bisiJob}/verify`, lead);
  check('and verifies their own team’s', r.statusCode === 200, r.body.slice(0, 160));

  // ---- the property-wide roles are untouched ----------------------------------------
  r = await post(`/api/jobs/${kunleJob}/verify`, sup);
  check('a supervisor still works across every team', r.statusCode === 200, r.body.slice(0, 160));
}

// --------------------------------------------------------------------------
heading('Every call the screens make has a route behind it');
// --------------------------------------------------------------------------
/*
 * Resolving the #7 merge kept one side of admin.ts and silently dropped three routes the
 * Who-is-alerted card still called — along with the checks that would have noticed. Every
 * other test passed, because every test was of something that still existed. This reads
 * the paths out of the client and the routes out of the server and wants a match for each.
 */
{
  const srcDir = SRC;
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

  // Server: every literal route, confirmed against the router so a file that is never
  // registered does not count.
  const routes: { method: string; parts: string[] }[] = [];
  for (const f of walk(path.join(srcDir, 'routes')).filter((f) => f.endsWith('.ts'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)) {
      const method = m[1]!.toUpperCase();
      if (app.hasRoute({ method: method as 'GET', url: m[2]! })) {
        routes.push({ method, parts: m[2]!.split('/') });
      }
    }
  }

  // Client: every /api/ path in a string or template, with its method when api.<verb>
  // is right there. A ${…} segment stands for any value; query strings are not routes.
  const VERB: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };
  const calls = new Map<string, { method: string | null; parts: string[]; file: string }>();
  const webSrc = path.resolve(srcDir, '../../web/src');
  for (const f of walk(webSrc).filter((f) => /\.tsx?$/.test(f))) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:api\.(get|post|put|patch|del)(?:<[^>(]*>)?\(\s*)?[`'"](\/api\/[^`'"]*)/g)) {
      let raw = m[2]!;
      raw = raw.split('?')[0]!;
      const q = raw.search(/[^/]\$\{/);           // /api/roster${qs}: the rest is a query
      if (q >= 0) raw = raw.slice(0, q + 1);
      const parts = raw.split('/').map((seg) => (seg.includes('${') ? '*' : seg));
      const method = m[1] ? VERB[m[1]]! : null;
      calls.set(`${method ?? 'ANY'} ${parts.join('/')}`, { method, parts, file: path.relative(webSrc, f) });
    }
  }

  const matches = (c: { method: string | null; parts: string[] }) => routes.some((rt) =>
    (c.method === null || rt.method === c.method)
    && rt.parts.length === c.parts.length
    && rt.parts.every((seg, i) => seg.startsWith(':') || c.parts[i] === '*' || c.parts[i] === seg));

  const missing = [...calls.entries()].filter(([, c]) => !matches(c)).map(([k, c]) => `${k} (${c.file})`);
  check('the client\u2019s API paths were found', calls.size > 100, String(calls.size));
  check('and every one of them reaches a route the server registers', missing.length === 0,
    missing.join('; '));
}

// --------------------------------------------------------------------------
heading('The client is served from the same address');
// --------------------------------------------------------------------------
/*
 * One process serves the API and the built client, so a phone needs one address. Nothing
 * checked that half — which matters most on the day @fastify/static changes under it.
 * Run after a build; CI builds before it runs this.
 */
{
  const dist = path.resolve(SRC, '../../web/dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.log('  --   the client has not been built here; npm run build first to check this section');
  } else {
    const asset = fs.readdirSync(path.join(dist, 'assets')).find((f) => f.endsWith('.js'))!;
    const html = (res: { statusCode: number; headers: Record<string, unknown>; body: string }) =>
      res.statusCode === 200 && String(res.headers['content-type']).startsWith('text/html')
        && res.body.includes('<div id="root"');
    r = await app.inject({ method: 'GET', url: '/' });
    check('the address on its own opens the app', html(r), `${r.statusCode} ${r.headers['content-type']}`);
    r = await app.inject({ method: 'GET', url: '/jobs/some-job-id' });
    check('a link into the app opens the app, and its router takes it from there', html(r));
    r = await app.inject({ method: 'GET', url: `/assets/${asset}` });
    check('the built scripts are served as scripts',
      r.statusCode === 200 && /javascript/.test(String(r.headers['content-type'])));
    r = await app.inject({ method: 'GET', url: '/api/no-such-route' });
    check('while an unknown API path is an API 404, not the app',
      r.statusCode === 404 && r.json().error === 'not_found');
    for (const url of ['/assets/../../../package.json', '/assets/..%2f..%2f..%2fpackage.json',
                       '/%2e%2e/%2e%2e/package.json', '/assets%2f..%2f..%2fREADME.md']) {
      r = await app.inject({ method: 'GET', url });
      check(`climbing out of the client folder reaches nothing (${url})`,
        !r.body.includes('"workspaces"') && !r.body.includes('# FacilityFlow'), r.body.slice(0, 80));
    }
  }
}

// --------------------------------------------------------------------------
heading('The API reference');
// --------------------------------------------------------------------------
{
  // Generated from the routes themselves, so a route added, removed or re-guarded without
  // `npm run docs:api` shows up here rather than in somebody's integration a month later.
  const written = fs.existsSync(API_DOC) ? fs.readFileSync(API_DOC, 'utf8') : '';
  check('docs/API.md lists every route the server has, and what each one requires — npm run docs:api rewrites it',
    written === await apiReference());
}

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
