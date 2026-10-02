import fs from 'node:fs';
import path from 'node:path';
import { openDb, integrityCheck } from './connection.js';
import { loadConfig, type Config } from '../config.js';
import { stamp } from '../lib/time.js';
import type { Db } from './connection.js';

export interface BackupResult { file: string; bytes: number; integrity: string; pruned: string[] }

/**
 * VACUUM INTO writes a clean, consistent copy while the server keeps running.
 * The attachments folder is backed up separately by the host — it is far larger
 * than the database and does not need the same frequency.
 *
 * An untested backup is not a backup: restoreCheck() opens the copy and runs an
 * integrity check, so a corrupt snapshot is caught now rather than on the day it matters.
 */
export function runBackup(db: Db, cfg: Config): BackupResult {
  fs.mkdirSync(cfg.backupsDir, { recursive: true });
  const file = path.join(cfg.backupsDir, `facilityflow-${stamp()}.db`);
  db.prepare('VACUUM INTO ?').run(file);

  const copy = openDb(file);
  const integrity = integrityCheck(copy);
  copy.close();
  if (integrity !== 'ok') throw new Error(`backup failed integrity check: ${integrity}`);

  const pruned = prune(cfg);
  return { file, bytes: fs.statSync(file).size, integrity, pruned };
}

function prune(cfg: Config): string[] {
  const files = fs.readdirSync(cfg.backupsDir)
    .filter((f) => f.startsWith('facilityflow-') && f.endsWith('.db'))
    .sort()
    .reverse();
  const doomed = files.slice(cfg.backupKeep);
  for (const f of doomed) fs.unlinkSync(path.join(cfg.backupsDir, f));
  return doomed;
}

// CLI: npm run backup
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const r = runBackup(db, cfg);
  console.log(`backup:    ${r.file}`);
  console.log(`size:      ${(r.bytes / 1024).toFixed(1)} KiB`);
  console.log(`integrity: ${r.integrity}`);
  if (r.pruned.length) console.log(`pruned:    ${r.pruned.length} old snapshot(s)`);
  db.close();
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restoring is staged, not immediate.
 *
 * SQLite is open and in WAL mode while the server runs; swapping the file underneath a
 * live connection is how you turn one bad day into two. So a restore writes the chosen
 * snapshot to `restore-pending.db` and the boot sequence applies it before anything opens
 * the database. The server then has to be restarted — on the Windows host the Scheduled
 * Task does that within five minutes, and by hand it is one Ctrl-C.
 *
 * The current database is copied to `pre-restore-<stamp>.db` first, every time. Somebody
 * restoring the wrong snapshot at 6am is a likelier event than the corruption they were
 * reaching for, and that copy is the only way back from it.
 */
export const PENDING = 'restore-pending.db';

export interface StagedRestore {
  from: string; bytes: number; integrity: string; safetyCopy: string;
}

function pendingPath(cfg: Config): string { return path.join(cfg.dataDir, PENDING); }

export function stageRestore(cfg: Config, backupFile: string): StagedRestore {
  // The filename comes from a request, so it is treated as hostile: basename only, and it
  // has to resolve to something that is really inside the backups folder.
  const safe = path.basename(backupFile);
  const source = path.join(cfg.backupsDir, safe);
  if (path.dirname(path.resolve(source)) !== path.resolve(cfg.backupsDir) || !fs.existsSync(source)) {
    throw new Error(`No backup called "${safe}" exists.`);
  }

  // Never stage a snapshot without opening it first. A corrupt file restored on top of a
  // working one loses everything the corruption had not yet reached.
  const check = openDb(source);
  const integrity = integrityCheck(check);
  const tables = (check.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`
  ).get() as { n: number }).n;
  check.close();
  if (integrity !== 'ok') throw new Error(`That snapshot fails its integrity check: ${integrity}`);
  if (tables < 10) throw new Error('That file does not look like a FacilityFlow database.');

  const safetyCopy = path.join(cfg.backupsDir, `pre-restore-${stamp()}.db`);
  if (fs.existsSync(cfg.dbPath)) {
    const live = openDb(cfg.dbPath);
    live.prepare('VACUUM INTO ?').run(safetyCopy);
    live.close();
  }

  fs.copyFileSync(source, pendingPath(cfg));
  return { from: safe, bytes: fs.statSync(source).size, integrity, safetyCopy: path.basename(safetyCopy) };
}

export function pendingRestore(cfg: Config): string | null {
  const p = pendingPath(cfg);
  return fs.existsSync(p) ? p : null;
}

export function cancelRestore(cfg: Config): boolean {
  const p = pendingPath(cfg);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/**
 * Called at boot, before the database is opened. Moves the staged file into place and
 * removes the WAL and shared-memory sidecars — they belong to the database being
 * replaced, and leaving them beside a different file is how a restore ends up serving a
 * mixture of the two.
 */
export function applyPendingRestore(cfg: Config): string | null {
  const p = pendingPath(cfg);
  if (!fs.existsSync(p)) return null;
  for (const sidecar of ['-wal', '-shm']) {
    const f = `${cfg.dbPath}${sidecar}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  fs.renameSync(p, cfg.dbPath);
  return cfg.dbPath;
}
