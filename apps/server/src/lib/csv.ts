/**
 * CSV for people who will open it in Excel, not for a parser.
 *
 * Three things matter and each is a bug somebody has shipped:
 *  - Excel only reads UTF-8 correctly if the file starts with a byte-order mark, so
 *    "₦" and a technician called Ifeoma survive the round trip.
 *  - CRLF line endings, because Excel on Windows treats a lone LF as one long row.
 *  - A leading =, +, - or @ in a cell is executed as a formula on open. Prefixing with
 *    an apostrophe is the standard defence; without it a value somebody typed into a
 *    job title is a way to run something on the machine of whoever opens the export.
 */
export type CsvValue = string | number | boolean | null | undefined;

const RISKY = /^[=+\-@\t\r]/;

function cell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (RISKY.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface Column { key: string; header: string }

export function toCsv(columns: Column[], rows: Record<string, CsvValue>[]): string {
  const head = columns.map((c) => cell(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(r[c.key])).join(','));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

/** Money is integer kobo everywhere inside; a spreadsheet wants naira it can sum. */
export function naira(kobo: CsvValue): number | null {
  return typeof kobo === 'number' ? Math.round(kobo) / 100 : null;
}

/**
 * A filename that sorts, and that Windows will accept. A month-scoped export carries
 * the month rather than the day it was pulled, so three exports of September taken on
 * three different afternoons do not look like three different months of data.
 */
export function filename(kind: string, month?: string | null, at = new Date()): string {
  const safe = month && /^\d{4}-\d{2}$/.test(month) ? month : at.toISOString().slice(0, 10);
  return `facilityflow-${kind}-${safe}.csv`;
}
