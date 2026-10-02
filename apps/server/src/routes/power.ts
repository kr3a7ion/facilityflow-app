import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import * as fuel from '../services/fuel.js';
import * as load from '../services/load.js';
import * as gensetLog from '../services/gensetLog.js';
import { propertyTimezone } from '../services/roster.js';
import { localDate } from '../lib/time.js';
import { ctxOf, monthOf, send, seesMoney, withoutMoney } from './_helpers.js';

export async function powerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/fuel/tanks', { preHandler: requirePermission('fuel.read') }, async (req) => {
    const me = req.principal!;
    return {
      tanks: app.db.prepare(
        `SELECT t.*, ROUND(100.0 * COALESCE(t.current_level_l,0) / t.capacity_l, 1) AS pct_full,
                (SELECT taken_at FROM fuel_dips d WHERE d.tank_id = t.id ORDER BY taken_at DESC LIMIT 1) AS last_dip_at
           FROM fuel_tanks t WHERE t.property_id = ? AND t.is_active = 1 ORDER BY t.kind DESC, t.name`
      ).all(me.propertyId),
    };
  });

  app.post('/api/fuel/tanks', { preHandler: requirePermission('admin.settings.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(60), kind: z.enum(['bulk', 'day_tank', 'drum']),
      capacityL: z.number().positive(), minLevelL: z.number().nonnegative().optional(),
      locationId: z.string().optional(),
      // [[millimetres, litres], ...] — a horizontal cylinder is not linear.
      dipChart: z.array(z.tuple([z.number(), z.number()])).min(2).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;
    app.db.prepare(
      `INSERT INTO fuel_tanks (id, property_id, name, location_id, kind, capacity_l, min_level_l,
        dip_chart_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, me.propertyId, d.name, d.locationId ?? null, d.kind, d.capacityL, d.minLevelL ?? 0,
          d.dipChart ? JSON.stringify(d.dipChart) : null, at, at);
    return reply.code(201).send({
      ok: true, id,
      warning: d.dipChart ? undefined
        : 'No calibration chart: dips must be entered in litres until one is added.',
    });
  });

  app.post('/api/fuel/tanks/:id/dip', { preHandler: requirePermission('fuel.dip.log') }, async (req, reply) => {
    const body = z.object({
      litres: z.number().nonnegative().optional(), dipMm: z.number().nonnegative().optional(),
      takenAt: z.string().optional(), shiftPatternId: z.string().optional(), note: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    return send(reply, () =>
      fuel.logDip(app.db, ctxOf(req), (req.params as { id: string }).id, body.data), 201);
  });

  app.get('/api/fuel/tanks/:id/dips', { preHandler: requirePermission('fuel.read') }, async (req) => ({
    dips: app.db.prepare(
      `SELECT d.*, u.display_name AS taken_by_name FROM fuel_dips d
         LEFT JOIN users u ON u.id = d.taken_by
        WHERE d.tank_id = ? ORDER BY d.taken_at DESC LIMIT 100`
    ).all((req.params as { id: string }).id),
  }));

  // ---- deliveries: two signatures, always -----------------------------------
  app.post('/api/fuel/deliveries', { preHandler: requirePermission('fuel.delivery.create') },
    async (req, reply) => {
      const body = z.object({
        tankId: z.string(), invoicedL: z.number().positive(),
        dipBeforeL: z.number().nonnegative(), dipAfterL: z.number().nonnegative(),
        witnessedBy: z.string(), deliveredAt: z.string().optional(), vendorId: z.string().optional(),
        waybillNo: z.string().max(60).optional(), truckReg: z.string().max(30).optional(),
        driverName: z.string().max(80).optional(), orderedL: z.number().positive().optional(),
        unitPriceKobo: z.number().int().nonnegative().optional(), notes: z.string().max(500).optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      return send(reply, () => fuel.recordDelivery(app.db, ctxOf(req), body.data), 201);
    });

  app.get('/api/fuel/deliveries', { preHandler: requirePermission('fuel.read') }, async (req) => {
    const period = monthOf(app, req);
    return {
      period,
      // Litres are an operational fact and everybody who may read fuel needs them. What
      // the property pays per litre is not: `fuel.read` is granted to every technician so
      // they can dip a tank, and it was handing them the diesel spend with it.
      deliveries: withoutMoney(req, app.db.prepare(
        `SELECT d.*, t.name AS tank_name, r.display_name AS received_by_name, w.display_name AS witnessed_by_name
           FROM fuel_deliveries d
           JOIN fuel_tanks t ON t.id = d.tank_id
           LEFT JOIN users r ON r.id = d.received_by
           LEFT JOIN users w ON w.id = d.witnessed_by
          WHERE d.property_id = ? AND d.delivered_at >= ? AND d.delivered_at < ?
          ORDER BY d.delivered_at DESC LIMIT 300`
      ).all(req.principal!.propertyId, period.from, period.to) as Record<string, unknown>[],
      ['unit_price_kobo', 'total_kobo']),
      showsCost: seesMoney(req),
    };
  });

  app.post('/api/fuel/issues', { preHandler: requirePermission('fuel.dip.log') }, async (req, reply) => {
    const body = z.object({
      tankId: z.string(), toAssetId: z.string().optional(), toTankId: z.string().optional(),
      quantityL: z.number().positive(), method: z.enum(['pump', 'manual', 'auto_topup']).optional(),
      issuedAt: z.string().optional(), note: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    return send(reply, () => fuel.issue(app.db, ctxOf(req), body.data), 201);
  });

  // ---- runs and engine health ------------------------------------------------
  app.post('/api/gensets/:id/profile', { preHandler: requirePermission('asset.manage') }, async (req, reply) => {
    const body = z.object({
      kvaRating: z.number().positive(),
      expectedLphAt50: z.number().positive().optional(),
      expectedLphAt75: z.number().positive().optional(),
      expectedLphAt100: z.number().positive().optional(),
      serviceIntervalHours: z.number().positive().optional(),
      deviationThresholdPct: z.number().positive().max(100).optional(),
      dayTankId: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const id = (req.params as { id: string }).id; const at = nowIso(); const d = body.data;
    const asset = app.db.prepare('SELECT current_meter FROM assets WHERE id = ? AND property_id = ?')
      .get(id, req.principal!.propertyId) as { current_meter: number | null } | undefined;
    if (!asset) return reply.code(404).send({ error: 'not_found', message: 'That generator does not exist.' });
    app.db.prepare(
      `INSERT INTO genset_profiles (asset_id, kva_rating, expected_lph_at_50pct, expected_lph_at_75pct,
        expected_lph_at_100pct, service_interval_hours, next_service_hours, day_tank_id,
        deviation_threshold_pct, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id) DO UPDATE SET kva_rating = excluded.kva_rating,
         expected_lph_at_50pct = excluded.expected_lph_at_50pct,
         expected_lph_at_75pct = excluded.expected_lph_at_75pct,
         expected_lph_at_100pct = excluded.expected_lph_at_100pct,
         service_interval_hours = excluded.service_interval_hours,
         day_tank_id = excluded.day_tank_id,
         deviation_threshold_pct = excluded.deviation_threshold_pct, updated_at = excluded.updated_at`
    ).run(id, d.kvaRating, d.expectedLphAt50 ?? null, d.expectedLphAt75 ?? null, d.expectedLphAt100 ?? null,
          d.serviceIntervalHours ?? null,
          d.serviceIntervalHours ? (asset.current_meter ?? 0) + d.serviceIntervalHours : null,
          d.dayTankId ?? null, d.deviationThresholdPct ?? 10, at);
    return reply.code(201).send({ ok: true });
  });

  app.post('/api/gensets/runs', { preHandler: requirePermission('genset.run.log') }, async (req, reply) => {
    const body = z.object({
      gensetAssetId: z.string(), startedAt: z.string(), endedAt: z.string(),
      hoursStart: z.number().nonnegative(), hoursEnd: z.number().nonnegative(),
      fuelStartL: z.number().nonnegative().optional(), fuelEndL: z.number().nonnegative().optional(),
      fuelTopupL: z.number().nonnegative().optional(), avgLoadKw: z.number().nonnegative().optional(),
      kwhGenerated: z.number().nonnegative().optional(), outageId: z.string().optional(),
      reason: z.enum(['utility_outage', 'weekly_test', 'load_test', 'maintenance', 'load_shedding']).optional(),
      notes: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    return send(reply, () => fuel.recordRun(app.db, ctxOf(req), body.data), 201);
  });

  app.get('/api/gensets/runs', { preHandler: requirePermission('fuel.read') }, async (req) => {
    const q = req.query as { assetId?: string; limit?: string; month?: string };
    const limit = Math.min(Number(q.limit) || 30, 200);
    // The burn trend needs a run of consecutive runs to mean anything, so this only
    // narrows to a month when one is asked for. The default is the last N runs,
    // whenever they happened.
    const period = q.month ? monthOf(app, req) : null;
    return {
      period,
      runs: app.db.prepare(
        `SELECT r.*, a.asset_tag, a.name AS genset_name FROM generator_runs r
           JOIN assets a ON a.id = r.genset_asset_id
          WHERE r.property_id = ? AND (? IS NULL OR r.genset_asset_id = ?)
            AND (? IS NULL OR (r.started_at >= ? AND r.started_at < ?))
          ORDER BY r.started_at DESC LIMIT ?`
      ).all(req.principal!.propertyId, q.assetId ?? null, q.assetId ?? null,
            period?.from ?? null, period?.from ?? null, period?.to ?? null, limit),
    };
  });

  app.post('/api/outages', { preHandler: requirePermission('genset.run.log') }, async (req, reply) => {
    const body = z.object({
      startedAt: z.string(), endedAt: z.string().optional(),
      source: z.enum(['utility', 'planned', 'internal_fault']).optional(), notes: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const id = ulid();
    app.db.prepare(
      `INSERT INTO power_outages (id, property_id, started_at, ended_at, source, notes, logged_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, me.propertyId, body.data.startedAt, body.data.endedAt ?? null,
          body.data.source ?? 'utility', body.data.notes ?? null, me.userId, nowIso());
    return reply.code(201).send({ ok: true, id });
  });

  // ---- reconciliation --------------------------------------------------------
  app.get('/api/fuel/reconcile', { preHandler: requirePermission('fuel.read') }, async (req, reply) => {
    const q = req.query as { tankId?: string; from?: string; to?: string };
    if (!q.tankId || !q.from || !q.to) {
      return reply.code(400).send({ error: 'invalid', message: 'Give a tank and a period (from, to).' });
    }
    return send(reply, () => fuel.reconcile(app.db, req.principal!.propertyId, q.tankId!, q.from!, q.to!));
  });

  app.post('/api/fuel/reconcile', { preHandler: requirePermission('fuel.reconcile') }, async (req, reply) => {
    const body = z.object({ tankId: z.string(), from: z.string(), to: z.string(),
                            explanation: z.string().max(1000).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    return send(reply, () => {
      const ctx = ctxOf(req);
      const r = fuel.reconcile(app.db, ctx.propertyId, body.data.tankId, body.data.from, body.data.to);
      const id = fuel.saveReconciliation(app.db, ctx, r);
      if (body.data.explanation) {
        app.db.prepare(
          `UPDATE fuel_reconciliations SET status = 'explained', explanation = ?, explained_by = ?, explained_at = ?
            WHERE id = ?`
        ).run(body.data.explanation, ctx.userId, nowIso(), id);
      }
      return { id, ...r };
    }, 201);
  });

  // Naira per unit generated. A cost figure, so it takes the cost permission and not the
  // one that lets a technician read a tank level.
  app.get('/api/power/cost', { preHandler: requirePermission('cost.read') }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const to = q.to ?? nowIso();
    const from = q.from ?? new Date(new Date(to).getTime() - 30 * 86_400_000).toISOString();
    return fuel.costPerKwh(app.db, req.principal!.propertyId, from, to);
  });

  // ---- clamp readings and building load --------------------------------------
  app.get('/api/power/sources', { preHandler: requirePermission('fuel.read') }, async (req) => {
    const q = req.query as { all?: string };
    return { sources: load.sources(app.db, req.principal!.propertyId, q.all === '1') };
  });

  const sourceBody = z.object({
    name: z.string().min(1).max(60),
    kind: z.enum(['utility', 'genset', 'feeder']),
    gensetAssetId: z.string().optional(),
    phases: z.union([z.literal(1), z.literal(3)]).optional(),
    nominalVolts: z.number().positive().max(1000).optional(),
    defaultPf: z.number().positive().max(1).optional(),
    ctRatio: z.number().positive().optional(),
    breakerAmps: z.number().positive().optional(),
    isIncomer: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
  });

  app.post('/api/power/sources', { preHandler: requirePermission('power.source.manage') },
    async (req, reply) => {
      const body = sourceBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      return send(reply, () => load.saveSource(app.db, ctxOf(req), body.data), 201);
    });

  app.patch('/api/power/sources/:id', { preHandler: requirePermission('power.source.manage') },
    async (req, reply) => {
      const body = sourceBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      return send(reply, () =>
        load.saveSource(app.db, ctxOf(req), body.data, (req.params as { id: string }).id));
    });

  app.post('/api/power/clamp', { preHandler: requirePermission('power.clamp.log') },
    async (req, reply) => {
      const body = z.object({
        sourceId: z.string(),
        l1Amps: z.number().nonnegative().max(20_000),
        l2Amps: z.number().nonnegative().max(20_000).optional(),
        l3Amps: z.number().nonnegative().max(20_000).optional(),
        neutralAmps: z.number().nonnegative().max(20_000).optional(),
        volts: z.number().positive().max(1000).optional(),
        powerFactor: z.number().positive().max(1).optional(),
        takenAt: z.string().optional(),
        note: z.string().max(300).optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      return send(reply, () => load.recordClamp(app.db, ctxOf(req), body.data), 201);
    });

  app.get('/api/power/clamp', { preHandler: requirePermission('fuel.read') }, async (req) => {
    const q = req.query as { sourceId?: string; from?: string; to?: string; limit?: string };
    return {
      readings: load.readings(app.db, req.principal!.propertyId, {
        sourceId: q.sourceId, from: q.from, to: q.to, limit: Number(q.limit) || 100,
      }),
    };
  });

  // The screen that answers "which set do we start". Cheap enough to poll.
  app.get('/api/power/load', { preHandler: requirePermission('fuel.read') }, async (req) =>
    load.loadNow(app.db, req.principal!.propertyId));

  app.get('/api/power/load/trend', { preHandler: requirePermission('fuel.read') }, async (req) => {
    const q = req.query as { from?: string; to?: string; sourceId?: string };
    const to = q.to ?? nowIso();
    const from = q.from ?? new Date(new Date(to).getTime() - 30 * 86_400_000).toISOString();
    return { points: load.loadTrend(app.db, req.principal!.propertyId, from, to, q.sourceId) };
  });

  /**
   * The generator logbook.
   *
   * Written by whoever is on shift, which is why it is `genset.run.log` and not a
   * supervisor permission: the person standing in front of the machine is the one who
   * can read the gauges, and a log somebody has to ask permission to write is a log that
   * does not get written.
   */
  app.post('/api/power/gensets/:assetId/log',
    { preHandler: requirePermission('genset.run.log') }, async (req, reply) => {
      const num = z.number().finite();
      const body = z.object({
        state: z.enum(['running', 'stopped']).optional(),
        takenAt: z.string().optional(),
        hoursMeter: num.min(0).max(1_000_000).optional(),
        dayTankL: num.min(0).max(100_000).optional(),
        dayTankPct: num.min(0).max(100).optional(),
        coolantTempC: num.min(-40).max(200).optional(),
        oilPressureBar: num.min(0).max(20).optional(),
        batteryVolts: num.min(0).max(120).optional(),
        voltsL1: num.min(0).max(1000).optional(),
        voltsL2: num.min(0).max(1000).optional(),
        voltsL3: num.min(0).max(1000).optional(),
        ampsL1: num.min(0).max(10_000).optional(),
        ampsL2: num.min(0).max(10_000).optional(),
        ampsL3: num.min(0).max(10_000).optional(),
        frequencyHz: num.min(0).max(200).optional(),
        loadKw: num.min(0).max(100_000).optional(),
        remarks: z.string().max(2000).optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });

      const me = req.principal!;
      // An entry with nothing in it is not a log entry. The meter alone is enough, or a
      // remark alone — somebody noting a smell with every gauge unreadable is a real and
      // useful entry — but an empty form saved by accident is not.
      const filled = Object.entries(body.data)
        .filter(([k]) => k !== 'state' && k !== 'takenAt')
        .some(([, v]) => v !== undefined && v !== '');
      if (!filled) {
        return reply.code(400).send({
          error: 'empty_entry',
          message: 'Nothing was entered. Record at least the hour meter, or a remark about what you saw.',
        });
      }

      const out = gensetLog.record(app.db, ctxOf(req), (req.params as { assetId: string }).assetId,
        body.data, propertyTimezone(app.db, me.propertyId));
      return reply.code(201).send(out);
    });

  app.get('/api/power/gensets/log', { preHandler: requirePermission('fuel.read') }, async (req) => {
    const q = req.query as { assetId?: string; from?: string; to?: string; limit?: string; month?: string };
    const period = q.month ? monthOf(app, req) : null;
    return {
      entries: gensetLog.entries(app.db, req.principal!.propertyId, {
        assetId: q.assetId,
        from: period?.from ?? q.from,
        to: period?.to ?? q.to,
        limit: Number(q.limit) || 200,
      }),
      period,
    };
  });

  /** Which sets have been logged today and which have not — the end-of-shift question. */
  app.get('/api/power/gensets/today', { preHandler: requirePermission('fuel.read') }, async (req) => {
    const me = req.principal!;
    const today = localDate(propertyTimezone(app.db, me.propertyId));
    return { workDate: today, sets: gensetLog.todayStatus(app.db, me.propertyId, today) };
  });

  /** What counts as normal for this set, so a reading can be judged. */
  app.get('/api/power/gensets/:assetId/limits',
    { preHandler: requirePermission('fuel.read') }, async (req, reply) => {
      const lim = gensetLog.limitsFor(app.db, (req.params as { assetId: string }).assetId);
      if (!lim) {
        return reply.code(404).send({
          error: 'no_profile',
          message: 'This set has no rating on file yet, so its readings cannot be judged. Add the kVA rating under Assets first.',
        });
      }
      return lim;
    });
}
