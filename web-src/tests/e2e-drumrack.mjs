// 128-pad drum rack with user samples, end to end in Chromium. Run: node tests/e2e-drumrack.mjs
// Screenshots: /workspace/daw/shots/drumrack-*.png
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8799), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 500) : ''}`); };
const shots = path.join(ROOT, 'shots'); fs.mkdirSync(shots, { recursive: true });
const shot = async (page, name, opts = {}) => { await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.classList.remove('show'); }); await new Promise((r) => setTimeout(r, 250)); return page.screenshot({ path: path.join(shots, name + '.png'), ...opts }); };
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
// test sample files on disk (for the file picker)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auduio-pads-'));
function wavBytes(freq, secs, sr = 44100, stereoDiff = false) {
  const n = Math.floor(secs * sr), nc = 2, b = Buffer.alloc(44 + n * nc * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * nc * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(nc, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * nc * 2, 28); b.writeUInt16LE(nc * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * nc * 2, 40);
  for (let i = 0; i < n; i++) { const v = Math.sin(2 * Math.PI * freq * i / sr) * Math.exp(-i / sr * 6) * 0.8; b.writeInt16LE(Math.round(v * 32767), 44 + i * 4); b.writeInt16LE(Math.round((stereoDiff ? -v : v) * 32767), 46 + i * 4); }
  return b;
}
const F = (name, data) => { const p = path.join(TMP, name); fs.writeFileSync(p, data); return p; };
const kick = F('My Kick.wav', wavBytes(60, 0.5)), snare = F('Snare 01.wav', wavBytes(200, 0.4, 44100, true));
const fakeWav = F('notreally.wav', Buffer.from('<html>this is not audio</html>'));
const brokenWav = F('broken.wav', Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEjunk'), Buffer.alloc(64, 7)]));

let browser;
async function newPage(opts = {}, prefs = { guideDone: true, tutorialDone: true, phoneMode: 'off' }) {
  const ctx = await browser.newContext({ ...opts });
  await ctx.addInitScript((prefs) => { if (!localStorage.getItem('auduio.prefs')) localStorage.setItem('auduio.prefs', JSON.stringify(prefs)); }, prefs);
  await ctx.addInitScript(() => {
    window.__buzz = 0; try { Object.defineProperty(navigator, 'vibrate', { value: () => { window.__buzz++; return true; }, configurable: true }); } catch (e) {}
    // record every buffer source start/stop (to prove what the pads play)
    window.__starts = []; window.__stops = [];
    const S0 = AudioBufferSourceNode.prototype.start, T0 = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (when = 0, off = 0, dur) { window.__starts.push({ len: this.buffer ? this.buffer.length : 0, dur: this.buffer ? this.buffer.duration : 0, ch: this.buffer ? this.buffer.numberOfChannels : 0, when, off, d: dur, rate: this.playbackRate.value, node: this }); return S0.apply(this, arguments); };
    AudioBufferSourceNode.prototype.stop = function (when = 0) { window.__stops.push({ node: this, when }); return T0.apply(this, arguments); };
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(URL_); await start(page);
  return { ctx, page };
}
async function start(page) { await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(300); }
const P = (page, fn, arg) => page.evaluate(fn, arg);
const toastText = (page) => P(page, () => document.querySelector('#toast').textContent);
async function pickFiles(page, clickFn, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), clickFn()]);
  await fc.setFiles(files);
}
// build files inside the page and drop them on an element (DataTransfer with files)
async function dropFiles(page, sel, specs) {
  await P(page, ({ sel, specs }) => {
    const mk = ({ name, freq, secs }) => { const sr = 22050, n = Math.floor(secs * sr), b = new DataView(new ArrayBuffer(44 + n * 2)); const ws = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
      ws(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, sr, true); b.setUint32(28, sr * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); ws(36, 'data'); b.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * i / sr) * 20000), true);
      return new File([b.buffer], name, { type: 'audio/wav' }); };
    const dt = new DataTransfer(); for (const s of specs) dt.items.add(s.text ? new File([s.text], s.name) : mk(s));
    const el = document.querySelector(sel);
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sel, specs });
}
const pads = (page) => P(page, () => { const t = __daw.S.project.tracks.find((x) => x.id === __daw.S.selected); return JSON.parse(JSON.stringify((t.inst && t.inst.pads) || {})); });

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DAW_BROWSER, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });
  // a drum track, session view (device panel visible)
  await P(page, () => document.querySelector('.views button[data-view=session]').click());
  await page.click('.add-col .add-track:nth-child(3)'); await sleep(300);
  const tid = await P(page, () => __daw.S.selected);
  await P(page, () => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Devices' && x.getClientRects().length); if (b) b.click(); }); await sleep(200);
  const base = await P(page, () => ({ cells: document.querySelectorAll('#devices .dr-ov .dr-ovc').length, pads: [...document.querySelectorAll('#devices .dr-pad')].map((p) => +p.dataset.note), names: [...document.querySelectorAll('#devices .dr-pad .dr-name')].slice(12).map((x) => x.textContent) }));
  ok('Drum rack: overview strip shows all 128 pads (4 x 32) beside a 4x4 pad view', base.cells === 128 && base.pads.length === 16, JSON.stringify(base));
  ok('Default view = notes 36-51 (bottom-left = Kick 36, top-right = 51), GM names on built-in pads', base.pads[12] === 36 && base.pads[3] === 51 && base.names[0] === 'Kick', JSON.stringify(base.pads));

  // overview: click near the top shows the highest pads, drag down scrolls, arrows step by a row
  const ov = await P(page, () => { const r = document.querySelector('#devices .dr-ov').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top, h: r.height }; });
  await page.mouse.click(ov.x, ov.y + 2); await sleep(100);
  const topView = await P(page, (tid) => __daw.drumRack.viewOf(__daw.S.project.tracks.find((t) => t.id === tid)), tid);
  await page.mouse.move(ov.x, ov.y + 2); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(ov.x, ov.y + ov.h * i / 8 - 1); await page.mouse.up(); await sleep(100);
  const lowView = await P(page, (tid) => __daw.drumRack.viewOf(__daw.S.project.tracks.find((t) => t.id === tid)), tid);
  await page.click('#devices .dr-nav [aria-label="Show higher pads"]'); await sleep(80);
  const upView = await P(page, (tid) => ({ v: __daw.drumRack.viewOf(__daw.S.project.tracks.find((t) => t.id === tid)), first: +document.querySelector('#devices .dr-pad').dataset.note }), tid);
  ok('Overview: click the top shows pads 112-127; drag down to 0-15; "higher" moves one row (4 pads)', topView === 112 && lowView === 0 && upView.v === 4 && upView.first === 16, JSON.stringify({ topView, lowView, upView }));
  await P(page, (tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); __daw.drumRack.setView(t, 36, true); }, tid); await sleep(80);

  // Load sample (file picker) on the selected pad (Kick 36)
  await page.click('#devices .dr-pad[data-note="36"]'); await sleep(80);
  await pickFiles(page, () => page.click('#devices .dr-edit .dr-load'), [kick]); await sleep(600);
  let pd = await pads(page);
  const vis1 = await P(page, () => ({ has: document.querySelector('#devices .dr-pad[data-note="36"]').classList.contains('has'), name: document.querySelector('#devices .dr-pad[data-note="36"] .dr-name').textContent, wave: !!document.querySelector('#devices .dr-pad[data-note="36"] canvas.dr-wave'), lit: document.querySelector('#devices .dr-ovc[data-n="36"]').classList.contains('has'), big: !!document.querySelector('#devices .dr-bigwave') }));
  ok('Load sample (file picker): pad 36 gets "My Kick", mini waveform, lit in the overview, editor shows the waveform', pd[36] && pd[36].name === 'My Kick' && vis1.has && vis1.name === 'My Kick' && vis1.wave && vis1.lit && vis1.big, JSON.stringify({ pd, vis1 }));
  const mem = await P(page, (id) => { const b = __daw.engine.buffers.get(id); return { ch: b.numberOfChannels, dur: b.duration }; }, pd[36].bufferId);
  ok('Memory: a stereo file with identical channels is stored as mono', mem.ch === 1 && Math.abs(mem.dur - 0.5) < 0.01, JSON.stringify(mem));
  // playing pad 36 plays the user's sample (not the built-in kick)
  await P(page, () => { window.__starts = []; });
  await page.dispatchEvent('#devices .dr-pad[data-note="36"]', 'pointerdown'); await page.dispatchEvent('#devices .dr-pad[data-note="36"]', 'pointerup'); await sleep(80);
  let st = await P(page, () => window.__starts.map((s) => ({ dur: +s.dur.toFixed(3), off: s.off, d: s.d })));
  ok('Tapping the pad plays the user sample', st.some((s) => Math.abs(s.dur - 0.5) < 0.01), JSON.stringify(st));
  await page.click('.btn-undo'); await sleep(200);
  const afterUndo = await pads(page);
  await page.click('.btn-redo'); await sleep(200);
  ok('Load sample is one undo step (Undo empties the pad, Redo brings the sample back)', !afterUndo[36] && (await pads(page))[36], JSON.stringify(afterUndo));

  // drop 3 files on pad 40: they fill 40, 41, 42 (natural order)
  await dropFiles(page, '#devices .dr-pad[data-note="40"]', [{ name: 'hit10.wav', freq: 900, secs: 0.2 }, { name: 'hit2.wav', freq: 500, secs: 0.2 }, { name: 'hit1.wav', freq: 300, secs: 0.3 }]);
  await sleep(900);
  pd = await pads(page);
  ok('Dropping several files on a pad fills the next pads in natural order (hit1, hit2, hit10 -> 40, 41, 42)', pd[40] && pd[40].name === 'hit1' && pd[41].name === 'hit2' && pd[42].name === 'hit10', JSON.stringify(Object.fromEntries(Object.entries(pd).map(([k, v]) => [k, v.name]))));
  // unsafe files: fake content, broken audio, wrong type -> clear message, nothing loaded
  await dropFiles(page, '#devices .dr-pad[data-note="44"]', [{ name: 'readme.txt', text: 'hello' }]); await sleep(300);
  const t1 = await toastText(page);
  await pickFiles(page, () => page.click('#devices .dr-pad[data-note="44"]', { button: 'right' }).then(() => P(page, () => [...document.querySelectorAll('.ctxmenu button')].find((b) => /Load sample/.test(b.textContent)).click())), [fakeWav, brokenWav]); await sleep(800);
  const t2 = await toastText(page); pd = await pads(page);
  ok('Validation: non-audio files are ignored with a message; fake/broken WAVs are refused with reasons; nothing loaded', /No audio files/.test(t1) && /2 could not be used/.test(t2) && /not audio/.test(t2) && !pd[44], JSON.stringify({ t1, t2 }));

  // pad editor: trim, gain, pitch, gate, choke -> playback uses them; slider drags are one undo step
  await page.click('#devices .dr-pad[data-note="36"]'); await sleep(100);
  const setSlider = (k, v) => P(page, ({ k, v }) => { const r = document.querySelector(`#devices .dr-edit input[data-k="${k}"]`); r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); }, { k, v });
  const h0 = await P(page, () => __daw.history.undoStack ? __daw.history.undoStack.length : null);
  await setSlider('start', 0.2); await setSlider('start', 0.25); await setSlider('end', 0.75); await setSlider('gain', -6); await setSlider('pitch', 12);
  pd = await pads(page);
  ok('Pad editor: Start/End trim, Gain, Pitch are stored on the pad', pd[36].start === 0.25 && pd[36].end === 0.75 && pd[36].gain === -6 && pd[36].pitch === 12, JSON.stringify(pd[36]));
  await P(page, () => { window.__starts = []; });
  await P(page, (tid) => __daw.engine.notes(tid).noteOn(36, 100), tid); await sleep(50);
  st = await P(page, () => window.__starts.map((s) => ({ dur: +s.dur.toFixed(3), off: +s.off.toFixed(3), d: +(s.d || 0).toFixed(3), rate: +s.rate.toFixed(3) })));
  ok('Playback honours trim (offset 0.125 s, length 0.25 s) and pitch (+12 st = rate 2)', st.some((s) => s.off === 0.125 && s.d === 0.25 && s.rate === 2), JSON.stringify(st));
  await page.click('.btn-undo'); await sleep(150);
  const undone = await pads(page);
  ok('Dragging a slider is one undo step (Undo resets pitch only)', undone[36].pitch === 0 && undone[36].gain === -6, JSON.stringify(undone[36]));
  await page.click('.btn-redo'); await sleep(150);
  // gate mode: the sample stops when the pad is released
  await P(page, () => [...document.querySelectorAll('#devices .dr-edit .seg button')].find((b) => b.textContent === 'Gate').click()); await sleep(100);
  await P(page, () => { window.__starts = []; window.__stops = []; });
  await P(page, async (tid) => { const n = __daw.engine.notes(tid); n.noteOn(36, 100); await new Promise((r) => setTimeout(r, 60)); n.noteOff(36); }, tid); await sleep(50);
  const gate = await P(page, () => { const s = window.__starts.find((x) => Math.abs(x.dur - 0.5) < 0.01); return !!s && window.__stops.some((x) => x.node === s.node); });
  ok('Gate mode: releasing the pad stops the sample', gate && (await pads(page))[36].mode === 'gate');
  // choke: 40 and 41 in group 1 -> hitting 41 cuts 40
  for (const n of [40, 41]) { await page.click(`#devices .dr-pad[data-note="${n}"]`); await sleep(80); await P(page, () => { const s = document.querySelector('#devices .dr-choke-sel select'); s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(80); }
  await P(page, () => { window.__starts = []; window.__stops = []; });
  await P(page, async (tid) => { const n = __daw.engine.notes(tid); n.noteOn(40, 100); await new Promise((r) => setTimeout(r, 40)); n.noteOn(41, 100); }, tid); await sleep(50);
  const choke = await P(page, () => { const first = window.__starts[0]; return { n: window.__starts.length, cut: !!first && window.__stops.some((x) => x.node === first.node) }; });
  pd = await pads(page);
  ok('Choke group: pads 40 and 41 in group 1, hitting 41 cuts 40 off', pd[40].choke === 1 && pd[41].choke === 1 && choke.cut, JSON.stringify(choke));
  await shot(page, 'drumrack-desktop', { clip: { x: 0, y: 560, width: 1440, height: 340 } });

  // My Samples in the browser: lists the loaded samples, double-click puts one on the selected pad
  const lib = await P(page, () => [...document.querySelectorAll('.br-sec[data-sec="samples"] .br-item .br-label')].map((x) => x.textContent));
  ok('Browser "My Samples" lists your samples', lib.includes('My Kick') && lib.includes('hit1') && lib.includes('Snare 01') === false, JSON.stringify(lib));
  await page.click('#devices .dr-pad[data-note="48"]'); await sleep(80);
  await P(page, () => { const it = [...document.querySelectorAll('.br-sec[data-sec="samples"] .br-item')].find((x) => x.querySelector('.br-label').textContent === 'My Kick'); it.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }); await sleep(300);
  pd = await pads(page);
  ok('Double-click a My Samples entry: it goes on the selected pad (48), sharing the stored audio', pd[48] && pd[48].bufferId === pd[36].bufferId, JSON.stringify(pd[48]));

  // sequencer: rows = the 16 pads in view; scrolling the rack changes the rows; a step on a far pad plays its sample
  await P(page, () => __daw.seq.render()); await sleep(200);
  await P(page, () => { const b = document.querySelector('[data-act=enable]'); if (b) b.click(); }); await sleep(150);
  const rows1 = await P(page, () => [...document.querySelectorAll('.sq-drow:not(.head) .sq-pad')].map((x) => x.textContent));
  await pickFiles(page, async () => { await P(page, (tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); __daw.drumRack.setView(t, 100); __daw.drumRack.select(t, 100); }, tid); await P(page, () => __daw.drumRack.pick(__daw.S.project.tracks.find((x) => x.id === __daw.S.selected), 100, false)); }, [snare]); await sleep(700);
  const rows2 = await P(page, () => ({ rows: [...document.querySelectorAll('.sq-drow:not(.head) .sq-pad')].map((x) => x.textContent), ov: !!document.querySelector('.sq-drumwrap .dr-ov.seq') }));
  ok('Sequencer drum rows follow the rack view (16 rows) with the overview strip beside them', rows1.length >= 16 && rows1[0] === 'My Kick' && rows1[2] === 'Snare' && rows2.ov && rows2.rows.includes('Snare 01') && rows2.rows.length >= 16, JSON.stringify({ rows1: rows1.slice(0, 4), n1: rows1.length, ov: rows2.ov, n2: rows2.rows.length, rows2: rows2.rows.slice(0, 6) }));
  await page.click('.sq-dcell[data-si="0"][data-n="100"]'); await sleep(100);
  await P(page, () => { window.__starts = []; __daw.engine.play(0); }); await sleep(400); await P(page, () => { __daw.engine.stop(); __daw.engine.stop(); });
  st = await P(page, () => window.__starts.map((s) => ({ ch: s.ch, dur: +s.dur.toFixed(2) })));
  ok('A sequencer step on pad 100 plays that pad\'s sample (stereo Snare 01, 0.4 s)', st.some((s) => s.ch === 2 && s.dur === 0.4), JSON.stringify(st));
  await shot(page, 'drumrack-seq');

  // persistence: autosave + reload keeps the pads; samples load lazily
  await P(page, (tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); __daw.drumRack.setView(t, 36, true); }, tid);
  await page.dispatchEvent('.sq-dcell[data-si="0"][data-n="100"]', 'click').catch(() => {}); // remove the step again (pad 100 then is unused + not visible)
  await sleep(200);
  await P(page, () => { const b = [...document.querySelectorAll('#menu button')].find((x) => /Save now/.test(x.textContent)); if (b) b.click(); }); await sleep(1800);
  const ids = await pads(page);
  await page.reload(); await start(page); await sleep(500);
  const re = await P(page, ({ tid }) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); const P = t.inst.pads || {}; return { n: Object.keys(P).length, name36: P[36] && P[36].name, trim: P[36] && [P[36].start, P[36].end, P[36].gain, P[36].pitch, P[36].mode], choke: P[41] && P[41].choke, far: P[100] && P[100].bufferId, farLoaded: P[100] ? __daw.engine.buffers.has(P[100].bufferId) : null }; }, { tid });
  ok('Samples are saved inside the project and survive reload (names, trim, gain, pitch, mode, choke)', re.n === Object.keys(ids).length && re.name36 === 'My Kick' && JSON.stringify(re.trim) === '[0.25,0.75,-6,12,"gate"]' && re.choke === 1, JSON.stringify(re));
  ok('Lazy loading: after reload an unused, hidden pad sample (100) is not decoded into memory yet', re.far && re.farLoaded === false, JSON.stringify(re));
  await P(page, () => { window.__starts = []; });
  await P(page, (tid) => __daw.engine.notes(tid).noteOn(100, 100), tid); await sleep(300);
  const lazy = await P(page, ({ tid }) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); return { loaded: __daw.engine.buffers.has(t.inst.pads[100].bufferId), played: window.__starts.some((s) => s.ch === 2 && Math.abs(s.dur - 0.4) < 0.01) }; }, { tid });
  ok('...and it loads on first use, and that first hit still plays', lazy.loaded && lazy.played, JSON.stringify(lazy));
  const libAfter = await P(page, () => __daw.library.list().map((x) => x.name));
  ok('My Samples survives reload', libAfter.includes('My Kick') && libAfter.includes('Snare 01'), JSON.stringify(libAfter));
  // export: the zip contains the pad audio (validated re-import keeps the pads)
  const exp = await P(page, async () => {
    const { exportProjectZip, importProjectFile } = await import('./js/project.js');
    await Promise.all(__daw.S.project.tracks.flatMap((t) => Object.values((t.inst && t.inst.pads) || {}).map((p) => __daw.engine.ensureBuffer(p.bufferId))));
    const blob = exportProjectZip(__daw.S.project, __daw.engine.buffers); const bytes = new Uint8Array(await blob.arrayBuffer());
    const r = await importProjectFile(bytes, __daw.engine.ctx); const t = r.project.tracks.find((x) => x.inst && x.inst.pads);
    return { pads: Object.keys(t.inst.pads).length, bufs: Object.values(t.inst.pads).every((p) => r.buffers.has(p.bufferId)) };
  });
  ok('Exported project (.zip) contains every pad sample and re-imports with the pads', exp.pads >= 5 && exp.bufs, JSON.stringify(exp));
  await ctx.close();

  // phone: drum track on the Tracks tab shows the rack; hold a pad -> "Load sample..."
  const ph = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { guideDone: true, tutorialDone: true, phoneMode: 'on', haptics: true });
  const pp = ph.page;
  await P(pp, () => { __daw.phone.show ? __daw.phone.show('tracks') : document.querySelector('.ph-tab[data-tab=tracks]').click(); }); await sleep(300);
  await P(pp, () => [...document.querySelectorAll('.ph-add .ph-big')].find((b) => /Drums/.test(b.textContent)).click()); await sleep(400);
  const phRack = await P(pp, () => ({ rack: !!document.querySelector('.ph-drums .dr-rack.phone'), pads: document.querySelectorAll('.ph-drums .dr-pad').length, ov: document.querySelectorAll('.ph-drums .dr-ovc').length, h: document.querySelector('.ph-drums .dr-pad') ? document.querySelector('.ph-drums .dr-pad').getBoundingClientRect().height : 0 }));
  ok('Phone: drum track shows the overview + 4x4 pads (big pads, 60 px)', phRack.rack && phRack.pads === 16 && phRack.ov === 128 && phRack.h >= 56, JSON.stringify(phRack));
  const cdp = await ph.ctx.newCDPSession(pp);
  const pr = await P(pp, () => { const r = document.querySelector('.ph-drums .dr-pad[data-note="37"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const buzz0 = await P(pp, () => window.__buzz);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pr] }); await sleep(700); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250);
  const sheet = await P(pp, () => [...document.querySelectorAll('.ph-sheet .ph-big')].map((b) => b.textContent));
  ok('Phone: hold a pad -> sheet (stays open after lifting the finger) with "Load sample...", "Load a folder...", Play (one sheet, with a haptic buzz)', sheet.some((x) => /^Load sample/.test(x)) && sheet.some((x) => /folder/.test(x)) && (await P(pp, () => document.querySelectorAll('.ph-sheet').length)) === 1 && (await P(pp, () => window.__buzz)) > buzz0, JSON.stringify(sheet));
  await pickFiles(pp, () => pp.locator('.ph-sheet .ph-big', { hasText: /^Load sample/ }).tap(), [kick]); await sleep(700);
  const phPads = await pads(pp);
  ok('Phone: Load sample from the sheet puts it on the held pad (37)', phPads[37] && phPads[37].name === 'My Kick', JSON.stringify(phPads));
  await shot(pp, 'drumrack-phone');
  await ph.ctx.close();

  ok('No page errors', !errors.length, errors.join(' | '));
} catch (e) {
  ok('drum rack test run completed without exception', false, e.stack || e.message);
} finally {
  if (browser) await browser.close(); server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}
const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} drum rack checks passed`);
process.exit(pass === results.length ? 0 : 1);
