import type { Database } from 'better-sqlite3';

/**
 * Human-facing references: WO-2026-0417. Per-year sequence, separate from the ULID id.
 * Short enough to read out over a radio.
 */
export function nextRef(db: Database, propertyId: string, prefix: string, year = new Date().getUTCFullYear()): string {
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO ref_sequences (property_id, prefix, year, next_value)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (property_id, prefix, year) DO UPDATE SET next_value = next_value + 1`
    ).run(propertyId, prefix, year);
    const row = db.prepare(
      'SELECT next_value FROM ref_sequences WHERE property_id = ? AND prefix = ? AND year = ?'
    ).get(propertyId, prefix, year) as { next_value: number } | undefined;
    return row?.next_value ?? 1;
  });
  const n = run();
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}
