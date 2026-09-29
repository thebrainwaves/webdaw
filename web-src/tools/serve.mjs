// Tiny static server. Usage: node tools/serve.mjs [dir=dist] [port=8080] [base=/]
// e.g. node tools/serve.mjs dist 8080 /daw/  -> simulates a GitHub Pages project subpath.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const [dir = 'dist', port = '8080', base = '/'] = process.argv.slice(2);
const root = path.resolve(dir);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.wav': 'audio/wav' };
http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (!u.startsWith(base)) { res.writeHead(302, { Location: base }); return res.end(); }
  u = u.slice(base.length); if (!u || u.endsWith('/')) u += 'index.html';
  const p = path.join(root, u);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
}).listen(+port, () => console.log(`Serving ${root} at http://localhost:${port}${base}`));
