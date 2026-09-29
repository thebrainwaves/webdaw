// Auduio step sequencer (inspired by the Squarp Pyramid / Hapax workflow).
// Every MIDI track can carry `t.seq`: up to 16 pattern slots (A-P), each with its own length (1-128 steps)
// and step rate, so tracks run polymetric / polyrhythmic against each other. Steps hold notes, velocity,
// length, gate, probability, ratchets, micro-timing and parameter locks (p-locks) for any device parameter.
// A chain (song mode) plays slots in order with repeats.
//
// The first half of this file is pure (data model, validation, timing plan, randomizer, recording helpers)
// so it runs under Node for the unit tests. `SeqRuntime` plugs it into the audio engine's look-ahead scheduler.

export const RATES = [
  ['1/1', 4], ['1/2', 2], ['1/4', 1], ['1/4t', 2 / 3], ['1/8d', 0.75], ['1/8', 0.5], ['1/8t', 1 / 3],
  ['1/16d', 0.375], ['1/16', 0.25], ['1/16t', 1 / 6], ['1/32', 0.125], ['1/32t', 1 / 12],
];
export const RATE_BEATS = Object.fromEntries(RATES);
export const SEQ_LIMITS = { steps: 128, slots: 16, chain: 64, repeats: 64, notes: 8, locks: 16 };
export const SLOT_NAMES = 'ABCDEFGHIJKLMNOP'.split('');
export const LENGTHS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
// Per-step values the user edits (lanes). `field` is also the randomizer lock key.
export const STEP_FIELDS = [
  { key: 'v', field: 'vel', label: 'Velocity', short: 'Vel', min: 1, max: 127, def: 100, step: 1, help: 'How hard the note is played (1-127).' },
  { key: 'len', field: 'len', label: 'Length', short: 'Len', min: 0.25, max: 16, def: 1, step: 0.25, unit: 'st', help: 'Note length in steps. 4 = the note lasts four steps.' },
  { key: 'gate', field: 'gate', label: 'Gate', short: 'Gate', min: 1, max: 100, def: 80, step: 1, unit: '%', help: 'How much of the length the note is held: short = staccato, 100 = legato.' },
  { key: 'prob', field: 'prob', label: 'Chance', short: 'Prob', min: 0, max: 100, def: 100, step: 1, unit: '%', help: 'Probability: the chance that this step plays each time round.' },
  { key: 'rat', field: 'rat', label: 'Repeat', short: 'Rpt', min: 1, max: 8, def: 1, step: 1, unit: 'x', help: 'Ratchet: plays the step 2-8 times quickly inside its own time.' },
  { key: 'nudge', field: 'nudge', label: 'Nudge', short: 'Nudge', min: -50, max: 50, def: 0, step: 1, unit: '%', help: 'Micro-timing: moves the step earlier (-) or later (+), in % of a step.' },
];
export const RAND_FIELDS = [
  { key: 'on', label: 'Steps on/off', min: 0, max: 1, def: 0 }, { key: 'note', label: 'Notes', min: 0, max: 127, def: 60 },
  ...STEP_FIELDS.map((f) => ({ key: f.field, label: f.label, min: f.min, max: f.max, def: f.def })),
];
const FIELD_OF = Object.fromEntries(STEP_FIELDS.map((f) => [f.key, f]));

const num = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def);
const int = (v, lo, hi, def) => Math.round(num(v, lo, hi, def));
const mod = (a, n) => ((a % n) + n) % n;
const LOCK_KEY_RE = /^(inst|\d{1,2}|plugin:[\w-]{1,40})\|[\w.-]{1,32}$/;

export function newStep(note = 60, on = false) {
  return { on, n: [note], v: 100, len: 1, gate: 80, prob: 100, rat: 1, nudge: 0 };
}
export function newPattern(len = 16, rate = '1/16', note = 60) {
  return { name: '', len, rate, swing: 0, steps: Array.from({ length: Math.max(16, len) }, () => newStep(note)) };
}
export function newSeq(note = 60) {
  return { on: true, active: 0, song: false, chain: [], patterns: [newPattern(16, '1/16', note)], out: 'track', port: '', ch: 1, quant: true, locks: [] };
}
// lock key <-> target: fx is 'inst', an audio-effect index, or 'plugin:<entry id>'
export const lockKey = (fx, key) => `${fx}|${key}`;
export function parseLockKey(k) {
  const i = k.lastIndexOf('|'); if (i < 0) return null;
  const a = k.slice(0, i), key = k.slice(i + 1);
  return { fx: a === 'inst' || a.startsWith('plugin:') ? a : +a, key };
}

// Strict sanitizer (import validation + stored projects). Returns a fresh whitelisted object, or null.
export function sanitizeStep(s, defNote = 60) {
  s = s && typeof s === 'object' ? s : {};
  const notes = (Array.isArray(s.n) ? s.n : [s.n]).filter((x) => typeof x === 'number' && isFinite(x)).slice(0, SEQ_LIMITS.notes).map((x) => int(x, 0, 127, defNote));
  const out = { on: s.on === true, n: notes.length ? [...new Set(notes)] : [defNote], v: int(s.v, 1, 127, 100), len: num(s.len, 0.25, 16, 1), gate: int(s.gate, 1, 100, 80),
    prob: int(s.prob, 0, 100, 100), rat: int(s.rat, 1, 8, 1), nudge: int(s.nudge, -50, 50, 0) };
  if (s.lock === true) out.lock = true;
  if (s.pl && typeof s.pl === 'object' && !Array.isArray(s.pl)) {
    const pl = {}; let k = 0;
    for (const [key, v] of Object.entries(s.pl)) {
      if (k >= SEQ_LIMITS.locks || !LOCK_KEY_RE.test(key)) continue;
      if (typeof v === 'number' && isFinite(v)) { pl[key] = Math.max(-1e6, Math.min(1e6, v)); k++; }
      else if (typeof v === 'string' && v.length <= 32 && /^[\w .#/+-]*$/.test(v)) { pl[key] = v; k++; }
    }
    if (k) out.pl = pl;
  }
  return out;
}
export function sanitizePattern(p) {
  if (!p || typeof p !== 'object') return null;
  const len = int(p.len, 1, SEQ_LIMITS.steps, 16);
  const raw = Array.isArray(p.steps) ? p.steps.slice(0, SEQ_LIMITS.steps) : [];
  const steps = raw.map((s) => sanitizeStep(s));
  while (steps.length < len) steps.push(newStep());
  return { name: typeof p.name === 'string' ? p.name.slice(0, 24).replace(/[\u0000-\u001f]/g, '') : '', len,
    rate: RATE_BEATS[p.rate] ? p.rate : '1/16', swing: int(p.swing, 0, 75, 0), steps };
}
export function sanitizeSeq(s) {
  if (!s || typeof s !== 'object') return null;
  const pats = Array.isArray(s.patterns) ? s.patterns.slice(0, SEQ_LIMITS.slots) : [];
  const patterns = pats.map(sanitizePattern);
  if (!patterns.some(Boolean)) patterns[0] = newPattern();
  const chain = (Array.isArray(s.chain) ? s.chain.slice(0, SEQ_LIMITS.chain) : [])
    .filter((c) => c && typeof c === 'object').map((c) => ({ p: int(c.p, 0, SEQ_LIMITS.slots - 1, 0), rep: int(c.rep, 1, SEQ_LIMITS.repeats, 1) }))
    .filter((c) => patterns[c.p]);
  const active = int(s.active, 0, SEQ_LIMITS.slots - 1, 0);
  const port = typeof s.port === 'string' ? s.port.slice(0, 128).replace(/[\u0000-\u001f]/g, '') : '';
  const locks = Array.isArray(s.locks) ? s.locks.filter((k) => RAND_FIELDS.some((f) => f.key === k)) : [];
  return { on: s.on !== false, active: patterns[active] ? active : patterns.findIndex(Boolean), song: s.song === true && chain.length > 0, chain, patterns,
    out: ['track', 'midi', 'both'].includes(s.out) ? s.out : 'track', port, ch: int(s.ch, 1, 16, 1), quant: s.quant !== false, locks: [...new Set(locks)] };
}

// ------------------------------------------------------------------ timing
export const stepBeats = (pat) => RATE_BEATS[pat && pat.rate] || 0.25;
export function chainTotal(seq) {
  let T = 0; for (const c of seq.chain || []) { const p = seq.patterns[c.p]; if (p) T += c.rep * p.len * stepBeats(p); } return T;
}
function emitRange(out, seq, pi, anchor, from, to, entry) {
  const pat = seq.patterns[pi]; if (!pat) return;
  const sb = stepBeats(pat), len = pat.len;
  let k = Math.ceil((from - anchor) / sb - 1e-9), guard = 0;
  for (; anchor + k * sb < to - 1e-9 && guard++ < 4096; k++) out.push({ beat: anchor + k * sb, pi, si: mod(k, len), k, sb, entry });
}
// Steps whose nominal time falls in beats [b0, b1). Beats count from the song start (grid origin).
// st: { anchor (beat where the active pattern started), queue: { slot, at } (pending slot switch) }
export function planSteps(seq, b0, b1, st = {}) {
  const out = [];
  if (!seq || !seq.patterns || b1 <= b0) return out;
  const T = seq.song ? chainTotal(seq) : 0;
  if (seq.song && T > 0) {
    const ch = seq.chain; let cyc = Math.floor(b0 / T), m = b0 - cyc * T, e = 0, s = 0;
    for (; e < ch.length; e++) { const p = seq.patterns[ch[e].p], d = p ? ch[e].rep * p.len * stepBeats(p) : 0; if (m < s + d - 1e-9) break; s += d; }
    if (e >= ch.length) { e = 0; s = 0; cyc++; }
    let from = b0, start = cyc * T + s, guard = 0;
    while (from < b1 - 1e-9 && guard++ < 512) {
      const c = ch[e], p = seq.patterns[c.p], d = p ? c.rep * p.len * stepBeats(p) : 0, end = start + d;
      if (d > 0) emitRange(out, seq, c.p, start, from, Math.min(b1, end), e);
      from = Math.max(from, end); start = end; e++; if (e >= ch.length) e = 0;
    }
    return out;
  }
  const q = st.queue, anchor = st.anchor || 0;
  if (q && seq.patterns[q.slot] && q.at < b1) {
    if (q.at > b0) emitRange(out, seq, seq.active, anchor, b0, q.at);
    emitRange(out, seq, q.slot, q.at, Math.max(b0, q.at), b1);
  } else emitRange(out, seq, seq.active, anchor, b0, b1);
  return out;
}
// where a pattern switch lands: the end of the current pattern cycle (Hapax/Pyramid style)
export function nextCycle(seq, b, anchor = 0) {
  const p = seq.patterns[seq.active]; if (!p) return b;
  const L = p.len * stepBeats(p), k = Math.ceil((b - anchor) / L - 1e-9);
  return anchor + k * L;
}
// Which step is playing at beat b (for the playhead). Returns { pi, si, entry, rep } or null.
export function stepAtBeat(seq, b, st = {}) {
  if (!seq) return null;
  const T = seq.song ? chainTotal(seq) : 0;
  if (seq.song && T > 0) {
    let m = mod(b, T), s = 0;
    for (let e = 0; e < seq.chain.length; e++) {
      const c = seq.chain[e], p = seq.patterns[c.p]; if (!p) continue;
      const cl = p.len * stepBeats(p), d = c.rep * cl;
      if (m < s + d - 1e-9) { const x = m - s; return { pi: c.p, si: Math.floor(x / stepBeats(p) + 1e-9) % p.len, entry: e, rep: Math.floor(x / cl + 1e-9) }; }
      s += d;
    }
    return null;
  }
  const q = st.queue, useQ = q && b >= q.at && seq.patterns[q.slot];
  const pi = useQ ? q.slot : seq.active, p = seq.patterns[pi]; if (!p) return null;
  const a = useQ ? q.at : st.anchor || 0;
  return { pi, si: mod(Math.floor((b - a) / stepBeats(p) + 1e-9), p.len), entry: -1, rep: 0 };
}
// Notes one step produces: [{ dt (s from the nominal step time), n, v, dur (s) }]. [] when it does not play.
export function expandStep(step, pat, si, bd, rng = Math.random) {
  if (!step || !step.on || !step.n || !step.n.length) return [];
  if (step.prob < 100 && rng() * 100 >= step.prob) return [];
  const sd = stepBeats(pat) * bd;
  const swing = si % 2 === 1 ? (pat.swing || 0) / 100 * sd * 0.5 : 0;
  const off = (step.nudge || 0) / 100 * sd + swing;
  const r = Math.max(1, step.rat | 0), full = step.len * sd * step.gate / 100;
  const out = [];
  for (let i = 0; i < r; i++) {
    const dur = r > 1 ? Math.max(0.005, Math.min(full, sd / r * Math.min(1, step.gate / 100 + 0.1))) : Math.max(0.005, full);
    for (const n of step.n) out.push({ dt: off + i * sd / r, n, v: step.v, dur });
  }
  return out;
}

// ------------------------------------------------------------------ editing helpers (pure)
export function setPatternLength(pat, len) {
  len = int(len, 1, SEQ_LIMITS.steps, 16);
  const note = (pat.steps[0] && pat.steps[0].n[0]) || 60;
  while (pat.steps.length < len) pat.steps.push(newStep(note)); // data beyond the length is kept (like the hardware)
  pat.len = len; return pat;
}
export function toggleNote(step, note) {
  const has = step.n.includes(note);
  if (!step.on) { step.on = true; if (!has) step.n = [note]; return true; }
  if (has) { step.n = step.n.filter((x) => x !== note); if (!step.n.length) { step.n = [note]; step.on = false; } return step.on; }
  if (step.n.length < SEQ_LIMITS.notes) step.n.push(note); return true;
}
export function setField(step, key, v) {
  const f = FIELD_OF[key]; if (!f) return;
  step[key] = Math.max(f.min, Math.min(f.max, f.step >= 1 ? Math.round(v) : Math.round(v / f.step) * f.step));
}
// Live recording: where a note played at beat b lands. quant=true snaps to the nearest step (nudge 0);
// otherwise the nearest step keeps the offset as micro-timing.
export function recordPosition(pat, b, anchor = 0, quant = true) {
  const sb = stepBeats(pat), x = (b - anchor) / sb, k = Math.round(x);
  return { si: mod(k, pat.len), nudge: quant ? 0 : Math.max(-50, Math.min(50, Math.round((x - k) * 100))) };
}
export function recordNote(pat, si, note, vel, opts = {}) {
  const s = pat.steps[si] || (pat.steps[si] = newStep(note));
  if (!s.on || opts.replace) { s.on = true; s.n = [note]; s.nudge = opts.nudge || 0; }
  else if (!s.n.includes(note) && s.n.length < SEQ_LIMITS.notes) s.n.push(note);
  s.v = int(vel, 1, 127, 100);
  if (opts.len != null) s.len = Math.max(0.25, Math.min(16, Math.round(opts.len * 4) / 4));
  return s;
}

// ------------------------------------------------------------------ randomizer
// Randomizes the pattern's steps inside its length. Never touches steps with `lock`, fields listed in
// seq.locks, or p-locks. amount 0..1. pool: allowed notes (scale or drum pads). Returns a new steps array.
export function randomizeSteps(seq, pat, { amount = 0.5, mode = 'musical', pool = null, rng = Math.random } = {}) {
  const L = new Set(seq.locks || []), steps = pat.steps.map((s) => ({ ...s, n: [...s.n], ...(s.pl ? { pl: { ...s.pl } } : {}) }));
  const notes = pool && pool.length ? pool : [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72];
  const chaos = mode === 'chaos', pick = (a) => a[Math.floor(rng() * a.length)];
  const mix = (cur, rnd) => cur + (rnd - cur) * amount;
  for (let i = 0; i < pat.len; i++) {
    const s = steps[i]; if (!s || s.lock) continue;
    if (!L.has('on') && rng() < amount) s.on = rng() < (chaos ? 0.5 : i % 4 === 0 ? 0.75 : 0.4);
    if (!L.has('note') && rng() < amount) s.n = [pick(notes)];
    if (!L.has('vel')) s.v = Math.round(Math.max(1, Math.min(127, mix(s.v, chaos ? 1 + rng() * 126 : 70 + rng() * 57))));
    if (!L.has('gate')) s.gate = Math.round(Math.max(1, Math.min(100, mix(s.gate, chaos ? 1 + rng() * 99 : 30 + rng() * 70))));
    if (!L.has('len') && rng() < amount * (chaos ? 1 : 0.25)) s.len = pick(chaos ? LENGTHS : [0.5, 1, 1, 2]);
    if (!L.has('prob') && rng() < amount * (chaos ? 1 : 0.3)) s.prob = chaos ? Math.round(rng() * 100) : pick([100, 100, 75, 50]);
    if (!L.has('rat') && rng() < amount * (chaos ? 1 : 0.15)) s.rat = chaos ? 1 + Math.floor(rng() * 8) : pick([1, 2, 2, 3]);
    if (!L.has('nudge') && rng() < amount * (chaos ? 1 : 0.3)) s.nudge = Math.round((rng() * 2 - 1) * (chaos ? 50 : 12));
  }
  return steps;
}

// Pattern text for screen readers / tests: "x..x x..." (x = on)
export const patternString = (pat) => pat.steps.slice(0, pat.len).map((s) => (s.on ? 'x' : '.')).join('');

// ------------------------------------------------------------------ runtime (browser)
// Called from Engine.scheduleMidi for every loop-aware segment of the look-ahead window.
export class SeqRuntime {
  constructor(engine) {
    this.engine = engine; this.state = new Map(); this.rng = Math.random; this.midiOut = null;
    this.lockTokens = new Map(); this.onStep = null; this.onSwitch = null;
  }
  st(tid) { let s = this.state.get(tid); if (!s) { s = { anchor: 0, queue: null, fired: [] }; this.state.set(tid, s); } return s; }
  reset() { for (const s of this.state.values()) { if (s.queue) this.commitQueue(s); s.anchor = 0; } }
  // switch the playing slot at the end of the current cycle (stopped: at once)
  queueSlot(t, slot) {
    const seq = t.seq, E = this.engine; if (!seq || !seq.patterns[slot]) return false;
    const s = this.st(t.id);
    if (!E.playing) { seq.active = slot; s.anchor = 0; s.queue = null; return true; }
    const b = this.beatAt(E.position());
    if (s.queue && b >= s.queue.at) this.commitQueue(s);
    s.queue = { slot, at: nextCycle(seq, b, s.anchor), tid: t.id };
    return false;
  }
  commitQueue(s) {
    const q = s.queue; s.queue = null; if (!q) return;
    const t = (this.engine.project.tracks || []).find((x) => x.id === q.tid); if (t && t.seq && t.seq.patterns[q.slot]) t.seq.active = q.slot;
    s.anchor = q.at; if (this.onSwitch) this.onSwitch(q.tid, q.slot); }
  beatAt(pos) { const E = this.engine; return (pos - E.gridOffset) / E.beatDur; }
  playheadOf(t) {
    const E = this.engine; if (!t.seq || !E.playing) return null;
    const pos = E.ctx && E.ctx.currentTime < E.startCtxTime ? E.startPos : E.position(); // pre-roll: show the start step
    const s = this.st(t.id), b = this.beatAt(pos);
    if (s.queue && b >= s.queue.at - 1e-6 && !t.seq.song) this.commitQueue(s);
    return stepAtBeat(t.seq, b, s);
  }
  schedule(t, n, sg, p1) {
    const seq = t.seq, E = this.engine, bd = E.beatDur, o = E.gridOffset;
    const s = this.st(t.id), b0 = (sg.p0 - o) / bd, b1 = (p1 - o) / bd;
    const now = E.ctx.currentTime;
    if (s.queue && b0 >= s.queue.at - 1e-9) this.commitQueue(s);
    for (const ev of planSteps(seq, b0, b1, s)) {
      const pat = seq.patterns[ev.pi], step = pat.steps[ev.si];
      const hits = expandStep(step, pat, ev.si, bd, this.rng); if (!hits.length) continue;
      const c = sg.c0 + (o + ev.beat * bd - sg.p0);
      const sd = ev.sb * bd, first = Math.max(now, c + hits[0].dt);
      if (step.pl) this.applyLocks(t, n, step.pl, first, step.len * sd, () => this.fire(t, n, hits, c, now));
      else this.fire(t, n, hits, c, now);
      if (this.onStep) this.onStep(t.id, ev, first);
    }
  }
  fire(t, n, hits, c, now) {
    const seq = t.seq, toTrack = seq.out !== 'midi', toMidi = seq.out !== 'track' && this.midiOut;
    for (const h of hits) {
      const at = Math.max(now, c + h.dt);
      if (toTrack) (n.midi || n.inst).playNote(h.n, h.v, at, h.dur);
      if (toMidi) this.midiOut.note(seq.port, seq.ch, h.n, h.v, at, h.dur);
    }
  }
  // p-locks: instrument values are swapped in while the step's voices are created (the built-in synths
  // read their values per voice); audio-effect and plugin parameters are set at the step time and
  // go back to the track's own value when the step ends. The project data is never changed.
  applyLocks(t, n, pl, at, dur, play) {
    const E = this.engine, saved = [];
    for (const [k, v] of Object.entries(pl)) {
      const L = parseLockKey(k); if (!L) continue;
      if (L.fx === 'inst') { if (n.inst && n.inst.values && L.key in n.inst.values) { saved.push([L.key, n.inst.values[L.key]]); n.inst.values[L.key] = v; } }
      else if (typeof L.fx === 'number') this.lockFx(t, n, L, v, at, dur);
      else if (E.pluginLock) E.pluginLock(t, L.fx.slice(7), +L.key, v, at, dur);
    }
    try { play(); } finally { for (const [k, v] of saved) n.inst.values[k] = v; }
  }
  lockFx(t, n, L, v, at, dur) {
    const f = n.fx && n.fx[L.fx]; if (!f || !f.apply || !(L.key in f.values)) return;
    const E = this.engine, id = `${t.id}|${L.fx}|${L.key}`, tok = {};
    const ms = (x) => Math.max(0, (x - E.ctx.currentTime) * 1000);
    setTimeout(() => { this.lockTokens.set(id, tok); try { f.apply(L.key, v, false); } catch (e) {} }, ms(at));
    setTimeout(() => { if (this.lockTokens.get(id) !== tok) return; this.lockTokens.delete(id); try { f.apply(L.key, f.values[L.key], false); } catch (e) {} }, ms(at + Math.max(0.02, dur)));
  }
}
