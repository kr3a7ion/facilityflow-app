import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { appliedVersions } from '../db/migrate.js';
import { certPaths } from '../services/tls.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The property's root certificate, for installing on a phone.
   *
   * Deliberately open: it is a public key, it is useless to anybody outside the building,
   * and the whole point is that somebody standing in a corridor can open it from a QR
   * code on the notice board before they have signed in to anything.
   *
   * Served as a download with the extension Android and iOS both recognise, because a
   * certificate that opens as text in a browser tab is a certificate nobody manages to
   * install.
   */
  app.get('/ca.crt', async (req, reply) => {
    const paths = certPaths(app.config.dataDir);
    if (!fs.existsSync(paths.caCert)) {
      return reply.code(404).send({
        error: 'no_certificate',
        message: 'This property has not generated a certificate yet. Turn on HTTPS under Admin → Host PC.',
      });
    }
    const pem = fs.readFileSync(paths.caCert, 'utf8');
    return reply
      .header('content-type', 'application/x-x509-ca-cert')
      .header('content-disposition', 'attachment; filename="facilityflow-root.crt"')
      .send(pem);
  });

  app.get('/api/health', async () => {
    const property = app.db.prepare('SELECT id, name, short_name, timezone FROM properties LIMIT 1').get() as
      { id: string; name: string; short_name: string; timezone: string } | undefined;
    return {
      ok: true,
      service: 'facilityflow',
      version: app.appVersion,
      schema: appliedVersions(app.db),
      setupComplete: !!property,
      property: property ? { name: property.name, shortName: property.short_name, timezone: property.timezone } : null,
      time: new Date().toISOString(),
    };
  });
}
