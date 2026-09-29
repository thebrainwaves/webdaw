// Build: copy src/ -> dist/ and inject the precache list + content hash into the service worker.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = path.join(root, 'src'), dist = path.join(root, 'dist');
// Clean dist/ but PRESERVE its git repo (dist/.git is the GitHub Pages deploy repo) and any CNAME.
const KEEP = new Set(['.git', 'CNAME']);
fs.mkdirSync(dist, { recursive: true });
for (const f of fs.readdirSync(dist)) if (!KEEP.has(f)) fs.rmSync(path.join(dist, f), { recursive: true, force: true });
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : files.push(path.relative(src, p)); } })(src);
const hash = crypto.createHash('sha256');
for (const f of files.sort()) { fs.mkdirSync(path.dirname(path.join(dist, f)), { recursive: true }); fs.copyFileSync(path.join(src, f), path.join(dist, f)); if (f !== 'sw.js') hash.update(f).update(fs.readFileSync(path.join(src, f))); }
const version = hash.digest('hex').slice(0, 10);
const assets = ['./', ...files.filter((f) => f !== 'sw.js').map((f) => './' + f.split(path.sep).join('/'))];
let sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
sw = sw.replace(/const VERSION = .*\/\*VERSION\*\//, `const VERSION = '${version}';`).replace(/const ASSETS = .*\/\*ASSETS\*\//, `const ASSETS = ${JSON.stringify(assets)};`);
fs.writeFileSync(path.join(dist, 'sw.js'), sw);
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
console.log(`Built dist/ (${files.length + 1} files, version ${version})`);
