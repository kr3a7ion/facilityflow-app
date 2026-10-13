/**
 * Module checks, chapter 2 of 11:
 *  - Work orders — lifecycle, SLA and segregation of duties
 *  - Escalation
 *  - Preventive maintenance
 */
import { addInterval, compliance as ppmCompliance } from '../../services/ppm.js';
import { tick } from '../../services/escalation.js';
import { check, day, db, get, heading, iso, near, post, throws } from './harness.js';
import type { Res } from './harness.js';
import { acAsset, admin, apt, gen01, grace, ifeoma, musa, propertyId, siteId, staffIds } from './01-setup.js';

let r: Res;

// --------------------------------------------------------------------------
heading('Work orders — lifecycle, SLA and segregation of duties');
// --------------------------------------------------------------------------
r = await post('/api/jobs', grace, { title: 'Job with no target', priority: 'P3' });
check('a job attached to nothing is refused', r.statusCode === 400 && r.json().error === 'no_target');

r = await post('/api/jobs', grace, {
  title: 'AC not cooling, guest in residence', apartmentId: apt.id, assetId: acAsset,
  trade: 'hvac', priority: 'P2', description: 'Guest reports no cooling since 14:00.',
});
export const job = r.json().job;
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
export const p1 = r.json().job;
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

/*
 * A role with nobody in it. A property with no team lead accounts yet — or whose only one
 * has been disabled — sent the first step of every escalation to nobody, silently.
 */
{
  const leadIds = (db.prepare(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'team_lead' AND u.is_active = 1`
  ).all() as { id: string }[]).map((x) => x.id);
  for (const id of leadIds) db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(id);

  r = await post('/api/jobs', grace, { title: 'Nobody has picked this up', locationId: siteId, priority: 'P2' });
  const unanswered = r.json().job as { id: string };
  db.prepare('UPDATE work_orders SET respond_by = ? WHERE id = ?').run(iso(-1 / 24), unanswered.id);
  const e = tick(db, propertyId).escalated.find((x) => x.id === unanswered.id);
  check('a response breach with no team lead on the property still reaches somebody',
    !!e && e.role === 'team_lead' && e.fellBack && e.told > 0, JSON.stringify(e));
  check('namely whoever can reassign it — the supervisor among them',
    (db.prepare(
      `SELECT COUNT(*) n FROM notifications n JOIN users u ON u.id = n.user_id
        WHERE n.kind = 'escalation' AND n.entity_id = ? AND u.username = 'grace'`
    ).get(unanswered.id) as { n: number }).n === 1);
  check('and the job\u2019s history says the role was empty, rather than that it was told',
    JSON.parse((db.prepare(
      `SELECT meta_json FROM work_order_events WHERE wo_id = ? AND event_type = 'escalated'`
    ).get(unanswered.id) as { meta_json: string }).meta_json).nobodyInRole === true);

  for (const id of leadIds) db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(id);
  await post(`/api/jobs/${unanswered.id}/cancel`, grace, { reason: 'Escalation fixture' });
}

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
