// Moves dist/cjs/index.js -> dist/index.cjs so the package can be required
// from CommonJS (NestJS) and imported from ESM (Vite) alike.
import { renameSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dist', 'cjs', 'index.js');
const dst = join(root, 'dist', 'index.cjs');
if (existsSync(src)) {
  renameSync(src, dst);
  rmSync(join(root, 'dist', 'cjs'), { recursive: true, force: true });
}
