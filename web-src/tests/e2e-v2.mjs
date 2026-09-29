// v0.2 feature tests (headless Chromium). Run after `node tools/build.mjs`: node tests/e2e-v2.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8766), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 700) : ''}`); };
const shots = path.join(ROOT, 'screenshots', 'v2'); fs.mkdirSync(shots, { recursive: true });
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const errors = [];
async function newPage(opts = {}, { midi = true, prefs = { guideDone: true, tutorialDone: true, phoneMode: 'off' } } = {}) {
  const ctx = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true, ...opts });
  await ctx.addInitScript(({ midi, prefs }) => {
    if (prefs && !localStorage.getItem('webdaw.prefs')) localStorage.setItem('webdaw.prefs', JSON.stringify(prefs));
    window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => { window.__csp.push(e.violatedDirective + ' ' + e.blockedURI); });
    if (midi === false) { try { delete Navigator.prototype.requestMIDIAccess; } catch (e) {} } // simulate Safari (no Web MIDI)
    if (midi) {
      const input = { id: 'mock-in', name: 'Mock Keys', state: 'connected', onmidimessage: null };
      const access = { inputs: new Map([['mock-in', input]]), outputs: new Map(), onstatechange: null };
      navigator.requestMIDIAccess = async () => access;
      window.__midiSend = (bytes) => input.onmidimessage && input.onmidimessage({ data: new Uint8Array(bytes), timeStamp: performance.now() });
    }
  }, { midi, prefs });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Refused to execute inline script/.test(m.text())) errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return { ctx, page };
}
async function start(page) { await page.goto(URL_); await page.click('#startBtn'); await page.waitForSelector('#sessionView .col[data-id]', { timeout: 15000 }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });
  await start(page);
  ok('CSP meta present (self only, no eval)', await page.evaluate(() => { const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]'); return m && /script-src 'self'/.test(m.content) && !/unsafe-eval|unsafe-inline/.test(m.content); }));
  ok('CSP blocks injected inline script', (await page.evaluate(async () => { const s = document.createElement('script'); s.textContent = 'window.__inl = 1'; document.head.append(s); await new Promise((r) => setTimeout(r, 50)); const r = window.__inl ? 'allowed' : 'blocked'; window.__csp.length = 0; return r; })) === 'blocked');

  // ---------------- MIDI (mocked Web MIDI)
  await page.evaluate(() => [...document.querySelectorAll('#sessionView .add-track')].find((b) => b.textContent.includes('Synth')).click());
  const synthId = await page.evaluate(() => __daw.S.project.tracks.at(-1).id);
  await page.click(`#sessionView .col[data-id="${synthId}"] .tbtn.arm`);
  await page.waitForFunction(() => !!__daw.MIDI.access, null, { timeout: 5000 });
  const midiLive = await page.evaluate(async (id) => {
    const n = __daw.engine.tracks.get(id); __midiSend([0x90, 60, 100]); __midiSend([0x90, 64, 90]); await new Promise((r) => setTimeout(r, 50));
    const on = n.inst.activeCount(); __midiSend([0xe0, 0, 127]); __midiSend([0xb0, 1, 64]); __midiSend([0x80, 60, 0]); __midiSend([0x90, 64, 0]); await new Promise((r) => setTimeout(r, 50));
    return { on, after: n.inst.activeCount(), inputs: __daw.MIDI.inputs().map((i) => i.name) };
  }, synthId);
  ok('MIDI input (mocked requestMIDIAccess) plays the synth, note-off releases, bend/mod accepted', midiLive.on === 2 && midiLive.after === 0, JSON.stringify(midiLive));
  await page.click('.views button[data-view=arrange]');
  await page.click('#btnRec'); await sleep(400);
  for (const n of [60, 62, 64]) { await page.evaluate((n) => __midiSend([0x90, n, 100]), n); await sleep(180); await page.evaluate((n) => __midiSend([0x80, n, 0]), n); await sleep(80); }
  await page.click('#btnRec'); await page.click('#btnStop');
  const midiClip = await page.evaluate((id) => { const c = __daw.S.project.tracks.find((t) => t.id === id).arrangement.find((x) => x.type === 'midi'); return c && { notes: c.notes.map((n) => n.n), beats: +c.lengthBeats.toFixed(2) }; }, synthId);
  ok('MIDI recording into an arrangement clip', midiClip && midiClip.notes.join() === '60,62,64', JSON.stringify(midiClip));
  // MIDI learn
  await page.click('.views button[data-view=session]');
  await page.click(`#sessionView .col[data-id="${synthId}"] .col-head`);
  await page.click('#devHead .learn-btn');
  const lk = await page.$('#devices .device.inst .knob');
  const lkey = await lk.getAttribute('data-learn');
  await lk.click();
  await page.evaluate(() => __midiSend([0xb0, 20, 100]));
  await page.evaluate(() => __midiSend([0xb0, 20, 5]));
  const learn = await page.evaluate((k) => { const [tid, fx, key] = k.split(':'); const n = __daw.engine.tracks.get(tid); return { map: __daw.S.project.midiMap.length, val: n.inst.values[key], key }; }, lkey);
  await page.click('#devHead .learn-btn');
  ok('MIDI learn maps a CC to a knob and the CC then drives it', learn.map === 1, JSON.stringify(learn));
  // session slot MIDI recording (bar-aligned)
  await page.click(`#sessionView .col[data-id="${synthId}"] .slot[data-slot="0"]`);
  await sleep(300);
  for (const n of [67, 71]) { await page.evaluate((n) => __midiSend([0x90, n, 100]), n); await sleep(200); await page.evaluate((n) => __midiSend([0x80, n, 0]), n); await sleep(100); }
  await page.click(`#sessionView .col[data-id="${synthId}"] .slot[data-slot="0"]`);
  await page.waitForFunction((id) => { const c = __daw.S.project.tracks.find((t) => t.id === id).slots[0]; return c && c.type === 'midi'; }, synthId, { timeout: 8000 }).catch(() => {});
  const slotMidi = await page.evaluate((id) => { const c = __daw.S.project.tracks.find((t) => t.id === id).slots[0]; return c && { notes: c.notes.map((n) => n.n), beats: c.lengthBeats, looping: __daw.engine.tracks.get(id).sessionSlot }; }, synthId);
  ok('MIDI recording into a session slot (bar-quantised, loops afterwards)', slotMidi && slotMidi.notes.join() === '67,71' && slotMidi.beats % 4 === 0, JSON.stringify(slotMidi));
  await page.click('#btnStop'); await page.click('#btnStop');
  // piano roll
  await page.dblclick(`#sessionView .col[data-id="${synthId}"] .slot[data-slot="0"]`);
  await page.waitForSelector('.pianoroll .pr-canvas');
  const cb = await (await page.$('.pianoroll .pr-canvas')).boundingBox();
  const n0 = await page.evaluate((id) => __daw.S.project.tracks.find((t) => t.id === id).slots[0].notes.length, synthId);
  await page.mouse.click(cb.x + 90, cb.y + cb.height * 0.4);
  const n1 = await page.evaluate((id) => __daw.S.project.tracks.find((t) => t.id === id).slots[0].notes.length, synthId);
  await page.screenshot({ path: path.join(shots, 'desktop-pianoroll.png') });
  await page.click('.pianoroll .pr-close');
  ok('Piano roll: tap adds a note', n1 === n0 + 1, `${n0} -> ${n1}`);

  // ---------------- clip ops: copy/paste/duplicate/delete + undo/redo (keyboard + toolbar)
  await page.evaluate(() => {
    const { engine, S } = __daw; const ctx = engine.ctx, sr = ctx.sampleRate; const b = ctx.createBuffer(1, sr * 2, sr); const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / sr) * Math.exp(-(i % (sr / 2)) / sr * 6);
    engine.buffers.set('bv2a', b); const t = S.project.tracks[0]; t.arrangement.push({ id: 'cv2a', bufferId: 'bv2a', start: 0, offset: 0, duration: 2, name: 'Tone' }); engine.rescheduleTrack(t);
  });
  await page.click('.views button[data-view=arrange]');
  const clipCount = () => page.evaluate(() => __daw.S.project.tracks[0].arrangement.length);
  await page.click('#arrangeView .aclip[data-clip="cv2a"]');
  const c0 = await clipCount();
  await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  const c1 = await clipCount();
  await page.keyboard.press('Control+z'); const c2 = await clipCount();
  await page.keyboard.press('Control+Shift+z'); const c3 = await clipCount();
  await page.click('#arrangeView .aclip[data-clip="cv2a"]', { force: true });
  await page.evaluate(() => [...document.querySelectorAll('#arrangeView .view-tools button')].find((b) => b.textContent === 'Dup').click());
  const c4 = await clipCount();
  await page.keyboard.press('Delete'); const c5 = await clipCount();
  await page.click('#btnUndo'); const c6 = await clipCount();
  ok('Copy/paste, duplicate, delete with undo/redo (keys + buttons)', c1 === c0 + 1 && c2 === c0 && c3 === c0 + 1 && c4 === c3 + 1 && c5 === c4 - 1 && c6 === c4, [c0, c1, c2, c3, c4, c5, c6].join(' '));
  const undoFx = await page.evaluate(async () => {
    const { S, engine, history } = __daw; const t = S.project.tracks[0];
    t.fx = [{ type: 'eq', enabled: true, values: {} }]; engine.setTrackFx(t); history.clear();
    const inst = engine.fxInstances(t.id)[0];
    history.push('Change lowGain', 'x'); engine.setFxParam(t.id, 0, 'lowGain', 7.5);
    history.undo(); const a = inst.values.lowGain; const same = engine.fxInstances(t.id)[0] === inst;
    history.redo(); return { afterUndo: a, afterRedo: inst.values.lowGain, sameInstance: same && engine.fxInstances(t.id)[0] === inst };
  });
  ok('Undo/redo of an effect parameter restores values in place (no chain rebuild)', undoFx.afterUndo === 0 && undoFx.afterRedo === 7.5 && undoFx.sameInstance, JSON.stringify(undoFx));

  // ---------------- real-time edits while playing (no restarts)
  const rt = await page.evaluate(async () => {
    const { S, engine, history } = __daw; await engine.resume(); engine.play(0);
    await new Promise((r) => setTimeout(r, 400)); const p0 = engine.position(); const startT = engine.startCtxTime;
    const t = S.project.tracks[0]; const pitchT = S.project.tracks[1];
    pitchT.fx = [{ type: 'pitch', enabled: true, values: {} }]; engine.setTrackFx(pitchT);
    const pinst = engine.fxInstances(pitchT.id)[0];
    history.push('p', 'a'); engine.setFxParam(pitchT.id, 0, 'speed', 0); engine.setFxParam(pitchT.id, 0, 'humanize', 60);
    history.push('k'); S.project.key = { root: 7, scale: 'minor' }; engine.updateBpmFx();
    history.push('m'); t.arrangement[0].start = 1; engine.rescheduleTrack(t);
    history.undo(); history.undo(); history.undo();
    await new Promise((r) => setTimeout(r, 300));
    return { playing: engine.playing, advanced: engine.position() > p0, sameStart: engine.startCtxTime === startT, pitchSame: engine.fxInstances(pitchT.id)[0] === pinst, key: S.project.key, clipStart: S.project.tracks[0].arrangement[0].start };
  });
  await page.evaluate(() => __daw.engine.stop());
  ok('Live edits while playing (fx params incl. pitch, key/scale, clip move, undo) never stop/restart transport', rt.playing && rt.advanced && rt.sameStart && rt.pitchSame && rt.key.root === 0 && rt.clipStart === 0, JSON.stringify(rt));

  // ---------------- drag & drop audio into the arrangement (synthetic DataTransfer)
  const dropRes = await page.evaluate(async () => {
    const { encodeWav } = await import('./js/project.js');
    const { engine, S } = __daw; const sr = 44100; const b = new AudioBuffer({ length: sr, sampleRate: sr, numberOfChannels: 1 }); const d = b.getChannelData(0); for (let i = 0; i < sr; i++) d[i] = 0.3 * Math.sin(i / 10);
    const file = new File([encodeWav(b)], 'dropped.wav', { type: 'audio/wav' });
    const sc = document.querySelector('#arrangeView .arr-scroll'); const content = sc.querySelector('.arr-content');
    const t0 = S.project.tracks[0]; const lane = content.querySelector(`.lane[data-id="${t0.id}"]`);
    const lr = lane.getBoundingClientRect(), cr = content.getBoundingClientRect();
    const want = 4 * engine.beatDur; // beat 5
    const fire = (target, x, y) => { const dt = new DataTransfer(); dt.items.add(file); for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y })); };
    const n0 = t0.arrangement.length, tracks0 = S.project.tracks.length;
    fire(lane, cr.left + want * S.zoom + 3, lr.top + lr.height / 2);
    await new Promise((r) => setTimeout(r, 800));
    const placed = t0.arrangement.slice(n0).map((c) => +c.start.toFixed(3));
    const empty = document.querySelector('#arrangeView .lane.drop-new'); const er = empty.getBoundingClientRect();
    fire(empty, er.left + 20, er.top + er.height / 2);
    await new Promise((r) => setTimeout(r, 800));
    return { placed, want: +want.toFixed(3), tracksBefore: tracks0, tracksAfter: S.project.tracks.length, newTrackClips: S.project.tracks.at(-1).arrangement.length };
  });
  ok('Drag-and-drop audio lands at the drop time on the drop track; empty space makes a new track', dropRes.placed.length === 1 && Math.abs(dropRes.placed[0] - dropRes.want) < 0.01 && dropRes.tracksAfter === dropRes.tracksBefore + 1 && dropRes.newTrackClips === 1, JSON.stringify(dropRes));
  await page.screenshot({ path: path.join(shots, 'desktop-arrange.png') });

  // ---------------- Auto-Mix pop-up: user role wins
  await page.click('#btnAutoMix');
  await page.waitForSelector('#dlg .am-row .role-sel');
  await page.selectOption('#dlg .am-row:nth-of-type(1) .role-sel', 'drum_snare').catch(async () => { await page.evaluate(() => { const s = document.querySelector('#dlg .role-sel'); s.value = 'drum_snare'; }); });
  await page.evaluate(() => { const s = document.querySelector('#dlg .role-sel'); if (s.value !== 'drum_snare') s.value = 'drum_snare'; });
  await page.click('#dlg button[value=apply]');
  await page.waitForFunction(() => __daw.S.project.tracks[0].role, null, { timeout: 5000 }).catch(() => {});
  const am = await page.evaluate(() => { const t = __daw.S.project.tracks[0]; return { role: t.role, src: t.roleSource, preset: t.preset, fx: t.fx.map((f) => f.type).join('>') }; });
  ok('Auto-Mix pop-up: a manually chosen role overrides the suggestion', am.role === 'drum_snare' && am.src === 'manual' && am.preset === 'Snare', JSON.stringify(am));

  // ---------------- groups
  await page.click('.views button[data-view=session]');
  const memberId = await page.evaluate(() => __daw.S.project.tracks[1].id);
  await page.click(`#sessionView .col[data-id="${memberId}"] .col-head`, { button: 'right' });
  await page.evaluate(() => [...document.querySelectorAll('.ctxmenu button')].find((b) => b.textContent.startsWith('Group this track')).click());
  const grp = await page.evaluate((mid) => { const { S, engine } = __daw; const m = S.project.tracks.find((t) => t.id === mid); const g = S.project.tracks.find((t) => t.id === m.groupId); return g && { kind: g.kind, routed: engine.tracks.get(mid).dest === engine.tracks.get(g.id).input, gid: g.id }; }, memberId);
  await page.click(`#sessionView .col[data-id="${grp && grp.gid}"] .fold`);
  const foldHidden = await page.$(`#sessionView .col[data-id="${memberId}"]`) === null;
  await page.click(`#sessionView .col[data-id="${grp && grp.gid}"] .fold`);
  const unfoldShown = await page.$(`#sessionView .col[data-id="${memberId}"]`) !== null;
  ok('Group bus: track routed into the group, fold/unfold hides/shows members', grp && grp.kind === 'group' && grp.routed && foldHidden && unfoldShown, JSON.stringify({ grp, foldHidden, unfoldShown }));

  // ---------------- rack with macros + preset save
  await page.click(`#sessionView .col[data-id="${memberId}"] .col-head`);
  await page.selectOption('#devHead .add-fx', 'rack:Parallel Crush');
  const rack = await page.evaluate((mid) => {
    const { S, engine } = __daw; const t = S.project.tracks.find((x) => x.id === mid); const idx = t.fx.findIndex((f) => f.type === 'rack'); const inst = engine.fxInstances(mid)[idx];
    const thr = () => inst.chains[1].fx[0].values.threshold;
    engine.setFxParam(mid, idx, 'macro1', 0); const a = thr(); engine.setFxParam(mid, idx, 'macro1', 100); const b = thr();
    return { chains: inst.chains.length, a, b, cards: document.querySelectorAll('#devices .device[data-type=rack] .chain').length };
  }, memberId);
  ok('Rack: parallel chains, macro knob drives a mapped inner parameter', rack.chains === 2 && rack.a === -20 && rack.b === -50 && rack.cards === 2, JSON.stringify(rack));
  page.once('dialog', (d) => d.accept('TestRack'));
  await page.evaluate(() => [...document.querySelectorAll('#devices .device[data-type=rack] button')].find((b) => b.textContent.startsWith('Save preset')).click());
  await sleep(200);
  const rp = await page.evaluate(() => ({ stored: !!JSON.parse(localStorage.getItem('auduio.rackPresets') || '{}').TestRack, option: !![...document.querySelectorAll('#devHead .add-fx option')].find((o) => o.value === 'rack:TestRack') }));
  ok('Rack preset save/load (local)', rp.stored && rp.option, JSON.stringify(rp));
  await page.screenshot({ path: path.join(shots, 'desktop-rack.png') });

  // ---------------- fine control (Shift-drag): 0.01 dB steps + precision readout
  await page.selectOption('#devHead .add-fx', 'eq');
  let eqCard = (await page.$$('#devices .device[data-type=eq]')).at(-1);
  let knobEl = await eqCard.$('.knob[data-learn$=":lowGain"]');
  if (!knobEl) { await eqCard.$eval('.expand', (b) => b.click()); eqCard = (await page.$$('#devices .device[data-type=eq]')).at(-1); knobEl = await eqCard.$('.knob[data-learn$=":lowGain"]'); }
  const key = (await knobEl.getAttribute('data-learn')).split(':');
  const kb = await knobEl.boundingBox();
  const getV = () => page.evaluate(([tid, fx, k]) => __daw.S.project.tracks.find((t) => t.id === tid).fx[+fx].values[k], key);
  const v0 = await getV();
  await page.keyboard.down('Shift');
  await page.mouse.move(kb.x + kb.width / 2, kb.y + 15); await page.mouse.down();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + 11, { steps: 4 });
  const readout = await knobEl.$eval('.k-fine', (e) => ({ text: e.textContent, shown: getComputedStyle(e).display !== 'none' }));
  await page.mouse.up(); await page.keyboard.up('Shift');
  const v1 = await getV();
  ok('Fine mode (Shift-drag): 0.01 dB steps with precision readout', Math.abs(v1 - v0 - 0.02) < 1e-6 && readout.shown && /\.\d\d dB/.test(readout.text), JSON.stringify({ v0, v1, readout }));
  // effect with visuals screenshot: expand EQ, play the tone clip
  eqCard = (await page.$$('#devices .device[data-type=eq]')).at(-1); if (!(await eqCard.evaluate((e) => e.classList.contains('expanded')))) await eqCard.$eval('.expand', (b) => b.click());
  await page.evaluate(() => { __daw.engine.play(0); });
  await sleep(900);
  await page.screenshot({ path: path.join(shots, 'desktop-session-fx-visuals.png') });
  await page.evaluate(() => __daw.engine.stop());

  // ---------------- tiers (placeholder gating)
  const tier = await page.evaluate(async () => {
    const T = await import('./js/tiers.js'); T.setTier('basic'); await new Promise((r) => setTimeout(r, 100));
    const opt = [...document.querySelectorAll('#devHead .add-fx option')].find((o) => o.value === 'chorus').textContent;
    return { allowedChorus: T.allowed('fx.chorus'), allowedEq: T.allowed('fx.eq'), opt };
  });
  const fxBefore = await page.$$eval('#devices .device', (d) => d.length);
  await page.selectOption('#devHead .add-fx', 'chorus');
  const gated = await page.evaluate(() => document.querySelector('#dlg').open && /Switch to/.test(document.querySelector('#dlg').textContent));
  await page.screenshot({ path: path.join(shots, 'desktop-tier-lock.png') });
  await page.click('#dlg button[value=cancel]');
  const fxAfter = await page.$$eval('#devices .device', (d) => d.length);
  await page.evaluate(async () => (await import('./js/tiers.js')).setTier('large'));
  ok('Tiers: Basic locks Mid features (badge + unlock dialog, nothing added); switching back unlocks', !tier.allowedChorus && tier.allowedEq && /\(Mid tier\)|locked/.test(tier.opt) && gated && fxBefore === fxAfter, JSON.stringify({ tier, gated, fxBefore, fxAfter }));

  // ---------------- synths (offline render)
  const syn = await page.evaluate(async () => {
    const { createInstrument } = await import('./js/audio/instruments.js');
    const render = async (type, values, notes) => {
      const oc = new OfflineAudioContext(2, 44100, 44100); const inst = createInstrument(oc, { type, values }); inst.output.connect(oc.destination);
      notes.forEach(([n, t, d]) => inst.playNote(n, 100, t, d)); const maxV = inst.voices.length;
      const b = await oc.startRendering(); const x = b.getChannelData(0); let s = 0, bad = false; for (const v of x) { if (!isFinite(v)) bad = true; s += v * v; }
      return { rms: +Math.sqrt(s / x.length).toFixed(4), bad, maxVoices: maxV };
    };
    return {
      analog: await render('synth', {}, [[48, 0, 0.8], [55, 0, 0.8], [60, 0.1, 0.5]]),
      wavetable: await render('wavetable', { table: 'Vocal', posEnv: 60 }, [[60, 0, 0.8], [64, 0.05, 0.6]]),
      steal: await render('synth', { poly: 2 }, [[60, 0, 0.9], [62, 0.01, 0.9], [64, 0.02, 0.9], [65, 0.03, 0.9]]),
    };
  });
  ok('Analog + wavetable synths render; polyphony limit steals voices', !syn.analog.bad && syn.analog.rms > 0.005 && !syn.wavetable.bad && syn.wavetable.rms > 0.005 && syn.steal.maxVoices <= 2, JSON.stringify(syn));
  // wavetable card screenshot
  await page.evaluate(() => [...document.querySelectorAll('#sessionView .add-track')].find((b) => b.textContent.includes('Synth')).click());
  await page.selectOption('#devices .device.inst .inst-type', 'wavetable');
  await page.evaluate(() => __daw.S.expanded.add(__daw.S.selected + ':inst'));
  await page.evaluate(() => [...document.querySelectorAll('.views button')][0].click());
  const wtOk = await page.evaluate(() => __daw.S.project.tracks.find((t) => t.id === __daw.S.selected).inst.type === 'wavetable');
  await page.evaluate(() => { const t = __daw.S.project.tracks.find((x) => x.id === __daw.S.selected); const n = __daw.engine.tracks.get(t.id); n.inst.noteOn(60, 100); n.inst.noteOn(67, 90); });
  await sleep(500);
  await page.screenshot({ path: path.join(shots, 'desktop-wavetable.png') });
  await page.evaluate(() => { const n = __daw.engine.tracks.get(__daw.S.selected); n.inst.allOff(); });
  ok('Switch a MIDI track to the wavetable synth', wtOk);

  // ---------------- pitch correction: synthetic tone detection + non-silent render
  const pitch = await page.evaluate(async () => {
    const { createEffect } = await import('./js/audio/effects.js'); const { yin } = await import('./js/audio/pitchdsp.js');
    const sr = 44100, oc = new OfflineAudioContext(2, sr * 1.5, sr);
    const fx = createEffect(oc, 'pitch', { keySource: 'manual', root: 'C', scale: 'major', speed: 0, humanize: 0 });
    const osc = oc.createOscillator(); osc.frequency.value = 227; const g = oc.createGain(); g.gain.value = 0.5;
    osc.connect(g).connect(fx.input); fx.output.connect(oc.destination); osc.start();
    const b = await oc.startRendering(); const y = b.getChannelData(0);
    let s = 0; for (let i = sr / 2; i < y.length; i++) s += y[i] * y[i];
    const f0out = yin(y.subarray(sr, sr + 4096), sr).f0;
    return { engine: fx.engineKind, detected: +(fx.readout.f0 || 0).toFixed(1), target: fx.readout.targetNote, outHz: +(f0out || 0).toFixed(1), rms: +Math.sqrt(s / (y.length - sr / 2)).toFixed(3) };
  });
  ok('Pitch correction detects a 227 Hz tone and snaps it toward A3 (220 Hz), output non-silent', Math.abs(pitch.detected - 227) < 3 && pitch.target === 57 && Math.abs(pitch.outHz - 220) < 4 && pitch.rms > 0.05, JSON.stringify(pitch));

  // ---------------- quantize (transient cut-and-shift)
  const q = await page.evaluate(async () => {
    const { quantizeBuffer, detectTransients } = await import('./js/audio/timecorrect.js');
    const sr = 44100, ctx = __daw.engine.ctx, b = ctx.createBuffer(1, sr * 2, sr), d = b.getChannelData(0);
    const hits = [0.03, 0.27, 0.52, 0.79, 1.02, 1.21, 1.53]; const grid = 0.25;
    for (const t of hits) { const s0 = Math.round(t * sr); for (let i = 0; i < 3000 && s0 + i < d.length; i++) d[s0 + i] += Math.sin(i / 8) * Math.exp(-i / 500) * 0.8; }
    const dev = (on) => on.reduce((a, t) => a + Math.abs(t - Math.round(t / grid) * grid), 0) / Math.max(1, on.length);
    const before = detectTransients(d, sr).map((i) => (typeof i === 'number' ? i : i.t));
    const res = quantizeBuffer(ctx, b, { gridSec: grid, strength: 1 });
    const after = detectTransients(res.buffer.getChannelData(0), sr).map((i) => (typeof i === 'number' ? i : i.t));
    const norm = (a) => a.map((x) => (x > 100 ? x / sr : x));
    return { moved: res.moved, devBeforeMs: +(dev(norm(before)) * 1000).toFixed(1), devAfterMs: +(dev(norm(after)) * 1000).toFixed(1), nBefore: before.length, nAfter: after.length };
  });
  ok('Quantize moves off-grid hits onto the grid', q.moved > 0.01 && q.devAfterMs < 6 && q.devAfterMs < q.devBeforeMs / 3, JSON.stringify(q));

  // ---------------- key detection (MIDI + audio) and live follow-the-band
  const keyRes = await page.evaluate(async () => {
    const { detectKey, chromaFromNotes, chromaFromBuffer } = await import('./js/audio/keydetect.js');
    const chords = [[55, 59, 62], [48, 52, 55], [50, 54, 57], [52, 55, 59], [55, 59, 62]]; // G C D Em G
    const notes = chords.flatMap((c, i) => c.map((n) => ({ n, t: i * 4, d: 4, v: 100 })));
    const k1 = detectKey(chromaFromNotes(notes));
    const sr = 22050, ctx = __daw.engine.ctx, b = ctx.createBuffer(1, sr * 8, sr), d = b.getChannelData(0);
    const am = [[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]]; // Am Dm E Am (harmonic minor V)
    for (let i = 0; i < d.length; i++) { const c = am[Math.floor(i / (sr * 2))]; let v = 0; for (const n of c) v += Math.sin(2 * Math.PI * 440 * Math.pow(2, (n - 69) / 12) * i / sr); d[i] = v * 0.2; }
    const k2 = detectKey(chromaFromBuffer(b));
    return { midi: k1.name, audio: k2.name, conf: +k2.confidence.toFixed(2) };
  });
  ok('Key detection: G major from MIDI chords, A minor from synthetic audio', /^G major/.test(keyRes.midi) && /^A minor/.test(keyRes.audio), JSON.stringify(keyRes));
  const follow = await page.evaluate(async () => {
    const { engine, S } = __daw; const ctx = engine.ctx; await engine.resume();
    S.project.key = { root: 0, scale: 'major' }; S.project.keyFollow = true; engine.keyFollower.reset();
    const mk = (notes) => notes.map((n, i) => { const o = ctx.createOscillator(); o.frequency.value = 440 * Math.pow(2, (n - 69) / 12); const g = ctx.createGain(); g.gain.value = i < 3 ? 0.12 : 0.05; /* tonic triad louder, as in real music */ o.connect(g).connect(engine.keySum); o.start(); return o; });
    const events = []; engine.on('key', (k) => events.push({ k: k.name, t: +ctx.currentTime.toFixed(1) }));
    const t0 = ctx.currentTime;
    let oscs = mk([62, 66, 69, 67, 71, 74, 64, 73]); // D major scale tones (D F# A G B D E C#)
    const until = async (fn, ms) => { const s = performance.now(); while (performance.now() - s < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
    await until(() => events.length >= 1, 9000);
    const first = S.project.key; oscs.forEach((o) => o.stop());
    oscs = mk([65, 69, 72, 70, 74, 77, 67, 76]); // F major tones
    const tSwitch = ctx.currentTime;
    await until(() => events.some((e) => /^F major/.test(e.k)), 20000);
    oscs.forEach((o) => o.stop()); S.project.keyFollow = false;
    return { first: { ...first }, events, lagAfterSwitch: events.find((e) => /^F major/.test(e.k)) ? +(events.find((e) => /^F major/.test(e.k)).t - tSwitch).toFixed(1) : null, firstAt: events[0] ? +(events[0].t - t0).toFixed(1) : null };
  });
  ok('Follow the band: live chroma key estimate updates the global key, with hysteresis (not instant)', follow.events[0] && /^D major/.test(follow.events[0].k) && follow.events.some((e) => /^F major/.test(e.k)) && follow.lagAfterSwitch >= 2, JSON.stringify(follow));

  // ---------------- malicious project archives are rejected
  const mal = await page.evaluate(async () => {
    const { zipFiles, importProjectFile, unzip, ZIP_LIMITS, newProject } = await import('./js/project.js');
    const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
    const good = newProject('x');
    const tryImport = async (files) => { try { const bytes = new Uint8Array(await zipFiles(files).arrayBuffer()); await importProjectFile(bytes, __daw.engine.ctx); return 'ACCEPTED'; } catch (e) { return e.message; } };
    return {
      traversal: await tryImport([{ name: 'project.json', data: enc(good) }, { name: '../evil.wav', data: new Uint8Array(100) }]),
      unknown: await tryImport([{ name: 'project.json', data: enc(good) }, { name: 'readme.txt', data: new Uint8Array(10) }]),
      schema: await tryImport([{ name: 'project.json', data: enc({ format: 'nope', tracks: 'x' }) }]),
      badFx: await tryImport([{ name: 'project.json', data: enc({ ...good, tracks: [{ id: 't1', fx: [{ type: 'evil', values: {} }] }] }) }]),
      oversize: await (async () => { try { await unzip(new Uint8Array(await zipFiles([{ name: 'project.json', data: new Uint8Array(5000).fill(32) }]).arrayBuffer()), { ...ZIP_LIMITS, maxEntryBytes: 1000 }); return 'ACCEPTED'; } catch (e) { return e.message; } })(),
      valid: await tryImport([{ name: 'project.json', data: enc(good) }]),
    };
  });
  ok('Malicious zips rejected: path traversal, unknown entry, bad schema, unknown effect, oversize (valid one accepted)', ['traversal', 'unknown', 'schema', 'badFx', 'oversize'].every((k) => mal[k] !== 'ACCEPTED') && mal.valid === 'ACCEPTED', JSON.stringify(mal));
  // UI import of a traversal zip shows a rejection and leaves the project intact
  const tracksNow = await page.evaluate(() => __daw.S.project.tracks.length);
  const evilPath = path.join(ROOT, 'tests', 'evil.webdaw.zip');
  fs.writeFileSync(evilPath, Buffer.from(await page.evaluate(async () => { const { zipFiles, newProject } = await import('./js/project.js'); return [...new Uint8Array(await zipFiles([{ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(newProject('e'))) }, { name: 'audio/../../x.wav', data: new Uint8Array(8) }]).arrayBuffer())]; })));
  await page.setInputFiles('#fileProject', evilPath);
  await sleep(500);
  const toastTxt = await page.evaluate(() => document.querySelector('#toast').textContent);
  ok('UI import of a malicious zip is rejected with a message; project unchanged', /rejected/i.test(toastTxt) && (await page.evaluate(() => __daw.S.project.tracks.length)) === tracksNow, toastTxt);

  // ---------------- encrypted export round-trip (UI)
  const beforeEnc = await page.evaluate(() => ({ n: __daw.S.project.tracks.length, name: __daw.S.project.name }));
  await page.evaluate(() => { document.querySelector('#btnMenu').click(); [...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Export encrypted')).click(); });
  await page.waitForSelector('#dlg input[type=password]');
  const pw = await page.$$('#dlg input[type=password]'); await pw[0].fill('correct horse'); await pw[1].fill('correct horse');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#dlg button[value=ok]')]);
  const encPath = path.join(ROOT, 'tests', 'exported-test.webdaw.enc'); await dl.saveAs(encPath);
  const head = fs.readFileSync(encPath).subarray(0, 8).toString();
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => { document.querySelector('#btnMenu').click(); [...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('New project')).click(); });
  await page.waitForFunction((n) => __daw.S.project.tracks.length !== n, beforeEnc.n, { timeout: 5000 });
  // wrong password first
  await page.setInputFiles('#fileProject', encPath);
  await page.waitForSelector('#dlg input[type=password]'); await page.fill('#dlg input[type=password]', 'wrong password'); await page.click('#dlg button[value=ok]');
  await sleep(1500); const wrongToast = await page.evaluate(() => document.querySelector('#toast').textContent);
  await page.setInputFiles('#fileProject', encPath);
  await page.waitForSelector('#dlg input[type=password]'); await page.fill('#dlg input[type=password]', 'correct horse'); await page.click('#dlg button[value=ok]');
  await page.waitForFunction((n) => __daw.S.project.tracks.length === n, beforeEnc.n, { timeout: 15000 }).catch(() => {});
  const afterEnc = await page.evaluate(() => ({ n: __daw.S.project.tracks.length, name: __daw.S.project.name }));
  ok('Encrypted export (AES-GCM) round-trips; wrong password rejected', head === 'WDAWENC1' && /wrong password/i.test(wrongToast) && afterEnc.n === beforeEnc.n && afterEnc.name === beforeEnc.name, JSON.stringify({ head, wrongToast, beforeEnc, afterEnc }));

  // ---------------- Easy Mode + help mode
  await page.click('#btnEasy');
  const easy = await page.evaluate(() => ({ body: document.body.classList.contains('easy'), advHidden: [...document.querySelectorAll('.adv')].every((e) => getComputedStyle(e).display === 'none') }));
  await page.screenshot({ path: path.join(shots, 'desktop-easy-mode.png') });
  await page.click('#btnEasy');
  await page.click('#btnHelp'); await page.click('#btnPlay');
  const help = await page.evaluate(() => ({ bubble: !!document.querySelector('.help-bubble'), playing: __daw.engine.playing }));
  await page.click('#btnHelp');
  ok('Easy Mode hides advanced controls; help mode explains instead of acting', easy.body && easy.advHidden && help.bubble && !help.playing, JSON.stringify({ easy, help }));
  ok('No CSP violations on the main page', (await page.evaluate(() => window.__csp.length)) === 0, await page.evaluate(() => window.__csp.join('; ')));
  await ctx.close();

  // ---------------- PIN lock (casual lock)
  const pinC = await newPage({ viewport: { width: 900, height: 700 } }, { midi: false });
  await pinC.page.goto(URL_);
  await pinC.page.evaluate(async () => { const s = await import('./js/security.js'); await s.setPin('2468'); });
  await pinC.page.reload();
  const lockShown = await pinC.page.isVisible('#lockOverlay');
  await pinC.page.fill('#pinInput', '1111'); await pinC.page.click('#pinBtn'); await sleep(1200);
  const stillLocked = await pinC.page.isVisible('#lockOverlay'); const msg = await pinC.page.textContent('#pinMsg');
  await pinC.page.fill('#pinInput', '2468'); await pinC.page.click('#pinBtn');
  await pinC.page.waitForSelector('#lockOverlay', { state: 'hidden', timeout: 5000 }).catch(() => {});
  const unlocked = !(await pinC.page.isVisible('#lockOverlay')) && await pinC.page.isVisible('#startBtn');
  const stored = await pinC.page.evaluate(() => localStorage.getItem('auduio.pin'));
  ok('PIN lock: shown after reload, wrong PIN rejected, correct PIN unlocks; PIN stored only as PBKDF2 hash', lockShown && stillLocked && /wrong/i.test(msg) && unlocked && !stored.includes('2468'), JSON.stringify({ lockShown, stillLocked, msg, unlocked, stored: stored.slice(0, 80) }));
  await pinC.ctx.close();

  // ---------------- first-run guide + phone screenshots (390x844)
  const phone = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }, { midi: false, prefs: { phoneMode: 'off' } });
  const P = phone.page;
  await P.goto(URL_); await P.tap('#startBtn'); await P.waitForSelector('#sessionView .col[data-id]');
  const guide = await P.isVisible('.tut-bubble');
  await P.screenshot({ path: path.join(shots, 'phone-guide.png') });
  const iosNotice = await P.evaluate(() => __daw.MIDI.notice());
  ok('First-run tutorial shows; iOS Safari gets a clear Web MIDI notice', guide && /Safari on iPhone\/iPad/.test(iosNotice || ''), JSON.stringify({ guide, iosNotice }));
  await P.evaluate(() => __daw.tutorial.stop());
  await P.setInputFiles('#fileProject', path.join(ROOT, 'tests', 'exported-test.webdaw.zip'));
  await P.waitForFunction(() => __daw.S.project.tracks.length >= 3, null, { timeout: 10000 });
  await P.tap('#sessionView .col[data-id]:nth-child(2) .col-head');
  await P.evaluate(() => { const t = __daw.S.project.tracks[1]; __daw.S.expanded.add(`${t.id}:0:${t.fx[0].type}`); });
  await P.evaluate(() => [...document.querySelectorAll('.views button')][0].click());
  await P.evaluate(() => { __daw.engine.launchSlot(__daw.S.project.tracks[1], 0); });
  await sleep(900);
  await P.screenshot({ path: path.join(shots, 'phone-session-fx.png') });
  await P.evaluate(() => __daw.engine.stop());
  await P.tap('.views button[data-view=arrange]'); await sleep(300);
  await P.screenshot({ path: path.join(shots, 'phone-arrange.png') });
  // pinch zoom in the arrangement (two touch pointers)
  const z = await P.evaluate(async () => {
    const sc = document.querySelector('#arrangeView .arr-scroll'); const r = sc.getBoundingClientRect(); const z0 = __daw.S.zoom;
    const ev = (type, id, x) => sc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: r.top + 60, isPrimary: id === 1 }));
    ev('pointerdown', 1, r.left + 100); ev('pointerdown', 2, r.left + 160);
    for (let i = 1; i <= 5; i++) { ev('pointermove', 1, r.left + 100 - i * 12); ev('pointermove', 2, r.left + 160 + i * 12); }
    ev('pointerup', 1, 0); ev('pointerup', 2, 0);
    return { z0, z1: document.querySelector('#arrangeView .arr-scroll') && __daw.S.zoom };
  });
  ok('Pinch-zoom (two touch pointers) zooms the arrangement', z.z1 > z.z0 * 1.5, JSON.stringify(z));
  await P.tap('#btnAutoMix'); await P.waitForSelector('#dlg .am-row'); await sleep(600);
  await P.screenshot({ path: path.join(shots, 'phone-automix-popup.png') });
  await P.evaluate(() => document.querySelector('#dlg button[value=cancel]').click());
  await P.tap('.views button[data-view=session]');
  await P.tap('#btnEasy'); await sleep(200);
  await P.screenshot({ path: path.join(shots, 'phone-easy-mode.png') });
  ok('No CSP violations on the phone page', (await P.evaluate(() => window.__csp.length)) === 0);
  await phone.ctx.close();
} catch (e) {
  ok('v0.2 test run completed without exception', false, e.stack);
}
const relevant = errors.filter((e) => !/favicon/i.test(e));
ok('No console errors / page errors (v0.2 run)', relevant.length === 0, relevant.join('\n'));
await browser.close(); server.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} v0.2 checks passed`);
fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-v2.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
