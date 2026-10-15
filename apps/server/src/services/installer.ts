/**
 * The alert app's installer: whether this host has one, and which build it is.
 *
 * The file is copied into the data folder by hand, so its version is read from the file
 * itself (lib/apk.ts) — once per copy, not once per request: phones ask on a timer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { apkVersion, type ApkVersion } from '../lib/apk.js';

export interface Installer {
  present: boolean;
  bytes?: number;
  updatedAt?: string;
  /** "1.0.0"; null when the file could not be read as an APK. */
  version: string | null;
  /** The build number phones compare against their own. */
  build: number | null;
}

export const installerFile = (dataDir: string): string => path.join(dataDir, 'app.apk');

let cached: { key: string; version: ApkVersion | null } | null = null;

export function installer(dataDir: string): Installer {
  const file = installerFile(dataDir);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { present: false, version: null, build: null };
  }
  // A new copy changes the size or the time, and is read again.
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (cached?.key !== key) cached = { key, version: apkVersion(file) };
  return {
    present: true, bytes: st.size, updatedAt: st.mtime.toISOString(),
    version: cached.version?.name ?? null, build: cached.version?.code ?? null,
  };
}
