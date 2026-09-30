// MIDI out through the native engine, for desktop webviews without Web MIDI (macOS WKWebView, Linux WebKitGTK).
// Web MIDI is removed from the page; the page gets the Tauri bridge stand-in (like e2e-plugins) wired to the
// real Rust engine, which writes MIDI to its test sink port (AUDUIO_MIDI_TEST_SINK). Run:
//   AUDUIO_ENGINE=/workspace/daw-apps/engine-rs/target/release/auduio-engine PORT=8781 node tests/e2e-midiout.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXE = process.env.AUDUIO_ENGINE || '/workspace/daw-apps/engine-rs/target/release/auduio-engine';
if (!fs.existsSync(EXE)) { console.log('SKIP: engine not found'); process.exit(0); }
const PORT = +(process.env.PORT || 8781), BASE = '/daw/', URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = []; const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 600) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auduio-e2e-midiout-')); const SINK = path.join(data, 'sink.log');
const eng = spawn(EXE, [], { env: { ...process.env, AUDUIO_ENGINE_DATA: data, AUDUIO_VST3_PATH: path.join(data, 'none'), AUDUIO_CLAP_PATH: path.join(data, 'none'), AUDUIO_MIDI_TEST_SINK: SINK, AUDUIO_MIDI_TEST_SOURCE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
let page = null, buf = '', stderr = '';
eng.stderr.on('data', (d) => (stderr += d));
eng.stdout.on('data', (d) => { buf += d; let i; const out = []; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) out.push(l); }
  if (out.length && page) page.evaluate((ls) => { for (const l of ls) for (const cb of (window.__tauriL['engine://msg'] || [])) cb({ payload: l }); }, out).catch(() => {}); });
const sink = () => (fs.existsSync(SINK) ? fs.readFileSync(SINK, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [us, ...b] = l.split(' '); return { us: +us, b: b.map((x) => parseInt(x, 16)) }; }) : []);
let browser; const errors = []; const P = (fn, arg) => page.evaluate(fn, arg);
try {
  browser = await chromium.launch({ headless: true, ...(process.env.DAW_BROWSER ? { executablePath: process.env.DAW_BROWSER } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('auduio.prefs')) localStorage.setItem('auduio.prefs', JSON.stringify({ guideDone: true, tutorialDone: true, phoneMode: 'off' }));
    try { delete Navigator.prototype.requestMIDIAccess; } catch (e) {} try { Object.defineProperty(navigator, 'requestMIDIAccess', { value: undefined, configurable: true }); } catch (e) {}
    window.__tauriL = {}; window.__TAURI_INTERNALS__ = {};
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
  const env = await P(async () => { const m = await import('./js/midi.js'); for (let i = 0; i < 50 && !m.engineMidi.ports.length; i++) await new Promise((r) => setTimeout(r, 100)); return { web: m.MIDI.webSupported, eng: m.engineMidi.available, ports: m.outputs().map((o) => o.name) }; });
  ok('Webview without Web MIDI: the engine announces midiOut and its ports are listed as MIDI outputs', !env.web && env.eng && env.ports.includes('Auduio Test Sink'), JSON.stringify(env));

  await page.click('#seqPanel [data-act=new-synth]'); await sleep(200);
  for (const i of [0, 4, 8, 12]) await page.click(`.sq-step[data-si="${i}"]`);
  await page.selectOption('.sq-out', 'midi'); await sleep(400);
  const opts = await P(() => [...document.querySelectorAll('.sq-port option')].map((o) => ({ v: o.value, t: o.textContent })));
  const sinkOpt = opts.find((o) => o.t === 'Auduio Test Sink');
  ok('Sequencer Output "MIDI out" works without Web MIDI (no error toast) and offers the engine port', !!sinkOpt && sinkOpt.v.startsWith('engine:'), JSON.stringify(opts));
  await page.selectOption('.sq-port', sinkOpt.v); await page.selectOption('.sq-ch', '3'); await sleep(200);
  await P(() => __daw.engine.play(0)); await sleep(1300); await P(() => { __daw.engine.stop(); __daw.engine.stop(); }); await sleep(700);
  const L = sink();
  const ons = L.filter((m) => m.b[0] === 0x92 && m.b[2] > 0), offs = L.filter((m) => m.b[0] === 0x82), cc = L.filter((m) => (m.b[0] & 0xf0) === 0xb0 && m.b[1] === 123);
  const gaps = ons.slice(1).map((m, i) => (m.us - ons[i].us) / 1000);
  ok('Playing sends note on/off on channel 3 through the engine, 500 ms apart at 120 BPM (timed by the engine)', ons.length >= 2 && offs.length >= 2 && gaps.every((g) => Math.abs(g - 500) < 20), `on=${ons.length} off=${offs.length} gaps=${gaps.map((g) => g.toFixed(1))}`);
  ok('Stop sends All Notes Off (CC 123) through the engine', cc.length >= 1, `cc123=${cc.length}`);
  const n0 = sink().length; await sleep(600);
  ok('Nothing is sent after stop (queued note-offs flushed/cleared)', sink().length === n0 || sink().slice(n0).every((m) => (m.b[0] & 0xf0) === 0xb0), `${sink().length - n0} extra`);
  await page.selectOption('.sq-out', 'track'); await sleep(100);

  // ---- MIDI in through the engine (no Web MIDI): an armed synth track plays notes from an engine input port
  const tid = await P(() => __daw.S.selected);
  await P((id) => { const t = __daw.S.project.tracks.find((x) => x.id === id); if (!t.arm) document.querySelector(`#sessionView .col[data-id="${id}"] .tbtn.arm, #arrangeView .lane-head[data-id="${id}"] .tbtn.arm`)?.click(); }, tid);
  await page.waitForFunction(async () => { const m = await import('./js/midi.js'); return m.MIDI.inputs().some((i) => i.name === 'Auduio Test Source'); }, null, { timeout: 12000 }).catch(() => {});
  const ins = await P(async () => { const m = await import('./js/midi.js'); return { sup: m.MIDI.supported, web: m.MIDI.webSupported, ins: m.MIDI.inputs().map((i) => i.id) }; });
  ok('MIDI in without Web MIDI: the engine\'s input ports are listed as MIDI inputs (ids engine:<name>)', ins.sup && !ins.web && ins.ins.includes('engine:Auduio Test Source'), JSON.stringify(ins));
  await P((id) => { const n = __daw.engine.tracks.get(id); const d = n.midi || n.inst; window.__inLog = []; const on = d.noteOn.bind(d), off = d.noteOff.bind(d); d.noteOn = (a, b, ...r) => { __inLog.push(['on', a, b]); return on(a, b, ...r); }; d.noteOff = (a, ...r) => { __inLog.push(['off', a]); return off(a, ...r); }; }, tid);
  const inject = (d) => eng.stdin.write(JSON.stringify({ id: 9000 + Math.floor(Math.random() * 999), cmd: 'midiin.inject', d }) + '\n');
  inject([0x90, 64, 101]); await sleep(250); inject([0x80, 64, 0]); await sleep(150); inject([0xF8]); inject([0xF0, 1, 2]); await sleep(150);
  const inLog = await P(() => window.__inLog);
  ok('A note from the engine MIDI input plays the armed track (note on 64 vel 101, then note off); clock/SysEx are dropped', JSON.stringify(inLog) === '[["on",64,101],["off",64]]', JSON.stringify(inLog));
  // flood: the engine rate-limits each port (2000 msgs/s) so a stuck controller cannot freeze the app
  for (let i = 0; i < 3000; i++) inject([0xB0, 1, i & 127]); await sleep(800);
  ok('Engine stays responsive after a MIDI-in flood (rate limited)', await P(async () => { try { await __daw.S.pluginApi.client.request('ping', {}, 3000); return true; } catch (e) { return false; } }));
} catch (e) { ok('test run crashed', false, e.stack + '\nENGINE STDERR: ' + stderr.slice(-1500)); }
finally {
  ok('No uncaught page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-midiout.json'), JSON.stringify(results, null, 2));
  if (browser) await browser.close(); server.kill();
  eng.stdin.end(); setTimeout(() => eng.kill(), 3000).unref();
  process.exit(passed === results.length ? 0 : 1);
}
