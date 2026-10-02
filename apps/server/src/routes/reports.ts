import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../auth/guard.js';
import { nowIso } from '../lib/time.js';
import * as reports from '../services/reports.js';
import { lowStock } from '../services/stores.js';
import { tick } from '../services/escalation.js';
import { propertyTimezone } from '../services/roster.js';
import { localDate } from '../lib/time.js';
import { monthOf } from './_helpers.js';
import { readiness } from '../services/readiness.js';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The status strip above every screen. One call, cheap enough to poll.
   *
   * Cut to what the caller may actually see. Being signed in was the only requirement
   * here, so a front-office requester who cannot open the fuel screen was still shown
   * every tank's level, every set's running hours and the building load on every page —
   * on a phone, above everything, whether or not it meant anything to them. Each cell is
   * now gated by the permission that guards the screen the number comes from, and the
   * fields a person cannot see are never sent to their device at all rather than being
   * hidden in the client.
   */
  app.get('/api/status/plant', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'not_signed_in' });
    const me = req.principal;
    const today = localDate(propertyTimezone(app.db, me.propertyId));
    const full = reports.plantStatus(app.db, me.propertyId, today);
    const plant = me.permissions.has('fuel.read');
    return {
      at: full.at,
      utility: plant ? full.utility : undefined,
      gensets: plant ? full.gensets : [],
      tanks: plant ? full.tanks : [],
      load: plant ? full.load : undefined,
      openP1: me.permissions.has('wo.read') ? full.openP1 : undefined,
      onShift: me.permissions.has('roster.read') ? full.onShift : undefined,
    };
  });

  /**
   * What is still to be set up. Every signed-in person may ask — the answer is filtered
   * to the steps they could actually act on, so a technician is not shown a checklist of
   * things only an administrator can do.
   */
  app.get('/api/setup/progress', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'not_signed_in' });
    const me = req.principal;
    const full = readiness(app.db, me.propertyId, app.config);
    const mine = full.steps.filter((s) => me.permissions.has(s.needs));
    return {
      ...full,
      steps: mine,
      // The headline counts stay whole-property: "6 of 14" must mean the same thing to
      // everyone, or two people comparing screens will think the system disagrees.
      visibleCount: mine.length,
      canAct: mine.length > 0,
    };
  });

  app.get('/api/reports/dashboard', { preHandler: requirePermission('report.read') }, async (req) => {
    const me = req.principal!;
    const q = req.query as { from?: string; to?: string; month?: string };
    // Rolling thirty days by default, because a dashboard that resets to zero every
    // first of the month tells the morning meeting nothing. A month is available for
    // the report somebody takes upstairs.
    const period = q.month ? monthOf(app, req) : null;
    const to = period?.to ?? q.to ?? nowIso();
    const from = period?.from ?? q.from ?? new Date(new Date(to).getTime() - 30 * 86_400_000).toISOString();
    const full = reports.dashboard(app.db, me.propertyId, from, to);
    return {
      ...full,
      // Cost per unit generated is a naira figure, and report.read reaches further than
      // the people who should see one — a team lead and a storekeeper both hold it.
      power: me.permissions.has('cost.read') ? full.power
        : { fuelUsedL: full.power.fuelUsedL, kwh: full.power.kwh },
      period,
      lowStock: me.permissions.has('stock.read') ? lowStock(app.db, me.propertyId) : undefined,
      showsCost: me.permissions.has('cost.read'),
    };
  });

  app.get('/api/reports/cost-per-apartment', { preHandler: requirePermission('finance.read') }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const to = q.to ?? nowIso();
    const from = q.from ?? new Date(new Date(to).getTime() - 365 * 86_400_000).toISOString();
    return { from, to, apartments: reports.costPerApartment(app.db, req.principal!.propertyId, from, to) };
  });

  app.get('/api/reports/top-assets', { preHandler: requirePermission('finance.read') }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const to = q.to ?? nowIso();
    const from = q.from ?? new Date(new Date(to).getTime() - 365 * 86_400_000).toISOString();
    return {
      from, to,
      assets: reports.topAssetsByCost(app.db, req.principal!.propertyId, from, to),
      note: 'Past roughly half of replacement value, the repair-or-replace argument writes itself.',
    };
  });

  /** Exposed so a supervisor can force the sweep; the host runs it every few minutes. */
  app.post('/api/reports/escalate', { preHandler: requirePermission('wo.assign') }, async (req) =>
    tick(app.db, req.principal!.propertyId));
}
