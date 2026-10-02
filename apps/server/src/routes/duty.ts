import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission, requireSignedIn } from '../auth/guard.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../audit.js';
import { ctxOf } from './_helpers.js';

/**
 * The screen that covers the shift.
 *
 * Every other alert in this system is addressed to a person. The duty device is addressed
 * to the department: it rings for anything nobody has accepted, regardless of whose name
 * is on it, and it is the answer to the three failures the phone app cannot fix — an
 * iPhone, a handset whose manufacturer kills background services, and a phone left in a
 * van.
 *
 * Two deliberate properties:
 *
 *  - **It cannot be silenced.** The whole point is a device that is listening when nothing
 *    else is, so `alerts.silence` is ignored here regardless of the account signed in.
 *  - **It reports that it is alive.** A duty screen that stopped checking in looks exactly
 *    like a quiet night, and a supervisor needs to be able to tell those apart.
 */
export async function dutyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/duty/devices', { preHandler: requirePermission('duty.device.manage') },
    async (req) => {
      const me = req.principal!;
      return {
        devices: app.db.prepare(
          `SELECT d.*, c.display_name AS claimed_by_name, u.display_name AS signed_in_as
             FROM duty_devices d
             LEFT JOIN users c ON c.id = d.claimed_by
             LEFT JOIN users u ON u.id = d.last_user_id
            WHERE d.property_id = ? AND d.is_active = 1
            ORDER BY d.claimed_at`
        ).all(me.propertyId),
        at: nowIso(),
      };
    });

  /** Is the browser I am looking at the duty device? Answered for anybody signed in. */
  app.get('/api/duty/is-duty', { preHandler: requireSignedIn() }, async (req) => {
    const me = req.principal!;
    const id = (req.query as { deviceId?: string }).deviceId ?? '';
    if (!id) return { duty: false };
    const row = app.db.prepare(
      'SELECT label FROM duty_devices WHERE property_id = ? AND device_id = ? AND is_active = 1'
    ).get(me.propertyId, id) as { label: string } | undefined;
    return { duty: !!row, label: row?.label ?? null };
  });

  app.post('/api/duty/claim', { preHandler: requirePermission('duty.device.manage') },
    async (req, reply) => {
      const body = z.object({
        deviceId: z.string().min(8).max(64),
        label: z.string().min(1).max(60),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      const me = req.principal!;
      const at = nowIso();
      app.db.prepare(
        `INSERT INTO duty_devices (id, property_id, device_id, label, claimed_by, claimed_at,
                                   last_seen_at, last_user_id, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (property_id, device_id) DO UPDATE SET
           label = excluded.label, claimed_by = excluded.claimed_by,
           claimed_at = excluded.claimed_at, is_active = 1`
      ).run(ulid(), me.propertyId, body.data.deviceId, body.data.label.trim(),
            me.userId, at, at, me.userId);
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'duty.claimed', entityType: 'duty_device', entityId: body.data.deviceId,
        after: { label: body.data.label }, ip: req.ip, origin: req.origin,
      });
      return { ok: true };
    });

  app.post('/api/duty/release', { preHandler: requirePermission('duty.device.manage') },
    async (req, reply) => {
      const body = z.object({ deviceId: z.string().min(8).max(64) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      const me = req.principal!;
      const r = app.db.prepare(
        `UPDATE duty_devices SET is_active = 0
          WHERE property_id = ? AND device_id = ? AND is_active = 1`
      ).run(me.propertyId, body.data.deviceId);
      if (r.changes === 0) {
        return reply.code(404).send({ error: 'not_found', message: 'That screen is not a duty device.' });
      }
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'duty.released', entityType: 'duty_device', entityId: body.data.deviceId,
        ip: req.ip, origin: req.origin,
      });
      return { ok: true };
    });

  /**
   * What the duty screen rings about.
   *
   * Property-wide and nobody's in particular: anything assigned and not yet accepted, and
   * anything not assigned to anyone at all — because an unassigned P1 at 2am is exactly
   * the case where there is no individual phone to ring.
   *
   * Checking in is the same call. A screen that is reading this is a screen that is awake,
   * so there is no separate heartbeat to forget to send.
   */
  app.get('/api/duty/board', { preHandler: requireSignedIn() }, async (req) => {
    const me = req.principal!;
    const deviceId = (req.query as { deviceId?: string }).deviceId ?? '';
    const at = nowIso();

    if (deviceId) {
      app.db.prepare(
        `UPDATE duty_devices SET last_seen_at = ?, last_user_id = ?
          WHERE property_id = ? AND device_id = ? AND is_active = 1`
      ).run(at, me.userId, me.propertyId, deviceId);
    }

    const waiting = app.db.prepare(
      `SELECT w.id, w.ref, w.title, w.priority, w.status, w.assigned_at, w.respond_by,
              st.first_name || ' ' || st.last_name AS assignee,
              a.unit_no, l.name AS location_name
         FROM work_orders w
         LEFT JOIN staff st ON st.id = w.assigned_to_staff_id
         LEFT JOIN apartments a ON a.id = w.apartment_id
         LEFT JOIN locations l ON l.id = w.location_id
        WHERE w.property_id = ?
          -- 'open' is a job nobody has been given yet; 'assigned' is one somebody has been
          -- given and has not picked up. Both are work the department has not answered.
          AND w.status IN ('open', 'assigned')
        ORDER BY CASE w.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
                 COALESCE(w.respond_by, w.reported_at)`
    ).all(me.propertyId) as {
      id: string; ref: string; title: string; priority: string; status: string;
      respond_by: string | null; assignee: string | null;
    }[];

    return {
      at,
      // Past its response deadline with nobody having picked it up: the reason this screen
      // makes a noise rather than just showing a list.
      overdue: waiting.filter((w) => !!w.respond_by && w.respond_by < at),
      waiting,
      onShift: app.db.prepare(
        `SELECT COUNT(*) AS n FROM roster_entries
          WHERE property_id = ? AND work_date = date('now') AND status = 'present'`
      ).get(me.propertyId),
    };
  });
}
