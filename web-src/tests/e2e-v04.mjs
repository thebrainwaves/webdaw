// v0.4: device browser sidebar, native MIDI effects, randomizer on every device. Run: node tests/e2e-v04.mjs
// Screenshots for the report go to /workspace/daw/shots/.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8772), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 600) : ''}`); };
const shots = path.join(ROOT, 'shots'); fs.mkdirSync(shots, { recursive: true });
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(shots, name + '.png'), ...opts });
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
let browser;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCAN = `(() => {
  const re = /[\\p{Extended_Pictographic}\\u{1F000}-\\u{1FAFF}\\u2600-\\u27BF\\u25A0-\\u25FF\\u2300-\\u23FF\\u2193-\\u21FF\\uFF0B\\uFE0F]/u;
  const hits = []; const root = document.querySelector('#browser');
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n; while ((n = walk.nextNode())) { if (re.test(n.nodeValue)) hits.push('text:' + n.nodeValue.trim().slice(0, 40)); }
  for (const el of root.querySelectorAll('[title],[aria-label],[placeholder]')) for (const a of ['title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v && re.test(v)) hits.push(a + ':' + v.slice(0, 40)); }
  for (const el of document.querySelectorAll('.rand-pop, .rand-pop *, .dev-bar, .dev-bar *')) { const v = el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.textContent : ''; if (re.test(v)) hits.push('dev:' + v); }
  return [...new Set(hits)];
})()`;
async function newPage(opts = {}, prefs = { guideDone: true, tutorialDone: true, phoneMode: 'off' }) {
  const ctx = await browser.newContext({ permissions: ['microphone'], ...opts });
  await ctx.addInitScript((prefs) => { if (prefs && !localStorage.getItem('auduio.prefs')) localStorage.setItem('auduio.prefs', JSON.stringify(prefs)); }, prefs);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Refused to execute inline script|Executing inline script violates/.test(m.text())) errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(URL_);
  await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(300);
  return { ctx, page };
}
const P = (page, fn, arg) => page.evaluate(fn, arg);
const tracks = (page) => P(page, () => __daw.S.project.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, inst: t.inst && t.inst.type, fx: t.fx.map((f) => f.type), midiFx: (t.midiFx || []).map((f) => f.type) })));

try {
  browser = await chromium.launch({ headless: true, ...(process.env.DAW_BROWSER ? { executablePath: process.env.DAW_BROWSER } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });

  // ---------------- browser sidebar
  const sb = await P(page, () => {
    const b = document.querySelector('#browser'), r = b.getBoundingClientRect();
    const secs = [...b.querySelectorAll('.br-sec')].map((s) => ({ id: s.dataset.sec, label: s.querySelector('.br-sec-label').textContent, n: s.querySelectorAll('.br-item').length, svg: !!s.querySelector('.br-sec-head svg') }));
    return { w: r.width, visible: r.width > 100 && getComputedStyle(b).display !== 'none', secs, items: [...b.querySelectorAll('.br-item .br-label')].map((x) => x.textContent) };
  });
  ok('Browser sidebar is shown on desktop with Instruments, MIDI Effects, Audio Effects, Racks and Plugins sections (SVG icons)',
    sb.visible && sb.secs.map((s) => s.id).join() === 'inst,midifx,fx,racks,plugins' && sb.secs.every((s) => s.svg), JSON.stringify(sb.secs) + ' w=' + sb.w);
  ok('Lists the 3 native instruments, 6 MIDI effects (Arpeggiator, Chord, Scale, Note Length, Velocity, Random) and the 12 audio effects',
    ['Analog Synth', 'Wavetable Synth', 'Drum Kit', 'Arpeggiator', 'Chord', 'Scale', 'Note Length', 'Velocity', 'Random', 'Parametric EQ', 'Compressor', 'Reverb', 'Delay', 'Pitch Correct', 'Tremolo'].every((x) => sb.items.includes(x)) && sb.secs[1].n === 6 && sb.secs[2].n === 12, sb.items.join(', '));
  const plug = await P(page, () => { const s = document.querySelector('.br-sec[data-sec=plugins]'); s.scrollIntoView(); const n = s.querySelector('.br-note'); return { note: n && n.textContent, cls: n && n.className, items: s.querySelectorAll('.br-item').length }; });
  ok('Web: Plugins section says "Desktop app only" (no plugin items, no scan button)', /Desktop app only/.test(plug.note || '') && /desktop-only/.test(plug.cls) && plug.items === 0, JSON.stringify(plug));
  const emo = await P(page, SCAN);
  ok('No emoji in the browser sidebar', emo.length === 0, emo.join(' | '));
  await P(page, () => document.querySelector('.br-list').scrollTop = 0);
  await shot(page, 'sidebar');
  await page.locator('#browser').screenshot({ path: path.join(shots, 'sidebar-closeup.png') });

  // search
  await page.fill('.br-search', 'verb'); await sleep(100);
  const found = await P(page, () => [...document.querySelectorAll('#browser .br-item .br-label')].map((x) => x.textContent));
  ok('Search filters the list ("verb" -> Reverb)', found.length >= 1 && found.includes('Reverb') && !found.includes('Compressor'), found.join(','));
  await page.fill('.br-search', ''); await sleep(50);

  // double-click adds to the selected track (+ one undo step)
  const t0 = await tracks(page);
  await page.dblclick('.br-item[data-kind=fx][data-type=reverb]'); await sleep(200);
  let t1 = await tracks(page);
  const sel = await P(page, () => __daw.S.selected);
  ok('Double-click on an audio effect adds it to the selected track', t1.find((t) => t.id === sel).fx.slice(-1)[0] === 'reverb', JSON.stringify(t1));
  await page.keyboard.press('Control+z'); await sleep(200);
  ok('Undo removes the added effect', JSON.stringify(await tracks(page)) === JSON.stringify(t0));

  // + button
  await page.hover('.br-item[data-kind=fx][data-type=delay]'); await page.click('.br-item[data-kind=fx][data-type=delay] .br-add'); await sleep(150);
  ok('The + button on a row adds the device too (for touch / people who do not drag)', (await tracks(page)).find((t) => t.id === sel).fx.includes('delay'));

  // drag onto a track column
  const other = t0[1].id;
  await page.dragAndDrop('.br-item[data-kind=fx][data-type=compressor]', `#sessionView .col[data-id="${other}"] .col-head`); await sleep(250);
  t1 = await tracks(page);
  ok('Dragging an effect onto a track header adds it to that track', t1.find((t) => t.id === other).fx.includes('compressor'), JSON.stringify(t1.find((t) => t.id === other)));

  // drag an instrument to empty space -> new MIDI track
  const n0 = t1.length;
  const box = await page.locator('#sessionView').boundingBox();
  await page.dragAndDrop('.br-item[data-kind=inst][data-type=drums]', '#sessionView', { targetPosition: { x: box.width - 60, y: box.height - 60 } }); await sleep(250);
  t1 = await tracks(page);
  ok('Dragging an instrument onto empty space creates a new MIDI track with it', t1.length === n0 + 1 && t1[t1.length - 1].kind === 'midi' && t1[t1.length - 1].inst === 'drums', JSON.stringify(t1.slice(-1)));
  // drag an instrument onto an existing MIDI track -> swaps the instrument
  const drumId = t1[t1.length - 1].id;
  await page.dragAndDrop('.br-item[data-kind=inst][data-type=wavetable]', `#sessionView .col[data-id="${drumId}"] .col-head`); await sleep(250);
  ok('Dropping an instrument on a MIDI track replaces its instrument', (await tracks(page)).find((t) => t.id === drumId).inst === 'wavetable');

  // MIDI effect on an audio track -> new MIDI track with synth + the MIDI effect
  await P(page, (id) => { __daw.S.selected = id; }, t0[0].id);
  await page.dblclick('.br-item[data-kind=midifx][data-type=arp]'); await sleep(250);
  t1 = await tracks(page);
  const arpT = t1[t1.length - 1];
  ok('Adding a MIDI effect with an audio track selected makes a new MIDI track (synth + arpeggiator) in one undo step', arpT.kind === 'midi' && arpT.inst === 'synth' && arpT.midiFx.join() === 'arp', JSON.stringify(arpT));
  const hist = await P(page, () => __daw.history.undoStack ? __daw.history.undoStack.length : null);
  await page.keyboard.press('Control+z'); await sleep(200);
  ok('...and one undo removes both', (await tracks(page)).length === t1.length - 1, 'hist ' + hist);
  await page.keyboard.press('Control+Shift+z'); await sleep(200);

  // ---------------- MIDI effects process notes
  const midi = await P(page, async (id) => {
    const { engine } = __daw; const n = engine.tracks.get(id); const got = [];
    const I = n.inst; const o = { p: I.playNote, on: I.noteOn, off: I.noteOff };
    I.playNote = (note, v, t, d) => { got.push(['p', note, +(t - engine.ctx.currentTime).toFixed(3)]); };
    I.noteOn = (note) => got.push(['on', note]); I.noteOff = (note) => got.push(['off', note]);
    // live keys through the arpeggiator: hold C E G for ~1 s at 120 BPM, 1/16 -> about 8 steps
    const dst = engine.notes(id); dst.noteOn(60, 100); dst.noteOn(64, 100); dst.noteOn(67, 100);
    await new Promise((r) => setTimeout(r, 1000)); dst.noteOff(60); dst.noteOff(64); dst.noteOff(67);
    const arpNotes = got.filter((g) => g[0] === 'p').map((g) => g[1]);
    await new Promise((r) => setTimeout(r, 400));
    const after = got.filter((g) => g[0] === 'p').length - arpNotes.length;
    Object.assign(I, { playNote: o.p, noteOn: o.on, noteOff: o.off });
    return { arpNotes, after, direct: got.filter((g) => g[0] === 'on').length };
  }, arpT.id);
  ok('Arpeggiator on live input: held C-E-G play one after another in time (up pattern), stops on release',
    midi.arpNotes.length >= 5 && midi.arpNotes.slice(0, 3).join() === '60,64,67' && midi.after <= 1 && midi.direct === 0, JSON.stringify(midi));

  // chord + scale on the same track via the device panel select
  await P(page, (id) => { __daw.S.selected = id; }, arpT.id); await P(page, () => document.querySelector('.views button[data-view=session]').click()); await sleep(100);
  await page.selectOption('.add-midifx', 'chord'); await sleep(150);
  const chord = await P(page, (id) => {
    const { engine, S } = __daw; const t = S.project.tracks.find((x) => x.id === id); t.midiFx[0].enabled = false; engine.setMidiFx(t);
    const n = engine.tracks.get(id); const got = []; const o = n.inst.playNote; n.inst.playNote = (note) => got.push(note);
    engine.notes(id).playNote(62, 100, engine.ctx.currentTime + 0.05, 0.2); n.inst.playNote = o;
    t.midiFx[0].enabled = true; engine.setMidiFx(t);
    return { got, fx: t.midiFx.map((f) => f.type), cards: document.querySelectorAll('#devices .device.midifx').length, order: [...document.querySelectorAll('#devices .device')].map((d) => d.classList.contains('midifx') ? 'm' : d.classList.contains('inst') ? 'i' : 'a').join('') };
  }, arpT.id);
  ok('"+ MIDI FX" adds a Chord; with the arp bypassed D becomes a D-major triad; MIDI effect cards sit before the instrument', chord.got.join() === '62,66,69' && chord.cards === 2 && chord.order.startsWith('mmi'), JSON.stringify(chord));
  // arrangement playback through MIDI effects
  const play = await P(page, async (id) => {
    const { engine, S } = __daw; const t = S.project.tracks.find((x) => x.id === id); const prev = t.midiFx;
    t.midiFx = [{ type: 'scale', enabled: true, values: { keySource: 'global', root: 'C', scale: 'major', transpose: 0 } }]; engine.setMidiFx(t);
    t.arrangement = [{ id: 'mc1', type: 'midi', name: 'm', start: 0, offset: 0, duration: 2, lengthBeats: 4, notes: [{ t: 0, d: 0.5, n: 61, v: 100 }, { t: 1, d: 0.5, n: 66, v: 100 }, { t: 2, d: 0.5, n: 70, v: 100 }] }];
    const n = engine.tracks.get(id); const got = []; const o = n.inst.playNote; n.inst.playNote = (note) => got.push(note);
    engine.play(0); await new Promise((r) => setTimeout(r, 1300)); engine.stop(); n.inst.playNote = o;
    t.arrangement = []; t.midiFx = prev; engine.setMidiFx(t);
    return got;
  }, arpT.id);
  ok('Arrangement MIDI clips play through MIDI effects (Scale: C#, F#, A# -> in C major)', play.length === 3 && play.every((n) => [0, 2, 4, 5, 7, 9, 11].includes(n % 12)), play.join());

  // ---------------- randomizer
  await P(page, (id) => { __daw.S.selected = id; }, t0[0].id);
  await page.dblclick('.br-item[data-kind=fx][data-type=eq]'); await sleep(200);
  await page.dblclick('.br-item[data-kind=fx][data-type=maximizer]'); await sleep(200);
  const tid = t0[0].id;
  const fxv = () => P(page, (id) => JSON.parse(JSON.stringify(__daw.S.project.tracks.find((t) => t.id === id).fx)), tid);
  const nButtons = await P(page, () => ({ cards: document.querySelectorAll('#devices .device').length, dice: document.querySelectorAll('#devices .device .rand-btn').length }));
  ok('Every device card has a randomize (dice) button', nButtons.cards >= 3 && nButtons.cards === nButtons.dice, JSON.stringify(nButtons));
  await P(page, () => document.querySelector('#devices').scrollLeft = 0);
  const before = await fxv();
  const eqIdx = before.findIndex((f) => f.type === 'eq');
  await shot(page, 'randomize-before');
  await page.click(`#devices .device[data-type=eq] .rand-btn`); await sleep(300);
  await shot(page, 'randomize-after');
  const after = await fxv();
  const eqChanged = Object.keys(after[eqIdx].values).filter((k) => after[eqIdx].values[k] !== before[eqIdx].values[k]);
  const knobShown = await P(page, () => [...document.querySelectorAll('#devices .device[data-type=eq] .knob .k-value')].map((x) => x.textContent).join(' '));
  ok('Dice on the EQ randomizes its parameters (and the knobs show the new values)', eqChanged.length >= 6 && JSON.stringify(after.filter((f, i) => i !== eqIdx)) === JSON.stringify(before.filter((f, i) => i !== eqIdx)), `changed ${eqChanged.join(',')} | ${knobShown}`);
  const engVals = await P(page, ([id, i]) => JSON.stringify(__daw.engine.fxInstances(id)[i].values) === JSON.stringify(__daw.S.project.tracks.find((t) => t.id === id).fx[i].values), [tid, eqIdx]);
  ok('Randomized values are applied to the running audio effect', engVals);
  await page.keyboard.press('Control+z'); await sleep(200);
  ok('Undo restores every randomized parameter exactly (one step)', JSON.stringify(await fxv()) === JSON.stringify(before));

  // popover: amount, musical/chaos, locks
  await page.click(`#devices .device[data-type=eq] .rand-more`); await sleep(200);
  const pop = await P(page, () => { const p = document.querySelector('.rand-pop'); return p && { amount: p.querySelector('.rp-amount').value, modes: [...p.querySelectorAll('.rp-mode')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')), chips: p.querySelectorAll('.rp-chip').length, btns: [...p.querySelectorAll('.rp-actions button')].map((b) => b.textContent) }; });
  ok('Options popover: amount slider, Musical/Chaos, a lock chip for every parameter, Device/Chain/Track/Undo', pop && pop.modes.join() === 'Musical*,Chaos' && pop.chips === 12 && pop.btns.join() === 'Device,Chain,Track,Undo', JSON.stringify(pop));
  // lock Low G + HPF
  await page.click('.rand-pop .rp-chip:has-text("HPF")'); await page.click('.rand-pop .rp-chip:has-text("Low G")'); await sleep(100);
  await shot(page, 'randomize-popover');
  const locks = await P(page, ([id, i]) => __daw.S.project.tracks.find((t) => t.id === id).fx[i].locks, [tid, eqIdx]);
  await P(page, () => { const r = document.querySelector('.rand-pop .rp-amount'); r.value = 100; r.dispatchEvent(new Event('input')); });
  const lockedBefore = (await fxv())[eqIdx].values;
  for (let i = 0; i < 5; i++) { await page.click('.rand-pop .rp-go'); await sleep(80); }
  const lockedAfter = (await fxv())[eqIdx].values;
  const lockIcons = await P(page, () => document.querySelectorAll('#devices .device[data-type=eq] .rlocked .rlock-ico').length);
  ok('Locked parameters (HPF, Low G) survive 5 randomizes at 100 %; locked knobs show a lock icon', JSON.stringify(locks) === '["hpf","lowGain"]' && lockedAfter.hpf === lockedBefore.hpf && lockedAfter.lowGain === lockedBefore.lowGain && lockedAfter.m1Freq !== lockedBefore.m1Freq && lockIcons >= 1, JSON.stringify({ locks, lockIcons, hpf: [lockedBefore.hpf, lockedAfter.hpf] }));
  // musical safety on the maximizer
  const mx = (await fxv()).findIndex((f) => f.type === 'maximizer');
  const mxBefore = (await fxv())[mx].values;
  for (let i = 0; i < 8; i++) { await page.click('#devices .device[data-type=maximizer] .rand-btn'); await sleep(60); }
  const mxAfter = (await fxv())[mx].values;
  ok('Musical mode: 8 randomizes of the Maximizer never touch its Gain or Ceiling (no clipping)', mxAfter.gain === mxBefore.gain && mxAfter.ceiling === mxBefore.ceiling && (mxAfter.release !== mxBefore.release || mxAfter.character !== mxBefore.character), JSON.stringify({ mxBefore, mxAfter }));
  // amount 0
  await page.click('#devices .device[data-type=maximizer] .rand-more'); await sleep(150);
  await P(page, () => { const r = document.querySelector('.rand-pop .rp-amount'); r.value = 0; r.dispatchEvent(new Event('input')); });
  const a0 = await fxv(); await page.click('.rand-pop .rp-go'); await sleep(100);
  ok('Amount 0 % changes nothing', JSON.stringify(await fxv()) === JSON.stringify(a0));
  await P(page, () => { const r = document.querySelector('.rand-pop .rp-amount'); r.value = 60; r.dispatchEvent(new Event('input')); });
  await page.keyboard.press('Escape'); await P(page, () => document.querySelectorAll('.popover').forEach((p) => p.remove()));

  // randomize chain: all effects in one undo step
  const c0 = await fxv();
  await page.click('.rand-chain'); await sleep(250);
  const c1 = await fxv();
  const changedDevs = c1.filter((f, i) => JSON.stringify(f.values) !== JSON.stringify(c0[i].values)).length;
  ok('Randomize chain changes every effect on the track', changedDevs === c1.length && c1.length >= 3, `${changedDevs}/${c1.length}`);
  await page.keyboard.press('Control+z'); await sleep(200);
  ok('One undo restores the whole chain', JSON.stringify(await fxv()) === JSON.stringify(c0));

  // randomize track on a MIDI track: MIDI fx + instrument + effects
  await P(page, (id) => { __daw.S.selected = id; }, arpT.id); await P(page, () => document.querySelector('.views button[data-view=session]').click()); await sleep(100);
  await page.dblclick('.br-item[data-kind=fx][data-type=chorus]'); await sleep(150);
  const snap = () => P(page, (id) => { const t = __daw.S.project.tracks.find((x) => x.id === id); return JSON.parse(JSON.stringify({ inst: t.inst, midiFx: t.midiFx, fx: t.fx, vol: t.volume })); }, arpT.id);
  const r0 = await snap();
  const instGain0 = r0.inst.values.gain;
  await page.click('.rand-track'); await sleep(250);
  const r1 = await snap();
  const liveInst = await P(page, (id) => JSON.stringify(__daw.engine.tracks.get(id).inst.values) === JSON.stringify(__daw.S.project.tracks.find((t) => t.id === id).inst.values), arpT.id);
  ok('Randomize track changes the MIDI effects, the instrument and the effects; volume and instrument output gain stay put',
    JSON.stringify(r1.inst) !== JSON.stringify(r0.inst) && JSON.stringify(r1.fx) !== JSON.stringify(r0.fx) && JSON.stringify(r1.midiFx) !== JSON.stringify(r0.midiFx) && r1.inst.values.gain === instGain0 && r1.vol === r0.vol && liveInst,
    JSON.stringify({ gain: [instGain0, r1.inst.values.gain], midiFx: r1.midiFx.map((m) => m.values) }).slice(0, 400));
  await shot(page, 'randomize-track');
  await page.keyboard.press('Control+z'); await sleep(250);
  ok('One undo restores the whole track (instrument values in the running synth too)', JSON.stringify(await snap()) === JSON.stringify(r0) && await P(page, (id) => JSON.stringify(__daw.engine.tracks.get(id).inst.values) === JSON.stringify(__daw.S.project.tracks.find((t) => t.id === id).inst.values), arpT.id));
  // chaos mode moves levels (proves the musical guard is what keeps them)
  await page.click('#devices .device.inst .rand-more'); await sleep(150);
  await page.click('.rand-pop .rp-mode[data-mode=chaos]');
  await P(page, () => { const r = document.querySelector('.rand-pop .rp-amount'); r.value = 100; r.dispatchEvent(new Event('input')); });
  let gainMoved = false; for (let i = 0; i < 6 && !gainMoved; i++) { await page.click('.rand-pop .rp-go'); await sleep(60); gainMoved = (await snap()).inst.values.gain !== instGain0; }
  ok('Chaos mode may change the instrument gain (musical mode is what protects it)', gainMoved);
  await page.click('.rand-pop .rp-mode[data-mode=musical]'); await P(page, () => document.querySelectorAll('.popover').forEach((p) => p.remove()));
  const emo2 = await P(page, SCAN);
  ok('No emoji in device bars / randomizer', emo2.length === 0, emo2.join(' | '));

  // ---------------- persistence: MIDI fx + locks survive save/validate
  const saved = await P(page, async () => {
    const { validateProject } = await import('./js/validate.js');
    const p = JSON.parse(JSON.stringify(__daw.S.project)); const v = validateProject(p).project;
    const a = p.tracks.map((t) => [t.midiFx, t.fx.map((f) => f.locks || null), t.inst && t.inst.locks]);
    const b = v.tracks.map((t) => [t.midiFx, t.fx.map((f) => f.locks || null), t.inst && t.inst.locks]);
    const bad = JSON.parse(JSON.stringify(p)); const mt = bad.tracks.find((t) => t.kind === 'midi'); mt.midiFx = [{ type: 'evil', values: {} }];
    let rejected = false; try { validateProject(bad); } catch (e) { rejected = /MIDI effect/.test(e.message); }
    const junk = JSON.parse(JSON.stringify(p)); const jt = junk.tracks.find((t) => t.fx.length); jt.fx[0].locks = ['nope', 'x'.repeat(99)];
    const jv = validateProject(junk).project.tracks.find((t) => t.id === jt.id).fx[0].locks;
    return { same: JSON.stringify(a) === JSON.stringify(b), hasMfx: v.tracks.some((t) => (t.midiFx || []).length), hasLocks: v.tracks.some((t) => t.fx.some((f) => f.locks)), rejected, junkLocks: jv || null };
  });
  ok('Project validation keeps MIDI effects and randomizer locks, rejects unknown MIDI effects, drops unknown lock keys', saved.same && saved.hasMfx && saved.hasLocks && saved.rejected && saved.junkLocks === null, JSON.stringify(saved));

  // ---------------- collapse / expand
  await page.click('#browser .br-head .br-toggle'); await sleep(200);
  const col = await P(page, () => ({ w: document.querySelector('#browser').getBoundingClientRect().width, rail: document.querySelectorAll('#browser .br-rail').length, pref: JSON.parse(localStorage.getItem('auduio.prefs')).browserOpen }));
  ok('Collapse button shrinks the browser to a thin icon rail and remembers it', col.w <= 40 && col.rail === 5 && col.pref === false, JSON.stringify(col));
  await shot(page, 'sidebar-collapsed');
  await page.click('body', { position: { x: 700, y: 400 } }).catch(() => {}); await P(page, () => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('b'); await sleep(200);
  ok('Key B shows it again', await P(page, () => document.querySelector('#browser').getBoundingClientRect().width > 150));
  await page.click('#browser .br-sec[data-sec=fx] .br-sec-head'); await sleep(100);
  ok('Sections fold (Audio Effects folded)', await P(page, () => document.querySelectorAll('.br-sec[data-sec=fx] .br-item').length === 0));
  await page.click('#browser .br-sec[data-sec=fx] .br-sec-head'); await sleep(100);
  await ctx.close();

  // ---------------- phone layout: no sidebar
  const ph = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { guideDone: true, tutorialDone: true, phoneMode: 'on' });
  const phoneBr = await P(ph.page, () => ({ phone: document.body.classList.contains('phone'), shown: getComputedStyle(document.querySelector('#browser')).display !== 'none' }));
  ok('Phone layout hides the sidebar', phoneBr.phone && !phoneBr.shown, JSON.stringify(phoneBr));
  await ph.ctx.close();
} catch (e) { ok('test run crashed', false, e.stack); }
finally {
  ok('No uncaught page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-v04.json'), JSON.stringify(results, null, 2));
  if (browser) await browser.close(); server.kill();
  process.exit(passed === results.length ? 0 : 1);
}
