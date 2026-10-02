import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSignedIn } from '../auth/guard.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../audit.js';
import type { Db } from '../db/connection.js';

/**
 * Taking something out of use.
 *
 * Every registry table in this system was given an `is_active` column on day one and
 * almost none of them could be set from the app. You could add a tank, a cost centre, a
 * shift pattern, a stock item, a place — and never take one away. The department's words
 * were "remove button is not available for added items and sections you add and want to
 * delete", and they were right about every one of them.
 *
 * Three decisions hold this together:
 *
 * 1. **Nothing is ever deleted.** A row that a movement, an event or an audit entry points
 *    at has to keep existing or the history stops making sense. Retiring hides it from
 *    every picker and list and leaves it readable from whatever already refers to it.
 *
 * 2. **The table name never comes from the request.** The map below is the whole universe
 *    of what can be retired; a path that is not a key in it is a 404 before anything is
 *    read. There is no construction of SQL from user input anywhere in this file.
 *
 * 3. **It refuses when retiring would strand live work**, and says what is in the way
 *    rather than "cannot". A button that is dangerous is a button people learn to fear;
 *    a button that explains itself is one they use.
 */

interface Retirable {
  table: string;
  needs: string;
  label: string;
  /** The column holding the human name, for the audit entry and the message. */
  nameColumn: string;
  /** cost_centres is the one table here without an updated_at column. */
  noUpdatedAt?: boolean;
  /** What must be dealt with first. Empty means nothing is in the way. */
  blockers?: (db: Db, propertyId: string, id: string) => string[];
}

const OPEN_JOB = `status NOT IN ('closed','cancelled','verified')`;

function count(db: Db, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

const RETIRABLE: Record<string, Retirable> = {
  asset: {
    table: 'assets', needs: 'asset.manage', label: 'asset', nameColumn: 'name',
    blockers: (db, _p, id) => {
      const out: string[] = [];
      const jobs = count(db, `SELECT COUNT(*) AS n FROM work_orders WHERE asset_id = ? AND ${OPEN_JOB}`, id);
      if (jobs) out.push(`${jobs} open job${jobs === 1 ? '' : 's'} against it`);
      const ppm = count(db,
        'SELECT COUNT(*) AS n FROM ppm_schedules WHERE asset_id = ? AND is_active = 1', id);
      if (ppm) out.push(`${ppm} planned maintenance schedule${ppm === 1 ? '' : 's'} still running`);
      return out;
    },
  },
  apartment: {
    table: 'apartments', needs: 'apartment.manage', label: 'apartment', nameColumn: 'unit_no',
    blockers: (db, _p, id) => {
      const jobs = count(db, `SELECT COUNT(*) AS n FROM work_orders WHERE apartment_id = ? AND ${OPEN_JOB}`, id);
      return jobs ? [`${jobs} open job${jobs === 1 ? '' : 's'} in it`] : [];
    },
  },
  location: {
    table: 'locations', needs: 'location.manage', label: 'place', nameColumn: 'name',
    blockers: (db, _p, id) => {
      const out: string[] = [];
      const kids = count(db,
        'SELECT COUNT(*) AS n FROM locations WHERE parent_id = ? AND is_active = 1', id);
      if (kids) out.push(`${kids} place${kids === 1 ? '' : 's'} inside it`);
      const assets = count(db,
        'SELECT COUNT(*) AS n FROM assets WHERE location_id = ? AND is_active = 1', id);
      if (assets) out.push(`${assets} asset${assets === 1 ? '' : 's'} sited there`);
      const jobs = count(db, `SELECT COUNT(*) AS n FROM work_orders WHERE location_id = ? AND ${OPEN_JOB}`, id);
      if (jobs) out.push(`${jobs} open job${jobs === 1 ? '' : 's'} there`);
      return out;
    },
  },
  'stock-item': {
    table: 'stock_items', needs: 'stock.receive', label: 'stock item', nameColumn: 'name',
    blockers: (db, _p, id) => {
      const out: string[] = [];
      const row = db.prepare('SELECT current_qty FROM stock_items WHERE id = ?')
        .get(id) as { current_qty: number } | undefined;
      // Retiring an item that is physically on the shelf would quietly remove it from the
      // valuation while the parts are still in the store. Count it out or write it off first.
      if (row && row.current_qty > 0.0001) {
        out.push(`${row.current_qty} still on the shelf — issue, count or write it off first`);
      }
      const reqs = count(db,
        `SELECT COUNT(*) AS n FROM requisition_items i
           JOIN requisitions r ON r.id = i.requisition_id
          WHERE i.item_id = ? AND r.status IN ('draft','pending','approved','purchased')`, id);
      if (reqs) out.push(`${reqs} requisition line${reqs === 1 ? '' : 's'} not yet received`);
      return out;
    },
  },
  team: {
    table: 'teams', needs: 'staff.manage', label: 'team', nameColumn: 'name',
    blockers: (db, _p, id) => {
      const people = count(db,
        'SELECT COUNT(*) AS n FROM staff WHERE team_id = ? AND is_active = 1', id);
      return people ? [`${people} ${people === 1 ? 'person is' : 'people are'} still in it`] : [];
    },
  },
  'shift-pattern': {
    table: 'shift_patterns', needs: 'admin.settings.manage', label: 'shift pattern', nameColumn: 'name',
    blockers: (db, _p, id) => {
      // Past roster entries are history and fine. A shift somebody is rostered onto
      // tomorrow is not, because retiring it takes the shift off their published week.
      const ahead = count(db,
        `SELECT COUNT(*) AS n FROM roster_entries
          WHERE shift_pattern_id = ? AND work_date >= date('now')`, id);
      return ahead ? [`${ahead} roster entr${ahead === 1 ? 'y' : 'ies'} from today onwards use it`] : [];
    },
  },
  'ppm-schedule': {
    table: 'ppm_schedules', needs: 'ppm.manage', label: 'PPM schedule', nameColumn: 'name',
  },
  vendor: {
    table: 'vendors', needs: 'vendor.manage', label: 'vendor', nameColumn: 'name',
    blockers: (db, _p, id) => {
      const live = count(db,
        `SELECT COUNT(*) AS n FROM contracts WHERE vendor_id = ? AND end_date >= date('now')`, id);
      return live ? [`${live} contract${live === 1 ? '' : 's'} still running`] : [];
    },
  },
  'cost-centre': {
    table: 'cost_centres', needs: 'finance.budget.edit', label: 'cost centre', nameColumn: 'name',
    noUpdatedAt: true,
  },
  tank: {
    table: 'fuel_tanks', needs: 'admin.settings.manage', label: 'tank', nameColumn: 'name',
  },
  'power-source': {
    table: 'power_sources', needs: 'power.source.manage', label: 'supply', nameColumn: 'name',
  },
};

export async function retireRoutes(app: FastifyInstance): Promise<void> {
  /** What this person may retire, so a screen can draw the button only where it works. */
  app.get('/api/retirable', { preHandler: requireSignedIn() }, async (req) => ({
    kinds: Object.entries(RETIRABLE)
      .filter(([, r]) => req.principal!.permissions.has(r.needs))
      .map(([kind, r]) => ({ kind, label: r.label, needs: r.needs })),
  }));

  app.post('/api/retire/:kind/:id', { preHandler: requireSignedIn() }, async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const spec = RETIRABLE[kind];
    if (!spec) {
      return reply.code(404).send({
        error: 'unknown_kind',
        message: `There is nothing of kind "${kind}" that can be taken out of use.`,
      });
    }
    const me = req.principal!;
    if (!me.permissions.has(spec.needs)) {
      return reply.code(403).send({
        error: 'forbidden', required: spec.needs,
        message: `Taking a ${spec.label} out of use needs the ${spec.needs} permission.`,
      });
    }
    const body = z.object({ active: z.boolean() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const makeActive = body.data.active;

    // Table and column names come from the map above, never from the request.
    const row = app.db.prepare(
      `SELECT id, is_active, ${spec.nameColumn} AS label FROM ${spec.table}
        WHERE id = ? AND property_id = ?`
    ).get(id, me.propertyId) as { id: string; is_active: number; label: string } | undefined;
    if (!row) {
      return reply.code(404).send({ error: 'not_found', message: `That ${spec.label} does not exist.` });
    }
    if (!!row.is_active === makeActive) {
      return reply.code(409).send({
        error: 'no_change',
        message: makeActive
          ? `${row.label} is already in use.`
          : `${row.label} is already out of use.`,
      });
    }

    if (!makeActive && spec.blockers) {
      const blocking = spec.blockers(app.db, me.propertyId, id);
      if (blocking.length > 0) {
        return reply.code(409).send({
          error: 'in_use',
          blockers: blocking,
          message: `${row.label} cannot be taken out of use yet: ${blocking.join('; ')}.`,
        });
      }
    }

    const at = nowIso();
    if (spec.noUpdatedAt) {
      app.db.prepare(`UPDATE ${spec.table} SET is_active = ? WHERE id = ? AND property_id = ?`)
        .run(makeActive ? 1 : 0, id, me.propertyId);
    } else {
      app.db.prepare(`UPDATE ${spec.table} SET is_active = ?, updated_at = ? WHERE id = ? AND property_id = ?`)
        .run(makeActive ? 1 : 0, at, id, me.propertyId);
    }

    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: makeActive ? 'record.restored' : 'record.retired',
      entityType: kind, entityId: id,
      before: { isActive: !!row.is_active, label: row.label },
      after: { isActive: makeActive, label: row.label },
      ip: req.ip,
    });

    return {
      ok: true,
      label: row.label,
      // Said plainly, because "deleted" is what people will assume and it is not what
      // happened — the record is still there behind everything that points at it.
      message: makeActive
        ? `${row.label} is back in use.`
        : `${row.label} is out of use. Nothing was deleted — it stays readable from the jobs and records that already refer to it.`,
    };
  });
}
