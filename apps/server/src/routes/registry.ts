import type { FastifyInstance } from 'fastify';
import * as unitImport from '../services/unitImport.js';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../audit.js';
import { ctxOf, send, seesMoney, withoutMoney } from './_helpers.js';

const APT_STATUS = ['occupied', 'vacant_ready', 'vacant_dirty', 'under_maintenance', 'out_of_service'] as const;

export async function registryRoutes(app: FastifyInstance): Promise<void> {
  // ---- locations -------------------------------------------------------------
  // `?all=1` includes retired places, for the Admin screen that brings them back. Every
  // picker leaves it off and so never offers a place nobody uses any more.
  app.get('/api/locations', { preHandler: requirePermission('location.read') }, async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    return {
      locations: app.db.prepare(
        `SELECT id, parent_id, type, code, name, sort_order, is_active FROM locations
          WHERE property_id = ? AND (? OR is_active = 1) ORDER BY sort_order, code`
      ).all(req.principal!.propertyId, all ? 1 : 0),
    };
  });

  app.post('/api/locations', { preHandler: requirePermission('location.manage') }, async (req, reply) => {
    const body = z.object({
      parentId: z.string().optional(),
      type: z.enum(['site', 'block', 'floor', 'apartment', 'common_area', 'plant_room', 'external']),
      code: z.string().min(1).max(40), name: z.string().min(1).max(120),
      sortOrder: z.number().int().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid();
    try {
      app.db.prepare(
        `INSERT INTO locations (id, property_id, parent_id, type, code, name, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, body.data.parentId ?? null, body.data.type, body.data.code,
            body.data.name, body.data.sortOrder ?? 0, at, at);
    } catch {
      return reply.code(409).send({ error: 'duplicate_code', message: `Code "${body.data.code}" is already used.` });
    }
    return reply.code(201).send({ ok: true, id });
  });

  /**
   * Rename a place, recode it, or move it.
   *
   * Moving is where this can go wrong: a place set inside one of its own children makes a
   * loop, and every screen that walks the tree walks it forever. The new parent's chain is
   * followed up to the top first, and the move is refused if it passes through this place.
   */
  app.patch('/api/locations/:id', { preHandler: requirePermission('location.manage') }, async (req, reply) => {
    const body = z.object({
      parentId: z.string().nullable().optional(),
      type: z.enum(['site', 'block', 'floor', 'apartment', 'common_area', 'plant_room', 'external']).optional(),
      code: z.string().trim().min(1).max(40).optional(),
      name: z.string().trim().min(1).max(120).optional(),
      sortOrder: z.number().int().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!;
    const { id } = req.params as { id: string };
    const place = app.db.prepare(
      'SELECT id, parent_id, type, code, name, sort_order FROM locations WHERE id = ? AND property_id = ?'
    ).get(id, me.propertyId) as
      { id: string; parent_id: string | null; type: string; code: string; name: string; sort_order: number } | undefined;
    if (!place) return reply.code(404).send({ error: 'not_found', message: 'That place does not exist.' });
    const d = body.data;

    const isRoot = place.type === 'site' && !place.parent_id;
    if (isRoot && ((d.type && d.type !== 'site') || (d.parentId !== undefined && d.parentId !== null))) {
      return reply.code(409).send({
        error: 'site_fixed',
        message: 'The site is the root of every place. It can be renamed, but not moved or given another kind.',
      });
    }

    if (d.parentId) {
      if (d.parentId === id) {
        return reply.code(400).send({ error: 'own_parent', message: 'A place cannot sit inside itself.' });
      }
      let cursor: string | null = d.parentId;
      for (let hops = 0; cursor && hops < 100; hops++) {
        const up = app.db.prepare('SELECT id, parent_id FROM locations WHERE id = ? AND property_id = ?')
          .get(cursor, me.propertyId) as { id: string; parent_id: string | null } | undefined;
        if (!up) return reply.code(400).send({ error: 'unknown_parent', message: 'The place to move it into does not exist.' });
        if (up.parent_id === id) {
          return reply.code(400).send({
            error: 'cycle', message: `${place.name} cannot move inside a place that is itself inside it.`,
          });
        }
        cursor = up.parent_id;
      }
    }

    const next = {
      parent_id: d.parentId === undefined ? place.parent_id : d.parentId,
      type: d.type ?? place.type,
      code: d.code ?? place.code,
      name: d.name ?? place.name,
      sort_order: d.sortOrder ?? place.sort_order,
    };
    try {
      app.db.prepare(
        `UPDATE locations SET parent_id = ?, type = ?, code = ?, name = ?, sort_order = ?, updated_at = ?
          WHERE id = ?`
      ).run(next.parent_id, next.type, next.code, next.name, next.sort_order, nowIso(), id);
    } catch {
      return reply.code(409).send({ error: 'duplicate_code', message: `Code "${next.code}" is already used.` });
    }
    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'location.updated', entityType: 'location', entityId: id,
      before: place, after: next, ip: req.ip,
    });
    return { ok: true, id };
  });

  // ---- apartments ------------------------------------------------------------
  app.get('/api/apartments', { preHandler: requirePermission('apartment.read') }, async (req) => {
    const me = req.principal!;
    const q = req.query as { status?: string; block?: string };
    const rows = app.db.prepare(
      `SELECT a.*, (SELECT COUNT(*) FROM work_orders w
                     WHERE w.apartment_id = a.id AND w.status NOT IN ('closed','cancelled','verified')) AS open_jobs
         FROM apartments a
        WHERE a.property_id = ? AND a.is_active = 1
          AND (? IS NULL OR a.status = ?) AND (? IS NULL OR a.block = ?)
        ORDER BY a.block, a.unit_no`
    ).all(me.propertyId, q.status ?? null, q.status ?? null, q.block ?? null, q.block ?? null);
    const summary = app.db.prepare(
      `SELECT status, COUNT(*) AS n FROM apartments WHERE property_id = ? AND is_active = 1 GROUP BY status`
    ).all(me.propertyId);
    return { apartments: rows, summary };
  });

  app.post('/api/apartments/:id/status', { preHandler: requirePermission('apartment.manage') }, async (req, reply) => {
    const body = z.object({ status: z.enum(APT_STATUS), note: z.string().max(500).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const id = (req.params as { id: string }).id;
    const before = app.db.prepare('SELECT status FROM apartments WHERE id = ? AND property_id = ?')
      .get(id, me.propertyId) as { status: string } | undefined;
    if (!before) return reply.code(404).send({ error: 'not_found', message: 'That unit does not exist.' });
    app.db.prepare('UPDATE apartments SET status = ?, updated_at = ? WHERE id = ?')
      .run(body.data.status, nowIso(), id);
    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'apartment.status', entityType: 'apartment', entityId: id,
      before, after: { status: body.data.status, note: body.data.note }, ip: req.ip,
    });
    return { ok: true };
  });

  /**
   * Read a unit list and say what it contains.
   *
   * Separate from the import itself so the person sees the file through the system's eyes
   * — which column it thinks is the unit number, which columns it is ignoring, how many
   * rows it could not use and why — before anything is written. The text is sent rather
   * than the file because the browser reads it anyway, and a few hundred rows of short
   * text is not worth a multipart upload path on a host with no internet.
   */
  app.post('/api/apartments/import/read', { preHandler: requirePermission('apartment.import') },
    async (req, reply) => {
      const body = z.object({
        text: z.string().min(1).max(2_000_000),
        // A correction to the guess. Absent on the first look.
        mapping: z.record(z.string(), z.string()).optional(),
        // The screen asks for the whole list once the mapping is confirmed, so the file is
        // parsed in exactly one place and the rows that get written are the rows that were
        // shown. Without this the client would have to re-implement the parser to submit.
        all: z.boolean().optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });

      return send(reply, () => {
        const file = unitImport.parse(body.data.text);
        const mapping = { ...file.mapping, ...(body.data.mapping ?? {}) } as
          Partial<Record<unitImport.Field, string>>;
        // A correction that clears a column arrives as an empty string; treat it as unset.
        for (const k of Object.keys(mapping) as unitImport.Field[]) {
          if (!mapping[k]) delete mapping[k];
        }
        const missing = unitImport.REQUIRED.filter((f) => !mapping[f]);
        const { units, rejected } = missing.length === 0
          ? unitImport.toUnits(file.rows, mapping)
          : { units: [], rejected: [] };

        const me = req.principal!;
        const hereRows = app.db.prepare(
          'SELECT block, unit_no FROM apartments WHERE property_id = ?'
        ).all(me.propertyId) as { block: string | null; unit_no: string }[];
        const here = new Map(hereRows.map((r) => [unitImport.unitKey(r.block, r.unit_no), true]));

        const seen = new Set<string>();
        const already: string[] = [];
        const repeated: string[] = [];
        const ambiguous: string[] = [];
        const toAdd: unitImport.Unit[] = [];
        for (const u of units) {
          const key = unitImport.unitKey(u.block, u.unitNo);
          const label = u.block ? `${u.block} · ${u.unitNo}` : u.unitNo;
          if (here.has(key)) { already.push(label); continue; }
          // Same rule as the write below, so the preview is the truth and not an estimate.
          if (!u.block) {
            const matches = hereRows.filter(
              (x) => x.unit_no.trim().toLowerCase() === u.unitNo.trim().toLowerCase());
            if (matches.length === 1) { already.push(label); continue; }
            if (matches.length > 1) { ambiguous.push(label); continue; }
          }
          if (seen.has(key)) { repeated.push(label); continue; }
          seen.add(key);
          toAdd.push(u);
        }

        return {
          format: file.format,
          headers: file.headers,
          fields: unitImport.FIELDS,
          mapping,
          missing,
          // Named, so nobody wonders whether their access-control columns were silently
          // imported somewhere.
          ignored: file.headers.filter((h) => h && !Object.values(mapping).includes(h)),
          rowsRead: file.rows.length,
          wouldCreate: toAdd.length,
          alreadyHere: already.slice(0, 25),
          repeatedInFile: [...new Set(repeated)].slice(0, 25),
          // Named, because "we could not tell which block you meant" is a sentence
          // somebody can act on and a silent skip is not.
          ambiguous: ambiguous.slice(0, 25),
          rejected: rejected.slice(0, 25),
          blocks: [...new Set(toAdd.map((u) => u.block ?? '(no block)'))].sort(),
          sample: body.data.all ? toAdd : toAdd.slice(0, 12),
        };
      });
    });

  /**
   * Import a unit list. One-way and one-off: no live link to another system, which
   * would tie a product meant to be sold to one client's other software.
   */
  app.post('/api/apartments/import', { preHandler: requirePermission('apartment.import') }, async (req, reply) => {
    const body = z.object({
      source: z.enum(['manual', 'csv', 'json', 'keyplate']),
      sourceRef: z.string().max(300).optional(),
      dryRun: z.boolean().optional(),
      units: z.array(z.object({
        unitNo: z.string().min(1).max(40), block: z.string().max(60).optional(),
        name: z.string().max(80).optional(),
        floor: z.string().max(20).optional(), unitType: z.string().max(40).optional(),
        bedrooms: z.number().int().min(0).max(99).optional(),
        status: z.enum(APT_STATUS).optional(),
      })).min(1).max(5000),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });

    const me = req.principal!; const at = nowIso();

    /*
     * Uniqueness is (block, unit number), not unit number alone.
     *
     * On a property with wings, `004` exists in every one of them. Collapsing on the unit
     * number alone threw away four out of five real units and told nobody — which is how
     * the department's own list silently became a quarter of itself.
     */
    const here = app.db.prepare(
      'SELECT block, unit_no FROM apartments WHERE property_id = ?'
    ).all(me.propertyId) as { block: string | null; unit_no: string }[];
    const existing = new Set(here.map((r) => unitImport.unitKey(r.block, r.unit_no)));

    const seen = new Set<string>();
    const alreadyHere: string[] = [];
    const repeated: string[] = [];
    const ambiguous: string[] = [];
    const toAdd: typeof body.data.units = [];
    for (const u of body.data.units) {
      const unitNo = u.unitNo.trim();
      if (!unitNo) continue;
      const block = u.block?.trim() || undefined;
      const key = unitImport.unitKey(block, unitNo);
      const label = block ? `${block} · ${unitNo}` : unitNo;

      if (existing.has(key)) { alreadyHere.push(label); continue; }

      /*
       * A row that names no block, against a property that uses them.
       *
       * Strictly these are different records, and importing it would add a second unit
       * "A-1204" alongside the one in block A. That is almost never what somebody meant,
       * so a blockless row is matched to an existing unit of that number — but only when
       * there is exactly one. Where the number exists in several blocks there is no
       * honest answer, so it is skipped and reported by name rather than guessed at.
       */
      if (!block) {
        const matches = here.filter((x) => x.unit_no.trim().toLowerCase() === unitNo.toLowerCase());
        if (matches.length === 1) { alreadyHere.push(label); continue; }
        if (matches.length > 1) { ambiguous.push(label); continue; }
      }

      if (seen.has(key)) { repeated.push(label); continue; }
      seen.add(key);
      toAdd.push({ ...u, unitNo, block });
    }
    const skipped = alreadyHere.length + repeated.length + ambiguous.length;

    // Show the mapping before writing anything.
    if (body.data.dryRun) {
      return {
        dryRun: true,
        wouldCreate: toAdd.length,
        wouldSkip: skipped,
        alreadyHere: alreadyHere.slice(0, 20),
        repeatedInList: [...new Set(repeated)].slice(0, 20),
        ambiguous: ambiguous.slice(0, 20),
        sample: toAdd.slice(0, 10),
      };
    }

    const site = app.db.prepare(`SELECT id FROM locations WHERE property_id = ? AND type = 'site' LIMIT 1`)
      .get(me.propertyId) as { id: string } | undefined;
    if (!site) {
      return reply.code(409).send({
        error: 'no_site', message: 'Create the site location before importing units.',
      });
    }

    const created = app.db.transaction(() => {
      const insLoc = app.db.prepare(
        `INSERT INTO locations (id, property_id, parent_id, type, code, name, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 'apartment', ?, ?, 0, ?, ?)`
      );
      const insApt = app.db.prepare(
        `INSERT INTO apartments (id, property_id, location_id, unit_no, block, floor, unit_type,
          name, bedrooms, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let n = 0;
      for (const u of toAdd) {
        const locId = ulid();
        /*
         * The location code has to be unique across the property, and on a property with
         * wings the unit number is not. The name is what a technician reads on a job
         * card, so it carries whatever the department actually says: "Seville (B · 004)"
         * when the unit has a name, "B · 004" when it does not.
         */
        const code = u.block ? `${u.block}-${u.unitNo}` : u.unitNo;
        const where = u.block ? `${u.block} · ${u.unitNo}` : `Unit ${u.unitNo}`;
        const label = u.name ? `${u.name} (${where})` : where;
        insLoc.run(locId, me.propertyId, site.id, code.slice(0, 60), label.slice(0, 120), at, at);
        insApt.run(ulid(), me.propertyId, locId, u.unitNo, u.block ?? null, u.floor ?? null,
                   u.unitType ?? null, u.name ?? null, u.bedrooms ?? null,
                   u.status ?? 'vacant_ready', at, at);
        n++;
      }
      app.db.prepare(
        `INSERT INTO apartment_imports (id, property_id, source, source_ref, imported_at, imported_by,
          row_count, mapping_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(ulid(), me.propertyId, body.data.source, body.data.sourceRef ?? null, at, me.userId, n,
            JSON.stringify({ submitted: body.data.units.length, created: n, skipped }));
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'apartment.import', entityType: 'property', entityId: me.propertyId,
        after: { source: body.data.source, created: n, skipped }, ip: req.ip,
      });
      return n;
    })();

    return reply.code(201).send({ ok: true, created, skipped, ambiguous });
  });

  // ---- assets ----------------------------------------------------------------
  app.get('/api/assets', { preHandler: requirePermission('asset.read') }, async (req) => {
    const me = req.principal!;
    const q = req.query as { status?: string; categoryId?: string; tag?: string };
    if (q.tag) {
      // The QR sticker route: scan a tag, get the asset and its history.
      const asset = app.db.prepare('SELECT * FROM assets WHERE property_id = ? AND asset_tag = ?')
        .get(me.propertyId, q.tag);
      if (!asset) return { assets: [], message: `No asset carries the tag "${q.tag}".` };
      const a = asset as { id: string };
      return {
        assets: withoutMoney(req, [asset as Record<string, unknown>], ['replacement_cost_kobo']),
        history: withoutMoney(req, app.db.prepare(
          `SELECT ref, title, status, completed_at, cost_labour_kobo + cost_parts_kobo + cost_vendor_kobo AS cost_kobo
             FROM work_orders WHERE asset_id = ? ORDER BY reported_at DESC LIMIT 50`
        ).all(a.id) as Record<string, unknown>[], ['cost_kobo']),
        showsCost: seesMoney(req),
      };
    }
    // asset.read is held by every technician — they scan a tag to find the service
    // history. What the machine would cost to replace is a different question, asked by
    // the person deciding whether to repair it.
    return {
      showsCost: seesMoney(req),
      assets: withoutMoney(req, app.db.prepare(
        // Most assets in a serviced block hang off an apartment, not a plant room. Without
        // the apartment join every split AC lists its location as blank.
        `SELECT a.*, l.name AS location_name, c.name AS category_name, ap.unit_no
           FROM assets a LEFT JOIN locations l ON l.id = a.location_id
           LEFT JOIN asset_categories c ON c.id = a.category_id
           LEFT JOIN apartments ap ON ap.id = a.apartment_id
          WHERE a.property_id = ? AND a.is_active = 1
            AND (? IS NULL OR a.status = ?) AND (? IS NULL OR a.category_id = ?)
          ORDER BY a.asset_tag`
      ).all(me.propertyId, q.status ?? null, q.status ?? null, q.categoryId ?? null, q.categoryId ?? null
      ) as Record<string, unknown>[], ['replacement_cost_kobo']),
    };
  });

  app.get('/api/assets/:id', { preHandler: requirePermission('asset.read') }, async (req, reply) => {
    const me = req.principal!;
    const { id } = req.params as { id: string };
    const asset = app.db.prepare(
      `SELECT a.*, l.name AS location_name, c.name AS category_name, ap.unit_no,
              p.kva_rating, p.expected_lph_at_75pct, p.service_interval_hours, p.next_service_hours,
              p.consecutive_deviations
         FROM assets a
         LEFT JOIN locations l ON l.id = a.location_id
         LEFT JOIN asset_categories c ON c.id = a.category_id
         LEFT JOIN apartments ap ON ap.id = a.apartment_id
         LEFT JOIN genset_profiles p ON p.asset_id = a.id
        WHERE a.id = ? AND a.property_id = ?`
    ).get(id, me.propertyId);
    if (!asset) return reply.code(404).send({ error: 'not_found', message: 'That asset does not exist.' });

    const jobs = app.db.prepare(
      `SELECT id, ref, title, status, priority, reported_at, completed_at,
              cost_labour_kobo + cost_parts_kobo + cost_vendor_kobo AS cost_kobo
         FROM work_orders WHERE asset_id = ? ORDER BY reported_at DESC LIMIT 50`
    ).all(id) as { cost_kobo: number; completed_at: string | null }[];

    const lifetime = jobs.reduce((sum, j) => sum + (j.cost_kobo ?? 0), 0);
    const replacement = (asset as { replacement_cost_kobo: number | null }).replacement_cost_kobo;

    const money = seesMoney(req);
    return {
      asset: money ? asset : withoutMoney(req, [asset as Record<string, unknown>],
                                          ['replacement_cost_kobo'])[0],
      jobs: withoutMoney(req, jobs as unknown as Record<string, unknown>[], ['cost_kobo']),
      showsCost: money,
      readings: app.db.prepare(
        'SELECT read_at, reading, unit, source FROM asset_meter_readings WHERE asset_id = ? ORDER BY read_at DESC LIMIT 24'
      ).all(id),
      schedules: app.db.prepare(
        `SELECT id, name, trigger_type, interval_value, interval_unit, next_due_at, next_due_meter
           FROM ppm_schedules WHERE asset_id = ? AND is_active = 1`
      ).all(id),
      lifetimeCostKobo: money ? lifetime : undefined,
      // Past roughly half of replacement value the repair-or-replace argument writes itself.
      pctOfReplacement: money && replacement && replacement > 0
        ? Math.round((lifetime / replacement) * 1000) / 10 : null,
    };
  });

  app.post('/api/assets', { preHandler: requirePermission('asset.manage') }, async (req, reply) => {
    const body = z.object({
      assetTag: z.string().min(1).max(40), name: z.string().min(1).max(120),
      categoryId: z.string().optional(), locationId: z.string().optional(), apartmentId: z.string().optional(),
      manufacturer: z.string().max(80).optional(), model: z.string().max(80).optional(),
      serialNo: z.string().max(80).optional(), capacity: z.string().max(60).optional(),
      criticality: z.number().int().min(1).max(3).optional(),
      meterType: z.enum(['none', 'hours', 'kwh', 'both']).optional(),
      warrantyExpiry: z.string().max(30).optional(),
      replacementCostKobo: z.number().int().nonnegative().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid(); const d = body.data;
    try {
      app.db.prepare(
        `INSERT INTO assets (id, property_id, asset_tag, name, category_id, location_id, apartment_id,
          manufacturer, model, serial_no, capacity, warranty_expiry, criticality, meter_type,
          replacement_cost_kobo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, me.propertyId, d.assetTag, d.name, d.categoryId ?? null, d.locationId ?? null,
            d.apartmentId ?? null, d.manufacturer ?? null, d.model ?? null, d.serialNo ?? null,
            d.capacity ?? null, d.warrantyExpiry ?? null, d.criticality ?? 2, d.meterType ?? 'none',
            d.replacementCostKobo ?? null, at, at);
    } catch {
      return reply.code(409).send({
        error: 'duplicate_tag', message: `Asset tag "${d.assetTag}" is already in use.`,
      });
    }
    return reply.code(201).send({ ok: true, id });
  });

  app.post('/api/assets/:id/reading', { preHandler: requirePermission('asset.manage') }, async (req, reply) => {
    const body = z.object({
      reading: z.number().nonnegative(), unit: z.enum(['hours', 'kwh']).optional(), readAt: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const id = (req.params as { id: string }).id; const at = nowIso();
    const asset = app.db.prepare('SELECT current_meter FROM assets WHERE id = ? AND property_id = ?')
      .get(id, me.propertyId) as { current_meter: number | null } | undefined;
    if (!asset) return reply.code(404).send({ error: 'not_found', message: 'That asset does not exist.' });
    if (asset.current_meter != null && body.data.reading < asset.current_meter) {
      return reply.code(400).send({
        error: 'meter_went_backwards',
        message: `The meter already reads ${asset.current_meter}. A lower reading means the meter was replaced — record that instead.`,
      });
    }
    const readAt = body.data.readAt ?? at;
    app.db.transaction(() => {
      app.db.prepare(
        `INSERT INTO asset_meter_readings (id, asset_id, read_at, reading, unit, source, read_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`
      ).run(ulid(), id, readAt, body.data.reading, body.data.unit ?? 'hours', me.userId, at);
      app.db.prepare('UPDATE assets SET current_meter = ?, current_meter_at = ?, updated_at = ? WHERE id = ?')
        .run(body.data.reading, readAt, at, id);
    })();
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/asset-categories', { preHandler: requirePermission('asset.read') }, async (req) => ({
    categories: app.db.prepare('SELECT * FROM asset_categories WHERE property_id = ? ORDER BY name')
      .all(req.principal!.propertyId),
  }));

  app.post('/api/asset-categories', { preHandler: requirePermission('asset.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(80), defaultTrade: z.string().max(40).optional(),
      defaultCriticality: z.number().int().min(1).max(3).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!; const at = nowIso(); const id = ulid();
    app.db.prepare(
      `INSERT INTO asset_categories (id, property_id, name, default_trade, default_criticality, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, me.propertyId, body.data.name, body.data.defaultTrade ?? null,
          body.data.defaultCriticality ?? 2, at, at);
    return reply.code(201).send({ ok: true, id });
  });
}
