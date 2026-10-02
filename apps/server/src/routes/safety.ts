import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.js';
import { ulid } from '../lib/ids.js';
import { nextRef } from '../lib/refs.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../audit.js';
import { monthOf } from './_helpers.js';

export async function safetyRoutes(app: FastifyInstance): Promise<void> {
  // ---- permit to work --------------------------------------------------------
  app.get('/api/permits', { preHandler: requirePermission('permit.request') }, async (req) => {
    const me = req.principal!;
    const period = monthOf(app, req);
    const permits = app.db.prepare(
      `SELECT p.*, w.ref AS wo_ref, r.display_name AS requested_by_name, i.display_name AS issued_by_name
         FROM permits p
         LEFT JOIN work_orders w ON w.id = p.wo_id
         LEFT JOIN users r ON r.id = p.requested_by
         LEFT JOIN users i ON i.id = p.issued_by
        WHERE p.property_id = ?
          AND (
            (p.created_at >= ? AND p.created_at < ?)
            -- A live permit is a lock on a piece of plant. It is never filtered out of
            -- view by a date, whatever month somebody happens to be looking at.
            OR p.status IN ('requested','issued')
          )
        ORDER BY p.status, p.valid_to DESC LIMIT 300`
    ).all(me.propertyId, period.from, period.to) as { id: string }[];
    // A permit without its isolation points is only half the document.
    return {
      permits: permits.map((p) => ({
        ...p,
        isolationPoints: app.db.prepare(
          `SELECT i.id, i.point_description, i.lock_tag_no, i.isolated_at, i.restored_at,
                  a.asset_tag
             FROM isolation_points i LEFT JOIN assets a ON a.id = i.asset_id
            WHERE i.permit_id = ?`
        ).all(p.id),
      })),
    };
  });

  app.post('/api/permits', { preHandler: requirePermission('permit.request') }, async (req, reply) => {
    const body = z.object({
      type: z.enum(['hot_work', 'electrical_isolation', 'height', 'confined_space', 'excavation']),
      woId: z.string().optional(), locationId: z.string().optional(),
      validFrom: z.string(), validTo: z.string(),
      precautions: z.array(z.string().max(200)).max(40).optional(),
      isolationPoints: z.array(z.object({
        assetId: z.string().optional(), description: z.string().min(1).max(200),
        lockTagNo: z.string().max(40).optional(),
      })).max(40).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const d = body.data;
    if (d.validTo <= d.validFrom) {
      return reply.code(400).send({ error: 'invalid_dates', message: 'The permit must end after it starts.' });
    }
    const me = req.principal!; const at = nowIso(); const id = ulid();
    const ref = app.db.transaction(() => {
      const r = nextRef(app.db, me.propertyId, 'PTW');
      app.db.prepare(
        `INSERT INTO permits (id, property_id, ref, type, wo_id, location_id, requested_by, valid_from,
          valid_to, precautions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, r, d.type, d.woId ?? null, d.locationId ?? null, me.userId,
            d.validFrom, d.validTo, d.precautions ? JSON.stringify(d.precautions) : null, at, at);
      const ins = app.db.prepare(
        `INSERT INTO isolation_points (id, permit_id, asset_id, point_description, lock_tag_no)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const p of d.isolationPoints ?? []) {
        ins.run(ulid(), id, p.assetId ?? null, p.description, p.lockTagNo ?? null);
      }
      return r;
    })();
    return reply.code(201).send({ ok: true, id, ref, status: 'requested' });
  });

  /** The person who asks for a permit is not the person who issues it. */
  app.post('/api/permits/:id/issue', { preHandler: requirePermission('permit.issue') }, async (req, reply) => {
    const me = req.principal!; const id = (req.params as { id: string }).id;
    const p = app.db.prepare('SELECT ref, requested_by, status FROM permits WHERE id = ? AND property_id = ?')
      .get(id, me.propertyId) as { ref: string; requested_by: string; status: string } | undefined;
    if (!p) return reply.code(404).send({ error: 'not_found', message: 'That permit does not exist.' });
    if (p.requested_by === me.userId) {
      return reply.code(403).send({
        error: 'self_issue', message: 'You requested this permit, so someone else has to issue it.',
      });
    }
    if (p.status !== 'requested') {
      return reply.code(409).send({ error: 'bad_state', message: `That permit is already ${p.status}.` });
    }
    const at = nowIso();
    app.db.prepare(`UPDATE permits SET status = 'issued', issued_by = ?, updated_at = ? WHERE id = ?`)
      .run(me.userId, at, id);
    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'permit.issued', entityType: 'permit', entityId: id, after: { ref: p.ref }, ip: req.ip,
    });
    return { ok: true };
  });

  app.post('/api/permits/:id/close', { preHandler: requirePermission('permit.issue') }, async (req, reply) => {
    const me = req.principal!; const id = (req.params as { id: string }).id; const at = nowIso();
    const open = app.db.prepare(
      'SELECT COUNT(*) AS n FROM isolation_points WHERE permit_id = ? AND isolated_at IS NOT NULL AND restored_at IS NULL'
    ).get(id) as { n: number };
    if (open.n > 0) {
      return reply.code(409).send({
        error: 'isolations_open',
        message: `${open.n} isolation point(s) are still locked out. Restore them before closing the permit.`,
      });
    }
    const r = app.db.prepare(
      `UPDATE permits SET status = 'closed', closed_by = ?, closed_at = ?, updated_at = ?
        WHERE id = ? AND property_id = ? AND status = 'issued'`
    ).run(me.userId, at, at, id, me.propertyId);
    if (!r.changes) {
      return reply.code(409).send({ error: 'bad_state', message: 'Only an issued permit can be closed.' });
    }
    return { ok: true };
  });

  app.post('/api/permits/:id/isolation/:pointId', { preHandler: requirePermission('permit.issue') },
    async (req, reply) => {
      const body = z.object({ action: z.enum(['isolate', 'restore']) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      const me = req.principal!; const { pointId } = req.params as { pointId: string }; const at = nowIso();
      const sql = body.data.action === 'isolate'
        ? 'UPDATE isolation_points SET isolated_by = ?, isolated_at = ? WHERE id = ?'
        : 'UPDATE isolation_points SET restored_by = ?, restored_at = ? WHERE id = ?';
      const r = app.db.prepare(sql).run(me.userId, at, pointId);
      if (!r.changes) return reply.code(404).send({ error: 'not_found', message: 'That isolation point does not exist.' });
      return { ok: true };
    });

  // ---- incidents -------------------------------------------------------------
  app.post('/api/incidents', { preHandler: requirePermission('incident.report') }, async (req, reply) => {
    const body = z.object({
      type: z.enum(['injury', 'near_miss', 'property_damage', 'fire', 'spill']),
      occurredAt: z.string(), description: z.string().min(5).max(4000),
      severity: z.enum(['minor', 'moderate', 'major', 'critical']).optional(),
      locationId: z.string().optional(), immediateAction: z.string().max(2000).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;
    const ref = app.db.transaction(() => {
      const r = nextRef(app.db, me.propertyId, 'INC');
      app.db.prepare(
        `INSERT INTO incidents (id, property_id, ref, occurred_at, type, location_id, description, severity,
          immediate_action, reported_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, r, d.occurredAt, d.type, d.locationId ?? null, d.description,
            d.severity ?? 'minor', d.immediateAction ?? null, me.userId, at, at);
      return r;
    })();
    return reply.code(201).send({ ok: true, id, ref });
  });

  /** Injury records are sensitive employee data — a separate permission from reporting one. */
  app.get('/api/incidents', { preHandler: requirePermission('incident.read') }, async (req) => {
    const period = monthOf(app, req);
    return {
      period,
      incidents: app.db.prepare(
        `SELECT i.*, u.display_name AS reported_by_name, l.name AS location_name FROM incidents i
           LEFT JOIN users u ON u.id = i.reported_by
           LEFT JOIN locations l ON l.id = i.location_id
          -- Strictly the month, unlike permits and jobs: an incident is a closed record
          -- of something that happened on a date, and a safety report for September
          -- that quietly includes August is not a safety report.
          WHERE i.property_id = ? AND i.occurred_at >= ? AND i.occurred_at < ?
          ORDER BY i.occurred_at DESC LIMIT 300`
      ).all(req.principal!.propertyId, period.from, period.to),
    };
  });

  // ---- utility meters --------------------------------------------------------
  app.get('/api/meters', { preHandler: requirePermission('location.read') }, async (req) => ({
    meters: app.db.prepare(
      `SELECT m.*, l.name AS location_name, a.unit_no,
              (SELECT reading FROM meter_readings r WHERE r.meter_id = m.id ORDER BY read_at DESC LIMIT 1) AS last_reading,
              (SELECT read_at FROM meter_readings r WHERE r.meter_id = m.id ORDER BY read_at DESC LIMIT 1) AS last_read_at
         FROM meters m
         LEFT JOIN locations l ON l.id = m.location_id
         LEFT JOIN apartments a ON a.id = m.apartment_id
        WHERE m.property_id = ? AND m.is_active = 1 ORDER BY m.type, m.serial`
    ).all(req.principal!.propertyId),
  }));

  app.post('/api/meters', { preHandler: requirePermission('asset.manage') }, async (req, reply) => {
    const body = z.object({
      type: z.enum(['electricity', 'water', 'gas']), serial: z.string().min(1).max(60),
      locationId: z.string().optional(), apartmentId: z.string().optional(),
      multiplier: z.number().positive().optional(), unit: z.string().max(12).optional(),
      readingFrequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;
    try {
      app.db.prepare(
        `INSERT INTO meters (id, property_id, type, serial, location_id, apartment_id, multiplier, unit,
          reading_frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, d.type, d.serial, d.locationId ?? null, d.apartmentId ?? null,
            d.multiplier ?? 1, d.unit ?? (d.type === 'electricity' ? 'kWh' : 'm3'),
            d.readingFrequency ?? 'monthly', at, at);
    } catch {
      return reply.code(409).send({ error: 'duplicate', message: `Meter "${d.serial}" is already registered.` });
    }
    return reply.code(201).send({ ok: true, id });
  });

  app.post('/api/meters/:id/reading', { preHandler: requirePermission('fuel.dip.log') }, async (req, reply) => {
    const body = z.object({
      reading: z.number().nonnegative(), readAt: z.string().optional(),
      isEstimated: z.boolean().optional(), note: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const id = (req.params as { id: string }).id; const at = nowIso();
    const meter = app.db.prepare('SELECT multiplier FROM meters WHERE id = ? AND property_id = ?')
      .get(id, me.propertyId) as { multiplier: number } | undefined;
    if (!meter) return reply.code(404).send({ error: 'not_found', message: 'That meter does not exist.' });

    const prev = app.db.prepare(
      'SELECT reading FROM meter_readings WHERE meter_id = ? ORDER BY read_at DESC LIMIT 1'
    ).get(id) as { reading: number } | undefined;

    if (prev && body.data.reading < prev.reading) {
      return reply.code(400).send({
        error: 'reading_went_backwards',
        message: `The meter last read ${prev.reading}. A lower figure means the meter rolled over or was replaced — record that instead.`,
      });
    }
    const consumption = prev ? (body.data.reading - prev.reading) * meter.multiplier : null;
    // A month at more than three times the recent average is worth a second look.
    const avg = app.db.prepare(
      'SELECT AVG(consumption) AS a FROM (SELECT consumption FROM meter_readings WHERE meter_id = ? AND consumption IS NOT NULL ORDER BY read_at DESC LIMIT 6)'
    ).get(id) as { a: number | null };
    const anomaly = consumption != null && avg.a != null && avg.a > 0 && consumption > avg.a * 3;

    app.db.prepare(
      `INSERT INTO meter_readings (id, meter_id, read_at, reading, consumption, read_by, is_estimated, anomaly, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ulid(), id, body.data.readAt ?? at, body.data.reading, consumption, me.userId,
          body.data.isEstimated ? 1 : 0, anomaly ? 1 : 0, body.data.note ?? null, at);

    return reply.code(201).send({
      ok: true, consumption,
      anomaly, note: anomaly ? 'This reading is more than three times the recent average — check for a leak or a misread.' : undefined,
    });
  });
}
