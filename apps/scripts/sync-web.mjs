// Build the WebDAW web app and copy its dist/ (without .git) into ./web for the native shells.
// Usage: node scripts/sync-web.mjs [path-to-webdaw-source]   (default: ../daw or $WEBDAW_SRC)
import { execSync } from 'node:child_process';
import { cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const src = resolve(process.argv[2] || process.env.WEBDAW_SRC || resolve(here, '../daw'));
const dist = resolve(src, 'dist'), out = resolve(here, 'web');
if (existsSync(resolve(src, 'tools/build.mjs'))) execSync('node tools/build.mjs', { cwd: src, stdio: 'inherit' });
if (!existsSync(resolve(dist, 'index.html'))) { console.error('No built web app at ' + dist); process.exit(1); }
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
cpSync(dist, out, { recursive: true, filter: (p) => basename(p) !== '.git' && basename(p) !== 'CNAME' });
console.log('Synced ' + dist + ' -> ' + out);
