import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Db } from '../db/connection.js';
import type { Config } from '../config.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';

/**
 * Files live on disk beside the database; only the pointer lives in SQLite. Keeping
 * blobs out of the database is what lets the nightly backup finish in seconds.
 */
export const MAX_BYTES = 8 * 1024 * 1024;

const TYPES: Record<string, { ext: string; magic: number[][] }> = {
  'image/jpeg': { ext: 'jpg', magic: [[0xff, 0xd8, 0xff]] },
  'image/png':  { ext: 'png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  'image/webp': { ext: 'webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
  'application/pdf': { ext: 'pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
};

/**
 * Attachments inherit the permission of the thing they hang off. A photo on a job is
 * readable by whoever may read the job — there is no separate "can see photos" right
 * to get out of step with it.
 */
export const ENTITY_PERMS: Record<string, { read: string; write: string }> = {
  work_order:     { read: 'wo.read', write: 'wo.update' },
  fuel_delivery:  { read: 'fuel.read', write: 'fuel.delivery.create' },
  permit:         { read: 'permit.request', write: 'permit.request' },
  incident:       { read: 'incident.read', write: 'incident.report' },
  expense:        { read: 'finance.read', write: 'finance.expense.create' },
  purchase:       { read: 'finance.read', write: 'purchase.record' },
  apartment:      { read: 'apartment.read', write: 'apartment.manage' },
  asset:          { read: 'asset.read', write: 'asset.manage' },
  unit_inspection:{ read: 'apartment.read', write: 'apartment.manage' },
};

export function permsFor(entityType: string): { read: string; write: string } {
  const p = ENTITY_PERMS[entityType];
  if (!p) throw new HttpError(400, 'unknown_entity', `Files cannot be attached to "${entityType}".`);
  return p;
}

/** Never trust the declared content type: read the first bytes and check. */
export function sniff(buf: Buffer, declared: string): { mime: string; ext: string } {
  const entry = TYPES[declared];
  if (!entry) {
    throw new HttpError(415, 'unsupported_type',
      'Only JPEG, PNG, WebP images and PDFs can be attached.');
  }
  const ok = entry.magic.some((sig) => sig.every((b, i) => buf[i] === b));
  if (!ok) {
    throw new HttpError(415, 'content_mismatch',
      `That file is named as ${declared} but its contents are something else.`);
  }
  return { mime: declared, ext: entry.ext };
}

export interface SaveInput {
  propertyId: string; userId: string | null;
  entityType: string; entityId: string;
  filename: string; declaredMime: string; data: Buffer;
}

export function save(db: Db, config: Config, input: SaveInput) {
  if (input.data.length === 0) throw new HttpError(400, 'empty_file', 'That file is empty.');
  if (input.data.length > MAX_BYTES) {
    throw new HttpError(413, 'too_large',
      `Files must be under ${Math.round(MAX_BYTES / 1024 / 1024)} MB. ` +
      'Photos are resized in the browser before upload, so this usually means an unresized import.');
  }
  const { mime, ext } = sniff(input.data, input.declaredMime);

  const at = nowIso();
  const id = ulid();
  const rel = path.join(at.slice(0, 4), at.slice(5, 7), `${id}.${ext}`);
  const abs = path.join(config.attachmentsDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, input.data);

  const sha256 = createHash('sha256').update(input.data).digest('hex');
  db.prepare(
    `INSERT INTO attachments (id, property_id, entity_type, entity_id, filename, mime, bytes, sha256,
      rel_path, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.propertyId, input.entityType, input.entityId, safeName(input.filename), mime,
        input.data.length, sha256, rel, input.userId, at);

  return { id, filename: safeName(input.filename), mime, bytes: input.data.length, sha256, createdAt: at };
}

export interface AttachmentRow {
  id: string; entity_type: string; entity_id: string; filename: string; mime: string;
  bytes: number; rel_path: string; created_at: string; uploaded_by_name: string | null;
}

export function list(db: Db, propertyId: string, entityType: string, entityId: string): AttachmentRow[] {
  return db.prepare(
    `SELECT a.id, a.entity_type, a.entity_id, a.filename, a.mime, a.bytes, a.rel_path, a.created_at,
            u.display_name AS uploaded_by_name
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.property_id = ? AND a.entity_type = ? AND a.entity_id = ?
      ORDER BY a.created_at`
  ).all(propertyId, entityType, entityId) as AttachmentRow[];
}

export function get(db: Db, propertyId: string, id: string): AttachmentRow {
  const row = db.prepare(
    `SELECT id, entity_type, entity_id, filename, mime, bytes, rel_path, created_at, NULL AS uploaded_by_name
       FROM attachments WHERE id = ? AND property_id = ?`
  ).get(id, propertyId) as AttachmentRow | undefined;
  if (!row) throw new HttpError(404, 'not_found', 'That file does not exist.');
  return row;
}

export function absolutePath(config: Config, row: AttachmentRow): string {
  const abs = path.join(config.attachmentsDir, row.rel_path);
  // rel_path comes from our own writer, but never let a stored value escape the folder.
  if (!abs.startsWith(path.resolve(config.attachmentsDir) + path.sep)) {
    throw new HttpError(400, 'bad_path', 'That file path is not valid.');
  }
  if (!fs.existsSync(abs)) {
    throw new HttpError(410, 'file_missing',
      'The record exists but the file is not on disk. It may have been lost in a restore.');
  }
  return abs;
}

function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
}
