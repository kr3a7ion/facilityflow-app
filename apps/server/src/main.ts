import os from 'node:os';
import { loadConfig, lanAddresses } from './config.js';
import { openDb } from './db/connection.js';
import { migrate, appliedVersions } from './db/migrate.js';
import { applyPendingRestore } from './db/backup.js';
import { pruneSessions } from './auth/sessions.js';
import { clearAllConnections, prunePairingCodes } from './services/devices.js';
import { buildApp, APP_VERSION } from './app.js';
import { startScheduler } from './services/scheduler.js';
import { startHeartbeat } from './services/bus.js';
import { ensureCertificates } from './services/tls.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Before anything opens the database. A restore staged from the Admin screen is applied
  // here because swapping the file under a live WAL connection is not survivable.
  const restored = applyPendingRestore(config);
  if (restored) console.log(`[db] restored from a staged snapshot — the previous database was saved to backups/`);

  const db = openDb(config.dbPath);

  const ran = migrate(db);
  if (ran.length) console.log(`[db] applied migrations: ${ran.join(', ')}`);
  pruneSessions(db);
  // Every phone's connection died with the last process. A row still claiming to be
  // connected would tell a supervisor somebody is reachable who is not.
  clearAllConnections(db);
  prunePairingCodes(db);

  const app = await buildApp(db, config);

  /*
   * Binding to one interface is an advanced choice, and this is the trap in it: the
   * address it names is usually handed out by DHCP, so a new lease, a moved cable or a
   * roam to another access point leaves the server bound to an address this PC no longer
   * has. listen() then fails with EADDRNOTAVAIL at boot, the scheduled task exits, and
   * the department arrives to a system that is simply gone — with the reason in a log
   * nobody opens.
   *
   * So the narrowing is honoured only while it is real. If that address is not on this PC
   * any more, serve on everything and say so loudly: a host reachable from one network
   * too many is a smaller failure than a host reachable from none.
   */
  let host = config.host;
  if (host !== '0.0.0.0' && !lanAddresses().includes(host)) {
    console.log('');
    console.log(`  !! This host is set to answer only on ${host}, and that address is not on`);
    console.log('     this PC any more. Serving on every network instead so the department');
    console.log('     does not lose the system. Set it again from Admin > Host PC.');
    host = '0.0.0.0';
  }
  await app.listen({ port: config.port, host });

  /*
   * HTTPS, with a certificate this property signed for itself.
   *
   * A second server rather than a replacement. The department's phones, the paired app and
   * every bookmark in the building point at the HTTP address, and a system that moves out
   * from under them on an upgrade is a system that broke. Plain HTTP keeps working; HTTPS
   * is there for the devices that have the root installed, and it is what makes the
   * browser a secure context — which is the whole reason to want it.
   *
   * A failure here is reported and survived. A certificate problem must not be the reason
   * the department cannot raise a job.
   */
  let https: { server: Awaited<ReturnType<typeof buildApp>>; port: number } | null = null;
  let tlsNote = '';
  if (config.https) {
    try {
      const propertyName = (db.prepare('SELECT short_name FROM properties LIMIT 1')
        .get() as { short_name: string } | undefined)?.short_name ?? 'FacilityFlow';
      // Every address somebody might type, so the name on the certificate matches whatever
      // they actually open.
      const names = [...new Set([
        ...lanAddresses(), '127.0.0.1', 'localhost',
        os.hostname(), `${os.hostname()}.local`,
      ])];
      const tls = ensureCertificates(config.dataDir, propertyName, names);
      const secure = await buildApp(db, config, { key: tls.key, cert: tls.cert });
      await secure.listen({ port: config.httpsPort, host });
      https = { server: secure, port: config.httpsPort };
      tlsNote = `[tls] certificate ${tls.action}, good until ${tls.expiresAt.toDateString()}`;
    } catch (err) {
      tlsNote = `[tls] HTTPS could not start (${(err as Error).message}). `
        + 'The department is still served over HTTP.';
    }
  }
  if (tlsNote) console.log(tlsNote);

  const scheduler = startScheduler(db, { config, log: (m) => console.log(m) });
  // Keeps the live connections from being reaped by a router or a phone radio while the
  // department is quiet. An idle socket looks exactly like an abandoned one.
  const heartbeat = startHeartbeat();

  const setup = (db.prepare('SELECT COUNT(*) AS n FROM properties').get() as { n: number }).n > 0;
  console.log('');
  console.log(`  FacilityFlow ${APP_VERSION}  ·  schema ${appliedVersions(db).at(-1) ?? 'none'}`);
  console.log(`  database   ${config.dbPath}`);
  console.log(`  status     ${setup ? 'ready' : 'NOT SET UP — open the address below to configure'}`);
  console.log(`  serving on  ${host === '0.0.0.0' ? 'every network on this PC' : host + ' only'}`);
  console.log('  reachable at:');
  console.log(`    http://localhost:${config.port}`);
  for (const ni of Object.entries(os.networkInterfaces())) {
    for (const a of ni[1] ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (host !== '0.0.0.0' && a.address !== host) continue;
      // The adapter's name alongside the address, so somebody reading this on the PC can
      // tell the office network from a VirtualBox adapter without guessing.
      console.log(`    http://${a.address}:${config.port}   (${ni[0]})`);
    }
  }
  console.log('');

  const close = async (signal: string) => {
    console.log(`\n[${signal}] shutting down`);
    scheduler.stop();
    heartbeat.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));
}

main().catch((err) => {
  console.error('failed to start:', err);
  process.exit(1);
});
