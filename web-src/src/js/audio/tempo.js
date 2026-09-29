// Tempo detection ("auto-timing"): spectral-flux onset envelope -> autocorrelation + comb scoring
// (60-200 BPM) -> metrical-level choice (half/double time) -> beat phase by least-squares fit to
// onset peaks -> downbeat by accent strength. Plain JS, no worklet needed. Pure functions + two small
// stateful helpers (TempoAnalyzer for streaming audio, TempoFollower for the live "Follow" policy),
// so everything can be tested offline with synthetic click tracks.
export const BPM_MIN = 60, BPM_MAX = 200;

// ---------------------------------------------------------------- FFT (in-place radix-2, complex)
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// ---------------------------------------------------------------- onset envelope (streaming)
// Frame rate is ~172 frames/s (hop 256 @ 44.1 kHz). Two envelopes: full-band flux and low-band flux
// (< 150 Hz, kick/bass accents, used for downbeats).
export class OnsetDetector {
  constructor(sr) {
    this.sr = sr; this.win = sr > 60000 ? 2048 : 1024; this.hop = Math.max(64, Math.round(sr / 172.27));
    this.fr = sr / this.hop;
    this.buf = new Float32Array(this.win); this.fill = 0; this.sinceHop = 0; this.started = false;
    this.hann = new Float32Array(this.win).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.win));
    this.re = new Float64Array(this.win); this.im = new Float64Array(this.win);
    this.nb = Math.min(this.win / 2, Math.round(12000 / (sr / this.win))); this.lowB = Math.max(2, Math.round(150 / (sr / this.win)));
    this.prev = new Float32Array(this.nb); this.prevLin = new Float32Array(this.lowB); this.prevAll = new Float32Array(4 * this.lowB); this.lowSum = 0; this.linSum = 0; this.frames = 0;
  }
  // feed samples; calls onFrame(flux, lowFlux, frameIndex) for each hop; frame time (s, stream clock)
  // of frame i = (i * hop + win) / sr  (end of the analysis window = when the onset is fully "seen")
  push(x, onFrame) {
    for (let i = 0; i < x.length; i++) {
      // shift-register via ring: keep simple (buffer small)
      this.buf[this.fill++] = x[i];
      if (this.fill === this.win) {
        this.frame(onFrame);
        this.buf.copyWithin(0, this.hop); this.fill = this.win - this.hop;
      }
    }
  }
  frame(onFrame) {
    const { re, im, win, hann, nb, prev } = this;
    for (let i = 0; i < win; i++) { re[i] = this.buf[i] * hann[i]; im[i] = 0; }
    fftInPlace(re, im);
    let flux = 0, low = 0, lin = 0, pow = 0;
    for (let k = 1; k < nb; k++) {
      const mag = Math.hypot(re[k], im[k]), m = Math.log1p(100 * mag); pow += mag * mag;
      const d = m - prev[k]; prev[k] = m;
      if (d > 0) flux += d;
      if (k < 4 * this.lowB) { const dd = mag - (this.prevAll[k] || 0); this.prevAll[k] = mag; if (dd > 0) lin += dd; }
      // low band uses linear magnitude: a kick's low-end energy stands out, broadband noise (snare/hats) does not
      if (k < this.lowB) { const dl = mag - this.prevLin[k]; this.prevLin[k] = mag; if (dl > 0) low += dl; }
    }
    if (this.frames === 0) { flux = 0; low = 0; lin = 0; }
    this.lowSum = this.lowSum * 0.999 + low; this.linSum = this.linSum * 0.999 + lin;
    onFrame(flux, low, this.frames++, Math.sqrt(pow));
  }
  // share of low-band (<150 Hz) onset energy within the <600 Hz range: high for kick/bass, low for clicks/leakage
  lowShare() { return this.linSum > 0 ? this.lowSum / this.linSum : 0; }
  frameTime(i) { return (i * this.hop + this.win) / this.sr; }
}

// offline: whole buffer (mono Float32Array) -> envelopes
export function onsetEnvelope(x, sr) {
  const od = new OnsetDetector(sr); const env = [], low = [], loud = [];
  od.push(x, (f, l, i, r) => { env.push(f); low.push(l); loud.push(r); });
  return { env: Float32Array.from(env), loud: Float32Array.from(loud), low: od.lowShare() > 0.35 ? Float32Array.from(low) : null, fr: od.fr, t0: od.win / sr, hop: od.hop, sr };
}
export function mixToMono(buf, from = 0, to = buf.length) {
  const n = Math.max(0, to - from), out = new Float32Array(n), ch = buf.numberOfChannels;
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[from + i] / ch; }
  return out;
}

// ---------------------------------------------------------------- estimation
function preprocess(env, fr) {
  // subtract local mean (~0.4 s) and half-wave rectify -> peaky novelty curve, normalised
  const n = env.length, w = Math.max(3, Math.round(fr * 0.2)), out = new Float32Array(n);
  let s = 0; const cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + env[i];
  let mx = 0;
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - w), b = Math.min(n, i + w + 1); const m = (cs[b] - cs[a]) / (b - a); const v = Math.max(0, env[i] - m); out[i] = v; if (v > mx) mx = v; s += v; }
  if (mx > 0) for (let i = 0; i < n; i++) out[i] /= mx;
  return out;
}
function autocorr(x, maxLag) {
  const n = x.length, r = new Float64Array(maxLag + 2);
  for (let L = 0; L <= maxLag + 1 && L < n; L++) { let s = 0; for (let i = L; i < n; i++) s += x[i] * x[i - L]; r[L] = s / (n - L); }
  return r;
}
const interp = (a, x) => { const i = Math.floor(x), f = x - i; if (i + 1 >= a.length) return a[a.length - 1] || 0; return a[i] * (1 - f) + a[i + 1] * f; };
// max of x within +-r frames of position p (fractional), with parabolic peak position
function peakNear(x, p, r) {
  const a = Math.max(1, Math.floor(p - r)), b = Math.min(x.length - 2, Math.ceil(p + r));
  let bi = -1, bv = 0; for (let i = a; i <= b; i++) if (x[i] > bv) { bv = x[i]; bi = i; }
  if (bi < 0) return { v: 0, pos: p };
  const y0 = x[bi - 1], y1 = x[bi], y2 = x[bi + 1], den = y0 - 2 * y1 + y2;
  const off = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0;
  return { v: bv, pos: bi + off };
}
// best phase for period P: maximise summed peak strength on the beat grid
function bestPhase(x, P) {
  let best = 0, bs = -1;
  for (let ph = 0; ph < P; ph += 0.5) { let s = 0; for (let p = ph; p < x.length; p += P) s += peakNear(x, p, 1.5).v; if (s > bs) { bs = s; best = ph; } }
  return best;
}
function onOffRatio(x, P, ph, lx) {
  let on = 0, off = 0, n = 0; const v = (p) => peakNear(x, p, 2).v + (lx ? peakNear(lx, p, 2).v : 0);
  for (let p = ph; p + P / 2 < x.length; p += P) { on += v(p); off += v(p + P / 2); n++; }
  return n && on > 0 ? off / on : 0;
}

// env: onset envelope, fr: frames/s. Returns null when there is no clear pulse.
// {bpm, confidence, period (frames), phase (frame of a beat, fractional), beats[] (frames), downbeat
// (frame of a bar start), downbeatConf, alternatives:[half, double]}
export function estimateTempo(envIn, fr, { low = null, loud = null, beatsPerBar = 4, min = BPM_MIN, max = BPM_MAX, prefer = null } = {}) {
  if (!envIn || envIn.length < fr * 3) return null;
  const x = preprocess(envIn, fr);
  const energy = x.reduce((a, b) => a + b, 0) / x.length; if (!(energy > 1e-4)) return null;
  const minP = 60 * fr / max, maxP = 60 * fr / min;
  const maxLag = Math.min(x.length - 2, Math.ceil(maxP * 4));
  const r = autocorr(x, maxLag); if (!(r[0] > 0)) return null;
  // comb score over tempo; only multiples that fit in the analysed window
  const score = (bpm) => { const P = 60 * fr / bpm; let s = 0, w = 0; for (let k = 1; k <= 4; k++) { if (k * P > maxLag) break; s += interp(r, k * P); w++; } return w ? s / w / r[0] : 0; };
  let bestB = 0, bestS = -1; const scores = [];
  for (let b = min; b <= max + 1e-9; b += 0.1) { const s = score(b) * Math.exp(-0.5 * Math.pow(Math.log2(b / 110) / 1.3, 2)); scores.push(s); if (s > bestS) { bestS = s; bestB = b; } }
  const meanS = scores.reduce((a, b) => a + b, 0) / scores.length;
  // low band only counts when it carries real energy (kick/bass), otherwise normalising it would amplify noise
  const lx = low ? preprocess(low, fr) : null;
  // metrical level: start at the slowest octave-related tempo in range, go faster while the
  // off-beats are (nearly) as strong as the beats (uniform pulse) -> handles half/double time
  let lvl = bestB; while (lvl / 2 >= min - 1e-9) lvl /= 2;
  while (lvl * 2 <= max + 1e-9) { const P = 60 * fr / lvl, ph = bestPhase(x, P); if (onOffRatio(x, P, ph, lx) >= 0.62) lvl *= 2; else break; }
  if (prefer) { // follow mode: fold to the octave closest to the tempo we are already following
    let c = lvl; const cands = [c / 2, c, c * 2].filter((b) => b >= min - 1 && b <= max + 1);
    c = cands.reduce((a, b) => (Math.abs(Math.log2(b / prefer)) < Math.abs(Math.log2(a / prefer)) ? b : a), cands[0] || c); lvl = c;
  }
  // refine locally around the chosen level
  let rb = lvl, rs = -1; for (let b = lvl * 0.97; b <= lvl * 1.03; b += 0.02) { const s = score(b); if (s > rs) { rs = s; rb = b; } }
  let P = 60 * fr / rb, ph = bestPhase(x, P);
  // least-squares fit of beat times to nearby onset peaks (two passes)
  let beats = [], hitFrac = 0, resid = 0;
  const peakThr = 0.12;
  for (let pass = 0; pass < 3; pass++) {
    const ks = [], ts = []; let total = 0;
    const k0 = -Math.floor(ph / P);
    for (let k = k0; ph + k * P < x.length - 2; k++) {
      const p = ph + k * P; if (p < 1) continue; total++;
      const pk = peakNear(x, p, Math.max(2, P * 0.12)); if (pk.v >= peakThr) { ks.push(k); ts.push(pk.pos); }
    }
    hitFrac = total ? ks.length / total : 0;
    if (ks.length < 4) break;
    const n = ks.length, mk = ks.reduce((a, b) => a + b, 0) / n, mt = ts.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (ks[i] - mk) * (ts[i] - mt); sxx += (ks[i] - mk) ** 2; }
    const nP = sxx > 0 ? sxy / sxx : P; if (!(nP > minP * 0.9 && nP < maxP * 1.1)) break;
    P = nP; ph = mt - mk * P; while (ph < 0) ph += P; while (ph >= P) ph -= P;
    resid = Math.sqrt(ks.reduce((a, k, i) => a + (ts[i] - (ph + k * P)) ** 2, 0) / n);
  }
  beats = []; for (let p = ph; p < x.length; p += P) beats.push(p);
  const bpm = 60 * fr / P;
  // downbeat: which beat of the bar carries the strongest accents (full + low-band flux)
  const bpb = Math.max(1, beatsPerBar | 0), aX = new Float64Array(bpb), aL = new Float64Array(bpb), cnt = new Float64Array(bpb), acc = new Float64Array(bpb);
  beats.forEach((p, i) => { aX[i % bpb] += peakNear(x, p, 2).v; if (lx) aL[i % bpb] += peakNear(lx, p, 2).v; cnt[i % bpb]++; });
  const mX = Math.max(...aX.map((v, i) => (cnt[i] ? v / cnt[i] : 0))) || 1, mL = Math.max(...aL.map((v, i) => (cnt[i] ? v / cnt[i] : 0))) || 1;
  // each band normalised to its own maximum; the low band (kick/bass) weighs more, as downbeats usually carry it
  // loudness at the beat (max frame level just after it) also counts: accented downbeats are louder
  const aR = new Float64Array(bpb); if (loud) beats.forEach((p, i) => { let m = 0; for (let j = Math.floor(p) - 1; j <= Math.ceil(p) + 3 && j < loud.length; j++) if (j >= 0 && loud[j] > m) m = loud[j]; aR[i % bpb] += m; });
  const mR = Math.max(...aR.map((v, i) => (cnt[i] ? v / cnt[i] : 0))) || 1;
  for (let i = 0; i < bpb; i++) acc[i] = cnt[i] ? aX[i] / cnt[i] / mX + (lx ? 1.5 * aL[i] / cnt[i] / mL : 0) + (loud ? 1.5 * Math.pow(aR[i] / cnt[i] / mR, 2) : 0) : 0;
  let db = 0; for (let i = 1; i < bpb; i++) if (acc[i] > acc[db]) db = i;
  const sorted = [...acc].sort((a, b) => b - a);
  const downbeatConf = sorted[0] > 0 ? Math.max(0, (sorted[0] - (sorted[1] || 0)) / sorted[0]) : 0;
  const peakiness = Math.max(0, Math.min(1, (bestS - meanS) / (bestS + 1e-9) * 1.6));
  const confidence = Math.max(0, Math.min(1, hitFrac * Math.max(0, 1 - resid / (0.08 * P)) * (0.4 + 0.6 * peakiness)));
  const alternatives = [bpm / 2, bpm * 2].filter((b) => b >= 40 && b <= 300).map((b) => Math.round(b * 10) / 10);
  return { accents: [...acc].map((v) => +v.toFixed(3)), bpm, confidence, period: P, phase: ph, beats, downbeat: beats[db] != null ? beats[db] : ph, downbeatIndex: db, downbeatConf, alternatives, fr };
}

// convenience: AudioBuffer (or region) -> tempo with times in seconds (relative to `from`)
export function detectBufferTempo(buf, { fromSec = 0, durSec = null, beatsPerBar = 4 } = {}) {
  const sr = buf.sampleRate, a = Math.max(0, Math.floor(fromSec * sr)), b = Math.min(buf.length, durSec ? a + Math.floor(durSec * sr) : buf.length);
  const e = onsetEnvelope(mixToMono(buf, a, b), sr);
  const est = estimateTempo(e.env, e.fr, { low: e.low, loud: e.loud, beatsPerBar }); if (!est) return null;
  const toSec = (f) => f / e.fr + e.t0 - ONSET_BIAS;
  return { ...est, beatTimes: est.beats.map(toSec), downbeatSec: toSec(est.downbeat), phaseSec: toSec(est.phase), periodSec: est.period / e.fr };
}
// the flux peak appears slightly after the true attack (window end reference); measured with
// synthetic clicks and compensated here (seconds)
export let ONSET_BIAS = 0.0061;
export function setOnsetBias(v) { ONSET_BIAS = v; }

// ---------------------------------------------------------------- streaming analyser
// push() audio with the AudioContext time of its first sample; analyse() estimates over the last
// `windowSec`, returning beat/downbeat times in AudioContext seconds.
export class TempoAnalyzer {
  constructor(sr, { windowSec = 12 } = {}) {
    this.od = new OnsetDetector(sr); this.sr = sr;
    this.cap = Math.ceil(this.od.fr * 40); this.env = new Float32Array(this.cap); this.low = new Float32Array(this.cap); this.times = new Float64Array(this.cap); this.loud = new Float32Array(this.cap);
    this.n = 0; this.windowSec = windowSec; this.anchor = null; this.samples = 0; this.level = 0;
  }
  reset() { this.od = new OnsetDetector(this.sr); this.n = 0; this.samples = 0; this.anchor = null; this.level = 0; }
  push(x, ctxTimeOfFirst) {
    // anchor maps stream samples -> context time (same clock; re-anchored on every chunk)
    this.anchor = { sample: this.samples, t: ctxTimeOfFirst };
    let pk = 0; for (let i = 0; i < x.length; i += 4) { const v = Math.abs(x[i]); if (v > pk) pk = v; }
    this.level = Math.max(pk, this.level * 0.9);
    this.od.push(x, (f, l, fi, r) => { const i = this.n % this.cap; this.env[i] = f; this.low[i] = l; this.loud[i] = r; this.times[i] = this.frameCtxTime(fi); this.n++; });
    this.samples += x.length;
  }
  frameCtxTime(frameIdx) { const s = frameIdx * this.od.hop + this.od.win; return this.anchor.t + (s - this.anchor.sample) / this.sr - ONSET_BIAS; }
  seconds() { return this.n / this.od.fr; }
  analyse({ windowSec = this.windowSec, beatsPerBar = 4, prefer = null } = {}) {
    if (!this.anchor) return null;
    const len = Math.min(this.n, this.cap, Math.round(windowSec * this.od.fr)); if (len < this.od.fr * 3) return null;
    const start = this.n - len, env = new Float32Array(len), low = new Float32Array(len), loud = new Float32Array(len);
    for (let i = 0; i < len; i++) { const j = (start + i) % this.cap; env[i] = this.env[j]; low[i] = this.low[j]; loud[i] = this.loud[j]; }
    const est = estimateTempo(env, this.od.fr, { low: this.od.lowShare() > 0.35 ? low : null, loud, beatsPerBar, prefer }); if (!est) return null;
    // map fractional frames to context time with the per-frame timestamps (robust to audio dropouts)
    const toT = (f) => { const i = Math.max(0, Math.min(len - 1, Math.floor(f))), fr = f - i, a = this.times[(start + i) % this.cap], b = i + 1 < len ? this.times[(start + i + 1) % this.cap] : a + 1 / this.od.fr; return a + (b - a) * fr; };
    const beatTimes = est.beats.map(toT);
    // tempo from a least-squares fit of the beat times in context seconds
    let bpm = est.bpm, periodSec = est.period / this.od.fr;
    if (beatTimes.length >= 4) { const n = beatTimes.length, mk = (n - 1) / 2, mt = beatTimes.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0; beatTimes.forEach((t, k) => { sxy += (k - mk) * (t - mt); sxx += (k - mk) ** 2; }); const ps = sxy / sxx; if (ps > 0.2 && ps < 1.2) { periodSec = ps; bpm = 60 / ps; } }
    return { ...est, bpm, beatTimes, downbeatTime: toT(est.downbeat), periodSec, lastBeatTime: beatTimes[beatTimes.length - 1] };
  }
}

// ---------------------------------------------------------------- follow policy
// Rate-limited, hysteresis-gated tempo following. update(estimate, now) -> {bpm, changed}
// - ignores estimates below minConf
// - deadband: differences below `deadband` BPM are ignored; larger ones must persist `persist` updates
// - slew: the followed tempo moves at most `maxRate` BPM per second
// - octave folding: estimates near 2x / 0.5x of the followed tempo are folded
export class TempoFollower {
  constructor({ minConf = 0.35, deadband = 0.6, persist = 2, maxRate = 1.5 } = {}) {
    Object.assign(this, { minConf, deadband, persist, maxRate }); this.bpm = null; this.target = null; this.count = 0; this.lastT = null; this.changes = 0;
  }
  reset(bpm = null) { this.bpm = bpm; this.target = null; this.count = 0; this.lastT = null; }
  update(est, now) {
    const dt = this.lastT == null ? 0.5 : Math.max(0, now - this.lastT); this.lastT = now;
    if (est && est.confidence >= this.minConf) {
      let b = est.bpm;
      if (this.bpm) { for (const f of [2, 0.5]) if (Math.abs(Math.log2(b * f / this.bpm)) < Math.abs(Math.log2(b / this.bpm))) b *= f; }
      if (this.bpm == null) { this.bpm = b; this.changes++; return { bpm: this.bpm, changed: true }; }
      if (Math.abs(b - this.bpm) < this.deadband) {
        // inside the deadband: keep converging if a move is already under way, otherwise hold
        if (this.target != null && this.count >= this.persist && Math.abs(b - this.bpm) > 0.1) this.target = b; else { this.count = 0; this.target = null; }
      }
      else { this.count = this.target != null && Math.abs(b - this.target) < 2.5 ? this.count + 1 : 1; this.target = b; }
    }
    if (this.target != null && this.count >= this.persist) {
      const d = this.target - this.bpm, step = Math.sign(d) * Math.min(Math.abs(d), this.maxRate * dt);
      if (Math.abs(step) > 1e-6) { this.bpm += step; this.changes++; if (Math.abs(this.target - this.bpm) < 0.05) { this.target = null; this.count = 0; } return { bpm: this.bpm, changed: true }; }
    }
    return { bpm: this.bpm, changed: false };
  }
}

// ---------------------------------------------------------------- tap tempo
export class TapTempo {
  constructor() { this.taps = []; }
  tap(t) { if (this.taps.length && t - this.taps[this.taps.length - 1] > 2) this.taps = []; this.taps.push(t); if (this.taps.length > 8) this.taps.shift(); return this.bpm(); }
  bpm() {
    const n = this.taps.length; if (n < 2) return null;
    const iv = []; for (let i = 1; i < n; i++) iv.push(this.taps[i] - this.taps[i - 1]);
    const med = [...iv].sort((a, b) => a - b)[iv.length >> 1]; const ok = iv.filter((d) => Math.abs(d - med) < med * 0.25);
    const avg = ok.reduce((a, b) => a + b, 0) / ok.length; const b = 60 / avg;
    return b >= 30 && b <= 300 ? Math.round(b * 10) / 10 : null;
  }
}

// synthetic click track (used by tests and the calibration): tempo may be a function of time for drift
export function clickTrack(sr, seconds, bpmOrFn, { beatsPerBar = 4, start = 0, jitter = 0, noise = 0, accent = 2, seed = 1 } = {}) {
  const x = new Float32Array(Math.floor(sr * seconds)); let rnd = seed; const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const clicks = []; let t = start, k = 0;
  const bpmAt = typeof bpmOrFn === 'function' ? bpmOrFn : () => bpmOrFn;
  while (t < seconds - 0.05) {
    const tt = t + (jitter ? (rand() * 2 - 1) * jitter : 0), down = k % beatsPerBar === 0, s0 = Math.round(tt * sr);
    const f = down ? 1600 : 1000, a = down ? 0.6 : 0.6 / accent;
    for (let i = 0; i < sr * 0.04 && s0 + i < x.length; i++) if (s0 + i >= 0) x[s0 + i] += a * Math.sin(2 * Math.PI * f * i / sr) * Math.exp(-i / (sr * 0.008));
    clicks.push({ t: tt, down }); t += 60 / bpmAt(t); k++;
  }
  if (noise) for (let i = 0; i < x.length; i++) x[i] += (rand() * 2 - 1) * noise;
  return { x, clicks };
}
