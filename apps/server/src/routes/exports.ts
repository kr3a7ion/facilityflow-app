import type { FastifyInstance, FastifyReply } from 'fastify';
import { requirePermission } from '../auth/guard.js';
import { toCsv, naira, filename, type Column, type CsvValue } from '../lib/csv.js';
import { monthOf } from './_helpers.js';
import type { MonthRange } from '../lib/time.js';

/**
 * CSV exports. One route, one `kind`, so a new export is a row in a table below rather
 * than another endpoint to guard and remember.
 *
 * Two rules hold across all of them. Money leaves as naira, because the person opening
 * this wants to sum a column, not divide by a hundred first. And every export is scoped
 * to the caller's property and gated on `report.export` *plus* the permission that
 * guards the screen the data comes from — an export must never be a side door around a
 * read permission somebody was deliberately not given.
 */
interface Export {
  needs: string;
  /**
   * Money columns, and the permission that opens them.
   *
   * An export is a file that leaves the building. Dropping the columns rather than
   * refusing the export is deliberate: a storekeeper exporting the catalogue to count
   * against still gets their list, and the shelf value simply is not in it.
   */
  money?: { needs: string; keys: string[] };
  what: string;
  /**
   * Whether a month means anything for this export. A ledger is a stream of dated
   * events and takes a month; a register is the state of things now and does not —
   * asking for "the asset register for August" is a question with no answer.
   */
  dated: boolean;
  columns: Column[];
  rows: (app: FastifyInstance, propertyId: string, period: MonthRange | null)
    => Record<string, CsvValue>[];
}

/** `AND col >= ? AND col < ?` when a month was asked for, and nothing when it was not. */
function within(column: string, period: MonthRange | null): { sql: string; args: string[] } {
  return period
    ? { sql: `AND ${column} >= ? AND ${column} < ?`, args: [period.from, period.to] }
    : { sql: '', args: [] };
}

const EXPORTS: Record<string, Export> = {
  jobs: {
    needs: 'wo.read', dated: true,
    money: { needs: 'wo.cost.read', keys: ['labour', 'parts', 'vendor', 'total'] },
    what: 'Every job with its dates, who did it and what it cost',
    columns: [
      { key: 'ref', header: 'Ref' }, { key: 'title', header: 'Title' },
      { key: 'status', header: 'Status' }, { key: 'priority', header: 'Priority' },
      { key: 'source', header: 'Source' }, { key: 'trade', header: 'Trade' },
      { key: 'unit_no', header: 'Unit' }, { key: 'asset_tag', header: 'Asset' },
      { key: 'assignee', header: 'Assigned to' },
      { key: 'reported_at', header: 'Reported' }, { key: 'due_at', header: 'Due' },
      { key: 'completed_at', header: 'Completed' }, { key: 'verified_at', header: 'Verified' },
      { key: 'held_minutes_total', header: 'Held (min)' },
      { key: 'labour_minutes', header: 'Labour (min)' },
      { key: 'labour', header: 'Labour cost' }, { key: 'parts', header: 'Parts cost' },
      { key: 'vendor', header: 'Vendor cost' }, { key: 'total', header: 'Total cost' },
      { key: 'resolution_notes', header: 'Resolution' },
    ],
    rows: (app, propertyId, period) => {
      const p = within('w.reported_at', period);
      return (app.db.prepare(
      `SELECT w.ref, w.title, w.status, w.priority, w.source, w.trade, w.reported_at, w.due_at,
              w.completed_at, w.verified_at, w.held_minutes_total, w.labour_minutes,
              w.cost_labour_kobo, w.cost_parts_kobo, w.cost_vendor_kobo, w.resolution_notes,
              a.unit_no, s.asset_tag,
              st.first_name || ' ' || st.last_name AS assignee
         FROM work_orders w
         LEFT JOIN apartments a ON a.id = w.apartment_id
         LEFT JOIN assets s ON s.id = w.asset_id
         LEFT JOIN staff st ON st.id = w.assigned_to_staff_id
        WHERE w.property_id = ? ${p.sql} ORDER BY w.reported_at DESC`
      ).all(propertyId, ...p.args) as Record<string, CsvValue>[]).map((r) => ({
        ...r,
        labour: naira(r.cost_labour_kobo),
        parts: naira(r.cost_parts_kobo),
        vendor: naira(r.cost_vendor_kobo),
        total: naira((r.cost_labour_kobo as number) + (r.cost_parts_kobo as number)
                     + (r.cost_vendor_kobo as number)),
      }));
    },
  },

  assets: {
    needs: 'asset.read', dated: false,
    money: { needs: 'cost.read', keys: ['replacement', 'lifetime'] },
    what: 'The asset register with meters, warranty and lifetime cost',
    columns: [
      { key: 'asset_tag', header: 'Tag' }, { key: 'name', header: 'Asset' },
      { key: 'category_name', header: 'Category' }, { key: 'status', header: 'Status' },
      { key: 'criticality', header: 'Criticality' },
      { key: 'unit_no', header: 'Unit' }, { key: 'location_name', header: 'Location' },
      { key: 'manufacturer', header: 'Make' }, { key: 'model', header: 'Model' },
      { key: 'serial_no', header: 'Serial' }, { key: 'capacity', header: 'Capacity' },
      { key: 'meter_type', header: 'Meter type' }, { key: 'current_meter', header: 'Meter' },
      { key: 'warranty_expiry', header: 'Warranty ends' },
      { key: 'replacement', header: 'Replacement cost' },
      { key: 'lifetime', header: 'Lifetime job cost' },
    ],
    rows: (app, propertyId) => (app.db.prepare(
      `SELECT a.asset_tag, a.name, a.status, a.criticality, a.manufacturer, a.model, a.serial_no,
              a.capacity, a.meter_type, a.current_meter, a.warranty_expiry, a.replacement_cost_kobo,
              c.name AS category_name, l.name AS location_name, ap.unit_no,
              COALESCE((SELECT SUM(w.cost_labour_kobo + w.cost_parts_kobo + w.cost_vendor_kobo)
                          FROM work_orders w WHERE w.asset_id = a.id), 0) AS lifetime_kobo
         FROM assets a
         LEFT JOIN asset_categories c ON c.id = a.category_id
         LEFT JOIN locations l ON l.id = a.location_id
         LEFT JOIN apartments ap ON ap.id = a.apartment_id
        WHERE a.property_id = ? AND a.is_active = 1 ORDER BY a.asset_tag`
    ).all(propertyId) as Record<string, CsvValue>[]).map((r) => ({
      ...r,
      replacement: naira(r.replacement_cost_kobo),
      lifetime: naira(r.lifetime_kobo),
    })),
  },

  stock: {
    needs: 'stock.read', dated: false,
    money: { needs: 'cost.read', keys: ['avg', 'value'] },
    what: 'Catalogue with balances, minimums and shelf value',
    columns: [
      { key: 'code', header: 'Code' }, { key: 'name', header: 'Item' },
      { key: 'category', header: 'Category' }, { key: 'bin_location', header: 'Bin' },
      { key: 'current_qty', header: 'On hand' }, { key: 'unit', header: 'Unit' },
      { key: 'min_level', header: 'Minimum' }, { key: 'reorder_qty', header: 'Reorder' },
      { key: 'avg', header: 'Average cost' }, { key: 'value', header: 'Value' },
    ],
    rows: (app, propertyId) => (app.db.prepare(
      `SELECT code, name, category, bin_location, current_qty, unit, min_level, reorder_qty,
              avg_cost_kobo FROM stock_items
        WHERE property_id = ? AND is_active = 1 ORDER BY code`
    ).all(propertyId) as Record<string, CsvValue>[]).map((r) => ({
      ...r,
      avg: naira(r.avg_cost_kobo),
      value: naira((r.current_qty as number) * (r.avg_cost_kobo as number)),
    })),
  },

  'stock-movements': {
    needs: 'stock.read', dated: true,
    money: { needs: 'cost.read', keys: ['cost'] },
    what: 'The full movement ledger — every receipt, issue, count and adjustment',
    columns: [
      { key: 'at', header: 'When' }, { key: 'code', header: 'Code' },
      { key: 'name', header: 'Item' }, { key: 'type', header: 'Type' },
      { key: 'qty_delta', header: 'Change' }, { key: 'balance_after', header: 'Balance' },
      { key: 'cost', header: 'Unit cost' }, { key: 'wo_ref', header: 'Job' },
      { key: 'ref', header: 'Reference' }, { key: 'done_by_name', header: 'By' },
      { key: 'note', header: 'Note' },
    ],
    rows: (app, propertyId, period) => {
      const p = within('m.at', period);
      return (app.db.prepare(
      `SELECT m.at, m.type, m.qty_delta, m.balance_after, m.unit_cost_kobo, m.ref, m.note,
              i.code, i.name, u.display_name AS done_by_name, w.ref AS wo_ref
         FROM stock_movements m
         JOIN stock_items i ON i.id = m.item_id
         LEFT JOIN users u ON u.id = m.done_by
         LEFT JOIN work_orders w ON w.id = m.wo_id
        WHERE m.property_id = ? ${p.sql} ORDER BY m.at DESC`
      ).all(propertyId, ...p.args) as Record<string, CsvValue>[])
        .map((r) => ({ ...r, cost: naira(r.unit_cost_kobo) }));
    },
  },

  spend: {
    needs: 'finance.read', dated: true,
    what: 'Purchases and approved expenses in one column of spend',
    columns: [
      { key: 'kind', header: 'Kind' }, { key: 'ref', header: 'Ref' },
      { key: 'at', header: 'Date' }, { key: 'description', header: 'Description' },
      { key: 'amount', header: 'Amount' }, { key: 'cost_centre', header: 'Cost centre' },
      { key: 'vendor_name', header: 'Vendor' }, { key: 'wo_ref', header: 'Job' },
      { key: 'status', header: 'Status' }, { key: 'raised_by_name', header: 'Raised by' },
    ],
    rows: (app, propertyId, period) => {
      const pp = within('p.purchased_at', period);
      const pe = within('e.spent_at', period);
      const purchases = app.db.prepare(
        `SELECT 'Purchase' AS kind, p.ref, p.purchased_at AS at, p.description, p.amount_kobo,
                'recorded' AS status, c.code AS cost_centre, v.name AS vendor_name,
                w.ref AS wo_ref, u.display_name AS raised_by_name
           FROM purchases p
           LEFT JOIN cost_centres c ON c.id = p.cost_centre_id
           LEFT JOIN vendors v ON v.id = p.vendor_id
           LEFT JOIN work_orders w ON w.id = p.wo_id
           LEFT JOIN users u ON u.id = p.recorded_by
          WHERE p.property_id = ? ${pp.sql}`
      ).all(propertyId, ...pp.args) as Record<string, CsvValue>[];
      const expenses = app.db.prepare(
        `SELECT 'Expense' AS kind, NULL AS ref, e.spent_at AS at, e.description, e.amount_kobo,
                e.status, c.code AS cost_centre, v.name AS vendor_name,
                w.ref AS wo_ref, u.display_name AS raised_by_name
           FROM expenses e
           LEFT JOIN cost_centres c ON c.id = e.cost_centre_id
           LEFT JOIN vendors v ON v.id = e.vendor_id
           LEFT JOIN work_orders w ON w.id = e.wo_id
           LEFT JOIN users u ON u.id = e.raised_by
          WHERE e.property_id = ? ${pe.sql}`
      ).all(propertyId, ...pe.args) as Record<string, CsvValue>[];
      const all: Record<string, CsvValue>[] = [...purchases, ...expenses]
        .map((r) => ({ ...r, amount: naira(r.amount_kobo) }));
      return all.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    },
  },

  fuel: {
    needs: 'fuel.read', dated: true,
    what: 'Dips, deliveries and generator runs for reconciliation off-system',
    columns: [
      { key: 'at', header: 'When' }, { key: 'kind', header: 'Kind' },
      { key: 'what', header: 'Tank or set' }, { key: 'litres', header: 'Litres' },
      { key: 'hours', header: 'Run hours' }, { key: 'lph', header: 'L per hour' },
      { key: 'detail', header: 'Detail' },
    ],
    rows: (app, propertyId, period) => {
      const pd = within('d.taken_at', period);
      const pf = within('f.delivered_at', period);
      const pr = within('r.started_at', period);
      const dips = app.db.prepare(
        `SELECT d.taken_at AS at, 'Dip' AS kind, t.name AS what, d.litres, NULL AS hours,
                NULL AS lph, d.note AS detail
           FROM fuel_dips d JOIN fuel_tanks t ON t.id = d.tank_id
          WHERE t.property_id = ? ${pd.sql}`
      ).all(propertyId, ...pd.args) as Record<string, CsvValue>[];
      const deliveries = app.db.prepare(
        `SELECT f.delivered_at AS at, 'Delivery' AS kind, t.name AS what, f.received_l AS litres,
                NULL AS hours, NULL AS lph,
                'invoiced ' || f.invoiced_l || ' L, variance ' || f.variance_l || ' L' AS detail
           FROM fuel_deliveries f JOIN fuel_tanks t ON t.id = f.tank_id
          WHERE f.property_id = ? ${pf.sql}`
      ).all(propertyId, ...pf.args) as Record<string, CsvValue>[];
      const runs = app.db.prepare(
        `SELECT r.started_at AS at, 'Generator run' AS kind, a.asset_tag AS what,
                r.fuel_used_l AS litres, r.run_hours AS hours, r.actual_lph AS lph,
                r.reason AS detail
           FROM generator_runs r JOIN assets a ON a.id = r.genset_asset_id
          WHERE r.property_id = ? ${pr.sql}`
      ).all(propertyId, ...pr.args) as Record<string, CsvValue>[];
      return [...dips, ...deliveries, ...runs]
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    },
  },

  audit: {
    needs: 'admin.audit.read', dated: true,
    what: 'The audit log — who changed what, and when',
    columns: [
      { key: 'at', header: 'When' }, { key: 'actor_name', header: 'Who' },
      { key: 'action', header: 'Action' }, { key: 'entity_type', header: 'Entity' },
      { key: 'entity_id', header: 'Entity id' }, { key: 'ip', header: 'From' },
      { key: 'before_json', header: 'Before' }, { key: 'after_json', header: 'After' },
    ],
    rows: (app, propertyId, period) => {
      const p = within('at', period);
      return app.db.prepare(
        `SELECT at, actor_name, action, entity_type, entity_id, ip, before_json, after_json
           FROM audit_log WHERE property_id = ? ${p.sql} ORDER BY at DESC`
      ).all(propertyId, ...p.args) as Record<string, CsvValue>[];
    },
  },
};

function sendCsv(reply: FastifyReply, kind: string, body: string, month: string | null): FastifyReply {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename(kind, month)}"`)
    // An export is a point-in-time snapshot; a cached one is a lie the next time it opens.
    .header('cache-control', 'no-store')
    .send(body);
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  /** What this person can actually export, so the UI never offers a dead button. */
  app.get('/api/exports', { preHandler: requirePermission('report.export') }, async (req) => ({
    exports: Object.entries(EXPORTS)
      .filter(([, e]) => req.principal!.permissions.has(e.needs))
      .map(([kind, e]) => {
        const money = e.money && !req.principal!.permissions.has(e.money.needs);
        return {
          kind, dated: e.dated,
          what: e.what,
          columns: e.columns.length - (money ? e.money!.keys.length : 0),
          // Said out loud, so nobody wonders why their file has fewer columns than a
          // colleague's and assumes the export is broken.
          withoutCosts: !!money,
        };
      }),
  }));

  app.get('/api/exports/:kind', { preHandler: requirePermission('report.export') }, async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const spec = EXPORTS[kind];
    if (!spec) {
      return reply.code(404).send({
        error: 'unknown_export',
        message: `There is no "${kind}" export. Ask /api/exports for the list.`,
      });
    }
    // report.export alone is not enough: the export must not hand over data the caller
    // cannot open on the screen it came from.
    if (!req.principal!.permissions.has(spec.needs)) {
      return reply.code(403).send({
        error: 'forbidden', required: spec.needs,
        message: `Exporting that also needs the ${spec.needs} permission.`,
      });
    }
    // A month is opt-in on an export, unlike on a screen. Somebody exporting a ledger
    // usually wants the whole thing to pivot in Excel; somebody exporting September
    // says so, and gets a file named for September rather than for today.
    const q = req.query as { month?: string };
    const period = spec.dated && q.month ? monthOf(app, req) : null;
    // Money columns come out for anybody who may not see money. The file the person
    // downloads is the file they were allowed to see, not a wide one with blanks in it.
    const columns = spec.money && !req.principal!.permissions.has(spec.money.needs)
      ? spec.columns.filter((c) => !spec.money!.keys.includes(c.key))
      : spec.columns;
    const rows = spec.rows(app, req.principal!.propertyId, period);
    return sendCsv(reply, kind, toCsv(columns, rows), period?.month ?? null);
  });
}
