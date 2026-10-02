import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission, requireSignedIn, scopeOf } from '../auth/guard.js';
import * as alerts from '../services/alerts.js';
import { ctxOf, send } from './_helpers.js';

/**
 * Ringing a device, and the emergency alert.
 *
 * Everything here is deliberately loud, so everything here is deliberately accountable:
 * a permission to use it, a record of who used it, and — the part that makes it worth
 * having — a list of who actually heard.
 */
export async function alertRoutes(app: FastifyInstance): Promise<void> {
  /** Who this person may ring, so the screen can show the button only where it works. */
  app.get('/api/alerts/ringable', { preHandler: requirePermission('alerts.ring') }, async (req) => {
    const me = req.principal!;
    const teamOnly = scopeOf(req, 'alerts.ring') === 'team';
    const args: unknown[] = [me.propertyId, me.userId ?? ''];
    let where = 'u.property_id = ? AND u.is_active = 1 AND u.id <> ?';
    if (teamOnly) {
      // A team lead rings their own people. Resolved in SQL through the staff link, so an
      // account with no staff record reaches nobody rather than everybody.
      where += ` AND u.staff_id IN (
                   SELECT s.id FROM staff s
                    WHERE s.team_id = (SELECT s2.team_id FROM staff s2
                                        JOIN users u2 ON u2.staff_id = s2.id
                                       WHERE u2.id = ?))`;
      args.push(me.userId ?? '');
    }
    return {
      scope: teamOnly ? 'team' : 'all',
      people: app.db.prepare(
        `SELECT u.id, u.display_name, r.name AS role_name,
                s.first_name || ' ' || s.last_name AS staff_name
           FROM users u
           JOIN roles r ON r.id = u.role_id
           LEFT JOIN staff s ON s.id = u.staff_id
          WHERE ${where} ORDER BY u.display_name`
      ).all(...args),
    };
  });

  app.post('/api/users/:id/ring', { preHandler: requirePermission('alerts.ring') },
    async (req, reply) => {
      const body = z.object({ reason: z.string().max(200).optional() })
        .safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      const me = req.principal!;
      const target = (req.params as { id: string }).id;

      // A team lead's reach is checked against the same list the screen was given, so the
      // button and the endpoint can never disagree.
      if (scopeOf(req, 'alerts.ring') === 'team') {
        const inTeam = app.db.prepare(
          `SELECT 1 FROM users u
            WHERE u.id = ? AND u.property_id = ? AND u.staff_id IN (
              SELECT s.id FROM staff s
               WHERE s.team_id = (SELECT s2.team_id FROM staff s2
                                   JOIN users u2 ON u2.staff_id = s2.id
                                  WHERE u2.id = ?))`
        ).get(target, me.propertyId, me.userId ?? '');
        if (!inTeam) {
          return reply.code(403).send({
            error: 'out_of_team',
            message: 'You can ring the people in your own team. Ask a supervisor for anybody else.',
          });
        }
      }

      return send(reply, () => alerts.ring(app.db, ctxOf(req),
        { userId: target, reason: body.data.reason }), 201);
    });

  /** What is ringing for me. Polled as a fallback; normally arrives on the event stream. */
  app.get('/api/me/rings', { preHandler: requireSignedIn() }, async (req) => ({
    rings: alerts.myRings(app.db, req.principal!.propertyId, req.principal!.userId ?? ''),
  }));

  app.post('/api/me/rings/:id/ack', { preHandler: requireSignedIn() }, async (req, reply) =>
    send(reply, () => alerts.acknowledgeRing(app.db, ctxOf(req), (req.params as { id: string }).id)));

  // ---- the emergency alert ---------------------------------------------------
  app.post('/api/alerts/emergency', { preHandler: requirePermission('alerts.emergency') },
    async (req, reply) => {
      const body = z.object({
        category: z.enum(alerts.EMERGENCY_CATEGORIES),
        message: z.string().min(3).max(300),
        locationId: z.string().optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      return send(reply, () => alerts.raiseEmergency(app.db, ctxOf(req), body.data), 201);
    });

  /*
   * Everybody signed in may read this, with no permission at all.
   *
   * An emergency alert that only supervisors can see is not an emergency alert — and the
   * roll call travels with it so the person by the fire door can see that the plant room
   * has not answered yet.
   */
  app.get('/api/alerts/emergency', { preHandler: requireSignedIn() }, async (req) => ({
    active: alerts.active(app.db, req.principal!.propertyId),
  }));

  app.get('/api/alerts/emergency/history', { preHandler: requirePermission('incident.read') },
    async (req) => ({ alerts: alerts.history(app.db, req.principal!.propertyId) }));

  app.post('/api/alerts/emergency/:id/ack', { preHandler: requireSignedIn() },
    async (req, reply) => {
      const body = z.object({ via: z.string().max(20).optional() }).safeParse(req.body ?? {});
      const via = body.success ? body.data.via : undefined;
      return send(reply, () => alerts.acknowledgeEmergency(
        app.db, ctxOf(req), (req.params as { id: string }).id,
        // A paired phone says so, so the roll call shows how each person was reached.
        via ?? (req.deviceId ? 'phone' : 'browser')));
    });

  app.post('/api/alerts/emergency/:id/stand-down',
    { preHandler: requirePermission('alerts.emergency') }, async (req, reply) => {
      const body = z.object({ note: z.string().max(300).optional() }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      return send(reply, () => alerts.standDown(
        app.db, ctxOf(req), (req.params as { id: string }).id, body.data.note));
    });
}
