/**
 * Deleting a record for real — but only one nothing depends on.
 *
 * Retire is still the normal way to take something out of use, and it always works. Delete
 * exists for the other case the department kept hitting: a person typed twice, a place
 * added under the wrong block, an account created with a misspelt username and never used.
 * Those should disappear, not linger as "retired" forever.
 *
 * The rule that keeps this safe is simple: **a record that anything points at is not
 * deleted.** Not a job, not a roster day, not a line in the audit log. The refusal names
 * what is in the way, so the answer is always either "deleted" or "retire it instead —
 * here is why".
 *
 * What points at a table is read from the database's own foreign keys rather than listed
 * by hand, so a table added in a later migration is protected the day it lands instead of
 * the day somebody remembers this file. The few references that are not declared foreign
 * keys (a login's link to a person, a team's lead, the audit log) are listed per kind.
 */
import type { Db } from '../db/connection.js';
import { HttpError } from '../lib/errors.js';

interface Reference { table: string; column: string }

/** Every (table, column) with a foreign key onto `target`. Read once per table. */
const referenceCache = new Map<string, Reference[]>();
export function referencesOnto(db: Db, target: string): Reference[] {
  const cached = referenceCache.get(target);
  if (cached) return cached;
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  ).all() as { name: string }[];
  const out: Reference[] = [];
  for (const { name } of tables) {
    const fks = db.prepare('SELECT "table" AS target, "from" AS col FROM pragma_foreign_key_list(?)')
      .all(name) as { target: string; col: string }[];
    for (const fk of fks) if (fk.target === target) out.push({ table: name, column: fk.col });
  }
  referenceCache.set(target, out);
  return out;
}

/** "work_order_labour" → "work order labour". Good enough for a refusal sentence. */
function words(table: string): string {
  return table.replace(/_/g, ' ');
}

export interface DeleteSpec {
  /** The table the record lives in. Never taken from a request. */
  table: string;
  /** Permission needed to delete one. */
  needs: string;
  /** What the department calls it. */
  label: string;
  /** SQL expression giving the human name, for the message and the audit entry. */
  nameSql: string;
  /**
   * References that are housekeeping rather than history: removed along with the record.
   * A login's open sessions, a role's permission grants — nobody needs them afterwards.
   */
  disposable?: Reference[];
  /** References the schema does not declare as foreign keys. */
  extra?: (db: Db, id: string) => string[];
  /** Outright refusals that have nothing to do with references. */
  refuse?: (db: Db, id: string, actorUserId: string | null) => string | null;
  /**
   * A record that exists only as this one's other half, deleted with it. An apartment is
   * also a place on the location tree; deleting the unit and leaving the place would
   * leave a "Seville (MAIN BUILDING · 001)" in every picker pointing at nothing.
   * Whatever points at the other half blocks the delete exactly as if it pointed here.
   */
  alsoDelete?: { column: string; table: string };
}

/** The id of the other half named by `alsoDelete`, if there is one. */
function linkedId(db: Db, spec: DeleteSpec, id: string): string | null {
  if (!spec.alsoDelete) return null;
  const row = db.prepare(`SELECT ${spec.alsoDelete.column} AS v FROM ${spec.table} WHERE id = ?`)
    .get(id) as { v: string | null } | undefined;
  return row?.v ?? null;
}

/** What stands in the way of deleting this record. Empty means it can go. */
export function blockersFor(db: Db, spec: DeleteSpec, id: string): string[] {
  const out: string[] = [];
  const skip = new Set((spec.disposable ?? []).map((r) => `${r.table}.${r.column}`));
  for (const ref of referencesOnto(db, spec.table)) {
    if (skip.has(`${ref.table}.${ref.column}`)) continue;
    // Table and column names come from the database's own schema, never from a request.
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${ref.table}" WHERE "${ref.column}" = ?`)
      .get(id) as { n: number }).n;
    if (n > 0) out.push(`${n} ${words(ref.table)} record${n === 1 ? '' : 's'}`);
  }
  out.push(...(spec.extra?.(db, id) ?? []));

  const linked = linkedId(db, spec, id);
  if (linked && spec.alsoDelete) {
    for (const ref of referencesOnto(db, spec.alsoDelete.table)) {
      // The back-reference from this record to its other half is the one that goes too.
      if (ref.table === spec.table && ref.column === spec.alsoDelete.column) continue;
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${ref.table}" WHERE "${ref.column}" = ?`)
        .get(linked) as { n: number }).n;
      if (n > 0) out.push(`${n} ${words(ref.table)} record${n === 1 ? '' : 's'} at its place`);
    }
  }
  return out;
}

/** Fields that must never be copied into the audit log. */
const SECRET = new Set(['password_hash', 'token_hash']);

export function deleteRecord(
  db: Db, spec: DeleteSpec, propertyId: string, id: string, actorUserId: string | null,
): { label: string; before: Record<string, unknown> } {
  const row = db.prepare(
    `SELECT *, ${spec.nameSql} AS __label FROM ${spec.table} WHERE id = ? AND property_id = ?`
  ).get(id, propertyId) as Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, 'not_found', `That ${spec.label} does not exist.`);
  const label = String(row['__label'] ?? spec.label);

  const refusal = spec.refuse?.(db, id, actorUserId);
  if (refusal) throw new HttpError(409, 'cannot_delete', refusal);

  const blocking = blockersFor(db, spec, id);
  if (blocking.length > 0) {
    throw new HttpError(409, 'in_use',
      `${label} cannot be deleted because other records point at it: ${blocking.join('; ')}. ` +
      `Retire it instead — it disappears from lists and its history stays readable.`);
  }

  const linked = linkedId(db, spec, id);
  try {
    db.transaction(() => {
      for (const ref of spec.disposable ?? []) {
        db.prepare(`DELETE FROM "${ref.table}" WHERE "${ref.column}" = ?`).run(id);
      }
      db.prepare(`DELETE FROM ${spec.table} WHERE id = ? AND property_id = ?`).run(id, propertyId);
      if (linked && spec.alsoDelete) {
        db.prepare(`DELETE FROM ${spec.alsoDelete.table} WHERE id = ? AND property_id = ?`)
          .run(linked, propertyId);
      }
    })();
  } catch (e) {
    // The checks above should make this unreachable. If a reference slipped past them the
    // database refuses on its own, and the person is told the same thing in plainer words.
    if (String((e as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
      throw new HttpError(409, 'in_use',
        `${label} is still referred to elsewhere, so it cannot be deleted. Retire it instead.`);
    }
    throw e;
  }

  const before: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k !== '__label' && !SECRET.has(k)) before[k] = v;
  }
  return { label, before };
}

function count(db: Db, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

export const DELETABLE: Record<string, DeleteSpec> = {
  apartment: {
    table: 'apartments', needs: 'apartment.manage', label: 'apartment',
    nameSql: `COALESCE(block || ' · ', '') || unit_no || COALESCE(' (' || name || ')', '')`,
    alsoDelete: { column: 'location_id', table: 'locations' },
  },
  user: {
    table: 'users', needs: 'admin.users.manage', label: 'account', nameSql: 'display_name',
    disposable: [
      { table: 'sessions', column: 'user_id' },
      { table: 'notifications', column: 'user_id' },
      { table: 'alert_state', column: 'user_id' },
      { table: 'pairing_codes', column: 'user_id' },
      { table: 'app_devices', column: 'user_id' },
    ],
    extra: (db, id) => {
      // The audit log names actors by id without a foreign key. Somebody whose actions are
      // in it has a history, and deleting them would leave entries pointing at nobody.
      const n = count(db, 'SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ?', id);
      return n ? [`${n} action${n === 1 ? '' : 's'} in the audit log`] : [];
    },
    refuse: (_db, id, actor) =>
      id === actor ? 'You cannot delete your own account.' : null,
  },
  staff: {
    table: 'staff', needs: 'staff.manage', label: 'person', nameSql: `first_name || ' ' || last_name`,
    extra: (db, id) => {
      const out: string[] = [];
      const logins = count(db, 'SELECT COUNT(*) AS n FROM users WHERE staff_id = ?', id);
      if (logins) out.push(`${logins} login${logins === 1 ? ' is' : 's are'} linked to them`);
      const leads = count(db,
        'SELECT COUNT(*) AS n FROM teams WHERE team_lead_staff_id = ? OR supervisor_staff_id = ?', id, id);
      if (leads) out.push(`named as lead or supervisor of ${leads} team${leads === 1 ? '' : 's'}`);
      return out;
    },
  },
  team: {
    table: 'teams', needs: 'staff.manage', label: 'team', nameSql: 'name',
  },
  location: {
    table: 'locations', needs: 'location.manage', label: 'place', nameSql: 'name',
    refuse: (db, id) => {
      const row = db.prepare('SELECT type, parent_id FROM locations WHERE id = ?')
        .get(id) as { type: string; parent_id: string | null } | undefined;
      return row && row.type === 'site' && !row.parent_id
        ? 'The site is the root everything else hangs off, and cannot be deleted.'
        : null;
    },
  },
  role: {
    table: 'roles', needs: 'admin.roles.manage', label: 'role', nameSql: 'name',
    disposable: [{ table: 'role_permissions', column: 'role_id' }],
    refuse: (db, id) => {
      const row = db.prepare('SELECT key, is_system FROM roles WHERE id = ?')
        .get(id) as { key: string; is_system: number } | undefined;
      if (!row) return null;
      if (row.key === 'admin') return 'The administrator role cannot be deleted.';
      if (row.is_system) {
        return 'This role ships with the system and cannot be deleted. Edit its permissions instead.';
      }
      return null;
    },
  },
};
