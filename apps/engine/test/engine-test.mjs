// Protocol test for auduio-engine with a real VST3 (Surge XT). Run:
//   AUDUIO_ENGINE=engine/build/auduio-engine_artefacts/Release/auduio-engine AUDUIO_TEST_VST3_DIR=/path/with/vst3s node engine/test/engine-test.mjs
// CLAP: AUDUIO_TEST_FORMAT=CLAP [AUDUIO_TEST_CLAP_DIR=/path/with/claps] (Rust engine only).
// Optional: DISPLAY set (e.g. Xvfb) -> also opens the plugin editor window.
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXE = process.env.AUDUIO_ENGINE || path.join(HERE, '..', 'build', 'auduio-engine_artefacts', 'Release', 'auduio-engine');
const VST3 = process.env.AUDUIO_TEST_VST3_DIR || '/workspace/tools/plugins/lib/vst3';
const WANT = process.env.AUDUIO_TEST_PLUGIN || 'Surge XT';
const FORMAT = (process.env.AUDUIO_TEST_FORMAT || 'VST3').toUpperCase(); // VST3 or CLAP (CLAP needs the Rust engine)
const CLAP = process.env.AUDUIO_TEST_CLAP_DIR || '/workspace/tools/plugins/lib/clap';
const results = []; const ok = (n, c, i = '') => { results.push({ name: n, pass: !!c, info: i }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${i ? '  — ' + String(i).slice(0, 400) : ''}`); };
// AUDUIO_TEST_WINE=1: the engine is a Windows build run under wine, so paths handed to it are mapped to Z:\...
const WINE = process.env.AUDUIO_TEST_WINE === '1';
const ep = (p) => (WINE && p.startsWith('/') ? 'Z:' + p.replace(/\//g, '\\') : p);
const hp = (p) => (WINE && /^Z:/i.test(p || '') ? p.slice(2).replace(/\\/g, '/') : p);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'auduio-engine-'));
const SINK = path.join(data, 'midi-sink.log');
const proc = spawn(EXE, [], { env: { ...process.env, AUDUIO_MIDI_TEST_SINK: ep(SINK), AUDUIO_ENGINE_DATA: ep(data), AUDUIO_VST3_PATH: ep(VST3), ...(FORMAT === 'CLAP' ? { AUDUIO_CLAP_PATH: ep(CLAP) } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', nextId = 1; const pending = new Map(), events = [], waiters = [];
proc.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch (e) { console.log('NON-JSON on stdout:', line.slice(0, 200)); continue; }
    if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); }
    else if (m.event) { events.push(m); waiters.filter((w) => w.ev === m.event).forEach((w) => { waiters.splice(waiters.indexOf(w), 1); w.res(m); }); }
  }
});
let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
const req = (cmd, args = {}, ms = 60000) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n'); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + cmd)); } }, ms); });
const waitEvent = (ev, ms = 180000) => { const e = events.find((x) => x.event === ev); if (e) return Promise.resolve(e); return new Promise((res, rej) => { waiters.push({ ev, res }); setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms); }); };
let code = 1;
async function loadRandomizer() {
  const cands = [process.env.AUDUIO_WEB_SRC, path.join(HERE, '../../../daw/src'), path.join(HERE, '../../../web-src/src'), path.join(HERE, '../../web/src')].filter(Boolean);
  for (const c of cands) { const f = path.join(c, 'js', 'randomize.js'); if (fs.existsSync(f)) return import(f); }
  throw new Error('randomize.js not found (set AUDUIO_WEB_SRC to the web app src folder)');
}
try {
  const ready = await waitEvent('ready', 20000);
  ok('Engine starts and announces itself (ready event: version, protocol, formats)', ready.engine === 'auduio-engine' && ready.protocol === 1 && ready.formats.includes(FORMAT), JSON.stringify({ v: ready.version, juce: ready.juce, formats: ready.formats, os: ready.os }));
  const bad = await req('nope').catch((e) => e.message);
  ok('Unknown commands get an error reply (engine keeps running)', /unknown command/.test(bad), bad);
  proc.stdin.write('{not json\n'); await new Promise((r) => setTimeout(r, 100));
  ok('Malformed JSON is rejected without crashing', (await req('ping')).engine === 'auduio-engine');
  const t0 = Date.now();
  const st = await req('scan', { timeoutMs: 60000 });
  const done = await waitEvent('scan.done', 300000);
  const prog = events.filter((e) => e.event === 'scan.progress').length;
  const names = done.plugins.map((p) => `${p.name} (${p.format}${p.isInstrument ? ', instrument' : ''})`);
  ok('Scan (each file probed in its own child process) finds the ' + FORMAT + 's in the plugin folder', st.started && done.plugins.some((p) => p.name === WANT && p.format === FORMAT), `${names.join(', ')} | failed: ${JSON.stringify(done.failed)} | progress events ${prog} | ${Date.now() - t0} ms | paths ${done.paths.join(':')}`);
  const cache = JSON.parse(fs.readFileSync(path.join(data, 'plugin-cache.json'), 'utf8'));
  ok('Scan results are cached on disk', cache.plugins.length === done.plugins.length);
  const surge = done.plugins.find((p) => p.name === WANT && p.format === FORMAT);
  const L = await req('plugin.load', { trackId: 't1', uid: surge.uid }, 120000);
  const visible = L.params.filter((p) => !p.hidden);
  ok(`Loads ${WANT} and enumerates its parameters (name, default, value, text, steps)`, L.instanceId > 0 && visible.length > 50 && L.outputs >= 2, `instance ${L.instanceId}, ${L.params.length} params (${visible.length} visible), editor ${L.hasEditor}, first: ${visible.slice(0, 4).map((p) => `${p.name}=${p.text}`).join(', ')}`);
  const tone = await req('render', { trackId: 't1', seconds: 1.5, notes: [{ t: 0.05, n: 60, v: 110, d: 0.8 }, { t: 0.05, n: 64, v: 110, d: 0.8 }], wav: ep(path.join(data, 'render-default.wav')) }, 120000);
  ok('Offline render: MIDI notes in -> audio out (non-silent, written to WAV)', tone.peak > 0.01 && fs.existsSync(hp(tone.wav)), JSON.stringify(tone));
  const silent = await req('render', { trackId: 't1', seconds: 0.5, notes: [] });
  ok('No notes -> (near) silence', silent.peak < tone.peak * 0.5, JSON.stringify(silent));
  // parameter set + readback
  const p0 = visible.find((p) => !p.discrete && /cutoff/i.test(p.name)) || visible.find((p) => !p.discrete);
  const s1 = await req('param.set', { instanceId: L.instanceId, index: p0.i, value: 0.123 });
  const back = (await req('plugin.params', { instanceId: L.instanceId })).find((p) => p.i === p0.i);
  ok('param.set changes a parameter (read back from the plugin)', Math.abs(back.value - 0.123) < 0.01, `${p0.name}: ${p0.value.toFixed(3)} -> ${back.value.toFixed(3)} (${back.text}) ${JSON.stringify(s1)}`);
  // randomize exactly like the app does (web/src/js/randomize.js, musical mode, plugin params by name)
  const toDefs = (list) => list.filter((p) => !p.hidden && p.automatable).map((p) => ({ key: String(p.i), label: p.name, min: 0, max: 1, def: p.def, plugin: true, ...(p.options ? { type: 'select', options: p.options.map((_, k) => k / Math.max(1, p.options.length - 1)) } : {}) }));
  const cur = Object.fromEntries(visible.map((p) => [String(p.i), p.value]));
  const R = await loadRandomizer();
  let seed = 20260929; const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ch = R.randomizeValues(toDefs(visible), cur, { amount: 0.5, mode: 'musical', rng }); // the app's default amount (50%)
  await req('param.setMany', { instanceId: L.instanceId, values: Object.entries(ch).map(([k, v]) => [+k, v]) });
  const after = await req('plugin.params', { instanceId: L.instanceId });
  const kept = visible.filter((p) => R.isKeptParam({ key: String(p.i), label: p.name, plugin: true }));
  const keptOk = kept.every((p) => Math.abs(after.find((q) => q.i === p.i).value - p.value) < 1e-6);
  ok('Musical randomize of the plugin (app logic): many params change, volume/mute/tuning-type params stay', Object.keys(ch).length > 100 && keptOk, `${Object.keys(ch).length} changed, ${kept.length} kept (e.g. ${kept.slice(0, 6).map((p) => p.name).join(', ')})`);
  const tone2 = await req('render', { trackId: 't1', seconds: 1.5, notes: [{ t: 0.05, n: 60, v: 110, d: 0.8 }], wav: ep(path.join(data, 'render-random.wav')) }, 120000);
  ok('Musically randomized patch still makes sound and does not clip', tone2.peak > 0.005 && tone2.peak <= 1.0 && Math.abs(tone2.rms - tone.rms) > 1e-5, JSON.stringify({ before: tone.rms, after: tone2.rms, peak: tone2.peak }));
  // state save / restore
  const state = await req('state.get', { instanceId: L.instanceId });
  await req('param.set', { instanceId: L.instanceId, index: p0.i, value: 0.9 });
  await req('state.set', { instanceId: L.instanceId, data: state.data });
  await req('render', { trackId: 't1', seconds: 0.1, notes: [] }); // some plugins (Surge) apply a loaded state on the next audio block
  await new Promise((r) => setTimeout(r, 400)); // ...and publish the new values to the host params asynchronously on the message thread
  const rv = (await req('plugin.params', { instanceId: L.instanceId })).find((p) => p.i === p0.i).value;
  const tone3 = await req('render', { trackId: 't1', seconds: 1.5, notes: [{ t: 0.05, n: 60, v: 110, d: 0.8 }] }, 120000);
  const sameSound = Math.abs(tone3.rms - tone2.rms) / tone2.rms < 0.05;
  const sameParam = Math.abs(rv - after.find((q) => q.i === p0.i).value) < 0.01;
  ok('Plugin state save/restore (base64 chunk) brings the saved sound back', state.bytes > 100 && (sameParam || sameSound), `${state.bytes} bytes; render rms ${tone3.rms.toFixed(4)} vs saved ${tone2.rms.toFixed(4)}; ${p0.name} reads ${rv.toFixed(3)}${sameParam ? '' : ' (host param readback lags: this plugin applies state on its audio thread)'}`);
  // timed MIDI through the live path (no device: queue accepted) + transport + mix
  await req('track.set', { trackId: 't1', gainDb: -6, pan: 0.2, mute: false });
  await req('transport', { playing: true, bpm: 128, ppq: 0 });
  const clk = await req('clock');
  await req('midi', { trackId: 't1', events: [{ t: clk.seconds + 0.1, d: [0x90, 60, 100] }, { t: clk.seconds + 0.5, d: [0x80, 60, 0] }, { d: [0xF0, 1, 2] }] });
  ok('Clock / transport / timed MIDI / mix commands accepted', typeof clk.seconds === 'number' && clk.sampleRate > 0);
  // editor window (needs a display)
  if (process.env.DISPLAY && L.hasEditor) {
    const ed = await req('editor.open', { instanceId: L.instanceId }, 60000).catch((e) => ({ error: e.message }));
    await new Promise((r) => setTimeout(r, 2500));
    ok('Opens the plugin\'s own editor window', ed.width > 100 && ed.height > 100, JSON.stringify(ed));
    await req('editor.close', { instanceId: L.instanceId });
  } else ok('Editor window test skipped (no DISPLAY)', true);
  // a second instance on another track, then unload
  const fx = done.plugins.find((p) => /Effects/.test(p.name) && p.format === FORMAT);
  if (fx) {
    const F = await req('plugin.load', { trackId: 't1', uid: fx.uid }, 120000);
    const chainRender = await req('render', { trackId: 't1', seconds: 1, notes: [{ t: 0.05, n: 67, v: 100, d: 0.5 }] }, 120000);
    ok('Instrument + effect plugin chain on one track renders', chainRender.peak > 0.001, `${fx.name}: ${F.params.length} params, peak ${chainRender.peak}`);
    await req('plugin.unload', { instanceId: F.instanceId });
  }
  await req('track.remove', { trackId: 't1' });
  const gone = await req('plugin.params', { instanceId: L.instanceId }).catch((e) => e.message);
  ok('track.remove unloads its plugins', /unknown instanceId/.test(gone), gone);
  // hardware MIDI out (Rust engine: desktop webviews have no Web MIDI)
  const hello = await req('hello');
  if (hello.midiOut) {
    const L2 = await req('midiout.list');
    ok('MIDI out: lists output ports (test sink present)', L2.ports.some((p) => p.name === 'Auduio Test Sink'), JSON.stringify(L2).slice(0, 300));
    const t0 = Date.now();
    await req('midiout.send', { port: 'Auduio Test Sink', events: [{ d: [0x90, 60, 100], dt: 0 }, { d: [0x80, 60, 0], dt: 0.25 }, { d: [0xB1, 7, 90], dt: 0.1 }] });
    await new Promise((r) => setTimeout(r, 500));
    const lines = fs.existsSync(SINK) ? fs.readFileSync(SINK, 'utf8').trim().split('\n').map((l) => l.split(' ')) : [];
    const us = (hex) => { const l = lines.find((x) => x.slice(1).join(' ') === hex); return l ? +l[0] : NaN; };
    const on = us('90 3c 64'), cc = us('b1 07 5a'), off = us('80 3c 00');
    ok('MIDI out: events leave in time order at their scheduled delays', lines.length === 3 && Math.abs((off - on) / 1000 - 250) < 25 && Math.abs((cc - on) / 1000 - 100) < 25, JSON.stringify(lines));
    const bad = await Promise.all([[0xF0, 1, 2], [0xF8], [0x90, 200, 1], [0x90, 60]].map((d) => req('midiout.send', { port: 'Auduio Test Sink', events: [{ d, dt: 0 }] }).then(() => 'accepted', (e) => 'rejected')));
    ok('MIDI out: rejects SysEx, realtime and malformed messages', bad.every((x) => x === 'rejected'), bad.join(','));
    await req('midiout.send', { port: 'Auduio Test Sink', events: [{ d: [0x90, 64, 100], dt: 0.3 }] });
    await req('midiout.allOff', { port: 'Auduio Test Sink' });
    await new Promise((r) => setTimeout(r, 450));
    const after = fs.readFileSync(SINK, 'utf8').trim().split('\n').slice(3);
    ok('MIDI out: allOff drops queued notes and sends All Notes Off on all 16 channels', !after.some((l) => / 90 40 64$/.test(l)) && after.filter((l) => / 7b 00$/.test(l)).length === 16, after.length + ' lines');
  } else ok('MIDI out test skipped (engine has no midiOut)', true);
  await req('quit');
  code = await new Promise((r) => { const t = setTimeout(() => r(-1), 10000); proc.on('exit', (c) => { clearTimeout(t); r(c); }); });
  ok('Engine quits cleanly on request', code === 0, 'exit ' + code);
} catch (e) { ok('engine test crashed', false, e.stack + '\nSTDERR: ' + stderr.slice(-2000)); proc.kill(); }
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} engine checks passed`);
fs.writeFileSync(path.join(HERE, FORMAT === 'VST3' ? 'last-results-engine.json' : `last-results-engine-${FORMAT.toLowerCase()}.json`), JSON.stringify(results, null, 2));
process.exit(passed === results.length ? 0 : 1);
