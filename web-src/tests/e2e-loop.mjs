// v0.3.1 arrangement loop: loop brace on the ruler (drag to set, move, resize, snap / Alt free), transport toggle,
// Ctrl/Cmd+L, seamless looped playback (sample-accurate pass scheduling, metronome across the wrap), loop recording
// into selectable takes, phone loop controls, persistence + undo. Also: per-track meter during audition.
// Run after `node tools/build.mjs`: node tests/e2e-loop.mjs   (PORT env, default 8770)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8770), BASE = '/daw/';
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
  page.on('console', (m) => { if (m.type() === 'error' && !/Refused to execute inline script/.test(m.text())) errors.push(`[console] ${m.text()}`); });
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


const START = async (page) => { await page.goto(URL_); await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(300); await page.evaluate(MK); };
try {
  const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });
  await START(page);
  await page.evaluate(() => { const { S, engine } = __daw; S.project.bpm = 120; engine.updateBpmFx(); __mkBuf('bl', 8); const t = S.project.tracks[0];
    t.arrangement.push({ id: 'cl', bufferId: 'bl', start: 0, offset: 0, duration: 8, name: 'Bed' }); document.querySelector('.views button[data-view=arrange]').click(); });
  await sleep(400);
  const init = await page.evaluate(() => ({ loop: __daw.S.project.loop, brace: !!document.querySelector('#arrangeView .ruler .loop-brace'), off: document.querySelector('.loop-brace').classList.contains('off'), btn: !!document.querySelector('#btnLoop svg.ico'), shadeHidden: document.querySelector('.loop-shade').hidden }));
  ok('Project has a default loop (off, 4 bars); brace on the ruler, loop button with SVG icon in the transport', init.brace && init.btn && init.off && init.shadeHidden && init.loop.on === false && Math.abs(init.loop.end - init.loop.start - 8) < 1e-6, JSON.stringify(init));

  // drag across the ruler (empty area) -> new loop, snapped to beats, switched on
  const geo = async () => page.evaluate(() => { const r = document.querySelector('#arrangeView .ruler').getBoundingClientRect(); const c = document.querySelector('#arrangeView .arr-content').getBoundingClientRect(); return { y: r.top + r.height - 5, y0: r.top + 5, left: c.left, zoom: __daw.S ? null : null }; });
  const zoom = await page.evaluate(() => { const c = document.querySelector('#arrangeView .arr-content'); return parseFloat(c.style.width) / 1; });
  const Z = await page.evaluate(() => { const el = document.querySelector('.aclip[data-clip="cl"]'); return el.getBoundingClientRect().width / 8; });
  let g = await geo(); const X = (sec) => g.left + sec * Z;
  // first move the brace out of the way: the default loop sits at 0..8 s; drag from 9.1 s to 11.8 s
  await page.mouse.move(X(9.1), g.y); await page.mouse.down(); await page.mouse.move(X(10), g.y, { steps: 4 }); await page.mouse.move(X(11.8), g.y, { steps: 4 }); await page.mouse.up(); await sleep(150);
  const L1 = await page.evaluate(() => ({ ...__daw.S.project.loop }));
  const onBeat = (x) => Math.abs(x / 0.5 - Math.round(x / 0.5)) < 1e-6;
  ok('Dragging along the ruler creates a loop snapped to the beat grid and switches it on', L1.on && onBeat(L1.start) && onBeat(L1.end) && Math.abs(L1.start - 9) < 1e-6 && Math.abs(L1.end - 12) < 1e-6, JSON.stringify(L1));
  await page.keyboard.press('Control+z'); await sleep(150);
  const Lu = await page.evaluate(() => ({ ...__daw.S.project.loop }));
  await page.keyboard.press('Control+Shift+z'); await sleep(150);
  const Lr = await page.evaluate(() => ({ ...__daw.S.project.loop }));
  ok('Loop edits are undoable (undo restores the previous loop, redo re-applies)', Lu.on === false && Math.abs(Lu.end - 8) < 1e-6 && Lr.on && Math.abs(Lr.start - 9) < 1e-6, JSON.stringify({ Lu, Lr }));
  // move by dragging the middle
  g = await geo();
  await page.mouse.move(X(10.5), g.y); await page.mouse.down(); await page.mouse.move(X(9.5), g.y, { steps: 5 }); await page.mouse.move(X(8.4), g.y, { steps: 5 }); await page.mouse.up(); await sleep(150);
  const Lm = await page.evaluate(() => ({ ...__daw.S.project.loop }));
  ok('Dragging the loop bar moves it (length kept, snapped)', Math.abs(Lm.end - Lm.start - 3) < 1e-6 && onBeat(Lm.start) && Math.abs(Lm.start - 7) < 0.51, JSON.stringify(Lm));
  // resize right edge; then Alt-drag for free placement
  const edgeX = X(Lm.end) - 2;
  await page.mouse.move(edgeX, g.y); await page.mouse.down(); await page.mouse.move(edgeX + 30, g.y, { steps: 3 }); await page.mouse.move(X(Lm.end + 1.1), g.y, { steps: 3 }); await page.mouse.up(); await sleep(150);
  const Le = await page.evaluate(() => ({ ...__daw.S.project.loop }));
  await page.keyboard.down('Alt');
  const edgeX2 = X(Le.end) - 2;
  await page.mouse.move(edgeX2, g.y); await page.mouse.down(); await page.mouse.move(edgeX2 + 20, g.y, { steps: 3 }); await page.mouse.move(X(Le.end + 0.37), g.y, { steps: 3 }); await page.mouse.up(); await sleep(150);
  await page.keyboard.up('Alt');
  const La = await page.evaluate(() => ({ ...__daw.S.project.loop }));
  ok('Dragging an edge resizes the loop (snapped); with Alt it is placed freely', Math.abs(Le.start - Lm.start) < 1e-6 && onBeat(Le.end) && Math.abs(Le.end - (Lm.end + 1)) < 1e-6 && !onBeat(La.end) && Math.abs(La.end - (Le.end + 0.37)) < 0.06, JSON.stringify({ Le, La }));
  const shade = await page.evaluate(() => { const b = document.querySelector('.loop-brace').getBoundingClientRect(), s = document.querySelector('.loop-shade'); return { bl: b.left, bw: b.width, sl: s.getBoundingClientRect().left, hidden: s.hidden }; });
  ok('Loop region is shaded across the lanes under the brace', !shade.hidden && Math.abs(shade.bl - shade.sl) < 1.5, JSON.stringify(shade));
  await shot(page, 'desktop-loop-brace');
  // double-click toggles, transport button toggles, Ctrl+L loops the selected clip
  await page.mouse.dblclick(X((La.start + La.end) / 2), g.y); await sleep(150);
  const offDbl = await page.evaluate(() => __daw.S.project.loop.on);
  await page.click('#btnLoop'); await sleep(100);
  const onBtn = await page.evaluate(() => ({ on: __daw.S.project.loop.on, cls: document.querySelector('#btnLoop').classList.contains('on'), pressed: document.querySelector('#btnLoop').getAttribute('aria-pressed') }));
  await page.evaluate(() => { __daw.S.project.tracks[0].arrangement.push({ id: 'c2', bufferId: 'bl', start: 2, offset: 0, duration: 1.5, name: 'Short' }); document.querySelector('.views button[data-view=session]').click(); document.querySelector('.views button[data-view=arrange]').click(); });
  await sleep(200);
  await page.click('.aclip[data-clip="c2"]', { position: { x: 10, y: 30 } }); await page.evaluate(() => __daw.engine.stopAudition());
  await page.keyboard.press('Control+l'); await sleep(150);
  const Lc = await page.evaluate(() => ({ ...__daw.S.project.loop }));
  ok('Double-click on the brace and the transport Loop button toggle the loop; Ctrl/Cmd+L loops the selected clip', offDbl === false && onBtn.on && onBtn.cls && onBtn.pressed === 'true' && Lc.on && Math.abs(Lc.start - 2) < 1e-6 && Math.abs(Lc.end - 3.5) < 1e-6, JSON.stringify({ offDbl, onBtn, Lc }));
  await page.evaluate(() => { const T = __daw.S.project.tracks[0]; T.arrangement = T.arrangement.filter((c) => c.id !== 'c2'); __daw.S.sel = null; });

  // ---- seamless looped playback: sources tile the timeline exactly, position wraps, clicks stay evenly spaced
  const play = await page.evaluate(async () => {
    const { S, engine } = __daw; const log = [];
    const orig = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, off, dur) { if (this.buffer === engine.buffers.get('bl')) log.push({ when, off, dur }); return orig.call(this, when, off, dur); };
    S.project.loop = { on: true, start: 1, end: 2 }; engine.setLoop();
    const clicks = []; engine.on('click', (c) => clicks.push(c));
    engine.metronome = true; engine.setPosition(0); engine.play(0);
    const pos = []; for (let i = 0; i < 16; i++) { await new Promise((r) => setTimeout(r, 250)); pos.push(engine.position()); }
    const T0 = engine.startCtxTime; engine.stop(); engine.metronome = false; AudioBufferSourceNode.prototype.start = orig;
    return { log: log.map((x) => ({ w: x.when - T0, off: x.off, dur: x.dur })), pos, clicks: clicks.map((c) => ({ t: c.t - T0, pos: c.pos })) };
  });
  const lg = play.log; let tiled = lg.length >= 3 && Math.abs(lg[0].w) < 1e-6 && Math.abs(lg[0].off) < 1e-9 && Math.abs(lg[0].dur - 2) < 1e-6;
  for (let i = 1; i < lg.length; i++) tiled = tiled && Math.abs(lg[i].w - (lg[i - 1].w + lg[i - 1].dur)) < 1e-6 && Math.abs(lg[i].off - 1) < 1e-9 && Math.abs(lg[i].dur - 1) < 1e-6;
  ok('Looped playback: each pass is scheduled sample-accurately back to back (pass 0: 0-2 s, then 1-2 s repeating), no gap or overlap', tiled, JSON.stringify(lg.slice(0, 6)));
  const wrapped = play.pos.slice(6).every((p) => p >= 1 - 1e-6 && p < 2 + 1e-6);
  ok('Playhead position wraps to the loop start at the loop end', wrapped && Math.max(...play.pos) < 2.001, JSON.stringify(play.pos.map((x) => +x.toFixed(3))));
  const ck = play.clicks.filter((c) => c.t > 0.1); let even = ck.length >= 6;
  for (let i = 1; i < ck.length; i++) even = even && Math.abs(ck[i].t - ck[i - 1].t - 0.5) < 1e-6;
  ok('Metronome keeps an even beat across the loop wrap (clicks every 0.5 s at 120 BPM, positions inside the loop)', even && ck.slice(3).every((c) => c.pos >= 1 - 1e-6 && c.pos < 2), JSON.stringify(ck.slice(0, 8).map((c) => [+c.t.toFixed(4), +c.pos.toFixed(3)])));

  // ---- loop recording: each pass is kept as a take of one recording; last complete pass is used; takes are selectable + undoable
  const armed = await page.evaluate(async () => { const t = __daw.S.project.tracks[1]; const b = document.querySelector(`.arr-heads [data-id="${t.id}"] .arm`); b.click(); await new Promise((r) => setTimeout(r, 1500)); return t.arm; });
  const rec = await page.evaluate(async () => {
    const { S, engine } = __daw; S.project.loop = { on: true, start: 1, end: 2 }; engine.setPosition(1);
    await engine.startRecording(); await new Promise((r) => setTimeout(r, 3500)); await engine.stopRecording(); await new Promise((r) => setTimeout(r, 400));
    const t = S.project.tracks[1]; const c = t.arrangement[t.arrangement.length - 1];
    return c ? { takes: c.takes, take: c.take, start: c.start, duration: c.duration, offset: c.offset, id: c.id, name: c.name } : null;
  });
  const tk = rec && rec.takes; let spaced = !!tk && tk.length >= 3;
  if (spaced) for (let i = 1; i < tk.length; i++) spaced = spaced && Math.abs(tk[i].offset - tk[i - 1].offset - tk[i - 1].duration) < 0.002 && Math.abs(tk[i].start - 1) < 1e-6;
  const full = spaced && Math.abs(rec.start - 1) < 1e-6 && Math.abs(rec.duration - 1) < 0.002 && rec.take >= tk.length - 2;
  ok('Loop recording keeps every pass as a take (one continuous recording, takes back to back, clip uses the last complete pass)', armed && spaced && full, JSON.stringify(rec));
  await page.evaluate((id) => { __daw.S.sel = { kind: 'arr', trackId: __daw.S.project.tracks[1].id, clipId: id }; document.querySelector('.views button[data-view=session]').click(); document.querySelector('.views button[data-view=arrange]').click(); }, rec && rec.id);
  await sleep(300);
  const badge = await page.evaluate((id) => { const el = document.querySelector(`.aclip[data-clip="${id}"] .take-badge`); return el && el.textContent; }, rec && rec.id);
  await page.evaluate(() => { __daw.S.bottom = 'clip'; });
  await page.click(`.aclip[data-clip="${rec && rec.id}"]`, { position: { x: 6, y: 30 } }); await page.evaluate(() => __daw.engine.stopAudition()); await sleep(250);
  const takeBtns = await page.evaluate(() => document.querySelectorAll('.takes .take').length);
  await shot(page, 'desktop-loop-takes');
  if (takeBtns) await page.click('.takes .take >> nth=0'); await sleep(200);
  const picked = await page.evaluate((id) => { const c = __daw.S.project.tracks[1].arrangement.find((x) => x.id === id); return { take: c.take, offset: c.offset }; }, rec && rec.id);
  await page.keyboard.press('Control+z'); await sleep(200);
  const unp = await page.evaluate((id) => { const c = __daw.S.project.tracks[1].arrangement.find((x) => x.id === id); return c && { take: c.take, offset: c.offset }; }, rec && rec.id);
  ok('Takes are selectable (badge on the clip, buttons in clip detail) and picking a take is undoable', badge === `T${rec.take + 1}/${tk.length}` && takeBtns === tk.length && picked.take === 0 && Math.abs(picked.offset - tk[0].offset) < 1e-9 && unp && unp.take === rec.take, JSON.stringify({ badge, takeBtns, picked, unp }));
  await page.evaluate(async () => { const t = __daw.S.project.tracks[1]; const b = document.querySelector(`.arr-heads [data-id="${t.id}"] .arm`); if (b && t.arm) b.click(); });

  // ---- persistence: the loop is saved with the project
  await page.evaluate(() => { const { S, engine } = __daw; S.project.loop = { on: true, start: 4, end: 6 }; engine.setLoop(); });
  await page.evaluate(() => { document.querySelector('#btnLoop').click(); document.querySelector('#btnLoop').click(); });
  await sleep(1800);
  await page.reload(); await page.click('#startBtn').catch(() => {}); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(600);
  const persisted = await page.evaluate(() => ({ ...__daw.S.project.loop, clips: __daw.S.project.tracks[0].arrangement.length }));
  ok('Loop region is saved with the project (restored after reload)', persisted.on === true && Math.abs(persisted.start - 4) < 1e-6 && Math.abs(persisted.end - 6) < 1e-6, JSON.stringify(persisted));

  // ---- per-track meter during audition
  await page.evaluate(MK);
  const met = await page.evaluate(async () => { const { S, engine } = __daw; __mkBuf('bm', 3); const t = S.project.tracks[0]; const c = { id: 'cm', bufferId: 'bm', start: 0, offset: 0, duration: 3 };
    engine.auditionClip(t, c, { key: 'm' }); let tp = 0, mp = 0; for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 60)); tp = Math.max(tp, ...((engine.meters.get(t.id) || {}).peak || [0])); mp = Math.max(mp, ...((engine.meters.get('master') || {}).peak || [0])); } engine.stopAudition(); return { tp, mp }; });
  ok('Track meter moves while a clip of that track is auditioned (as does the master meter)', met.tp > 0.05 && met.mp > 0.05, JSON.stringify(met));
  await ctx.close();

  // ---- phone mode loop controls
  const pc = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { tutorialDone: true });
  const P = pc.page; await P.goto(URL_); await P.tap('#startBtn'); await P.waitForFunction(() => __daw.phone && __daw.phone.active, null, { timeout: 20000 }); await sleep(400);
  await P.evaluate(() => { __daw.S.project.bpm = 120; __daw.engine.updateBpmFx(); __daw.S.project.loop = { on: false, start: 0, end: 8 }; __daw.phone.render(); });
  const hasPanel = await P.evaluate(() => !!document.querySelector('.ph-loop .ph-loop-toggle'));
  await P.tap('.ph-loop-toggle'); await sleep(150);
  const pOn = await P.evaluate(() => __daw.S.project.loop.on);
  await P.tap('.ph-loop-len >> nth=1'); await sleep(150);
  const p2 = await P.evaluate(() => ({ ...__daw.S.project.loop }));
  await P.tap('.ph-loop-next'); await sleep(150);
  const p3 = await P.evaluate(() => ({ ...__daw.S.project.loop, shown: document.querySelector('.ph-loop-start').textContent }));
  const sizes = await P.evaluate(() => [...document.querySelectorAll('.ph-loop button')].map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height)));
  const phHits = await P.evaluate(SCAN);
  await P.evaluate(() => document.querySelector('.ph-loop').scrollIntoView());
  await shot(P, 'phone-390-loop');
  ok('Phone: Loop toggle and "loop these bars" controls (length, start bar) work with big targets and no emoji', hasPanel && pOn && Math.abs(p2.end - p2.start - 4) < 1e-6 && p2.start === 0 && Math.abs(p3.start - 2) < 1e-6 && Math.abs(p3.end - 6) < 1e-6 && p3.shown === '2' && sizes.every((s) => s >= 44) && !phHits.length, JSON.stringify({ hasPanel, pOn, p2, p3, sizes, phHits }));
  await P.tap('.ph-undo'); await sleep(150);
  const pu = await P.evaluate(() => __daw.S.project.loop.start);
  ok('Phone: loop changes are undoable with the Undo button', Math.abs(pu - 0) < 1e-6, String(pu));
  await pc.ctx.close();
} catch (e) { ok('loop test run completed without exception', false, e.stack); }
const relevant = errors.filter((e) => !/favicon/i.test(e));
ok('No console errors / page errors (loop run)', relevant.length === 0, relevant.join('\n'));
await browser.close(); server.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} loop checks passed`);
fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-loop.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
