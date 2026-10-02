import type { Db } from './db/connection.js';
import { ulid } from './lib/ids.js';
import { nowIso } from './lib/time.js';

export interface AuditEntry {
  propertyId: string;
  userId?: string | null;
  actorName?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  /**
   * Whether this happened on the property network or through the tunnel from outside it.
   * Defaults to 'lan' so every existing caller keeps working and nothing is mislabelled
   * as remote; the routes that know pass it explicitly.
   */
  origin?: 'lan' | 'remote';
}

/**
 * Every state change appends a row. Overwriting a status without an audit row is
 * how you lose the ability to answer "who changed this, and when".
 * The table has triggers that refuse UPDATE and DELETE.
 */
export function audit(db: Db, e: AuditEntry): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO audit_log (id, property_id, at, user_id, actor_name, action, entity_type, entity_id, before_json, after_json, ip, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, e.propertyId, nowIso(), e.userId ?? null, e.actorName ?? null,
    e.action, e.entityType, e.entityId ?? null,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    e.ip ?? null,
    e.origin ?? 'lan'
  );
  return id;
}

/** Strip anything that must never reach the audit trail in cleartext. */
export function redact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of ['password', 'password_hash', 'passwordHash', 'token']) delete out[k];
  return out as Partial<T>;
}
