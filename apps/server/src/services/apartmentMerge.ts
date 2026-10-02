/**
 * Folding a duplicated apartment back into the real one.
 *
 * The way a unit list gets doubled is nearly always the same: it is imported a second time
 * with the *name* column chosen as the unit number. The importer only recognises a unit it
 * already has by (block, unit number), so `MAIN BUILDING · Seville` looked new beside
 * `MAIN BUILDING · 001 (Seville)` and every row went in again.
 *
 * Deleting the copies is not enough on its own, because by the time anybody notices, jobs
 * have been raised against them. So a duplicate is *merged*: everything that points at the
 * copy — jobs, requests, assets, meters, and anything sited at its place on the location
 * tree — is moved onto the real unit, and then the copy and its place are deleted. What
 * points where is read from the schema's foreign keys, as deletion does, so nothing added
 * in a later migration is left pointing at a row that no longer exists.
 */
import type { Db } from '../db/connection.js';
import { HttpError } from '../lib/errors.js';
import { referencesOnto } from './deletion.js';

interface AptRow {
  id: string; unit_no: string; name: string | null; block: string | null; location_id: string;
}

export interface DuplicatePair {
  duplicate: { id: string; unitNo: string; name: string | null; block: string | null };
  /** The unit it copies. Null when more than one unit carries that name in the block. */
  target: { id: string; unitNo: string; name: string | null } | null;
  /** Every unit it could be a copy of — more than one only when the target is null. */
  candidates: { id: string; unitNo: string; name: string | null }[];
  /** How many records point at the copy, and would be moved by a merge. */
  attached: number;
}

function label(a: { block: string | null; unit_no: string; name: string | null }): string {
  return `${a.block ? `${a.block} · ` : ''}${a.unit_no}${a.name ? ` (${a.name})` : ''}`;
}

/** Records pointing at an apartment or its place, other than the pair's own link. */
function attachedCount(db: Db, apt: AptRow): number {
  let n = 0;
  for (const ref of referencesOnto(db, 'apartments')) {
    n += (db.prepare(`SELECT COUNT(*) AS n FROM "${ref.table}" WHERE "${ref.column}" = ?`)
      .get(apt.id) as { n: number }).n;
  }
  for (const ref of referencesOnto(db, 'locations')) {
    if (ref.table === 'apartments' && ref.column === 'location_id') continue;
    n += (db.prepare(`SELECT COUNT(*) AS n FROM "${ref.table}" WHERE "${ref.column}" = ?`)
      .get(apt.location_id) as { n: number }).n;
  }
  return n;
}

/**
 * Units whose unit number is another unit's name, in the same block.
 *
 * The real unit must have a unit number that is *not* its own name — otherwise two copies
 * would each look like the original of the other.
 */
export function findDuplicates(db: Db, propertyId: string): DuplicatePair[] {
  const rows = db.prepare(
    `SELECT d.id AS d_id, d.unit_no AS d_unit, d.name AS d_name, d.block AS d_block,
            d.location_id AS d_loc,
            t.id AS t_id, t.unit_no AS t_unit, t.name AS t_name
       FROM apartments d
       JOIN apartments t
         ON t.property_id = d.property_id AND t.id <> d.id
        AND lower(trim(coalesce(t.block, ''))) = lower(trim(coalesce(d.block, '')))
        AND t.name IS NOT NULL AND lower(trim(t.name)) = lower(trim(d.unit_no))
        AND lower(trim(t.unit_no)) <> lower(trim(t.name))
      WHERE d.property_id = ?
      ORDER BY d.block, d.unit_no`
  ).all(propertyId) as {
    d_id: string; d_unit: string; d_name: string | null; d_block: string | null; d_loc: string;
    t_id: string; t_unit: string; t_name: string | null;
  }[];

  const byDup = new Map<string, typeof rows>();
  for (const r of rows) byDup.set(r.d_id, [...(byDup.get(r.d_id) ?? []), r]);

  return [...byDup.values()].map((matches) => {
    const d = matches[0]!;
    return {
      duplicate: { id: d.d_id, unitNo: d.d_unit, name: d.d_name, block: d.d_block },
      // Two real units sharing a name in one block: there is no honest guess which this
      // copies, so it is listed for a person to decide rather than merged.
      target: matches.length === 1 ? { id: d.t_id, unitNo: d.t_unit, name: d.t_name } : null,
      candidates: matches.map((m) => ({ id: m.t_id, unitNo: m.t_unit, name: m.t_name })),
      attached: attachedCount(db, {
        id: d.d_id, unit_no: d.d_unit, name: d.d_name, block: d.d_block, location_id: d.d_loc,
      }),
    };
  });
}

/** Move everything from one apartment onto another, then delete the first and its place. */
export function mergeInto(
  db: Db, propertyId: string, duplicateId: string, targetId: string,
): { moved: number; duplicate: string; target: string } {
  if (duplicateId === targetId) {
    throw new HttpError(400, 'same_unit', 'A unit cannot be merged into itself.');
  }
  const get = (id: string) => db.prepare(
    'SELECT id, unit_no, name, block, location_id FROM apartments WHERE id = ? AND property_id = ?'
  ).get(id, propertyId) as AptRow | undefined;
  const dup = get(duplicateId);
  const target = get(targetId);
  if (!dup) throw new HttpError(404, 'not_found', 'The duplicate unit does not exist any more.');
  if (!target) throw new HttpError(404, 'not_found', 'The unit to merge into does not exist.');

  let moved = 0;
  try {
    db.transaction(() => {
      for (const ref of referencesOnto(db, 'apartments')) {
        moved += db.prepare(`UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE "${ref.column}" = ?`)
          .run(target.id, dup.id).changes;
      }
      for (const ref of referencesOnto(db, 'locations')) {
        if (ref.table === 'apartments' && ref.column === 'location_id') continue;
        moved += db.prepare(`UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE "${ref.column}" = ?`)
          .run(target.location_id, dup.location_id).changes;
      }
      db.prepare('DELETE FROM apartments WHERE id = ?').run(dup.id);
      db.prepare('DELETE FROM locations WHERE id = ? AND property_id = ?').run(dup.location_id, propertyId);
    })();
  } catch (e) {
    if (String((e as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
      throw new HttpError(409, 'cannot_merge',
        `${label(dup)} could not be merged into ${label(target)}: a record would clash. Nothing was changed.`);
    }
    throw e;
  }
  return { moved, duplicate: label(dup), target: label(target) };
}
