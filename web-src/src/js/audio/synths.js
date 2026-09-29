// Polyphonic synths with a shared voice manager: voice pool with a polyphony limit, voice stealing
// (oldest released voice first, then oldest held), velocity, pitch bend and mod wheel (vibrato).
// Web Audio oscillators are single-use, so a "voice" = a pooled slot whose oscillator/filter/VCA
// nodes are created at note-on and released after the envelope tail.
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const dbToLin = (db) => Math.pow(10, db / 20);
const ms = (v) => Math.max(0.001, v / 1000);

class VoiceSynth {
  constructor(ctx, type) {
    this.ctx = ctx; this.type = type; this.output = ctx.createGain(); this.values = {};
    this.voices = []; this.held = new Map(); this.lastNote = null;
    this.bend = ctx.createConstantSource(); this.bend.offset.value = 0; this.bend.start();
    this.vib = ctx.createOscillator(); this.vib.frequency.value = 5.5; this.vibGain = ctx.createGain(); this.vibGain.gain.value = 0;
    this.vib.connect(this.vibGain); this.vib.start();
    this.bendRange = 2; this.modWheelValue = 0;
  }
  get def() { return this.constructor; }
  init(values = {}) {
    for (const p of this.def.params) this.values[p.key] = values[p.key] != null ? values[p.key] : p.def;
    for (const p of this.def.params) this.apply(p.key, this.values[p.key], true);
    return this;
  }
  set(k, v) { this.values[k] = v; this.apply(k, v, false); }
  applyPreset(name) { const p = this.def.presets[name]; if (!p) return; for (const prm of this.def.params) if (prm.key !== 'gain' && prm.key !== 'poly') this.set(prm.key, p[prm.key] != null ? p[prm.key] : prm.def); }
  apply(k, v, i) { if (k === 'gain') { const t = this.ctx.currentTime; this.output.gain.cancelScheduledValues(t); i ? (this.output.gain.value = dbToLin(v)) : this.output.gain.setTargetAtTime(dbToLin(v), t, 0.02); } }
  pitchBend(x) { this.bend.offset.setTargetAtTime(Math.max(-1, Math.min(1, x)) * this.bendRange * 100, this.ctx.currentTime, 0.005); }
  modWheel(x) { this.modWheelValue = x; this.vibGain.gain.setTargetAtTime(Math.max(0, Math.min(1, x)) * 45, this.ctx.currentTime, 0.02); }
  hookOsc(o) { this.bend.connect(o.detune); this.vibGain.connect(o.detune); }
  unhookOsc(o) { try { this.bend.disconnect(o.detune); } catch (e) {} try { this.vibGain.disconnect(o.detune); } catch (e) {} }
  // voice allocation with stealing
  allocate(t) {
    const poly = Math.max(1, Math.round(this.values.poly || 8));
    this.voices = this.voices.filter((v) => !v.dead);
    while (this.voices.length >= poly) {
      const released = this.voices.filter((v) => v.releasedAt != null).sort((a, b) => a.releasedAt - b.releasedAt)[0];
      const victim = released || this.voices.slice().sort((a, b) => a.start - b.start)[0];
      this.kill(victim, t);
    }
  }
  velGain(vel) { const s = (this.values.velSens != null ? this.values.velSens : 70) / 100; return (1 - s) + s * Math.pow(vel / 127, 1.5); }
  start(note, vel, t) {
    this.allocate(t);
    const from = this.lastNote; this.lastNote = note;
    const v = this.makeVoice(note, vel, t, from);
    v.note = note; v.start = t; v.releasedAt = null; v.dead = false;
    v.oscs.forEach((o) => { this.hookOsc(o); o.start(t); });
    v.oscs[0].onended = () => { v.dead = true; v.oscs.forEach((o) => this.unhookOsc(o)); (v.extra || []).forEach((n) => { try { n.stop && n.stop(); } catch (e) {} }); try { v.amp.disconnect(); } catch (e) {} };
    this.voices.push(v);
    return v;
  }
  release(v, t) {
    if (v.releasedAt != null) return; v.releasedAt = t;
    const tail = this.releaseVoice(v, Math.max(t, v.start + 0.002));
    v.oscs.forEach((o) => { try { o.stop(t + tail + 0.05); } catch (e) {} });
    (v.extra || []).forEach((n) => { try { n.stop && n.stop(t + tail + 0.05); } catch (e) {} });
  }
  kill(v, t) {
    v.releasedAt = v.releasedAt ?? t; v.dead = true;
    v.amp.gain.cancelScheduledValues(t); v.amp.gain.setTargetAtTime(0, t, 0.004);
    v.oscs.forEach((o) => { try { o.stop(t + 0.03); } catch (e) {} });
    (v.extra || []).forEach((n) => { try { n.stop && n.stop(t + 0.03); } catch (e) {} });
    this.voices = this.voices.filter((x) => x !== v);
    for (const [n, hv] of this.held) if (hv === v) this.held.delete(n);
  }
  playNote(note, vel, t, dur) { const v = this.start(note, vel, t); this.release(v, t + Math.max(0.01, dur)); }
  noteOn(note, vel, t = this.ctx.currentTime) { this.noteOff(note, t); this.held.set(note, this.start(note, vel, t)); }
  noteOff(note, t = this.ctx.currentTime) { const v = this.held.get(note); if (v) { this.release(v, t); this.held.delete(note); } }
  allOff() { const t = this.ctx.currentTime; [...this.voices].forEach((v) => this.kill(v, t)); this.held.clear(); }
  activeCount() { return this.voices.filter((v) => !v.dead && v.releasedAt == null).length; }
  toJSON() { return { type: this.type, values: { ...this.values } }; }
  dispose() { this.allOff(); try { this.output.disconnect(); this.bend.stop(); this.vib.stop(); } catch (e) {} }
}
// ADSR on an AudioParam
function adsr(param, t, base, peak, a, d, s) {
  param.cancelScheduledValues(t); param.setValueAtTime(base, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(base + (peak - base) * s, t + a, d / 3 + 0.001);
}
function releaseParam(param, t, to, r) { param.cancelScheduledValues(t); if (param.cancelAndHoldAtTime) { try { param.cancelAndHoldAtTime(t); } catch (e) {} } param.setTargetAtTime(to, t, r / 4 + 0.001); }

// ------------------------------------------------------------------ analog-style synth
const driveCurves = new Map();
function driveCurve(drive) {
  const k = Math.round(drive); if (driveCurves.has(k)) return driveCurves.get(k);
  const n = 2048, c = new Float32Array(n), g = 1 + k / 12;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * g) / Math.tanh(g); }
  driveCurves.set(k, c); return c;
}
const WAVES = ['sawtooth', 'square', 'triangle', 'sine'];
export class AnalogSynth extends VoiceSynth {
  static get label() { return 'Analog Synth'; }
  static get params() {
    return [
      { key: 'o1wave', label: 'Osc 1', type: 'select', options: WAVES, def: 'sawtooth', easy: true, help: 'Oscillator 1 waveform.' },
      { key: 'o2wave', label: 'Osc 2', type: 'select', options: WAVES, def: 'sawtooth', help: 'Oscillator 2 waveform.' },
      { key: 'o2semi', label: 'O2 semi', min: -24, max: 24, def: 0, unit: 'st', step: 1, help: 'Oscillator 2 tuning in semitones.' },
      { key: 'o2detune', label: 'Detune', min: 0, max: 50, def: 9, unit: 'ct', help: 'Oscillator 2 fine detune (beating / width).' },
      { key: 'o2level', label: 'O2 lvl', min: 0, max: 100, def: 70, unit: '%' },
      { key: 'o3wave', label: 'Osc 3', type: 'select', options: ['off', ...WAVES], def: 'off', help: 'Optional third oscillator.' },
      { key: 'o3semi', label: 'O3 semi', min: -24, max: 24, def: 12, unit: 'st', step: 1 },
      { key: 'sub', label: 'Sub', min: 0, max: 100, def: 25, unit: '%', help: 'Square sub-oscillator one octave down.' },
      { key: 'drift', label: 'Drift', min: 0, max: 100, def: 25, unit: '%', help: 'Subtle random pitch drift like old analog oscillators.' },
      { key: 'cutoff', label: 'Cutoff', min: 60, max: 16000, def: 1800, unit: 'Hz', curve: 'log', easy: true, help: 'Ladder-style 24 dB low-pass cutoff.' },
      { key: 'reso', label: 'Reso', min: 0, max: 100, def: 25, unit: '%', easy: true, help: 'Filter resonance.' },
      { key: 'drive', label: 'Drive', min: 0, max: 100, def: 15, unit: '%', help: 'Saturation into the filter.' },
      { key: 'envAmt', label: 'F.Env', min: 0, max: 100, def: 45, unit: '%', help: 'Filter envelope amount.' },
      { key: 'fA', label: 'F.Att', min: 1, max: 3000, def: 5, unit: 'ms', curve: 'log' },
      { key: 'fD', label: 'F.Dec', min: 10, max: 4000, def: 350, unit: 'ms', curve: 'log' },
      { key: 'fS', label: 'F.Sus', min: 0, max: 100, def: 30, unit: '%' },
      { key: 'fR', label: 'F.Rel', min: 10, max: 5000, def: 300, unit: 'ms', curve: 'log' },
      { key: 'aA', label: 'Attack', min: 1, max: 3000, def: 4, unit: 'ms', curve: 'log' },
      { key: 'aD', label: 'Decay', min: 10, max: 4000, def: 300, unit: 'ms', curve: 'log' },
      { key: 'aS', label: 'Sustain', min: 0, max: 100, def: 70, unit: '%' },
      { key: 'aR', label: 'Release', min: 10, max: 5000, def: 250, unit: 'ms', curve: 'log', easy: true },
      { key: 'glide', label: 'Glide', min: 0, max: 1000, def: 0, unit: 'ms', help: 'Portamento time from the previous note.' },
      { key: 'poly', label: 'Voices', min: 1, max: 16, def: 8, unit: '', step: 1, help: 'Maximum simultaneous voices (1 = mono). Extra notes steal the oldest voice.' },
      { key: 'velSens', label: 'Vel', min: 0, max: 100, def: 70, unit: '%', help: 'Velocity sensitivity (level and filter).' },
      { key: 'gain', label: 'Gain', min: -30, max: 6, def: -9, unit: 'dB', easy: true },
    ];
  }
  static get presets() {
    return {
      'Init': {},
      'Fat Bass': { o1wave: 'sawtooth', o2wave: 'square', o2semi: -12, o2detune: 6, sub: 60, cutoff: 420, reso: 30, drive: 45, envAmt: 55, fD: 220, fS: 10, aA: 2, aD: 400, aS: 80, aR: 90, poly: 1, glide: 40 },
      'Warm Pad': { o1wave: 'sawtooth', o2wave: 'sawtooth', o2detune: 18, sub: 10, drift: 45, cutoff: 1400, reso: 15, envAmt: 25, fA: 800, fD: 1500, fS: 60, fR: 1500, aA: 900, aD: 1200, aS: 85, aR: 1800 },
      'Lead': { o1wave: 'square', o2wave: 'sawtooth', o2semi: 12, o2detune: 5, o2level: 50, cutoff: 2600, reso: 45, drive: 35, envAmt: 40, aA: 3, aS: 85, aR: 180, glide: 60, poly: 1 },
      'Brass': { o1wave: 'sawtooth', o2wave: 'sawtooth', o2detune: 12, cutoff: 900, reso: 10, envAmt: 70, fA: 60, fD: 500, fS: 45, aA: 40, aD: 400, aS: 80, aR: 250 },
      'Pluck': { o1wave: 'sawtooth', o2wave: 'triangle', o2semi: 7, o2level: 40, cutoff: 700, reso: 35, envAmt: 80, fD: 180, fS: 0, aA: 1, aD: 350, aS: 0, aR: 300 },
    };
  }
  constructor(ctx) {
    super(ctx, 'synth');
    this.driftLfo = ctx.createOscillator(); this.driftLfo.frequency.value = 0.13; this.driftGain = ctx.createGain(); this.driftGain.gain.value = 0;
    this.driftLfo.connect(this.driftGain); this.driftLfo.start();
  }
  apply(k, v, i) { super.apply(k, v, i); if (k === 'drift') this.driftGain.gain.setTargetAtTime(v * 0.06, this.ctx.currentTime, 0.1); }
  hookOsc(o) { super.hookOsc(o); this.driftGain.connect(o.detune); }
  unhookOsc(o) { super.unhookOsc(o); try { this.driftGain.disconnect(o.detune); } catch (e) {} }
  makeVoice(note, vel, t, from) {
    const ctx = this.ctx, v = this.values, f = mtof(note), vg = this.velGain(vel);
    const osc = (type, freq, det) => { const o = ctx.createOscillator(); o.type = type; o.detune.value = det + (Math.random() * 2 - 1) * v.drift * 0.08;
      if (v.glide > 0 && from != null && from !== note) { const f0 = freq * mtof(from) / f; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(freq, t + ms(v.glide)); } else o.frequency.value = freq; return o; };
    const mix = ctx.createGain(); mix.gain.value = 0.22;
    const o1 = osc(v.o1wave, f, 0), o2 = osc(v.o2wave, f * Math.pow(2, Math.round(v.o2semi) / 12), v.o2detune);
    const g2 = ctx.createGain(); g2.gain.value = v.o2level / 100;
    o1.connect(mix); o2.connect(g2).connect(mix);
    const oscs = [o1, o2];
    if (v.o3wave !== 'off') { const o3 = osc(v.o3wave, f * Math.pow(2, Math.round(v.o3semi) / 12), -v.o2detune * 0.5); const g3 = ctx.createGain(); g3.gain.value = 0.6; o3.connect(g3).connect(mix); oscs.push(o3); }
    if (v.sub > 0) { const s = osc('square', f / 2, 0); const gs = ctx.createGain(); gs.gain.value = (v.sub / 100) * 0.6; s.connect(gs).connect(mix); oscs.push(s); }
    const shaper = ctx.createWaveShaper(); shaper.curve = driveCurve(v.drive);
    const pre = ctx.createGain(); pre.gain.value = 1 + v.drive / 25;
    const lp1 = ctx.createBiquadFilter(), lp2 = ctx.createBiquadFilter(); lp1.type = lp2.type = 'lowpass';
    lp1.Q.value = 0.5; lp2.Q.value = 0.7 + (v.reso / 100) * 14;
    const post = ctx.createGain(); post.gain.value = 1 / (1 + v.drive / 60);
    const amp = ctx.createGain(); amp.gain.value = 0;
    mix.connect(pre).connect(shaper).connect(lp1).connect(lp2).connect(post).connect(amp).connect(this.output);
    const base = v.cutoff, top = Math.min(18000, base * (1 + (v.envAmt / 100) * 10 * (0.5 + 0.5 * vg)));
    for (const lp of [lp1, lp2]) { adsr(lp.frequency, t, base, top, ms(v.fA), ms(v.fD), v.fS / 100); }
    adsr(amp.gain, t, 0, vg, ms(v.aA), ms(v.aD), v.aS / 100);
    return { oscs, amp, filters: [lp1, lp2] };
  }
  releaseVoice(vc, t) {
    const v = this.values, r = ms(v.aR);
    releaseParam(vc.amp.gain, t, 0, r);
    vc.filters.forEach((lp) => releaseParam(lp.frequency, t, v.cutoff, ms(v.fR)));
    return r * 1.6;
  }
  dispose() { super.dispose(); try { this.driftLfo.stop(); } catch (e) {} }
}

// ------------------------------------------------------------------ wavetable synth
// Each table has two harmonic spectra (frame A and B, sine phase). Crossfading two oscillators whose
// partials share phase equals linear interpolation of the spectra, so "table position" morphs
// smoothly at audio rate (driven by an LFO and envelope 2).
const H = 64;
const spec = (fn) => { const a = new Float32Array(H + 1); for (let k = 1; k <= H; k++) a[k] = fn(k); return a; };
export const WAVETABLES = {
  'Basic': [spec((k) => (k === 1 ? 1 : 0)), spec((k) => 1 / k)],
  'Pulse': [spec((k) => (k % 2 ? 1 / k : 0)), spec((k) => Math.abs(Math.sin(Math.PI * k * 0.12)) / k * 1.6)],
  'Vocal': [spec((k) => Math.exp(-(((k * 110) - 700) ** 2) / 60000) + 0.8 * Math.exp(-(((k * 110) - 1100) ** 2) / 90000) + 0.05 / k), spec((k) => Math.exp(-(((k * 110) - 350) ** 2) / 30000) + 0.7 * Math.exp(-(((k * 110) - 2300) ** 2) / 200000) + 0.05 / k)],
  'Glass': [spec((k) => ([1, 2, 4, 7, 11].includes(k) ? 1 / Math.sqrt(k) : 0)), spec((k) => ([1, 3, 5, 9, 13, 17].includes(k) ? 1 / Math.sqrt(k) : 0))],
  'Digital': [spec((k) => (k <= 8 ? 1 / k : 0)), spec((k) => (k % 3 === 0 ? 1 : 0.15) / Math.sqrt(k))],
  'Growl': [spec((k) => 1 / k * (k % 2 ? 1 : 0.3)), spec((k) => (k > 4 && k < 20 ? 0.6 : 0.1) / Math.sqrt(k))],
};
const waveCache = new WeakMap();
function tableWaves(ctx, name) {
  let m = waveCache.get(ctx); if (!m) waveCache.set(ctx, (m = {}));
  if (m[name]) return m[name];
  const [a, b] = WAVETABLES[name] || WAVETABLES.Basic;
  const norm = (s) => { let sum = 0; for (let k = 1; k <= H; k++) sum += Math.abs(s[k]); return s.map((x) => x / Math.max(1, sum * 0.6)); };
  const mk = (s) => ctx.createPeriodicWave(new Float32Array(H + 1), norm(s), { disableNormalization: true });
  return (m[name] = [mk(a), mk(b)]);
}
// Waveform of a table at position 0..1 (for the display)
export function wavetableFrame(name, pos, n = 128) {
  const [a, b] = WAVETABLES[name] || WAVETABLES.Basic; const out = new Float32Array(n); let mx = 1e-6;
  for (let i = 0; i < n; i++) { let s = 0; const ph = (i / n) * 2 * Math.PI; for (let k = 1; k <= H; k++) { const amp = a[k] * (1 - pos) + b[k] * pos; if (amp) s += amp * Math.sin(k * ph); } out[i] = s; mx = Math.max(mx, Math.abs(s)); }
  for (let i = 0; i < n; i++) out[i] /= mx; return out;
}
export class WavetableSynth extends VoiceSynth {
  static get label() { return 'Wavetable Synth'; }
  static get params() {
    return [
      { key: 'table', label: 'Table', type: 'select', options: Object.keys(WAVETABLES), def: 'Basic', easy: true, help: 'Wavetable (generated in code).' },
      { key: 'pos', label: 'Position', min: 0, max: 100, def: 30, unit: '%', easy: true, help: 'Position in the wavetable (morph between its frames).' },
      { key: 'posEnv', label: 'Pos Env', min: -100, max: 100, def: 0, unit: '%', help: 'How much envelope 2 moves the table position.' },
      { key: 'posLfo', label: 'Pos LFO', min: 0, max: 100, def: 20, unit: '%', help: 'How much the LFO moves the table position.' },
      { key: 'lfoRate', label: 'LFO Hz', min: 0.05, max: 20, def: 0.8, unit: 'Hz', curve: 'log' },
      { key: 'lfoShape', label: 'LFO', type: 'select', options: ['sine', 'triangle', 'square', 'sawtooth'], def: 'sine' },
      { key: 'unison', label: 'Unison', type: 'select', options: ['1', '2', '3', '4'], def: '2', help: 'Stacked detuned copies per voice.' },
      { key: 'detune', label: 'Detune', min: 0, max: 50, def: 12, unit: 'ct' },
      { key: 'cutoff', label: 'Cutoff', min: 60, max: 18000, def: 6000, unit: 'Hz', curve: 'log', easy: true },
      { key: 'reso', label: 'Reso', min: 0.1, max: 18, def: 1, unit: '', curve: 'log' },
      { key: 'fEnv', label: 'F.Env', min: -100, max: 100, def: 20, unit: '%', help: 'Envelope 2 amount on the filter.' },
      { key: 'aA', label: 'Attack', min: 1, max: 3000, def: 8, unit: 'ms', curve: 'log' },
      { key: 'aD', label: 'Decay', min: 10, max: 4000, def: 400, unit: 'ms', curve: 'log' },
      { key: 'aS', label: 'Sustain', min: 0, max: 100, def: 75, unit: '%' },
      { key: 'aR', label: 'Release', min: 10, max: 5000, def: 400, unit: 'ms', curve: 'log', easy: true },
      { key: 'eA', label: 'E2 Att', min: 1, max: 3000, def: 200, unit: 'ms', curve: 'log' },
      { key: 'eD', label: 'E2 Dec', min: 10, max: 4000, def: 800, unit: 'ms', curve: 'log' },
      { key: 'eS', label: 'E2 Sus', min: 0, max: 100, def: 40, unit: '%' },
      { key: 'eR', label: 'E2 Rel', min: 10, max: 5000, def: 600, unit: 'ms', curve: 'log' },
      { key: 'poly', label: 'Voices', min: 1, max: 12, def: 8, unit: '', step: 1 },
      { key: 'velSens', label: 'Vel', min: 0, max: 100, def: 60, unit: '%' },
      { key: 'gain', label: 'Gain', min: -30, max: 6, def: -10, unit: 'dB', easy: true },
    ];
  }
  static get presets() {
    return {
      'Init': {},
      'Glass Pad': { table: 'Glass', pos: 20, posLfo: 35, lfoRate: 0.3, unison: '3', detune: 14, cutoff: 7000, aA: 700, aD: 1200, aS: 80, aR: 1800, eA: 1500, posEnv: 40 },
      'Vox Lead': { table: 'Vocal', pos: 0, posEnv: 80, eA: 250, eD: 600, eS: 30, posLfo: 10, lfoRate: 5, unison: '2', detune: 6, cutoff: 5000, aA: 10, aR: 250 },
      'Growl Bass': { table: 'Growl', pos: 10, posLfo: 60, lfoRate: 2, lfoShape: 'triangle', unison: '2', detune: 8, cutoff: 1500, reso: 4, fEnv: 40, aA: 2, aS: 90, aR: 120, poly: 1 },
      'Digital Pluck': { table: 'Digital', pos: 70, posEnv: -70, eA: 1, eD: 250, eS: 0, cutoff: 3000, fEnv: 60, aA: 1, aD: 300, aS: 0, aR: 300, unison: '1' },
    };
  }
  constructor(ctx) {
    super(ctx, 'wavetable');
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 0.8; this.lfoPos = ctx.createGain(); this.lfoPos.gain.value = 0;
    this.lfo.connect(this.lfoPos); this.lfo.start(); this.t0 = ctx.currentTime;
  }
  apply(k, v, i) {
    super.apply(k, v, i); const t = this.ctx.currentTime;
    if (k === 'lfoRate') this.lfo.frequency.setTargetAtTime(v, t, 0.02);
    else if (k === 'lfoShape') this.lfo.type = v;
    else if (k === 'posLfo') this.lfoPos.gain.setTargetAtTime(v / 200, t, 0.02);
    else if (k === 'pos') this.voices.forEach((vc) => vc.posCS && vc.posCS.offset.setTargetAtTime(v / 100, t, 0.02));
    else if (k === 'cutoff') this.voices.forEach((vc) => vc.filt && vc.filt.frequency.setTargetAtTime(v, t, 0.02));
    else if (k === 'reso') this.voices.forEach((vc) => vc.filt && vc.filt.Q.setTargetAtTime(v, t, 0.02));
  }
  // approximate current position for the display (LFO phase estimated from its rate)
  displayPos() {
    const v = this.values, t = this.ctx.currentTime; const ph = 2 * Math.PI * v.lfoRate * t;
    const l = v.lfoShape === 'square' ? Math.sign(Math.sin(ph)) : v.lfoShape === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : Math.sin(ph);
    return Math.max(0, Math.min(1, v.pos / 100 + l * v.posLfo / 200));
  }
  makeVoice(note, vel, t) {
    const ctx = this.ctx, v = this.values, f = mtof(note), vg = this.velGain(vel);
    const [wa, wb] = tableWaves(ctx, v.table);
    const gA = ctx.createGain(), gB = ctx.createGain(); gA.gain.value = 1; gB.gain.value = 0;
    const posCS = ctx.createConstantSource(); posCS.offset.value = v.pos / 100;
    const env2 = ctx.createConstantSource(); env2.offset.value = 0;
    const posEnvG = ctx.createGain(); posEnvG.gain.value = v.posEnv / 100;
    const posSum = ctx.createGain(); const inv = ctx.createGain(); inv.gain.value = -1;
    posCS.connect(posSum); env2.connect(posEnvG).connect(posSum); this.lfoPos.connect(posSum);
    posSum.connect(gB.gain); posSum.connect(inv).connect(gA.gain);
    const n = +v.unison || 1, oscs = [], lvl = 0.5 / Math.sqrt(n);
    const mix = ctx.createGain(); mix.gain.value = lvl;
    for (let u = 0; u < n; u++) {
      const det = n === 1 ? 0 : (u / (n - 1) * 2 - 1) * v.detune;
      for (const [w, g] of [[wa, gA], [wb, gB]]) { const o = ctx.createOscillator(); o.setPeriodicWave(w); o.frequency.value = f; o.detune.value = det; o.connect(g); oscs.push(o); }
    }
    gA.connect(mix); gB.connect(mix);
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = v.cutoff; filt.Q.value = v.reso;
    const fEnvG = ctx.createGain(); fEnvG.gain.value = v.fEnv * 48; env2.connect(fEnvG).connect(filt.detune);
    const amp = ctx.createGain(); amp.gain.value = 0;
    mix.connect(filt).connect(amp).connect(this.output);
    adsr(amp.gain, t, 0, vg, ms(v.aA), ms(v.aD), v.aS / 100);
    adsr(env2.offset, t, 0, 1, ms(v.eA), ms(v.eD), v.eS / 100);
    posCS.start(t); env2.start(t);
    return { oscs, amp, filt, env2, posCS, extra: [posCS, env2], lfoTap: posSum };
  }
  releaseVoice(vc, t) {
    const v = this.values, r = ms(v.aR);
    releaseParam(vc.amp.gain, t, 0, r); releaseParam(vc.env2.offset, t, 0, ms(v.eR));
    setTimeout(() => { try { this.lfoPos.disconnect(vc.lfoTap); } catch (e) {} }, (t - this.ctx.currentTime + r * 1.6 + 0.2) * 1000);
    return r * 1.6;
  }
  kill(vc, t) { super.kill(vc, t); setTimeout(() => { try { this.lfoPos.disconnect(vc.lfoTap); } catch (e) {} }, 100); }
  dispose() { super.dispose(); try { this.lfo.stop(); } catch (e) {} }
}
