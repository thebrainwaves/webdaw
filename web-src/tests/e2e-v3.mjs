// v0.3 feature tests (headless Chromium): phone mode, tutorial, theme, waveforms/clip detail, free clip placement.
// Run after `node tools/build.mjs`: node tests/e2e-v3.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8768), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 700) : ''}`); };
const shots = path.join(ROOT, 'screenshots', 'v3'); fs.mkdirSync(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(shots, name + '.png') });
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ headless: true, ...(process.env.DAW_BROWSER ? { executablePath: process.env.DAW_BROWSER } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const errors = [];
const DONE = { guideDone: true, tutorialDone: true, phoneMode: 'off' };
async function newPage(opts = {}, prefs = DONE) {
  const ctx = await browser.newContext({ permissions: ['microphone'], ...opts });
  await ctx.addInitScript((prefs) => { if (prefs && !localStorage.getItem('webdaw.prefs')) localStorage.setItem('webdaw.prefs', JSON.stringify(prefs)); window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective)); }, prefs);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Refused to execute inline script|Executing inline script violates/.test(m.text())) errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return { ctx, page };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function start(page) { await page.goto(URL_); await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(300); }
// helpers injected into the page (CSP blocks inline scripts, so evaluate a string)
const HELPERS = `
window.__mkBuf = (id, secs, stereo = true, f = 110) => { const { engine } = __daw; const sr = engine.ctx.sampleRate; const b = engine.ctx.createBuffer(stereo ? 2 : 1, Math.round(sr * secs), sr);
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const t = i / sr, env = Math.exp(-(t % 0.5) * 8); d[i] = env * (c ? 0.4 : 0.8) * Math.sin(2 * Math.PI * f * (c + 1) * t); } }
  engine.buffers.set(id, b); return b; };
window.__wav = (secs = 1, sr = 22050) => { const n = Math.round(secs * sr), ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab); const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(12000 * Math.sin(2 * Math.PI * 330 * i / sr) * Math.exp(-(i / sr % 0.25) * 10)), true); return new File([ab], 'drop-test.wav', { type: 'audio/wav' }); };
window.__dropFile = (x, y, secs = 1, mods = {}) => { const dt = new DataTransfer(); dt.items.add(__wav(secs)); const el = document.elementFromPoint(x, y);
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt, ...mods }));
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt, ...mods })); return el.className; };
window.__pix = (cv) => { if (!cv || !cv.width) return 0; const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] + d[i + 1] + d[i + 2]) > 90) n++; return n; };
window.__snapState = () => JSON.stringify(__daw.S.project.tracks.map((t) => [t.id, t.arrangement.map((c) => [c.id, +c.start.toFixed(4), +c.duration.toFixed(4), +(c.offset || 0).toFixed(4)]).sort(), t.slots.map((s) => s ? (s.name || 'x') : null)]));
`;
const lanePoint = (page, trackIdx, sec) => page.evaluate(([i, sec]) => { const t = __daw.S.project.tracks[i]; const lane = document.querySelector(`#arrangeView .lane[data-id="${t.id}"]`); const content = lane.closest('.arr-content') || lane.parentElement;
  const sc = document.querySelector('#arrangeView .arr-scroll'); const r = content.getBoundingClientRect(), lr = lane.getBoundingClientRect(); return { x: r.left + sec * __daw.S.zoom, y: lr.top + lr.height / 2, zoom: __daw.S.zoom, scroll: sc.scrollLeft }; }, [trackIdx, sec]);
const clipBox = (page, id) => page.evaluate((id) => { const r = document.querySelector(`.aclip[data-clip="${id}"]`).getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; }, id);
async function dragMouse(page, from, to, { steps = 12, hold = 0, via = null, mods = [] } = {}) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  for (const m of mods) await page.keyboard.down(m);
  if (via) { await page.mouse.move(via.x, via.y, { steps }); await sleep(hold); }
  await page.mouse.move(to.x, to.y, { steps }); await sleep(60);
  await page.mouse.up(); for (const m of mods) await page.keyboard.up(m); await sleep(150);
}
const setView = (page, v) => page.evaluate((v) => document.querySelector(`.views button[data-view=${v}]`).click(), v);

try {
  // ======================================================================= desktop
  const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });
  await start(page); await page.evaluate(HELPERS);

  // ---- theme: no yellow/orange left on any rendered element; contrast of the new accents
  await page.evaluate(() => { __daw.S.project.tracks[0].fx.push({ type: 'compressor', enabled: true, values: {} }); __daw.engine.setTrackFx(__daw.S.project.tracks[0]); __daw.S.selected = __daw.S.project.tracks[0].id; });
  await page.evaluate(() => document.querySelector('#btnMetro') && document.querySelector('#btnMetro').click());
  const theme = await page.evaluate(() => {
    const parse = (s) => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(s || ''); return m && (m[4] == null || +m[4] > 0.15) ? [+m[1], +m[2], +m[3]] : null; };
    const hsl = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; if (!d) return [0, 0, l]; const s = d / (1 - Math.abs(2 * l - 1)); let hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [(hh * 60 + 360) % 360, s, l]; };
    const yellowish = (c) => { if (!c) return false; const [hh, s, l] = hsl(c); return hh >= 25 && hh <= 65 && s > 0.45 && l > 0.3 && l < 0.85; };
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!el.getClientRects().length) continue; const cs = getComputedStyle(el);
      for (const p of ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'fill', 'stroke', 'outlineColor']) { const c = parse(cs[p]); if (yellowish(c) && !(p.startsWith('border') && parseFloat(cs.borderTopWidth) === 0 && parseFloat(cs.borderLeftWidth) === 0) && !(p === 'outlineColor' && cs.outlineStyle === 'none')) bad.push(`${el.tagName}.${el.className}:${p}=${cs[p]}`); }
    }
    const lum = (hex) => { const n = parseInt(hex.replace('#', ''), 16); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); };
    const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const root = getComputedStyle(document.documentElement); const v = (k) => root.getPropertyValue(k).trim();
    const tc = __daw.S.project.tracks.map((t) => t.color);
    return { bad: bad.slice(0, 12), nbad: bad.length, accent: v('--accent'), rec: v('--rec'), hiOnBg: cr(v('--accent-hi'), v('--bg') || '#1e1e1e'), whiteOnDeep: cr('#ffffff', v('--accent-deep')), whiteOnRecDeep: cr('#ffffff', v('--rec-deep')),
      yellowTracks: tc.filter((c) => yellowish([parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)])),
      kgrad: !!document.querySelector('#kgrad'), knobStroke: (document.querySelector('.k-val') && getComputedStyle(document.querySelector('.k-val')).stroke) || '',
      theme: document.querySelector('meta[name=theme-color]').content };
  });
  ok('Theme: no yellow/orange computed colours on any visible element; purple primary + red record', theme.nbad === 0 && /8b5cf6/i.test(theme.accent) && /ef4444/i.test(theme.rec) && !theme.yellowTracks.length, JSON.stringify(theme));
  ok('Theme: contrast ≥ 4.5:1 (accent text on bg, white on purple, white on red) and knob arcs use the purple→red gradient', theme.hiOnBg >= 4.5 && theme.whiteOnDeep >= 4.5 && theme.whiteOnRecDeep >= 4.5 && theme.kgrad && /kgrad/.test(theme.knobStroke), JSON.stringify({ hi: theme.hiOnBg.toFixed(2), deep: theme.whiteOnDeep.toFixed(2), red: theme.whiteOnRecDeep.toFixed(2), stroke: theme.knobStroke }));
  await page.evaluate(() => document.querySelector('#btnMetro') && document.querySelector('#btnMetro').click());
  await shot(page, 'desktop-theme-session');

  // ---- waveforms in arrangement: clip colour, mipmap level follows zoom, stereo lanes
  await page.evaluate(() => { const { S, engine } = __daw; __mkBuf('bst', 8); const t = S.project.tracks[0];
    t.arrangement.push({ id: 'cA', bufferId: 'bst', start: 0, offset: 0, duration: 8, name: 'Stereo loop' }); t.slots[0] = { bufferId: 'bst', name: 'Loop', loopLength: 4 }; engine.rescheduleTrack(t); });
  await setView(page, 'arrange'); await sleep(400);
  const wz = [];
  for (const z of [8, 40, 200]) { await page.evaluate((z) => { __daw.S.zoom = z; document.querySelector('.views button[data-view=arrange]').click(); __daw.S.view = 'session'; document.querySelector('.views button[data-view=arrange]').click(); }, z); await sleep(350);
    wz.push(await page.evaluate(() => { const cv = document.querySelector('.aclip[data-clip="cA"] canvas'); return { block: +cv.dataset.block, spp: +cv.dataset.spp, lanes: +cv.dataset.lanes, pix: __pix(cv), h: cv.clientHeight }; })); }
  ok('Arrangement waveform: peak mipmap level follows zoom (block ≤ samples/pixel, finer when zoomed in) and is drawn', wz.every((w) => w.block <= Math.max(1, w.spp) && w.pix > 50) && wz[0].block > wz[2].block, JSON.stringify(wz));
  const lanes1 = await page.evaluate(() => { const cv = document.querySelector('.aclip[data-clip="cA"] canvas'); return { lanes: +cv.dataset.lanes, h: cv.clientHeight }; });
  await page.click('#arrangeView .lane-size'); await sleep(350);
  const lanes2 = await page.evaluate(() => { const cv = document.querySelector('.aclip[data-clip="cA"] canvas'); return { lanes: +cv.dataset.lanes, h: cv.clientHeight }; });
  ok('Stereo clip: one lane at the default track height, two L/R lanes once the track is tall enough (↕)', lanes1.h < 40 && lanes1.lanes === 1 && lanes2.h >= 40 && lanes2.lanes === 2, JSON.stringify({ lanes1, lanes2 }));
  await shot(page, 'desktop-arrangement-stereo-lanes');
  // ---- clip detail view
  const cbx = await clipBox(page, 'cA'); await page.mouse.click(cbx.x + 30, cbx.y); await sleep(400);
  const det = await page.evaluate(() => { const cv = document.querySelector('.clip-detail .clip-wave'); return { shown: !!document.querySelector('.clip-detail'), lanes: cv && +cv.dataset.lanes, pix: __pix(cv), over: !!document.querySelector('.clip-over'), tabs: [...document.querySelectorAll('.bottom-tabs button')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')) }; });
  ok('Selecting an audio clip opens the clip detail view (large stereo waveform + overlay, Clip|Devices tabs)', det.shown && det.lanes === 2 && det.pix > 500 && det.over && det.tabs.includes('Clip*'), JSON.stringify(det));
  await shot(page, 'desktop-clip-detail');
  // start marker drag changes offset/duration (one undo step)
  const mk = await page.evaluate(() => { const o = document.querySelector('.clip-detail .clip-over'); const r = o.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width, top: r.top }; });
  const before = await page.evaluate(() => { const c = __daw.S.project.tracks[0].arrangement.find((x) => x.id === 'cA'); return [c.offset || 0, c.duration, c.start]; });
  await page.mouse.move(mk.x + 3, mk.top + 8); await page.mouse.down(); await page.mouse.move(mk.x + mk.w * 0.25, mk.top + 8, { steps: 8 }); await page.mouse.up(); await sleep(200);
  const after = await page.evaluate(() => { const c = __daw.S.project.tracks[0].arrangement.find((x) => x.id === 'cA'); return [c.offset || 0, c.duration, c.start]; });
  await page.evaluate(() => __daw.history.undo()); await sleep(150);
  const undone = await page.evaluate(() => { const c = __daw.S.project.tracks[0].arrangement.find((x) => x.id === 'cA'); return [c.offset || 0, c.duration, c.start]; });
  ok('Clip detail: dragging the start marker trims the clip (offset ↑, duration ↓) and undoes in one step', after[0] > before[0] + 0.3 && after[1] < before[1] - 0.3 && Math.abs(undone[0] - before[0]) < 1e-6 && Math.abs(undone[1] - before[1]) < 1e-6, JSON.stringify({ before, after, undone }));
  // gain + transpose live on the playing source
  await page.evaluate(() => { __daw.engine.play(0); }); await sleep(500);
  const live = await page.evaluate(() => { const { S, engine } = __daw; const t = S.project.tracks[0]; const c = t.arrangement.find((x) => x.id === 'cA');
    c.transpose = 12; engine.updateClipLive(t, c, 'transpose'); c.gain = -6; engine.updateClipLive(t, c, 'gain');
    const n = engine.tracks.get(t.id); const srcs = (n.sources || []).map((s) => s.src || s.node || s).filter((s) => s && s.playbackRate);
    return { rates: srcs.map((s) => +s.playbackRate.value.toFixed(3)) }; });
  const tr = await page.evaluate(() => [...document.querySelectorAll('.clip-detail .clip-wave, .clip-detail .clip-over')].length);
  await sleep(700); await shot(page, 'desktop-arrangement-waveforms-playing');
  const scope = await page.evaluate(() => __pix(document.querySelector('#masterScope')));
  await page.evaluate(() => { __daw.engine.stop(); const t = __daw.S.project.tracks[0]; const c = t.arrangement.find((x) => x.id === 'cA'); c.transpose = 0; c.gain = 0; });
  ok('Transpose repitches the playing source (+12 st → playbackRate 2)', live.rates.length && live.rates.some((r) => Math.abs(r - 2) < 0.01), JSON.stringify(live));
  ok('Master oscilloscope in the header draws while playing', scope > 30, 'lit pixels ' + scope);
  { const b = await clipBox(page, 'cA'); await page.mouse.click(b.x + 30, b.y); await sleep(500); }
  const trans = await page.evaluate(() => { const o = document.querySelector('.clip-detail .clip-over'); return o ? __pix(o) : 0; });
  ok('Clip detail overlay draws markers / transients', trans > 20, 'overlay pixels ' + trans);

  // ---- live recording waveform (fake mic)
  await page.evaluate(async () => { const { S } = __daw; S.selected = S.project.tracks[1].id; }); await setView(page, 'arrange'); await sleep(200);
  const armed = await page.evaluate(async () => { const t = __daw.S.project.tracks[1]; const b = document.querySelector(`.lane-head[data-id="${t.id}"] .arm, .arr-heads [data-id="${t.id}"] .arm`); if (b) b.click(); else return 'no arm btn'; await new Promise((r) => setTimeout(r, 1200)); return t.arm; });
  await page.evaluate(() => document.querySelector('#btnRec').click()); await sleep(2200);
  const recw = await page.evaluate(() => { const el = document.querySelector('.rec-live'); const cv = el && (el.tagName === 'CANVAS' ? el : el.querySelector('canvas')); return { el: !!el, pix: __pix(cv), w: el ? el.getBoundingClientRect().width : 0, recording: __daw.engine.recording }; });
  await shot(page, 'desktop-live-recording');
  await page.evaluate(() => document.querySelector('#btnRec').click()); await sleep(1500);
  const recDone = await page.evaluate(() => ({ live: !!document.querySelector('.rec-live'), clips: __daw.S.project.tracks[1].arrangement.length }));
  ok('Live recording waveform scrolls in on the armed track while recording, replaced by the clip after stop', armed === true && recw.el && recw.pix > 20 && recw.w > 20 && !recDone.live && recDone.clips >= 1, JSON.stringify({ armed, recw, recDone }));
  await page.evaluate(async () => { const t = __daw.S.project.tracks[1]; const b = document.querySelector(`.arr-heads [data-id="${t.id}"] .arm`); if (b && t.arm) b.click(); });

  // ======================================================================= free placement
  // reset to a known layout: track0: A [0..8s] audio; track1: B (2 s) at 12 s; zoom 40 px/s; snap on
  await page.evaluate(() => { const { S, engine } = __daw; __mkBuf('bB', 2, false, 220);
    S.project.tracks[1].arrangement = [{ id: 'cB', bufferId: 'bB', start: 12, offset: 0, duration: 2, name: 'B' }];
    S.project.tracks[0].arrangement = [{ id: 'cA', bufferId: 'bst', start: 0, offset: 0, duration: 8, name: 'A' }];
    S.project.tracks.forEach((t) => engine.rescheduleTrack(t)); S.zoom = 40; S.project.tracks[0].height = 80; S.sel = null; localStorage.setItem('x', '1'); });
  await page.evaluate(() => { const p = document.querySelector('#seqPanel'); if (p && p.classList.contains('open')) p.querySelector('.sqp-tog').click(); }); await sleep(150);
  await setView(page, 'session'); await setView(page, 'arrange'); await sleep(300);
  const beat = await page.evaluate(() => __daw.engine.beatDur);
  // 1) move B from track 1 to track 0 into the middle of A (snap on): A is split around B
  let b0 = await clipBox(page, 'cB'); let tgt = await lanePoint(page, 0, 3.1);
  const s0 = await page.evaluate(() => __snapState());
  await dragMouse(page, { x: b0.x + 15, y: b0.y }, { x: tgt.x + 15, y: tgt.y });
  const m1 = await page.evaluate(() => { const [a, b] = __daw.S.project.tracks; return { t0: a.arrangement.map((c) => [c.id === 'cA' ? 'A' : c.id === 'cB' ? 'B' : 'A2', +c.start.toFixed(3), +c.duration.toFixed(3), +(c.offset || 0).toFixed(3)]).sort((x, y) => x[1] - y[1]), t1: b.arrangement.length }; });
  const bStart = m1.t0.find((x) => x[0] === 'B'); const snapped = bStart && Math.abs(bStart[1] / beat - Math.round(bStart[1] / beat)) < 1e-3;
  const split = m1.t0.length === 3 && m1.t0[0][0] === 'A' && Math.abs(m1.t0[0][2] - bStart[1]) < 1e-3 && m1.t0[2][0] === 'A2' && Math.abs(m1.t0[2][1] - (bStart[1] + 2)) < 1e-3 && Math.abs(m1.t0[2][3] - (bStart[1] + 2)) < 1e-3;
  ok('Drag a clip to another track (snap on → beat grid); the clip underneath is split around it', m1.t1 === 0 && snapped && split, JSON.stringify({ beat, m1 }));
  await page.evaluate(() => __daw.history.undo()); await sleep(200);
  ok('…and the move + trim is one undo step', (await page.evaluate(() => __snapState())) === s0);
  // 2) snap off → exact non-grid position; head-trim of A
  await page.click('#arrangeView .snap-btn'); await sleep(100);
  b0 = await clipBox(page, 'cB'); tgt = await lanePoint(page, 0, 7.13);
  await dragMouse(page, { x: b0.x + 15, y: b0.y }, { x: tgt.x + 15, y: tgt.y });
  const m2 = await page.evaluate(() => { const t = __daw.S.project.tracks[0]; const b = t.arrangement.find((c) => c.id === 'cB'), a = t.arrangement.find((c) => c.id === 'cA'); return { b: b && +b.start.toFixed(3), a: a && [a.start, +a.duration.toFixed(3)] }; });
  ok('Snap off: clip lands at an exact non-grid position (7.13 s) and the clip underneath is tail-trimmed', m2.b != null && Math.abs(m2.b - 7.13) < 0.03 && Math.abs(m2.b / beat - Math.round(m2.b / beat)) > 0.02 && Math.abs(m2.a[1] - m2.b) < 1e-3, JSON.stringify({ m2, beat }));
  await page.evaluate(() => __daw.history.undo()); await page.click('#arrangeView .snap-btn'); await sleep(200);
  // 3) snap on + Alt held → temporary bypass
  b0 = await clipBox(page, 'cB'); tgt = await lanePoint(page, 1, 5.37);
  await dragMouse(page, { x: b0.x + 15, y: b0.y }, { x: tgt.x + 15, y: tgt.y }, { mods: ['Alt'] });
  const m3 = await page.evaluate(() => { const b = __daw.S.project.tracks[1].arrangement.find((c) => c.id === 'cB'); return b && +b.start.toFixed(3); });
  ok('Snap on + Alt held while dropping places freely (no grid)', m3 != null && Math.abs(m3 - 5.37) < 0.03, JSON.stringify({ m3 }));
  await page.evaluate(() => __daw.history.undo()); await sleep(200);
  // 4) full cover removes; drop on the empty lane creates a new track
  await page.evaluate(() => { const { S, engine } = __daw; S.project.tracks[0].arrangement.push({ id: 'cS', bufferId: 'bB', start: 12.5, offset: 0, duration: 1, name: 'small' }); engine.rescheduleTrack(S.project.tracks[0]); S.view = 'session'; document.querySelector('.views button[data-view=arrange]').click(); });
  await sleep(250); b0 = await clipBox(page, 'cB'); tgt = await lanePoint(page, 0, 12);
  await dragMouse(page, { x: b0.x + 12, y: b0.y }, { x: tgt.x + 12, y: tgt.y });
  const m4 = await page.evaluate(() => __daw.S.project.tracks[0].arrangement.map((c) => c.id));
  ok('A clip fully covered by the dropped clip is removed', m4.includes('cB') && !m4.includes('cS'), JSON.stringify(m4));
  const nTracks = await page.evaluate(() => __daw.S.project.tracks.length);
  b0 = await clipBox(page, 'cB'); const nl = await page.evaluate(() => { const r = document.querySelector('#arrangeView .lane.drop-new').getBoundingClientRect(); return { y: r.top + r.height / 2 }; });
  await dragMouse(page, { x: b0.x + 12, y: b0.y }, { x: b0.x + 12 + 80, y: nl.y });
  const m5 = await page.evaluate(() => { const T = __daw.S.project.tracks; const last = T[T.length - 1]; return { n: T.length, lastClips: last.arrangement.map((c) => c.id), kind: last.kind }; });
  ok('Dropping a clip on empty space below the tracks creates a new track with it', m5.n === nTracks + 1 && m5.lastClips.includes('cB') && m5.kind === 'audio', JSON.stringify(m5));
  await page.evaluate(() => { __daw.history.undo(); __daw.history.undo(); }); await sleep(200);
  // 5) arrangement → session: hover the Session tab, drop on a slot
  const sBefore = await page.evaluate(() => __snapState());
  b0 = await clipBox(page, 'cB');
  const sessTab = await page.evaluate(() => { const r = document.querySelector('.views button[data-view=session]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(b0.x + 15, b0.y); await page.mouse.down(); await page.mouse.move(sessTab.x, sessTab.y, { steps: 10 }); await sleep(700);
  const inSession = await page.evaluate(() => __daw.S.view);
  const slotPt = await page.evaluate(() => { const t = __daw.S.project.tracks[0]; const s = document.querySelector(`#sessionView .col[data-id="${t.id}"] .slot[data-slot="2"]`); const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(slotPt.x, slotPt.y, { steps: 8 }); await sleep(80);
  await shot(page, 'desktop-drag-to-session');
  await page.mouse.up(); await sleep(250);
  const m6 = await page.evaluate(() => { const [a, b] = __daw.S.project.tracks; const s = a.slots[2]; return { slot: s && { name: s.name, ls: s.loopStart, ll: +(s.loopLength || 0).toFixed(3), buf: s.bufferId }, stillInArr: b.arrangement.some((c) => c.id === 'cB') }; });
  ok('Arrangement → Session: drag a clip onto the Session tab, then onto a slot (moves it, keeps region)', inSession === 'session' && m6.slot && m6.slot.buf === 'bB' && Math.abs(m6.slot.ll - 2) < 1e-3 && !m6.stillInArr, JSON.stringify({ inSession, m6 }));
  await shot(page, 'desktop-session-after-drop');
  // 6) session slot → another track's slot
  const from = slotPt; const to = await page.evaluate(() => { const t = __daw.S.project.tracks[1]; const s = document.querySelector(`#sessionView .col[data-id="${t.id}"] .slot[data-slot="3"]`); const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await dragMouse(page, from, to);
  const m7 = await page.evaluate(() => { const [a, b] = __daw.S.project.tracks; return { a2: !!a.slots[2], b3: b.slots[3] && b.slots[3].bufferId }; });
  ok('Session slot → slot on another track (drag)', !m7.a2 && m7.b3 === 'bB', JSON.stringify(m7));
  // 7) session → arrangement: hover the Arrange tab, drop on a lane at a position
  const arrTab = await page.evaluate(() => { const r = document.querySelector('.views button[data-view=arrange]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(to.x, to.y); await page.mouse.down(); await page.mouse.move(arrTab.x, arrTab.y, { steps: 10 }); await sleep(700);
  const inArr = await page.evaluate(() => __daw.S.view);
  tgt = await lanePoint(page, 1, 20.1);
  await page.mouse.move(tgt.x, tgt.y, { steps: 8 }); await sleep(80); await page.mouse.up(); await sleep(250);
  const m8 = await page.evaluate(() => { const b = __daw.S.project.tracks[1]; const c = b.arrangement.find((x) => x.bufferId === 'bB'); return { c: c && [+c.start.toFixed(3), +c.duration.toFixed(3)], slot: !!b.slots[3] }; });
  ok('Session → Arrangement: drag a slot clip onto the Arrange tab, then onto a lane (snapped position)', inArr === 'arrange' && m8.c && Math.abs(m8.c[1] - 2) < 1e-3 && Math.abs(m8.c[0] / beat - Math.round(m8.c[0] / beat)) < 1e-3 && Math.abs(m8.c[0] - 20.1) < beat && !m8.slot, JSON.stringify({ inArr, m8 }));
  for (let i = 0; i < 3; i++) await page.evaluate(() => __daw.history.undo());
  await sleep(200);
  ok('All three cross-view moves undo back to the original layout', (await page.evaluate(() => __snapState())) === sBefore);
  // 8) Pick up & place (touch-friendly flow, exercised with the context menu)
  await setView(page, 'arrange'); await sleep(200); b0 = await clipBox(page, 'cB');
  await page.mouse.click(b0.x + 5, b0.y, { button: 'right' }); await sleep(150);
  await page.click('text=Pick up / move'); await sleep(150);
  tgt = await lanePoint(page, 0, 16);
  await page.mouse.click(tgt.x + 3, tgt.y); await sleep(150);
  await shot(page, 'desktop-pick-up-place');
  const bar = await page.evaluate(() => ({ bar: !!document.querySelector('.carry-bar'), where: (document.querySelector('.carry-where') || {}).textContent }));
  await page.click('.carry-place'); await sleep(250);
  const m9 = await page.evaluate(() => { const c = __daw.S.project.tracks[0].arrangement.find((x) => x.id === 'cB'); return c && +c.start.toFixed(3); });
  ok('Pick up → tap a position → “Place here” moves the clip', bar.bar && m9 != null && Math.abs(m9 - 16) < 0.3, JSON.stringify({ bar, m9 }));
  await page.evaluate(() => __daw.history.undo()); await sleep(150);
  // 9) audio files dropped anywhere
  const nT0 = await page.evaluate(() => __daw.S.project.tracks.length);
  tgt = await lanePoint(page, 1, 9.3);
  await page.evaluate(([x, y]) => __dropFile(x, y, 1, { altKey: true }), [tgt.x, tgt.y]); await sleep(900);
  const f1 = await page.evaluate(() => { const c = __daw.S.project.tracks[1].arrangement.find((x) => x.name === 'drop-test'); return c && +c.start.toFixed(3); });
  const nlp = await page.evaluate(() => { const r = document.querySelector('#arrangeView .lane.drop-new').getBoundingClientRect(); return [r.left + 200, r.top + r.height / 2]; });
  await page.evaluate(([x, y]) => __dropFile(x, y, 1), nlp); await sleep(900);
  const f2 = await page.evaluate(() => __daw.S.project.tracks.length);
  await setView(page, 'session'); await sleep(250);
  const sp = await page.evaluate(() => { const t = __daw.S.project.tracks[0]; const s = document.querySelector(`#sessionView .col[data-id="${t.id}"] .slot[data-slot="4"]`); const r = s.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.evaluate(([x, y]) => __dropFile(x, y, 1), sp); await sleep(900);
  const f3 = await page.evaluate(() => { const s = __daw.S.project.tracks[0].slots[4]; return s && s.name; });
  const ep = await page.evaluate(() => { const g = document.querySelector('#sessionView .add-col').getBoundingClientRect(); return [g.left + g.width / 2, g.bottom - 10]; });
  await page.evaluate(([x, y]) => __dropFile(x, y, 1), ep); await sleep(900);
  const f4 = await page.evaluate(() => { const T = __daw.S.project.tracks; const l = T[T.length - 1]; return { n: T.length, slot: l.slots.findIndex((s) => s && s.name === 'drop-test') }; });
  ok('Audio file dropped on a track at an exact time (Alt = no snap)', f1 != null && Math.abs(f1 - 9.3) < 0.05, 'start ' + f1);
  ok('Audio file dropped on empty arrangement space creates a new track', f2 === nT0 + 1, `${nT0} → ${f2}`);
  ok('Audio file dropped on a session slot fills that slot; on empty session space creates a new track', f3 === 'drop-test' && f4.n === nT0 + 2 && f4.slot >= 0, JSON.stringify({ f3, f4 }));
  for (let i = 0; i < 4; i++) await page.evaluate(() => __daw.history.undo());
  await sleep(200);
  ok('File imports are undoable', (await page.evaluate(() => __daw.S.project.tracks.length)) === nT0 && !(await page.evaluate(() => __daw.S.project.tracks[0].slots[4])));
  // MIDI clip onto an audio track goes to a new MIDI track rather than mixing kinds
  await page.evaluate(() => { const { S } = __daw; const b = [...document.querySelectorAll('.add-track')].find((x) => /Synth/.test(x.textContent)); b.click(); });
  await sleep(200);
  await page.evaluate(() => { const { S, engine } = __daw; const t = S.project.tracks[S.project.tracks.length - 1]; t.slots[0] = { type: 'midi', name: 'M', lengthBeats: 4, notes: [{ p: 60, s: 0, d: 1, v: 100 }] }; S.view = 'arrange'; document.querySelector('.views button[data-view=session]').click(); });
  await sleep(250);
  const nT1 = await page.evaluate(() => __daw.S.project.tracks.length);
  const mfrom = await page.evaluate(() => { const T = __daw.S.project.tracks; const t = T[T.length - 1]; const s = document.querySelector(`#sessionView .col[data-id="${t.id}"] .slot[data-slot="0"]`); const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const mto = await page.evaluate(() => { const t = __daw.S.project.tracks[0]; const s = document.querySelector(`#sessionView .col[data-id="${t.id}"] .slot[data-slot="1"]`); const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await dragMouse(page, mfrom, mto);
  const mm = await page.evaluate(() => { const T = __daw.S.project.tracks; return { n: T.length, a: !!T[0].slots[1], lastKind: T[T.length - 1].kind, lastSlot: !!T[T.length - 1].slots[1] }; });
  ok('A MIDI clip dropped on an audio track is placed on a new MIDI track instead', mm.n === nT1 + 1 && !mm.a && mm.lastKind === 'midi' && mm.lastSlot, JSON.stringify(mm));
  await page.evaluate(() => { __daw.history.undo(); __daw.history.undo(); });

  // ---- desktop tutorial (short version) + replay from Help
  const tctx = await newPage({ viewport: { width: 1280, height: 800 } }, { phoneMode: 'off' });
  const T = tctx.page; await T.goto(URL_); await T.waitForSelector('.tut-bubble'); await sleep(400);
  const t1 = await T.evaluate(() => { const r = document.querySelector('.tut-ring').getBoundingClientRect(), b = document.querySelector('#startBtn').getBoundingClientRect(); return { n: __daw.tutorial.count, text: document.querySelector('.tut-text').textContent, around: r.left <= b.left && r.right >= b.right && r.top <= b.top && r.bottom >= b.bottom }; });
  await shot(T, 'desktop-tutorial-1');
  await T.click('#startBtn'); await T.waitForFunction(() => __daw.tutorial.step === 1, null, { timeout: 20000 }); await T.waitForFunction(() => !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(600);
  const t2 = await T.evaluate(() => ({ text: document.querySelector('.tut-text').textContent, ringVisible: getComputedStyle(document.querySelector('.tut-ring')).display !== 'none' }));
  await shot(T, 'desktop-tutorial-2');
  await T.click('.tut-next'); await sleep(300); await T.click('.tut-next'); await sleep(300);
  const t4 = await T.evaluate(() => ({ step: __daw.tutorial.step, text: document.querySelector('.tut-text').textContent }));
  await T.click('.tut-skip'); await sleep(200);
  const tDone = await T.evaluate(() => ({ running: __daw.tutorial.running, done: JSON.parse(localStorage.getItem('auduio.prefs')).tutorialDone }));
  await T.click('#btnHelp'); await sleep(200); await shot(T, 'desktop-help-replay');
  await T.click('.help-bar button.primary'); await sleep(300);
  const tReplay = await T.evaluate(() => ({ running: __daw.tutorial.running, n: __daw.tutorial.count, helpOff: !document.body.classList.contains('helpmode') }));
  await T.click('.tut-skip');
  ok('Desktop tutorial: 4 short steps, ring highlights the real control, advances when you use it', t1.n === 4 && t1.around && t2.ringVisible && /Record/.test(t2.text) && t4.step === 3 && /menu/i.test(t4.text), JSON.stringify({ t1, t2, t4 }));
  ok('Tutorial is skippable (remembered) and replayable from Help mode', !tDone.running && tDone.done === true && tReplay.running && tReplay.n === 3 && tReplay.helpOff, JSON.stringify({ tDone, tReplay }));
  await tctx.ctx.close();
  await ctx.close();

  // ======================================================================= phone
  for (const [W, H] of [[390, 844], [360, 780]]) {
    const pc = await newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, null);
    const P = pc.page; await P.goto(URL_); await P.waitForSelector('.tut-bubble'); await sleep(300);
    const tag = `phone-${W}`;
    await shot(P, `${tag}-tutorial-1-start`);
    await P.tap('#startBtn'); await P.waitForFunction(() => __daw.phone && __daw.phone.active && __daw.tutorial.step === 1, null, { timeout: 20000 }); await sleep(600);
    await P.evaluate(HELPERS);
    const tsteps = [];
    for (let i = 1; i < 6; i++) {
      await sleep(350);
      tsteps.push(await P.evaluate(() => { const ring = document.querySelector('.tut-ring'); return { step: __daw.tutorial.step, tab: __daw.phone.tab, ring: getComputedStyle(ring).display !== 'none', text: document.querySelector('.tut-text').textContent }; }));
      await shot(P, `${tag}-tutorial-${i + 1}`);
      await P.tap('.tut-next');
    }
    await sleep(300);
    const tEnd = await P.evaluate(() => ({ running: __daw.tutorial.running, n: __daw.tutorial.count }));
    ok(`[${W}x${H}] Phone tutorial: 6 one-sentence steps, each switches tab and highlights the real control`, tEnd.n === 6 && !tEnd.running && tsteps.every((s) => s.ring) && tsteps.map((s) => s.tab).join() === 'tracks,record,mix,effects,more', JSON.stringify(tsteps));
    ok(`[${W}x${H}] Phone layout auto-enabled (topbar hidden, bottom tab bar visible)`, await P.evaluate(() => document.body.classList.contains('phone') && !document.querySelector('#topbar').getClientRects().length && !!document.querySelector('.ph-tabs').getClientRects().length));
    // targets + text sizes on every tab
    const tabInfo = {};
    // give the Effects tab something to show: add "Make it louder" through the sheet
    await P.tap('.ph-tab[data-tab=effects]'); await sleep(200); await P.tap('.ph-addfx'); await sleep(200);
    await shot(P, `${tag}-effects-add-sheet`);
    await P.tap('.ph-sheet .ph-big:has-text("Make it louder")'); await sleep(300);
    for (const tab of ['record', 'tracks', 'mix', 'effects', 'more']) {
      await P.tap(`.ph-tab[data-tab=${tab}]`); await sleep(350);
      tabInfo[tab] = await P.evaluate(() => {
        const small = []; let minFont = 99;
        for (const el of document.querySelectorAll('#phone button, #phone input, #phone select')) { const r = el.getBoundingClientRect(); if (!r.width || el.closest('.ph-clips') && r.right > innerWidth) continue; if (Math.min(r.width, r.height) < 47.5) small.push(`${el.className || el.type}:${Math.round(r.width)}x${Math.round(r.height)}`); }
        for (const el of document.querySelectorAll('#phone .b1, #phone .ph-tname, #phone .ph-status')) { if (el.getClientRects().length) minFont = Math.min(minFont, parseFloat(getComputedStyle(el).fontSize)); }
        const over = document.documentElement.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('#phone .ph-body > *')].some((e) => e.getBoundingClientRect().right > innerWidth + 1);
        return { small, minFont, over, text: document.querySelector('#phone .ph-body').innerText.slice(0, 200) };
      });
      await shot(P, `${tag}-${tab}`);
    }
    ok(`[${W}x${H}] Every phone tab: all touch targets ≥ 48px, main labels ≥ 16px, nothing overflows horizontally`, Object.values(tabInfo).every((t) => !t.small.length && t.minFont >= 16 && !t.over), JSON.stringify(Object.fromEntries(Object.entries(tabInfo).map(([k, v]) => [k, { small: v.small, minFont: v.minFont, over: v.over }]))));
    ok(`[${W}x${H}] Plain-language labels next to technical names (“Make it louder” / Compressor, “Space / room”)`, /Make it louder/.test(tabInfo.effects.text) && /Compressor/.test(tabInfo.effects.text), tabInfo.effects.text);
    // swipe between tracks (real touch events via CDP)
    await P.tap('.ph-tab[data-tab=tracks]'); await sleep(200);
    const cdp = await pc.ctx.newCDPSession(P);
    const swipe = async (x0, x1, y) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] }); for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 6, y }] }); await sleep(16); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250); };
    const n0 = await P.evaluate(() => __daw.S.selected);
    const hy = await P.evaluate(() => { const r = document.querySelector('.ph-h').getBoundingClientRect(); return r.top + 8; });
    await swipe(W - 40, 40, hy);
    const n1 = await P.evaluate(() => __daw.S.selected);
    await swipe(40, W - 40, hy);
    const n2 = await P.evaluate(() => __daw.S.selected);
    ok(`[${W}x${H}] Swipe left/right moves between tracks (one focused track at a time)`, n1 !== n0 && n2 === n0, JSON.stringify({ n0, n1, n2 }));
    // record: big button arms + records; live waveform; stop creates a clip
    // Chromium >= 1243: the first tap right after a CDP touch swipe can be swallowed, so retry once (harness only)
    await P.tap('.ph-tab[data-tab=record]'); await sleep(200);
    if (await P.evaluate(() => __daw.phone.tab !== 'record')) { await sleep(300); await P.tap('.ph-tab[data-tab=record]'); await sleep(200); }
    const rb = await P.evaluate(() => { const r = document.querySelector('.ph-recbtn').getBoundingClientRect(); return [r.width, r.height]; });
    await P.tap('.ph-recbtn'); await P.waitForFunction(() => __daw.engine.recording, null, { timeout: 8000 }).catch(() => {}); await sleep(1800);
    const rec = await P.evaluate(() => ({ rec: __daw.engine.recording, status: document.querySelector('.ph-status').textContent, on: document.querySelector('.ph-recbtn').classList.contains('on'), wave: __pix(document.querySelector('.ph-wave')), label: document.querySelector('.ph-recbtn').getAttribute('aria-label') }));
    await shot(P, `${tag}-recording`);
    await P.tap('.ph-recbtn'); await sleep(1500);
    const recStop = await P.evaluate(() => ({ rec: __daw.engine.recording, clips: __daw.S.project.tracks.find((t) => t.id === __daw.S.selected).arrangement.length, box: document.querySelector('.ph-wavebox').getBoundingClientRect().height, wave: __pix(document.querySelector('.ph-wave')) }));
    ok(`[${W}x${H}] Big record button (≥120px) arms + records with a clear “Recording” state and a live waveform; stop keeps the take`, rb[0] >= 120 && rec.rec && rec.on && /Recording/.test(rec.status) && rec.label === 'Stop recording' && rec.wave > 20 && !recStop.rec && recStop.clips >= 1 && recStop.box >= 140 && recStop.wave > 20, JSON.stringify({ rb, rec, recStop }));
    // tracks screen: large waveform + long-press a clip → swipe to next track → Place here
    await P.tap('.ph-tab[data-tab=tracks]'); await sleep(300);
    await shot(P, `${tag}-tracks-waveform`);
    const chip = await P.evaluate(() => { const r = document.querySelector('.ph-clip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const srcTrack = await P.evaluate(() => __daw.S.selected);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [chip] }); await sleep(650); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250);
    // v0.4.x: long-press opens the clip sheet (Split here / Split in half / Move / Delete); Move picks the clip up
    await P.tap('.ph-sheet .ph-move'); await sleep(250);
    const carrying = await P.evaluate(() => !!__daw.phone.carry && !!document.querySelector('.ph-carry'));
    await P.tap('.ph-arrow[aria-label="Next track"]'); await sleep(250);
    await shot(P, `${tag}-place-here`);
    await P.tap('.ph-place'); await sleep(300);
    const placed = await P.evaluate((src) => { const T = __daw.S.project.tracks; const dst = T.find((t) => t.id === __daw.S.selected); return { moved: dst.id !== src && dst.arrangement.length >= 1, srcLeft: T.find((t) => t.id === src).arrangement.length }; }, srcTrack);
    await P.tap('.ph-undo'); await sleep(250);
    const undone = await P.evaluate((src) => __daw.S.project.tracks.find((t) => t.id === src).arrangement.length, srcTrack);
    ok(`[${W}x${H}] Phone: long-press a clip to pick it up, change track, tap “Place here”; undo restores`, carrying && placed.moved && placed.srcLeft === 0 && undone >= 1, JSON.stringify({ carrying, placed, undone }));
    // full layout toggle
    await P.tap('.ph-tab[data-tab=more]'); await sleep(200); await P.tap('.ph-full'); await sleep(400);
    const full = await P.evaluate(() => ({ phone: document.body.classList.contains('phone'), top: !!document.querySelector('#topbar').getClientRects().length, pref: JSON.parse(localStorage.getItem('auduio.prefs')).phoneMode }));
    await shot(P, `${tag}-full-layout`);
    ok(`[${W}x${H}] “Show full layout” switches to the full UI and remembers it`, !full.phone && full.top && full.pref === 'off', JSON.stringify(full));
    ok(`[${W}x${H}] No CSP violations`, (await P.evaluate(() => window.__csp.length)) === 0);
    await pc.ctx.close();
  }
} catch (e) {
  ok('v0.3 test run completed without exception', false, e.stack);
}
const relevant = errors.filter((e) => !/favicon/i.test(e));
ok('No console errors / page errors (v0.3 run)', relevant.length === 0, relevant.join('\n'));
await browser.close(); server.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} v0.3 checks passed`);
fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-v3.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
