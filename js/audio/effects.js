// Built-in effects implemented with native Web Audio nodes (+ an AudioWorklet gate).
import { generateIR, IR_TYPES } from './ir.js';
import { PitchCorrectorDSP, SCALES, NOTE_NAMES } from './pitchdsp.js';

const dbToLin = (db) => Math.pow(10, db / 20);
let uid = 0;

export class Effect {
  constructor(ctx, type, params = {}) {
    this.ctx = ctx;
    this.type = type;
    this.id = 'fx' + Date.now().toString(36) + (uid++);
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.enabled = true;
    this.values = {};
    this._params = params;
  }
  static get params() { return []; }
  get def() { return this.constructor; }
  init(values = {}) {
    for (const p of this.def.params) {
      const v = values[p.key] != null ? values[p.key] : p.def;
      this.values[p.key] = v;
    }
    for (const p of this.def.params) this.apply(p.key, this.values[p.key], true);
    this.route();
    return this;
  }
  // wire input->wet chain->output, or input->output when bypassed
  route() {
    try { this.input.disconnect(); } catch (e) {}
    if (this.enabled) this.input.connect(this.wetIn); else this.input.connect(this.output);
  }
  setEnabled(on) { this.enabled = !!on; this.route(); }
  set(key, value) { this.values[key] = value; this.apply(key, value, false); }
  apply() {}
  p(param, value, instant) {
    const t = this.ctx.currentTime;
    if (!isFinite(value)) return;
    if (instant) { param.cancelScheduledValues(0); param.value = value; }
    else { param.cancelScheduledValues(t); param.setTargetAtTime(value, t, 0.015); }
  }
  toJSON() { return { type: this.type, enabled: this.enabled, values: { ...this.values } }; }
  dispose() { try { this.input.disconnect(); this.output.disconnect(); } catch (e) {} }
  // optional meter reading (e.g. gain reduction in dB, positive number)
  getReduction() { return 0; }
}

// ---------------------------------------------------------------- EQ
export class ParametricEQ extends Effect {
  static get label() { return 'Parametric EQ'; }
  static get params() {
    return [
      { key: 'hpf', label: 'HPF', min: 20, max: 1000, def: 20, unit: 'Hz', curve: 'log' },
      { key: 'lowFreq', label: 'Low F', min: 30, max: 600, def: 100, unit: 'Hz', curve: 'log' },
      { key: 'lowGain', label: 'Low G', min: -18, max: 18, def: 0, unit: 'dB' },
      { key: 'm1Freq', label: 'Mid1 F', min: 80, max: 4000, def: 400, unit: 'Hz', curve: 'log' },
      { key: 'm1Gain', label: 'Mid1 G', min: -18, max: 18, def: 0, unit: 'dB' },
      { key: 'm1Q', label: 'Mid1 Q', min: 0.2, max: 10, def: 1, unit: '', curve: 'log' },
      { key: 'm2Freq', label: 'Mid2 F', min: 300, max: 12000, def: 2500, unit: 'Hz', curve: 'log' },
      { key: 'm2Gain', label: 'Mid2 G', min: -18, max: 18, def: 0, unit: 'dB' },
      { key: 'm2Q', label: 'Mid2 Q', min: 0.2, max: 10, def: 1, unit: '', curve: 'log' },
      { key: 'highFreq', label: 'High F', min: 1500, max: 18000, def: 8000, unit: 'Hz', curve: 'log' },
      { key: 'highGain', label: 'High G', min: -18, max: 18, def: 0, unit: 'dB' },
      { key: 'lpf', label: 'LPF', min: 1000, max: 20000, def: 20000, unit: 'Hz', curve: 'log' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'eq');
    const b = (type) => { const f = ctx.createBiquadFilter(); f.type = type; return f; };
    this.hp = b('highpass'); this.hp.Q.value = 0.707;
    this.ls = b('lowshelf'); this.m1 = b('peaking'); this.m2 = b('peaking'); this.hs = b('highshelf');
    this.lp = b('lowpass'); this.lp.Q.value = 0.707;
    this.wetIn = this.hp;
    this.hp.connect(this.ls).connect(this.m1).connect(this.m2).connect(this.hs).connect(this.lp).connect(this.output);
  }
  apply(k, v, i) {
    const m = { hpf: [this.hp.frequency], lowFreq: [this.ls.frequency], lowGain: [this.ls.gain],
      m1Freq: [this.m1.frequency], m1Gain: [this.m1.gain], m1Q: [this.m1.Q],
      m2Freq: [this.m2.frequency], m2Gain: [this.m2.gain], m2Q: [this.m2.Q],
      highFreq: [this.hs.frequency], highGain: [this.hs.gain], lpf: [this.lp.frequency] }[k];
    if (m) this.p(m[0], v, i);
  }
  // magnitude response for UI drawing
  response(freqs) {
    const mag = new Float32Array(freqs.length).fill(1), tmp = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    for (const f of [this.hp, this.ls, this.m1, this.m2, this.hs, this.lp]) {
      f.getFrequencyResponse(freqs, tmp, ph);
      for (let i = 0; i < mag.length; i++) mag[i] *= tmp[i];
    }
    return mag;
  }
}

// ---------------------------------------------------------------- Compressor
export class Compressor extends Effect {
  static get label() { return 'Compressor'; }
  static get params() {
    return [
      { key: 'threshold', label: 'Thresh', min: -60, max: 0, def: -18, unit: 'dB' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, def: 3, unit: ':1', curve: 'log' },
      { key: 'attack', label: 'Attack', min: 0.1, max: 200, def: 10, unit: 'ms', curve: 'log' },
      { key: 'release', label: 'Release', min: 10, max: 1000, def: 120, unit: 'ms', curve: 'log' },
      { key: 'knee', label: 'Knee', min: 0, max: 30, def: 6, unit: 'dB' },
      { key: 'makeup', label: 'Makeup', min: -12, max: 24, def: 0, unit: 'dB' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'compressor');
    this.wetIn = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.makeup = ctx.createGain();
    this.wet = ctx.createGain(); this.dry = ctx.createGain();
    this.wetIn.connect(this.comp).connect(this.makeup).connect(this.wet).connect(this.output);
    this.wetIn.connect(this.dry).connect(this.output);
  }
  apply(k, v, i) {
    const c = this.comp;
    if (k === 'threshold') this.p(c.threshold, v, i);
    else if (k === 'ratio') this.p(c.ratio, v, i);
    else if (k === 'attack') this.p(c.attack, v / 1000, i);
    else if (k === 'release') this.p(c.release, v / 1000, i);
    else if (k === 'knee') this.p(c.knee, v, i);
    else if (k === 'makeup') this.p(this.makeup.gain, dbToLin(v), i);
    else if (k === 'mix') { this.p(this.wet.gain, v / 100, i); this.p(this.dry.gain, 1 - v / 100, i); }
  }
  getReduction() { return -this.comp.reduction; }
}

// soft/hard clip curves operating on a pre-scaled range of +-range
function clipCurve(ceilLin, range, hardness) {
  const n = 4096, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * range;
    let y;
    if (hardness >= 1) y = Math.max(-ceilLin, Math.min(ceilLin, x));
    else {
      // blend of linear-until-knee + tanh saturation above the knee
      const knee = ceilLin * (1 - 0.5 * (1 - hardness));
      const ax = Math.abs(x);
      if (ax <= knee) y = x;
      else y = Math.sign(x) * (knee + (ceilLin - knee) * Math.tanh((ax - knee) / (ceilLin - knee + 1e-9)));
    }
    c[i] = y;
  }
  return c;
}

// ---------------------------------------------------------------- Maximizer
export class Maximizer extends Effect {
  static get label() { return 'Maximizer'; }
  static get params() {
    return [
      { key: 'gain', label: 'Gain', min: 0, max: 24, def: 3, unit: 'dB' },
      { key: 'ceiling', label: 'Ceiling', min: -12, max: 0, def: -0.3, unit: 'dB' },
      { key: 'release', label: 'Release', min: 10, max: 500, def: 60, unit: 'ms', curve: 'log' },
      { key: 'character', label: 'Soft', min: 0, max: 100, def: 50, unit: '%' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'maximizer');
    this.RANGE = 8;
    this.pre = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.ratio.value = 12; this.comp.attack.value = 0.002; this.comp.knee.value = 4;
    this.scaleDown = ctx.createGain(); this.scaleDown.gain.value = 1 / this.RANGE;
    this.shaper = ctx.createWaveShaper(); this.shaper.oversample = '4x';
    this.wetIn = this.pre;
    this.pre.connect(this.comp).connect(this.scaleDown).connect(this.shaper).connect(this.output);
  }
  apply(k, v, i) {
    if (k === 'gain') this.p(this.pre.gain, dbToLin(v), i);
    else if (k === 'release') this.p(this.comp.release, v / 1000, i);
    if (k === 'ceiling' || k === 'character') {
      const ceil = this.values.ceiling != null ? this.values.ceiling : -0.3;
      this.p(this.comp.threshold, ceil - 4, true);
      const soft = (this.values.character != null ? this.values.character : 50) / 100;
      this.shaper.curve = clipCurve(dbToLin(ceil), this.RANGE, 1 - soft * 0.9);
    }
  }
  getReduction() { return -this.comp.reduction; }
}

// ---------------------------------------------------------------- Limiter
export class Limiter extends Effect {
  static get label() { return 'Limiter'; }
  static get params() {
    return [
      { key: 'input', label: 'Input', min: -12, max: 18, def: 0, unit: 'dB' },
      { key: 'ceiling', label: 'Ceiling', min: -12, max: 0, def: -0.1, unit: 'dB' },
      { key: 'release', label: 'Release', min: 5, max: 500, def: 50, unit: 'ms', curve: 'log' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'limiter');
    this.RANGE = 8;
    this.pre = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.ratio.value = 20; this.comp.attack.value = 0.0005; this.comp.knee.value = 0;
    this.scaleDown = ctx.createGain(); this.scaleDown.gain.value = 1 / this.RANGE;
    this.clip = ctx.createWaveShaper(); this.clip.oversample = '4x';
    this.wetIn = this.pre;
    this.pre.connect(this.comp).connect(this.scaleDown).connect(this.clip).connect(this.output);
  }
  apply(k, v, i) {
    if (k === 'input') this.p(this.pre.gain, dbToLin(v), i);
    else if (k === 'release') this.p(this.comp.release, v / 1000, i);
    else if (k === 'ceiling') {
      this.p(this.comp.threshold, v - 1, true);
      this.clip.curve = clipCurve(dbToLin(v), this.RANGE, 1); // safety clipper = hard ceiling
    }
  }
  getReduction() { return -this.comp.reduction; }
}

// ---------------------------------------------------------------- Delay
export const SYNC_OPTIONS = ['off', '1/4', '1/8', '1/8d', '1/16', '1/4t', '1/2'];
const SYNC_BEATS = { '1/4': 1, '1/8': 0.5, '1/8d': 0.75, '1/16': 0.25, '1/4t': 2 / 3, '1/2': 2 };
export class Delay extends Effect {
  static get label() { return 'Delay'; }
  static get params() {
    return [
      { key: 'sync', label: 'Sync', type: 'select', options: SYNC_OPTIONS, def: '1/8d' },
      { key: 'time', label: 'Time', min: 10, max: 2000, def: 350, unit: 'ms', curve: 'log' },
      { key: 'feedback', label: 'Fdbk', min: 0, max: 95, def: 35, unit: '%' },
      { key: 'tone', label: 'Tone', min: 500, max: 16000, def: 5000, unit: 'Hz', curve: 'log' },
      { key: 'pingpong', label: 'Ping', type: 'select', options: ['off', 'on'], def: 'off' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, def: 25, unit: '%' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'delay');
    this.bpm = 120;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.wetIn = g(); this.dry = g(); this.wet = g();
    this.dL = ctx.createDelay(4); this.dR = ctx.createDelay(4);
    this.lpL = ctx.createBiquadFilter(); this.lpR = ctx.createBiquadFilter();
    this.lpL.type = this.lpR.type = 'lowpass';
    this.inL = g(); this.inR = g();
    this.fbLL = g(); this.fbRR = g(); this.fbLR = g(); this.fbRL = g();
    this.merger = ctx.createChannelMerger(2);
    this.mono = g(); this.mono.channelCount = 1; this.mono.channelCountMode = 'explicit'; this.mono.channelInterpretation = 'speakers';
    this.wetIn.connect(this.dry).connect(this.output);
    this.wetIn.connect(this.mono);
    this.mono.connect(this.inL).connect(this.dL); this.mono.connect(this.inR).connect(this.dR);
    this.dL.connect(this.lpL); this.dR.connect(this.lpR);
    this.lpL.connect(this.fbLL).connect(this.dL); this.lpR.connect(this.fbRR).connect(this.dR);
    this.lpL.connect(this.fbLR).connect(this.dR); this.lpR.connect(this.fbRL).connect(this.dL);
    this.lpL.connect(this.merger, 0, 0); this.lpR.connect(this.merger, 0, 1);
    this.merger.connect(this.wet).connect(this.output);
  }
  setBpm(bpm) { this.bpm = bpm; this.apply('time', this.values.time, false); }
  delayTime() {
    const s = this.values.sync;
    if (s && s !== 'off' && SYNC_BEATS[s]) return (60 / this.bpm) * SYNC_BEATS[s];
    return (this.values.time || 350) / 1000;
  }
  apply(k, v, i) {
    if (k === 'time' || k === 'sync') {
      const t = Math.min(3.9, this.delayTime());
      this.p(this.dL.delayTime, t, i); this.p(this.dR.delayTime, t, i);
    } else if (k === 'tone') { this.p(this.lpL.frequency, v, i); this.p(this.lpR.frequency, v, i); }
    else if (k === 'mix') { this.p(this.wet.gain, v / 100, i); this.p(this.dry.gain, 1 - (v / 100) * 0.5, i); }
    if (k === 'feedback' || k === 'pingpong') {
      const fb = (this.values.feedback || 0) / 100;
      const pp = this.values.pingpong === 'on';
      this.p(this.fbLL.gain, pp ? 0 : fb, i); this.p(this.fbRR.gain, pp ? 0 : fb, i);
      this.p(this.fbLR.gain, pp ? fb : 0, i); this.p(this.fbRL.gain, pp ? fb : 0, i);
      this.p(this.inR.gain, pp ? 0 : 1, i);
    }
  }
}

// ---------------------------------------------------------------- Convolution reverb
export class Reverb extends Effect {
  static get label() { return 'Reverb'; }
  static get params() {
    return [
      { key: 'space', label: 'Space', type: 'select', options: Object.keys(IR_TYPES), def: 'hall' },
      { key: 'decay', label: 'Decay', min: 0.2, max: 8, def: 2.4, unit: 's', curve: 'log' },
      { key: 'predelay', label: 'Pre', min: 0, max: 200, def: 15, unit: 'ms' },
      { key: 'lowcut', label: 'LoCut', min: 20, max: 1000, def: 150, unit: 'Hz', curve: 'log' },
      { key: 'tone', label: 'Tone', min: 1000, max: 20000, def: 9000, unit: 'Hz', curve: 'log' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, def: 20, unit: '%' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'reverb');
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.wetIn = g(); this.dry = g(); this.wet = g();
    this.pre = ctx.createDelay(1);
    this.conv = ctx.createConvolver();
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass';
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass';
    this.wetIn.connect(this.dry).connect(this.output);
    this.wetIn.connect(this.pre).connect(this.hp).connect(this.conv).connect(this.lp).connect(this.wet).connect(this.output);
    this._irTimer = null;
  }
  regen(instant) {
    clearTimeout(this._irTimer);
    const run = () => { this.conv.buffer = generateIR(this.ctx, this.values.space || 'hall', { decay: this.values.decay }); };
    if (instant) run(); else this._irTimer = setTimeout(run, 150);
  }
  apply(k, v, i) {
    if (k === 'space' || k === 'decay') { if (this.values.space && this.values.decay) this.regen(i); }
    else if (k === 'predelay') this.p(this.pre.delayTime, v / 1000, i);
    else if (k === 'lowcut') this.p(this.hp.frequency, v, i);
    else if (k === 'tone') this.p(this.lp.frequency, v, i);
    else if (k === 'mix') { this.p(this.wet.gain, v / 100, i); this.p(this.dry.gain, 1 - (v / 100) * 0.5, i); }
  }
}

// ---------------------------------------------------------------- Amp / Distortion
// Voicings define stage count, total gain range, pre-EQ and default character.
export const VOICINGS = {
  clean:     { label: 'Clean',     stages: 1, maxDb: 14, tight: 70, midF: 700, midG: 1, bias: 0.03 },
  overdrive: { label: 'Overdrive', stages: 1, maxDb: 30, tight: 80, midF: 800, midG: 5, bias: 0.15 },
  crunch:    { label: 'Crunch',    stages: 2, maxDb: 45, tight: 100, midF: 900, midG: 4, bias: 0.1 },
  highgain:  { label: 'High Gain', stages: 3, maxDb: 62, tight: 140, midF: 1000, midG: 6, bias: 0.08 },
  death:     { label: 'Death Metal', stages: 4, maxDb: 78, tight: 190, midF: 1200, midG: 8, bias: 0.05 },
};
export const CABS = {
  off:    { label: 'Off' },
  combo:  { label: '1x12 Combo', hp: 90, bump: [110, 2, 1], dip: [500, -3, 1.2], pres: [2200, 3, 1.2], lp: 5500 },
  open:   { label: '2x12 Open', hp: 75, bump: [100, 1.5, 1], dip: [420, -4, 1.0], pres: [2600, 4, 1.4], lp: 6500 },
  closed: { label: '4x12 Closed', hp: 70, bump: [95, 4, 1.2], dip: [380, -6, 1.2], pres: [2800, 5, 1.6], lp: 4800 },
};

function stageCurve(bias, hardness) {
  const n = 8192, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; // input already scaled into +-1 domain representing +-8
    const xs = x * 8 + bias;          // asymmetric bias = even harmonics (tube-like)
    let y = hardness > 0.5 ? (2 / Math.PI) * Math.atan(xs * 1.6) : Math.tanh(xs);
    y -= hardness > 0.5 ? (2 / Math.PI) * Math.atan(bias * 1.6) : Math.tanh(bias); // remove DC
    c[i] = y;
  }
  return c;
}

export class Distortion extends Effect {
  static get label() { return 'Distortion'; }
  static get params() {
    return [
      { key: 'voicing', label: 'Voice', type: 'select', options: Object.keys(VOICINGS), def: 'crunch' },
      { key: 'gate', label: 'Gate', min: -90, max: -20, def: -70, unit: 'dB' },
      { key: 'drive', label: 'Drive', min: 0, max: 100, def: 50, unit: '%' },
      { key: 'tight', label: 'Tight', min: 20, max: 400, def: 100, unit: 'Hz', curve: 'log' },
      { key: 'bass', label: 'Bass', min: -12, max: 12, def: 0, unit: 'dB' },
      { key: 'mid', label: 'Mid', min: -12, max: 12, def: 0, unit: 'dB' },
      { key: 'treble', label: 'Treble', min: -12, max: 12, def: 0, unit: 'dB' },
      { key: 'presence', label: 'Pres', min: -12, max: 12, def: 2, unit: 'dB' },
      { key: 'cab', label: 'Cab', type: 'select', options: Object.keys(CABS), def: 'closed' },
      { key: 'level', label: 'Level', min: -30, max: 12, def: 0, unit: 'dB' },
    ];
  }
  constructor(ctx, gateAvailable = true) {
    super(ctx, 'distortion');
    const bq = (type, f, g = 0, q = 0.707) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.gain.value = g; n.Q.value = q; return n; };
    this.wetIn = ctx.createGain();
    try {
      this.gateNode = new AudioWorkletNode(ctx, 'gate-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    } catch (e) { this.gateNode = ctx.createGain(); this.gateNode._fallback = true; }
    this.preHP = bq('highpass', 100);
    this.preMid = bq('peaking', 900, 4, 0.9);
    this.preLP = bq('lowpass', 7000);
    this.stages = [];
    for (let s = 0; s < 4; s++) {
      const gain = ctx.createGain();
      const scale = ctx.createGain(); scale.gain.value = 1 / 8;
      const shaper = ctx.createWaveShaper(); shaper.oversample = '4x';
      const post = bq('highpass', 30 + s * 15); // interstage coupling (DC + low tightening)
      const lp = bq('lowpass', 9000 - s * 1200);
      gain.connect(scale).connect(shaper).connect(post).connect(lp);
      this.stages.push({ gain, scale, shaper, post, lp });
    }
    this.bass = bq('lowshelf', 120); this.mid = bq('peaking', 650, 0, 0.7); this.treble = bq('highshelf', 3200); this.presence = bq('peaking', 4500, 0, 0.8);
    this.cabIn = ctx.createGain();
    this.cab = [bq('highpass', 80), bq('peaking', 100), bq('peaking', 400), bq('peaking', 2500), bq('lowpass', 5000, 0, 0.9), bq('lowpass', 5000, 0, 0.6)];
    this.cabOut = ctx.createGain();
    this.level = ctx.createGain();
    this.wetIn.connect(this.gateNode).connect(this.preHP).connect(this.preMid).connect(this.preLP);
    this.bass.connect(this.mid).connect(this.treble).connect(this.presence).connect(this.cabIn);
    this.cabOut.connect(this.level).connect(this.output);
  }
  rewire() {
    const v = VOICINGS[this.values.voicing] || VOICINGS.crunch;
    try { this.preLP.disconnect(); } catch (e) {}
    this.stages.forEach((s) => { try { s.lp.disconnect(); } catch (e) {} });
    let node = this.preLP;
    for (let i = 0; i < v.stages; i++) { node.connect(this.stages[i].gain); node = this.stages[i].lp; }
    node.connect(this.bass);
    this.stages.forEach((s, i) => { s.shaper.curve = stageCurve(i === 0 ? v.bias : v.bias * 0.5, i >= 2 ? 1 : 0); });
    this.p(this.preMid.frequency, v.midF, true); this.p(this.preMid.gain, v.midG, true);
    this.applyDrive(true);
  }
  applyDrive(i) {
    const v = VOICINGS[this.values.voicing] || VOICINGS.crunch;
    const totalDb = 6 + (this.values.drive / 100) * v.maxDb;
    const per = totalDb / v.stages;
    for (let s = 0; s < 4; s++) this.p(this.stages[s].gain.gain, dbToLin(s === 0 ? per : per - 6), i);
    // loudness compensation: saturated output ~ +-1 → bring down
    this.p(this.level.gain, dbToLin((this.values.level || 0) - 14), i);
  }
  applyCab() {
    try { this.cabIn.disconnect(); this.cab.forEach((f) => f.disconnect()); } catch (e) {}
    const c = CABS[this.values.cab] || CABS.off;
    if (!c.hp) { this.cabIn.connect(this.cabOut); return; }
    const [hp, bump, dip, pres, lp1, lp2] = this.cab;
    hp.frequency.value = c.hp;
    bump.frequency.value = c.bump[0]; bump.gain.value = c.bump[1]; bump.Q.value = c.bump[2];
    dip.frequency.value = c.dip[0]; dip.gain.value = c.dip[1]; dip.Q.value = c.dip[2];
    pres.frequency.value = c.pres[0]; pres.gain.value = c.pres[1]; pres.Q.value = c.pres[2];
    lp1.frequency.value = c.lp; lp2.frequency.value = c.lp * 1.1;
    this.cabIn.connect(hp).connect(bump).connect(dip).connect(pres).connect(lp1).connect(lp2).connect(this.cabOut);
  }
  apply(k, v, i) {
    if (k === 'voicing') { if (this.values.drive != null) this.rewire(); }
    else if (k === 'drive' || k === 'level') { if (this.values.voicing) this.applyDrive(i); }
    else if (k === 'gate') { if (!this.gateNode._fallback) this.p(this.gateNode.parameters.get('threshold'), v, i); }
    else if (k === 'tight') this.p(this.preHP.frequency, v, i);
    else if (k === 'bass') this.p(this.bass.gain, v, i);
    else if (k === 'mid') this.p(this.mid.gain, v, i);
    else if (k === 'treble') this.p(this.treble.gain, v, i);
    else if (k === 'presence') this.p(this.presence.gain, v, i);
    else if (k === 'cab') this.applyCab();
  }
  init(values) { super.init(values); this.rewire(); this.applyCab(); return this; }
}

// ---------------------------------------------------------------- Pitch correction (auto-tune style)
export class PitchCorrect extends Effect {
  static get label() { return 'Pitch Correct'; }
  static get params() {
    return [
      { key: 'keySource', label: 'Key from', type: 'select', options: ['global', 'manual'], def: 'global' },
      { key: 'root', label: 'Key', type: 'select', options: NOTE_NAMES, def: 'C' },
      { key: 'scale', label: 'Scale', type: 'select', options: Object.keys(SCALES), def: 'major' },
      { key: 'speed', label: 'Speed', min: 0, max: 400, def: 40, unit: 'ms', help: 'Retune speed: 0 = hard robotic snap, higher = more natural.' },
      { key: 'humanize', label: 'Human', min: 0, max: 100, def: 30, unit: '%', help: 'Leaves small deviations (vibrato, scoops) partly uncorrected.' },
      { key: 'amount', label: 'Amount', min: 0, max: 100, def: 100, unit: '%' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'pitch');
    this.readout = { f0: 0, target: 0, targetNote: null, conf: 0, level: 0, shift: 0 };
    this.history = [];
    this.globalKey = { root: 0, scale: 'major' };
    this.wetIn = ctx.createGain();
    const onReport = (r) => { this.readout = r; this.history.push([r.f0 ? 69 + 12 * Math.log2(r.f0 / 440) : 0, r.target || 0]); if (this.history.length > 240) this.history.shift(); if (this.onSnap && r.targetNote != null && r.targetNote !== this._lastNote) this.onSnap(r.targetNote); this._lastNote = r.targetNote; };
    try {
      this.node = new AudioWorkletNode(ctx, 'pitch-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.port.onmessage = (e) => onReport(e.data);
      this.send = (key, value) => this.node.port.postMessage({ type: 'set', key, value });
      this.engineKind = 'AudioWorklet';
    } catch (e) {
      // fallback: same DSP on the main thread via ScriptProcessorNode (more latency/jank risk)
      const dsp = new PitchCorrectorDSP(ctx.sampleRate); dsp.onReport = onReport;
      this.node = ctx.createScriptProcessor(1024, 2, 2);
      const mono = new Float32Array(1024);
      this.node.onaudioprocess = (ev) => {
        const ib = ev.inputBuffer, a = ib.getChannelData(0), b = ib.numberOfChannels > 1 ? ib.getChannelData(1) : a;
        for (let i = 0; i < a.length; i++) mono[i] = 0.5 * (a[i] + b[i]);
        dsp.process(mono, ev.outputBuffer.getChannelData(0), ev.outputBuffer.getChannelData(1));
      };
      this.send = (key, value) => dsp.set(key, value);
      this.engineKind = 'ScriptProcessor fallback';
    }
    this.wetIn.connect(this.node).connect(this.output);
  }
  setGlobalKey(k) { if (k) { this.globalKey = k; this.pushKey(); } }
  pushKey() {
    const g = this.values.keySource !== 'manual';
    this.send('root', g ? this.globalKey.root : Math.max(0, NOTE_NAMES.indexOf(this.values.root)));
    this.send('scale', g ? this.globalKey.scale : this.values.scale);
  }
  apply(k, v) {
    if (k === 'keySource' || k === 'root' || k === 'scale') this.pushKey();
    else if (this.send) this.send(k, v);
  }
  dispose() { super.dispose(); try { this.node.disconnect(); if (this.node.port && this.node.port.close) this.node.port.close(); this.node.onaudioprocess = null; } catch (e) {} }
}

// ---------------------------------------------------------------- Modulation effects (tempo-syncable LFOs)
export const LFO_SYNC = ['off', '4/1', '2/1', '1/1', '1/2', '1/4', '1/8', '1/16', '1/4t', '1/8t', '1/8d'];
const LFO_BEATS = { '4/1': 16, '2/1': 8, '1/1': 4, '1/2': 2, '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/4t': 2 / 3, '1/8t': 1 / 3, '1/8d': 0.75 };
class LfoEffect extends Effect {
  constructor(ctx, type) { super(ctx, type); this.bpm = 120; this.lfo = ctx.createOscillator(); this.lfo.start(); }
  setBpm(bpm) { this.bpm = bpm; this.applyRate(false); }
  lfoHz() { const s = this.values.sync; return s && s !== 'off' && LFO_BEATS[s] ? 1 / ((60 / this.bpm) * LFO_BEATS[s]) : this.values.rate || 1; }
  applyRate(i) { this.p(this.lfo.frequency, this.lfoHz(), i); }
  dispose() { super.dispose(); try { this.lfo.stop(); } catch (e) {} }
}
export class Chorus extends LfoEffect {
  static get label() { return 'Chorus'; }
  static get params() {
    return [
      { key: 'rate', label: 'Rate', min: 0.05, max: 8, def: 0.6, unit: 'Hz', curve: 'log' },
      { key: 'depth', label: 'Depth', min: 0, max: 100, def: 45, unit: '%' },
      { key: 'delay', label: 'Delay', min: 4, max: 30, def: 14, unit: 'ms' },
      { key: 'feedback', label: 'Fdbk', min: 0, max: 70, def: 10, unit: '%' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, def: 45, unit: '%' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'chorus');
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.wetIn = g(); this.dry = g(); this.wet = g(); this.mono = g(); this.mono.channelCount = 1; this.mono.channelCountMode = 'explicit';
    this.dL = ctx.createDelay(0.1); this.dR = ctx.createDelay(0.1);
    this.lfo2 = ctx.createOscillator(); this.lfo2.start();
    this.modL = g(0); this.modR = g(0); this.fbL = g(0); this.fbR = g(0);
    this.merger = ctx.createChannelMerger(2);
    this.wetIn.connect(this.dry).connect(this.output);
    this.wetIn.connect(this.mono); this.mono.connect(this.dL); this.mono.connect(this.dR);
    this.lfo.connect(this.modL).connect(this.dL.delayTime); this.lfo2.connect(this.modR).connect(this.dR.delayTime);
    this.dL.connect(this.fbL).connect(this.dL); this.dR.connect(this.fbR).connect(this.dR);
    this.dL.connect(this.merger, 0, 0); this.dR.connect(this.merger, 0, 1); this.merger.connect(this.wet).connect(this.output);
  }
  applyRate(i) { super.applyRate(i); this.p(this.lfo2.frequency, this.lfoHz() * 1.13, i); }
  apply(k, v, i) {
    if (k === 'rate') this.applyRate(i);
    else if (k === 'delay' || k === 'depth') { const d = (this.values.delay || 14) / 1000, m = d * 0.85 * (this.values.depth || 0) / 100; this.p(this.dL.delayTime, d, i); this.p(this.dR.delayTime, d * 1.07, i); this.p(this.modL.gain, m, i); this.p(this.modR.gain, m, i); }
    else if (k === 'feedback') { this.p(this.fbL.gain, v / 100, i); this.p(this.fbR.gain, v / 100, i); }
    else if (k === 'mix') { this.p(this.wet.gain, v / 100, i); this.p(this.dry.gain, 1 - (v / 100) * 0.5, i); }
  }
  dispose() { super.dispose(); try { this.lfo2.stop(); } catch (e) {} }
}
export class AutoPan extends LfoEffect {
  static get label() { return 'Auto-Pan'; }
  static get params() {
    return [
      { key: 'sync', label: 'Sync', type: 'select', options: LFO_SYNC, def: '1/4' },
      { key: 'rate', label: 'Rate', min: 0.05, max: 16, def: 1, unit: 'Hz', curve: 'log', help: 'Speed when Sync is off.' },
      { key: 'depth', label: 'Depth', min: 0, max: 100, def: 60, unit: '%' },
      { key: 'shape', label: 'Shape', type: 'select', options: ['sine', 'triangle', 'square'], def: 'sine' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'autopan');
    this.wetIn = ctx.createGain(); this.pan = ctx.createStereoPanner(); this.depth = ctx.createGain(); this.depth.gain.value = 0;
    this.wetIn.connect(this.pan).connect(this.output); this.lfo.connect(this.depth).connect(this.pan.pan);
  }
  apply(k, v, i) {
    if (k === 'sync' || k === 'rate') this.applyRate(i);
    else if (k === 'depth') this.p(this.depth.gain, v / 100, i);
    else if (k === 'shape') this.lfo.type = v;
  }
}
export class Tremolo extends LfoEffect {
  static get label() { return 'Tremolo'; }
  static get params() {
    return [
      { key: 'sync', label: 'Sync', type: 'select', options: LFO_SYNC, def: '1/8' },
      { key: 'rate', label: 'Rate', min: 0.1, max: 20, def: 5, unit: 'Hz', curve: 'log', help: 'Speed when Sync is off.' },
      { key: 'depth', label: 'Depth', min: 0, max: 100, def: 50, unit: '%' },
      { key: 'shape', label: 'Shape', type: 'select', options: ['sine', 'triangle', 'square'], def: 'sine' },
    ];
  }
  constructor(ctx) {
    super(ctx, 'tremolo');
    this.wetIn = ctx.createGain(); this.vca = ctx.createGain(); this.depth = ctx.createGain(); this.depth.gain.value = 0;
    this.smooth = ctx.createBiquadFilter(); this.smooth.type = 'lowpass'; this.smooth.frequency.value = 120; // de-click square LFO
    this.wetIn.connect(this.vca).connect(this.output); this.lfo.connect(this.smooth).connect(this.depth).connect(this.vca.gain);
  }
  apply(k, v, i) {
    if (k === 'sync' || k === 'rate') this.applyRate(i);
    else if (k === 'depth') { this.p(this.depth.gain, v / 200, i); this.p(this.vca.gain, 1 - v / 200, i); }
    else if (k === 'shape') this.lfo.type = v;
  }
}
// Guitar amp: same multi-stage tube-ish engine as the distortion, presented as an amp with channels
const AMP_CH = { clean: 'clean', crunch: 'crunch', lead: 'highgain', metal: 'death' };
export class Amp extends Distortion {
  static get label() { return 'Amp'; }
  static get params() {
    return [
      { key: 'channel', label: 'Channel', type: 'select', options: Object.keys(AMP_CH), def: 'crunch' },
      { key: 'gain', label: 'Gain', min: 0, max: 100, def: 45, unit: '%' },
      { key: 'bass', label: 'Bass', min: -12, max: 12, def: 0, unit: 'dB' },
      { key: 'mid', label: 'Mid', min: -12, max: 12, def: 0, unit: 'dB' },
      { key: 'treble', label: 'Treble', min: -12, max: 12, def: 0, unit: 'dB' },
      { key: 'presence', label: 'Pres', min: -12, max: 12, def: 1, unit: 'dB' },
      { key: 'gate', label: 'Gate', min: -90, max: -20, def: -75, unit: 'dB' },
      { key: 'cab', label: 'Cab', type: 'select', options: Object.keys(CABS), def: 'combo' },
      { key: 'master', label: 'Master', min: -30, max: 12, def: 0, unit: 'dB' },
    ];
  }
  constructor(ctx) { super(ctx); this.type = 'amp'; }
  apply(k, v, i) {
    if (k === 'channel') { const voice = AMP_CH[v] || 'crunch'; this.values.voicing = voice; this.values.tight = VOICINGS[voice].tight; super.apply('tight', this.values.tight, i); super.apply('voicing', voice, i); }
    else if (k === 'gain') { this.values.drive = v; super.apply('drive', v, i); }
    else if (k === 'master') { this.values.level = v + (this.values.channel === 'clean' ? 6 : 0); super.apply('level', v, i); }
    else super.apply(k, v, i);
  }
  toJSON() { const o = super.toJSON(); ['voicing', 'drive', 'level', 'tight'].forEach((k) => delete o.values[k]); return o; }
}

// ---------------------------------------------------------------- Audio rack: parallel chains + macros
export const RACK_LIMITS = { chains: 6, fxPerChain: 8, macros: 4, maps: 32 };
export class Rack extends Effect {
  static get label() { return 'Rack'; }
  static get params() {
    return [0, 1, 2, 3].map((m) => ({ key: 'macro' + (m + 1), label: 'Macro ' + (m + 1), min: 0, max: 100, def: 0, unit: '%', help: 'Macro knob: controls every parameter mapped to it inside the rack.' }));
  }
  constructor(ctx) { super(ctx, 'rack'); this.wetIn = ctx.createGain(); this.chains = []; this.rdef = { chains: [], macroMap: [] }; this.bpm = 120; this.key = null; }
  // called by createEffect with the stored device definition (chains + macro mappings)
  setDef(def) {
    this.rdef = def; def.chains = def.chains || []; def.macroMap = def.macroMap || [];
    this.chains.forEach((c) => this.disposeChain(c)); this.chains = def.chains.map((cd) => this.buildChain(cd));
    for (let m = 0; m < 4; m++) this.applyMacro(m, true);
  }
  buildChain(cd) {
    const ctx = this.ctx; cd.fx = cd.fx || [];
    const c = { def: cd, input: ctx.createGain(), fx: [], vol: ctx.createGain(), pan: ctx.createStereoPanner(), mute: ctx.createGain() };
    c.fx = cd.fx.filter((d) => d.type !== 'rack' && EFFECT_TYPES[d.type]).map((d) => { const f = createEffect(ctx, d.type, d.values, d.enabled !== false); d.values = f.values; return f; });
    this.wireChain(c);
    c.vol.connect(c.pan).connect(c.mute).connect(this.output);
    this.wetIn.connect(c.input);
    this.syncChain(c, true);
    return c;
  }
  wireChain(c) {
    try { c.input.disconnect(); } catch (e) {} c.fx.forEach((f) => { try { f.output.disconnect(); } catch (e) {} });
    let n = c.input; for (const f of c.fx) { n.connect(f.input); n = f.output; } n.connect(c.vol);
    c.fx.forEach((f) => { if (f.setBpm) f.setBpm(this.bpm); if (f.setGlobalKey && this.key) f.setGlobalKey(this.key); });
  }
  syncChain(c, i) { const d = c.def; this.p(c.vol.gain, Math.pow(10, (d.volume || 0) / 20), i); this.p(c.pan.pan, d.pan || 0, i); this.p(c.mute.gain, d.mute ? 0 : 1, i); }
  rebuildChain(ci) { const old = this.chains[ci]; if (old) this.disposeChain(old); this.chains[ci] = this.buildChain(this.rdef.chains[ci]); }
  addChain(cd) { this.rdef.chains.push(cd); this.chains.push(this.buildChain(cd)); }
  removeChain(ci) { const c = this.chains[ci]; if (c) this.disposeChain(c); this.chains.splice(ci, 1); this.rdef.chains.splice(ci, 1); this.rdef.macroMap = this.rdef.macroMap.filter((m) => m.chain !== ci).map((m) => (m.chain > ci ? { ...m, chain: m.chain - 1 } : m)); }
  disposeChain(c) { try { this.wetIn.disconnect(c.input); } catch (e) {} c.fx.forEach((f) => f.dispose()); [c.input, c.vol, c.pan, c.mute].forEach((n) => { try { n.disconnect(); } catch (e) {} }); }
  innerParam(chain, fx, key) { const f = this.chains[chain] && this.chains[chain].fx[fx]; return f ? [f, f.def.params.find((p) => p.key === key)] : [null, null]; }
  applyMacro(m, instant = false) {
    const v = (this.values['macro' + (m + 1)] || 0) / 100; const changed = [];
    for (const map of this.rdef.macroMap) {
      if (map.macro !== m) continue;
      const [f, p] = this.innerParam(map.chain, map.fx, map.key); if (!f || !p) continue;
      let val;
      if (p.type === 'select') val = p.options[Math.min(p.options.length - 1, Math.floor(v * p.options.length))];
      else if (p.curve === 'log' && map.min > 0 && map.max > 0) val = map.min * Math.pow(map.max / map.min, v);
      else val = map.min + (map.max - map.min) * v;
      if (f.values[map.key] !== val) { f.set(map.key, val); changed.push(map); }
    }
    if (changed.length && this.onMacro && !instant) this.onMacro(changed);
  }
  apply(k) { const m = /^macro(\d)$/.exec(k); if (m && this.rdef) this.applyMacro(+m[1] - 1); }
  setBpm(bpm) { this.bpm = bpm; this.chains.forEach((c) => c.fx.forEach((f) => f.setBpm && f.setBpm(bpm))); }
  setGlobalKey(k) { this.key = k; this.chains.forEach((c) => c.fx.forEach((f) => f.setGlobalKey && f.setGlobalKey(k))); }
  getReduction() { let r = 0; this.chains.forEach((c) => c.fx.forEach((f) => { r = Math.max(r, f.getReduction()); })); return r; }
  toJSON() { return { ...super.toJSON(), chains: this.rdef.chains, macroMap: this.rdef.macroMap }; }
  dispose() { this.chains.forEach((c) => this.disposeChain(c)); super.dispose(); }
}

export const EFFECT_TYPES = {
  pitch: PitchCorrect,
  eq: ParametricEQ,
  compressor: Compressor,
  distortion: Distortion,
  delay: Delay,
  reverb: Reverb,
  maximizer: Maximizer,
  limiter: Limiter,
  amp: Amp,
  chorus: Chorus,
  autopan: AutoPan,
  tremolo: Tremolo,
  rack: Rack,
};

export function createEffect(ctx, type, values, enabled = true, def = null) {
  const C = EFFECT_TYPES[type];
  if (!C) throw new Error('Unknown effect ' + type);
  const fx = new C(ctx);
  fx.init(values || {});
  if (type === 'rack') fx.setDef(def || { chains: [], macroMap: [] });
  if (!enabled) fx.setEnabled(false);
  return fx;
}

// Parameters shown in Easy Mode, and short help texts (tooltips / help mode).
export const EASY_PARAMS = {
  pitch: ['speed', 'humanize', 'mix'], amp: ['channel', 'gain', 'bass', 'mid', 'treble', 'master'], chorus: ['rate', 'depth', 'mix'], autopan: ['sync', 'depth'], tremolo: ['sync', 'depth'], rack: ['macro1', 'macro2', 'macro3', 'macro4'], eq: ['lowGain', 'm1Gain', 'm2Gain', 'highGain'], compressor: ['threshold', 'ratio', 'makeup'], distortion: ['voicing', 'drive', 'level'],
  delay: ['sync', 'feedback', 'mix'], reverb: ['space', 'decay', 'mix'], maximizer: ['gain', 'ceiling'], limiter: ['input', 'ceiling'],
};
export const EFFECT_HELP = {
  pitch: 'Pitch Correct: detects the sung/played note and pulls it to the nearest note of the key. Speed 0 = robotic snap. Monophonic sources only.',
  eq: 'Parametric EQ: shape the tone. Boost or cut bass, mids and treble. The display shows the live spectrum and the EQ curve.',
  compressor: 'Compressor: evens out loud and quiet parts. Lower threshold = more compression. The display shows gain reduction over time.',
  distortion: 'Distortion: from light overdrive to extreme high gain, with gate, tone stack and speaker-cabinet simulation.',
  delay: 'Delay: echoes. Sync locks the echo time to the song tempo.',
  reverb: 'Reverb: adds space (room, hall, plate…) using impulse responses generated in the app.',
  maximizer: 'Maximizer: makes the mix louder without clipping.',
  limiter: 'Limiter: hard ceiling so the output never goes above the set level.',
  amp: 'Amp: guitar amp simulation with clean/crunch/lead/metal channels, tone stack and speaker cabinet.',
  chorus: 'Chorus: thickens the sound with slightly detuned, modulated copies (stereo).',
  autopan: 'Auto-Pan: moves the sound left/right; Sync locks the movement to the tempo.',
  tremolo: 'Tremolo: rhythmic volume pulsing; Sync locks it to the tempo.',
  rack: 'Rack: parallel effect chains mixed together, with 4 macro knobs that can control any parameter inside. Save racks as presets.',
};
export const PARAM_HELP = {
  hpf: 'High-pass filter: removes rumble below this frequency.', lpf: 'Low-pass filter: removes hiss above this frequency.',
  threshold: 'Level where compression starts.', ratio: 'How strongly signals above the threshold are reduced.', attack: 'How fast compression reacts.',
  release: 'How fast it recovers.', knee: 'Softness of the compression onset.', makeup: 'Gain added after compression.', mix: 'Blend between dry and processed signal.',
  drive: 'Amount of distortion.', gate: 'Silences noise below this level.', tight: 'Removes low end before distortion for a tighter sound.',
  voicing: 'Distortion character: overdrive, crunch, high gain, death metal.', cab: 'Speaker cabinet simulation.', level: 'Output level.',
  ceiling: 'Maximum output level.', gain: 'Input gain / loudness.', feedback: 'Number of repeats.', sync: 'Echo time in note values.',
  space: 'Type of room.', decay: 'Length of the reverb tail.', predelay: 'Gap before the reverb starts.', tone: 'Brightness.',
};
