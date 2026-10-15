/**
 * Module checks, chapter 7 of 11:
 *  - Being told a job is yours
 *  - The generator logbook
 *  - Alerts a technician cannot switch off
 *  - Told the moment it happens, and asked again until it is picked up
 *  - A phone paired to the alert app
 *  - The alert app's installer, and which build it is
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as bus from '../../services/bus.js';
import * as devices from '../../services/devices.js';
import { PW, app, check, config, day, db, get, heading, login, post, throws } from './harness.js';
import type { Hdr, Res } from './harness.js';
import { admin, afternoon, femi, grace, hod, ifeoma, propertyId, siteId } from './01-setup.js';
import { musaAgain } from './04-records-and-admin.js';
import { chidiSession, chidiUser, civilTeam } from './06-first-run.js';

let r: Res;

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

/*
 * A job handed to a team rang nobody. The phone and the banner listed only jobs in your own
 * name, and a technician may act only on those — so a team job sat silent until somebody
 * happened to look. It rings the team's lead now, the one person who can put it in a name.
 */
{
  type Waiting = { id: string; team_name: string | null; ring_until: string | null };
  const waitingFor = async (who: Hdr) =>
    (await get('/api/me/outstanding', who)).json().unaccepted as Waiting[];

  r = await post('/api/jobs', grace, {
    title: 'Crack along the car park ramp', locationId: siteId, priority: 'P2', trade: 'civil',
  });
  const teamJob = r.json().job as { id: string; ref: string };
  r = await post(`/api/jobs/${teamJob.id}/assign`, grace, { teamId: civilTeam });
  check('a job can be handed to a team rather than a person', r.statusCode === 200, r.body.slice(0, 160));

  const forLead = (await waitingFor(musaAgain)).find((w) => w.id === teamJob.id);
  check('a job handed to a team rings the team’s lead', !!forLead, JSON.stringify(forLead));
  check('marked with the team, so the lead knows it is theirs to put in a name',
    forLead?.team_name === 'Civil', JSON.stringify(forLead));
  check('and with a time to stop ringing, like any other', !!forLead?.ring_until, JSON.stringify(forLead));
  check('but not the technicians on the team, who cannot act on a job not in their name',
    !(await waitingFor(chidiSession)).some((w) => w.id === teamJob.id));

  // Named as lead, but in a role that cannot hand work out: ringing them asks for what they
  // cannot do.
  await app.inject({ method: 'PATCH', url: `/api/teams/${civilTeam}`, headers: admin,
    payload: { teamLeadStaffId: chidiStaff?.id } });
  check('a lead whose role cannot hand out work is not rung for the team\u2019s jobs',
    !(await waitingFor(chidiSession)).some((w) => w.id === teamJob.id));
  await app.inject({ method: 'PATCH', url: `/api/teams/${civilTeam}`, headers: admin,
    payload: { teamLeadStaffId: musaStaff?.id } });
  check('the lead’s notice says what to do with it',
    unreadFor('musa').some((n) => n.kind === 'wo.assigned' && n.title.includes(teamJob.ref)
      && (n.body ?? '').startsWith('P2') && (n.body ?? '').includes('name')),
    JSON.stringify(unreadFor('musa').slice(0, 2)));

  r = await post(`/api/jobs/${teamJob.id}/assign`, grace, { staffId: ifeomaStaff?.id });
  check('once it is in somebody’s name, the lead’s ring stops',
    r.statusCode === 200 && !(await waitingFor(musaAgain)).some((w) => w.id === teamJob.id), r.body.slice(0, 160));
  const forIfeoma = (await waitingFor(ifeoma)).find((w) => w.id === teamJob.id);
  check('and that person’s starts, as their own job', !!forIfeoma && forIfeoma.team_name === null,
    JSON.stringify(forIfeoma));

  r = await post('/api/jobs', grace, {
    title: 'Loose kerb stone by the gatehouse', locationId: siteId, priority: 'P3', trade: 'civil',
  });
  const picked = r.json().job as { id: string };
  await post(`/api/jobs/${picked.id}/assign`, grace, { teamId: civilTeam });
  r = await post(`/api/jobs/${picked.id}/accept`, musaAgain);
  check('a lead who takes the team’s job stops it ringing too',
    r.statusCode === 200 && !(await waitingFor(musaAgain)).some((w) => w.id === picked.id), r.body.slice(0, 160));
  check('and taking it puts it in their name, so it is somebody’s to do rather than nobody’s',
    r.json().job?.assigned_to_staff_id === musaStaff?.id, JSON.stringify(r.json().job?.assigned_to_staff_id));
  r = await post(`/api/jobs/${picked.id}/start`, musaAgain);
  check('so the lead can carry on and start it', r.statusCode === 200, r.body.slice(0, 160));
}

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

  // What the lead's ring is for: they put the team's job in one of their people's names —
  // here a team they lead without being on it.
  r = await post('/api/jobs', grace, {
    title: 'Blocked gully outside block C', locationId: siteId, priority: 'P3', trade: 'civil',
  });
  const gully = r.json().job as { id: string };
  await post(`/api/jobs/${gully.id}/assign`, grace, { teamId: civilTeam });
  r = await post(`/api/jobs/${gully.id}/assign`, musaAgain, { staffId: tundeStaff.id });
  check('the lead puts the team’s job in one of their people’s names', r.statusCode === 200,
    r.body.slice(0, 160));
  check('and it rings that person instead',
    ((await get('/api/me/outstanding', chidiSession)).json().unaccepted as { id: string }[])
      .some((w) => w.id === gully.id));
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
{
  // Sent back long after its response deadline, it is handed over again now — so the
  // phone rings for it again rather than treating it as a job whose time ran out.
  db.prepare('UPDATE work_orders SET respond_by = ? WHERE id = ?')
    .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), notifyJob.id);
  const w = ((await get('/api/me/outstanding', chidiSession)).json().unaccepted as
    { id: string; ring_until: string | null }[]).find((x) => x.id === notifyJob.id);
  check('and a job sent back rings its technician again',
    !!w?.ring_until && w.ring_until > new Date().toISOString(), JSON.stringify(w));
}

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
{
  const w = waiting.find((x) => x.id === liveJob.id) as { respond_by: string; ring_until: string } | undefined;
  check('with when to stop ringing, never earlier than the response deadline',
    !!w?.ring_until && w.ring_until >= w.respond_by, JSON.stringify(w));
}

/*
 * A job handed out after its response time has already gone. respond_by is measured from
 * the report and is never moved, so ringing only until then meant the person it was given
 * to was never rung at all — a job left unassigned too long, or reassigned after somebody
 * went home, arrived in silence.
 */
r = await post('/api/jobs', grace, { title: 'Sat unassigned too long', locationId: siteId, priority: 'P2' });
const lateJob = r.json().job as { id: string };
{
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  db.prepare('UPDATE work_orders SET reported_at = ?, respond_by = ? WHERE id = ?')
    .run(hoursAgo(6), hoursAgo(4), lateJob.id);
}
await post(`/api/jobs/${lateJob.id}/assign`, grace, { staffId: ifeomaStaff?.id });
{
  const w = ((await get('/api/me/outstanding', ifeoma)).json().unaccepted as
    { id: string; respond_by: string; ring_until: string }[]).find((x) => x.id === lateJob.id);
  const now = new Date().toISOString();
  check('a job assigned after its response deadline still rings the person it went to',
    !!w && w.respond_by < now && w.ring_until > now, JSON.stringify(w));
  check('while the deadline it is judged against stays where it was',
    !!w && w.respond_by < now);
}
await post(`/api/jobs/${lateJob.id}/accept`, ifeoma);

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
check('and the rings and emergencies it is meant to ring about',
  (await get('/api/me/rings', phone)).statusCode === 200
  && (await get('/api/alerts/emergency', phone)).statusCode === 200);

/*
 * Escalations, mains failure, a job taken away or sent back: the phone was nudged that
 * something had happened and refused when it asked what. It reads the person's own notices
 * now, the same ones the bell shows — and leaves marking them read to the website.
 */
r = await get('/api/notifications', phone);
check('the phone can read the notices behind the nudges it is sent',
  r.statusCode === 200 && Array.isArray(r.json().notifications), r.body.slice(0, 140));
check('the same notices the website shows that person, loudness and all',
  JSON.stringify((r.json().notifications as { id: string }[]).map((n) => n.id))
    === JSON.stringify(((await get('/api/notifications', ifeoma)).json().notifications as { id: string }[])
      .map((n) => n.id))
  && (r.json().notifications as Record<string, unknown>[]).every((n) => 'level' in n));
r = await post('/api/notifications/read', phone);
check('but cannot mark them read: the bell stays the record of what the person has seen',
  r.statusCode === 403 && r.json().error === 'not_for_phones', r.body.slice(0, 140));

// The token has no password behind it and never expires, so it opens what the app does
// and nothing else. A lost phone must not be a standing key to the whole system.
r = await get('/api/jobs', phone);
check('but the phone\u2019s token cannot read the job board',
  r.statusCode === 403 && r.json().error === 'not_for_phones', r.body.slice(0, 140));
r = await post('/api/jobs', phone, { title: 'Raised with a phone token', locationId: siteId, priority: 'P3' });
check('or raise work', r.statusCode === 403, r.body.slice(0, 140));
r = await get('/api/stock', phone);
check('or reach anything else its owner\u2019s role could', r.statusCode === 403, r.body.slice(0, 140));
check('while the same person on the website still can',
  (await get('/api/jobs', ifeoma)).statusCode === 200);

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

/*
 * A phone that redials after a silent drop opens its new stream before the host notices
 * the old one has gone. When that stale socket finally closes, the phone is still
 * listening on the new one — and a supervisor told "Phone app not running" would chase
 * somebody whose phone is fine.
 */
{
  const connected = () => (db.prepare('SELECT connected_at FROM app_devices WHERE id = ?')
    .get(paired.deviceId) as { connected_at: string | null }).connected_at !== null;
  devices.streamOpened(db, paired.deviceId);
  devices.streamOpened(db, paired.deviceId);
  devices.streamClosed(db, paired.deviceId);
  check('a phone that redialled stays connected when its old stream finally closes', connected());
  devices.streamClosed(db, paired.deviceId);
  check('and shows as gone only when its last stream does', !connected());
}

// Revoking is the answer to a lost or sold handset, and it has to be immediate.
r = await app.inject({ method: 'DELETE', url: `/api/me/devices/${paired.deviceId}`, headers: ifeoma });
check('a phone can be unpaired', r.statusCode === 200);
check('and its token dies with it, at once',
  (await get('/api/me', phone)).statusCode === 401);

r = await app.inject({ method: 'DELETE', url: `/api/me/devices/${paired.deviceId}`, headers: grace });
check('nobody can unpair somebody else\u2019s phone through the path', r.statusCode === 404);

// The app's own Unpair tells the host, with the phone's own token.
{
  const code = (await post('/api/me/pairing-code', ifeoma)).json().code as string;
  const second = (await post('/api/devices/pair', { cookie: '' } as Hdr,
    { code, deviceName: 'Ifeoma second phone', platform: 'android' })).json() as { deviceId: string; token: string };
  const own: Hdr = { authorization: `Bearer ${second.token}` } as unknown as Hdr;
  r = await app.inject({ method: 'DELETE', url: `/api/me/devices/${second.deviceId}`, headers: own });
  check('a phone can unpair itself', r.statusCode === 200, r.body.slice(0, 140));
  check('and its token stops working', (await get('/api/me', own)).statusCode === 401);
}

/*
 * A phone's token has no password behind it, so it outlived everything that is meant to
 * take somebody's access away: a password reset, their own password change, their account
 * being disabled — and re-enabling the account brought every old phone back. And revoking
 * stopped the token's next request but not the stream it already had open, so a phone
 * unpaired on the website went on hearing every event, counted as reached by every ring.
 * A fresh account, so cutting its streams touches nothing else in this chapter.
 */
{
  r = await post('/api/admin/users', admin,
    { username: 'pagerpat', roleKey: 'technician', displayName: 'Pat Pager', password: PW });
  check('an account to pair a phone to', r.statusCode === 201, r.body.slice(0, 140));
  const patId = (db.prepare("SELECT id FROM users WHERE username = 'pagerpat'").get() as { id: string }).id;
  let pat = await login('pagerpat', PW);
  const pair = async (who: Hdr) => {
    const code = (await post('/api/me/pairing-code', who)).json().code as string;
    const p = (await post('/api/devices/pair', { cookie: '' } as Hdr,
      { code, deviceName: 'Pat Itel A70', platform: 'android' })).json() as { deviceId: string; token: string };
    return { ...p, hdr: { authorization: `Bearer ${p.token}` } as unknown as Hdr };
  };
  const works = async (h: Hdr) => (await get('/api/me/outstanding', h)).statusCode === 200;

  // Unpairing ends the stream it had open.
  let phone = await pair(pat);
  const stream = app.inject({ method: 'GET', url: '/api/events', headers: phone.hdr });
  await new Promise((res) => setTimeout(res, 50));
  check('a listening phone holds a stream open', bus.listenerCountFor(patId) === 1,
    String(bus.listenerCountFor(patId)));
  await app.inject({ method: 'DELETE', url: `/api/me/devices/${phone.deviceId}`, headers: pat });
  check('unpairing it takes it off the list at once, so a ring sent now does not count it',
    bus.listenerCountFor(patId) === 0, String(bus.listenerCountFor(patId)));
  const ended = await Promise.race([
    stream.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 2000)),
  ]);
  check('and the stream itself is closed, not left to hear the next event', ended);

  // An administrator's reset.
  phone = await pair(pat);
  check('a newly paired phone works', await works(phone.hdr));
  r = await post(`/api/admin/users/${patId}/reset-password`, admin, { password: 'a-reset-password-1' });
  check('resetting the password unpairs the phone with everything else',
    r.statusCode === 200 && r.json().phonesUnpaired === 1, r.body.slice(0, 160));
  check('and its token stops working', !(await works(phone.hdr)));

  // Their own password change.
  pat = await login('pagerpat', 'a-reset-password-1');
  phone = await pair(pat);
  r = await post('/api/auth/password', pat,
    { currentPassword: 'a-reset-password-1', newPassword: 'a-chosen-password-2' });
  check('changing your own password unpairs your phone too, and says so',
    r.statusCode === 200 && r.json().phonesUnpaired === 1 && /pairing again/.test(String(r.json().message)),
    r.body.slice(0, 200));
  check('its token stops working', !(await works(phone.hdr)));
  const fresh = r.cookies.find((c) => c.name === 'ff_sid');
  pat = { cookie: `ff_sid=${fresh?.value}` };
  check('while the browser that changed it carries on, on its new session', await works(pat));

  // Disabled, then enabled again.
  phone = await pair(pat);
  r = await post(`/api/admin/users/${patId}/disable`, admin);
  check('disabling the account unpairs the phone',
    r.statusCode === 200 && r.json().phonesUnpaired === 1, r.body.slice(0, 160));
  await post(`/api/admin/users/${patId}/enable`, admin);
  check('and enabling it again does not bring the old phone back', !(await works(phone.hdr)));
}

// --------------------------------------------------------------------------
heading('The alert app\u2019s installer, and which build it is');
// --------------------------------------------------------------------------
/*
 * The installer is a file an administrator copies into the data folder, and nothing on
 * the host knew which build it was — so no phone could be told a newer one was waiting.
 * The host reads the version out of the APK itself. The fixture is the real manifest from
 * build 1.0.0+14, wrapped in a zip the way an APK wraps it.
 */
{
  const manifest = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/AndroidManifest.bin'));
  const zip = (entries: { name: string; data: Buffer }[]): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name);
      const packed = zlib.deflateRawSync(e.data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
      local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(e.data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
      central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20);
      central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, name, packed);
      centrals.push(central, name);
      offset += 30 + name.length + packed.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
  };
  const apk = path.join(config.dataDir, 'app.apk');
  const health = async () => (await get('/api/health', { cookie: '' } as Hdr)).json().app as
    { version: string | null; build: number | null } | null;

  check('with no installer on the host, there is no version to offer', (await health()) === null);

  fs.writeFileSync(apk, zip([
    { name: 'classes.dex', data: Buffer.from('not the manifest') },
    { name: 'AndroidManifest.xml', data: manifest },
  ]));
  let v = await health();
  check('with one, the host says which build it hands out, read from the file itself',
    v?.version === '1.0.0' && v.build === 14, JSON.stringify(v));
  r = await get('/api/admin/installer', admin);
  check('and the Host PC screen is told the same',
    r.json().present === true && r.json().version === '1.0.0' && r.json().build === 14, r.body.slice(0, 160));

  r = await app.inject({ method: 'GET', url: '/app.apk' });
  check('a phone told there is a newer one can open it in its browser, which has no session',
    r.statusCode === 200 && r.headers['content-type'] === 'application/vnd.android.package-archive');

  fs.writeFileSync(apk, 'copied from the wrong folder');
  v = await health();
  check('a file that is not an APK is there but unknown — not a crash, and not offered as newer',
    v !== null && v.version === null && v.build === null, JSON.stringify(v));
  fs.unlinkSync(apk);
}
