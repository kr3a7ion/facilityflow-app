import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { hashPassword } from '../auth/password.js';
import { requirePermission } from '../auth/guard.js';
import { ROLE_SCOPES } from '../auth/permissions.js';
import { revokeAllForUser } from '../auth/sessions.js';
import { audit, redact } from '../audit.js';
import { runBackup, stageRestore, pendingRestore, cancelRestore } from '../db/backup.js';
import { getSetting, setSetting } from '../services/settings.js';
import { hostStatus } from '../services/host.js';
import { networkView } from '../services/network.js';
import { writeHostFile, readHostFile, lanAddresses } from '../config.js';
import { monthOf, send, ctxOf } from './_helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import * as remote from '../services/remote.js';
import { certPaths, caFingerprint, expiryOf, namesOf } from '../services/tls.js';

const NewUser = z.object({
  displayName: z.string().min(2).max(80),
  username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i),
  password: z.string().min(10),
  roleKey: z.string().min(2).max(40),
  staffId: z.string().max(40).optional(),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/roles', { preHandler: requirePermission('admin.roles.manage') }, async (req) => {
    const me = req.principal!;
    const roles = app.db.prepare(
      `SELECT r.id, r.key, r.name, r.description, r.is_system,
              (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count,
              (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS user_count,
              -- Read off the real grants rather than the role's name, so a role somebody
              -- edited last month still describes itself correctly.
              (EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id
                        AND rp.permission_code = 'wo.complete')
               AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id
                            AND rp.permission_code = 'wo.read'
                            AND rp.scope IN ('own','team'))) AS does_jobs,
              (SELECT rp.scope FROM role_permissions rp WHERE rp.role_id = r.id
                        AND rp.permission_code = 'wo.read') AS job_scope,
              -- Whether this role sees money, and how far it sees requisitions. Shown
              -- under the dropdown where an account is created, because "can this person
              -- see what things cost" is a question asked at that moment and nowhere else.
              EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id
                       AND rp.permission_code = 'cost.read') AS sees_money,
              (SELECT rp.scope FROM role_permissions rp WHERE rp.role_id = r.id
                        AND rp.permission_code = 'requisition.read') AS requisition_scope
         FROM roles r WHERE r.property_id = ? ORDER BY r.key`
    ).all(me.propertyId);
    return { roles };
  });

  /**
   * A new role — blank, or a copy of one that is nearly right.
   *
   * Copying is the common case: "a security lead is a team lead who can also raise
   * emergencies" is one tick on top of an existing role, not sixty from nothing. Scopes
   * are copied with the grants, so a copy of Technician still sees only its own jobs.
   */
  app.post('/api/admin/roles', { preHandler: requirePermission('admin.roles.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().trim().min(2).max(60),
      description: z.string().trim().max(300).optional(),
      copyFrom: z.string().max(40).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!;
    const d = body.data;

    const nameTaken = app.db.prepare('SELECT 1 FROM roles WHERE property_id = ? AND lower(name) = lower(?)')
      .get(me.propertyId, d.name);
    if (nameTaken) return reply.code(409).send({ error: 'name_taken', message: `There is already a role called "${d.name}".` });

    let source: { id: string; name: string } | undefined;
    if (d.copyFrom) {
      source = app.db.prepare('SELECT id, name FROM roles WHERE id = ? AND property_id = ?')
        .get(d.copyFrom, me.propertyId) as { id: string; name: string } | undefined;
      if (!source) return reply.code(400).send({ error: 'unknown_role', message: 'The role to copy from does not exist.' });
    }

    // The key is what code and the seed refer to; it is derived once and never changes,
    // so renaming a role later cannot break anything that looks it up.
    const base = d.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'role';
    let key = base;
    for (let n = 2; app.db.prepare('SELECT 1 FROM roles WHERE property_id = ? AND key = ?').get(me.propertyId, key); n++) {
      key = `${base}_${n}`;
    }

    const id = ulid();
    app.db.transaction(() => {
      app.db.prepare(
        `INSERT INTO roles (id, property_id, key, name, description, is_system, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      ).run(id, me.propertyId, key, d.name, d.description || null, nowIso());
      if (source) {
        app.db.prepare(
          `INSERT INTO role_permissions (role_id, permission_code, scope)
           SELECT ?, permission_code, scope FROM role_permissions WHERE role_id = ?`
        ).run(id, source.id);
      }
    })();

    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'role.created', entityType: 'role', entityId: id,
      after: { key, name: d.name, copiedFrom: source?.name ?? null }, ip: req.ip,
    });
    return reply.code(201).send({ ok: true, id, key });
  });

  /** Rename a role or rewrite its sentence. The key stays put. */
  app.patch('/api/admin/roles/:id', { preHandler: requirePermission('admin.roles.manage') }, async (req, reply) => {
    const body = z.object({
      name: z.string().trim().min(2).max(60).optional(),
      description: z.string().trim().max(300).nullable().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const me = req.principal!;
    const { id } = req.params as { id: string };
    const role = app.db.prepare('SELECT key, name, description FROM roles WHERE id = ? AND property_id = ?')
      .get(id, me.propertyId) as { key: string; name: string; description: string | null } | undefined;
    if (!role) return reply.code(404).send({ error: 'not_found', message: 'That role does not exist.' });
    if (role.key === 'admin') {
      return reply.code(409).send({ error: 'admin_locked', message: 'The administrator role cannot be edited.' });
    }
    const d = body.data;
    if (d.name && d.name.toLowerCase() !== role.name.toLowerCase()) {
      const taken = app.db.prepare(
        'SELECT 1 FROM roles WHERE property_id = ? AND lower(name) = lower(?) AND id <> ?'
      ).get(me.propertyId, d.name, id);
      if (taken) return reply.code(409).send({ error: 'name_taken', message: `There is already a role called "${d.name}".` });
    }
    const next = {
      name: d.name ?? role.name,
      description: d.description === undefined ? role.description : (d.description || null),
    };
    app.db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?')
      .run(next.name, next.description, id);
    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'role.updated', entityType: 'role', entityId: id,
      before: { name: role.name, description: role.description }, after: next, ip: req.ip,
    });
    return { ok: true, id };
  });

  app.get('/api/admin/permissions', { preHandler: requirePermission('admin.roles.manage') }, async () => {
    const permissions = app.db.prepare('SELECT code, module, description FROM permissions ORDER BY module, code').all();
    return { permissions };
  });

  app.get('/api/admin/users', { preHandler: requirePermission('admin.users.manage') }, async (req) => {
    const me = req.principal!;
    // The role's real name travels with it. Sending only the key made the client
    // title-case it, and "hod" came out as "Hod" — a label nobody could read.
    // staff_id comes too: an operational account linked to nobody has an empty job
    // board, and the screen has to be able to say so. does_jobs is what decides whether
    // that silence is a fault — a finance officer is never assigned a job, so an unlinked
    // finance account is correct, while an unlinked technician is broken.
    const users = app.db.prepare(
      `SELECT u.id, u.username, u.display_name, r.key AS role, r.name AS role_name,
              r.description AS role_description, u.is_active,
              u.must_change_password, u.last_login_at, u.locked_until, u.created_at,
              u.staff_id, s.first_name || ' ' || s.last_name AS staff_name,
              -- Two conditions, not one. Holding wo.complete alone catches the
              -- administrator, who holds every permission by definition and is nobody's
              -- technician; it is the narrowed wo.read that says this account was meant
              -- to open on its own board.
              (EXISTS (SELECT 1 FROM role_permissions rp
                        WHERE rp.role_id = u.role_id AND rp.permission_code = 'wo.complete')
               AND EXISTS (SELECT 1 FROM role_permissions rp
                            WHERE rp.role_id = u.role_id AND rp.permission_code = 'wo.read'
                              AND rp.scope IN ('own','team')))
                AS does_jobs
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN staff s ON s.id = u.staff_id AND s.is_active = 1
        WHERE u.property_id = ? ORDER BY u.display_name`
    ).all(me.propertyId);
    return { users };
  });

  app.post('/api/admin/users', { preHandler: requirePermission('admin.users.manage') }, async (req, reply) => {
    const me = req.principal!;
    const parsed = NewUser.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    const body = parsed.data;

    const role = app.db.prepare('SELECT id FROM roles WHERE property_id = ? AND key = ?')
      .get(me.propertyId, body.roleKey) as { id: string } | undefined;
    if (!role) return reply.code(400).send({ error: 'unknown_role', message: `No role named "${body.roleKey}".` });

    const taken = app.db.prepare('SELECT 1 FROM users WHERE property_id = ? AND username = ?')
      .get(me.propertyId, body.username.toLowerCase());
    if (taken) return reply.code(409).send({ error: 'username_taken', message: 'That username is already in use.' });

    const digest = await hashPassword(body.password);
    const id = ulid();
    const at = nowIso();
    app.db.prepare(
      `INSERT INTO users (id, property_id, staff_id, username, display_name, password_hash, role_id,
                          must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, me.propertyId, body.staffId ?? null, body.username.toLowerCase(),
          body.displayName, digest, role.id, at, at);

    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'user.created', entityType: 'user', entityId: id,
      after: redact({ username: body.username, role: body.roleKey, displayName: body.displayName }),
      ip: req.ip,
    });

    return reply.code(201).send({ ok: true, id, mustChangePassword: true });
  });

  app.post('/api/admin/users/:id/disable', { preHandler: requirePermission('admin.users.manage') }, async (req, reply) => {
    const me = req.principal!;
    const { id } = req.params as { id: string };
    if (id === me.userId) {
      return reply.code(400).send({ error: 'self_disable', message: 'You cannot disable your own account.' });
    }
    const r = app.db.prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ? AND property_id = ?')
      .run(nowIso(), id, me.propertyId);
    if (r.changes === 0) return reply.code(404).send({ error: 'not_found' });

    const revoked = revokeAllForUser(app.db, id);
    audit(app.db, {
      propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
      action: 'user.disabled', entityType: 'user', entityId: id,
      after: { sessionsRevoked: revoked }, ip: req.ip,
    });
    return { ok: true, sessionsRevoked: revoked };
  });

  // ---- the host PC itself ----------------------------------------------------
  app.get('/api/admin/host', { preHandler: requirePermission('admin.settings.manage') },
    async () => hostStatus(app.config, app.appVersion));

  /**
   * The property's own certificate: whether it is on, what it covers, and when it runs out.
   *
   * The fingerprint is here because it is the only thing that makes installing a root safe.
   * Somebody holding a phone compares six pairs of hex on the screen in front of them with
   * the ones on this screen; without that step they are installing whatever the network
   * handed them.
   */
  app.get('/api/admin/tls', { preHandler: requirePermission('admin.settings.manage') },
    async (req) => {
      const paths = certPaths(app.config.dataDir);
      const have = fs.existsSync(paths.caCert) && fs.existsSync(paths.hostCert);
      if (!have) {
        return {
          enabled: app.config.https, generated: false, httpsPort: app.config.httpsPort,
          addresses: lanAddresses(),
        };
      }
      const caPem = fs.readFileSync(paths.caCert, 'utf8');
      const hostPem = fs.readFileSync(paths.hostCert, 'utf8');
      const expires = expiryOf(hostPem);
      const covers = namesOf(hostPem);
      const live = lanAddresses();
      return {
        enabled: app.config.https,
        generated: true,
        httpsPort: app.config.httpsPort,
        fingerprint: caFingerprint(caPem),
        expiresAt: expires?.toISOString() ?? null,
        daysLeft: expires ? Math.round((expires.getTime() - Date.now()) / 86_400_000) : null,
        covers,
        addresses: live,
        // The failure that looks like a broken system: this PC moved to an address the
        // certificate was not made for. Renewed automatically on the next restart, and
        // said out loud here so nobody debugs it from scratch.
        uncovered: live.filter((a: string) => !covers.includes(a)),
      };
    });

  app.post('/api/admin/host/https', { preHandler: requirePermission('admin.settings.manage') },
    async (req, reply) => {
      const body = z.object({
        enabled: z.boolean(),
        port: z.number().int().min(1024).max(65535).optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      const me = req.principal!;
      const saved = readHostFile(app.config.dataDir);
      writeHostFile(app.config.dataDir, {
        ...saved, https: body.data.enabled, httpsPort: body.data.port ?? saved.httpsPort,
      });
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: body.data.enabled ? 'host.https_on' : 'host.https_off',
        entityType: 'property', entityId: me.propertyId,
        after: { enabled: body.data.enabled, port: body.data.port ?? saved.httpsPort },
        ip: req.ip, origin: req.origin,
      });
      return {
        ok: true,
        // Same honesty as the port change: nothing is rebound under a running server.
        message: body.data.enabled
          ? 'HTTPS starts the next time the host restarts. The certificate is generated then, and plain HTTP keeps working either way.'
          : 'HTTPS stops the next time the host restarts. Nothing else changes.',
      };
    });

  /**
   * Change the port the host listens on, from the next start.
   *
   * Deliberately not applied live. Rebinding under a running server would kill the
   * request that asked for it and every other device mid-action, and the person who
   * pressed the button would be left on a dead page with no way to tell whether it
   * worked. Saving and saying plainly that a restart is needed is the honest version.
   */
  app.post('/api/admin/host/port', { preHandler: requirePermission('admin.settings.manage') },
    async (req, reply) => {
      const body = z.object({
        // Below 1024 needs privileges the host will not have; 4700 is the default.
        port: z.number().int().min(1024).max(65535),
      }).safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({
          error: 'invalid',
          message: 'Pick a port between 1024 and 65535. Anything lower needs administrator rights the server does not have.',
        });
      }
      const me = req.principal!;
      const next = body.data.port;
      const current = app.config.port;

      if (process.env.FF_PORT) {
        return reply.code(409).send({
          error: 'port_pinned',
          message: `This host was started with FF_PORT=${process.env.FF_PORT} set, which overrides the saved setting. ` +
                   'Change it where the server is started, or clear it and use this screen.',
        });
      }

      const before = readHostFile(app.config.dataDir);
      writeHostFile(app.config.dataDir, { ...before, port: next });
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'host.port.changed', entityType: 'host', entityId: 'config',
        before: { port: current }, after: { port: next }, ip: req.ip,
      });

      return reply.code(200).send({
        ok: true, port: next, current, restartRequired: next !== current,
        message: next === current
          ? `Saved. The host is already on ${next}.`
          : `Saved. The host stays on ${current} until it restarts, then moves to ${next}. ` +
            'Open the firewall for the new port before restarting, or the wifi loses it.',
      });
    });

  /**
   * Choose which network address the department is given.
   *
   * Two separate things, on purpose.
   *
   * `advertise` decides what the QR code and the join card show, and nothing else. It is
   * safe to get wrong: the worst case is a wrong line on a screen somebody corrects in
   * ten seconds.
   *
   * `bindTo` narrows what the server actually answers on, which is what a property wants
   * when the host PC can also see a guest network. It takes effect at the next restart,
   * and it is the one that can cost you the system — an address handed out by DHCP can
   * be gone by morning. The host refuses to die of it (it falls back to every interface
   * and says so on start-up), but a bind is still a promise about an address, so it is
   * only accepted for an address this PC actually has right now.
   */
  app.post('/api/admin/host/network', { preHandler: requirePermission('admin.settings.manage') },
    async (req, reply) => {
      const body = z.object({
        advertise: z.string().max(45).nullable().optional(),
        bindTo: z.string().max(45).nullable().optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });

      const me = req.principal!;
      const view = await networkView(null);
      const known = new Map(view.nics.map((n) => [n.address, n]));
      const d = body.data;

      if (d.advertise && !known.has(d.advertise)) {
        return reply.code(400).send({
          error: 'unknown_address',
          message: 'This PC has no such address. Reload the page — the networks may have changed since it was drawn.',
        });
      }
      if (d.bindTo) {
        const nic = known.get(d.bindTo);
        if (!nic) {
          return reply.code(400).send({
            error: 'unknown_address',
            message: 'This PC has no such address, so the host would fail to start on it.',
          });
        }
        if (!nic.usable) {
          return reply.code(409).send({
            error: 'unusable_address',
            message: `${nic.name} is not a network the department can reach. Answering only on it would make the system unreachable from every phone.`,
          });
        }
      }

      const before = readHostFile(app.config.dataDir);
      const next = { ...before };
      if (d.advertise !== undefined) {
        if (d.advertise === null) delete next.advertise; else next.advertise = d.advertise;
      }
      if (d.bindTo !== undefined) {
        if (d.bindTo === null) delete next.bindTo; else next.bindTo = d.bindTo;
      }
      writeHostFile(app.config.dataDir, next);

      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'host.network.changed', entityType: 'host', entityId: 'config',
        before: { advertise: before.advertise ?? null, bindTo: before.bindTo ?? null },
        after: { advertise: next.advertise ?? null, bindTo: next.bindTo ?? null },
        ip: req.ip,
      });

      const bindChanged = (before.bindTo ?? null) !== (next.bindTo ?? null);
      return {
        ok: true,
        advertise: next.advertise ?? null,
        bindTo: next.bindTo ?? null,
        restartRequired: bindChanged,
        message: bindChanged
          ? (next.bindTo
              ? `Saved. From the next restart this host answers only on ${next.bindTo}.`
              : 'Saved. From the next restart this host answers on every network again.')
          : 'Saved. This is the address the department will be given.',
      };
    });

  /**
   * Who can actually be reached.
   *
   * Gated on wo.assign rather than an admin permission: the person who needs this is the
   * supervisor about to hand somebody a P1 at two in the morning, not an administrator.
   *
   * It reports three different silences and does not conflate them. An account that has
   * never signed in on any device has nothing to report. One whose browser has not been
   * touched since it loaded is set to alert and cannot. One that was switched off was
   * switched off by somebody who was allowed to.
   */
  app.get('/api/admin/alerts', { preHandler: requirePermission('wo.assign') }, async (req) => {
    const me = req.principal!;
    const rows = app.db.prepare(
      `SELECT u.id, u.display_name, u.username, r.name AS role_name,
              EXISTS (SELECT 1 FROM role_permissions rp
                       WHERE rp.role_id = u.role_id AND rp.permission_code = 'alerts.silence')
                AS may_silence,
              (SELECT COUNT(*) FROM alert_state a WHERE a.user_id = u.id) AS devices,
              (SELECT COUNT(*) FROM alert_state a WHERE a.user_id = u.id AND a.sound_on = 1
                                                   AND a.audio_ready = 1) AS listening,
              (SELECT COUNT(*) FROM alert_state a WHERE a.user_id = u.id AND a.sound_on = 0) AS muted,
              (SELECT MAX(a.last_seen_at) FROM alert_state a WHERE a.user_id = u.id) AS last_seen,
              -- Paired phones, which are a different and much stronger signal than a
              -- browser tab: a phone holding the stream open will ring with the screen
              -- off, and one that has stopped holding it will not ring at all.
              (SELECT COUNT(*) FROM app_devices d
                WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS phones,
              (SELECT COUNT(*) FROM app_devices d
                WHERE d.user_id = u.id AND d.revoked_at IS NULL
                  AND d.connected_at IS NOT NULL) AS phones_live,
              (SELECT MAX(d.last_seen_at) FROM app_devices d
                WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS phone_last_seen
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.property_id = ? AND u.is_active = 1
        ORDER BY u.display_name`
    ).all(me.propertyId) as {
      id: string; display_name: string; username: string; role_name: string;
      may_silence: number; devices: number; listening: number; muted: number;
      last_seen: string | null;
      phones: number; phones_live: number; phone_last_seen: string | null;
    }[];

    return {
      people: rows.map((p) => ({
        ...p,
        /*
         * A paired phone outranks everything a browser can report.
         *
         * It rings with the screen off and the app in the background, which no browser on
         * this network can do — so if one is connected, this person is reachable whatever
         * their browser tabs are doing. If they have paired a phone and it is NOT
         * connected, that is the single most important line on this screen: the thing
         * that was supposed to wake them has been killed, most likely by the handset's
         * own battery manager, and nobody would otherwise know.
         */
        state: p.phones_live > 0 ? 'phone'
          : p.phones > 0 ? 'phone_offline'
            // Not "never signed in": an account that signed in before this existed, or on
            // a browser that could not store anything, has no device row either. What is
            // true in all those cases is only that nothing has reported.
            : p.devices === 0 ? 'unreported'
              : p.muted > 0 ? 'muted'
                : p.listening > 0 ? 'listening'
                  : 'not_ready',
      })),
    };
  });

  /**
   * The alert app's installer, served by the host itself.
   *
   * There is no Play Store on this network and no internet to reach one, so the APK is
   * dropped into the data folder and handed out from here. It gets backed up with
   * everything else, which means a department restoring onto a new PC restores the
   * installer too.
   *
   * Open to anybody signed in: a technician standing next to the notice board with a
   * QR code should not need an administrator to hand them a file.
   */
  app.get('/app.apk', async (req, reply) => {
    const file = path.join(app.config.dataDir, 'app.apk');
    if (!fs.existsSync(file)) {
      return reply.code(404).send({
        error: 'no_installer',
        message: 'No installer has been put on this host yet. Copy app.apk into the data folder.',
      });
    }
    const stat = fs.statSync(file);
    return reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-disposition', 'attachment; filename="FacilityFlowAlerts.apk"')
      .header('content-length', String(stat.size))
      .send(fs.createReadStream(file));
  });

  /** Whether there is one to hand out, for the Host PC screen. */
  app.get('/api/admin/installer', { preHandler: requirePermission('admin.settings.manage') },
    async () => {
      const file = path.join(app.config.dataDir, 'app.apk');
      if (!fs.existsSync(file)) return { present: false };
      const stat = fs.statSync(file);
      return { present: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
    });

  /**
   * The remote door.
   *
   * Reading it needs only the ability to see the Host PC screen; changing it is an
   * administrator's decision and is audited under its own action, because "who opened the
   * building to the internet, and when" is a question that should never need archaeology.
   */
  app.get('/api/admin/remote', { preHandler: requirePermission('admin.settings.manage') },
    async (req) => {
      const me = req.principal!;
      const st = remote.state(app.db, me.propertyId);
      return {
        ...st,
        // Who could actually use it, so turning it on is not a leap in the dark.
        allowed: app.db.prepare(
          `SELECT u.display_name, r.name AS role_name,
                  EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id
                           AND rp.permission_code = 'remote.write') AS may_change
             FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.property_id = ? AND u.is_active = 1
              AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id
                           AND rp.permission_code = 'remote.access')
            ORDER BY u.display_name`
        ).all(me.propertyId),
        // An account on its default password cannot sign in from outside at all; naming
        // them here is how somebody knows to fix it before they travel.
        blocked: app.db.prepare(
          `SELECT u.display_name FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.property_id = ? AND u.is_active = 1 AND u.must_change_password = 1
              AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id
                           AND rp.permission_code = 'remote.access')`
        ).all(me.propertyId),
        // Sessions open from outside right now.
        liveRemote: (app.db.prepare(
          `SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE u.property_id = ? AND s.origin = 'remote' AND s.revoked_at IS NULL
              AND s.expires_at > ?`
        ).get(me.propertyId, nowIso()) as { n: number }).n,
      };
    });

  app.patch('/api/admin/remote', { preHandler: requirePermission('admin.settings.manage') },
    async (req, reply) => {
      const body = z.object({
        enabled: z.boolean().optional(),
        publicHost: z.string().max(200).nullable().optional(),
        idleMinutes: z.number().int().optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      return send(reply, () => remote.setState(app.db, ctxOf(req), body.data));
    });

  app.get('/api/admin/audit', { preHandler: requirePermission('admin.audit.read') }, async (req) => {
    const me = req.principal!;
    const q = req.query as { limit?: string; entityType?: string; entityId?: string; month?: string };
    const limit = Math.min(Number(q.limit) || 100, 500);
    // The audit log is the fastest-growing table in the database and the one nobody
    // ever deletes from. A month at a time, always — asking for the trail of one
    // entity is the exception, and that one is already narrow.
    const period = monthOf(app, req);
    const rows = q.entityType
      ? app.db.prepare(
          `SELECT id, at, actor_name, action, entity_type, entity_id, ip FROM audit_log
            WHERE property_id = ? AND entity_type = ? AND (? IS NULL OR entity_id = ?)
            ORDER BY at DESC LIMIT ?`
        ).all(me.propertyId, q.entityType, q.entityId ?? null, q.entityId ?? null, limit)
      : app.db.prepare(
          `SELECT id, at, actor_name, action, entity_type, entity_id, ip FROM audit_log
            WHERE property_id = ? AND at >= ? AND at < ? ORDER BY at DESC LIMIT ?`
        ).all(me.propertyId, period.from, period.to, limit);
    return { entries: rows, limit, period: q.entityType ? null : period,
             truncated: rows.length === limit };
  });


  // ---- password reset --------------------------------------------------------
  /**
   * Change what somebody may do, or who they are on the floor.
   *
   * Separate from creating them because getting a role wrong at 5pm on the first day is
   * ordinary, and the alternative — delete and recreate — throws away their history and
   * every job that points at them.
   */
  app.patch('/api/admin/users/:id', { preHandler: requirePermission('admin.users.manage') },
    async (req, reply) => {
      const body = z.object({
        roleKey: z.string().min(2).max(40).optional(),
        staffId: z.string().max(40).nullable().optional(),
        displayName: z.string().min(2).max(80).optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
      const me = req.principal!;
      const id = (req.params as { id: string }).id;

      const user = app.db.prepare(
        `SELECT u.id, u.display_name, u.staff_id, r.key AS role
           FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.id = ? AND u.property_id = ?`
      ).get(id, me.propertyId) as
        { id: string; display_name: string; staff_id: string | null; role: string } | undefined;
      if (!user) return reply.code(404).send({ error: 'not_found', message: 'That account does not exist.' });

      const d = body.data;
      let roleId: string | null = null;
      if (d.roleKey && d.roleKey !== user.role) {
        // Locking yourself out of user management is a one-way door, and the person
        // doing it is always mid-thought about something else.
        if (user.id === me.userId) {
          return reply.code(409).send({
            error: 'own_role',
            message: 'You cannot change your own role. Ask another administrator, so nobody locks themselves out.',
          });
        }
        const role = app.db.prepare('SELECT id FROM roles WHERE property_id = ? AND key = ?')
          .get(me.propertyId, d.roleKey) as { id: string } | undefined;
        if (!role) return reply.code(400).send({ error: 'unknown_role', message: `No role named "${d.roleKey}".` });
        roleId = role.id;
      }

      if (d.staffId) {
        const staff = app.db.prepare('SELECT id FROM staff WHERE id = ? AND property_id = ?')
          .get(d.staffId, me.propertyId);
        if (!staff) return reply.code(400).send({ error: 'unknown_staff', message: 'That person is not on the staff list.' });
      }

      app.db.prepare(
        `UPDATE users SET role_id = COALESCE(?, role_id),
                          staff_id = CASE WHEN ? THEN ? ELSE staff_id END,
                          display_name = COALESCE(?, display_name),
                          updated_at = ?
          WHERE id = ?`
      ).run(roleId, d.staffId === undefined ? 0 : 1, d.staffId ?? null,
            d.displayName ?? null, nowIso(), id);

      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'user.updated', entityType: 'user', entityId: id,
        before: { role: user.role, staffId: user.staff_id },
        after: { role: d.roleKey ?? user.role, staffId: d.staffId === undefined ? user.staff_id : d.staffId },
        ip: req.ip,
      });
      return reply.code(200).send({ ok: true, id });
    });

  app.post('/api/admin/users/:id/reset-password', { preHandler: requirePermission('admin.users.manage') },
    async (req, reply) => {
      const me = req.principal!;
      const body = z.object({ password: z.string().min(10) }).safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid', message: 'A new password needs at least 10 characters.' });
      }
      const { id } = req.params as { id: string };
      const user = app.db.prepare('SELECT username FROM users WHERE id = ? AND property_id = ?')
        .get(id, me.propertyId) as { username: string } | undefined;
      if (!user) return reply.code(404).send({ error: 'not_found', message: 'That user does not exist.' });

      const digest = await hashPassword(body.data.password);
      const at = nowIso();
      app.db.prepare(
        `UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0,
          locked_until = NULL, updated_at = ? WHERE id = ?`
      ).run(digest, at, id);
      const revoked = revokeAllForUser(app.db, id);

      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'user.password.reset', entityType: 'user', entityId: id,
        after: { username: user.username, sessionsRevoked: revoked }, ip: req.ip,
      });
      return { ok: true, sessionsRevoked: revoked, mustChangePassword: true };
    });

  app.post('/api/admin/users/:id/enable', { preHandler: requirePermission('admin.users.manage') },
    async (req, reply) => {
      const me = req.principal!;
      const { id } = req.params as { id: string };
      const r = app.db.prepare(
        'UPDATE users SET is_active = 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ? AND property_id = ?'
      ).run(nowIso(), id, me.propertyId);
      if (!r.changes) return reply.code(404).send({ error: 'not_found' });
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'user.enabled', entityType: 'user', entityId: id, ip: req.ip,
      });
      return { ok: true };
    });

  // ---- role permissions ------------------------------------------------------
  app.get('/api/admin/roles/:id/permissions', { preHandler: requirePermission('admin.roles.manage') },
    async (req, reply) => {
      const me = req.principal!;
      const { id } = req.params as { id: string };
      const role = app.db.prepare('SELECT key, name FROM roles WHERE id = ? AND property_id = ?')
        .get(id, me.propertyId) as { key: string; name: string } | undefined;
      if (!role) return reply.code(404).send({ error: 'not_found', message: 'That role does not exist.' });
      return {
        role,
        granted: (app.db.prepare('SELECT permission_code, scope FROM role_permissions WHERE role_id = ?')
          .all(id) as { permission_code: string; scope: string }[]),
      };
    });

  /**
   * Editing a role changes what a whole group of people can do, so it is audited with
   * the before and after, and the admin role cannot be edited into uselessness.
   */
  app.post('/api/admin/roles/:id/permissions', { preHandler: requirePermission('admin.roles.manage') },
    async (req, reply) => {
      const me = req.principal!;
      const { id } = req.params as { id: string };
      const body = z.object({
        codes: z.array(z.string().max(60)).max(200),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });

      const role = app.db.prepare('SELECT key FROM roles WHERE id = ? AND property_id = ?')
        .get(id, me.propertyId) as { key: string } | undefined;
      if (!role) return reply.code(404).send({ error: 'not_found', message: 'That role does not exist.' });
      if (role.key === 'admin') {
        return reply.code(409).send({
          error: 'admin_locked',
          message: 'The administrator role always holds every permission and cannot be edited.',
        });
      }
      const known = new Set((app.db.prepare('SELECT code FROM permissions').all() as { code: string }[])
        .map((p) => p.code));
      const unknown = body.data.codes.filter((c) => !known.has(c));
      if (unknown.length) {
        return reply.code(400).send({
          error: 'unknown_permission', message: `Not a permission: ${unknown.slice(0, 3).join(', ')}`,
        });
      }

      const priorRows = app.db.prepare(
        'SELECT permission_code, scope FROM role_permissions WHERE role_id = ?'
      ).all(id) as { permission_code: string; scope: string }[];
      const before = priorRows.map((r) => r.permission_code);

      /*
       * Scope survives the edit.
       *
       * This screen sends a list of permission codes and nothing else, so rewriting the
       * grants from that list alone used to reset every scope to 'all'. Ticking one extra
       * box for technicians silently promoted every technician from "the jobs assigned to
       * me" to "every job on the property" — no warning, and an audit entry that recorded
       * only the code list, so the widening was invisible afterwards too.
       *
       * A code that is already granted keeps the scope it has. A newly added code takes
       * the scope this role was designed with, and only falls back to 'all' when the role
       * has no narrower design for it.
       */
      const held = new Map(priorRows.map((r) => [r.permission_code, r.scope]));
      const designed: Record<string, string> = ROLE_SCOPES[role.key] ?? {};
      const scopeFor = (code: string): string => held.get(code) ?? designed[code] ?? 'all';

      const widened = body.data.codes.filter((c) => held.has(c) && held.get(c) !== scopeFor(c));

      app.db.transaction(() => {
        app.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
        const ins = app.db.prepare(
          'INSERT INTO role_permissions (role_id, permission_code, scope) VALUES (?, ?, ?)'
        );
        for (const code of new Set(body.data.codes)) ins.run(id, code, scopeFor(code));
        audit(app.db, {
          propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
          action: 'role.permissions.changed', entityType: 'role', entityId: id,
          // Scopes go in the record too. "gained wo.read" and "gained wo.read over the
          // whole property" are different events and the log has to be able to tell them
          // apart a year later.
          before: { count: before.length, codes: before,
                    scopes: Object.fromEntries(held) },
          after: { count: body.data.codes.length, codes: body.data.codes,
                   scopes: Object.fromEntries(body.data.codes.map((c) => [c, scopeFor(c)])) },
          ip: req.ip,
        });
      })();
      return { ok: true, granted: body.data.codes.length, widened };
    });

  // ---- settings --------------------------------------------------------------
  const EDITABLE = ['sla_matrix', 'trades', 'hold_reasons', 'failure_causes',
                    'fuel_variance_tolerance_pct'] as const;

  app.get('/api/admin/settings', { preHandler: requirePermission('admin.settings.manage') }, async (req) => {
    const me = req.principal!;
    const out: Record<string, unknown> = {};
    for (const key of EDITABLE) out[key] = getSetting(app.db, me.propertyId, key, null);
    return { settings: out, editable: EDITABLE };
  });

  app.post('/api/admin/settings', { preHandler: requirePermission('admin.settings.manage') },
    async (req, reply) => {
      const me = req.principal!;
      const body = z.object({ key: z.enum(EDITABLE), value: z.unknown() }).safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({
          error: 'invalid', message: `Editable settings are: ${EDITABLE.join(', ')}.`,
        });
      }
      // The SLA matrix drives every deadline in the system; a malformed one would
      // quietly stop jobs getting due dates.
      if (body.data.key === 'sla_matrix') {
        const shape = z.array(z.object({
          priority: z.enum(['P1', 'P2', 'P3', 'P4']),
          label: z.string().min(1).max(40),
          respondMinutes: z.number().int().positive().max(100000),
          resolveMinutes: z.number().int().positive().max(1000000),
          escalateToRole: z.string().min(2).max(40),
        })).length(4).safeParse(body.data.value);
        if (!shape.success) {
          return reply.code(400).send({
            error: 'invalid_sla',
            message: 'The SLA matrix needs one row for each of P1 to P4, with response and resolve minutes.',
          });
        }
      }
      const before = getSetting(app.db, me.propertyId, body.data.key, null);
      setSetting(app.db, me.propertyId, body.data.key, body.data.value, nowIso(), me.userId ?? undefined);
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'settings.changed', entityType: 'setting', entityId: body.data.key,
        before, after: body.data.value, ip: req.ip,
      });
      return { ok: true };
    });

  // ---- backups ---------------------------------------------------------------
  app.get('/api/admin/backups', { preHandler: requirePermission('admin.backup.run') }, async () => {
    const dir = app.config.backupsDir;
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse().slice(0, 30)
      : [];
    return {
      directory: dir,
      keep: app.config.backupKeep,
      backups: files.map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, bytes: st.size, at: st.mtime.toISOString() };
      }),
      pending: pendingRestore(app.config) ? true : false,
      note: 'A backup is only a backup once you have restored it. Download one and keep it '
          + 'somewhere other than this PC — a snapshot on the same disk does not survive a dead machine.',
    };
  });

  /**
   * Getting a backup OFF this PC. A nightly snapshot sitting on the same disk as the
   * database survives a mistake but not a dead machine, a theft or a fire, and that is
   * the case the department actually needs to survive.
   */
  app.get('/api/admin/backups/:file', { preHandler: requirePermission('admin.backup.run') },
    async (req, reply) => {
      const me = req.principal!;
      // The name is from a request: basename, then prove it resolves inside the folder.
      const name = path.basename((req.params as { file: string }).file);
      const full = path.join(app.config.backupsDir, name);
      if (path.dirname(path.resolve(full)) !== path.resolve(app.config.backupsDir)
          || !name.endsWith('.db') || !fs.existsSync(full)) {
        return reply.code(404).send({ error: 'not_found', message: `No backup called "${name}".` });
      }
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'backup.downloaded', entityType: 'backup', entityId: name, ip: req.ip,
      });
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${name}"`)
        .header('cache-control', 'no-store')
        .send(fs.createReadStream(full));
    });

  /**
   * Staging a restore. Deliberately two steps and a restart: this replaces every record
   * the department has, so it should not be one mis-aimed click.
   */
  app.post('/api/admin/restore', { preHandler: requirePermission('admin.backup.run') },
    async (req, reply) => {
      const body = z.object({
        file: z.string().min(1),
        confirm: z.literal('RESTORE'),
      }).safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({
          error: 'confirm_required',
          message: 'Restoring replaces the live database. Type RESTORE to confirm.',
        });
      }
      const me = req.principal!;
      try {
        const staged = stageRestore(app.config, body.data.file);
        audit(app.db, {
          propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
          action: 'restore.staged', entityType: 'backup', entityId: staged.from,
          after: { safetyCopy: staged.safetyCopy }, ip: req.ip,
        });
        return reply.code(201).send({
          ok: true, ...staged,
          message: 'Staged. Restart the server and it will come up on this snapshot. '
                 + `The database as it stands now was saved to ${staged.safetyCopy}.`,
        });
      } catch (err) {
        return reply.code(400).send({
          error: 'restore_refused',
          message: err instanceof Error ? err.message : 'That snapshot could not be staged.',
        });
      }
    });

  app.delete('/api/admin/restore', { preHandler: requirePermission('admin.backup.run') },
    async (req) => {
      const me = req.principal!;
      const cancelled = cancelRestore(app.config);
      if (cancelled) {
        audit(app.db, {
          propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
          action: 'restore.cancelled', entityType: 'backup', entityId: null, ip: req.ip,
        });
      }
      return { ok: true, cancelled };
    });

  app.post('/api/admin/backup', { preHandler: requirePermission('admin.backup.run') }, async (req, reply) => {
    const me = req.principal!;
    try {
      const r = runBackup(app.db, app.config);
      audit(app.db, {
        propertyId: me.propertyId, userId: me.userId, actorName: me.displayName,
        action: 'backup.run', entityType: 'backup', entityId: r.file,
        after: { bytes: r.bytes, integrity: r.integrity, pruned: r.pruned.length }, ip: req.ip,
      });
      return { ok: true, file: r.file, bytes: r.bytes, integrity: r.integrity, pruned: r.pruned.length };
    } catch (err) {
      req.log.error({ err }, 'backup failed');
      return reply.code(500).send({
        error: 'backup_failed',
        message: 'The backup could not be completed. Check free disk space on the host, then try again.',
      });
    }
  });
}
