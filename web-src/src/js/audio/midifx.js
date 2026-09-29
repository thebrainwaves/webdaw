// Native MIDI effects. They sit in front of a MIDI track's instrument and transform notes from clips,
// the piano roll preview and live input (MIDI keyboard / on-screen keys). Recording always stores the
// notes as played (before MIDI effects), like other DAWs.
//
// Event model: { note, vel, t, dur }  t = AudioContext time; dur = seconds, or null for a live note that
// ends with noteOff. Each effect maps one event to zero or more events; the arpeggiator is stateful
// (collects held notes and emits steps from tick()).
import { SCALES, NOTE_NAMES } from './pitchdsp.js';

const RATE_BEATS = { '1/4': 1, '1/8': 0.5, '1/8t': 1 / 3, '1/16': 0.25, '1/16t': 1 / 6, '1/32': 0.125 };
const LEN_BEATS = { '1/32': 0.125, '1/16': 0.25, '1/8': 0.5, '1/4': 1, '1/2': 2, '1 bar': 4 };
const CHORDS = {
  major: [0, 4, 7], minor: [0, 3, 7], sus2: [0, 2, 7], sus4: [0, 5, 7], power: [0, 7, 12], octave: [0, 12],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dom7: [0, 4, 7, 10], add9: [0, 4, 7, 14], min9: [0, 3, 7, 10, 14], dim: [0, 3, 6],
};
const clampNote = (n) => Math.max(0, Math.min(127, Math.round(n)));
const clampVel = (v) => Math.max(1, Math.min(127, Math.round(v)));

// snap a MIDI note to the nearest note of a scale (ties go down)
export function snapToScale(note, root, scale) {
  const iv = SCALES[scale] || SCALES.major; let best = note, bd = 99;
  for (let d = 0; d <= 6; d++) for (const s of [-1, 1]) { const n = note + d * s; if (iv.includes((((n - root) % 12) + 12) % 12) && d < bd) { best = n; bd = d; } }
  return best;
}

class MidiEffect {
  constructor(engine, track, def) { this.engine = engine; this.track = track; this.def = def; }
  get values() { return this.def.values; }
  get enabled() { return this.def.enabled !== false; }
  key() { const v = this.values; if (v.keySource === 'manual') return { root: NOTE_NAMES.indexOf(v.root), scale: v.scale }; const k = this.engine.project.key || { root: 0, scale: 'major' }; return { root: k.root, scale: k.scale }; }
  process(ev, emit) { emit(ev); }
  tick() {}
  reset() {}
}

class Chord extends MidiEffect {
  static get label() { return 'Chord'; }
  static get params() {
    return [
      { key: 'shape', label: 'Chord', type: 'select', options: Object.keys(CHORDS), def: 'major', easy: true, help: 'Which chord each note plays.' },
      { key: 'inversion', label: 'Invert', min: 0, max: 3, def: 0, step: 1, unit: '', easy: true, help: 'Moves the lowest notes up an octave.' },
      { key: 'spread', label: 'Spread', min: 0, max: 2, def: 0, step: 1, unit: 'oct', help: 'Spreads upper notes over more octaves.' },
      { key: 'velScale', label: 'Upper vel', min: 20, max: 100, def: 85, unit: '%', help: 'Loudness of the added notes.' },
      { key: 'fit', label: 'Fit key', type: 'select', options: ['off', 'on'], def: 'off', help: 'Keeps the chord inside the song key.' },
    ];
  }
  process(ev, emit) {
    const v = this.values; let iv = [...(CHORDS[v.shape] || CHORDS.major)];
    for (let i = 0; i < Math.min(v.inversion | 0, iv.length - 1); i++) iv[i] += 12;
    iv = iv.map((x, i) => x + (i > 0 ? Math.floor(i * (v.spread | 0) / Math.max(1, iv.length - 1)) * 12 : 0));
    const k = this.key(); const seen = new Set();
    iv.forEach((x, i) => { let n = clampNote(ev.note + x); if (v.fit === 'on' && i) n = snapToScale(n, k.root, k.scale); if (seen.has(n)) return; seen.add(n); emit({ ...ev, note: n, vel: i === 0 ? ev.vel : clampVel(ev.vel * v.velScale / 100) }); });
  }
}

class Scale extends MidiEffect {
  static get label() { return 'Scale'; }
  static get params() {
    return [
      { key: 'keySource', label: 'Key from', type: 'select', options: ['global', 'manual'], def: 'global', easy: true, help: 'Use the song key, or pick one here.' },
      { key: 'root', label: 'Key', type: 'select', options: NOTE_NAMES, def: 'C' },
      { key: 'scale', label: 'Scale', type: 'select', options: Object.keys(SCALES), def: 'major', easy: true },
      { key: 'transpose', label: 'Shift', min: -12, max: 12, def: 0, step: 1, unit: 'st', easy: true, help: 'Transposes before fitting to the scale.' },
    ];
  }
  process(ev, emit) { const k = this.key(); emit({ ...ev, note: clampNote(snapToScale(ev.note + (this.values.transpose | 0), k.root, k.scale)) }); }
}

class NoteLength extends MidiEffect {
  static get label() { return 'Note Length'; }
  static get params() {
    return [
      { key: 'mode', label: 'Mode', type: 'select', options: ['fixed', 'scale'], def: 'fixed', easy: true, help: 'Fixed: every note gets the same length. Scale: multiply the played length.' },
      { key: 'length', label: 'Length', type: 'select', options: Object.keys(LEN_BEATS), def: '1/8', easy: true },
      { key: 'gate', label: 'Gate', min: 5, max: 400, def: 100, unit: '%', curve: 'log', easy: true, help: 'Percentage of the length (or of the played length in Scale mode).' },
    ];
  }
  process(ev, emit) {
    const v = this.values, bd = this.engine.beatDur;
    if (v.mode === 'scale' && ev.dur != null) return emit({ ...ev, dur: Math.max(0.01, ev.dur * v.gate / 100) });
    emit({ ...ev, dur: Math.max(0.01, (LEN_BEATS[v.length] || 0.5) * bd * v.gate / 100), live: ev.dur == null ? true : ev.live });
  }
}

class Velocity extends MidiEffect {
  static get label() { return 'Velocity'; }
  static get params() {
    return [
      { key: 'drive', label: 'Drive', min: -100, max: 100, def: 0, unit: '%', easy: true, help: 'Pushes soft notes louder (+) or loud notes softer (-).' },
      { key: 'offset', label: 'Offset', min: -64, max: 64, def: 0, step: 1, unit: '', easy: true },
      { key: 'min', label: 'Min', min: 1, max: 127, def: 1, step: 1, unit: '' },
      { key: 'max', label: 'Max', min: 1, max: 127, def: 127, step: 1, unit: '' },
      { key: 'random', label: 'Random', min: 0, max: 64, def: 0, step: 1, unit: '', easy: true, help: 'Random variation (humanize).' },
    ];
  }
  process(ev, emit) {
    const v = this.values; let x = ev.vel / 127;
    const d = v.drive / 100; x = d >= 0 ? Math.pow(x, 1 - d * 0.8) : Math.pow(x, 1 - d * 2);
    let vel = x * 127 + v.offset + (Math.random() * 2 - 1) * v.random;
    const lo = Math.min(v.min, v.max), hi = Math.max(v.min, v.max);
    emit({ ...ev, vel: clampVel(Math.max(lo, Math.min(hi, vel))) });
  }
}

class RandomFx extends MidiEffect {
  static get label() { return 'Random'; }
  static get params() {
    return [
      { key: 'chance', label: 'Chance', min: 0, max: 100, def: 50, unit: '%', easy: true, help: 'How often a note is changed.' },
      { key: 'range', label: 'Range', min: 1, max: 24, def: 7, step: 1, unit: 'st', easy: true, help: 'How far (semitones) a note may move.' },
      { key: 'direction', label: 'Direction', type: 'select', options: ['both', 'up', 'down'], def: 'both' },
      { key: 'inKey', label: 'In key', type: 'select', options: ['on', 'off'], def: 'on', easy: true, help: 'Keeps random notes inside the song key.' },
    ];
  }
  process(ev, emit) {
    const v = this.values; if (Math.random() * 100 >= v.chance) return emit(ev);
    const r = 1 + Math.floor(Math.random() * v.range); const s = v.direction === 'up' ? 1 : v.direction === 'down' ? -1 : Math.random() < 0.5 ? -1 : 1;
    let n = ev.note + r * s;
    if (v.inKey === 'on') { const k = this.key(); n = snapToScale(n, k.root, k.scale); for (let d = r + 1; n === ev.note && d <= v.range + 2; d++) n = snapToScale(ev.note + d * s, k.root, k.scale); }
    emit({ ...ev, note: clampNote(n) });
  }
}

class Arpeggiator extends MidiEffect {
  static get label() { return 'Arpeggiator'; }
  static get params() {
    return [
      { key: 'mode', label: 'Style', type: 'select', options: ['up', 'down', 'updown', 'random', 'played'], def: 'up', easy: true },
      { key: 'rate', label: 'Rate', type: 'select', options: Object.keys(RATE_BEATS), def: '1/16', easy: true },
      { key: 'octaves', label: 'Octaves', min: 1, max: 4, def: 1, step: 1, unit: '', easy: true },
      { key: 'gate', label: 'Gate', min: 10, max: 100, def: 60, unit: '%', help: 'Length of each step.' },
      { key: 'accent', label: 'Accent', min: 0, max: 60, def: 15, unit: '', step: 1, help: 'Extra velocity on the first step of each beat.' },
    ];
  }
  constructor(...a) { super(...a); this.held = []; this.wm = null; this.k = 0; this.order = 0; }
  reset() { this.held = []; this.wm = null; this.k = 0; }
  process(ev) {
    // collect the note; steps are generated in tick()
    if (ev.off) { for (const h of this.held) if (h.src === ev.src && h.t1 === Infinity) h.t1 = ev.t; return; }
    this.held.push({ note: ev.note, vel: ev.vel, t0: ev.t, t1: ev.dur == null ? Infinity : ev.t + ev.dur, src: ev.src, ord: this.order++ });
  }
  sequence(notes) {
    const v = this.values; let base = [...notes];
    if (v.mode !== 'played') base.sort((a, b) => a.note - b.note); else base.sort((a, b) => a.ord - b.ord);
    const seq = []; for (let o = 0; o < (v.octaves | 0 || 1); o++) for (const h of base) seq.push({ note: h.note + 12 * o, vel: h.vel });
    if (v.mode === 'down') seq.reverse();
    if (v.mode === 'updown' && seq.length > 2) return seq.concat(seq.slice(1, -1).reverse());
    return seq;
  }
  tick(from, to, emit) {
    const e = this.engine, v = this.values, step = (RATE_BEATS[v.rate] || 0.25) * e.beatDur;
    const w0 = Math.max(from, this.wm != null ? this.wm : from);
    const times = [];
    if (e.playing) {
      for (const sg of e.loopSegments(w0, to)) {
        const o = e.gridOffset, pEnd = sg.p0 + (sg.c1 - sg.c0);
        for (let k = Math.ceil((sg.p0 - o - 1e-6) / step); o + k * step < pEnd - 1e-6; k++) times.push({ t: sg.c0 + (o + k * step - sg.p0), k });
      }
    } else for (let k = Math.ceil((w0 - 1e-6) / step); k * step < to - 1e-6; k++) times.push({ t: k * step, k });
    this.wm = to;
    const now = e.ctx.currentTime;
    this.held = this.held.filter((h) => h.t1 > now - 0.5);
    for (const { t, k } of times) {
      const on = this.held.filter((h) => h.t0 <= t + 0.004 && h.t1 > t + 0.004);
      if (!on.length) { this.k = 0; continue; }
      const seq = this.sequence(on); const pick = v.mode === 'random' ? seq[Math.floor(Math.random() * seq.length)] : seq[this.k % seq.length]; this.k++;
      const beatStart = Math.abs((k * (RATE_BEATS[v.rate] || 0.25)) % 1) < 1e-6;
      emit({ note: clampNote(pick.note), vel: clampVel(pick.vel + (beatStart ? v.accent : 0)), t: Math.max(t, now), dur: Math.max(0.01, step * v.gate / 100) });
    }
  }
}

export const MIDI_FX_TYPES = { arp: Arpeggiator, chord: Chord, scale: Scale, notelength: NoteLength, velocity: Velocity, random: RandomFx };
export const MIDI_FX_HELP = {
  arp: 'Arpeggiator: plays held notes one after another in time with the song.',
  chord: 'Chord: turns each note into a chord.',
  scale: 'Scale: moves notes into the song key (no wrong notes).',
  notelength: 'Note Length: makes every note the same length, or longer/shorter.',
  velocity: 'Velocity: shapes how hard notes are played (louder, softer, humanized).',
  random: 'Random: changes some notes at random, optionally inside the key.',
};
export function midiFxDefaults(type) { const C = MIDI_FX_TYPES[type]; const values = {}; for (const p of C.params) values[p.key] = p.def; return { type, enabled: true, values }; }

// The chain in front of one track's instrument. sink = the instrument (playNote/noteOn/noteOff/allOff).
export class MidiFxChain {
  constructor(engine, track, sink) { this.engine = engine; this.track = track; this.sink = sink; this.fx = []; this.live = new Map(); this.sync(); }
  sync() {
    const defs = this.track.midiFx || []; const old = this.fx;
    this.fx = defs.map((d) => { const C = MIDI_FX_TYPES[d.type]; if (!C) return null; const prev = old.find((f) => f.def === d); return prev || new C(this.engine, this.track, d); }).filter(Boolean);
  }
  get active() { return this.fx.some((f) => f.enabled); }
  run(ev, i) {
    for (; i < this.fx.length && !this.fx[i].enabled; i++);
    if (i >= this.fx.length) return this.out(ev);
    this.fx[i].process(ev, (e2) => this.run(e2, i + 1));
  }
  out(ev) {
    if (ev.off) return;
    if (ev.dur != null) { this.sink.playNote(ev.note, ev.vel, ev.t, ev.dur); return; }
    this.sink.noteOn(ev.note, ev.vel, ev.t); const L = this.live.get(ev.src) || []; L.push(ev.note); this.live.set(ev.src, L);
  }
  playNote(note, vel, t, dur) { if (!this.active) return this.sink.playNote(note, vel, t, dur); this.run({ note, vel, t, dur }, 0); }
  noteOn(note, vel, t = this.engine.ctx.currentTime) {
    if (!this.active) return this.sink.noteOn(note, vel, t);
    this.noteOff(note, t); this.run({ note, vel, t, dur: null, src: note }, 0);
  }
  noteOff(note, t = this.engine.ctx.currentTime) {
    if (!this.active && !this.live.size) return this.sink.noteOff(note, t);
    for (const f of this.fx) if (f.enabled && f instanceof Arpeggiator) f.process({ off: true, src: note, t });
    const L = this.live.get(note); if (L) { for (const n of L) this.sink.noteOff(n, t); this.live.delete(note); }
  }
  tick(from, to) { this.fx.forEach((f, i) => { if (f.enabled && f.tick !== MidiEffect.prototype.tick) f.tick(from, to, (e) => this.run(e, i + 1)); }); }
  allOff() { this.fx.forEach((f) => f.reset()); this.live.clear(); this.sink.allOff(); }
}
