import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { requireSignedIn } from '../auth/guard.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import * as attachments from '../services/attachments.js';
import { send } from './_helpers.js';

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Upload. Multipart rather than base64 JSON: a 4 MB photo becomes 5.4 MB of JSON,
   * and the office wifi is not fast.
   */
  app.post('/api/attachments', { preHandler: requireSignedIn() }, async (req, reply) => {
    const me = req.principal!;
    let entityType = '';
    let entityId = '';
    let filename = 'upload';
    let declaredMime = '';
    let data: Buffer | null = null;
    let note: string | undefined;

    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          const value = String(part.value);
          if (part.fieldname === 'entityType') entityType = value;
          else if (part.fieldname === 'entityId') entityId = value;
          else if (part.fieldname === 'note') note = value.slice(0, 300);
        } else {
          filename = part.filename || filename;
          declaredMime = part.mimetype;
          data = await part.toBuffer();
        }
      }
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({
          error: 'too_large',
          message: 'That file is too large. Photos are resized in the browser before upload.',
        });
      }
      throw err;
    }

    if (!data) return reply.code(400).send({ error: 'no_file', message: 'No file was sent.' });
    if (!entityType || !entityId) {
      return reply.code(400).send({ error: 'no_target', message: 'Say what the file belongs to.' });
    }

    return send(reply, () => {
      const perms = attachments.permsFor(entityType);
      if (!me.permissions.has(perms.write)) {
        throw new HttpError(403, 'forbidden',
          `Your role does not allow attaching files here (${perms.write}).`);
      }
      const saved = attachments.save(app.db, app.config, {
        propertyId: me.propertyId, userId: me.userId, entityType, entityId,
        filename, declaredMime, data: data!,
      });

      // A photo on a job is part of the job's story, so it appears in the history.
      if (entityType === 'work_order') {
        const wo = app.db.prepare('SELECT status FROM work_orders WHERE id = ? AND property_id = ?')
          .get(entityId, me.propertyId) as { status: string } | undefined;
        if (!wo) throw new HttpError(404, 'not_found', 'That job does not exist.');
        app.db.prepare(
          `INSERT INTO work_order_events (id, wo_id, at, actor_id, actor_name, event_type, from_status,
            to_status, note, meta_json) VALUES (?, ?, ?, ?, ?, 'photo', ?, ?, ?, ?)`
        ).run(ulid(), entityId, nowIso(), me.userId, me.displayName, wo.status, wo.status,
              note ?? saved.filename, JSON.stringify({ attachmentId: saved.id, bytes: saved.bytes }));
      }

      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'attachment.uploaded', entityType: 'attachment', entityId: saved.id,
        after: { on: `${entityType}:${entityId}`, bytes: saved.bytes, mime: saved.mime }, ip: req.ip,
      });
      return saved;
    }, 201);
  });

  app.get('/api/attachments', { preHandler: requireSignedIn() }, async (req, reply) => {
    const me = req.principal!;
    const q = req.query as { entityType?: string; entityId?: string };
    if (!q.entityType || !q.entityId) {
      return reply.code(400).send({ error: 'invalid', message: 'Give an entityType and entityId.' });
    }
    return send(reply, () => {
      const perms = attachments.permsFor(q.entityType!);
      if (!me.permissions.has(perms.read)) {
        throw new HttpError(403, 'forbidden', `Your role does not allow this (${perms.read}).`);
      }
      return {
        attachments: attachments.list(app.db, me.propertyId, q.entityType!, q.entityId!)
          .map(({ rel_path, ...rest }) => rest),
      };
    });
  });

  app.get('/api/attachments/:id', { preHandler: requireSignedIn() }, async (req, reply) => {
    const me = req.principal!;
    const { id } = req.params as { id: string };
    try {
      const row = attachments.get(app.db, me.propertyId, id);
      const perms = attachments.permsFor(row.entity_type);
      if (!me.permissions.has(perms.read)) {
        return reply.code(403).send({
          error: 'forbidden', message: `Your role does not allow this (${perms.read}).`,
        });
      }
      const abs = attachments.absolutePath(app.config, row);
      return reply
        .type(row.mime)
        .header('content-disposition', `inline; filename="${row.filename}"`)
        // Attachment bytes never change once written, so they can be cached hard.
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(fs.createReadStream(abs));
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.code(err.status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
