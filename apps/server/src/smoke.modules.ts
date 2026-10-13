/**
 * Phase 1-7 end-to-end checks. Runs against a throwaway database through the real
 * HTTP layer (fastify inject), so permissions, validation and business rules are all
 * exercised the way a client would hit them.
 *
 *   npm run smoke
 */
import fs from 'node:fs';
import { app, db, dir, failures, passed } from './smoke/modules/harness.js';

// Each chapter builds on what the ones before it set up, so they run one at a time, in order.
await import('./smoke/modules/01-setup.js');
await import('./smoke/modules/02-work-orders.js');
await import('./smoke/modules/03-plant-and-stores.js');
await import('./smoke/modules/04-records-and-admin.js');
await import('./smoke/modules/05-load.js');
await import('./smoke/modules/06-first-run.js');
await import('./smoke/modules/07-alerts.js');
await import('./smoke/modules/08-money-and-imports.js');
await import('./smoke/modules/09-remote.js');
await import('./smoke/modules/10-editing.js');
await import('./smoke/modules/11-scopes.js');

await app.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
console.log('Phases 1-7 are sound.\n');
