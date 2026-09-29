// Step sequencer view (Squarp Pyramid / Hapax inspired). Desktop: the "Seq" main view. Phone: the "Steps" tab.
// Layout, top to bottom: toolbar (on/off, output, rate, length, swing, record, p-lock, randomize), pattern
// slots A-P with the song chain, the 16-step page grid (or drum rows), one value lane, and the step inspector.
// All edits go through api.change() so undo works; the audio side is sequencer.js + Engine.scheduleMidi.
import { h, $, $$, toast, haptic, prefs, savePrefs } from './dom.js';
import { icon } from './icons.js';
import * as SQ from '../audio/sequencer.js';
import { PAD_ORDER } from '../audio/instruments.js';
import { MIDI, outputs as midiOutputs, engineMidi } from '../midi.js';

const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => NN[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
const PAGE = 16;
const LANES = SQ.STEP_FIELDS;
const fmtField = (f, v) => (f.key === 'len' ? (v >= 1 ? +v.toFixed(2) + ' st' : '1/' + Math.round(1 / v) + ' st') : f.key === 'nudge' ? (v > 0 ? '+' : '') + v + ' %' : f.key === 'rat' ? v + 'x' : v + (f.unit === '%' ? ' %' : ''));

export function createSeqView(api) {
  const { S, engine } = api;
  const ui = S.seqUI = { page: 0, sel: [], lane: 'v', stepRec: false, liveRec: false, plock: false, follow: true, oct: 4, cursor: 0, clip: null };
  const live = { open: new Map(), pass: 0, lastAt: 0, lastSi: -1 };
  let host = null, phoneMode = false, shown = { tid: null, page: -1, pi: -1 };

  const PS = () => (phoneMode && isDrum(cur()) ? 8 : PAGE);
  const cur = () => { const t = api.track(S.selected); return t && t.kind === 'midi' ? t : null; };
  const midiTracks = () => S.project.tracks.filter((t) => t.kind === 'midi');
  const pat = (t) => (t && t.seq ? t.seq.patterns[t.seq.active] : null);
  const isDrum = (t) => !!(t && t.inst && t.inst.type === 'drums' && !(t.plugins && t.plugins[0] && t.plugins[0].instrument));
  const defNote = (t) => (isDrum(t) ? 36 : 60);
  const slotName = (i) => SQ.SLOT_NAMES[i] || '?';
  const edit = (label, fn, key) => api.change(label, fn, key);
  const clampSel = (p) => { ui.sel = ui.sel.filter((i) => i < p.len); };
  const pages = (p) => Math.max(1, Math.ceil(p.len / PS()));
  const padLabel = (t, n) => (api.drumRack ? api.drumRack.name(t, n) : ((PAD_ORDER.find((x) => x[0] === n) || [])[1] || noteName(n)));
  const noteLabel = (t, n) => (isDrum(t) ? padLabel(t, n) : noteName(n));
  const audition = (t, n, v = 100) => { const nd = engine.tracks.get(t.id); if (!nd || !nd.inst) return; engine.resume(); (nd.midi || nd.inst).playNote(n, v, engine.ctx.currentTime + 0.01, 0.25); };

  // ---------------------------------------------------------------- actions
  function enable(t) {
    if (!t) return;
    edit('Add sequencer', () => { t.seq = SQ.newSeq(defNote(t)); });
    ui.page = 0; ui.sel = []; ui.cursor = 0; haptic(12); rerender();
  }
  async function newSeqTrack(type = 'synth') {
    const t = api.addTrack(null, 'midi', type); if (!t) return;
    t.seq = SQ.newSeq(defNote(t)); t.name = (type === 'drums' ? 'Beat ' : 'Seq ') + midiTracks().length;
    api.select(t.id); ui.page = 0; ui.sel = []; api.markDirty(); api.renderAll();
  }
  function toggleStep(t, si, note) {
    const p = pat(t), s = p.steps[si]; if (!s) return;
    edit(s.on ? 'Step off' : 'Step on', () => {
      if (note != null) SQ.toggleNote(s, note);
      else { s.on = !s.on; if (s.on && !s.n.length) s.n = [defNote(t)]; }
    });
    if (s.on) { ui.sel = [si]; audition(t, note != null ? note : s.n[0], s.v); }
    haptic(s.on ? 10 : 6); refresh();
  }
  function selectStep(si, add, range) {
    if (range && ui.sel.length) { const a = ui.sel[ui.sel.length - 1], lo = Math.min(a, si), hi = Math.max(a, si); ui.sel = [...new Set([...ui.sel, ...Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)])]; }
    else if (add) ui.sel = ui.sel.includes(si) ? ui.sel.filter((x) => x !== si) : [...ui.sel, si];
    else ui.sel = ui.sel.length === 1 && ui.sel[0] === si ? [] : [si];
    ui.cursor = si; haptic(5); refresh();
  }
  function setStepField(t, key, v, coalesce) {
    const p = pat(t); if (!p || !ui.sel.length) return;
    const f = LANES.find((x) => x.key === key);
    edit('Step ' + f.label.toLowerCase(), () => { for (const si of ui.sel) if (p.steps[si]) SQ.setField(p.steps[si], key, v); }, coalesce);
  }
  function setNotes(t, n, addChord) {
    const p = pat(t); if (!p) return;
    if (ui.stepRec) return stepRecord(t, n, 100);
    if (!ui.sel.length) { audition(t, n); return; }
    edit('Step note', () => { for (const si of ui.sel) { const s = p.steps[si]; if (!s) continue; if (addChord && s.on) { if (!s.n.includes(n) && s.n.length < SQ.SEQ_LIMITS.notes) s.n.push(n); } else { s.n = [n]; s.on = true; } } });
    audition(t, n); haptic(8); refresh();
  }
  function transposeSel(t, d) {
    const p = pat(t); if (!p || !ui.sel.length) return;
    edit('Transpose steps', () => { for (const si of ui.sel) { const s = p.steps[si]; if (s) s.n = s.n.map((x) => Math.max(0, Math.min(127, x + d))); } }, 'seqtr:' + t.id);
    const s = p.steps[ui.sel[0]]; if (s && s.on) audition(t, s.n[0], s.v); refresh();
  }
  function setLen(t, len) {
    const p = pat(t); len = Math.max(1, Math.min(SQ.SEQ_LIMITS.steps, Math.round(len) || 16));
    if (len === p.len) return;
    edit('Pattern length', () => SQ.setPatternLength(p, len), 'seqlen:' + t.id);
    ui.page = Math.min(ui.page, pages(p) - 1); clampSel(p); rerender();
  }
  function slotClick(t, i, ev) {
    const seq = t.seq;
    if (!seq.patterns[i]) {
      const src = pat(t), copy = ev && (ev.shiftKey || ev.altKey);
      edit('New pattern ' + slotName(i), () => { while (seq.patterns.length <= i) seq.patterns.push(null); seq.patterns[i] = copy && src ? JSON.parse(JSON.stringify(src)) : SQ.newPattern(src ? src.len : 16, src ? src.rate : '1/16', defNote(t)); });
      engine.seq.queueSlot(t, i); if (!engine.playing) seq.active = i;
      api.markDirty(); ui.sel = []; ui.page = 0; haptic(12); rerender();
      toast(`Pattern ${slotName(i)} created${copy ? ' (copy)' : ''}. It plays ${engine.playing ? 'when the current one ends' : 'now'}.`, 2000);
      return;
    }
    const now = engine.seq.queueSlot(t, i);
    if (!now) toast(`Pattern ${slotName(i)} starts at the end of the current pattern.`, 1600);
    api.markDirty(); ui.sel = []; ui.page = 0; haptic(8); rerender();
  }
  function copyPattern(t) { ui.clip = JSON.parse(JSON.stringify(pat(t))); toast('Pattern copied. Pick a slot and press Paste.', 1600); rerender(); }
  function pastePattern(t) { if (!ui.clip) return; edit('Paste pattern', () => { t.seq.patterns[t.seq.active] = JSON.parse(JSON.stringify(ui.clip)); }); rerender(); }
  function clearPattern(t) {
    const p = pat(t);
    edit('Clear pattern', () => { p.steps = p.steps.map(() => SQ.newStep(defNote(t))); });
    ui.sel = []; haptic(14); rerender();
  }
  function deletePattern(t) {
    const seq = t.seq; if (seq.patterns.filter(Boolean).length < 2) return clearPattern(t);
    const i = seq.active;
    edit('Delete pattern ' + slotName(i), () => { seq.patterns[i] = null; seq.chain = seq.chain.filter((c) => c.p !== i); if (!seq.chain.length) seq.song = false; seq.active = seq.patterns.findIndex(Boolean); });
    ui.sel = []; rerender();
  }
  function chainAdd(t) {
    const seq = t.seq; if (seq.chain.length >= SQ.SEQ_LIMITS.chain) return toast('The chain is full (64 entries).');
    const last = seq.chain[seq.chain.length - 1];
    edit('Add to chain', () => { if (last && last.p === seq.active) last.rep = Math.min(SQ.SEQ_LIMITS.repeats, last.rep + 1); else seq.chain.push({ p: seq.active, rep: 1 }); });
    haptic(8); rerender();
  }
  function chainRep(t, k, d) { const c = t.seq.chain[k]; if (!c) return; edit('Chain repeats', () => { c.rep = Math.max(1, Math.min(SQ.SEQ_LIMITS.repeats, c.rep + d)); }, 'seqch:' + t.id + ':' + k); rerender(); }
  function chainDel(t, k) { edit('Remove from chain', () => { t.seq.chain.splice(k, 1); if (!t.seq.chain.length) t.seq.song = false; }); rerender(); }
  function toggleSong(t) {
    if (!t.seq.chain.length) return toast('Add patterns to the chain first (press "+ Add"), then turn Song on.', 3200);
    edit(t.seq.song ? 'Song mode off' : 'Song mode on', () => { t.seq.song = !t.seq.song; }); haptic(10); rerender();
  }
  function toggleLock(t) {
    const p = pat(t); if (!ui.sel.length) return;
    const on = !ui.sel.every((si) => p.steps[si] && p.steps[si].lock);
    edit(on ? 'Protect steps' : 'Unprotect steps', () => { for (const si of ui.sel) { const s = p.steps[si]; if (!s) continue; if (on) s.lock = true; else delete s.lock; } });
    rerender();
  }
  function addPlock(t, entry, value) {
    const p = pat(t); if (!ui.sel.length || !entry) return false;
    const k = SQ.lockKey(entry.fx, entry.key);
    for (const si of ui.sel) { const s = p.steps[si]; if (s && !(s.pl && k in s.pl) && Object.keys(s.pl || {}).length >= SQ.SEQ_LIMITS.locks) { toast('Up to 16 parameter locks per step.'); return false; } }
    edit('Parameter lock ' + entry.label, () => { for (const si of ui.sel) { const s = p.steps[si]; if (!s) continue; s.pl = s.pl || {}; s.pl[k] = value; } }, 'seqpl:' + t.id + ':' + k);
    return true;
  }
  function delPlock(t, k) {
    const p = pat(t);
    edit('Remove parameter lock', () => { for (const si of ui.sel) { const s = p.steps[si]; if (s && s.pl) { delete s.pl[k]; if (!Object.keys(s.pl).length) delete s.pl; } } });
    rerender();
  }
  // P-LOCK mode: a knob move on this track's devices becomes a lock on the selected steps
  function capture(trackId, fx, key, v) {
    if (!ui.plock || !S.project) return false;
    const t = cur(); if (!t || t.id !== trackId || !t.seq || !ui.sel.length) return false;
    if (!(S.view === 'seq' || onPhone())) return false;
    const entry = api.paramCatalog(t).find((e) => String(e.fx) === String(fx) && e.key === String(key)); if (!entry) return false;
    if (addPlock(t, entry, v)) { refreshGrid(); renderInspector(); }
    return true;
  }
  // ---------------------------------------------------------------- recording (MIDI keyboard / on-screen keys)
  function stepRecord(t, n, v, fromMidi = false) {
    const p = pat(t); if (!p) return;
    // notes from a MIDI keyboard that arrive together (< 90 ms) form a chord on one step
    const now = performance.now(), chord = fromMidi && live.lastMidi && now - live.lastAt < 90 && live.lastSi >= 0;
    live.lastMidi = fromMidi;
    const si = chord ? live.lastSi : ui.cursor % p.len;
    edit('Step record', () => { SQ.recordNote(p, si, n, v, { replace: !chord }); }, chord ? 'seqsr:' + t.id + ':' + si : undefined);
    live.lastAt = now; live.lastSi = si;
    if (!chord) ui.cursor = (si + 1) % p.len;
    ui.sel = [si]; if (ui.follow) ui.page = Math.floor(ui.cursor / PS());
    haptic(8); refresh();
  }
  function stepRest(t, tie) {
    const p = pat(t); if (!p) return;
    if (tie) { const prev = (ui.cursor - 1 + p.len) % p.len, s = p.steps[prev]; if (s && s.on) edit('Tie', () => { s.len = Math.min(16, s.len + 1); s.gate = 100; }); }
    ui.cursor = (ui.cursor + 1) % p.len; live.lastSi = -1; ui.page = Math.floor(ui.cursor / PS()); haptic(5); refresh();
  }
  // returns true when the note was used by the sequencer (the instrument still plays it)
  function onNote(t, n, v, on) {
    if (!t || !t.seq || t.id !== S.selected) return false;
    if (ui.stepRec && on && (!engine.playing || !ui.liveRec)) { stepRecord(t, n, v, true); return true; }
    if (!ui.liveRec || !engine.playing) return false;
    const p = pat(t), st = engine.seq.st(t.id), b = engine.seq.beatAt(engine.position());
    if (on) {
      const { si, nudge } = SQ.recordPosition(p, b, st.anchor, t.seq.quant);
      edit('Live record', () => { SQ.recordNote(p, si, n, v, { nudge }); }, 'seqlive:' + t.id + ':' + live.pass); // overdub
      live.open.set(n, { si, b });
      refreshGrid();
    } else {
      const o = live.open.get(n); live.open.delete(n); if (!o) return true;
      const L = Math.max(0.25, (b - o.b) / SQ.stepBeats(p)), s = p.steps[o.si];
      if (s) { edit('Live record', () => { s.len = Math.min(16, Math.round(L * 4) / 4); }, 'seqlive:' + t.id + ':' + live.pass); }
      refreshGrid();
    }
    return true;
  }
  function toggleLiveRec() {
    ui.liveRec = !ui.liveRec; live.pass++; live.open.clear(); 
    haptic(ui.liveRec ? 18 : 8);
    if (ui.liveRec && !engine.playing) toast('Live record is armed: press Play and play your MIDI keyboard. Notes land on the nearest step' + (cur() && cur().seq.quant ? '.' : ' (timing kept as nudge).'), 3200);
    rerender();
  }

  // ---------------------------------------------------------------- randomizer target (joins "Randomize track")
  function pool(t) {
    if (isDrum(t)) { const P = (t.inst && t.inst.pads) || {}, view = api.drumRack ? api.drumRack.rows(t) : []; const own = view.filter((n) => P[n]); return own.length >= 3 ? own : PAD_ORDER.slice(0, 8).map((x) => x[0]); }
    const k = S.project.key || { root: 0, scale: 'major' }, sc = api.SCALES[k.scale] || api.SCALES.major, out = [];
    for (let o = 4; o <= 5; o++) for (const iv of sc) out.push(12 * o + k.root + iv);
    out.push(12 * 6 + k.root); return out;
  }
  function target(t) {
    const p = pat(t); if (!p) return null;
    return { label: 'Pattern ' + slotName(t.seq.active), type: 'seq', defs: SQ.RAND_FIELDS, holder: t.seq, values: () => ({}),
      plan: (o) => { const steps = SQ.randomizeSteps(t.seq, p, { amount: o.amount, mode: o.mode, pool: pool(t) }); const ch = {}; steps.forEach((s, i) => { if (JSON.stringify(s) !== JSON.stringify(p.steps[i])) ch['s' + i] = s; }); return ch; },
      set: (k, v) => { p.steps[+k.slice(1)] = v; } };
  }

  // ---------------------------------------------------------------- rendering
  function mount(el) { host = el; phoneMode = false; rerender(); }
  const onPhone = () => !!(api.phoneActive && api.phoneActive() && api.phoneTab() === 'seq');
  function rerender() {
    if (!S.project) return;
    const ct = cur(); document.body.classList.toggle('sq-plock', !!(ui.plock && ct && ct.seq));
    if (onPhone()) { api.phoneRender(); return; }
    if (!host || S.view !== 'seq') return;
    host.replaceChildren(...build(false));
  }
  const refresh = () => rerender();
  function refreshGrid() { const g = $('.sq-gridwrap', root()); const t = cur(); if (!g || !t || !t.seq) return; g.replaceWith(gridBlock(t)); }
  const root = () => (onPhone() ? $('#phone') : host) || document;
  function renderInspector() { const el = $('.sq-insp', root()), t = cur(); if (el && t && t.seq) el.replaceWith(inspector(t)); }

  function build(phone) {
    phoneMode = phone;
    const t = cur();
    const strip = phone ? null : trackStrip();
    if (!t) return [h('div', { class: 'sq-wrap' }, strip, h('div', { class: 'sq-empty' }, h('p', {}, 'Pick a MIDI track, or make a new one for the sequencer.'),
      h('div', { class: 'sq-row' }, h('button', { class: 'sq-big', onclick: () => newSeqTrack('synth') }, icon('synth'), 'New synth sequence'), h('button', { class: 'sq-big', onclick: () => newSeqTrack('drums') }, icon('drums'), 'New drum sequence'))))];
    if (!t.seq) return [h('div', { class: 'sq-wrap' }, strip, h('div', { class: 'sq-empty' },
      h('p', {}, `"${t.name}" has no sequencer yet. A step sequencer plays patterns on this track: tap steps to turn notes on, then press Play.`),
      h('button', { class: 'sq-big accent', 'data-act': 'enable', onclick: () => enable(t) }, icon('seq'), 'Add step sequencer')))];
    const p = pat(t); clampSel(p); ui.page = Math.min(ui.page, pages(p) - 1);
    shown = { tid: t.id, page: ui.page, pi: t.seq.active };
    const main = h('div', { class: 'sq-main' + (phone ? ' phone' : '') },
      toolbar(t, phone), slots(t, phone), h('div', { class: 'sq-body' }, h('div', { class: 'sq-left' }, gridBlock(t), keys(t, phone)), inspector(t)));
    return [h('div', { class: 'sq-wrap' + (phone ? ' phone' : '') }, strip, main)];
  }
  function trackStrip() {
    const list = midiTracks();
    return h('div', { class: 'sq-tracks', role: 'listbox', 'aria-label': 'Sequencer tracks' },
      h('div', { class: 'sq-th' }, 'Tracks'),
      ...list.map((t) => {
        const p = pat(t), on = t.seq && t.seq.on;
        return h('div', { class: 'sq-tr' + (t.id === S.selected ? ' sel' : '') + (on ? ' live' : ''), role: 'option', 'aria-selected': String(t.id === S.selected), 'data-tid': t.id, onclick: () => { api.select(t.id); ui.sel = []; ui.page = 0; api.renderAll(); } },
          h('i', { class: 'sq-tc', style: { background: t.color } }),
          h('span', { class: 'sq-tn' }, t.name),
          t.seq ? h('span', { class: 'sq-tinfo', title: 'Pattern, length and step rate' }, `${t.seq.song ? 'Song' : slotName(t.seq.active)} ${p ? p.len + ' @ ' + p.rate : ''}`) : h('span', { class: 'sq-tinfo dim' }, 'no seq'),
          h('span', { class: 'sq-tbar' }, h('i', { 'data-seqbar': t.id })));
      }),
      h('div', { class: 'sq-tadd' }, h('button', { title: 'New MIDI track with a synth and a sequencer', onclick: () => newSeqTrack('synth') }, icon('plus'), 'Synth'), h('button', { title: 'New MIDI track with the drum kit and a sequencer', onclick: () => newSeqTrack('drums') }, icon('plus'), 'Drums')));
  }
  function toolbar(t, phone) {
    const seq = t.seq, p = pat(t);
    const tb = (cls, label, title, fn, extra = {}) => h('button', { class: 'sq-tb ' + cls, title, 'aria-label': extra.aria || title, 'aria-pressed': extra.pressed != null ? String(extra.pressed) : undefined, onclick: fn, ...extra.attrs }, label);
    const rate = h('select', { class: 'sq-rate', 'aria-label': 'Step rate', title: 'Step rate: how long each step is. Different rates on different tracks make polyrhythms.', onchange: (e) => { edit('Step rate', () => { p.rate = e.target.value; }); rerender(); } },
      SQ.RATES.map(([r]) => h('option', { value: r, selected: r === p.rate }, r)));
    const len = h('input', { type: 'number', class: 'sq-len', min: 1, max: SQ.SEQ_LIMITS.steps, value: p.len, 'aria-label': 'Pattern length in steps', title: 'Pattern length (1-128 steps). Different lengths on different tracks make polymeters.', onchange: (e) => setLen(t, +e.target.value) });
    const swing = h('input', { type: 'range', class: 'sq-swing', min: 0, max: 75, step: 1, value: p.swing, 'aria-label': 'Swing', title: 'Swing: delays every second step for a shuffled groove', oninput: (e) => { edit('Swing', () => { p.swing = +e.target.value; }, 'seqsw:' + t.id); sw.textContent = e.target.value + '%'; } });
    const sw = h('span', { class: 'sq-val' }, p.swing + '%');
    const outs = midiOutputs();
    const out = h('select', { class: 'sq-out', 'aria-label': 'Sequencer output', title: 'Where the notes go: this track\'s instrument or plugin, an external MIDI device, or both', onchange: async (e) => {
      const v = e.target.value;
      if (v !== 'track' && engineMidi.available) await engineMidi.refresh();
      if (v !== 'track' && !MIDI.access && !engineMidi.available) { const ok = await MIDI.init(); if (!ok) { toast(MIDI.notice() || 'MIDI output is not available (permission denied).', 4000); rerender(); return; } }
      edit('Sequencer output', () => { seq.out = v; }); rerender(); } },
      [['track', 'This track'], ['midi', 'MIDI out'], ['both', 'Track + MIDI']].map(([v, l]) => h('option', { value: v, selected: seq.out === v }, l)));
    const midiBits = seq.out === 'track' ? [] : [
      h('select', { class: 'sq-port', 'aria-label': 'MIDI output port', title: 'MIDI output device', onchange: (e) => edit('MIDI port', () => { seq.port = e.target.value; }) },
        h('option', { value: '' }, outs.length ? 'First output' : 'No MIDI outputs'), ...outs.map((o) => h('option', { value: o.id, selected: o.id === seq.port }, o.name))),
      h('select', { class: 'sq-ch', 'aria-label': 'MIDI channel', title: 'MIDI channel', onchange: (e) => edit('MIDI channel', () => { seq.ch = +e.target.value; }) },
        Array.from({ length: 16 }, (_, i) => h('option', { value: i + 1, selected: seq.ch === i + 1 }, 'Ch ' + (i + 1))))];
    const rand = api.randButtons(() => [target(t)], t.id);
    const L = api.loopInfo();
    return h('div', { class: 'sq-toolbar' },
      tb('sq-power' + (seq.on ? ' on' : ''), [icon('power'), phone ? '' : seq.on ? 'On' : 'Off'], seq.on ? 'Sequencer on: plays when the transport runs. Click to mute it.' : 'Sequencer off (muted). Click to turn on.', () => { edit(seq.on ? 'Sequencer off' : 'Sequencer on', () => { seq.on = !seq.on; }); haptic(10); rerender(); }, { pressed: seq.on }),
      h('span', { class: 'sq-grp' }, h('label', { class: 'sq-lbl' }, 'Steps'), h('button', { class: 'sq-mini', 'aria-label': 'Fewer steps', onclick: () => setLen(t, p.len - 1) }, '-'), len, h('button', { class: 'sq-mini', 'aria-label': 'More steps', onclick: () => setLen(t, p.len + 1) }, '+')),
      h('span', { class: 'sq-grp' }, h('label', { class: 'sq-lbl' }, 'Rate'), rate),
      phone ? null : h('span', { class: 'sq-grp' }, h('label', { class: 'sq-lbl' }, 'Swing'), swing, sw),
      h('span', { class: 'sq-sep' }),
      tb('sq-srec' + (ui.stepRec ? ' on rec' : ''), [icon('keys'), 'Step'], 'Step record: each note you play (MIDI keyboard or the keys below) fills the next step', () => { ui.stepRec = !ui.stepRec; live.lastSi = -1; haptic(10); rerender(); }, { pressed: ui.stepRec }),
      tb('sq-lrec' + (ui.liveRec ? ' on rec' : ''), [icon('record'), 'Live'], 'Live record: play along while the pattern runs; notes land on the steps', toggleLiveRec, { pressed: ui.liveRec }),
      tb('sq-quant' + (seq.quant ? ' on' : ''), 'Q', seq.quant ? 'Quantize on: live notes snap to the nearest step' : 'Quantize off: live notes keep their timing (stored as nudge)', () => { edit('Quantize', () => { seq.quant = !seq.quant; }); rerender(); }, { pressed: seq.quant, aria: 'Quantize live recording' }),
      tb('sq-plock' + (ui.plock ? ' on rec' : ''), 'P-Lock', 'Parameter lock: select steps, turn this on, then move any knob of this track\'s devices. The step plays with that value.', () => { ui.plock = !ui.plock; if (ui.plock && !ui.sel.length) toast('Select one or more steps (tap the numbers), then move a knob in the device panel.', 3000); haptic(10); rerender(); api.renderDevices(); }, { pressed: ui.plock }),
      h('span', { class: 'sq-sep' }),
      h('span', { class: 'sq-grp sq-rand' }, ...rand),
      phone ? null : h('span', { class: 'sq-grp' }, out, ...midiBits),
      phone ? null : tb('sq-loop' + (L.on ? ' on' : ''), [icon('loop'), L.on ? L.label : 'Loop'], 'Loop bar: the sequencer follows the transport loop. Click to turn the loop on/off.', () => { api.toggleLoop(); rerender(); }, { pressed: L.on }));
  }
  function slots(t, phone) {
    const seq = t.seq, st = engine.seq.state.get(t.id), q = st && st.queue;
    const n = phone ? 8 : SQ.SEQ_LIMITS.slots;
    const row = h('div', { class: 'sq-slots', role: 'toolbar', 'aria-label': 'Pattern slots' },
      h('span', { class: 'sq-lbl' }, 'Pattern'),
      ...Array.from({ length: n }, (_, i) => h('button', {
        class: 'sq-slot' + (seq.patterns[i] ? ' full' : '') + (i === seq.active ? ' on' : '') + (q && q.slot === i ? ' queued' : ''), 'data-slot': i,
        title: seq.patterns[i] ? `Pattern ${slotName(i)} (${seq.patterns[i].len} steps @ ${seq.patterns[i].rate}). Click to play/edit it.` : `Empty slot ${slotName(i)}: click to make a new pattern (Shift+click: copy the current one)`,
        onclick: (e) => slotClick(t, i, e) }, slotName(i))),
      h('span', { class: 'sq-sep' }),
      h('button', { class: 'sq-mini txt', title: 'Copy this pattern', onclick: () => copyPattern(t) }, 'Copy'),
      h('button', { class: 'sq-mini txt', title: 'Paste into this slot', disabled: !ui.clip, onclick: () => pastePattern(t) }, 'Paste'),
      h('button', { class: 'sq-mini txt', title: 'Clear all steps of this pattern', onclick: () => clearPattern(t) }, 'Clear'),
      phone ? null : h('button', { class: 'sq-mini txt', title: 'Delete this pattern slot', onclick: () => deletePattern(t) }, 'Delete'));
    const chain = h('div', { class: 'sq-chain', 'aria-label': 'Song chain' },
      h('button', { class: 'sq-tb sq-song' + (seq.song ? ' on rec' : ''), 'aria-pressed': String(seq.song), title: 'Song mode: play the chain below in order (with repeats) instead of one pattern', onclick: () => toggleSong(t) }, icon('chain'), 'Song'),
      ...seq.chain.map((c, k) => h('span', { class: 'sq-chip', 'data-k': k },
        h('b', {}, slotName(c.p)), h('button', { class: 'sq-x', 'aria-label': 'Fewer repeats', onclick: () => chainRep(t, k, -1) }, '-'), h('span', { class: 'sq-rep', title: 'Repeats' }, 'x' + c.rep),
        h('button', { class: 'sq-x', 'aria-label': 'More repeats', onclick: () => chainRep(t, k, 1) }, '+'), h('button', { class: 'sq-x', 'aria-label': 'Remove from chain', onclick: () => chainDel(t, k) }, icon('close')))),
      h('button', { class: 'sq-mini txt sq-chadd', title: `Add pattern ${slotName(seq.active)} to the end of the chain`, onclick: () => chainAdd(t) }, '+ Add ' + slotName(seq.active)),
      seq.chain.length ? null : h('span', { class: 'sq-hint' }, 'Chain patterns for a song: A x2, B x1 ...'));
    return h('div', { class: 'sq-slotsbox' }, row, chain);
  }
  function stepCell(t, p, si) {
    const s = p.steps[si], f = LANES.find((x) => x.key === ui.lane);
    const cls = ['sq-step', s.on ? 'on' : '', ui.sel.includes(si) ? 'sel' : '', si % 4 === 0 ? 'beat' : '', ui.stepRec && ui.cursor === si ? 'cursor' : '', s.pl ? 'pl' : '', s.lock ? 'prot' : '', s.prob < 100 ? 'prob' : ''].filter(Boolean).join(' ');
    const flags = [];
    if (s.on && s.prob < 100) flags.push(h('span', { class: 'fp' }, s.prob + '%'));
    if (s.on && s.rat > 1) flags.push(h('span', { class: 'fr' }, 'x' + s.rat));
    if (s.pl) flags.push(h('span', { class: 'fl', title: 'Has parameter locks' }, 'P'));
    const tail = s.on && s.len > 1 ? h('i', { class: 'sq-tail', style: { width: Math.min(s.len - 1, 15) * 100 + '%' } }) : null;
    return h('button', { class: cls, 'data-si': si, 'aria-pressed': String(s.on), 'aria-label': `Step ${si + 1}${s.on ? ', ' + s.n.map((n) => noteLabel(t, n)).join(' ') + ', velocity ' + s.v : ', off'}` },
      h('span', { class: 'sq-num' }, si + 1),
      s.on ? h('span', { class: 'sq-nn' }, noteLabel(t, s.n[0]) + (s.n.length > 1 ? '+' + (s.n.length - 1) : '')) : null,
      s.on ? h('i', { class: 'sq-vel', style: { height: Math.round(s.v / 127 * 100) + '%' } }) : null,
      s.on && s.nudge ? h('i', { class: 'sq-ndg', style: { left: 50 + s.nudge + '%' } }) : null,
      flags.length ? h('span', { class: 'sq-flags' }, ...flags) : null, tail);
  }
  function gridBlock(t) {
    const p = pat(t), np = pages(p), start = ui.page * PS(), end = Math.min(p.len, start + PS());
    const pager = h('div', { class: 'sq-pages', role: 'tablist', 'aria-label': 'Step pages' },
      ...Array.from({ length: np }, (_, k) => h('button', { class: 'sq-page' + (k === ui.page ? ' on' : ''), 'data-page': k, role: 'tab', 'aria-selected': String(k === ui.page), onclick: () => { ui.page = k; haptic(5); refresh(); } }, `${k * PS() + 1}-${Math.min(p.len, (k + 1) * PS())}`)),
      h('label', { class: 'sq-follow', title: 'Follow the playhead to the page it is on' }, h('input', { type: 'checkbox', checked: ui.follow, onchange: (e) => { ui.follow = e.target.checked; } }), 'Follow'),
      h('span', { class: 'sq-info' }, `${p.len} steps @ ${p.rate}` + (t.seq.song ? ' - song' : '')));
    let grid;
    if (isDrum(t)) {
      const used = new Set(); p.steps.slice(0, p.len).forEach((s) => s.on && s.n.forEach((n) => used.add(n)));
      // rows = the 16 pads shown in the drum rack (scroll with the overview strip), plus used pads outside it
      const DRK = api.drumRack, view = DRK ? DRK.rows(t) : PAD_ORDER.slice(0, 8).map((x) => x[0]);
      const rows = view.map((n) => [n, padLabel(t, n)]);
      for (const n of [...used].sort((a, b) => a - b)) if (!view.includes(n)) rows.push([n, padLabel(t, n), true]);
      grid = h('div', { class: 'sq-drums', style: { '--cols': String(end - start) } },
        h('div', { class: 'sq-drow head' }, h('span', { class: 'sq-pad' }, 'Step'), ...Array.from({ length: end - start }, (_, k) => {
          const si = start + k; return h('button', { class: 'sq-dnum' + (ui.sel.includes(si) ? ' sel' : '') + (si % 4 === 0 ? ' beat' : ''), 'data-num': si, title: 'Select step ' + (si + 1) + ' to edit it (Shift: add)', onclick: (e) => selectStep(si, e.ctrlKey || e.metaKey, e.shiftKey) }, si + 1); })),
        ...rows.map(([n, name, out]) => h('div', { class: 'sq-drow' + (out ? ' out' : '') + (t.inst.pads && t.inst.pads[n] ? ' has' : '') }, h('button', { class: 'sq-pad', title: out ? name + ' (outside the pads shown; it has steps in this pattern)' : name, onclick: () => audition(t, n) }, name),
          ...Array.from({ length: end - start }, (_, k) => { const si = start + k, s = p.steps[si], on = s.on && s.n.includes(n);
            return h('button', { class: 'sq-dcell' + (on ? ' on' : '') + (si % 4 === 0 ? ' beat' : '') + (ui.sel.includes(si) ? ' sel' : '') + (s.pl && on ? ' pl' : ''), 'data-si': si, 'data-n': n, 'aria-pressed': String(on), 'aria-label': `${name} step ${si + 1}`, style: on ? { '--v': (s.v / 127).toFixed(2) } : {}, onclick: () => toggleStep(t, si, n) }); }))));
    } else {
      grid = h('div', { class: 'sq-grid', style: { '--cols': String(phoneMode ? 8 : PS()) } }, ...Array.from({ length: end - start }, (_, k) => stepCell(t, p, start + k)));
      let lp = null, moved = false;
      grid.addEventListener('pointerdown', (e) => {
        const b = e.target.closest('.sq-step'); if (!b) return; const si = +b.dataset.si; moved = false;
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.button === 2) { e.preventDefault(); selectStep(si, e.ctrlKey || e.metaKey || e.button === 2, e.shiftKey); lp = 'done'; return; }
        lp = setTimeout(() => { lp = 'done'; selectStep(si, false, false); haptic(20); }, 450);
      });
      grid.addEventListener('pointerup', (e) => {
        const b = e.target.closest('.sq-step'); if (lp === 'done') { lp = null; return; } clearTimeout(lp); lp = null; if (!b || moved) return;
        if (e.target.closest('.sq-num')) return selectStep(+b.dataset.si, false, false);
        toggleStep(t, +b.dataset.si);
      });
      grid.addEventListener('pointerleave', () => { if (lp && lp !== 'done') { clearTimeout(lp); lp = null; } });
      grid.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    if (isDrum(t) && api.drumRack) grid = h('div', { class: 'sq-drumwrap' }, api.drumRack.overview(t, 'seq'), grid);
    return h('div', { class: 'sq-gridwrap' + (phoneMode ? ' ph-noswipe' : '') }, pager, grid, lane(t, start, end));
  }
  function lane(t, start, end) {
    const p = pat(t), f = LANES.find((x) => x.key === ui.lane) || LANES[0];
    const tabs = h('div', { class: 'sq-lanetabs', role: 'tablist', 'aria-label': 'Step value lane' }, ...LANES.map((x) => h('button', { class: 'sq-lt' + (x.key === f.key ? ' on' : ''), role: 'tab', 'aria-selected': String(x.key === f.key), title: x.help, onclick: () => { ui.lane = x.key; refresh(); } }, phoneMode ? x.short : x.label)));
    const norm = (v) => (v - f.min) / (f.max - f.min);
    const barStyle = (v) => (f.key === 'nudge' ? { bottom: Math.min(50, norm(v) * 100) + '%', height: Math.abs(norm(v) - 0.5) * 100 + '%' } : { height: Math.max(3, norm(v) * 100) + '%' });
    const bars = h('div', { class: 'sq-lane' + (f.key === 'nudge' ? ' bi' : ''), style: { '--cols': String(isDrum(t) ? end - start : phoneMode ? 8 : PS()) }, title: f.help + ' Drag across the bars to draw.' },
      ...Array.from({ length: end - start }, (_, k) => { const si = start + k, s = p.steps[si], v = s[f.key];
        return h('div', { class: 'sq-bar' + (s.on ? ' on' : ''), 'data-si': si, title: `Step ${si + 1}: ${fmtField(f, v)}` }, h('i', { style: barStyle(v) }), h('span', {}, fmtField(f, v))); }));
    let drag = null;
    const apply = (e) => {
      const r = bars.getBoundingClientRect(), n = end - start, cols = isDrum(t) ? n : phoneMode ? 8 : PS(), rows = Math.ceil(n / cols), rowH = r.height / rows;
      const col = Math.floor((e.clientX - r.left) / (r.width / cols)), row = Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - r.top) / rowH)));
      const k = row * cols + col; if (col < 0 || col >= cols || k < 0 || k >= n) return;
      const y = 1 - Math.max(0, Math.min(1, (e.clientY - r.top - row * rowH) / rowH));
      const si = start + k, v = f.min + y * (f.max - f.min);
      edit('Draw ' + f.label.toLowerCase(), () => SQ.setField(p.steps[si], f.key, v), drag);
      const bar = bars.children[k], s = p.steps[si], nv = s[f.key];
      Object.assign(bar.firstChild.style, { bottom: '', height: '' }, barStyle(nv));
      bar.lastChild.textContent = fmtField(f, nv);
    };
    bars.addEventListener('pointerdown', (e) => { drag = 'seqlane:' + t.id + ':' + Date.now(); try { bars.setPointerCapture(e.pointerId); } catch (x) {} apply(e); haptic(5); });
    bars.addEventListener('pointermove', (e) => { if (drag) apply(e); });
    const end_ = () => { if (!drag) return; drag = null; refreshGrid(); renderInspector(); };
    bars.addEventListener('pointerup', end_); bars.addEventListener('pointercancel', end_);
    return h('div', { class: 'sq-lanebox' }, tabs, bars);
  }
  function keys(t, phone) {
    const base = ui.oct * 12 + 12, white = [0, 2, 4, 5, 7, 9, 11, 12], black = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
    if (isDrum(t)) return h('div', { class: 'sq-keys drum' }, h('span', { class: 'sq-lbl' }, ui.stepRec ? 'Step record: tap a pad' : 'Pads'),
      ...(api.drumRack ? api.drumRack.rows(t).map((n) => [n, padLabel(t, n)]) : PAD_ORDER.slice(0, 8)).map(([n, name]) => h('button', { class: 'sq-key pad' + (t.inst.pads && t.inst.pads[n] ? ' has' : ''), 'data-note': n, onclick: (e) => setNotes(t, n, e.shiftKey) }, name)),
      ui.stepRec ? [h('button', { class: 'sq-mini txt', onclick: () => stepRest(t, false) }, 'Rest')] : []);
    return h('div', { class: 'sq-keys' },
      h('span', { class: 'sq-lbl' }, ui.stepRec ? 'Step record' : ui.sel.length ? 'Set note' : 'Keys'),
      h('button', { class: 'sq-mini', 'aria-label': 'Octave down', onclick: () => { ui.oct = Math.max(0, ui.oct - 1); refresh(); } }, '-'),
      h('span', { class: 'sq-oct' }, 'C' + ui.oct),
      h('button', { class: 'sq-mini', 'aria-label': 'Octave up', onclick: () => { ui.oct = Math.min(8, ui.oct + 1); refresh(); } }, '+'),
      h('div', { class: 'sq-kb' }, ...white.map((iv) => h('button', { class: 'sq-key w', 'data-note': base + iv, 'aria-label': noteName(base + iv), onclick: (e) => setNotes(t, base + iv, e.shiftKey) }, iv === 0 || iv === 12 ? noteName(base + iv) : '')),
        ...Object.entries(black).map(([iv, after]) => h('button', { class: 'sq-key b', 'data-note': base + +iv, 'aria-label': noteName(base + +iv), style: { left: `calc(${(after + 1) * (100 / 8)}% - ${phoneMode ? 10 : 7}px)` }, onclick: (e) => setNotes(t, base + +iv, e.shiftKey) }))),
      ui.stepRec ? [h('button', { class: 'sq-mini txt', title: 'Skip a step', onclick: () => stepRest(t, false) }, 'Rest'), h('button', { class: 'sq-mini txt', title: 'Make the previous note one step longer', onclick: () => stepRest(t, true) }, 'Tie')] : [],
      ui.sel.length ? [h('button', { class: 'sq-mini txt', title: 'Transpose the selected steps down a semitone', onclick: () => transposeSel(t, -1) }, '-1'), h('button', { class: 'sq-mini txt', title: 'Transpose the selected steps up a semitone', onclick: () => transposeSel(t, 1) }, '+1')] : []);
  }
  function slider(label, f, v, onv, help) {
    const val = h('span', { class: 'sq-val' }, fmtField(f, v));
    const r = h('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: v, 'aria-label': label, title: help || f.help, oninput: (e) => { onv(+e.target.value); val.textContent = fmtField(f, +e.target.value); } });
    return h('label', { class: 'sq-sl' }, h('span', { class: 'sq-sll' }, label), r, val);
  }
  function inspector(t) {
    const p = pat(t);
    if (!ui.sel.length) return h('div', { class: 'sq-insp empty' },
      h('div', { class: 'sq-ih' }, 'Step'),
      h('p', { class: 'sq-hint' }, phoneMode ? 'Tap a step to turn it on. Press and hold a step to edit its note, volume, chance, repeats and locks.' : 'Tap a step to turn it on. Click a step number (or hold a step) to edit it: note, velocity, length, gate, chance, repeats, nudge and parameter locks. Shift+click selects a range.'));
    const s = p.steps[ui.sel[0]]; const many = ui.sel.length > 1;
    const coalesce = (k) => `seqf:${t.id}:${k}:${ui.sel.join(',')}`;
    const rows = LANES.map((f) => slider(f.label, f, s[f.key], (v) => { setStepField(t, f.key, v, coalesce(f.key)); refreshGrid(); }));
    const cat = api.paramCatalog(t);
    const plocks = Object.entries(s.pl || {}).map(([k, v]) => {
      const e = cat.find((x) => SQ.lockKey(x.fx, x.key) === k); const lbl = e ? e.label : k;
      const ctl = e && e.type === 'select' ? h('select', { 'aria-label': 'Locked value for ' + lbl, onchange: (ev) => addPlock(t, e, ev.target.value) }, e.options.map((o) => h('option', { value: o, selected: o === v }, o)))
        : e ? h('input', { type: 'range', min: e.min, max: e.max, value: v, step: 'any', 'aria-label': 'Locked value for ' + lbl, oninput: (ev) => { addPlock(t, e, +ev.target.value); vv.textContent = e.fmt(+ev.target.value); } }) : h('span', { class: 'dim' }, 'device missing');
      const vv = h('span', { class: 'sq-val' }, e ? e.fmt(v) : String(v));
      return h('div', { class: 'sq-plrow' }, h('span', { class: 'sq-pll', title: lbl }, lbl), ctl, e && e.type !== 'select' ? vv : null, h('button', { class: 'sq-x', 'aria-label': 'Remove lock ' + lbl, onclick: () => delPlock(t, k) }, icon('close')));
    });
    const add = h('select', { class: 'sq-pladd', 'aria-label': 'Add a parameter lock', onchange: (e) => { const x = cat[+e.target.value]; if (x) { addPlock(t, x, x.value); rerender(); } } },
      h('option', { value: '' }, cat.length ? '+ Lock a parameter...' : 'No lockable parameters'), ...cat.map((x, i) => h('option', { value: i }, x.label)));
    const prot = ui.sel.every((si) => p.steps[si] && p.steps[si].lock);
    return h('div', { class: 'sq-insp' },
      h('div', { class: 'sq-ih' }, many ? `${ui.sel.length} steps` : `Step ${ui.sel[0] + 1}`, h('span', { class: 'sq-notes' }, s.on ? s.n.map((n) => noteLabel(t, n)).join(' ') : 'off'),
        h('button', { class: 'sq-mini txt' + (s.on ? ' on' : ''), title: 'Turn the selected steps on/off', onclick: () => { edit('Step on/off', () => { const on = !s.on; for (const si of ui.sel) p.steps[si].on = on; }); refresh(); } }, s.on ? 'On' : 'Off'),
        h('button', { class: 'sq-mini txt' + (prot ? ' on' : ''), 'aria-pressed': String(prot), title: 'Protect: the randomizer never changes protected steps', onclick: () => toggleLock(t) }, icon(prot ? 'lock' : 'unlock')),
        h('button', { class: 'sq-mini', 'aria-label': 'Close step editor', onclick: () => { ui.sel = []; refresh(); } }, icon('close'))),
      h('div', { class: 'sq-sls' }, ...rows),
      h('div', { class: 'sq-ih sub' }, 'Parameter locks', h('span', { class: 'sq-hint' }, ui.plock ? 'P-Lock on: move a knob' : '')),
      ...plocks, add);
  }

  // ---------------------------------------------------------------- playhead (called every animation frame)
  let lastSi = new Map();
  function frame() {
    if (!S.project) return;
    const visible = onPhone() || (S.view === 'seq' && host && !host.hidden && !(api.phoneActive && api.phoneActive()));
    if (!visible) return;
    const r = root();
    for (const t of midiTracks()) {
      if (!t.seq) continue;
      const ph = engine.seq.playheadOf(t), bar = $(`[data-seqbar="${t.id}"]`, r);
      const p = ph && t.seq.patterns[ph.pi];
      if (bar) bar.style.width = ph && p ? ((ph.si + 1) / p.len * 100).toFixed(1) + '%' : '0%';
      if (t.id !== S.selected) continue;
      const key = ph ? ph.pi + ':' + ph.si : '';
      if (lastSi.get(t.id) === key) continue; lastSi.set(t.id, key);
      if (ph && ph.pi !== t.seq.active && !t.seq.song) { rerender(); return; }
      if (ph && t.seq.song && ph.pi !== t.seq.active) { t.seq.active = ph.pi; rerender(); return; }
      $$('.sq-step.play, .sq-dcell.play, .sq-dnum.play, .sq-bar.play', r).forEach((e) => e.classList.remove('play'));
      $$('.sq-slot.playing', r).forEach((e) => e.classList.remove('playing'));
      $$('.sq-chip.playing', r).forEach((e) => e.classList.remove('playing'));
      if (!ph) continue;
      if (ui.follow && ph.pi === t.seq.active && Math.floor(ph.si / PS()) !== ui.page) { ui.page = Math.floor(ph.si / PS()); rerender(); return; }
      $$(`.sq-step[data-si="${ph.si}"], .sq-dcell[data-si="${ph.si}"], .sq-dnum[data-num="${ph.si}"], .sq-bar[data-si="${ph.si}"]`, r).forEach((e) => e.classList.add('play'));
      const sl = $(`.sq-slot[data-slot="${ph.pi}"]`, r); if (sl) sl.classList.add('playing');
      if (ph.entry >= 0) { const c = $(`.sq-chip[data-k="${ph.entry}"]`, r); if (c) c.classList.add('playing'); }
    }
  }
  function phoneScreen() { phoneMode = true; return build(true); }
  return { mount, render: rerender, frame, onNote, capture, target, phoneScreen, enable, ui, leavePhone: () => { phoneMode = false; }, get phoneMode() { return phoneMode; } };
}
