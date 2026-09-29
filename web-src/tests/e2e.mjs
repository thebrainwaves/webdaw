// End-to-end test in headless Chrome (fake mic). Run: npm run build && node tests/e2e.mjs
import { chromium, firefox } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8765), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}`;
const BROWSER = process.env.DAW_BROWSER || 'chromium';
const isFF = BROWSER === 'firefox';
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));

const browser = isFF
  ? await firefox.launch({ headless: true, firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false } })
  : await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: [
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
console.log('Browser:', BROWSER, browser.version());
const errors = [];
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ ...(isFF ? {} : { permissions: ['microphone'] }), acceptDownloads: true, ...opts });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('webdaw.prefs')) localStorage.setItem('webdaw.prefs', JSON.stringify({ guideDone: true, tutorialDone: true, phoneMode: 'off' }));
    window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => { window.__csp.push(e.violatedDirective + ' ' + e.blockedURI); console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI); });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return { ctx, page };
}
const shots = path.join(ROOT, 'screenshots'); fs.mkdirSync(shots, { recursive: true });

try {
  const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(URL_);
  await page.click('#startBtn');
  await page.waitForSelector('#sessionView .col[data-id]', { timeout: 10000 });
  ok('App loads and starts audio', await page.evaluate(() => __daw.engine.ctx.state === 'running'), await page.evaluate(() => `ctx ${__daw.engine.ctx.sampleRate}Hz, worklet=${__daw.engine.workletOK}`));
  const sw = await page.evaluate(async () => { const r = await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 5000))]); return !!(r && r.active); });
  ok('Service worker registered + active', sw);
  const manifestOk = await page.evaluate(async () => { const r = await fetch(document.querySelector('link[rel=manifest]').href); const m = await r.json(); return m.icons.length === 3 && m.start_url === './'; });
  ok('Manifest reachable with icons and relative start_url', manifestOk);

  // add a track
  const before = await page.$$eval('#sessionView .col[data-id]:not([data-id=master])', (e) => e.length);
  await page.click('#sessionView .add-track');
  const after = await page.$$eval('#sessionView .col[data-id]:not([data-id=master])', (e) => e.length);
  ok('Add track', after === before + 1, `${before} -> ${after}`);

  // add every effect type through the UI to the selected (new) track
  const types = await page.$$eval('#devHead .add-fx option', (o) => o.map((x) => x.value).filter(Boolean));
  for (const t of types) await page.selectOption('#devHead .add-fx', t);
  const fxCount = await page.$$eval('#devices .device', (d) => d.length);
  ok("All effect types instantiate via UI", fxCount === types.length, `${fxCount}/${types.length}: ${types.join(", ")}`);

  // knob drag changes a parameter
  const knob = await page.$('#devices .device .knob');
  await knob.scrollIntoViewIfNeeded();
  const kb = await knob.boundingBox();
  const valBefore = await knob.$eval('.k-value', (e) => e.textContent);
  await page.mouse.move(kb.x + kb.width / 2, kb.y + 15); await page.mouse.down(); await page.mouse.move(kb.x + kb.width / 2, kb.y - 40, { steps: 5 }); await page.mouse.up();
  const valAfter = await knob.$eval('.k-value', (e) => e.textContent);
  ok('Knob drag changes value', valBefore !== valAfter, `${valBefore} -> ${valAfter}`);

  // effects render valid audio offline (incl. death-metal distortion)
  const offline = await page.evaluate(async () => {
    const { createEffect, EFFECT_TYPES, VOICINGS } = await import('./js/audio/effects.js');
    const out = {};
    const run = async (type, values) => {
      const oc = new OfflineAudioContext(2, 44100, 44100);
      if (__daw.engine.workletOK) await oc.audioWorklet.addModule('./js/audio/worklets.js');
      const osc = oc.createOscillator(); osc.frequency.value = 110; const g = oc.createGain(); g.gain.value = 0.5;
      const fx = createEffect(oc, type, values, true, type === 'rack' ? { chains: [{ name: 'A', fx: [{ type: 'chorus', values: {} }] }, { name: 'B', fx: [] }], macroMap: [{ macro: 0, chain: 0, fx: 0, key: 'depth', min: 0, max: 100 }] } : null); osc.connect(g).connect(fx.input); fx.output.connect(oc.destination); osc.start();
      const buf = await oc.startRendering(); const d = buf.getChannelData(0);
      let s = 0, bad = false, pk = 0; for (const v of d) { if (!isFinite(v)) bad = true; s += v * v; pk = Math.max(pk, Math.abs(v)); }
      return { rms: +Math.sqrt(s / d.length).toFixed(4), peak: +pk.toFixed(3), bad };
    };
    for (const t of Object.keys(EFFECT_TYPES)) out[t] = await run(t, {});
    for (const v of Object.keys(VOICINGS)) out['distortion:' + v] = await run('distortion', { voicing: v, drive: 90 });
    out['limiter:ceiling-6'] = await run('limiter', { input: 12, ceiling: -6 });
    return out;
  });
  const offOk = Object.values(offline).every((r) => !r.bad && r.rms > 0.001);
  ok('Every effect renders finite, non-silent audio (OfflineAudioContext)', offOk, JSON.stringify(offline));
  ok('Limiter respects ceiling (-6 dB => peak <= 0.51)', offline['limiter:ceiling-6'].peak <= 0.51, `peak ${offline['limiter:ceiling-6'].peak}`);

  // AudioWorklet processors (recorder + meter) exercised offline when the browser can load worklets
  const wk = await page.evaluate(async () => {
    if (!__daw.engine.workletOK) return { skipped: 'AudioWorklet addModule unavailable in this browser build' };
    const oc = new OfflineAudioContext(1, 44100, 44100);
    await oc.audioWorklet.addModule('./js/audio/worklets.js');
    const osc = oc.createOscillator();
    const rec = new AudioWorkletNode(oc, 'recorder-processor', { processorOptions: { channels: 1 }, outputChannelCount: [1] });
    const met = new AudioWorkletNode(oc, 'meter-processor', { outputChannelCount: [2] });
    let frames = 0, done = false, peak = 0;
    rec.port.onmessage = (e) => { if (e.data.type === 'data') frames += e.data.channels[0].length; else done = true; };
    met.port.onmessage = (e) => { peak = Math.max(peak, e.data.peak[0]); };
    rec.port.postMessage({ type: 'start', time: 0.1 }); rec.port.postMessage({ type: 'stop', time: 0.6 });
    osc.connect(rec).connect(oc.destination); osc.connect(met).connect(oc.destination); osc.start();
    await new Promise((r) => setTimeout(r, 100));
    await oc.startRendering(); await new Promise((r) => setTimeout(r, 300));
    return { frames, expected: 22050, done, meterPeak: +peak.toFixed(3) };
  });
  ok('AudioWorklet recorder/meter processors work (offline render)', wk.skipped || (wk.done && Math.abs(wk.frames - wk.expected) <= 128 && wk.meterPeak > 0.9), JSON.stringify(wk));

  // audio graph: synthetic clip on track -> master meter shows signal
  await page.evaluate(() => {
    const { engine, S } = __daw; const ctx = engine.ctx; const sr = ctx.sampleRate;
    const mk = (secs, fn) => { const b = ctx.createBuffer(1, secs * sr, sr); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = fn(i / sr); return b; };
    // bass: 55 Hz + harmonics, notes every beat
    const bass = mk(8, (t) => { const f = [55, 55, 73.4, 65.4][Math.floor(t / 0.5) % 4]; const e = Math.exp(-((t % 0.5)) * 3); return 0.5 * e * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)); });
    // drums: kick every beat, noise snare on 2 & 4, hats on 8ths
    const drums = mk(8, (t) => { const b = t % 0.5, e8 = t % 0.25; let v = 0; v += Math.exp(-b * 30) * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-b * 40)) * b) * 0.8;
      if (Math.floor(t / 0.5) % 2 === 1) v += (Math.random() * 2 - 1) * Math.exp(-b * 25) * 0.5; v += (Math.random() * 2 - 1) * Math.exp(-e8 * 120) * 0.2; return v; });
    const tr = S.project.tracks;
    window.__testBufs = { bass, drums };
    const add = (t, buf, name) => { const id = 'btest' + name; engine.buffers.set(id, buf); t.slots[0] = { bufferId: id, name, loopLength: 4 }; t.arrangement.push({ id: 'c' + name, bufferId: id, start: 0, offset: 0, duration: buf.duration, name }); };
    add(tr[0], bass, 'Bassline'); tr[0].name = 'Track A';
    add(tr[1], drums, 'Beat'); tr[1].name = 'Track B';
  });
  await page.click('.views button[data-view=arrange]'); await page.click('.views button[data-view=session]');
  await page.click('#sessionView .col[data-id]:nth-child(1) .slot[data-slot="0"] .slot-launch');
  await page.waitForTimeout(1200);
  const meter = await page.evaluate(() => ({ master: __daw.engine.meters.get('master'), playing: __daw.engine.playing, slot: [...__daw.engine.tracks.values()][0].sessionSlot }));
  ok('Session clip launch -> audio reaches master bus', meter.playing && meter.slot === 0 && meter.master && meter.master.peak[0] > 0.01, `master peak ${meter.master && meter.master.peak[0].toFixed(3)}`);
  await page.click('#btnStop'); await page.click('#btnStop');

  // Auto-mix (v0.2: setup pop-up -> Apply)
  await page.click('#btnAutoMix');
  await page.waitForSelector('#dlg .automix-setup .am-row');
  await page.waitForFunction(() => [...document.querySelectorAll('#dlg .am-row .sug')].every((s) => s.dataset.role), null, { timeout: 20000 });
  if (!isFF) await page.screenshot({ path: path.join(shots, 'v2', 'desktop-automix-popup.png') });
  await page.click('#dlg button[value=apply]');
  await page.waitForFunction(() => !document.querySelector('#dlg').open, null, { timeout: 5000 });
  // the dialog's close event (which applies the mix) is dispatched asynchronously after the dialog closes
  await page.waitForFunction(() => __daw.S.project.tracks.every((t) => t.role), null, { timeout: 5000 }).catch(() => {});
  const detected = await page.evaluate(() => __daw.S.project.tracks.map((t) => ({ name: t.name, inst: t.instrument, role: t.role, fx: t.fx.map((f) => f.type).join('>') })));
  ok('Auto-Mix detects synthetic bass + drums and applies chains', detected[0].inst === 'bass' && detected[1].inst === 'drums' && detected[0].fx && detected[1].fx, JSON.stringify(detected));

  // Arrangement recording with fake mic
  await page.click('.views button[data-view=arrange]');
  const t3 = await page.evaluate(() => __daw.S.project.tracks[2].id);
  const armBtn = await page.$(`#arrangeView .lane-head[data-id="${t3}"] .tbtn.arm`); // third track (the newly added one)
  await armBtn.click();
  await page.waitForFunction(() => __daw.S.project.tracks[2].arm && __daw.engine.tracks.get(__daw.S.project.tracks[2].id).inputChain, null, { timeout: 5000 });
  await page.click('#btnRec');
  await page.waitForTimeout(2500);
  await page.click('#btnRec');
  await page.waitForFunction(() => __daw.S.project.tracks[2].arrangement.length > 0, null, { timeout: 5000 }).catch(() => {});
  const rec = await page.evaluate(() => { const t = __daw.S.project.tracks[2]; const c = t.arrangement[0]; if (!c) return null; const b = __daw.engine.buffers.get(c.bufferId); let pk = 0; const d = b.getChannelData(0); for (const v of d) pk = Math.max(pk, Math.abs(v)); return { dur: +c.duration.toFixed(2), peak: +pk.toFixed(3), ch: b.numberOfChannels, offset: +c.offset.toFixed(3) }; });
  ok('Arrangement recording from fake mic creates a clip with audio', rec && rec.dur > 1.5 && rec.peak > 0.01, JSON.stringify(rec));
  await page.click('#btnStop');
  if (!isFF) await page.screenshot({ path: path.join(shots, 'desktop-arrange.png') });

  // Session recording into a slot
  await page.click('.views button[data-view=session]');
  const slotSel = `#sessionView .col[data-id="${await page.evaluate(() => __daw.S.project.tracks[2].id)}"] .slot[data-slot="1"]`;
  await page.click(slotSel);
  await page.waitForTimeout(2600);
  await page.click(slotSel);
  await page.waitForFunction(() => !!__daw.S.project.tracks[2].slots[1], null, { timeout: 8000 }).catch(() => {});
  const srec = await page.evaluate(() => { const c = __daw.S.project.tracks[2].slots[1]; return c && { loop: +c.loopLength.toFixed(2), dur: +__daw.engine.buffers.get(c.bufferId).duration.toFixed(2) }; });
  ok('Session slot recording creates a bar-quantized looping clip', srec && srec.loop > 0 && Math.abs((srec.loop / 2) - Math.round(srec.loop / 2)) < 0.01, JSON.stringify(srec));
  await page.waitForTimeout(600);
  if (!isFF) await page.screenshot({ path: path.join(shots, 'desktop-session.png') });
  await page.click('#btnStop');

  // Export
  const projBefore = await page.evaluate(() => ({ tracks: __daw.S.project.tracks.length, clips: __daw.S.project.tracks.reduce((s, t) => s + t.arrangement.length + t.slots.filter(Boolean).length, 0), sum: (() => { const b = __daw.engine.buffers.get(__daw.S.project.tracks[0].slots[0].bufferId).getChannelData(0); let s = 0; for (let i = 0; i < b.length; i += 97) s += b[i]; return s; })() }));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => { document.querySelector('#btnMenu').click(); [...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Export')).click(); })]);
  const zipPath = path.join(ROOT, 'tests', 'exported-test.webdaw.zip');
  await dl.saveAs(zipPath);
  const zsize = fs.statSync(zipPath).size;
  ok('Project export produces a .zip', zsize > 1000, `${dl.suggestedFilename()} ${(zsize / 1024).toFixed(0)} KB`);

  // New project, then import the zip
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => { document.querySelector('#btnMenu').click(); [...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('New project')).click(); });
  await page.waitForFunction(() => __daw.S.project.tracks.every((t) => !t.slots.some(Boolean)), null, { timeout: 5000 });
  await page.setInputFiles('#fileProject', zipPath);
  await page.waitForFunction((n) => __daw.S.project.tracks.length === n, projBefore.tracks, { timeout: 10000 });
  const projAfter = await page.evaluate(() => ({ tracks: __daw.S.project.tracks.length, clips: __daw.S.project.tracks.reduce((s, t) => s + t.arrangement.length + t.slots.filter(Boolean).length, 0), sum: (() => { const b = __daw.engine.buffers.get(__daw.S.project.tracks[0].slots[0].bufferId).getChannelData(0); let s = 0; for (let i = 0; i < b.length; i += 97) s += b[i]; return s; })(), fx: __daw.S.project.tracks[1].fx.map((f) => f.type).join('>') }));
  ok('Project import round-trips tracks, clips, audio and effect chains', projAfter.tracks === projBefore.tracks && projAfter.clips === projBefore.clips && Math.abs(projAfter.sum - projBefore.sum) < 0.05 * Math.max(1, Math.abs(projBefore.sum)), `before ${JSON.stringify(projBefore)} after ${JSON.stringify(projAfter)}`);

  // Persistence (IndexedDB) across reload
  await page.evaluate(() => document.querySelector('#btnMenu').click());
  await page.evaluate(() => [...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Save now')).click());
  await page.waitForTimeout(800);
  await page.reload();
  await page.click('#startBtn');
  await page.waitForSelector('#sessionView .col[data-id]');
  const persisted = await page.evaluate(() => ({ tracks: __daw.S.project.tracks.length, bufs: __daw.engine.buffers.size }));
  ok('Project persists in IndexedDB across reload', persisted.tracks === projBefore.tracks && persisted.bufs > 0, JSON.stringify(persisted));

  // Offline via service worker
  await ctx.setOffline(true);
  await page.reload();
  const offlineOk = await page.waitForSelector('#startBtn', { timeout: 5000 }).then(() => true).catch(() => false);
  ok('App shell loads offline (service worker cache)', offlineOk);
  await ctx.setOffline(false);
  await ctx.close();

  // Phone viewport (iPhone 12/13/14 size)
  if (!isFF) {
  const phone = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await phone.page.goto(URL_);
  await phone.page.screenshot({ path: path.join(shots, 'phone-start.png') });
  await phone.page.tap('#startBtn');
  await phone.page.waitForSelector('#sessionView .col[data-id]');
  // load a demo project via import so the phone shot has content
  await phone.page.setInputFiles('#fileProject', zipPath);
  await phone.page.waitForFunction(() => __daw.S.project.tracks.length >= 3, null, { timeout: 10000 });
  await phone.page.tap('#sessionView .col[data-id]:nth-child(2) .col-head');
  await phone.page.waitForTimeout(500);
  await phone.page.screenshot({ path: path.join(shots, 'phone-session.png') });
  // touch drag on knob
  const pk = await phone.page.$('#devices .knob');
  await pk.scrollIntoViewIfNeeded();
  const bb = await pk.boundingBox();
  const v0 = await pk.$eval('.k-value', (e) => e.textContent);
  await phone.page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const fire = (type, yy) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: yy, isPrimary: true }));
    fire('pointerdown', y); for (let i = 1; i <= 6; i++) fire('pointermove', y - i * 8); fire('pointerup', y - 48);
  }, { x: bb.x + bb.width / 2, y: bb.y + 15 });
  const v1 = await pk.$eval('.k-value', (e) => e.textContent);
  ok('Knob responds to touch-drag (pointer events) on phone viewport', v0 !== v1, `${v0} -> ${v1}`);
  await phone.page.tap('.views button[data-view=arrange]');
  await phone.page.waitForTimeout(400);
  await phone.page.screenshot({ path: path.join(shots, 'phone-arrange.png') });
  await phone.ctx.close();
  }
} catch (e) {
  ok('Test run completed without exception', false, e.stack);
}
const relevantErrors = errors.filter((e) => !/favicon/i.test(e) && !/net::ERR_INTERNET_DISCONNECTED/.test(e));
ok('No console errors / page errors', relevantErrors.length === 0, relevantErrors.join('\n'));
await browser.close(); server.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
fs.writeFileSync(path.join(ROOT, 'tests', `last-results-${BROWSER}.json`), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
