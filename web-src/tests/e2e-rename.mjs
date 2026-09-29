// v0.3.1 rename WebDAW -> Auduio: visible name everywhere, new export extension, old files still import,
// projects saved under the old IndexedDB name and old settings keys are migrated. Run: node tests/e2e-rename.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8771), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 600) : ''}`); };
const shots = path.join(ROOT, 'screenshots', 'v3'); fs.mkdirSync(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(shots, name + '.png') });
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ headless: true, ...(process.env.DAW_BROWSER ? { executablePath: process.env.DAW_BROWSER } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const errors = [];
async function newPage(opts = {}, prefs = { guideDone: true, tutorialDone: true, phoneMode: 'off' }) {
  const ctx = await browser.newContext({ permissions: ['microphone'], ...opts });
  await ctx.addInitScript((prefs) => { if (prefs && !localStorage.getItem('webdaw.prefs')) localStorage.setItem('webdaw.prefs', JSON.stringify(prefs)); }, prefs);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Refused to execute inline script|Executing inline script violates/.test(m.text())) errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return { ctx, page };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Emoji / pictograph detector used on the rendered DOM: Unicode Extended_Pictographic plus the symbol blocks
// that were used as icons before (geometric shapes, dingbats, misc technical, arrows except plain → and ←).
const SCAN = `(() => {
  const re = /[\\p{Extended_Pictographic}\\u{1F000}-\\u{1FAFF}\\u2600-\\u27BF\\u25A0-\\u25FF\\u2300-\\u23FF\\u2193-\\u21FF\\uFF0B\\uFE0F]/u;
  const hits = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = walk.nextNode())) { if (re.test(n.nodeValue)) hits.push('text:' + n.nodeValue.trim().slice(0, 40)); }
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],option,optgroup')) for (const a of ['title', 'aria-label', 'placeholder', 'label']) { const v = el.getAttribute(a); if (v && re.test(v)) hits.push(a + ':' + v.slice(0, 40)); }
  for (const el of document.querySelectorAll('body *')) { for (const pe of ['::before', '::after']) { const c = getComputedStyle(el, pe).content; if (c && c !== 'none' && c !== 'normal' && re.test(c)) hits.push('css' + pe + ':' + c); } }
  const t = document.title; if (re.test(t)) hits.push('title:' + t);
  return [...new Set(hits)];
})()`;
const MK = `window.__mkBuf = (id, secs) => { const { engine } = __daw; const sr = engine.ctx.sampleRate; const b = engine.ctx.createBuffer(2, Math.round(sr * secs), sr);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = Math.exp(-(t % 0.5) * 6) * 0.7 * Math.sin(2 * Math.PI * 220 * t); } } engine.buffers.set(id, b); return b; };`;



try {
  const { ctx, page } = await newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(URL_);
  const vis = await page.evaluate(() => ({ title: document.title, h1: document.querySelector('#startOverlay h1') && document.querySelector('#startOverlay h1').textContent, apple: document.querySelector('meta[name="apple-mobile-web-app-title"]').content, text: document.body.innerText }));
  const man = await (await page.request.get(`http://localhost:${PORT}${BASE}manifest.webmanifest`)).json();
  ok('Visible name is Auduio (page title, start screen, iOS title, manifest name/short_name); no "WebDAW" text in the UI', vis.title === 'Auduio' && vis.h1 === 'Auduio' && vis.apple === 'Auduio' && man.name === 'Auduio' && man.short_name === 'Auduio' && !/WebDAW/.test(vis.text), JSON.stringify({ ...vis, text: undefined, man: [man.name, man.short_name] }));
  await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(300);
  const txt = await page.evaluate(() => document.body.innerText);
  const proj = await page.evaluate(() => JSON.stringify({ ...__daw.S.project, id: 'p_oldsong', name: 'Old Song From WebDAW' }));
  // export uses the new extension
  await page.click('#btnMenu'); await sleep(150);
  const exportBtn = await page.evaluate(() => { const b = [...document.querySelectorAll('#menu button')].find((x) => /Export project|Save as file|Export/i.test(x.textContent)); return b ? b.textContent : null; });
  let fname = null;
  if (exportBtn) { const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.evaluate((t) => [...document.querySelectorAll('#menu button')].find((x) => x.textContent === t).click(), exportBtn)]); fname = dl && dl.suggestedFilename(); if (dl) await dl.saveAs(path.join(ROOT, 'tests', 'exported-test.auduio.zip')); }
  ok('New project exports use the .auduio.zip extension', /\.auduio\.zip$/.test(fname || ''), JSON.stringify({ exportBtn, fname }));
  // old .webdaw.zip files still import
  const oldZip = path.join(ROOT, 'tests', 'exported-test.webdaw.zip');
  await page.setInputFiles('#fileProject', oldZip); await sleep(1500);
  const imported = await page.evaluate(() => ({ name: __daw.S.project.name, tracks: __daw.S.project.tracks.length }));
  ok('Old .webdaw.zip project files still import', fs.existsSync(oldZip) && imported.tracks > 0, JSON.stringify(imported));
  ok('No "WebDAW" text in the running app UI', !/WebDAW/.test(txt), '');
  await page.evaluate(() => __daw.engine.stop());
  // ---- simulate a user of the old version: data only under the old DB name + old settings keys
  await page.goto(`http://localhost:${PORT}${BASE}manifest.webmanifest`);
  const seeded = await page.evaluate(async (projJson) => {
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => res('blocked'); });
    await req(indexedDB.deleteDatabase('auduio')); await req(indexedDB.deleteDatabase('webdaw'));
    const open = indexedDB.open('webdaw', 1);
    open.onupgradeneeded = () => { const db = open.result; db.createObjectStore('projects', { keyPath: 'id' }); db.createObjectStore('buffers', { keyPath: 'id' }); db.createObjectStore('meta', { keyPath: 'key' }); };
    const db = await req(open);
    const t = db.transaction(['projects', 'meta'], 'readwrite'); t.objectStore('projects').put(JSON.parse(projJson)); t.objectStore('meta').put({ key: 'lastProject', value: 'p_oldsong' });
    await new Promise((r) => { t.oncomplete = r; }); db.close();
    localStorage.clear(); localStorage.setItem('webdaw.prefs', JSON.stringify({ guideDone: true, tutorialDone: true, phoneMode: 'off', laneH: 140 })); localStorage.setItem('webdaw.rackPresets', JSON.stringify({ OldRack: { chains: [] } }));
    return (await indexedDB.databases()).map((d) => d.name);
  }, proj);
  await page.goto(URL_); await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(500);
  const after = await page.evaluate(async () => ({ name: __daw.S.project.name, dbs: (await indexedDB.databases()).map((d) => d.name).sort(), prefs: JSON.parse(localStorage.getItem('auduio.prefs') || '{}').laneH, rack: !!JSON.parse(localStorage.getItem('auduio.rackPresets') || '{}').OldRack, oldKept: !!localStorage.getItem('webdaw.prefs') }));
  const oldStill = await page.evaluate(async () => { const r = indexedDB.open('webdaw'); const db = await new Promise((res) => { r.onsuccess = () => res(r.result); }); const n = await new Promise((res) => { const q = db.transaction('projects').objectStore('projects').count(); q.onsuccess = () => res(q.result); }); db.close(); return n; });
  ok('Projects saved by WebDAW (old IndexedDB name) are migrated and open in Auduio; the old database is kept', after.name === 'Old Song From WebDAW' && after.dbs.includes('auduio') && oldStill === 1, JSON.stringify({ seeded, after, oldStill }));
  ok('Settings saved under the old keys (prefs, rack presets) carry over; old keys are kept', after.prefs === 140 && after.rack && after.oldKept, JSON.stringify(after));
  await ctx.close();
} catch (e) { ok('rename test run completed without exception', false, e.stack); }
const relevant = errors.filter((e) => !/favicon/i.test(e));
ok('No console errors / page errors (rename run)', relevant.length === 0, relevant.join('\n'));
await browser.close(); server.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} rename checks passed`);
fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-rename.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
