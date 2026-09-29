// v0.3 auto-timing tests (Chromium, real-time AudioContext): tap tempo, detect (playing + stopped),
// follow with drift + lock, clip BPM + "set project tempo from clip", tier gating, undo, screenshots.
// Run: node tests/e2e-tempo.mjs   (PORT env, default 8767)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8767), BASE = '/daw/', URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const shots = path.join(ROOT, 'screenshots/v3'); fs.mkdirSync(shots, { recursive: true });
const results = []; const ok = (name, c, d = '') => { results.push({ name, pass: !!c, detail: d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${d ? '  — ' + d : ''}`); };
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ headless: true, ...(process.env.DAW_BROWSER ? { executablePath: process.env.DAW_BROWSER } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
async function newPage(viewport = { width: 1280, height: 800 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  await ctx.addInitScript(() => {
    localStorage.setItem('webdaw.prefs', JSON.stringify({ guideDone: true, tutorialDone: true, phoneMode: 'off' }));
    window.__vib = 0; try { Object.defineProperty(navigator, 'vibrate', { value: () => { window.__vib++; return true; }, configurable: true }); } catch (e) {}
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  await page.goto(URL_); await page.click('#startBtn'); await page.waitForSelector('#sessionView .col[data-id]');
  return { ctx, page };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// in-page helper: schedule oscillator clicks into the tempo bus (simulates a live band on an armed input)
const INJECT = `window.__clicks = (bpmFn, secs, startIn = 0.3) => { const { engine } = __daw, ctx = engine.ctx; const t0 = ctx.currentTime + startIn; const out = []; (window.__osc || []).forEach((o) => { try { o.stop(); } catch (e) {} }); window.__osc = []; let t = 0, k = 0;
  while (t < secs) { const at = t0 + t, down = k % 4 === 0; const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = down ? 1600 : 1000;
    g.gain.setValueAtTime(0, 0); g.gain.setValueAtTime(down ? 0.6 : 0.3, at); g.gain.setTargetAtTime(0, at, 0.008); o.connect(g).connect(engine.tempoSum); o.start(at); o.stop(at + 0.06); window.__osc.push(o);
    out.push({ t: at, down }); t += 60 / bpmFn(t); k++; }
  return out; };`;
try {
  const { ctx, page } = await newPage();
  await page.evaluate(INJECT);

  // ---- compact transport
  const tb = await page.evaluate(() => { const r = document.querySelector('#topbar').getBoundingClientRect(); return { h: Math.round(r.height), tap: !!document.querySelector('#btnTap'), tempo: !!document.querySelector('#btnTempo') }; });
  ok('Transport has TAP + auto-timing buttons and stays one slim row', tb.tap && tb.tempo && tb.h <= 48, JSON.stringify(tb));

  // ---- tap tempo with haptic ticks
  for (let i = 0; i < 6; i++) { await page.dispatchEvent('#btnTap', 'pointerdown'); await sleep(500); }
  const tap = await page.evaluate(() => ({ bpm: __daw.S.project.bpm, vib: window.__vib, field: +document.querySelector('#bpm').value }));
  ok('Tap tempo: 6 taps at 500 ms -> ~120 BPM, a haptic tick per tap', Math.abs(tap.bpm - 120) < 2 && tap.vib >= 6 && tap.field === tap.bpm, JSON.stringify(tap));

  // ---- detect while playing a click-track clip (128 BPM, first downbeat 0.30 s)
  const det = await page.evaluate(async () => {
    const { engine, S } = __daw; const { clickTrack } = await import('./js/audio/tempo.js');
    const sr = engine.ctx.sampleRate; const { x } = clickTrack(sr, 24, 128, { start: 0.3 });
    const b = engine.ctx.createBuffer(1, x.length, sr); b.copyToChannel(x, 0); engine.buffers.set('bclick', b);
    const t = S.project.tracks[0]; t.arrangement.push({ id: 'cclick', bufferId: 'bclick', start: 0, offset: 0, duration: 24, name: 'Click 128' });
    engine.setTempo(100, { keepPhase: false }); S.project.gridOffset = 0; engine.metronome = true; engine.play(0);
    return true;
  });
  await page.click('#btnTempo'); await page.waitForSelector('.tempo-pop');
  await page.evaluate(() => { __daw.S.detectBars = 6; });
  await sleep(1500);
  await page.screenshot({ path: path.join(shots, 'desktop-tempo-popover.png') });
  await page.click('.tempo-pop .tp-detect');
  await page.waitForFunction(() => !__daw.engine.tempo.detect, null, { timeout: 30000 });
  const clicks = [];
  const d1 = await page.evaluate(async () => {
    const { engine, S } = __daw; const ev = []; engine.on('click', (c) => ev.push(c));
    await new Promise((r) => setTimeout(r, 3000));
    const bar = engine.barDur, beat = engine.beatDur;
    // clip clicks are at position 0.3 + k*60/128; downbeats every 4
    const wrap = (e, P) => { e = ((e % P) + P) % P; return e > P / 2 ? e - P : e; };
    const P = 60 / 128; const errs = ev.map((c) => wrap(c.pos - 0.3, P) * 1000);
    const accErr = ev.filter((c) => ((c.k % 4) + 4) % 4 === 0).map((c) => wrap(c.pos - 0.3, 4 * P) * 1000);
    return { bpm: S.project.bpm, grid: S.project.gridOffset, gridErrMs: wrap(S.project.gridOffset - 0.3, bar) * 1000, clickErrMs: errs.map((e) => +e.toFixed(1)), accentErrMs: accErr.map((e) => +e.toFixed(1)), n: ev.length, beat };
  });
  ok('Detect (playing): clip at 128 BPM -> project tempo 128', Math.abs(d1.bpm - 128) < 0.4, `bpm ${d1.bpm}`);
  ok('Detect (playing): metronome clicks land on the clip\'s beats, accents on its downbeats (±25 ms)', d1.n >= 4 && d1.clickErrMs.every((e) => Math.abs(e) < 25) && d1.accentErrMs.length >= 1 && d1.accentErrMs.every((e) => Math.abs(e) < 25), JSON.stringify({ grid: d1.grid, click: d1.clickErrMs, accents: d1.accentErrMs }));
  await page.evaluate(() => { __daw.engine.stop(); __daw.engine.stop(); });
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => __daw.S.project.bpm);
  ok('Undo restores the tempo from before "Detect tempo"', Math.abs(undone - 100) < 0.01, `bpm after undo ${undone}`);
  await page.mouse.click(5, 790); // close popover
  await page.evaluate(() => { const t = __daw.S.project.tracks[0]; t.arrangement = t.arrangement.filter((c) => c.id !== 'cclick'); __daw.engine.stop(); });

  // ---- detect while stopped from a live input: start transport + click on the next downbeat
  const d2 = await page.evaluate(async () => {
    const { engine, S } = __daw; engine.metronome = false; S.project.gridOffset = 0; S.detectBars = 5;
    const src = __clicks(() => 110, 26, 0.2);
    const est = await engine.detectTempo({ bars: 5, startOnDownbeat: true });
    const outLat = engine.ctx.outputLatency || engine.ctx.baseLatency || 0;
    const downs = src.filter((c) => c.down).map((c) => c.t); const st = engine.startCtxTime;
    const dErr = downs.reduce((m, t) => (Math.abs(st - t) < Math.abs(m) ? st - t : m), 9);
    await new Promise((r) => setTimeout(r, 1500)); const playing = engine.playing, metro = engine.metronome; engine.stop(); engine.stop();
    return { bpm: S.project.bpm, conf: est && +est.confidence.toFixed(2), downErrMs: +(dErr * 1000).toFixed(1), playing, metro, outLatMs: +(outLat * 1000).toFixed(1) };
  });
  ok('Detect (stopped, live input 110 BPM): sets tempo, starts transport + metronome on a downbeat (±25 ms)', Math.abs(d2.bpm - 110) < 0.5 && Math.abs(d2.downErrMs) < 25 && d2.playing && d2.metro, JSON.stringify(d2));

  // ---- follow a drifting band: 120 -> 126 BPM, tremolo synced to tempo
  const f = await page.evaluate(async () => {
    const { engine, S } = __daw; await engine.resume(); engine.stopTempoListen();
    const t = S.project.tracks[0]; t.fx.push({ type: 'tremolo', enabled: true, values: { sync: 1, division: '1/8', depth: 50 } }); engine.setTrackFx(t);
    const trem = engine.tracks.get(t.id).fx.at(-1);
    engine.setTempo(120, { keepPhase: false }); S.project.gridOffset = 0;
    const fn = (s) => (s < 8 ? 120 : s < 18 ? 120 + (s - 8) * 0.6 : 126);
    const src = __clicks(fn, 30, 0.2); engine.metronome = true;
    engine.play(0, src[0].t); // start on the band's first beat
    engine.setTempoFollow(true);
    const trace = [], ev = []; engine.on('click', (c) => ev.push(c));
    const t0 = performance.now();
    while (performance.now() - t0 < 29000) { await new Promise((r) => setTimeout(r, 500)); trace.push({ s: (performance.now() - t0) / 1000, bpm: S.project.bpm }); }
    engine.setTempoFollow(false); engine.stop(); engine.stop();
    let maxRate = 0; for (let i = 1; i < trace.length; i++) maxRate = Math.max(maxRate, Math.abs(trace[i].bpm - trace[i - 1].bpm) / (trace[i].s - trace[i - 1].s));
    const ivs = []; for (let i = 1; i < ev.length; i++) ivs.push(ev[i].t - ev[i - 1].t);
    // phase: last 4 s of metronome clicks vs nearest band click (acoustic click = t + outLat)
    const outLat = engine.ctx.outputLatency || engine.ctx.baseLatency || 0; const lastT = ev.at(-1).t;
    const ph = ev.filter((c) => c.t > lastT - 4).map((c) => { const a = c.t + outLat; return +(src.reduce((m, s) => (Math.abs(a - s.t) < Math.abs(m) ? a - s.t : m), 9) * 1000).toFixed(1); });
    return { final: S.project.bpm, tremBpm: trem.bpm, maxRate: +maxRate.toFixed(2), minIv: +Math.min(...ivs).toFixed(3), maxIv: +Math.max(...ivs).toFixed(3), ph, trace: trace.filter((_, i) => i % 6 === 0).map((p) => +p.bpm.toFixed(2)) };
  });
  ok('Follow: tracks a 120 -> 126 BPM drift smoothly (rate-limited)', Math.abs(f.final - 126) < 1 && f.maxRate <= 1.6, JSON.stringify({ final: f.final, maxRate: f.maxRate, trace: f.trace }));
  ok('Follow: tempo-synced effect (tremolo) moves with the tempo', Math.abs(f.tremBpm - f.final) < 0.01, `tremolo bpm ${f.tremBpm}`);
  ok('Follow: metronome never double-clicks or skips, stays phase-locked to the band (±30 ms)', f.minIv > 0.8 * 60 / 126 && f.maxIv < 1.2 * 60 / 120 && f.ph.every((e) => Math.abs(e) < 30), JSON.stringify({ minIv: f.minIv, maxIv: f.maxIv, phaseMs: f.ph }));

  // ---- lock once detected
  const lk = await page.evaluate(async () => {
    const { engine, S } = __daw; engine.setTempo(96, { keepPhase: false }); let locked = null; engine.on('tempolock', (e) => (locked = e.bpm));
    __clicks(() => 100, 22, 0.2); engine.setTempoFollow(true, { lock: true });
    const t0 = performance.now(); while (performance.now() - t0 < 21000 && locked == null) await new Promise((r) => setTimeout(r, 250));
    const after = S.project.bpm; await new Promise((r) => setTimeout(r, 600));
    return { locked, bpm: S.project.bpm, mode: engine.tempo.mode, listening: engine.tempo.listening, after };
  });
  ok('Follow + "Lock once detected": locks at the band tempo and stops following', lk.locked != null && Math.abs(lk.bpm - 100) < 1 && lk.mode === 'off' && !lk.listening, JSON.stringify(lk));

  // ---- clip BPM detection + set project tempo from clip (with bar alignment)
  await page.evaluate(async () => {
    const { engine, S } = __daw; const { clickTrack } = await import('./js/audio/tempo.js');
    const sr = engine.ctx.sampleRate; const { x } = clickTrack(sr, 12, 93, { start: 0.2 });
    const b = engine.ctx.createBuffer(1, x.length, sr); b.copyToChannel(x, 0); engine.buffers.set('b93', b);
    S.project.gridOffset = 0; engine.setTempo(120, { keepPhase: false });
    S.project.tracks[0].arrangement.push({ id: 'c93', bufferId: 'b93', start: 1.0, offset: 0, duration: 12, name: 'Loop 93' });
    S.view = 'arrange'; document.querySelector('.views button[data-view=arrange]').click();
  });
  await page.click('#arrangeView .aclip[data-clip="c93"]', { force: true });
  await page.evaluate(() => [...document.querySelectorAll('#arrangeView .view-tools button')].find((b) => b.textContent === 'BPM…').click());
  await page.waitForSelector('#dlg .clip-tempo');
  const dlgText = await page.textContent('#dlg .clip-tempo');
  await page.screenshot({ path: path.join(shots, 'desktop-clip-tempo.png') });
  await page.click('#dlg button[value=ok]');
  await sleep(200);
  const ct = await page.evaluate(() => { const { S, engine } = __daw; const c = S.project.tracks[0].arrangement.find((x) => x.id === 'c93'); const db = c.start + 0.2, bar = engine.barDur; const e = ((db % bar) + bar) % bar; return { bpm: S.project.bpm, start: c.start, clipBpm: c.bpm, barErrMs: +(Math.min(e, bar - e) * 1000).toFixed(1) }; });
  ok('Clip BPM detection finds 93 BPM', /93\.\d BPM/.test(dlgText) && Math.abs(ct.clipBpm - 93) < 0.3, dlgText.slice(0, 80));
  ok('"Set project tempo from clip" sets 93 BPM and aligns the clip\'s downbeat to a bar line', Math.abs(ct.bpm - 93) < 0.3 && ct.barErrMs < 15, JSON.stringify(ct));

  // ---- tier gating: Basic keeps tap tempo, gates detection
  await page.evaluate(async () => { const m = await import('./js/tiers.js'); m.setTier('basic'); });
  await page.click('.views button[data-view=session]');
  await page.click('#btnTempo'); await page.waitForSelector('.tempo-pop');
  const lockB = await page.isVisible('.tempo-pop .lock');
  await page.click('.tempo-pop .tp-detect');
  const gated = await page.isVisible('#dlg[open]');
  await page.screenshot({ path: path.join(shots, 'desktop-tempo-basic-locked.png') });
  await page.keyboard.press('Escape'); await page.mouse.click(5, 790);
  const before = await page.evaluate(() => __daw.S.project.bpm);
  for (let i = 0; i < 4; i++) { await page.dispatchEvent('#btnTap', 'pointerdown'); await sleep(400); }
  const tapB = await page.evaluate(() => __daw.S.project.bpm);
  ok('Tiers: Basic shows 🔒 on auto-timing and gates Detect; tap tempo still works', lockB && gated && Math.abs(tapB - 150) < 3 && tapB !== before, JSON.stringify({ lockB, gated, tapB }));
  await page.evaluate(async () => { const m = await import('./js/tiers.js'); m.setTier('large'); });
  await ctx.close();

  // ---- phone: transport stays compact
  const ph = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ph.page.evaluate(INJECT); await ph.page.evaluate(() => { __daw.engine.startTempoListen(); __clicks(() => 124, 12, 0.1); });
  await sleep(6000);
  await ph.page.tap('#btnTempo').catch(() => ph.page.click('#btnTempo')); await ph.page.waitForSelector('.tempo-pop'); await sleep(800);
  const phoneEst = await ph.page.evaluate(() => { const e = __daw.engine.tempo.est; return e && { bpm: +e.bpm.toFixed(1), conf: +e.confidence.toFixed(2) }; });
  await ph.page.screenshot({ path: path.join(shots, 'phone-tempo-popover.png') });
  ok('Phone: live tempo readout works in the popover (124 BPM input)', phoneEst && Math.abs(phoneEst.bpm - 124) < 1, JSON.stringify(phoneEst));
  await ph.ctx.close();
} catch (e) { ok('tempo test run completed without exception', false, e.message.slice(0, 600)); }
ok('No console errors / page errors (tempo run)', errors.length === 0, errors.slice(0, 5).join(' | '));
const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} tempo e2e checks passed`);
fs.writeFileSync(path.join(ROOT, 'tests/last-results-tempo.json'), JSON.stringify(results, null, 1));
await browser.close(); server.kill(); process.exit(pass === results.length ? 0 : 1);
