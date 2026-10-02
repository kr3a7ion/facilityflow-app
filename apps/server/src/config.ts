import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export interface Config {
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
  backupsDir: string;
  port: number;
  host: string;
  sessionDays: number;
  backupKeep: number;
  /** Serve HTTPS alongside HTTP, with this property's own root. Off by default. */
  https: boolean;
  httpsPort: number;
}

/**
 * The data directory must NOT depend on the shell's working directory — otherwise
 * `npm run seed` from apps/server and `npm start` from the repo root quietly write
 * to two different databases. Anchor it to the workspace root instead.
 * FF_DATA_DIR overrides it when the host keeps its data somewhere else.
 */
function defaultDataDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return path.join(dir, 'data');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve('./data');
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Settings the host keeps between restarts, written by the Admin screen. */
export interface HostFile {
  port?: number;
  /**
   * The address to hand out, when an administrator has picked one. Advisory only: it
   * decides what the QR code and the "address to hand out" show, never what the server
   * listens on, so a saved address that has since changed costs the department a wrong
   * line on a screen rather than a system that will not start.
   */
  advertise?: string;
  /**
   * The interface address to listen on, when a property has deliberately narrowed it.
   * Unset means every interface, which is the default and the one that survives a
   * changed address.
   */
  bindTo?: string;
  /**
   * Serve HTTPS as well as HTTP, using a certificate signed by this property's own root.
   *
   * Off until somebody turns it on, because it is only useful once the root has been
   * installed on the department's devices — and a padlock warning on every phone is worse
   * than plain HTTP on a LAN that was never on the internet.
   */
  https?: boolean;
  /** The port HTTPS answers on. Defaults to the HTTP port plus one. */
  httpsPort?: number;
}

export const HOST_FILE = 'host.json';

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Read `data/host.json`, the small file the Admin screen writes.
 *
 * It sits below the environment on purpose. Somebody who sets FF_PORT on the command
 * line means it for that run and must not be silently overruled by a file — but the
 * scheduled task sets nothing, so on the office PC this file is what actually decides,
 * which is the whole point of being able to change it from a screen.
 *
 * A corrupt or hand-edited file must never stop the server booting: the department
 * cannot fix JSON at 6am, and a host that will not start is a worse failure than a
 * host on the wrong port.
 */
export function readHostFile(dataDir: string): HostFile {
  try {
    const raw = fs.readFileSync(path.join(dataDir, HOST_FILE), 'utf8');
    const parsed = JSON.parse(raw) as HostFile;
    const out: HostFile = {};
    const port = Number(parsed?.port);
    if (Number.isFinite(port) && port >= 1024 && port <= 65535) out.port = Math.floor(port);
    // Each field is validated on its own: one bad value must not discard the others,
    // and a hand-edited address must never reach a socket unchecked.
    if (typeof parsed?.advertise === 'string' && IPV4.test(parsed.advertise)) {
      out.advertise = parsed.advertise;
    }
    if (typeof parsed?.bindTo === 'string' && IPV4.test(parsed.bindTo)) {
      out.bindTo = parsed.bindTo;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeHostFile(dataDir: string, next: HostFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, HOST_FILE), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.FF_DATA_DIR ?? defaultDataDir());
  const saved = readHostFile(dataDir);
  const cfg: Config = {
    dataDir,
    dbPath: path.join(dataDir, 'facilityflow.db'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    backupsDir: path.join(dataDir, 'backups'),
    // Environment beats the saved file beats the default.
    port: int(process.env.FF_PORT, saved.port ?? 4700),
    host: process.env.FF_HOST ?? saved.bindTo ?? '0.0.0.0',
    sessionDays: int(process.env.FF_SESSION_DAYS, 7),
    backupKeep: int(process.env.FF_BACKUP_KEEP, 14),
    https: process.env.FF_HTTPS ? process.env.FF_HTTPS !== '0' : (saved.https ?? false),
    // One above the HTTP port by default, so "the usual address with an s" is one number
    // away rather than something to look up.
    httpsPort: int(process.env.FF_HTTPS_PORT,
                   saved.httpsPort ?? (int(process.env.FF_PORT, saved.port ?? 4700) + 1)),
    ...overrides,
  };
  for (const dir of [cfg.dataDir, cfg.attachmentsDir, cfg.backupsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return cfg;
}

/** IPv4 addresses other machines on the LAN can reach this host on. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
