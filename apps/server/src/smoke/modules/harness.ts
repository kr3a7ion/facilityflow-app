/**
 * What every chapter of the module checks shares: the check/heading harness, one throwaway
 * database and app built through the real HTTP layer, and the helpers that sign in and call it.
 * The chapters run in order from smoke.modules.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

export let passed = 0;
export const failures: string[] = [];
let group = '';

export function heading(name: string): void { group = name; console.log(`\n${name}`); }
export function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`[${group}] ${name}${detail ? ' — ' + detail : ''}`);
         console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
export function near(a: number, b: number, tol = 0.01): boolean { return Math.abs(a - b) <= tol; }
export function throws(name: string, fn: () => unknown): void {
  try { fn(); check(name, false, 'expected it to throw'); } catch { check(name, true); }
}


/** Build a multipart body by hand so inject() can post a file without extra deps. */
export function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const b = '----ffsmoke' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

// A real 1x1 PNG, so the magic-byte check has something honest to read.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

export const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mod-'));
export const config = loadConfig({ dataDir: dir });
export const db = openDb(config.dbPath);
migrate(db);
export const app: FastifyInstance = await buildApp(db, config);

console.log(`\nFacilityFlow module checks\ndata dir: ${dir}`);

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
export type Hdr = { cookie: string };
/**
 * Sign in as a fixture account.
 *
 * Every account here is created by an administrator, so every one starts on a temporary
 * password the server holds behind the change screen. Fixture accounts are treated as past
 * that first sign-in, so the sections below can exercise what they are about; the change
 * itself is exercised through the API in "A person can change their own password".
 * `asIssued` signs in on the password as it was handed out, flag and all.
 */
export async function login(username: string, password: string, { asIssued = false } = {}): Promise<Hdr> {
  if (!asIssued) db.prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run(username);
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  const c = r.cookies.find((x) => x.name === 'ff_sid');
  if (!c) throw new Error(`login failed for ${username}: ${r.body}`);
  return { cookie: `ff_sid=${c.value}` };
}
export async function post(url: string, headers: Hdr, payload?: unknown) {
  return app.inject({ method: 'POST', url, headers, payload: payload as object });
}
export async function get(url: string, headers: Hdr) {
  return app.inject({ method: 'GET', url, headers });
}
export const PW = 'facilityflow-testing';
/* One source for the property's timezone: the fixture below sets it on the property,
   and day() reads it back. Two copies of this is exactly how they drift apart. */
export const PROPERTY_TZ = 'Africa/Lagos';
export const iso = (offsetDays: number, base = Date.now()) => new Date(base + offsetDays * 86_400_000).toISOString();
/*
 * A calendar day in the PROPERTY's timezone, not in UTC.
 *
 * The roster is keyed on the property's local date, and the product is right to do
 * that: a Lagos maintenance department's "today" is Lagos's today, not Greenwich's.
 * This fixture used to slice the date off a UTC timestamp, which agrees with the
 * product for 23 hours a day and disagrees for the hour between 23:00 UTC and
 * midnight, when Lagos has already rolled over. In that hour it marked people present
 * on yesterday, every assignment was refused as not_on_shift, and the whole job
 * lifecycle below it failed — a suite that passes depending on what time you run it
 * is worse than one that fails.
 */
export const day = (offsetDays: number, base = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: PROPERTY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(base + offsetDays * 86_400_000));

/** The server's src folder, for the checks that read the source and the built client. */
export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** What inject() answers. Each chapter keeps the latest one in its own `r`. */
export type Res = Awaited<ReturnType<typeof app.inject>>;
