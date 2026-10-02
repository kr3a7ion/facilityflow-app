import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';
import { openDb } from './connection.js';
import { loadConfig } from '../config.js';
import { nowIso } from '../lib/time.js';

export interface AppliedMigration { version: string; applied_at: string; checksum: string }

export function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.join(here, 'migrations');
  if (fs.existsSync(local)) return local;
  // Running from dist without the copy step: fall back to the source tree.
  const fromSrc = path.resolve(here, '../../src/db/migrations');
  if (fs.existsSync(fromSrc)) return fromSrc;
  throw new Error(`migrations directory not found (looked in ${local} and ${fromSrc})`);
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

export function migrate(db: Db, dir = migrationsDir()): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    checksum   TEXT NOT NULL
  )`);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map(
    (db.prepare('SELECT version, applied_at, checksum FROM schema_migrations').all() as AppliedMigration[])
      .map((r) => [r.version, r])
  );

  const ran: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const sum = checksum(sql);
    const prev = applied.get(version);

    if (prev) {
      // An applied migration must never be edited — the databases already in the
      // field would silently diverge from the source tree.
      if (prev.checksum !== sum) {
        throw new Error(
          `migration ${version} has changed since it was applied on ${prev.applied_at}. ` +
          `Add a new migration instead of editing an applied one.`
        );
      }
      continue;
    }

    /*
     * Rebuilding a table means dropping it, and dropping a table that other tables point
     * at fires their ON DELETE CASCADE — which would quietly take work orders and
     * inspections with it. SQLite's own answer is to turn foreign keys off for the
     * rebuild, and that pragma is a no-op inside a transaction, so it has to happen out
     * here.
     *
     * Opted into per migration with a marker on the first line, so it is visible in the
     * file that does it rather than being the default for everything:
     *
     *     -- @foreign_keys: off
     *
     * The integrity check afterwards is the point: a rebuild that left a dangling
     * reference fails the migration and rolls nothing forward, rather than being
     * discovered months later by a report that returns the wrong rows.
     */
    const fkOff = /^\s*--\s*@foreign_keys:\s*off\b/im.test(sql.slice(0, 400));

    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)')
        .run(version, nowIso(), sum);
    });

    if (fkOff) {
      db.pragma('foreign_keys = OFF');
      try {
        apply();
        const dangling = db.pragma('foreign_key_check') as unknown[];
        if (dangling.length > 0) {
          throw new Error(
            `migration ${version} left ${dangling.length} dangling foreign key reference(s). ` +
            'The database has not been changed.'
          );
        }
      } finally {
        // Always back on, including after a failure, or every later query in this process
        // would be running without the constraint this system depends on.
        db.pragma('foreign_keys = ON');
      }
    } else {
      apply();
    }
    ran.push(version);
  }
  return ran;
}

export function appliedVersions(db: Db): string[] {
  const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`).get();
  if (!t) return [];
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[])
    .map((r) => r.version);
}

// CLI: npm run migrate
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const ran = migrate(db);
  console.log(ran.length ? `applied: ${ran.join(', ')}` : 'database already up to date');
  console.log(`schema:  ${appliedVersions(db).join(', ')}`);
  console.log(`file:    ${cfg.dbPath}`);
  db.close();
}
