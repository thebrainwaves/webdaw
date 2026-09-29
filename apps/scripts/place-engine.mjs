// Copy the built native audio engine (engine/build/.../auduio-engine[.exe]) to src-tauri/binaries/ under the
// name Tauri's `externalBin` expects: auduio-engine-<target-triple>[.exe].
// Usage: node scripts/place-engine.mjs [target-triple ...]   (default: the host triple from `rustc -vV`)
// For a macOS universal build pass: universal-apple-darwin aarch64-apple-darwin x86_64-apple-darwin
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = process.platform === 'win32' ? '.exe' : '';
const candidates = ['Release', 'RelWithDebInfo', 'Debug'].map((c) => resolve(here, 'engine/build/auduio-engine_artefacts', c, 'auduio-engine' + exe));
const src = process.env.AUDUIO_ENGINE_BIN || candidates.find(existsSync);
if (!src) { console.error('No built engine found. Build it first: cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release && cmake --build engine/build --config Release'); process.exit(1); }
const triples = process.argv.slice(2).length ? process.argv.slice(2) : [execSync('rustc -vV').toString().match(/host: (\S+)/)[1]];
const outDir = resolve(here, 'src-tauri/binaries'); mkdirSync(outDir, { recursive: true });
for (const t of triples) {
  const dst = resolve(outDir, `auduio-engine-${t}${exe}`);
  copyFileSync(src, dst); if (!exe) chmodSync(dst, 0o755);
  console.log(`${src} -> ${dst}`);
}
