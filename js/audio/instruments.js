// Built-in MIDI instruments: a polyphonic subtractive synth and a drum sampler whose kits are
// synthesized in code at load time (no samples, nothing copyrighted).

import { AnalogSynth, WavetableSynth } from './synths.js';
export { AnalogSynth, WavetableSynth, wavetableFrame, WAVETABLES } from './synths.js';
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const dbToLin = (db) => Math.pow(10, db / 20);

class Instrument {
  constructor(ctx, type) { this.ctx = ctx; this.type = type; this.output = ctx.createGain(); this.values = {}; }
  get def() { return this.constructor; }
  init(values = {}) {
    for (const p of this.def.params) this.values[p.key] = values[p.key] != null ? values[p.key] : p.def;
    for (const p of this.def.params) this.apply(p.key, this.values[p.key], true);
    return this;
  }
  set(k, v) { this.values[k] = v; this.apply(k, v, false); }
  apply() {}
  toJSON() { return { type: this.type, values: { ...this.values } }; }
  dispose() { this.allOff(); try { this.output.disconnect(); } catch (e) {} }
}

export class PolySynth extends Instrument {
  static get label() { return 'Poly Synth'; }
  static get params() {
    return [
      { key: 'wave', label: 'Wave', type: 'select', options: ['sawtooth', 'square', 'triangle', 'sine'], def: 'sawtooth', easy: true, help: 'Oscillator waveform: saw = bright, square = hollow, triangle/sine = soft.' },
      { key: 'detune', label: 'Detune', min: 0, max: 50, def: 8, unit: 'ct', help: 'Detunes the two oscillators for a wider, chorused sound.' },
      { key: 'sub', label: 'Sub', min: 0, max: 100, def: 25, unit: '%', help: 'Adds a sine one octave below.' },
      { key: 'cutoff', label: 'Cutoff', min: 80, max: 16000, def: 2400, unit: 'Hz', curve: 'log', easy: true, help: 'Low-pass filter cutoff: lower = darker.' },
      { key: 'reso', label: 'Reso', min: 0.1, max: 18, def: 2, unit: '', curve: 'log', help: 'Filter resonance (emphasis at the cutoff).' },
      { key: 'envAmt', label: 'Env', min: 0, max: 100, def: 40, unit: '%', help: 'How much the envelope opens the filter.' },
      { key: 'attack', label: 'Attack', min: 1, max: 2000, def: 5, unit: 'ms', curve: 'log' },
      { key: 'decay', label: 'Decay', min: 10, max: 3000, def: 300, unit: 'ms', curve: 'log' },
      { key: 'sustain', label: 'Sustain', min: 0, max: 100, def: 60, unit: '%' },
      { key: 'release', label: 'Release', min: 10, max: 5000, def: 300, unit: 'ms', curve: 'log', easy: true },
      { key: 'gain', label: 'Gain', min: -30, max: 6, def: -8, unit: 'dB', easy: true },
    ];
  }
  constructor(ctx) { super(ctx, 'synth'); this.held = new Map(); this.active = new Set(); }
  apply(k, v, i) { if (k === 'gain') { const t = this.ctx.currentTime; this.output.gain.cancelScheduledValues(t); i ? (this.output.gain.value = dbToLin(v)) : this.output.gain.setTargetAtTime(dbToLin(v), t, 0.02); } }
  voice(note, vel, t) {
    const ctx = this.ctx, v = this.values, f = mtof(note);
    if (this.active.size >= 24) { const oldest = this.active.values().next().value; this.kill(oldest, t); }
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), sub = ctx.createOscillator();
    o1.type = o2.type = v.wave; o1.frequency.value = o2.frequency.value = f; o1.detune.value = -v.detune; o2.detune.value = v.detune;
    sub.type = 'sine'; sub.frequency.value = f / 2;
    const mix = ctx.createGain(); mix.gain.value = 0.28;
    const subG = ctx.createGain(); subG.gain.value = (v.sub / 100) * 0.5;
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.Q.value = v.reso;
    const amp = ctx.createGain(); amp.gain.value = 0;
    o1.connect(mix); o2.connect(mix); sub.connect(subG).connect(filt); mix.connect(filt); filt.connect(amp).connect(this.output);
    const a = v.attack / 1000, d = v.decay / 1000, s = v.sustain / 100, peak = Math.pow(vel / 127, 1.4);
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(peak, t + a); amp.gain.setTargetAtTime(peak * s, t + a, d / 3 + 0.001);
    const base = v.cutoff, top = Math.min(18000, base * (1 + (v.envAmt / 100) * 8));
    filt.frequency.setValueAtTime(base, t); filt.frequency.exponentialRampToValueAtTime(Math.max(base, top), t + a + 0.001); filt.frequency.setTargetAtTime(base, t + a, d / 3 + 0.001);
    [o1, o2, sub].forEach((o) => o.start(t));
    const vc = { oscs: [o1, o2, sub], amp, note, start: t };
    o1.onended = () => { this.active.delete(vc); try { amp.disconnect(); } catch (e) {} };
    this.active.add(vc);
    return vc;
  }
  release(vc, t) {
    const r = this.values.release / 1000;
    vc.amp.gain.setTargetAtTime(0, Math.max(t, vc.start + 0.001), r / 4 + 0.001);
    vc.oscs.forEach((o) => { try { o.stop(t + r * 1.6 + 0.05); } catch (e) {} });
  }
  kill(vc, t) { vc.amp.gain.cancelScheduledValues(t); vc.amp.gain.setTargetAtTime(0, t, 0.01); vc.oscs.forEach((o) => { try { o.stop(t + 0.06); } catch (e) {} }); this.active.delete(vc); }
  playNote(note, vel, t, dur) { const vc = this.voice(note, vel, t); this.release(vc, t + Math.max(0.01, dur)); }
  noteOn(note, vel, t = this.ctx.currentTime) { this.noteOff(note, t); this.held.set(note, this.voice(note, vel, t)); }
  noteOff(note, t = this.ctx.currentTime) { const vc = this.held.get(note); if (vc) { this.release(vc, t); this.held.delete(note); } }
  allOff() { const t = this.ctx.currentTime; [...this.active].forEach((vc) => this.kill(vc, t)); this.held.clear(); }
}

// ------------------------------------------------------------------ drum synthesis
export const DRUM_NOTES = { 36: 'kick', 37: 'rim', 38: 'snare', 39: 'clap', 42: 'hatC', 44: 'hatC', 46: 'hatO', 41: 'tomL', 43: 'tomL', 45: 'tomM', 47: 'tomM', 48: 'tomH', 50: 'tomH', 49: 'crash', 57: 'crash', 51: 'ride', 53: 'ride' };
export const PAD_ORDER = [[36, 'Kick'], [38, 'Snare'], [39, 'Clap'], [37, 'Rim'], [42, 'Hat'], [46, 'Open'], [41, 'Tom L'], [45, 'Tom M'], [48, 'Tom H'], [49, 'Crash'], [51, 'Ride']];
const FALLBACK = ['kick', 'rim', 'snare', 'clap', 'hatC', 'tomL', 'hatC', 'tomM', 'hatO', 'tomH', 'crash', 'ride'];
export const KITS = {
  electro: { label: '808 / Electro', kick: { f0: 160, f1: 42, pd: 18, dec: 0.9, click: 0.1 }, snare: { tone: 190, noise: 0.7, dec: 0.18 }, hat: { dec: 0.05, open: 0.45, bright: 1 }, tom: { dec: 0.5, base: 90 }, cym: { dec: 1.6 }, drive: 0 },
  acoustic: { label: 'Acoustic-ish', kick: { f0: 140, f1: 55, pd: 35, dec: 0.35, click: 0.35 }, snare: { tone: 220, noise: 0.85, dec: 0.22 }, hat: { dec: 0.06, open: 0.55, bright: 0.8 }, tom: { dec: 0.45, base: 100 }, cym: { dec: 2.2 }, drive: 0 },
  metal: { label: 'Metal (tight)', kick: { f0: 190, f1: 58, pd: 55, dec: 0.22, click: 0.9 }, snare: { tone: 240, noise: 0.95, dec: 0.2 }, hat: { dec: 0.04, open: 0.4, bright: 1.2 }, tom: { dec: 0.4, base: 110 }, cym: { dec: 1.8 }, drive: 0.4 },
};

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; }; }
function synthDrum(sr, name, kit) {
  const K = KITS[kit] || KITS.electro, rand = rng(name.length * 977 + kit.length * 31);
  const len = (s) => new Float32Array(Math.floor(sr * s));
  const TWO_PI = Math.PI * 2;
  let d;
  if (name === 'kick') {
    const k = K.kick; d = len(k.dec * 2 + 0.05); let ph = 0;
    for (let i = 0; i < d.length; i++) { const t = i / sr; const f = k.f1 + (k.f0 - k.f1) * Math.exp(-t * k.pd); ph += TWO_PI * f / sr;
      d[i] = Math.sin(ph) * Math.exp(-t / k.dec * 2.2) + (t < 0.004 ? rand() * k.click * (1 - t / 0.004) : 0); }
  } else if (name === 'snare' || name === 'rim') {
    const s = K.snare, rim = name === 'rim'; d = len(rim ? 0.08 : s.dec * 2.5); let prev = 0;
    for (let i = 0; i < d.length; i++) { const t = i / sr; const n = rand(); const hp = n - prev; prev = n;
      const tone = (Math.sin(TWO_PI * (rim ? 1700 : s.tone) * t) + 0.6 * Math.sin(TWO_PI * (rim ? 2400 : s.tone * 1.7) * t)) * Math.exp(-t * (rim ? 70 : 28));
      d[i] = rim ? tone * 0.8 : tone * 0.5 + hp * s.noise * 0.5 * Math.exp(-t / s.dec * 2.5); }
  } else if (name === 'clap') {
    d = len(0.35); let lp = 0, prev = 0;
    for (let i = 0; i < d.length; i++) { const t = i / sr; const n = rand(); lp += 0.3 * (n - lp); const bp = lp - prev; prev = lp;
      let env = Math.exp(-t * 18) * 0.7; for (const o of [0, 0.011, 0.022]) if (t >= o && t < o + 0.01) env = Math.max(env, 1 - (t - o) / 0.01);
      d[i] = bp * env * 3; }
  } else if (name === 'hatC' || name === 'hatO' || name === 'crash' || name === 'ride') {
    const h = K.hat, dec = name === 'hatC' ? h.dec : name === 'hatO' ? h.open : name === 'crash' ? K.cym.dec : K.cym.dec * 0.6;
    d = len(dec * 3 + 0.02); const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21], base = name === 'ride' ? 320 : 410; let prev = 0, prevOut = 0;
    for (let i = 0; i < d.length; i++) { const t = i / sr; let m = 0; for (const r of ratios) m += Math.sign(Math.sin(TWO_PI * base * r * t));
      const x = m / 6 * 0.6 + rand() * (name === 'ride' ? 0.3 : 0.6); const hp = 0.9 * (prevOut + x - prev); prev = x; prevOut = hp;
      let v = hp * Math.exp(-t / dec * 2.3) * h.bright;
      if (name === 'ride') v += Math.sin(TWO_PI * 2600 * t) * 0.15 * Math.exp(-t * 3);
      d[i] = v * (name === 'crash' ? 0.8 : 0.6); }
  } else { // toms
    const tm = K.tom, mult = name === 'tomL' ? 1 : name === 'tomM' ? 1.35 : 1.8; d = len(tm.dec * 2.5); let ph = 0;
    for (let i = 0; i < d.length; i++) { const t = i / sr; const f = tm.base * mult * (1 + 0.6 * Math.exp(-t * 25)); ph += TWO_PI * f / sr;
      d[i] = Math.sin(ph) * Math.exp(-t / tm.dec * 2.4) * 0.9 + (t < 0.003 ? rand() * 0.3 : 0); }
  }
  if (K.drive) for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * (1 + K.drive * 3)) / Math.tanh(1 + K.drive * 3);
  // fade-out tail to avoid clicks
  const fade = Math.min(d.length, Math.floor(sr * 0.01)); for (let i = 0; i < fade; i++) d[d.length - 1 - i] *= i / fade;
  return d;
}
const kitCache = new WeakMap();
function getKit(ctx, kit) {
  let perCtx = kitCache.get(ctx); if (!perCtx) { perCtx = {}; kitCache.set(ctx, perCtx); }
  if (perCtx[kit]) return perCtx[kit];
  const out = {};
  for (const name of ['kick', 'rim', 'snare', 'clap', 'hatC', 'hatO', 'tomL', 'tomM', 'tomH', 'crash', 'ride']) {
    const data = synthDrum(ctx.sampleRate, name, kit); const b = ctx.createBuffer(1, data.length, ctx.sampleRate); b.getChannelData(0).set(data); out[name] = b;
  }
  return (perCtx[kit] = out);
}

export class DrumSampler extends Instrument {
  static get label() { return 'Drum Kit'; }
  static get params() {
    return [
      { key: 'kit', label: 'Kit', type: 'select', options: Object.keys(KITS), def: 'acoustic', easy: true, help: 'Synthesized drum kit (generated in code, no samples).' },
      { key: 'tune', label: 'Tune', min: -12, max: 12, def: 0, unit: 'st', easy: true, help: 'Pitch of all drums in semitones.' },
      { key: 'gain', label: 'Gain', min: -30, max: 6, def: -4, unit: 'dB', easy: true },
    ];
  }
  constructor(ctx) { super(ctx, 'drums'); this.sources = new Set(); this.openHat = null; }
  apply(k, v) {
    if (k === 'gain') this.output.gain.setTargetAtTime(dbToLin(v), this.ctx.currentTime, 0.02);
    if (k === 'kit') this.kit = getKit(this.ctx, v);
  }
  playNote(note, vel, t) {
    const name = DRUM_NOTES[note] || FALLBACK[note % 12];
    const buf = this.kit[name]; if (!buf) return;
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = Math.pow(2, (this.values.tune || 0) / 12);
    const g = this.ctx.createGain(); g.gain.value = Math.pow(vel / 127, 1.3);
    src.connect(g).connect(this.output); src.start(t);
    if (name === 'hatC' && this.openHat) { try { this.openHat.stop(t); } catch (e) {} this.openHat = null; } // hat choke
    if (name === 'hatO') this.openHat = src;
    this.sources.add(src); src.onended = () => this.sources.delete(src);
  }
  noteOn(note, vel, t = this.ctx.currentTime) { this.playNote(note, vel, t); }
  noteOff() {}
  allOff() { const t = this.ctx.currentTime; this.sources.forEach((s) => { try { s.stop(t + 0.02); } catch (e) {} }); this.sources.clear(); }
}

export const INSTRUMENT_TYPES = { synth: AnalogSynth, wavetable: WavetableSynth, drums: DrumSampler };
export function createInstrument(ctx, def) {
  const C = INSTRUMENT_TYPES[def && def.type] || AnalogSynth;
  return new C(ctx).init((def && def.values) || {});
}
