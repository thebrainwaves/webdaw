// Manual screenshot img/plugins.png: the real web UI driving the real native engine with a real test plugin, but
// with every third-party product/vendor name replaced by neutral names on the way into the page (and back on the
// way out), so no third-party brand appears in the manual. Needs the engine binary and a test VST3 folder.
//   PORT=8783 node tools/manual-plugin-shot.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXE = process.env.AUDUIO_ENGINE || '/workspace/daw-apps/engine-rs/target/release/auduio-engine';
const VST3 = process.env.AUDUIO_TEST_VST3_DIR || '/workspace/tools/plugins/lib/vst3';
const PORT = +(process.env.PORT || 8783), BASE = '/daw/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// longest first; each neutral name is unique so the reverse mapping is exact
const MAP = [['Surge Synth Team', 'Auduio Test Lab'], ['Surge XT Effects', 'Test Effect'], ['Surge XT', 'Test Synth'], ['Surge', 'Test']];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const swap = (l, pairs) => pairs.reduce((a, [f, t]) => a.replace(new RegExp(esc(f), 'g'), t), l);
const inbound = (l) => swap(l, MAP), outbound = (l) => swap(l, MAP.map(([a, b]) => [b, a]));
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auduio-shot-plugins-'));
const eng = spawn(EXE, [], { env: { ...process.env, AUDUIO_ENGINE_DATA: data, AUDUIO_VST3_PATH: VST3 }, stdio: ['pipe', 'pipe', 'pipe'] });
let page = null, buf = '';
eng.stdout.on('data', (d) => { buf += d; let i; const out = [];
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) out.push(inbound(l)); }
  if (out.length && page) page.evaluate((ls) => { for (const l of ls) for (const cb of (window.__tauriL['engine://msg'] || [])) cb({ payload: l }); }, out).catch(() => {}); });
let code = 1, browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.DAW_BROWSER ? { executablePath: process.env.DAW_BROWSER } : {}), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('auduio.prefs')) localStorage.setItem('auduio.prefs', JSON.stringify({ guideDone: true, tutorialDone: true, phoneMode: 'off', seqOpen: false }));
    window.__tauriL = {}; window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke: (cmd, args) => window.__engineInvoke(cmd, JSON.stringify(args || {})) }, event: { listen: async (n, cb) => { (window.__tauriL[n] = window.__tauriL[n] || []).push(cb); return () => {}; } } };
  });
  page = await ctx.newPage();
  await page.exposeFunction('__engineInvoke', (cmd, args) => { const a = JSON.parse(args);
    if (cmd === 'engine_send') { eng.stdin.write(outbound(a.line) + '\n'); return null; }
    if (cmd === 'engine_status') return { running: true, found: true, path: 'auduio-engine' };
    throw new Error('unknown command ' + cmd); });
  await page.goto(`http://localhost:${PORT}${BASE}?nosw`);
  await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 });
  await page.waitForFunction(() => __daw.S.pluginApi && __daw.S.pluginApi.connected, null, { timeout: 20000 });
  await page.evaluate(() => document.querySelector('.br-sec[data-sec=plugins]').scrollIntoView());
  await page.locator('.br-sec[data-sec=plugins] button', { hasText: 'Scan' }).first().click();
  await page.waitForFunction(() => __daw.S.pluginApi.list.length >= 1 && !__daw.S.pluginApi.scanning, null, { timeout: 60000 });
  await page.locator('.br-sec[data-sec=plugins] .br-item', { hasText: /^Test Synth/ }).first().dblclick();
  await page.waitForFunction(() => document.querySelector('.device.plugin .pl-row'), null, { timeout: 60000 });
  await sleep(3500); // let the 'Added ...' toast fade
  await page.evaluate(() => { const s = document.querySelector('.br-sec[data-sec=plugins]'); s.scrollIntoView({ block: 'end' }); });
  const leak = await page.evaluate(() => (document.documentElement.outerHTML.match(/surge/ig) || []).length);
  if (leak) throw new Error(`third-party name still visible (${leak}x)`);
  await page.screenshot({ path: path.join(ROOT, 'docs/img/plugins.png') });
  console.log('wrote docs/img/plugins.png'); code = 0;
} catch (e) { console.error('plugin shot failed:', e.message); }
finally { if (browser) await browser.close(); server.kill(); eng.stdin.end(); setTimeout(() => eng.kill(), 2000).unref(); process.exit(code); }
