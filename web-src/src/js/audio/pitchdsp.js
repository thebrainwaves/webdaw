// Pitch correction DSP (shared by the AudioWorklet and the ScriptProcessor fallback).
// - Detection: YIN on a 2x-decimated signal (range ~60-1000 Hz), every 256 input samples.
// - Correction: nearest note of the chosen key/scale, retune-speed smoothing, humanize
//   (small deviations such as vibrato are corrected less).
// - Shifting: pitch-synchronous two-tap delay-line granular shifter (window = 2 detected periods,
//   Hann crossfade). This is PSOLA-like: for small shifts (about +-2 semitones) formants stay
//   roughly in place, larger shifts sound increasingly artificial. Latency ~= one window (<= 40 ms).

export const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11], majPentatonic: [0, 2, 4, 7, 9], minPentatonic: [0, 3, 5, 7, 10], blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (midi) => NOTE_NAMES[((Math.round(midi) % 12) + 12) % 12] + (Math.floor(Math.round(midi) / 12) - 1);

export function nearestScaleNote(midi, root, scale) {
  const pcs = SCALES[scale] || SCALES.chromatic;
  let best = Math.round(midi), bestD = Infinity;
  for (let o = -1; o <= 1; o++) for (const pc of pcs) {
    const base = Math.floor(midi / 12) * 12 + ((root + pc) % 12) + o * 12;
    const d = Math.abs(base - midi); if (d < bestD) { bestD = d; best = base; }
  }
  return best;
}

// YIN pitch estimate. x: Float32Array (already decimated), sr: its sample rate.
export function yin(x, sr, fmin = 60, fmax = 1000, threshold = 0.15) {
  const tauMin = Math.max(2, Math.floor(sr / fmax)), tauMax = Math.min(Math.floor(x.length / 2), Math.ceil(sr / fmin));
  const W = x.length - tauMax; if (W < 32) return { f0: 0, conf: 0 };
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) { let s = 0; for (let j = 0; j < W; j++) { const v = x[j] - x[j + tau]; s += v * v; } d[tau] = s; }
  let run = 0, tauBest = -1; const cm = new Float32Array(tauMax + 1); cm[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cm[tau] < threshold) { while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++; tauBest = tau; break; }
  }
  if (tauBest < 0) { // no dip under threshold: take global min as low-confidence estimate
    let m = Infinity; for (let tau = tauMin; tau <= tauMax; tau++) if (cm[tau] < m) { m = cm[tau]; tauBest = tau; }
    if (m > 0.35) return { f0: 0, conf: 1 - m };
  }
  const a = cm[tauBest - 1] ?? cm[tauBest], b = cm[tauBest], c = cm[tauBest + 1] ?? cm[tauBest];
  const den = a - 2 * b + c; const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
  return { f0: sr / (tauBest + Math.max(-1, Math.min(1, shift))), conf: 1 - b };
}

export class PitchCorrectorDSP {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.N = 16384; this.buf = new Float32Array(this.N); this.w = 0;
    this.decim = sampleRate > 60000 ? 4 : 2;
    this.det = new Float32Array(Math.round(2048 / this.decim) * (this.decim === 4 ? 2 : 1)); // ~43 ms window
    this.detLen = this.det.length; this.detPos = 0; this.hop = 256; this.hopCount = 0;
    this.p = 0; this.L = Math.round(0.03 * sampleRate); this.nextL = this.L;
    this.ratio = 1; this.logRatio = 0; this.targetLog = 0;
    this.f0 = 0; this.conf = 0; this.target = 0; this.voiced = false; this.level = 0;
    this.params = { root: 0, scale: 'chromatic', speed: 40, humanize: 30, mix: 100, amount: 100, bypass: 0 };
    this.onReport = null; this.reportEvery = Math.round(sampleRate / 40); this.reportCount = 0;
    this.lp = 0;
  }
  set(k, v) { this.params[k] = v; }
  analyse() {
    // copy the decimated ring into linear order
    const n = this.detLen, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = this.det[(this.detPos + i) % n];
    let e = 0; for (let i = 0; i < n; i++) e += x[i] * x[i];
    this.level = Math.sqrt(e / n);
    if (this.level < 0.004) { this.voiced = false; this.f0 = 0; return; }
    const r = yin(x, this.sr / this.decim, 60, 1000, 0.15);
    this.conf = r.conf;
    if (!r.f0 || r.conf < 0.75) { this.voiced = false; this.f0 = 0; return; }
    this.voiced = true; this.f0 = r.f0;
    const midi = 69 + 12 * Math.log2(r.f0 / 440);
    const P = this.params;
    const tgt = nearestScaleNote(midi, P.root | 0, P.scale);
    const dev = tgt - midi; // semitones to correct
    // humanize: deviations below the tolerance (up to 50 cents) are corrected less, keeping vibrato/scoops
    const tol = (P.humanize / 100) * 0.5;
    let corr = dev;
    if (tol > 0 && Math.abs(dev) < tol) corr = dev * Math.pow(Math.abs(dev) / tol, 2);
    corr *= P.amount / 100;
    this.target = midi + corr; this.targetNote = tgt;
    this.targetLog = corr / 12; // log2 ratio
    // pitch-synchronous window: two periods (clamped 8..40 ms)
    this.nextL = Math.round(Math.max(0.008 * this.sr, Math.min(0.04 * this.sr, 2 * this.sr / r.f0)));
  }
  process(inp, out, out2) {
    const P = this.params, n = inp.length, N = this.N, buf = this.buf;
    const speedS = Math.max(0.0005, P.speed / 1000);
    const k = 1 - Math.exp(-1 / (speedS * this.sr));
    const mix = P.mix / 100;
    for (let i = 0; i < n; i++) {
      const x = inp[i];
      buf[this.w] = x;
      // decimate (simple averaging lowpass) into the detector ring
      this.lp += x; if (((this.hopCount + i) % this.decim) === this.decim - 1) { this.det[this.detPos] = this.lp / this.decim; this.detPos = (this.detPos + 1) % this.detLen; this.lp = 0; }
      // smooth ratio in log domain: speed 0 => robotic instant snap
      const tl = this.voiced && !P.bypass ? this.targetLog : 0;
      this.logRatio += (tl - this.logRatio) * (P.speed <= 0 ? 1 : k);
      const ratio = Math.pow(2, this.logRatio);
      // two-tap delay-line shifter
      const L = this.L;
      this.p += (1 - ratio) / L;
      if (this.p >= 1 || this.p < 0) { this.p -= Math.floor(this.p); this.L = this.nextL; }
      const pA = this.p, pB = (this.p + 0.5) % 1;
      const dA = 2 + pA * this.L, dB = 2 + pB * this.L;
      const gA = Math.sin(Math.PI * pA) ** 2, gB = Math.sin(Math.PI * pB) ** 2;
      const y = gA * this.tap(dA) + gB * this.tap(dB);
      const o = mix * y + (1 - mix) * x;
      out[i] = o; if (out2) out2[i] = o;
      this.w = (this.w + 1) % N;
    }
    this.hopCount += n;
    if (this.hopCount >= this.hop) { this.hopCount %= this.hop * this.decim; this.analyse(); }
    this.reportCount += n;
    if (this.reportCount >= this.reportEvery && this.onReport) {
      this.reportCount = 0;
      this.onReport({ f0: this.voiced ? this.f0 : 0, target: this.voiced ? this.target : 0, targetNote: this.voiced ? this.targetNote : null, conf: this.conf, level: this.level, shift: this.logRatio * 12 });
    }
  }
  tap(d) {
    let r = this.w - d; while (r < 0) r += this.N;
    const i0 = Math.floor(r), f = r - i0, i1 = (i0 + 1) % this.N;
    return this.buf[i0] * (1 - f) + this.buf[i1] * f;
  }
}
