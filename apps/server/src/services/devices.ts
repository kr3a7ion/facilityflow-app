/**
 * Paired phones: how one is enrolled, how it proves itself afterwards, and how the
 * department finds out when one has gone quiet.
 *
 * The enrolment is deliberately indirect. The person is already signed in on the web, so
 * the browser asks for a code, the phone scans it, and the server hands the phone a token
 * of its own. At no point does a password go into the app. That matters for a department
 * where phones are lost, sold and handed to a cousin: revoking a device is one row, not a
 * password reset that signs the person out of everything they own.
 */
import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';

/** Long enough that guessing is not a strategy, short enough to live in a QR code. */
const TOKEN_BYTES = 32;

/**
 * Ten minutes, and one use.
 *
 * Long enough to walk from the office PC to wherever the phone was left, short enough
 * that a code photographed off a screen and forgotten is worthless by lunchtime.
 */
const CODE_TTL_MINUTES = 10;

/**
 * No I, O, 0 or 1. Somebody is reading this off a screen and typing it into a phone with
 * one hand, and a code that cannot be transcribed is a code that gets written down badly.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function makeCode(): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export interface PairingCode {
  code: string;
  expiresAt: string;
  /** Everything the phone needs, so one scan is the entire setup. */
  payload: string;
}

/**
 * Mint a code for the person asking.
 *
 * The identity comes from the session, never from the request. A code that let a caller
 * name somebody else would be a way to mint a working token for their account.
 */
export function createPairingCode(
  db: Db, propertyId: string, userId: string, baseUrl: string,
): PairingCode {
  const at = nowIso();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();

  // Any code this person left outstanding is spent now. Two live codes for one account is
  // one more than anybody needs and one more chance for the wrong phone to use one.
  db.prepare(
    `UPDATE pairing_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL`
  ).run(at, userId);

  let code = makeCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = db.prepare('SELECT 1 FROM pairing_codes WHERE code = ?').get(code);
    if (!clash) break;
    code = makeCode();
  }

  db.prepare(
    `INSERT INTO pairing_codes (code, property_id, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(code, propertyId, userId, expiresAt, at);

  return {
    code,
    expiresAt,
    // One scan carries both halves: where the host is, and who this is. Without the URL
    // the person would have to type an IP address into a phone, which is the step that
    // makes somebody give up and go back to not being told about jobs.
    payload: JSON.stringify({ v: 1, url: baseUrl, code }),
  };
}

export interface PairedDevice {
  deviceId: string;
  token: string;
  user: { id: string; displayName: string; username: string; role: string; roleName: string };
  property: { name: string; shortName: string };
}

export function redeemPairingCode(
  db: Db, code: string, deviceName: string, platform: string, appVersion: string | undefined,
): PairedDevice {
  const at = nowIso();
  const row = db.prepare(
    `SELECT code, property_id, user_id, expires_at, used_at FROM pairing_codes WHERE code = ?`
  ).get(code.trim().toUpperCase()) as {
    code: string; property_id: string; user_id: string; expires_at: string; used_at: string | null;
  } | undefined;

  // One message for every failure. Telling the difference between "no such code" and
  // "that code was already used" is a way to probe for live codes.
  const refuse = (): never => {
    throw new HttpError(400, 'bad_code',
      'That pairing code is not valid any more. Generate a fresh one on the website and scan it again.');
  };
  if (!row || row.used_at || row.expires_at < at) refuse();

  const user = db.prepare(
    `SELECT u.id, u.display_name, u.username, u.is_active, r.key AS role, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
  ).get(row!.user_id) as {
    id: string; display_name: string; username: string; is_active: number;
    role: string; role_name: string;
  } | undefined;
  if (!user || !user.is_active) refuse();

  const property = db.prepare('SELECT name, short_name FROM properties WHERE id = ?')
    .get(row!.property_id) as { name: string; short_name: string } | undefined;

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const deviceId = ulid();

  db.transaction(() => {
    db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code = ?').run(at, row!.code);
    db.prepare(
      `INSERT INTO app_devices (id, property_id, user_id, name, platform, token_hash,
                                app_version, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(deviceId, row!.property_id, row!.user_id, deviceName.slice(0, 60) || 'Phone',
          platform, hashToken(token), appVersion ?? null, at, at);
  })();

  return {
    deviceId,
    token,
    user: {
      id: user!.id, displayName: user!.display_name, username: user!.username,
      role: user!.role, roleName: user!.role_name,
    },
    property: { name: property?.name ?? '', shortName: property?.short_name ?? '' },
  };
}

export interface DeviceIdentity {
  deviceId: string;
  userId: string;
  propertyId: string;
}

/** Who a bearer token belongs to, or null. Also marks the device as alive. */
export function identify(db: Db, token: string): DeviceIdentity | null {
  const row = db.prepare(
    `SELECT d.id, d.user_id, d.property_id
       FROM app_devices d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = ? AND d.revoked_at IS NULL AND u.is_active = 1`
  ).get(hashToken(token)) as { id: string; user_id: string; property_id: string } | undefined;
  if (!row) return null;
  db.prepare('UPDATE app_devices SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { deviceId: row.id, userId: row.user_id, propertyId: row.property_id };
}

/**
 * Mark a phone as holding the stream open, or as having let go.
 *
 * This is the column the supervisor's screen actually depends on. "The app is installed"
 * is not the question — Android manufacturers, and Transsion in particular, kill
 * background services whatever permissions you grant. The question is whether this phone
 * would ring right now, and the only honest answer is whether it is connected this
 * second.
 */
export function setConnected(db: Db, deviceId: string, connected: boolean): void {
  const at = nowIso();
  db.prepare('UPDATE app_devices SET connected_at = ?, last_seen_at = ? WHERE id = ?')
    .run(connected ? at : null, at, deviceId);
}

/** Every connection dropped when the host restarts, so no row may claim otherwise. */
export function clearAllConnections(db: Db): void {
  db.prepare('UPDATE app_devices SET connected_at = NULL WHERE connected_at IS NOT NULL').run();
}

export interface DeviceRow {
  id: string; name: string; platform: string; app_version: string | null;
  created_at: string; last_seen_at: string | null; connected_at: string | null;
  user_id: string; display_name: string; username: string;
}

export function listForProperty(db: Db, propertyId: string): DeviceRow[] {
  return db.prepare(
    `SELECT d.id, d.name, d.platform, d.app_version, d.created_at, d.last_seen_at,
            d.connected_at, d.user_id, u.display_name, u.username
       FROM app_devices d JOIN users u ON u.id = d.user_id
      WHERE d.property_id = ? AND d.revoked_at IS NULL
      ORDER BY u.display_name, d.created_at`
  ).all(propertyId) as DeviceRow[];
}

export function listForUser(db: Db, userId: string): DeviceRow[] {
  return db.prepare(
    `SELECT d.id, d.name, d.platform, d.app_version, d.created_at, d.last_seen_at,
            d.connected_at, d.user_id, u.display_name, u.username
       FROM app_devices d JOIN users u ON u.id = d.user_id
      WHERE d.user_id = ? AND d.revoked_at IS NULL ORDER BY d.created_at`
  ).all(userId) as DeviceRow[];
}

export function revoke(db: Db, propertyId: string, deviceId: string, by: string): boolean {
  const r = db.prepare(
    `UPDATE app_devices SET revoked_at = ?, revoked_by = ?
      WHERE id = ? AND property_id = ? AND revoked_at IS NULL`
  ).run(nowIso(), by, deviceId, propertyId);
  return r.changes > 0;
}

/** Housekeeping: spent and expired codes are litter after a day. */
export function prunePairingCodes(db: Db): number {
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  return db.prepare('DELETE FROM pairing_codes WHERE created_at < ?').run(cutoff).changes;
}
