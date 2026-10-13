/**
 * Module checks, chapter 3 of 11:
 *  - Diesel — dip charts, deliveries, runs and reconciliation
 *  - Stores
 *  - Departmental finance
 *  - Safety and utilities
 *  - Reports
 */
import { litresFromDip, expectedLph, type Profile } from '../../services/fuel.js';
import { app, check, db, get, heading, iso, near, post, throws } from './harness.js';
import type { Res } from './harness.js';
import { admin, femi, gen01, grace, halima, hod, ifeoma, musa, siteId } from './01-setup.js';
import { job } from './02-work-orders.js';

let r: Res;

// --------------------------------------------------------------------------
heading('Diesel — dip charts, deliveries, runs and reconciliation');
// --------------------------------------------------------------------------
check('a dip chart interpolates between calibration points',
  near(litresFromDip([[0, 0], [500, 1000], [1000, 3000], [1500, 6000], [2000, 10000]], 750), 2000));
check('a dip below the chart floor reads as empty',
  litresFromDip([[100, 50], [1000, 5000]], 0) === 50);
check('a dip above the chart ceiling reads as full',
  litresFromDip([[100, 50], [1000, 5000]], 9999) === 5000);
throws('a tank with no calibration chart refuses a millimetre dip',
  () => litresFromDip(null, 500));

const profile: Profile = {
  asset_id: gen01, kva_rating: 250, expected_lph_at_50pct: 30, expected_lph_at_75pct: 40,
  expected_lph_at_100pct: 55, deviation_threshold_pct: 10, consecutive_deviations: 0,
  service_interval_hours: 250, next_service_hours: null,
};
check('expected burn interpolates for the load actually carried',
  near(expectedLph(profile, 250 * 0.8 * 0.875)!, 47.5, 0.5), String(expectedLph(profile, 175)));
check('expected burn falls back sensibly with no load figure', expectedLph(profile) === 40);

r = await post('/api/fuel/tanks', admin, {
  name: 'Bulk tank', kind: 'bulk', capacityL: 15000, minLevelL: 2500,
  dipChart: [[0, 0], [500, 2000], [1000, 5000], [1500, 7500], [2000, 10000], [2500, 12500], [3000, 15000]],
});
const bulk = r.json().id;
check('a tank is created with a calibration chart', r.statusCode === 201 && !r.json().warning);

r = await post('/api/fuel/tanks', admin, { name: 'Day tank', kind: 'day_tank', capacityL: 1000, minLevelL: 300 });
check('a tank without a chart is created with a warning', typeof r.json().warning === 'string');

r = await post(`/api/fuel/tanks/${bulk}/dip`, ifeoma, { litres: 7180, takenAt: iso(-7) });
check('an opening dip is logged', r.statusCode === 201);
r = await post(`/api/fuel/tanks/${bulk}/dip`, ifeoma, { dipMm: 750 });
check('a millimetre dip converts through the chart', near(r.json().litres, 3500));
r = await post(`/api/fuel/tanks/${bulk}/dip`, ifeoma, { litres: 20000 });
check('a dip beyond the tank capacity is refused', r.statusCode === 400);

r = await post('/api/fuel/deliveries', grace, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 6000, dipAfterL: 10940, witnessedBy: 'x', deliveredAt: iso(-5),
});
check('a supervisor cannot receive a delivery, only countersign one',
  r.statusCode === 403 && r.json().required === 'fuel.delivery.create');

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 6000, dipAfterL: 10940, witnessedBy: 'x', deliveredAt: iso(-5),
});
check('an unknown witness is refused', r.statusCode === 400);

const graceUserId = (db.prepare(`SELECT id FROM users WHERE username = 'grace'`).get() as { id: string }).id;

const halimaUserId = (db.prepare(`SELECT id FROM users WHERE username = 'halima'`).get() as { id: string }).id;
r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 6000, dipAfterL: 10940,
  witnessedBy: halimaUserId, deliveredAt: iso(-5),
});
check('one person cannot both receive and witness a delivery',
  r.statusCode === 403 && r.json().error === 'same_signature');

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 6000, dipAfterL: 10940, witnessedBy: graceUserId,
  waybillNo: 'NG-4471', unitPriceKobo: 1_250_00, deliveredAt: iso(-5),
});
check('a two-signature delivery is accepted', r.statusCode === 201);
check('received litres come from the dips, not the invoice', near(r.json().receivedL, 4940));
check('the variance is received minus invoiced', near(r.json().varianceL, -60));
check('a variance inside tolerance is not flagged', r.json().flagged === false, String(r.json().variancePct));

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 100, dipAfterL: 4600, witnessedBy: graceUserId, deliveredAt: iso(-9),
});
check('a variance beyond tolerance is flagged', r.json().flagged === true, String(r.json().variancePct));
check('the flag notifies the HOD',
  (db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'fuel_variance'`).get() as { n: number }).n > 0);

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 9000, dipAfterL: 8000, witnessedBy: graceUserId,
});
check('a closing dip below the opening dip is refused', r.statusCode === 400);

r = await post('/api/fuel/deliveries', halima, {
  tankId: bulk, invoicedL: 5000, dipBeforeL: 14000, dipAfterL: 19000, witnessedBy: graceUserId,
});
check('a delivery that would overfill the tank is refused',
  r.statusCode === 400 && r.json().error === 'over_capacity');

// issues out to the genset
for (const [days, litres] of [[-4, 1500], [-3, 1500], [-2, 1500], [-1, 1330]] as const) {
  await post('/api/fuel/issues', ifeoma, {
    tankId: bulk, toAssetId: gen01, quantityL: litres, issuedAt: iso(days),
  });
}
r = await post(`/api/fuel/tanks/${bulk}/dip`, ifeoma, { litres: 6240, takenAt: iso(0.005) });
check('a closing dip is logged', r.statusCode === 201);

r = await app.inject({
  method: 'GET', headers: grace,
  url: `/api/fuel/reconcile?tankId=${bulk}&from=${encodeURIComponent(iso(-7))}&to=${encodeURIComponent(iso(0.01))}`,
});
const rec = r.json();
check('reconciliation reads the opening dip', near(rec.openingL, 7180));
check('reconciliation sums deliveries received', near(rec.deliveriesL, 4940));
check('reconciliation sums issues out', near(rec.issuesL, 5830));
check('expected closing = opening + deliveries - issues', near(rec.computedClosingL, 6290));
check('variance = dipped closing - expected closing', near(rec.varianceL, -50), String(rec.varianceL));
check('variance is measured against throughput, not the balance',
  near(rec.variancePct, -0.46, 0.02), String(rec.variancePct));
check('a variance inside tolerance reads as ok', rec.status === 'ok');

r = await post('/api/fuel/reconcile', grace, { tankId: bulk, from: iso(-7), to: iso(0.01) });
check('a reconciliation can be closed and stored', r.statusCode === 201);

// engine health
r = await post(`/api/gensets/${gen01}/profile`, admin, {
  kvaRating: 250, expectedLphAt50: 30, expectedLphAt75: 40, expectedLphAt100: 55,
  serviceIntervalHours: 250, deviationThresholdPct: 10,
});
check('a genset profile is saved', r.statusCode === 201);

r = await post('/api/gensets/runs', ifeoma, {
  gensetAssetId: gen01, startedAt: iso(-3), endedAt: iso(-2.9),
  hoursStart: 5010, hoursEnd: 4990,
});
check('an hour meter that goes backwards is refused', r.statusCode === 400);

let raised: string | null = null;
for (let i = 0; i < 3; i++) {
  r = await post('/api/gensets/runs', ifeoma, {
    gensetAssetId: gen01, startedAt: iso(-3 + i), endedAt: iso(-2.6 + i),
    hoursStart: 5010 + i * 10, hoursEnd: 5020 + i * 10,
    fuelStartL: 500, fuelEndL: 40, kwhGenerated: 1400,
  });
  if (i === 0) {
    check('a run computes hours, fuel used and burn rate',
      r.json().runHours === 10 && near(r.json().fuelUsedL, 460) && near(r.json().actualLph, 46));
    check('the run is compared with the expected burn for the load', near(r.json().expectedLph, 40));
    check('the deviation is a percentage', near(r.json().deviationPct, 15));
    check('one bad run does not raise a job', r.json().raisedJob === null);
  }
  if (i === 1) check('two bad runs still do not raise a job', r.json().raisedJob === null);
  if (i === 2) raised = r.json().raisedJob;
}
check('three consecutive runs over threshold raise a job automatically', !!raised, String(raised));
check('the raised job names the likely cause',
  /injectors/i.test((db.prepare('SELECT description FROM work_orders WHERE ref = ?').get(raised) as
    { description: string }).description));
check('the deviation streak resets after a job is raised',
  (db.prepare('SELECT consecutive_deviations c FROM genset_profiles WHERE asset_id = ?').get(gen01) as
    { c: number }).c === 0);

r = await get('/api/power/cost', hod);
check('cost per kWh generated is reported', typeof r.json().costPerKwhKobo === 'number',
  JSON.stringify(r.json()));

// --------------------------------------------------------------------------
heading('Stores');
// --------------------------------------------------------------------------
r = await post('/api/stock', halima, {
  code: 'SP-0142', name: 'Contactor coil 240 V', unit: 'pcs', minLevel: 2, reorderQty: 6,
});
export const coil = r.json().id;
check('a stock item is created', r.statusCode === 201);

r = await post('/api/stock', halima, { code: 'SP-0142', name: 'Duplicate' });
check('a duplicate item code is refused', r.statusCode === 409);

r = await post(`/api/stock/${coil}/movement`, halima, { type: 'receipt', qtyDelta: 10, unitCostKobo: 38_500_00 });
check('stock is received', r.statusCode === 201 && r.json().balance === 10);

r = await post(`/api/stock/${coil}/movement`, ifeoma, { type: 'receipt', qtyDelta: 5 });
check('a technician cannot move stock', r.statusCode === 403 && r.json().required === 'stock.receive');

r = await post(`/api/jobs/${job.id}/parts`, halima, { itemId: coil, qty: 3 });
check('parts are issued against a job', r.statusCode === 201 && r.json().balance === 7);
check('the issue carries the job cost', r.json().totalKobo === 3 * 38_500_00);

r = await get(`/api/jobs/${job.id}`, grace);
check('the job picks up the parts cost', r.json().job.cost_parts_kobo === 3 * 38_500_00);
check('the job history records the issue',
  (r.json().history as { event_type: string }[]).some((e) => e.event_type === 'part_issued'));

r = await post(`/api/jobs/${job.id}/parts`, halima, { itemId: coil, qty: 100 });
check('issuing more than the store holds is refused',
  r.statusCode === 409 && r.json().error === 'insufficient_stock');
check('the refusal says what is actually on the shelf', /7 pcs/.test(r.json().message), r.json().message);

r = await post(`/api/stock/${coil}/movement`, halima, { type: 'receipt', qtyDelta: -20 });
check('a receipt cannot take the balance negative', r.statusCode === 409);

throws('the stock ledger refuses UPDATE',
  () => db.prepare('UPDATE stock_movements SET qty_delta = 999').run());
throws('the stock ledger refuses DELETE', () => db.prepare('DELETE FROM stock_movements').run());

r = await post('/api/stock/recompute', admin);
check('balances rebuilt from the ledger agree with the cache', r.json().corrected === 0);

r = await post(`/api/jobs/${job.id}/parts`, halima, { itemId: coil, qty: 5 });
check('taking stock to the minimum notifies the storekeeper',
  (db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'stock_low'`).get() as { n: number }).n > 0);

// ---- stock counts ---------------------------------------------------------
r = await post('/api/stock/counts', halima);
const countId = r.json().id;
check('a stock count opens with a line per catalogue item',
  r.statusCode === 201 && r.json().lines > 0, JSON.stringify(r.json()));

r = await post('/api/stock/counts', halima);
check('a second count cannot open while one is still open',
  r.statusCode === 409 && r.json().error === 'count_already_open');

r = await get(`/api/stock/counts/${countId}`, halima);
{
  const lines = r.json().lines as { id: string; item_id: string; system_qty: number;
                                    counted_qty: number; variance: number }[];
  check('every line starts at the system figure, so an untouched count posts nothing',
    lines.every((l) => l.counted_qty === l.system_qty && l.variance === 0));

  const coilLine = lines.find((l) => l.item_id === coil)!;
  const systemQty = coilLine.system_qty;

  r = await post(`/api/stock/counts/${countId}/lines`, halima, {
    lines: [{ lineId: coilLine.id, countedQty: systemQty - 2, reason: 'Two coils broken in the bin' }],
  });
  check('a counted quantity is recorded', r.statusCode === 201 && r.json().recorded === 1);

  r = await get(`/api/stock/counts/${countId}`, halima);
  const after = (r.json().lines as { id: string; variance: number }[])
    .find((l) => l.id === coilLine.id)!;
  check('the variance is derived rather than sent by the client', after.variance === -2);

  r = await post(`/api/stock/counts/${countId}/lines`, ifeoma, {
    lines: [{ lineId: coilLine.id, countedQty: 1 }],
  });
  check('counting needs the stock.adjust permission', r.statusCode === 403);

  const before = (db.prepare('SELECT current_qty FROM stock_items WHERE id = ?')
    .get(coil) as { current_qty: number }).current_qty;

  r = await post(`/api/stock/counts/${countId}/post`, halima);
  check('posting adjusts only the lines that differ',
    r.statusCode === 200 && r.json().posted === 1, JSON.stringify(r.json()));
  check('the balance moved by the variance',
    (db.prepare('SELECT current_qty FROM stock_items WHERE id = ?')
      .get(coil) as { current_qty: number }).current_qty === before - 2);
  check('and it moved because a ledger movement says so, not a silent edit',
    (db.prepare(`SELECT COUNT(*) n FROM stock_movements WHERE item_id = ? AND type = 'count'`)
      .get(coil) as { n: number }).n === 1);

  r = await post(`/api/stock/counts/${countId}/post`, halima);
  check('a posted count cannot be posted twice', r.statusCode === 409);

  r = await post(`/api/stock/counts/${countId}/lines`, halima, {
    lines: [{ lineId: coilLine.id, countedQty: 5 }],
  });
  check('a posted count cannot be edited afterwards', r.statusCode === 409);
}

r = await post('/api/stock/recompute', admin);
check('balances still rebuild from the ledger after a count', r.json().corrected === 0);

r = await post('/api/requisitions', musa, {
  purpose: 'Restock contactor coils',
  lines: [{ itemId: coil, description: 'Contactor coil 240 V', qty: 6, estimatedKobo: 231_000_00 }],
});
export const requisition = r.json().id;
check('a technician or team lead can raise a requisition', r.statusCode === 201 && /^RQ-/.test(r.json().ref));

r = await post(`/api/requisitions/${requisition}/decide`, musa, { decision: 'approved' });
check('someone without the approval right cannot decide',
  r.statusCode === 403 && r.json().required === 'requisition.approve');

// A supervisor raising their own requisition still cannot approve it.
const own = (await post('/api/requisitions', grace, {
  purpose: 'Supervisor raising their own',
  lines: [{ description: 'Spare fuses', qty: 10, estimatedKobo: 5_000_00 }],
})).json();
r = await post(`/api/requisitions/${own.id}/decide`, grace, { decision: 'approved' });
check('the person who raised a requisition cannot approve it',
  r.statusCode === 403 && r.json().error === 'self_approval', JSON.stringify(r.json()));

r = await post(`/api/requisitions/${requisition}/decide`, grace, { decision: 'approved' });
check('a supervisor approves someone else\'s requisition', r.statusCode === 200);

r = await post(`/api/requisitions/${requisition}/decide`, grace, { decision: 'rejected' });
check('a decided requisition cannot be decided again', r.statusCode === 409);

// --------------------------------------------------------------------------
heading('Departmental finance');
// --------------------------------------------------------------------------
r = await post('/api/cost-centres', femi, { code: 'DIESEL', name: 'Diesel' });
const ccDiesel = r.json().id;
r = await post('/api/cost-centres', femi, { code: 'SPARES', name: 'Spares' });
const ccSpares = r.json().id;
check('cost centres are created', r.statusCode === 201);

const now = new Date();
r = await post('/api/budgets', femi, {
  costCentreId: ccSpares, fiscalYear: now.getUTCFullYear(), periodMonth: now.getUTCMonth() + 1,
  amountKobo: 1_000_000_00,
});
check('a budget is set for the period', r.statusCode === 201);

r = await post('/api/purchases', femi, {
  description: 'Contactor coils × 6', amountKobo: 231_000_00, costCentreId: ccSpares,
  requisitionId: requisition,
});
check('a purchase is recorded against the requisition', r.statusCode === 201 && /^PU-/.test(r.json().ref));
check('the requisition moves to purchased',
  (db.prepare('SELECT status FROM requisitions WHERE id = ?').get(requisition) as { status: string })
    .status === 'purchased');

r = await post('/api/purchases', femi, {
  description: 'Vendor AC repair', amountKobo: 75_000_00, woId: job.id, costCentreId: ccSpares,
});
check('a purchase can be charged to a job', r.statusCode === 201);
r = await get(`/api/jobs/${job.id}`, grace);
check('the job picks up the vendor cost', r.json().job.cost_vendor_kobo === 75_000_00);

r = await post(`/api/jobs/${job.id}/complete`, ifeoma, { resolutionNotes: 'Second visit, coil replaced.' });
check('a reopened job cannot jump straight back to complete',
  r.statusCode === 409 && r.json().error === 'bad_transition');
await post(`/api/jobs/${job.id}/accept`, ifeoma);
await post(`/api/jobs/${job.id}/start`, ifeoma);
await post(`/api/jobs/${job.id}/complete`, ifeoma, { resolutionNotes: 'Second visit, coil replaced.' });
await post(`/api/jobs/${job.id}/verify`, grace);
r = await post('/api/purchases', femi, { description: 'Late charge', amountKobo: 1000, woId: job.id });
check('a purchase cannot be charged to a verified job', r.statusCode === 409);

r = await post('/api/expenses', femi, {
  costCentreId: ccDiesel, amountKobo: 4_280_000_00, description: 'Diesel — September',
});
export const expense = r.json().id;
r = await post(`/api/expenses/${expense}/approve`, femi);
check('the person who raised an expense cannot approve it', r.statusCode === 403);
r = await post(`/api/expenses/${expense}/approve`, hod);
check('the HOD approves it', r.statusCode === 200);

r = await get('/api/budgets/vs-actual', femi);
const spares = (r.json().lines as { code: string; budget_kobo: number; actual_kobo: number }[])
  .find((l) => l.code === 'SPARES')!;
check('budget versus actual picks up the purchases',
  spares.budget_kobo === 1_000_000_00 && spares.actual_kobo === 306_000_00,
  JSON.stringify(spares));

r = await get('/api/jobs', femi);
check('finance can read jobs', r.statusCode === 200);
r = await post('/api/jobs', femi, { title: 'Finance raising work', locationId: siteId });
check('finance cannot raise jobs', r.statusCode === 403);

// --------------------------------------------------------------------------
heading('Safety and utilities');
// --------------------------------------------------------------------------
r = await post('/api/permits', musa, {
  type: 'electrical_isolation', woId: job.id, validFrom: iso(0), validTo: iso(0.5),
  precautions: ['Prove dead before touching', 'Lock and tag the breaker'],
  isolationPoints: [{ assetId: gen01, description: 'Block B riser breaker', lockTagNo: 'LT-014' }],
});
export const permit = r.json().id;
check('a permit to work is requested', r.statusCode === 201 && /^PTW-/.test(r.json().ref));

r = await post(`/api/permits/${permit}/issue`, musa);
check('the person who requested a permit cannot issue it', r.statusCode === 403);

r = await post(`/api/permits/${permit}/issue`, grace);
check('a supervisor issues the permit', r.statusCode === 200);

const point = (db.prepare('SELECT id FROM isolation_points WHERE permit_id = ?').get(permit) as { id: string }).id;
await post(`/api/permits/${permit}/isolation/${point}`, grace, { action: 'isolate' });
r = await post(`/api/permits/${permit}/close`, grace);
check('a permit cannot close with a live isolation', r.statusCode === 409 && r.json().error === 'isolations_open');

await post(`/api/permits/${permit}/isolation/${point}`, grace, { action: 'restore' });
r = await post(`/api/permits/${permit}/close`, grace);
check('once everything is restored the permit closes', r.statusCode === 200);

r = await post('/api/incidents', ifeoma, {
  type: 'near_miss', occurredAt: iso(0), description: 'Loose cover on the riser cupboard.', severity: 'minor',
});
check('a technician can report a near miss', r.statusCode === 201);
r = await get('/api/incidents', ifeoma);
check('a technician cannot read the incident register', r.statusCode === 403);
r = await get('/api/incidents', hod);
check('the HOD can read it', r.statusCode === 200 && r.json().incidents.length === 1);

r = await post('/api/meters', admin, { type: 'electricity', serial: 'MTR-A-01', locationId: siteId });
const meter = r.json().id;
r = await post(`/api/meters/${meter}/reading`, ifeoma, { reading: 1000, readAt: iso(-60) });
check('a meter reading is recorded', r.statusCode === 201);
r = await post(`/api/meters/${meter}/reading`, ifeoma, { reading: 1200, readAt: iso(-30) });
check('consumption is derived from the previous reading', r.json().consumption === 200);
r = await post(`/api/meters/${meter}/reading`, ifeoma, { reading: 900 });
check('a reading that goes backwards is refused', r.statusCode === 400);
r = await post(`/api/meters/${meter}/reading`, ifeoma, { reading: 3000 });
check('an implausible jump is flagged as an anomaly', r.json().anomaly === true);

// --------------------------------------------------------------------------
heading('Reports');
// --------------------------------------------------------------------------
r = await get('/api/reports/dashboard', hod);
const dash = r.json();
check('the dashboard reports open job aging', typeof dash.openJobs.total === 'number');
check('it reports mean time to repair', dash.mttr.jobs > 0);
check('it reports the SLA breach rate by priority', Array.isArray(dash.slaBreach));
check('it reports first-time fix', dash.firstTimeFix.verified > 0);
check('it reports the reactive-versus-planned mix', typeof dash.workMix.reactivePct === 'number');
check('it reports PPM compliance', typeof dash.ppm.compliancePct === 'number');
check('it reports the cost of generated power', typeof dash.power.fuelUsedL === 'number');
check('reopened jobs pull first-time fix below 100%', dash.firstTimeFix.firstTimeFixPct < 100,
  String(dash.firstTimeFix.firstTimeFixPct));

r = await get('/api/reports/top-assets', femi);
check('assets are ranked by lifetime cost against replacement value',
  Array.isArray(r.json().assets));

r = await get('/api/reports/dashboard', ifeoma);
check('a technician cannot open the dashboard', r.statusCode === 403);
