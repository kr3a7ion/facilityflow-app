import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { hashPassword } from '../auth/password.js';
import { PERMISSIONS, ROLES, ALL_CODES, ROLE_SCOPES } from '../auth/permissions.js';
import { audit } from '../audit.js';

const SetupBody = z.object({
  property: z.object({
    name: z.string().min(2).max(120),
    shortName: z.string().min(2).max(40),
    address: z.string().max(300).optional(),
    city: z.string().max(80).optional(),
    timezone: z.string().min(3).max(60).default('Africa/Lagos'),
    currency: z.string().length(3).default('NGN'),
  }),
  admin: z.object({
    displayName: z.string().min(2).max(80),
    username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i, 'letters, numbers, dot, dash or underscore'),
    password: z.string().min(10, 'at least 10 characters'),
  }),
});

/**
 * First-run wizard. Seeds the permission catalogue and the nine system roles, then
 * creates the property and its first administrator. Refuses once a property exists —
 * this endpoint must never be a way to mint a second admin.
 */
export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/setup/status', async () => {
    const row = app.db.prepare('SELECT COUNT(*) AS n FROM properties').get() as { n: number };
    return { needsSetup: row.n === 0 };
  });

  app.post('/api/setup', async (req, reply) => {
    const existing = app.db.prepare('SELECT COUNT(*) AS n FROM properties').get() as { n: number };
    if (existing.n > 0) {
      return reply.code(409).send({ error: 'already_set_up', message: 'This installation is already configured.' });
    }

    const parsed = SetupBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues });
    }
    const { property, admin } = parsed.data;
    const passwordHash = await hashPassword(admin.password);

    const result = app.db.transaction(() => {
      const at = nowIso();

      const insPerm = app.db.prepare(
        'INSERT OR IGNORE INTO permissions (code, module, description) VALUES (?, ?, ?)'
      );
      for (const p of PERMISSIONS) insPerm.run(p.code, p.module, p.description);

      const propertyId = ulid();
      app.db.prepare(
        `INSERT INTO properties (id, name, short_name, address, city, country, timezone, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'NG', ?, ?, ?, ?)`
      ).run(propertyId, property.name, property.shortName, property.address ?? null,
            property.city ?? null, property.timezone, property.currency, at, at);

      const insRole = app.db.prepare(
        'INSERT INTO roles (id, property_id, key, name, description, is_system, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
      );
      const insGrant = app.db.prepare(
        'INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope) VALUES (?, ?, ?)'
      );
      const roleIds: Record<string, string> = {};
      for (const role of ROLES) {
        const id = ulid();
        roleIds[role.key] = id;
        insRole.run(id, propertyId, role.key, role.name, role.description, at);
        const codes = role.permissions === '*' ? ALL_CODES : role.permissions;
        const scopes = ROLE_SCOPES[role.key] ?? {};
        for (const code of codes) insGrant.run(id, code, scopes[code] ?? 'all');
      }

      const userId = ulid();
      app.db.prepare(
        `INSERT INTO users (id, property_id, username, display_name, password_hash, role_id,
                            must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(userId, propertyId, admin.username.toLowerCase(), admin.displayName,
            passwordHash, roleIds['admin']!, at, at);

      // The root of the location tree, named after the property.
      //
      // Without it the first common-area job cannot be raised at all: a job must hang off
      // an asset, a location or an apartment, and on a fresh database there are none of
      // any kind. Everything else here is optional and can be added later; a site is not,
      // so it is created rather than left as a first task nobody knows they have.
      app.db.prepare(
        `INSERT INTO locations (id, property_id, parent_id, type, code, name, sort_order,
                                created_at, updated_at)
         VALUES (?, ?, NULL, 'site', 'SITE', ?, 0, ?, ?)`
      ).run(ulid(), propertyId, property.shortName, at, at);

      const insSetting = app.db.prepare(
        'INSERT INTO settings (property_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)'
      );
      insSetting.run(propertyId, 'sla_matrix', JSON.stringify(DEFAULT_SLA), at);
      insSetting.run(propertyId, 'trades', JSON.stringify(DEFAULT_TRADES), at);
      insSetting.run(propertyId, 'hold_reasons', JSON.stringify(DEFAULT_HOLD_REASONS), at);
      insSetting.run(propertyId, 'failure_causes', JSON.stringify(DEFAULT_FAILURE_CAUSES), at);
      insSetting.run(propertyId, 'fuel_variance_tolerance_pct', JSON.stringify(2), at);

      audit(app.db, {
        propertyId, userId, actorName: admin.displayName,
        action: 'setup.complete', entityType: 'property', entityId: propertyId,
        after: { name: property.name, admin: admin.username },
        ip: req.ip,
      });

      return { propertyId, userId, roles: Object.keys(roleIds).length };
    })();

    return reply.code(201).send({
      ok: true,
      propertyId: result.propertyId,
      rolesCreated: result.roles,
      permissionsSeeded: PERMISSIONS.length,
      message: 'FacilityFlow is configured. Sign in with the administrator account.',
    });
  });
}

/** Editable in Admin afterwards — never hard-coded in a handler. */
const DEFAULT_SLA = [
  { priority: 'P1', label: 'Emergency',  respondMinutes: 15,  resolveMinutes: 240,  escalateToRole: 'supervisor' },
  { priority: 'P2', label: 'Urgent',     respondMinutes: 60,  resolveMinutes: 1440, escalateToRole: 'supervisor' },
  { priority: 'P3', label: 'Routine',    respondMinutes: 240, resolveMinutes: 4320, escalateToRole: 'team_lead' },
  { priority: 'P4', label: 'Scheduled',  respondMinutes: 1440, resolveMinutes: 10080, escalateToRole: 'team_lead' },
];
const DEFAULT_TRADES = ['electrical', 'plumbing', 'hvac', 'carpentry', 'civil', 'mechanical', 'general', 'vendor'];
const DEFAULT_HOLD_REASONS = ['awaiting_parts', 'awaiting_access', 'awaiting_vendor', 'awaiting_approval'];
const DEFAULT_FAILURE_CAUSES = ['wear', 'misuse', 'power', 'age', 'installation', 'no_fault_found'];
