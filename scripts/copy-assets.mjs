// tsc does not copy .sql files; the migration runner needs them beside the compiled code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'apps/server/src/db/migrations');
const to = path.join(root, 'apps/server/dist/db/migrations');
fs.mkdirSync(to, { recursive: true });
fs.cpSync(from, to, { recursive: true });
console.log(`copied ${fs.readdirSync(to).length} migration(s) into dist`);
