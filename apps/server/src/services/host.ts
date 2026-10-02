/**
 * What the host PC is actually doing, reported to the Admin screen.
 *
 * This exists because every question somebody asks on the day of an install — "is it
 * running as a service or just in your window?", "did the firewall rule take?", "what
 * address do I give the store?", "when did it last back up?" — currently has no answer
 * except reading PowerShell output over somebody's shoulder.
 *
 * The rule throughout: report what can be established, and say **unknown** for the rest.
 * A status screen that guesses is worse than no status screen, because somebody will
 * act on it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Config } from '../config.js';
import { readHostFile } from '../config.js';
import { networkView, type NetworkView } from './network.js';

/** Windows queries are allowed a moment and no more; a slow one must not hang the screen. */
const PROBE_MS = 4000;
const TASK_NAME = 'FacilityFlow';

export type Known<T> = { state: T } | { state: 'unknown'; why: string };

export interface BackupSummary {
  count: number; newestAt: string | null; newestFile: string | null;
  newestBytes: number | null; totalBytes: number; ageHours: number | null;
}

export interface HostStatus {
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  node: string;
  platform: string;
  port: number;
  bindsTo: string;
  addresses: { label: string; url: string; kind: 'local' | 'lan' }[];
  /** Every adapter on this PC, classified, with one picked to hand out. */
  network: NetworkView;
  /** The address the QR code and the join card should show. */
  advertise: string | null;
  /** Set when this host has been narrowed to a single interface. */
  boundTo: string | null;
  /** A port change saved from Admin that this process has not picked up yet. */
  pendingPort: number | null;
  dataDir: string;
  dataBytes: number;
  attachmentCount: number;
  freeBytes: number | null;
  backups: BackupSummary;
  /** Windows only, and only when it can be established. */
  bootService: Known<'registered' | 'missing'> & { detail?: string };
  firewall: Known<'open' | 'missing'> & { detail?: string };
  isWindows: boolean;
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // Fixed command, fixed arguments, nothing from a request — there is no injection
    // surface here and execFile does not go through a shell in any case.
    const child = execFile(cmd, args, { timeout: PROBE_MS, windowsHide: true },
      (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') }));
    child.on('error', () => resolve({ ok: false, out: '' }));
  });
}

/** Recursive size, capped so a huge attachments folder cannot stall the screen. */
function dirBytes(dir: string, budget = { files: 20_000 }): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.files <= 0) return total;
    budget.files--;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(full, budget);
    else {
      try { total += fs.statSync(full).size; } catch { /* vanished mid-walk */ }
    }
  }
  return total;
}

function countFiles(dir: string, budget = { files: 20_000 }): number {
  let n = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.files <= 0) return n;
    budget.files--;
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name), budget);
    else n++;
  }
  return n;
}

export function backupSummary(cfg: Config, at = new Date()): BackupSummary {
  let files: string[];
  try {
    files = fs.readdirSync(cfg.backupsDir)
      .filter((f) => f.startsWith('facilityflow-') && f.endsWith('.db'));
  } catch {
    return { count: 0, newestAt: null, newestFile: null, newestBytes: null, totalBytes: 0, ageHours: null };
  }

  let total = 0;
  let newest: { file: string; mtime: number; size: number } | null = null;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(cfg.backupsDir, f));
      total += st.size;
      if (!newest || st.mtimeMs > newest.mtime) newest = { file: f, mtime: st.mtimeMs, size: st.size };
    } catch { /* vanished mid-walk */ }
  }

  return {
    count: files.length,
    newestAt: newest ? new Date(newest.mtime).toISOString() : null,
    newestFile: newest?.file ?? null,
    newestBytes: newest?.size ?? null,
    totalBytes: total,
    ageHours: newest ? Math.round(((at.getTime() - newest.mtime) / 3_600_000) * 10) / 10 : null,
  };
}

/**
 * Is the server registered to start at boot?
 *
 * On Windows this is answerable — the scheduled task either exists or it does not.
 * Anywhere else, and whenever the query fails, the honest answer is that we cannot
 * tell from inside the process, which is what gets reported.
 */
async function bootService(): Promise<HostStatus['bootService']> {
  if (process.platform !== 'win32') {
    return { state: 'unknown', why: 'The boot service is a Windows scheduled task; this host is not Windows.' };
  }
  const r = await run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST']);
  if (r.ok && /TaskName/i.test(r.out)) {
    const status = /Status:\s*(.+)/i.exec(r.out)?.[1]?.trim();
    return { state: 'registered', detail: status || undefined };
  }
  // schtasks exits non-zero when the task simply is not there, which is an answer.
  if (/cannot find|does not exist/i.test(r.out) || !r.ok) {
    return { state: 'missing' };
  }
  return { state: 'unknown', why: 'The scheduled task query gave an answer that could not be read.' };
}

async function firewall(port: number): Promise<HostStatus['firewall']> {
  if (process.platform !== 'win32') {
    return { state: 'unknown', why: 'Firewall rules are checked only on Windows.' };
  }
  const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule',
                                `name=FacilityFlow (${port})`]);
  if (r.ok && /Enabled:\s*Yes/i.test(r.out)) return { state: 'open' };
  if (/No rules match/i.test(r.out) || !r.ok) return { state: 'missing' };
  return { state: 'unknown', why: 'The firewall query gave an answer that could not be read.' };
}

function freeBytes(dir: string): number | null {
  try {
    // statfs is Node 18.15+ and not on every platform; absence is not an error worth surfacing.
    const sf = (fs as unknown as {
      statfsSync?: (p: string) => { bsize: number; bavail: number };
    }).statfsSync;
    if (!sf) return null;
    const st = sf(dir);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}

export async function hostStatus(cfg: Config, version: string): Promise<HostStatus> {
  const uptime = process.uptime();
  const saved = readHostFile(cfg.dataDir);

  const [service, fw, net] = await Promise.all([
    bootService(), firewall(cfg.port), networkView(saved.advertise ?? null),
  ]);

  // Only the addresses somebody could actually reach the host on. A VirtualBox adapter
  // and a 169.254 address were being offered here as though they were the office network.
  const addresses: HostStatus['addresses'] = [
    { label: 'On this PC', url: `http://localhost:${cfg.port}`, kind: 'local' },
    ...net.nics.filter((n) => n.usable).map((n) => ({
      label: n.name, url: `http://${n.address}:${cfg.port}`, kind: 'lan' as const,
    })),
  ];

  return {
    version,
    startedAt: new Date(Date.now() - uptime * 1000).toISOString(),
    uptimeSeconds: Math.round(uptime),
    node: process.versions.node,
    platform: `${os.platform()} ${os.release()}`,
    port: cfg.port,
    bindsTo: cfg.host,
    addresses,
    network: net,
    advertise: net.advertise,
    boundTo: cfg.host === '0.0.0.0' ? null : cfg.host,
    // Saved but not in force: the file was changed and nobody has restarted yet.
    pendingPort: saved.port != null && saved.port !== cfg.port ? saved.port : null,
    dataDir: cfg.dataDir,
    dataBytes: dirBytes(cfg.dataDir),
    attachmentCount: countFiles(cfg.attachmentsDir),
    freeBytes: freeBytes(cfg.dataDir),
    backups: backupSummary(cfg),
    bootService: service,
    firewall: fw,
    isWindows: process.platform === 'win32',
  };
}
