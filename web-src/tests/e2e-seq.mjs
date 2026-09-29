// Step sequencer (Squarp-style) + clip cutting, end to end in Chromium. Run: node tests/e2e-seq.mjs
// Screenshots: /workspace/daw/shots/seq-*.png and clip-*.png
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8797), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 500) : ''}`); };
const shots = path.join(ROOT, 'shots'); fs.mkdirSync(shots, { recursive: true });
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(shots, name + '.png'), ...opts });
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let browser;
const EMOJI = `(() => { const re = /[\\p{Extended_Pictographic}\\u{1F000}-\\u{1FAFF}\\u2600-\\u27BF\\uFE0F]/u; const root = document.querySelector('#seqView').closest('body');
  const hits = []; for (const el of document.querySelectorAll('#seqView *, .ph-body *')) { if (el.childNodes.length === 1 && el.firstChild.nodeType === 3 && re.test(el.textContent)) hits.push(el.textContent); for (const a of ['title', 'aria-label']) { const v = el.getAttribute(a); if (v && re.test(v)) hits.push(v); } } return hits; })()`;
// fake Web MIDI (one output) + haptics recorder
const initMocks = () => {
  window.__midiSent = []; window.__buzz = 0;
  const out = { id: 'out1', name: 'Fake Synth', state: 'connected', send(d, ts) { window.__midiSent.push({ d: [...d], ts }); }, clear() {} };
  const access = { inputs: new Map(), outputs: new Map([['out1', out]]), onstatechange: null };
  navigator.requestMIDIAccess = async () => access;
  try { Object.defineProperty(navigator, 'vibrate', { value: () => { window.__buzz++; return true; }, configurable: true }); } catch (e) {}
};
async function newPage(opts = {}, prefs = { guideDone: true, tutorialDone: true, phoneMode: 'off' }) {
  const ctx = await browser.newContext({ ...opts });
  await ctx.addInitScript((prefs) => { if (!localStorage.getItem('auduio.prefs')) localStorage.setItem('auduio.prefs', JSON.stringify(prefs)); }, prefs);
  await ctx.addInitScript(initMocks);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(URL_); await start(page);
  return { ctx, page };
}
async function start(page) { await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(300); }
const P = (page, fn, arg) => page.evaluate(fn, arg);
// record every note the instrument of track tid receives (the sequencer calls playNote through the MIDI effects chain)
const spy = (page, tid) => P(page, (tid) => { window.__notes = window.__notes || {}; const L = (window.__notes[tid] = []); const n = __daw.engine.tracks.get(tid);
  const o = n.inst.playNote.bind(n.inst); n.inst.playNote = (note, v, t, d) => { L.push({ note, v, t, d, cutoff: n.inst.values.cutoff, now: __daw.engine.ctx.currentTime }); return o(note, v, t, d); }; }, tid);
const notes = (page, tid) => P(page, (tid) => (window.__notes && window.__notes[tid]) || [], tid);
const sel = (page) => P(page, () => __daw.S.selected);
const seqOf = (page, tid) => P(page, (tid) => JSON.parse(JSON.stringify(__daw.S.project.tracks.find((t) => t.id === tid).seq)), tid);
const play = (page) => P(page, () => __daw.engine.play(0));
const stop = (page) => P(page, () => { __daw.engine.stop(); __daw.engine.stop(); });
const setRange = (page, selector, v) => P(page, ([s, v]) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, [selector, v]);
const inspSlider = (label) => `.sq-insp input[aria-label="${label}"]`;

try {
  browser = await chromium.launch({ headless: true, ...(process.env.DAW_BROWSER ? { executablePath: process.env.DAW_BROWSER } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });

  // ---------------- view
  await page.click('.views button[data-view=seq]'); await sleep(150);
  const v0 = await P(page, () => ({ shown: !document.querySelector('#seqView').hidden, btn: document.querySelector('.views button[data-view=seq]').classList.contains('on'), text: document.querySelector('#seqView').innerText }));
  ok('"Seq" main view opens from the view switcher and offers New synth / drum sequence', v0.shown && v0.btn && /New synth sequence/.test(v0.text) && /New drum sequence/.test(v0.text));
  await page.keyboard.press('Tab'); const afterTab = await P(page, () => __daw.S.view); await page.click('.views button[data-view=seq]');
  ok('Tab key cycles Session -> Arrange -> Seq -> Session', afterTab === 'session');

  // ---------------- create + step entry
  await page.click('.sq-tadd button'); await sleep(200);
  const T1 = await sel(page);
  for (const i of [0, 4, 8, 12]) await page.click(`.sq-step[data-si="${i}"]`);
  let q = await seqOf(page, T1);
  const pstr = q.patterns[0].steps.slice(0, 16).map((s) => (s.on ? 'x' : '.')).join('');
  ok('New synth sequence: MIDI track with a sequencer; tapping steps 1, 5, 9, 13 turns them on', pstr === 'x...x...x...x...', pstr);
  // ---------------- playback drives the native instrument
  await spy(page, T1); await play(page); await sleep(1300); await stop(page);
  let N = await notes(page, T1); let d = N.slice(1).map((x, i) => +(x.t - N[i].t).toFixed(3));
  ok('Playback: the sequencer plays the synth on every 4th 1/16 step (0.5 s apart at 120 BPM)', N.length >= 2 && d.every((x) => Math.abs(x - 0.5) < 0.005) && N.every((x) => x.note === 60), JSON.stringify(d));
  // through the MIDI effects chain (Chord) -> 3 notes per step
  await P(page, (tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); (t.midiFx = t.midiFx || []).push({ type: 'chord', enabled: true, values: { shape: 'major', inversion: 0, spread: 0, velScale: 85, fit: 'off' } }); __daw.engine.setMidiFx(t); }, T1);
  await spy(page, T1); await play(page); await sleep(300); await stop(page);
  N = await notes(page, T1);
  ok('Sequencer notes go through the track\'s MIDI effects (Chord adds notes)', N.length >= 3 && new Set(N.map((x) => x.note)).size >= 3, N.map((x) => x.note).join(','));
  await P(page, (tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); t.midiFx = []; __daw.engine.setMidiFx(t); }, T1);

  // ---------------- inspector: ratchet, chance, p-lock via the list
  await page.click('.sq-step[data-si="4"] .sq-num'); await sleep(80);
  await setRange(page, inspSlider('Repeat'), 3);
  await page.click('.sq-step[data-si="8"] .sq-num'); await sleep(80);
  await setRange(page, inspSlider('Chance'), 0);
  await page.click('.sq-step[data-si="4"] .sq-num'); await sleep(80);
  await P(page, () => { const s = document.querySelector('.sq-pladd'); const o = [...s.options].find((x) => x.textContent === 'Analog Synth: Cutoff'); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(80);
  await setRange(page, '.sq-plrow input[type=range]', 400); await sleep(80);
  q = await seqOf(page, T1); const st4 = q.patterns[0].steps[4];
  ok('Step inspector: Repeat 3 on step 5, Chance 0 % on step 9, parameter lock Cutoff = 400 Hz on step 5', st4.rat === 3 && q.patterns[0].steps[8].prob === 0 && st4.pl && Math.abs(st4.pl['inst|cutoff'] - 400) < 1, JSON.stringify(st4));
  await shot(page, 'seq-desktop-synth');
  await spy(page, T1); await play(page); await sleep(2100); await stop(page);
  N = await notes(page, T1);
  const rel = N.map((x) => +((x.t - N[0].t) % 2).toFixed(4));
  const rat = N.filter((x) => x.cutoff === 400), plain = N.filter((x) => x.cutoff !== 400);
  ok('Playback: step 5 ratchets 3x (1/3-step apart) with the locked cutoff 400; step 9 (0 %) never plays; other steps use the synth\'s own cutoff',
    rat.length >= 3 && Math.abs(rat[1].t - rat[0].t - 0.125 / 3) < 0.003 && !rel.some((r) => Math.abs(r - 1.0) < 0.01) && plain.length >= 2 && plain.every((x) => x.cutoff !== 400), `n=${N.length} rat=${rat.length} rel=${rel.join(',')}`);
  const base = await P(page, (tid) => __daw.S.project.tracks.find((x) => x.id === tid).inst.values.cutoff, T1);
  ok('P-locks never change the saved device value', base !== 400, base);

  // ---------------- P-Lock mode: turn a device knob -> lock on the selected step
  await page.click('.sq-step[data-si="12"] .sq-num'); await page.click('.sq-plock'); await sleep(100);
  const plockOn = await P(page, () => document.body.classList.contains('sq-plock'));
  await P(page, () => { const k = [...document.querySelectorAll('#devices [data-learn]')].find((e) => /:inst:cutoff$/.test(e.dataset.learn)); k.focus(); });
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await sleep(100);
  q = await seqOf(page, T1);
  const base2 = await P(page, (tid) => __daw.engine.tracks.get(tid).inst.values.cutoff, T1);
  ok('P-Lock mode: moving the Cutoff knob in the device panel writes a lock on step 13 instead of changing the synth', plockOn && q.patterns[0].steps[12].pl && q.patterns[0].steps[12].pl['inst|cutoff'] > base && base2 === base, JSON.stringify(q.patterns[0].steps[12].pl) + ' base=' + base2);
  await shot(page, 'seq-desktop-plock-mode');
  await page.click('.sq-plock');
  // undo / redo
  await page.keyboard.press('Control+z'); await sleep(150); q = await seqOf(page, T1);
  const undone = !q.patterns[0].steps[12].pl;
  await page.keyboard.press('Control+Shift+z'); await sleep(150); q = await seqOf(page, T1);
  ok('Undo removes the lock, redo brings it back', undone && !!q.patterns[0].steps[12].pl);

  // ---------------- polymeter: a 3-step drum pattern against the 16-step synth
  await page.click('.sq-tadd button:nth-child(2)'); await sleep(200);
  const T2 = await sel(page);
  await P(page, () => { const el = document.querySelector('.sq-len'); el.value = 3; el.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(100);
  await page.click('.sq-dcell[data-si="0"][data-n="36"]'); await page.click('.sq-dcell[data-si="1"][data-n="42"]');
  q = await seqOf(page, T2);
  ok('Drum sequence: pad rows (Kick, Snare, Hat...), per-track length 3', q.patterns[0].len === 3 && q.patterns[0].steps[0].n.includes(36) && q.patterns[0].steps[1].n.includes(42) && await P(page, () => document.querySelectorAll('.sq-drow').length >= 9));
  await shot(page, 'seq-desktop-drums');
  await spy(page, T2); await spy(page, T1); await play(page); await sleep(1600); await stop(page);
  const kicks = (await notes(page, T2)).filter((x) => x.note === 36); const dk = kicks.slice(1).map((x, i) => +(x.t - kicks[i].t).toFixed(3));
  ok('Polymeter: the 3-step drum pattern repeats every 3/16 (0.375 s) while the synth repeats every 16/16', kicks.length >= 3 && dk.every((x) => Math.abs(x - 0.375) < 0.005), dk.join(','));
  await page.selectOption('.sq-rate', '1/8t'); await spy(page, T2); await play(page); await sleep(1300); await stop(page);
  const k2 = (await notes(page, T2)).filter((x) => x.note === 36); const dk2 = k2.slice(1).map((x, i) => +(x.t - k2[i].t).toFixed(3));
  ok('Polyrhythm: per-track step rate 1/8t -> kick every 3 triplet-eighths (0.5 s)', k2.length >= 2 && dk2.every((x) => Math.abs(x - 0.5) < 0.005), dk2.join(','));

  // ---------------- pattern slots, chain, song mode
  await P(page, (tid) => { __daw.S.selected = tid; __daw.S.project.bpm = 240; document.querySelector('#bpm').value = 240; }, T1); await P(page, () => document.querySelector('.views button[data-view=seq]').click()); await sleep(100);
  await page.click('.sq-slot[data-slot="1"]'); await sleep(100);
  await page.click('.sq-step[data-si="0"]'); await page.click('.sq-step[data-si="0"] .sq-num'); await sleep(50);
  await page.click('.sq-step[data-si="0"] .sq-num'); await page.click('.sq-key[data-note="72"]'); await sleep(50);
  q = await seqOf(page, T1);
  ok('Pattern slot B: new pattern, step 1 set to C5 from the on-screen keys', q.active === 1 && q.patterns[1] && q.patterns[1].steps[0].on && q.patterns[1].steps[0].n[0] === 72, JSON.stringify(q.patterns[1] && q.patterns[1].steps[0]));
  await page.click('.sq-slot[data-slot="0"]'); await page.click('.sq-chadd'); await page.click('.sq-chadd');
  await page.click('.sq-slot[data-slot="1"]'); await page.click('.sq-chadd'); await page.click('.sq-song'); await sleep(80);
  q = await seqOf(page, T1);
  ok('Chain: A x2, B x1 and Song mode on', q.song && JSON.stringify(q.chain) === '[{"p":0,"rep":2},{"p":1,"rep":1}]', JSON.stringify(q.chain));
  await spy(page, T1); await play(page); await sleep(2600);
  const midSong = await P(page, () => document.querySelector('.sq-chip.playing') ? document.querySelector('.sq-chip.playing').dataset.k : null);
  await shot(page, 'seq-desktop-song');
  await sleep(500); await stop(page);
  N = await notes(page, T1);
  const first72 = N.find((x) => x.note === 72), start0 = N[0] && N[0].t;
  ok('Song mode plays A twice (2 bars at 240 BPM = 2 s) then B (C5 at 2.0 s)', first72 && Math.abs(first72.t - start0 - 2.0) < 0.01 && N.filter((x) => x.note === 72 && x.t < start0 + 2).length === 0, first72 ? (first72.t - start0).toFixed(3) : 'no C5');
  ok('Song mode highlights the playing chain entry', midSong === '1', midSong);
  await page.click('.sq-song');
  // queued switch while playing
  await page.click('.sq-slot[data-slot="0"]'); await play(page); await sleep(200);
  await page.click('.sq-slot[data-slot="1"]'); await sleep(60);
  const qd = await P(page, (tid) => ({ active: __daw.S.project.tracks.find((t) => t.id === tid).seq.active, cls: document.querySelector('.sq-slot[data-slot="1"]').className }), T1);
  await sleep(1100); const qa = await P(page, (tid) => __daw.S.project.tracks.find((t) => t.id === tid).seq.active, T1); await stop(page);
  ok('Switching patterns while playing waits for the end of the current pattern (slot blinks as queued)', qd.active === 0 && /queued/.test(qd.cls) && qa === 1, JSON.stringify(qd) + ' after=' + qa);

  // ---------------- live record (quantized) and step record
  await page.click('.sq-slot[data-slot="2"]'); await page.click('.sq-lrec'); await play(page); await sleep(300);
  await P(page, () => __daw.MIDI.onNote('in', 0, 67, 101, true)); await sleep(120); await P(page, () => __daw.MIDI.onNote('in', 0, 67, 0, false)); await sleep(200);
  await stop(page); await page.click('.sq-lrec');
  q = await seqOf(page, T1); const recd = q.patterns[2].steps.filter((s) => s.on && s.n.includes(67));
  ok('Live record: a MIDI note played during playback lands on the nearest step (quantized, velocity kept)', recd.length === 1 && recd[0].nudge === 0 && recd[0].v === 101, JSON.stringify(recd));
  await page.click('.sq-slot[data-slot="3"]'); await page.click('.sq-srec'); await sleep(50);
  for (const n of [60, 62, 64]) await page.click(`.sq-key[data-note="${n}"]`);
  await P(page, () => { __daw.MIDI.onNote('in', 0, 65, 90, true); __daw.MIDI.onNote('in', 0, 65, 0, false); });
  await page.click('.sq-srec');
  q = await seqOf(page, T1); const sr = q.patterns[3].steps.slice(0, 5).map((s) => (s.on ? s.n[0] : '-')).join(',');
  ok('Step record: keys and MIDI notes fill steps 1, 2, 3, 4 in order', sr === '60,62,64,65,-', sr);

  // ---------------- randomizer respects locks
  await page.click('.sq-slot[data-slot="0"]'); await sleep(50);
  await page.click('.sq-step[data-si="0"] .sq-num'); await page.click('.sq-insp button[title^="Protect"]'); await sleep(50);
  await page.click('.sq-rand .rand-more'); await sleep(80);
  await P(page, () => [...document.querySelectorAll('.rand-pop .rp-chip')].find((b) => /Notes/.test(b.textContent)).click()); await page.keyboard.press('Escape'); await P(page, () => document.querySelectorAll('.popover').forEach((p) => p.remove()));
  const beforeR = await seqOf(page, T1);
  await page.click('.sq-rand .rand-btn'); await sleep(150);
  const afterR = await seqOf(page, T1);
  const A0 = beforeR.patterns[0].steps, A1 = afterR.patterns[0].steps;
  const changedSteps = A1.slice(0, 16).filter((s, i) => JSON.stringify(s) !== JSON.stringify(A0[i])).length;
  ok('Randomize pattern: changes steps but not the protected step 1, not the locked Notes, and keeps p-locks',
    changedSteps > 0 && JSON.stringify(A1[0]) === JSON.stringify(A0[0]) && A1.every((s, i) => s.n.join() === A0[i].n.join()) && JSON.stringify(A1[4].pl) === JSON.stringify(A0[4].pl), `changed=${changedSteps} locks=${JSON.stringify(afterR.locks)}`);
  await page.keyboard.press('Control+z'); await sleep(150);
  ok('One undo reverts the whole randomize', JSON.stringify((await seqOf(page, T1)).patterns[0].steps) === JSON.stringify(A0));

  // ---------------- loop bar: loop 0-0.5 s (half a bar at 240 BPM) -> only steps 1-8 ever play
  await P(page, () => __daw.engine.setLoop({ on: true, start: 0, end: 0.5 }));
  await play(page); const seen = new Set();
  for (let i = 0; i < 30; i++) { const ph = await P(page, (tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); const p = __daw.engine.seq.playheadOf(t); return p ? p.si : -1; }, T1); seen.add(ph); await sleep(50); }
  await stop(page); await P(page, () => __daw.engine.setLoop({ on: false, start: 0, end: 4 }));
  ok('Loop bar: with a half-bar loop the sequencer wraps with the transport (only steps 1-8 play)', [...seen].every((s) => s < 8) && seen.size >= 4, [...seen].join(','));

  // ---------------- external MIDI out (mocked Web MIDI)
  await page.selectOption('.sq-out', 'both'); await sleep(300);
  const ports = await P(page, () => [...document.querySelectorAll('.sq-port option')].map((o) => o.textContent));
  await play(page); await sleep(600); await stop(page); await sleep(50);
  const sent = await P(page, () => window.__midiSent);
  const ons = sent.filter((m) => (m.d[0] & 0xf0) === 0x90), offs = sent.filter((m) => (m.d[0] & 0xf0) === 0x80), cc = sent.filter((m) => m.d[0] === 0xb0 && m.d[1] === 123);
  ok('MIDI out: lists the output port, sends timed note on/off on channel 1, all-notes-off on stop', ports.includes('Fake Synth') && ons.length >= 2 && offs.length >= 2 && ons.every((m) => typeof m.ts === 'number' && m.ts > 0) && cc.length >= 1, `ports=${ports} on=${ons.length} cc=${cc.length}`);
  await page.selectOption('.sq-out', 'track');

  // ---------------- persistence: autosave + reload + import validation keep the sequencer
  await sleep(1600); await page.reload(); await start(page);
  const after = await P(page, (tid) => { const t = __daw.S.project.tracks.find((x) => x.id === tid); return t && t.seq ? { n: t.seq.patterns.filter(Boolean).length, rat: t.seq.patterns[0].steps[4].rat, pl: t.seq.patterns[0].steps[4].pl, chain: t.seq.chain.length } : null; }, T1);
  ok('Sequencer data survives save + reload (validated on load): 4 patterns, ratchet, p-lock, chain', after && after.n === 4 && after.rat === 3 && after.pl && after.chain === 2, JSON.stringify(after));
  const emo = await P(page, EMOJI); ok('No emoji in the sequencer UI', emo.length === 0, emo.join('|'));

  // ---------------- clip cutting (arrangement)
  const mk = `(() => { const { engine, S } = __daw; const sr = engine.ctx.sampleRate, b = engine.ctx.createBuffer(2, sr * 8, sr); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.3 * Math.sin(i / 20); } engine.buffers.set('bx', b);
    const t = S.project.tracks.find((x) => x.kind === 'audio'); t.arrangement = [{ id: 'cx', bufferId: 'bx', start: 0, offset: 0, duration: 8, name: 'Take' }]; engine.rescheduleTrack(t); S.selected = t.id; S.sel = null; document.querySelector('.views button[data-view=arrange]').click(); return t.id; })()`;
  const TA = await P(page, mk); await sleep(200);
  const clips = () => P(page, (tid) => __daw.S.project.tracks.find((x) => x.id === tid).arrangement.map((c) => [+c.start.toFixed(3), +c.duration.toFixed(3), +(c.offset || 0).toFixed(3)]).sort((a, b) => a[0] - b[0]), TA);
  await P(page, () => __daw.engine.setPosition(1)); await page.keyboard.press('Control+e'); await sleep(100);
  const c1 = await clips();
  ok('Ctrl/Cmd+E splits the clip under the playhead (no selection needed)', JSON.stringify(c1) === '[[0,1,0],[1,7,1]]', JSON.stringify(c1));
  await page.keyboard.press('Control+z'); await sleep(100);
  ok('Undo joins it back', JSON.stringify(await clips()) === '[[0,8,0]]');
  await page.click('.cut-btn'); await sleep(50);
  const box = await P(page, () => { const r = document.querySelector('.aclip[data-clip="cx"]').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, zoom: __daw.S.zoom }; });
  await page.mouse.move(box.x + box.zoom * 2 + 1, box.y); await sleep(50);
  await shot(page, 'clip-cut-tool');
  await page.mouse.down(); await page.mouse.up(); await sleep(100);
  const c2 = await clips();
  ok('Cut tool: clicking the clip splits it right there (snapped to the beat: 2.0 s)', JSON.stringify(c2) === '[[0,2,0],[2,6,2]]', JSON.stringify(c2));
  await page.keyboard.press('x');
  ok('Key X turns the cut tool off again (B stays the browser toggle)', await P(page, () => !__daw.S.tool && !document.querySelector('#arrangeView').classList.contains('razor')));
  await P(page, () => { __daw.S.project.loop = { on: true, start: 3, end: 5 }; __daw.engine.setLoop(__daw.S.project.loop); });
  await page.click('.edit-btn'); await P(page, () => [...document.querySelectorAll('.ctxmenu button')].find((b) => /Split at loop edges/.test(b.textContent)).click()); await sleep(100);
  const c3 = await clips();
  ok('Edit > Split at loop edges cuts at the loop start and end', JSON.stringify(c3) === '[[0,2,0],[2,1,2],[3,2,3],[5,3,5]]', JSON.stringify(c3));
  await page.click('.edit-btn'); await P(page, () => [...document.querySelectorAll('.ctxmenu button')].find((b) => /Cut out loop section/.test(b.textContent)).click()); await sleep(100);
  const c4 = await clips();
  ok('Edit > Cut out loop section removes 3-5 s and closes the gap', JSON.stringify(c4) === '[[0,2,0],[2,1,2],[3,3,5]]', JSON.stringify(c4));
  await page.keyboard.press('Control+z'); await sleep(80);
  await page.click('.edit-btn'); await P(page, () => [...document.querySelectorAll('.ctxmenu button')].find((b) => /Delete loop section/.test(b.textContent)).click()); await sleep(100);
  const c5 = await clips();
  ok('Edit > Delete loop section leaves a gap', JSON.stringify(c5) === '[[0,2,0],[2,1,2],[5,3,5]]', JSON.stringify(c5));
  // right-click / long-press menu: "Split here"
  const bx = await P(page, () => { const el = [...document.querySelectorAll('.aclip')].find((e) => e._clip && Math.abs(e._clip.start - 5) < 1e-6); const r = el.getBoundingClientRect(); return { x: r.left + __daw.S.zoom * 1 + 1, y: r.top + r.height / 2 }; });
  await page.mouse.click(bx.x, bx.y, { button: 'right' }); await sleep(80);
  const hasHere = await P(page, () => [...document.querySelectorAll('.ctxmenu button')].map((b) => b.textContent));
  await P(page, () => [...document.querySelectorAll('.ctxmenu button')].find((b) => b.textContent === 'Split here').click()); await sleep(100);
  const c6 = await clips();
  ok('Long-press / right-click menu has "Split here" and splits at that point (MIDI and audio use the same code)', hasHere.includes('Split here') && JSON.stringify(c6) === '[[0,2,0],[2,1,2],[5,1,5],[6,2,6]]', JSON.stringify(c6));
  // MIDI clip split keeps notes playing from the right place
  const mid = await P(page, () => { const { S, engine } = __daw; const t = S.project.tracks.find((x) => x.seq); t.arrangement = [{ id: 'mx', type: 'midi', name: 'M', start: 0, offset: 0, lengthBeats: 8, duration: 4, notes: [{ t: 0, d: 1, n: 60, v: 100 }, { t: 6, d: 1, n: 64, v: 100 }] }]; S.selected = t.id; S.sel = { kind: 'arr', trackId: t.id, clipId: 'mx' }; engine.setPosition(2); return t.id; });
  await page.keyboard.press('Control+e'); await sleep(80);
  const mc = await P(page, (tid) => __daw.S.project.tracks.find((x) => x.id === tid).arrangement.map((c) => ({ s: c.start, d: c.duration, o: c.offset, n: c.notes.length })).sort((a, b) => a.s - b.s), mid);
  ok('MIDI clip split (Ctrl/Cmd+E on a selected clip): two clips, the right one starts 2 s into the notes', mc.length === 2 && mc[1].s === 2 && mc[1].o === 2 && mc[0].d === 2 && mc[1].n === 2, JSON.stringify(mc));
  await ctx.close();

  // ---------------- phone layout
  const ph = await newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, { guideDone: true, tutorialDone: true, phoneMode: 'on', haptics: true });
  const pp = ph.page;
  await P(pp, () => { const { S } = __daw; const t = S.project.tracks.find((x) => x.kind === 'audio'); S.selected = t.id; });
  await P(pp, () => document.querySelector('.ph-tab[data-tab=seq]').click()); await sleep(150);
  const needMidi = await P(pp, () => document.querySelector('.ph-body').innerText);
  await P(pp, () => [...document.querySelectorAll('.ph-body .ph-big')].find((b) => /instrument track/i.test(b.textContent)).click()); await sleep(250);
  const phq = await P(pp, () => ({ grid: !!document.querySelector('.ph-body .sq-grid'), cols: getComputedStyle(document.querySelector('.ph-body .sq-grid')).gridTemplateColumns.split(' ').length, h: document.querySelector('.ph-body .sq-step').getBoundingClientRect().height }));
  ok('Phone: "Steps" tab explains it needs an instrument track, makes one, shows 8 steps per row with big touch targets', /instrument \(MIDI\) tracks/.test(needMidi) && phq.grid && phq.cols === 8 && phq.h >= 44, JSON.stringify(phq));
  const b0 = await P(pp, () => window.__buzz);
  for (const i of [0, 3, 6, 10, 12]) await pp.tap(`.ph-body .sq-step[data-si="${i}"]`);
  const PT = await sel(pp);
  const phs = await seqOf(pp, PT); const buzz = await P(pp, () => window.__buzz);
  ok('Phone: tapping steps turns them on, with haptic feedback', phs.patterns[0].steps.filter((s) => s.on).length === 5 && buzz > b0, `buzz=${buzz - b0}`);
  await P(pp, (tid) => { const p = __daw.S.project.tracks.find((t) => t.id === tid).seq.patterns[0]; p.steps[3].prob = 50; p.steps[6].rat = 3; p.steps[10].pl = { 'inst|cutoff': 600 }; __daw.phone.render(); }, PT);
  await pp.tap('.ph-body .sq-step[data-si="6"] .sq-num'); await sleep(100);
  await P(pp, () => __daw.engine.play(0)); await sleep(700);
  await shot(pp, 'seq-phone-steps');
  await P(pp, () => { __daw.engine.stop(); __daw.engine.stop(); });
  await P(pp, () => document.querySelector('.ph-body').scrollTop = 400); await sleep(100);
  await shot(pp, 'seq-phone-steps-inspector');
  // phone drums
  await P(pp, () => { document.querySelector('.ph-tab[data-tab=tracks]').click(); [...document.querySelectorAll('.ph-body .ph-big')].find((b) => /Tap drum pads/.test(b.textContent)).click(); }); await sleep(150);
  await P(pp, () => { const { S } = __daw; const L = S.project.tracks.filter((x) => x.kind === 'midi' && x.inst.type === 'drums'); S.selected = L[L.length - 1].id; document.querySelector('.ph-tab[data-tab=seq]').click(); }); await sleep(150);
  const hasDrum = await P(pp, () => { const b = [...document.querySelectorAll('.ph-body button')].find((x) => /Add step sequencer/.test(x.textContent)); if (b) b.click(); return !!b; }); await sleep(150);
  if (hasDrum) { for (const [si, n] of [[0, 36], [4, 36], [2, 42], [6, 42], [4, 38]]) await pp.tap(`.ph-body .sq-dcell[data-si="${si}"][data-n="${n}"]`); }
  const dcols = await P(pp, () => document.querySelectorAll('.ph-body .sq-drow.head .sq-dnum').length);
  ok('Phone drums: pad rows, 8 steps per page', hasDrum && dcols === 8, `cols=${dcols}`);
  await P(pp, () => document.querySelector('.ph-body').scrollTop = 0);
  await shot(pp, 'seq-phone-drums');
  // phone clip long-press -> Split here
  await P(pp, () => { const { engine, S } = __daw; const sr = engine.ctx.sampleRate, b = engine.ctx.createBuffer(1, sr * 4, sr); engine.buffers.set('bp', b); const t = S.project.tracks.find((x) => x.kind === 'audio'); t.arrangement = [{ id: 'cp', bufferId: 'bp', start: 0, offset: 0, duration: 4, name: 'Vocal' }]; S.selected = t.id; engine.setPosition(1.5); document.querySelector('.ph-tab[data-tab=tracks]').click(); });
  await sleep(150);
  await P(pp, () => document.querySelector('.ph-clip').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))); await sleep(150);
  const sheet = await P(pp, () => [...document.querySelectorAll('.ph-sheet .ph-big .b1')].map((x) => x.textContent.trim()));
  await shot(pp, 'clip-phone-split-menu');
  await sleep(1600); // the long-press guard ignores taps for a moment (a real finger lifts first)
  await P(pp, () => document.querySelector('.ph-sheet .ph-split').click()); await sleep(150);
  const pc = await P(pp, () => __daw.S.project.tracks.find((x) => x.kind === 'audio').arrangement.map((c) => [c.start, c.duration]).sort((a, b) => a[0] - b[0]));
  ok('Phone: long-press a clip -> "Split here" splits it at the playhead (1.5 s)', sheet.includes('Split here') && JSON.stringify(pc) === '[[0,1.5],[1.5,2.5]]', JSON.stringify(sheet) + ' ' + JSON.stringify(pc));
  await P(pp, () => document.querySelector('.ph-undo').click()); await sleep(100);
  ok('Phone: Undo button joins it back', await P(pp, () => __daw.S.project.tracks.find((x) => x.kind === 'audio').arrangement.length === 1));
  await ph.ctx.close();

  const bad = errors.filter((e) => !/Refused to execute inline script|Executing inline script violates|favicon/.test(e));
  ok('No page errors or CSP violations', bad.length === 0, bad.slice(0, 5).join(' | '));
} catch (e) {
  ok('test run finished without exceptions', false, e.stack || e.message);
} finally {
  if (browser) await browser.close(); server.kill();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${pass}/${results.length} passed`);
  fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-seq.json'), JSON.stringify({ when: new Date().toISOString(), pass, total: results.length, results }, null, 2));
  process.exit(pass === results.length ? 0 : 1);
}
