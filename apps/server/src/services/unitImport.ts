import { HttpError } from '../lib/errors.js';

/**
 * Reading a unit list the department already has.
 *
 * The previous importer took pasted text and read the columns **by position** — unit,
 * block, floor, type, in that order. Every real list is a spreadsheet somebody has been
 * editing for years, with its own column order, its own names for things, and columns
 * that mean nothing to maintenance. Asking a facilities manager to re-order a spreadsheet
 * before the system will read it is asking them to do the computer's job.
 *
 * So this reads the header row, guesses what each column is, and shows the guess back for
 * correction. Nothing is written until somebody has seen what would land.
 */

/** What the system actually needs. Everything else in the file is somebody else's data. */
export const FIELDS = ['block', 'unit_no', 'name', 'floor', 'bedrooms', 'type'] as const;
export type Field = (typeof FIELDS)[number];

export const REQUIRED: Field[] = ['unit_no'];

/**
 * Header names seen in the wild, lowercased and stripped of punctuation.
 *
 * Deliberately generous. Being wrong here costs one correction on a screen that shows the
 * mapping; being narrow costs somebody renaming columns in Excel.
 */
const ALIASES: Record<Field, string[]> = {
  block: ['block', 'building', 'wing', 'tower', 'house', 'blockname', 'buildingname'],
  unit_no: ['unitno', 'unit', 'unitnumber', 'number', 'no', 'flat', 'flatno', 'apartment',
            'apartmentno', 'room', 'roomno', 'doorno'],
  name: ['name', 'unitname', 'apartmentname', 'flatname', 'alias', 'label'],
  floor: ['floorlabel', 'floor', 'level', 'storey', 'story', 'floorno'],
  bedrooms: ['bedrooms', 'beds', 'bedroom', 'noofbedrooms', 'numberofbedrooms', 'br'],
  type: ['type', 'unittype', 'apartmenttype', 'category', 'class', 'configuration'],
};

function normalise(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ParsedFile {
  format: 'csv' | 'json';
  headers: string[];
  rows: Record<string, string>[];
  /** Columns in the file that nothing was mapped to — reported, never silently dropped. */
  ignored: string[];
  mapping: Partial<Record<Field, string>>;
}

/**
 * A CSV line reader that understands quotes.
 *
 * Hand-rolled on purpose: a unit list is a few hundred rows of short text, and a parser
 * dependency on a host with no internet is a liability at install time. It handles the two
 * things that actually appear — a comma inside a quoted field, and a doubled quote — and
 * tabs, because half of what people paste is tab separated.
 */
function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = false; }
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      out.push(cur.trim()); cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function detectSeparator(headerLine: string): string {
  const tabs = (headerLine.match(/\t/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  const semis = (headerLine.match(/;/g) ?? []).length;
  if (tabs >= commas && tabs >= semis && tabs > 0) return '\t';
  if (semis > commas) return ';';
  return ',';
}

export function guessMapping(headers: string[]): Partial<Record<Field, string>> {
  const mapping: Partial<Record<Field, string>> = {};
  const taken = new Set<string>();
  // Exact alias order matters: 'floorlabel' is listed before 'floor' so a file with both
  // takes the readable one, which is what somebody reading a job card wants.
  for (const field of FIELDS) {
    for (const alias of ALIASES[field]) {
      const hit = headers.find((h) => !taken.has(h) && normalise(h) === alias);
      if (hit) { mapping[field] = hit; taken.add(hit); break; }
    }
  }
  return mapping;
}

export function parse(text: string): ParsedFile {
  const trimmed = text.trim();
  if (!trimmed) throw new HttpError(400, 'empty', 'There is nothing in that file.');

  // ---- JSON ----------------------------------------------------------------
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new HttpError(400, 'bad_json', 'That looks like JSON but it will not parse.');
    }
    const list = Array.isArray(data)
      ? data
      : (data as { units?: unknown[]; apartments?: unknown[] }).units
        ?? (data as { apartments?: unknown[] }).apartments;
    if (!Array.isArray(list) || list.length === 0) {
      throw new HttpError(400, 'bad_json',
        'Expected a list of units — either a JSON array, or an object with a "units" or "apartments" array in it.');
    }
    const rows = list.map((r) => {
      const o: Record<string, string> = {};
      for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
        o[k] = v === null || v === undefined ? '' : String(v).trim();
      }
      return o;
    });
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const mapping = guessMapping(headers);
    return {
      format: 'json', headers, rows, mapping,
      ignored: headers.filter((h) => !Object.values(mapping).includes(h)),
    };
  }

  // ---- CSV -----------------------------------------------------------------
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerLine = lines[0];
  if (!headerLine || lines.length < 2) {
    throw new HttpError(400, 'no_rows',
      'That file needs a header row and at least one unit under it.');
  }
  const sep = detectSeparator(headerLine);
  const headers = splitLine(headerLine, sep).map((h) => h.replace(/^"|"$/g, ''));
  if (headers.filter(Boolean).length < 1) {
    throw new HttpError(400, 'no_headers', 'The first row should name the columns.');
  }

  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line, sep);
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) o[h] = cells[i] ?? ''; });
    return o;
  });

  const mapping = guessMapping(headers);
  return {
    format: 'csv', headers, rows, mapping,
    ignored: headers.filter((h) => h && !Object.values(mapping).includes(h)),
  };
}

export interface Unit {
  unitNo: string;
  block?: string;
  name?: string;
  floor?: string;
  bedrooms?: number;
  unitType?: string;
}

export interface MapResult {
  units: Unit[];
  /** Rows that could not be used, with the line number from the file and why. */
  rejected: { line: number; reason: string; raw: string }[];
}

/**
 * Turn mapped rows into units.
 *
 * A row with no unit number is reported with its line number rather than dropped, because
 * "114 rows in, 112 imported" with no explanation is the kind of thing that makes somebody
 * distrust the whole system.
 */
export function toUnits(
  rows: Record<string, string>[], mapping: Partial<Record<Field, string>>
): MapResult {
  const col = (row: Record<string, string>, f: Field): string => {
    const header = mapping[f];
    if (!header) return '';
    return (row[header] ?? '').trim();
  };

  const units: Unit[] = [];
  const rejected: MapResult['rejected'] = [];

  rows.forEach((row, i) => {
    const unitNo = col(row, 'unit_no');
    // +2: one for the header row, one because people count from 1.
    const line = i + 2;
    if (!unitNo) {
      rejected.push({ line, reason: 'no unit number', raw: Object.values(row).join(' · ').slice(0, 80) });
      return;
    }
    const bedroomsRaw = col(row, 'bedrooms');
    let bedrooms: number | undefined;
    if (bedroomsRaw) {
      // "3", "3 bedroom", "3-bed" all mean three. "Studio" means none, and none is a real
      // answer rather than a missing one.
      if (/studio/i.test(bedroomsRaw)) bedrooms = 0;
      else {
        const n = Number(bedroomsRaw.replace(/[^0-9.]/g, ''));
        if (Number.isFinite(n) && n >= 0 && n < 100) bedrooms = Math.round(n);
      }
    }
    units.push({
      unitNo,
      block: col(row, 'block') || undefined,
      name: col(row, 'name') || undefined,
      floor: col(row, 'floor') || undefined,
      unitType: col(row, 'type') || undefined,
      bedrooms,
    });
  });

  return { units, rejected };
}

/** `block ∥ unit` — the pair the table is unique on, normalised the same way every time. */
export function unitKey(block: string | null | undefined, unitNo: string): string {
  return `${(block ?? '').trim().toLowerCase()}\u0000${unitNo.trim().toLowerCase()}`;
}
