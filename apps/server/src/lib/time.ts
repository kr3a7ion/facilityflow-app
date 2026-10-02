/**
 * Everything is stored as UTC ISO-8601 text and rendered in the property timezone.
 * Night shifts cross midnight; comparing on local dates is how roster logic breaks.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function isPast(iso: string | null | undefined): boolean {
  return !!iso && new Date(iso).getTime() <= Date.now();
}

/** YYYY-MM-DD in the given IANA timezone — the roster's idea of "today". */
export function localDate(tz: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Filesystem-safe UTC stamp for backup filenames. */
export function stamp(at: Date = new Date()): string {
  return at.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

/**
 * How far the property's local clock is from UTC at a given instant, in minutes.
 * Derived by formatting rather than assumed, so a timezone that changes offset
 * during the year does not quietly shift a month boundary by an hour.
 */
function offsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return (asUtc - at.getTime()) / 60000;
}

/** The UTC instant of local midnight on a given local calendar day. */
function localMidnightUtc(tz: string, year: number, month: number, day: number): Date {
  const wall = Date.UTC(year, month - 1, day);
  const first = offsetMinutes(tz, new Date(wall));
  let ms = wall - first * 60000;
  // One correction pass: the first guess can land on the wrong side of a DST change.
  const second = offsetMinutes(tz, new Date(ms));
  if (second !== first) ms = wall - second * 60000;
  return new Date(ms);
}

export interface MonthRange { month: string; from: string; to: string; label: string }

/** YYYY-MM for the property's current local month. */
export function currentMonth(tz: string, at: Date = new Date()): string {
  return localDate(tz, at).slice(0, 7);
}

/**
 * A calendar month as a half-open UTC range, `from <= t < to`.
 *
 * Screens are scoped to a month so a property three years in does not ask the host to
 * read and ship every movement it has ever recorded to draw one table. Half-open, not
 * inclusive, because a `BETWEEN` on ISO text silently drops anything recorded in the
 * last second of the month.
 */
export function monthRange(month: string, tz: string): MonthRange {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`month must look like 2026-09, got "${month}"`);
  const year = Number(m[1]); const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error(`month ${month} is not a real month`);
  const from = localMidnightUtc(tz, year, mon, 1);
  const to = localMidnightUtc(tz, mon === 12 ? year + 1 : year, mon === 12 ? 1 : mon + 1, 1);
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(year, mon - 1, 15)));
  return { month, from: from.toISOString(), to: to.toISOString(), label };
}

/** Step a YYYY-MM by whole months, either direction. */
export function shiftMonth(month: string, by: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`month must look like 2026-09, got "${month}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
