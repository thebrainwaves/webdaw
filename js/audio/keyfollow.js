// "Follow the band": rolling chroma estimate from all non-drum tracks (inputs + playback, pre-FX),
// Krumhansl key correlation, with hysteresis so the key only changes when a new key has clearly
// and consistently won for several seconds. CPU only (the native AnalyserNode does the FFT).
import { detectKey } from './keydetect.js';

export class KeyFollower {
  constructor(ctx, node) {
    this.ctx = ctx;
    this.an = ctx.createAnalyser(); this.an.fftSize = 8192; this.an.smoothingTimeConstant = 0.5;
    node.connect(this.an);
    this.f = new Float32Array(this.an.frequencyBinCount);
    this.chroma = new Float64Array(12); this.steps = 0;
    this.current = null; this.candidate = null; this.candidateCount = 0; this.lastEstimate = null;
    this.decay = 0.97; // ~8 s memory at 4 steps/s... (step every 250 ms)
    const sr = ctx.sampleRate, binHz = sr / this.an.fftSize;
    this.pcOfBin = new Int8Array(this.f.length).fill(-1);
    for (let k = Math.ceil(55 / binHz); k < Math.min(this.f.length, 2000 / binHz); k++) this.pcOfBin[k] = ((Math.round(69 + 12 * Math.log2(k * binHz / 440)) % 12) + 12) % 12;
  }
  reset() { this.chroma.fill(0); this.current = null; this.candidate = null; this.candidateCount = 0; }
  // returns a key object when the followed key changes, else null
  step() {
    this.an.getFloatFrequencyData(this.f);
    const frame = new Float64Array(12); let e = 0;
    for (let k = 0; k < this.f.length; k++) { const pc = this.pcOfBin[k]; if (pc < 0) continue; const m = Math.pow(10, this.f[k] / 20); frame[pc] += m; e += m; }
    if (e < 0.05) return null; // silence: keep the current key
    for (let i = 0; i < 12; i++) this.chroma[i] = this.chroma[i] * this.decay + frame[i] / e;
    if (++this.steps % 4) return null; // evaluate once per second
    const est = detectKey(this.chroma); if (!est) return null;
    this.lastEstimate = est;
    const same = (a, b) => a && b && a.root === b.root && a.scale === b.scale;
    if (!this.current) { if (this.steps >= 12) { this.current = est; return est; } return null; }
    if (same(est, this.current)) { this.candidate = null; this.candidateCount = 0; return null; }
    // hysteresis: new key must beat the current key's correlation by a margin, 3 evaluations in a row
    const curR = est.candidates.concat([]).find((c) => same(c, this.current));
    const margin = curR ? est.candidates[0].r - curR.r : 1;
    if (margin < 0.04) return null;
    if (same(est, this.candidate)) this.candidateCount++; else { this.candidate = est; this.candidateCount = 1; }
    if (this.candidateCount >= 3) { this.current = est; this.candidate = null; this.candidateCount = 0; return est; }
    return null;
  }
}
