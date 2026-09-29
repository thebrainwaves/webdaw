// Built-in effects implemented with native Web Audio nodes (+ an AudioWorklet gate).
import { generateIR, IR_TYPES } from './ir.js';

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
  static get label() { return 'Amp / Distortion'; }
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

export const EFFECT_TYPES = {
  eq: ParametricEQ,
  compressor: Compressor,
  distortion: Distortion,
  delay: Delay,
  reverb: Reverb,
  maximizer: Maximizer,
  limiter: Limiter,
};

export function createEffect(ctx, type, values, enabled = true) {
  const C = EFFECT_TYPES[type];
  if (!C) throw new Error('Unknown effect ' + type);
  const fx = new C(ctx).init(values || {});
  if (!enabled) fx.setEnabled(false);
  return fx;
}
