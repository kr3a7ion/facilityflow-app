import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/connection.js';
import { nowIso } from '../lib/time.js';
import { tick } from './escalation.js';
import { generateDue } from './ppm.js';
import { pruneSessions } from '../auth/sessions.js';
import { runBackup } from '../db/backup.js';
import type { Config } from '../config.js';
import type { Ctx } from './workOrders.js';

/**
 * Background work the host process runs so nobody has to remember to.
 *
 *  - escalation sweep every few minutes, so a late job surfaces unprompted
 *  - PPM generation once a day, catching up on boot if the host was switched off
 *  - a backup once a day, because a restore button is worthless without snapshots
 *
 * All three are safe to run repeatedly: escalation levels only ever increase, PPM
 * generation skips a schedule that already has an open job, and a backup taken twice
 * is a wasted few hundred kilobytes rather than a problem.
 */
export interface SchedulerHandle { stop: () => void }

const MINUTE = 60_000;

function systemCtx(propertyId: string): Ctx {
  // No human actor. The audit trail says "System", not somebody's name.
  return { propertyId, userId: null, displayName: 'System' };
}

export function properties(db: Db): string[] {
  return (db.prepare('SELECT id FROM properties WHERE is_active = 1').all() as { id: string }[])
    .map((r) => r.id);
}

export function runEscalationSweep(db: Db, log: (msg: string) => void = () => {}): number {
  let total = 0;
  for (const propertyId of properties(db)) {
    const r = tick(db, propertyId);
    total += r.escalated.length;
    if (r.escalated.length) {
      log(`[escalation] ${r.escalated.length} job(s) escalated: ${r.escalated.map((e) => e.ref).join(', ')}`);
    }
  }
  return total;
}

export function runPpmGeneration(db: Db, log: (msg: string) => void = () => {}): number {
  let total = 0;
  for (const propertyId of properties(db)) {
    const r = generateDue(db, systemCtx(propertyId));
    total += r.created.length;
    if (r.created.length) {
      log(`[ppm] generated ${r.created.length} job(s): ${r.created.map((c) => c.ref).join(', ')}`);
    }
  }
  return total;
}

/**
 * A snapshot a day, taken by the machine rather than by somebody's memory.
 *
 * The restore path built into Admin is only as good as the newest snapshot beside it,
 * and "click Back up now every Friday" is not a plan that survives a busy month. This
 * skips the day's backup if one already exists, so restarting the host six times in a
 * morning does not fill the folder and prune away the older snapshots that matter.
 *
 * A failure here is logged and swallowed: a full disk must not take the job board down
 * with it, and the Admin screen shows what the newest snapshot actually is.
 */
export function runDailyBackup(db: Db, cfg: Config, log: (msg: string) => void = () => {}): boolean {
  const today = nowIso().slice(0, 10);
  fs.mkdirSync(cfg.backupsDir, { recursive: true });
  const already = fs.readdirSync(cfg.backupsDir)
    .some((f) => f.startsWith(`facilityflow-${today}`) && f.endsWith('.db'));
  if (already) return false;

  const r = runBackup(db, cfg);
  log(`[backup] ${path.basename(r.file)} — ${(r.bytes / 1024).toFixed(0)} KiB, integrity ${r.integrity}` +
      (r.pruned.length ? `, pruned ${r.pruned.length} old snapshot(s)` : ''));
  return true;
}

export interface SchedulerOptions {
  escalateEveryMinutes?: number;
  ppmEveryHours?: number;
  /** Omit and no automatic backup runs — the CLI and the Admin button still work. */
  config?: Config;
  log?: (msg: string) => void;
  runOnStart?: boolean;
}

export function startScheduler(db: Db, opts: SchedulerOptions = {}): SchedulerHandle {
  const log = opts.log ?? ((m: string) => console.log(m));
  const escalateMs = (opts.escalateEveryMinutes ?? 5) * MINUTE;
  const ppmMs = (opts.ppmEveryHours ?? 12) * 60 * MINUTE;

  const safely = (name: string, fn: () => number) => {
    try { fn(); } catch (err) { log(`[${name}] failed: ${(err as Error).message}`); }
  };

  const backup = () => {
    if (!opts.config) return 0;
    runDailyBackup(db, opts.config, log);
    return 0;
  };

  if (opts.runOnStart !== false) {
    // Catch up on whatever happened while the host was switched off.
    safely('ppm', () => runPpmGeneration(db, log));
    safely('escalation', () => runEscalationSweep(db, log));
    safely('sessions', () => pruneSessions(db));
    // On boot, not only on the timer: the office PC is switched off at night, so a
    // twelve-hour interval on its own could go days without ever firing.
    safely('backup', backup);
  }

  const a = setInterval(() => safely('escalation', () => runEscalationSweep(db, log)), escalateMs);
  const b = setInterval(() => {
    safely('ppm', () => runPpmGeneration(db, log));
    safely('sessions', () => pruneSessions(db));
    safely('backup', backup);
  }, ppmMs);
  a.unref?.(); b.unref?.();

  log(`[scheduler] escalation every ${opts.escalateEveryMinutes ?? 5} min, ` +
      `PPM every ${opts.ppmEveryHours ?? 12} h, ` +
      `${opts.config ? 'a backup once a day' : 'no automatic backup'}, since ${nowIso()}`);

  return { stop: () => { clearInterval(a); clearInterval(b); } };
}
