// Phone mode: a simplified, big-target layout for small/touch screens (and for anyone who wants it).
// One screen at a time with a bottom tab bar (Record, Tracks, Mix, Effects, More), one focused track
// (swipe or use the big arrows to move between tracks), plain-language labels next to technical names.
// The full layout is always one tap away (More → Show full layout). Shares all state with the desktop UI.
import { h, $, $$, toast, haptic, prefs, savePrefs } from './dom.js';
import { drawWaveform } from './waveform.js';
import { icon } from './icons.js';

export const PLAIN_FX = {
  compressor: 'Make it louder', eq: 'Tone', reverb: 'Space / room', delay: 'Echo', distortion: 'Grit', amp: 'Guitar amp',
  chorus: 'Thicken', autopan: 'Move left–right', tremolo: 'Pulse the volume', pitch: 'Tuning', limiter: 'Stop it clipping',
  maximizer: 'Louder master', rack: 'Effect rack',
};
const PLAIN_PARAM = { threshold: 'How much', ratio: 'Strength', makeup: 'Loudness', mix: 'Amount', decay: 'Length', space: 'Room type', feedback: 'Repeats',
  sync: 'Timing', drive: 'Grit amount', level: 'Output', voicing: 'Style', lowGain: 'Bass', m1Gain: 'Low mids', m2Gain: 'High mids', highGain: 'Treble',
  speed: 'Snap speed', humanize: 'Natural feel', depth: 'Depth', rate: 'Speed', gain: 'Gain', ceiling: 'Max level', input: 'Input', channel: 'Channel',
  bass: 'Bass', mid: 'Mids', treble: 'Treble', master: 'Volume', macro1: 'Macro 1', macro2: 'Macro 2', macro3: 'Macro 3', macro4: 'Macro 4' };
const TABS = [['record', 'record', 'Record'], ['tracks', 'tracks', 'Tracks'], ['mix', 'mixer', 'Mix'], ['effects', 'fx', 'Effects'], ['more', 'more', 'More']];

export function wantsPhone() {
  const mode = prefs.phoneMode || 'auto';
  if (mode === 'on') return true; if (mode === 'off') return false;
  return matchMedia('(max-width: 700px)').matches || (matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 560);
}

export function createPhone(api) {
  const { S, engine } = api;
  let root = null, tab = 'record', active = false, wave = null, lastDraw = 0, carry = null, quietUntil = 0;
  const focused = () => { let t = api.track(S.selected); if (!t || t.kind === 'group') t = S.project.tracks.find((x) => x.kind !== 'group') || null; if (t) S.selected = t.id; return t; };
  const tracksList = () => S.project.tracks.filter((t) => t.kind !== 'group');
  function move(d) {
    const L = tracksList(); if (!L.length) return; const t = focused(); let i = L.indexOf(t) + d; i = (i + L.length) % L.length;
    S.selected = L[i].id; haptic(8); render(); api.renderDevices(); api.syncMonitor();
  }
  function setActive(on) {
    active = on; document.body.classList.toggle('phone', on);
    if (on) { if (!root) build(); root.hidden = false; render(); } else if (root) root.hidden = true;
  }
  function build() {
    root = h('div', { id: 'phone', role: 'application', 'aria-label': 'Simple phone layout' });
    const bar = h('div', { class: 'ph-top' },
      h('span', { class: 'ph-title' }), h('span', { class: 'ph-pos' }, '1.1.1'),
      h('button', { class: 'ph-play', 'aria-label': 'Play or stop', title: 'Play / stop', onclick: () => { haptic(10); api.togglePlay(); } }, icon('play')),
      h('button', { class: 'ph-undo', 'aria-label': 'Undo', title: 'Undo', onclick: () => api.undo() }, icon('undo')));
    const body = h('div', { class: 'ph-body' });
    const tabs = h('nav', { class: 'ph-tabs', role: 'tablist' }, TABS.map(([k, ico, label]) => h('button', { class: 'ph-tab', 'data-tab': k, role: 'tab', 'aria-label': label, onclick: () => show(k) }, h('span', { class: 'tab-ico' }, icon(ico)), h('span', { class: 'lbl' }, label))));
    root.append(bar, body, tabs); document.body.append(root);
    // the finger that long-pressed a clip must not "tap" whatever the re-rendered screen puts under it
    root.addEventListener('click', (e) => { if (Date.now() < quietUntil) { e.preventDefault(); e.stopPropagation(); } }, true);
    // swipe between tracks (not on sliders / waveform scrubbing)
    let sx = null, sy = 0, st = 0;
    body.addEventListener('pointerdown', (e) => { if (e.target.closest('input, select, .ph-noswipe, .ph-sheet')) { sx = null; return; } sx = e.clientX; sy = e.clientY; st = Date.now(); });
    body.addEventListener('pointerup', (e) => {
      if (sx == null) return; const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 800 && tab !== 'more') move(dx < 0 ? 1 : -1);
    });
  }
  function show(k) { tab = k; haptic(6); render(); }
  function pager(t) {
    const L = tracksList(), i = L.indexOf(t);
    return h('div', { class: 'ph-pager' },
      h('button', { class: 'ph-arrow', 'aria-label': 'Previous track', onclick: () => move(-1), disabled: L.length < 2 }, icon('chevLeft')),
      h('div', { class: 'ph-track', style: { '--c': t ? t.color : '#888' } }, h('div', { class: 'ph-tname' }, t ? t.name : 'No track'), h('div', { class: 'ph-tsub' }, t ? `Track ${i + 1} of ${L.length} · ${t.kind === 'midi' ? (t.instrument === 'drums' ? 'Drums' : 'Keyboard') : 'Voice / instrument'} · swipe to change` : '')),
      h('button', { class: 'ph-arrow', 'aria-label': 'Next track', onclick: () => move(1), disabled: L.length < 2 }, icon('chevRight')));
  }
  const big = (label, sub, fn, cls = '') => h('button', { class: 'ph-big ' + cls, onclick: fn }, h('span', { class: 'b1' }, label), sub ? h('span', { class: 'b2' }, sub) : null);
  const slider = (label, sub, min, max, step, value, fmt, onInput) => {
    const out = h('span', { class: 'ph-val' }, fmt(value));
    const inp = h('input', { type: 'range', min, max, step, value, 'aria-label': label, oninput: (e) => { const v = +e.target.value; out.textContent = fmt(v); onInput(v); } });
    return h('label', { class: 'ph-slider' }, h('span', { class: 'ph-sl-top' }, h('span', { class: 'b1' }, label), sub ? h('span', { class: 'b2' }, sub) : null, out), inp);
  }
  function waveBox(t, tall = true) {
    const cv = h('canvas', { class: 'ph-wave' + (tall ? ' tall' : '') , 'aria-label': 'Waveform of this track' });
    const box = h('div', { class: 'ph-wavebox ph-noswipe', style: { '--c': t.color } }, cv, h('div', { class: 'ph-wave-empty' }, 'No recording yet'));
    wave = { cv, box, t }; requestAnimationFrame(drawWave);
    box.addEventListener('click', () => { const c = mainClip(t); if (!c) return; if (engine.audition && engine.audition.c === c) engine.stopAudition(); else { engine.resume(); api.startAudition(t, c, { key: c.id ? 'arr:' + c.id : '' }); } });
    box.title = 'Tap to preview (tap again to stop)';
    return box;
  }
  function mainClip(t) {
    const clips = t.arrangement.filter((c) => c.bufferId && engine.buffers.get(c.bufferId));
    const slot = t.slots.find((c) => c && c.bufferId && engine.buffers.get(c.bufferId));
    return clips.length ? clips.reduce((a, b) => (b.duration > a.duration ? b : a)) : slot;
  }
  function drawWave() {
    if (!wave || !wave.cv.isConnected) return; const t = wave.t;
    // live recording: show the last seconds scrolling in
    const live = api.liveTakes().find((k) => k.tid === t.id);
    if (live) { const lp = api.livePeaksFor(t.id + ':' + live.kind, live.rec); const d = lp.duration; drawWaveform(wave.cv, lp, { startSec: Math.max(0, d - 6), endSec: Math.max(6, d), color: '#EF4444', bg: '#1a0e10', stereo: false }); wave.box.classList.add('has'); return; }
    const c = mainClip(t);
    wave.box.classList.toggle('has', !!c);
    if (!c) { const g = wave.cv.getContext('2d'); g.clearRect(0, 0, wave.cv.width, wave.cv.height); return; }
    const buf = engine.buffers.get(c.bufferId); const a = c.offset || c.loopStart || 0; const b = a + (c.duration || c.loopLength || buf.duration);
    drawWaveform(wave.cv, buf, { startSec: a, endSec: b, color: t.color, bg: '#111114' });
    if (engine.audition && engine.audition.c === c) { const p = engine.auditionPos(); const g = wave.cv.getContext('2d'); const x = (p - a) / (b - a) * wave.cv.width; g.fillStyle = '#EF4444'; g.fillRect(Math.round(x), 0, Math.max(2, devicePixelRatio * 1.5), wave.cv.height); }
  }
  function recordScreen(t) {
    const recOn = engine.recording, waiting = engine.autoRec.state === 'waiting';
    const status = h('div', { class: 'ph-status' + (recOn ? ' rec' : waiting ? ' wait' : '') }, recOn ? 'Recording' : waiting ? 'Listening… starts when you play' : t && t.arm ? 'Ready — mic is on' : 'Ready to record');
    const btn = h('button', { class: 'ph-recbtn' + (recOn ? ' on' : waiting ? ' wait' : ''), 'aria-label': recOn || waiting ? 'Stop recording' : 'Record', onclick: () => recordPress(t) }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, recOn || waiting ? 'Stop' : 'Record'));
    return [pager(t), t ? waveBox(t) : null, status, h('div', { class: 'ph-center' }, btn),
      h('div', { class: 'ph-level' }, h('span', { class: 'b2' }, 'Microphone level'), h('div', { class: 'ph-meter' }, h('i'))),
      h('div', { class: 'ph-row' },
        big(engine.autoRec.state !== 'off' ? 'Auto-start: on' : 'Auto-start: off', 'Start recording when I play', async () => { if (t && !t.arm && t.kind !== 'midi') await api.toggleArm(t); await api.toggleAutoRecord(); render(); }, engine.autoRec.state !== 'off' ? 'on' : ''),
        big(engine.metronome ? 'Click: on' : 'Click: off', 'Metronome', () => { engine.metronome = !engine.metronome; engine.nextClick = null; api.updateTransportUI(); render(); }, engine.metronome ? 'on' : '')),
      loopPanel()];
  }
  // Loop: one big toggle plus "loop these bars" (start bar and length). Recording while the loop is on keeps every pass as a take.
  function loopPanel() {
    const L = api.loopInfo(), lens = [1, 2, 4, 8];
    const set = (bar, bars, on = true) => { haptic(8); api.setLoopBars(bar, bars, on); render(); };
    return h('div', { class: 'ph-loop', role: 'group', 'aria-label': 'Loop' },
      h('div', { class: 'ph-loop-row' },
        h('button', { class: 'ph-loop-toggle' + (L.on ? ' on' : ''), 'aria-pressed': String(L.on), 'aria-label': 'Loop', onclick: () => { haptic(8); api.toggleLoop(); render(); } }, icon('loop'), L.on ? 'Loop: on' : 'Loop: off'),
        h('button', { class: 'ph-loop-here', title: 'Loop the bars at the playhead', onclick: () => set(Math.floor((engine.barFloor(engine.position()) - engine.gridOffset) / engine.barDur + 1e-6) + 1, Math.max(1, Math.round(L.bars)) || 4) }, 'Loop here')),
      h('div', { class: 'ph-loop-row' }, h('span', { class: 'lbl2' }, 'From bar'),
        h('button', { class: 'ph-loop-prev', 'aria-label': 'Loop starts one bar earlier', onclick: () => set(L.startBar - 1, L.bars, L.on) }, icon('chevLeft')),
        h('span', { class: 'val ph-loop-start' }, String(L.startBar)),
        h('button', { class: 'ph-loop-next', 'aria-label': 'Loop starts one bar later', onclick: () => set(L.startBar + 1, L.bars, L.on) }, icon('chevRight'))),
      h('div', { class: 'ph-loop-row' }, h('span', { class: 'lbl2' }, 'Bars'),
        lens.map((n) => h('button', { class: 'ph-loop-len' + (Math.abs(L.bars - n) < 0.01 ? ' on' : ''), 'aria-pressed': String(Math.abs(L.bars - n) < 0.01), 'aria-label': `Loop ${n} bar${n > 1 ? 's' : ''}`, onclick: () => set(L.startBar, n) }, String(n)))),
      L.on ? h('span', { class: 'ph-hint' }, `Looping ${L.label}. Recording now keeps every pass as a take.`) : null);
  }
  async function recordPress(t) {
    haptic(16);
    if (engine.recording || engine.autoRec.state === 'waiting') { await api.toggleRecord(); render(); return; }
    if (!t) { toast('Add a track first (Tracks tab).'); return; }
    if (!t.arm) await api.toggleArm(t);
    if (!t.arm) return; // mic permission refused
    await api.toggleRecord(); render();
  }
  // clips of the focused track: tap to preview, long-press to pick one up, swipe to another track, tap "Place here"
  function clipStrip(t) {
    if (!t) return null;
    const clips = [...t.arrangement].sort((a, b) => a.start - b.start);
    const strip = h('div', { class: 'ph-clips ph-noswipe', role: 'list', 'aria-label': 'Clips on this track' });
    if (!clips.length) strip.append(h('span', { class: 'ph-hint' }, 'No clips on this track yet.'));
    for (const c of clips) {
      const chip = h('button', { class: 'ph-clip' + (carry && carry.c === c ? ' carried' : '') + (engine.audition && engine.audition.c === c ? ' auditioning' : ''), role: 'listitem', style: { '--c': t.color }, title: 'Tap to preview, long-press to pick up and move', 'aria-label': `Clip ${c.name || ''} at ${api.fmtPos(c.start)} — tap to preview, long-press to move` },
        h('span', { class: 'b1' }, c.name || 'Clip'), h('span', { class: 'b2' }, api.fmtPos(c.start)));
      let timer = null;
      const pick = () => { carry = { t, c }; quietUntil = Date.now() + 1500; window.addEventListener('pointerup', () => setTimeout(() => { quietUntil = 0; }, 60), { once: true, capture: true }); haptic(20); render(); };
      chip.addEventListener('pointerdown', () => { clearTimeout(timer); timer = setTimeout(pick, 480); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => chip.addEventListener(ev, () => clearTimeout(timer)));
      chip.addEventListener('contextmenu', (e) => { e.preventDefault(); pick(); });
      chip.addEventListener('click', () => { if (engine.audition && engine.audition.c === c) engine.stopAudition(); else { engine.resume(); api.startAudition(t, c, { key: 'arr:' + c.id }); } render(); });
      strip.append(chip);
    }
    return strip;
  }
  function carryBar(t) {
    if (!carry) return null;
    const pos = api.snapPos(engine.position());
    return h('div', { class: 'ph-carry', role: 'status' },
      h('div', { class: 'b1' }, icon('move'), ` Moving “${carry.c.name || 'Clip'}”`),
      h('div', { class: 'b2' }, `Swipe or use ‹ › to choose a track, then place it at the playhead (${api.fmtPos(pos)}). Overlapped clips get trimmed.`),
      h('div', { class: 'ph-row' },
        big('Place here', t ? t.name : '', () => { const c = carry; carry = null; if (!t) return render(); api.placeClip({ kind: 'arr', t: c.t, c: c.c }, { kind: 'arr', trackId: t.id, pos }); toast('Placed — Undo if that was wrong', 1800); }, 'accent ph-place'),
        big('Cancel', null, () => { carry = null; render(); })));
  }
  function tracksScreen(t) {
    return [pager(t), carryBar(t), t ? waveBox(t) : null, clipStrip(t),
      t ? h('div', { class: 'ph-row' },
        big(t.arm ? 'Mic: on' : 'Mic: off', t.kind === 'midi' ? 'Listen to MIDI keyboard (arm)' : 'Hear the microphone (arm)', async () => { await api.toggleArm(t); render(); }, (t.arm ? 'on red' : '') + ' ph-arm'),
        big(t.mute ? 'Muted' : 'Mute', 'Silence this track', () => { api.change('Mute', () => { t.mute = !t.mute; engine.syncTrack(t); }); api.renderAll(); }, t.mute ? 'on' : ''),
        big(t.solo ? 'Solo on' : 'Solo', 'Hear only this track', () => { api.change('Solo', () => { t.solo = !t.solo; engine.syncMutes(); }); api.renderAll(); }, t.solo ? 'on' : '')) : null,
      t ? big('Rename track', t.name, () => { api.renameTrack(t); }) : null,
      h('h3', { class: 'ph-h' }, 'Add a track'),
      h('div', { class: 'ph-col ph-add' },
        big([icon('mic'), ' Voice or instrument'], 'Record with the microphone (audio track)', () => { api.addTrack(null, 'audio'); tab = 'record'; api.renderAll(); }),
        big([icon('keys'), ' Keyboard'], 'Play notes on screen or with a MIDI keyboard', () => { api.addTrack(null, 'midi', 'synth'); api.renderAll(); }),
        big([icon('drums'), ' Drums'], 'Tap drum pads', () => { api.addTrack(null, 'midi', 'drums'); api.renderAll(); }))];
  }
  function mixScreen(t) {
    const dbFmt = (v) => (v <= -60 ? '−∞' : (v > 0 ? '+' : '') + v.toFixed(1) + ' dB');
    return [pager(t),
      t ? slider('Volume', 'How loud this track is', -60, 6, 0.5, t.volume, dbFmt, (v) => { api.history.push('Volume', 'vol' + t.id); t.volume = v; engine.syncTrack(t); api.markDirty(); }) : null,
      t ? slider('Left / right', 'Pan', -1, 1, 0.05, t.pan, (v) => (Math.abs(v) < 0.03 ? 'Centre' : v < 0 ? `${Math.round(-v * 100)}% left` : `${Math.round(v * 100)}% right`), (v) => { api.history.push('Pan', 'pan' + t.id); t.pan = v; engine.syncTrack(t); api.markDirty(); }) : null,
      big([icon('mixer'), ' Auto-Mix'], 'Set up the sound of every track for me', () => api.autoMixDialog(), 'accent ph-automix'),
      slider('Main volume', 'Everything together (master)', -60, 6, 0.5, S.project.master.volume, dbFmt, (v) => { api.history.push('Master volume', 'mvol'); S.project.master.volume = v; engine.syncMaster(); api.markDirty(); })];
  }
  function effectsScreen(t) {
    const out = [pager(t)]; if (!t) return out;
    const list = h('div', { class: 'ph-col' });
    t.fx.forEach((d, idx) => {
      const C = api.EFFECT_TYPES[d.type]; if (!C) return;
      const card = h('div', { class: 'ph-fx' + (d.enabled === false ? ' off' : '') });
      card.append(h('div', { class: 'ph-fx-head' },
        h('div', {}, h('div', { class: 'b1' }, PLAIN_FX[d.type] || C.label), h('div', { class: 'b2' }, C.label)),
        h('button', { class: 'ph-toggle' + (d.enabled === false ? '' : ' on'), 'aria-label': (d.enabled === false ? 'Turn on ' : 'Turn off ') + C.label, onclick: () => { api.change('Toggle effect', () => { d.enabled = d.enabled === false; engine.setFxEnabled(t.id, idx, d.enabled); }); render(); } }, d.enabled === false ? 'Off' : 'On')));
      const inst = engine.fxInstances(t.id)[idx];
      for (const key of (api.EASY_PARAMS[d.type] || []).slice(0, 2)) {
        const p = C.params.find((x) => x.key === key); if (!p || p.type === 'select' || p.options) continue;
        const v = inst ? inst.values[key] : (d.values[key] ?? p.def);
        card.append(slider(PLAIN_PARAM[key] || p.label, p.label, p.min, p.max, p.step || (p.max - p.min) / 200, v, (x) => api.fmtParam(p, x), (x) => api.setParam(t.id, idx, key, x)));
      }
      card.append(h('button', { class: 'ph-remove', onclick: () => { api.change('Remove effect', () => { t.fx.splice(idx, 1); engine.setTrackFx(t); }); api.renderAll(); } }, 'Remove'));
      list.append(card);
    });
    if (!t.fx.length) list.append(h('p', { class: 'ph-hint' }, 'No effects yet. Add one below — or use Auto-Mix on the Mix tab.'));
    out.push(list, big([icon('plus'), ' Add an effect'], 'Echo, space, tone, louder…', () => addFxSheet(t), 'accent ph-addfx'));
    return out;
  }
  function addFxSheet(t) {
    const sheet = h('div', { class: 'ph-sheet', role: 'dialog', 'aria-label': 'Add an effect' });
    const close = () => sheet.remove();
    const items = Object.keys(PLAIN_FX).filter((k) => k !== 'rack' && api.EFFECT_TYPES[k]).map((k) => h('button', { class: 'ph-big', onclick: () => {
      if (!api.gate('fx.' + k, api.EFFECT_TYPES[k].label)) return;
      api.change('Add effect', () => { t.fx.push({ type: k, enabled: true, values: {} }); engine.setTrackFx(t); }); close(); api.renderAll(); toast(`Added: ${PLAIN_FX[k]}`, 1500);
    } }, h('span', { class: 'b1' }, PLAIN_FX[k], api.lockBadge('fx.' + k)), h('span', { class: 'b2' }, api.EFFECT_TYPES[k].label + ' — ' + (api.EFFECT_HELP[k] || '').split(':').slice(1).join(':').trim().split('.')[0])));
    sheet.append(h('div', { class: 'ph-sheet-card' }, h('h3', { class: 'ph-h' }, 'Add an effect'), h('div', { class: 'ph-col' }, items), big('Cancel', null, close)));
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    root.append(sheet);
  }
  function moreScreen() {
    return [h('h3', { class: 'ph-h' }, 'Song'),
      h('div', { class: 'ph-col' },
        big([icon('save'), ' Save / share'], 'Save now and share or download the song file', () => api.saveAndShare(), 'accent ph-save'),
        big([icon('folder'), ' My songs'], 'Open another project', () => api.projectsDialog()),
        h('div', { class: 'ph-row' }, big([icon('undo'), ' Undo'], null, () => api.undo()), big([icon('redo'), ' Redo'], null, () => api.redo()))),
      h('h3', { class: 'ph-h' }, 'Timing'),
      h('div', { class: 'ph-row' },
        big('TAP', `Tempo ${S.project.bpm} BPM — tap on the beat`, () => { api.tapTempo(); render(); }, 'ph-tap'),
        big('Find tempo', 'Listen to the band (auto)', (e) => api.tempoPopover(e.currentTarget))),
      h('h3', { class: 'ph-h' }, 'Help & settings'),
      h('div', { class: 'ph-col' },
        big([icon('book'), ' Tutorial'], 'Show the 6-step introduction again', () => api.startTutorial()),
        big([icon('help'), ' Help mode'], 'Tap anything to see what it does', () => api.toggleHelp()),
        big([icon('settings'), ' Settings'], 'Bigger text, contrast, haptics, tier…', () => api.prefsDialog()),
        big([icon('desktop'), ' Show full layout'], 'All controls (more complex)', () => { prefs.phoneMode = 'off'; savePrefs(); setActive(false); api.renderAll(); toast('Full layout. Switch back in Menu → Simple phone layout.', 3000); }, 'ph-full'))];
  }
  function render() {
    if (!active || !root || !S.project) return;
    const t = focused();
    root.querySelector('.ph-title').textContent = S.project.name;
    $$('.ph-tab', root).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    root.querySelector('.ph-play').replaceChildren(icon(engine.playing ? 'stop' : 'play'));
    root.querySelector('.ph-play').classList.toggle('on', engine.playing);
    const body = root.querySelector('.ph-body'); body.innerHTML = ''; wave = null;
    const scr = tab === 'record' ? recordScreen(t) : tab === 'tracks' ? tracksScreen(t) : tab === 'mix' ? mixScreen(t) : tab === 'effects' ? effectsScreen(t) : moreScreen();
    body.dataset.tab = tab; body.append(...scr.filter(Boolean));
  }
  function frame(ts) {
    if (!active || !root) return;
    const pos = root.querySelector('.ph-pos'); if (pos) pos.textContent = api.fmtPos(engine.position());
    const m = root.querySelector('.ph-meter i');
    if (m) { const t = focused(); const n = t && engine.tracks.get(t.id); const db = n && n.inputChain ? n.inputLevel || -100 : -100; m.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%'; m.dataset.lv = db > -1 ? 'clip' : db > -12 ? 'hot' : ''; }
    const st = root.querySelector('.ph-status.rec'); if (st && engine.recording) st.textContent = 'Recording ' + fmtTime(engine.position() - (S.liveRec ? S.liveRec.startPos : 0));
    if (wave && ts - lastDraw > 80 && (engine.recording || engine.playing || engine.audition)) { lastDraw = ts; drawWave(); }
  }
  const fmtTime = (s) => { s = Math.max(0, s); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
  return { setActive, render, frame, show, get active() { return active; }, get tab() { return tab; }, move, get carry() { return carry; } };
}
