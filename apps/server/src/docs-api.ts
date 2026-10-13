/** `npm run docs:api`: rewrite docs/API.md from the routes the server registers. */
import fs from 'node:fs';
import path from 'node:path';
import { API_DOC, apiReference } from './apiReference.js';

// The probes would otherwise log a line each.
process.env.FF_LOG_LEVEL ??= 'warn';
fs.writeFileSync(API_DOC, await apiReference(), 'utf8');
console.log(`wrote ${path.relative(process.cwd(), API_DOC)}`);
