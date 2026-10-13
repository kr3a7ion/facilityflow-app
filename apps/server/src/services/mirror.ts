/**
 * A second copy, off this PC.
 *
 * Every snapshot the host takes sits on the same disk as the database it copies. That
 * survives a mistake, not a dead machine, a theft or a fire — and the photographs every job,
 * permit and incident carries were in no snapshot at all, because they live on disk beside
 * the database rather than in it. "Download one and keep it somewhere else" was the whole
 * plan, and it depended on somebody remembering.
 *
 * This copies to a folder the department chooses — a USB drive left in the PC, a share on
 * another machine — on the same daily sweep that takes the snapshot: the newest snapshot,
 * and every attachment not already there. Attachments are never changed once written, so a
 * file already present with the same size is the same file, and each run copies only what
 * is new. Every copy is asynchronous, so a first run with years of photographs does not
 * stop the host answering while it works.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';

const STATUS_FILE = 'backup-mirror.json';
const SNAPSHOT = /^facilityflow-.+\.db$/;

export interface MirrorStatus {
  at: string;
  ok: boolean;
  message: string;
  snapshot: string | null;
  photosCopied: number;
  photosThere: number;
}

/**
 * Refuse a folder that cannot work, with the reason, before it is saved.
 *
 * Absolute, already there, a folder, writable — and not inside the data folder, which is
 * the one disk this exists to not depend on.
 */
export async function checkMirrorFolder(cfg: Config, folder: string): Promise<string> {
  const p = folder.trim();
  if (!path.isAbsolute(p)) {
    throw new HttpError(400, 'not_absolute',
      'Give the whole path, starting from the drive — for example E:\\FacilityFlow or \\\\NAS\\backups.');
  }
  const resolved = path.resolve(p);
  const data = path.resolve(cfg.dataDir);
  if (resolved === data || resolved.startsWith(data + path.sep)) {
    throw new HttpError(400, 'same_disk',
      'That folder is inside the data folder, which is what this copy exists to survive losing.');
  }
  let st: fs.Stats;
  try {
    st = await fsp.stat(resolved);
  } catch {
    throw new HttpError(400, 'not_found',
      'That folder does not exist, or this PC cannot reach it. Plug the drive in or check the share, then try again.');
  }
  if (!st.isDirectory()) throw new HttpError(400, 'not_a_folder', 'That is a file, not a folder.');
  const probe = path.join(resolved, `.facilityflow-probe-${process.pid}`);
  try {
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
  } catch {
    throw new HttpError(400, 'not_writable',
      'This PC cannot write to that folder. Check the drive is not read-only and the share allows it.');
  }
  return resolved;
}

async function walk(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

async function sameSize(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    return x.size === y.size;
  } catch {
    return false;
  }
}

/**
 * Copy onto a temporary name and rename into place, so a drive pulled out half way leaves
 * a stray .part file rather than a short copy that looks complete next time.
 */
async function copyInto(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  const part = `${to}.part`;
  await fsp.copyFile(from, part);
  await fsp.rename(part, to);
}

let running: Promise<MirrorStatus> | null = null;

/** Copy what is missing. One run at a time: a second caller gets the run in progress. */
export function runMirror(cfg: Config, folder: string): Promise<MirrorStatus> {
  running ??= (async () => {
    try {
      return await mirrorOnce(cfg, folder);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function mirrorOnce(cfg: Config, folder: string): Promise<MirrorStatus> {
  const at = new Date().toISOString();
  let status: MirrorStatus;
  try {
    await checkMirrorFolder(cfg, folder);

    // The newest snapshot, and as many as are kept here, so the copy can go back as far.
    const snaps = (await fsp.readdir(cfg.backupsDir).catch(() => [] as string[]))
      .filter((f) => SNAPSHOT.test(f)).sort();
    const newest = snaps.at(-1) ?? null;
    const there = path.join(folder, 'snapshots');
    if (newest && !await sameSize(path.join(cfg.backupsDir, newest), path.join(there, newest))) {
      await copyInto(path.join(cfg.backupsDir, newest), path.join(there, newest));
    }
    const kept = (await fsp.readdir(there).catch(() => [] as string[])).filter((f) => SNAPSHOT.test(f)).sort();
    for (const f of kept.slice(0, Math.max(0, kept.length - cfg.backupKeep))) {
      await fsp.unlink(path.join(there, f)).catch(() => {});
    }

    // Every attachment not already there. Never deleted from the copy: a photo removed by
    // mistake on the host is exactly the one somebody will want back.
    let copied = 0;
    const files = await walk(cfg.attachmentsDir);
    for (const f of files) {
      const rel = path.relative(cfg.attachmentsDir, f);
      const dest = path.join(folder, 'attachments', rel);
      if (await sameSize(f, dest)) continue;
      await copyInto(f, dest);
      copied += 1;
    }

    status = {
      at, ok: true, snapshot: newest, photosCopied: copied, photosThere: files.length,
      message: newest
        ? `Copied ${newest}${copied ? ` and ${copied} new file${copied === 1 ? '' : 's'}` : ''}. Everything is there.`
        : 'No snapshot has been taken yet; the files are copied.',
    };
  } catch (err) {
    status = {
      at, ok: false, snapshot: null, photosCopied: 0, photosThere: 0,
      message: err instanceof Error ? err.message : 'The copy failed.',
    };
  }
  try {
    fs.writeFileSync(path.join(cfg.dataDir, STATUS_FILE), JSON.stringify(status, null, 2) + '\n');
  } catch { /* the status is a convenience; the copy is what matters */ }
  return status;
}

/** What the last run did, for the Backups screen. */
export function lastMirror(cfg: Config): MirrorStatus | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cfg.dataDir, STATUS_FILE), 'utf8')) as MirrorStatus;
  } catch {
    return null;
  }
}

export function mirrorRunning(): boolean {
  return running !== null;
}
