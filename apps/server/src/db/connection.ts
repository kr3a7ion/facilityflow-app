import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

/**
 * SQLite pragmas that matter, set on EVERY connection:
 *  - foreign_keys defaults to OFF and silently accepts orphan rows without this.
 *  - WAL lets many readers work while one writer commits, which is the whole
 *    concurrency story for a department of this size.
 */
export function openDb(dbPath: string): Db {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

export function integrityCheck(db: Db): string {
  const row = db.pragma('integrity_check', { simple: true });
  return String(row);
}

export type { Db };
