// v0.4 plugin hosting: the real web UI (headless Chromium) driving the real native engine (auduio-engine, JUCE)
// with a real VST3 (Surge XT, GPL). The page gets a stand-in for the Tauri bridge (window.__TAURI__) that
// forwards `engine_send` to the engine's stdin and engine stdout lines back as `engine://msg` events, i.e.
// exactly what apps/src-tauri/src/lib.rs does in the desktop app. Skips (exit 0) when the engine binary or the
// plugin is not available. Run: DISPLAY=:8 node tests/e2e-plugins.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXE = process.env.AUDUIO_ENGINE || '/workspace/daw-apps/engine/build/auduio-engine_artefacts/Release/auduio-engine';
const VST3 = process.env.AUDUIO_TEST_VST3_DIR || '/workspace/tools/plugins/lib/vst3';
if (!fs.existsSync(EXE) || !fs.existsSync(path.join(VST3, 'Surge XT.vst3'))) { console.log('SKIP: engine or Surge XT not found'); process.exit(0); }
const PORT = +(process.env.PORT || 8773), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 600) : ''}`); };
const shots = path.join(ROOT, 'shots'); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));

// ---- the engine + a tiny side channel for the test's own checks (string ids never collide with the app's numeric ids)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auduio-e2e-plugins-'));
// AUDUIO_TEST_WINE=1: Windows engine build under wine; its paths are mapped to Z:\...
const ep = (p) => (process.env.AUDUIO_TEST_WINE === '1' && p.startsWith('/') ? 'Z:' + p.replace(/\//g, '\\') : p);
const eng = spawn(EXE, [], { env: { ...process.env, AUDUIO_ENGINE_DATA: ep(data), AUDUIO_VST3_PATH: ep(VST3) }, stdio: ['pipe', 'pipe', 'pipe'] });
let page = null, buf = '', stderr = ''; const mine = new Map(); let seq = 0; const lines = [];
eng.stderr.on('data', (d) => (stderr += d));
eng.stdout.on('data', (d) => {
  buf += d; let i; const out = [];
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l) continue; lines.push(l);
    let m; try { m = JSON.parse(l); } catch (e) { continue; }
    if (typeof m.id === 'string' && mine.has(m.id)) { mine.get(m.id)(m); mine.delete(m.id); continue; }
    out.push(l); }
  if (out.length && page) page.evaluate((ls) => { for (const l of ls) for (const cb of (window.__tauriL['engine://msg'] || [])) cb({ payload: l }); }, out).catch(() => {});
});
const req = (cmd, a = {}) => new Promise((res, rej) => { const id = 't' + ++seq; mine.set(id, (m) => (m.ok ? res(m.result) : rej(new Error(m.error)))); eng.stdin.write(JSON.stringify({ id, cmd, ...a }) + '\n'); });

let browser; const errors = [];
const P = (fn, arg) => page.evaluate(fn, arg);
try {
  browser = await chromium.launch({ headless: true, ...(process.env.DAW_BROWSER ? { executablePath: process.env.DAW_BROWSER } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('auduio.prefs')) localStorage.setItem('auduio.prefs', JSON.stringify({ guideDone: true, tutorialDone: true, phoneMode: 'off' }));
    window.__tauriL = {};
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke: (cmd, args) => window.__engineInvoke(cmd, JSON.stringify(args || {})) }, event: { listen: async (name, cb) => { (window.__tauriL[name] = window.__tauriL[name] || []).push(cb); return () => {}; } } };
  });
  page = await ctx.newPage();
  await page.exposeFunction('__engineInvoke', (cmd, args) => {
    const a = JSON.parse(args);
    if (cmd === 'engine_send') { if (typeof a.line !== 'string' || a.line.includes('\n')) throw new Error('bad line'); eng.stdin.write(a.line + '\n'); return null; }
    if (cmd === 'engine_status') return { running: true, found: true, path: EXE };
    throw new Error('unknown command ' + cmd);
  });
  page.on('console', (m) => { if (m.type() === 'error' && !/Refused to execute inline script|Executing inline script violates/.test(m.text())) errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(URL_);
  await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 });
  await page.waitForFunction(() => __daw.S.pluginApi && __daw.S.pluginApi.connected, null, { timeout: 20000 });

  // ---- sidebar in desktop mode + scan
  const sec0 = await P(() => { const s = document.querySelector('.br-sec[data-sec=plugins]'); s.scrollIntoView(); return { note: (s.querySelector('.br-note') || {}).textContent || '', scan: !!s.querySelector('.br-actions button') }; });
  ok('Desktop app: Plugins section is active (Scan button, no "desktop only" note)', sec0.scan && !/Desktop app only/.test(sec0.note), JSON.stringify(sec0));
  await page.locator('.br-sec[data-sec=plugins] button', { hasText: 'Scan' }).first().click();
  await page.waitForFunction(() => __daw.S.pluginApi.list.length >= 2 && !__daw.S.pluginApi.scanning, null, { timeout: 60000 });
  const items = await P(() => [...document.querySelectorAll('.br-sec[data-sec=plugins] .br-item')].map((x) => x.textContent.trim()));
  ok('Scan (out of process) lists Surge XT (instrument) and Surge XT Effects in the sidebar', items.some((x) => /Surge XT/.test(x) && /Inst/.test(x)) && items.some((x) => /Surge XT Effects/.test(x) && /FX/.test(x)), items.join(' | '));
  await page.locator('#browser').screenshot({ path: path.join(shots, 'plugins-sidebar.png') });

  // ---- double-click the instrument -> new MIDI track playing through the plugin
  const nT = await P(() => __daw.S.project.tracks.length);
  await page.locator('.br-sec[data-sec=plugins] .br-item', { hasText: /^Surge XT(?! Effects)/ }).first().dblclick();
  await page.waitForFunction(() => { const t = __daw.S.project.tracks.find((x) => x.plugins); if (!t) return false; const r = __daw.S.pluginApi.rt.get(t.plugins[0].id); return r && r.instanceId && document.querySelector('.device.plugin .pl-row'); }, null, { timeout: 60000 });
  const T = await P(() => { const t = __daw.S.project.tracks.find((x) => x.plugins), e = t.plugins[0], r = __daw.S.pluginApi.rt.get(e.id), n = __daw.engine.tracks.get(t.id);
    return { id: t.id, kind: t.kind, name: t.name, pid: e.id, inst: r.instanceId, params: r.params.length, vis: __daw.S.pluginApi.visibleParams(e.id).length, proxy: n.inst && n.inst.type, rows: document.querySelectorAll('.device.plugin .pl-row').length, macros: document.querySelectorAll('.device.plugin .pl-macro').length, sel: __daw.S.selected }; });
  const nT2 = await P(() => __daw.S.project.tracks.length);
  ok('Double-click on a plugin instrument creates a MIDI track with it (loaded in the engine, card with parameters and 8 macros)', nT2 === nT + 1 && T.kind === 'midi' && T.inst > 0 && T.params > 1000 && T.rows > 10 && T.macros === 8 && T.sel === T.id, JSON.stringify(T));
  ok('The track\'s instrument is the native proxy: MIDI effects -> engine (no Web Audio synth)', T.proxy === 'plugin');
  const engParams = async () => Object.fromEntries((await req('plugin.params', { instanceId: T.inst })).map((p) => [p.i, p]));

  // ---- a note from the UI reaches the plugin: render after sending via the app's path is not observable offline,
  // so check the engine's render of this very instance is audible (the synth is live in the engine)
  const r0 = await req('render', { trackId: T.id, seconds: 1, notes: [{ t: 0.02, n: 60, v: 110, d: 0.6 }] });
  ok('The loaded plugin renders audio in the engine (offline render of the track)', r0.peak > 0.01, JSON.stringify(r0));

  // ---- slider -> engine parameter
  const target = await P((pid) => { const p = __daw.S.pluginApi.visibleParams(pid).find((x) => /Filter 1 Cutoff/.test(x.name)); return p && { i: p.i, name: p.name }; }, T.pid);
  await P(([pid, i]) => { document.querySelector('.device.plugin .pl-search').value = 'Filter 1 Cutoff'; document.querySelector('.device.plugin .pl-search').dispatchEvent(new Event('input')); }, [T.pid, target.i]);
  await sleep(100);
  const slider = page.locator(`.device.plugin .pl-row[data-i="${target.i}"] input[type=range]`).first();
  await slider.evaluate((el) => { el.value = 0.2; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(250);
  let E = await engParams();
  ok('Moving a parameter slider in the card sets it on the plugin (read back from the engine)', Math.abs(E[target.i].value - 0.2) < 0.01, `${target.name} = ${E[target.i].value} (${E[target.i].text})`);
  await page.keyboard.press('Escape');
  await P(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z'); await sleep(400);
  E = await engParams();
  ok('Undo puts the plugin parameter back', Math.abs(E[target.i].value - 0.2) > 0.05, `${target.name} = ${E[target.i].value}`);

  // ---- lock + randomize the plugin (musical), then undo
  const before = await engParams();
  await page.locator(`.device.plugin .pl-row[data-i="${target.i}"] .pl-lock`).first().click();
  const locked = await P((pid) => __daw.S.project.tracks.flatMap((t) => t.plugins || []).find((e) => e.id === pid).locks, T.pid);
  await page.locator('.device.plugin .rand-btn').first().click();
  await sleep(800);
  const after = await engParams();
  const changed = Object.keys(before).filter((k) => Math.abs(before[k].value - after[k].value) > 1e-4);
  const gv = Object.values(before).find((p) => p.name === 'Global Volume');
  ok('Randomize on the plugin card changes hundreds of its parameters in the engine; the locked one and Global Volume stay', changed.length > 100 && Math.abs(after[target.i].value - before[target.i].value) < 1e-6 && gv && Math.abs(after[gv.i].value - gv.value) < 1e-6 && (locked || []).includes(String(target.i)), `${changed.length} changed; locked ${target.name} ${before[target.i].value.toFixed(3)} -> ${after[target.i].value.toFixed(3)}; Global Volume ${gv && gv.value}`);
  const r1 = await req('render', { trackId: T.id, seconds: 1.2, notes: [{ t: 0.02, n: 60, v: 110, d: 0.8 }] });
  ok('The randomized patch still makes sound and does not clip (musical mode)', r1.peak > 0.003 && r1.peak <= 1, JSON.stringify({ peak: r1.peak, rms: r1.rms }));
  await page.screenshot({ path: path.join(shots, 'plugins-desktop.png') });
  await sleep(2800); // let the toast go
  await page.locator('.device.plugin').first().screenshot({ path: path.join(shots, 'plugins-card-randomized.png') });
  await P(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z'); await sleep(800);
  const undone = await engParams();
  const back = Object.keys(before).filter((k) => Math.abs(before[k].value - undone[k].value) > 1e-3);
  ok('One undo restores every randomized plugin parameter', back.length === 0, back.length + ' params differ: ' + back.slice(0, 5).map((k) => `${before[k].name} ${before[k].value.toFixed(3)} vs ${undone[k].value.toFixed(3)}`).join(', '));

  // ---- randomize whole track includes the plugin
  const b2 = await engParams();
  await P(() => document.querySelector('.rand-track').click()); await sleep(800);
  const a2 = await engParams();
  ok('"Randomize track" includes the plugin', Object.keys(b2).filter((k) => Math.abs(b2[k].value - a2[k].value) > 1e-4).length > 100);
  await P(() => document.activeElement && document.activeElement.blur()); await page.keyboard.press('Control+z'); await sleep(500);

  // ---- the plugin's own edits (as if turned in its window) flow back into the card + project
  const other = Object.values(before).find((p) => /A Filter 1 Resonance/.test(p.name));
  await req('param.set', { instanceId: T.inst, index: other.i, value: 0.61, notify: true }); // notify = the plugin reports it, like a move in its own window
  await sleep(600);
  const fed = await P(([pid, i]) => { const e = __daw.S.project.tracks.flatMap((t) => t.plugins || []).find((x) => x.id === pid); return { proj: e.values[i], rt: __daw.S.pluginApi.rt.get(pid).values[i] }; }, [T.pid, other.i]);
  ok('Parameter changes made inside the plugin are reported back (20 Hz) and stored in the project', Math.abs(fed.proj - 0.61) < 0.01 && Math.abs(fed.rt - 0.61) < 0.01, JSON.stringify(fed));

  // ---- MIDI learn
  await P(() => { __daw.S.learn.active = true; });
  await P(() => { const s = document.querySelector('.device.plugin .pl-search'); s.value = 'A Filter 1'; s.dispatchEvent(new Event('input')); }); await sleep(100);
  await page.locator(`.device.plugin .pl-row[data-i="${other.i}"] .pl-name`).first().dispatchEvent('pointerdown');
  await P(() => __daw.MIDI.onCC('in1', 0, 21, 100)); // learn
  await P(() => { __daw.S.learn.active = false; });
  await P(() => __daw.MIDI.onCC('in1', 0, 21, 32)); await sleep(300);
  E = await engParams();
  const mm = await P(() => __daw.S.project.midiMap.slice(-1)[0]);
  ok('MIDI learn: a controller CC mapped to a plugin parameter moves it in the engine', mm && mm.fx === 'plugin:' + T.pid && mm.key === String(other.i) && Math.abs(E[other.i].value - 32 / 127) < 0.01, JSON.stringify(mm) + ' value ' + E[other.i].value);

  // ---- macro mapping
  await page.locator('.device.plugin .pl-macro .pl-map').first().click();
  await page.locator(`.device.plugin .pl-row[data-i="${target.i}"] .pl-name`).first().dispatchEvent('pointerdown');
  await page.locator(`.device.plugin .pl-row[data-i="${other.i}"] .pl-name`).first().dispatchEvent('pointerdown');
  await page.locator('.device.plugin .pl-macro .pl-map').first().click();
  const mac = await P((pid) => __daw.S.project.tracks.flatMap((t) => t.plugins || []).find((e) => e.id === pid).macros[0].targets.map((x) => x.i), T.pid);
  await P((pid) => __daw.S.pluginApi.setMacro(pid, 0, 0.75), T.pid); await sleep(300);
  E = await engParams();
  ok('Macro 1 mapped to two plugin parameters drives both', mac.length === 2 && Math.abs(E[target.i].value - 0.75) < 0.01 && Math.abs(E[other.i].value - 0.75) < 0.01, `targets ${mac}; ${E[target.i].value.toFixed(3)} ${E[other.i].value.toFixed(3)}`);

  // ---- automation record + playback
  await page.locator('.device.plugin .pl-rec').first().click();
  await P(() => __daw.engine.play ? __daw.engine.play() : document.querySelector('#btnPlay').click()); await sleep(200);
  for (const v of [0.1, 0.3, 0.5, 0.7, 0.9]) { await P(([pid, i, v]) => __daw.S.pluginApi.setParam(pid, i, v), [T.pid, other.i, v]); await sleep(120); }
  await P(() => document.querySelector('#btnPlay') ? document.querySelector('#btnPlay').click() : __daw.engine.stop()); await sleep(200);
  await page.locator('.device.plugin .pl-rec').first().click();
  const lane = await P(([pid, i]) => (__daw.S.project.tracks.flatMap((t) => t.plugins || []).find((e) => e.id === pid).auto || {})[i] || [], [T.pid, other.i]);
  ok('Automation: parameter moves while playing with Auto armed are recorded as a lane', lane.length >= 4 && lane[0][0] <= lane[lane.length - 1][0], JSON.stringify(lane).slice(0, 200));
  await req('param.set', { instanceId: T.inst, index: other.i, value: 0.0 }); await sleep(400);
  await P(() => { __daw.engine.startPos = 0; document.querySelector('#btnPlay').click(); }); await sleep(900);
  E = await engParams();
  await P(() => document.querySelector('#btnPlay').click()); await sleep(100);
  ok('Automation plays back into the plugin', E[other.i].value > 0.2, 'value during playback ' + E[other.i].value.toFixed(3));

  // ---- effect plugin after the instrument
  await page.locator('.br-sec[data-sec=plugins] .br-item', { hasText: 'Surge XT Effects' }).first().dblclick();
  await page.waitForFunction((tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); return t.plugins.length === 2 && __daw.S.pluginApi.rt.get(t.plugins[1].id)?.instanceId; }, T.id, { timeout: 60000 });
  const r2 = await req('render', { trackId: T.id, seconds: 1, notes: [{ t: 0.02, n: 64, v: 110, d: 0.6 }] });
  ok('Plugin effect goes after the plugin instrument on the same track (chain renders)', r2.peak > 0.001 && (await P(() => document.querySelectorAll('.device.plugin').length)) === 2, JSON.stringify({ peak: r2.peak }));

  // ---- editor window
  if (process.env.DISPLAY) {
    await page.locator('.device.plugin .pl-editor').first().click(); await sleep(2500);
    const opened = lines.some((l) => /"width":\d{3}/.test(l));
    ok('The "Open plugin window" button opens the plugin\'s own editor', opened);
  } else ok('Editor test skipped (no DISPLAY)', true);

  // ---- project save/validate keeps plugins; state captured
  await P(() => __daw.S.pluginApi.captureStates());
  const val = await P(async () => { const { validateProject } = await import('./js/validate.js'); const v = validateProject(JSON.parse(JSON.stringify(__daw.S.project))).project; const t = v.tracks.find((x) => x.plugins);
    return { n: t && t.plugins.length, state: t && t.plugins[0].state && t.plugins[0].state.length, macros: t && t.plugins[0].macros[0].targets.length, auto: t && Object.keys(t.plugins[0].auto).length, map: v.midiMap.some((m) => String(m.fx).startsWith('plugin:')) }; });
  ok('Saved project keeps the plugins (state chunk, macros, automation, MIDI map) through validation', val.n === 2 && val.state > 1000 && val.macros === 2 && val.auto >= 1 && val.map, JSON.stringify(val));

  // ---- remove -> unloaded in the engine
  const inst2 = T.inst;
  await P(() => document.querySelectorAll('.device.plugin .rm')[1].click()); await sleep(200);
  await P(() => document.querySelector('.device.plugin .rm').click()); await sleep(500);
  const gone = await req('plugin.params', { instanceId: inst2 }).then(() => 'still there', (e) => e.message);
  const T3 = await P((tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); return { plugins: t.plugins, inst: __daw.engine.tracks.get(tid).inst.type }; }, T.id);
  ok('Removing the plugins unloads them in the engine and brings the built-in synth back', /unknown instanceId/.test(gone) && !T3.plugins && T3.inst !== 'plugin', gone + ' ' + JSON.stringify(T3));
  await P(() => document.activeElement && document.activeElement.blur()); await page.keyboard.press('Control+z'); await sleep(1500);
  const re = await P((tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); return t.plugins && t.plugins.map((e) => !!__daw.S.pluginApi.rt.get(e.id)?.instanceId); }, T.id);
  ok('Undo of the removal reloads the plugin (from its saved state)', re && re.length === 1 && re[0], JSON.stringify(re));
} catch (e) { ok('test run crashed', false, e.stack + '\nENGINE STDERR: ' + stderr.slice(-1500)); }
finally {
  ok('No uncaught page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-plugins.json'), JSON.stringify(results, null, 2));
  if (browser) await browser.close(); server.kill();
  eng.stdin.end(); setTimeout(() => eng.kill(), 3000).unref();
  process.exit(passed === results.length ? 0 : 1);
}
