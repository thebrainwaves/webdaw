// Copy the built native audio engine to src-tauri/binaries/ under the name Tauri's `externalBin` expects:
// auduio-engine-<target-triple>[.exe].
//   AUDUIO_ENGINE_IMPL=rs    engine-rs (Rust, JUCE-free):  cargo build --release --manifest-path engine-rs/Cargo.toml
//   AUDUIO_ENGINE_IMPL=juce  engine (JUCE C++):            cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release && cmake --build engine/build --config Release
//   (unset: the Rust engine if it has been built, else the JUCE one). AUDUIO_ENGINE_BIN=/path overrides both.
// Usage: node scripts/place-engine.mjs [target-triple ...]   (default: the host triple from `rustc -vV`)
// For a macOS universal build pass: universal-apple-darwin aarch64-apple-darwin x86_64-apple-darwin
// (with the Rust engine, lipo the two per-arch builds into one file and pass it as AUDUIO_ENGINE_BIN).
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = process.platform === 'win32' ? '.exe' : '';
const host = execSync('rustc -vV').toString().match(/host: (\S+)/)[1];
const triples = process.argv.slice(2).length ? process.argv.slice(2) : [host];
const rs = [resolve(here, 'engine-rs/target/release', 'auduio-engine' + exe), resolve(here, 'engine-rs/target', host, 'release', 'auduio-engine' + exe)];
const juce = ['Release', 'RelWithDebInfo', 'Debug'].map((c) => resolve(here, 'engine/build/auduio-engine_artefacts', c, 'auduio-engine' + exe));
const impl = (process.env.AUDUIO_ENGINE_IMPL || '').toLowerCase();
const pick = impl === 'rs' ? rs : impl === 'juce' ? juce : [...rs, ...juce];
const src = process.env.AUDUIO_ENGINE_BIN || pick.find(existsSync);
if (!src) {
  console.error(`No built engine found (${impl || 'rs or juce'}). Build it first:\n  Rust: cargo build --release --manifest-path engine-rs/Cargo.toml\n  JUCE: cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release && cmake --build engine/build --config Release`);
  process.exit(1);
}
const outDir = resolve(here, 'src-tauri/binaries'); mkdirSync(outDir, { recursive: true });
for (const t of triples) {
  const dst = resolve(outDir, `auduio-engine-${t}${exe}`);
  copyFileSync(src, dst); if (!exe) chmodSync(dst, 0o755);
  console.log(`${src} -> ${dst}`);
}
