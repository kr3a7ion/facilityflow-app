import type { Db } from '../db/connection.js';

export interface SlaRow {
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  label: string;
  respondMinutes: number;
  resolveMinutes: number;
  escalateToRole: string;
}

const FALLBACK_SLA: SlaRow[] = [
  { priority: 'P1', label: 'Emergency', respondMinutes: 15, resolveMinutes: 240, escalateToRole: 'supervisor' },
  { priority: 'P2', label: 'Urgent', respondMinutes: 60, resolveMinutes: 1440, escalateToRole: 'supervisor' },
  { priority: 'P3', label: 'Routine', respondMinutes: 240, resolveMinutes: 4320, escalateToRole: 'team_lead' },
  { priority: 'P4', label: 'Scheduled', respondMinutes: 1440, resolveMinutes: 10080, escalateToRole: 'team_lead' },
];

export function getSetting<T>(db: Db, propertyId: string, key: string, fallback: T): T {
  const row = db.prepare('SELECT value_json FROM settings WHERE property_id = ? AND key = ?')
    .get(propertyId, key) as { value_json: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value_json) as T; } catch { return fallback; }
}

export function setSetting(db: Db, propertyId: string, key: string, value: unknown, at: string, by?: string): void {
  db.prepare(
    `INSERT INTO settings (property_id, key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (property_id, key) DO UPDATE SET value_json = excluded.value_json,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(propertyId, key, JSON.stringify(value), at, by ?? null);
}

export function slaFor(db: Db, propertyId: string, priority: string): SlaRow {
  const matrix = getSetting<SlaRow[]>(db, propertyId, 'sla_matrix', FALLBACK_SLA);
  return matrix.find((r) => r.priority === priority)
    ?? FALLBACK_SLA.find((r) => r.priority === priority)
    ?? FALLBACK_SLA[2]!;
}

export function fuelTolerancePct(db: Db, propertyId: string): number {
  return getSetting<number>(db, propertyId, 'fuel_variance_tolerance_pct', 2);
}

export function labourRateKobo(db: Db, propertyId: string, trade: string | null, at: string): number {
  if (!trade) return 0;
  const row = db.prepare(
    `SELECT hourly_rate_kobo FROM labour_rates
      WHERE property_id = ? AND trade = ? AND effective_from <= ?
      ORDER BY effective_from DESC LIMIT 1`
  ).get(propertyId, trade, at) as { hourly_rate_kobo: number } | undefined;
  return row?.hourly_rate_kobo ?? 0;
}
