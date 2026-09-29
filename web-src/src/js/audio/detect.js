// Heuristic instrument detection: local, free, no model/API. Computes spectral + temporal
// features and scores each instrument class with hand-tuned fuzzy rules.
// It is a best-guess helper — the user can always override the result.

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const bell = (x, center, width) => Math.exp(-Math.pow((x - center) / width, 2));
const ramp = (x, lo, hi) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

export function extractFeatures(mono, sr, maxSeconds = 30) {
  const N = 2048, hop = 1024;
  const total = Math.min(mono.length, Math.floor(maxSeconds * sr));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const re = new Float32Array(N), im = new Float32Array(N);
  let prevMag = null;
  const binHz = sr / N;
  const F = { centroid: [], flatness: [], rolloff: [], zcr: [], flux: [], rms: [], bands: [0, 0, 0, 0, 0], clarity: [], f0: [] };
  let voicedFrames = 0, activeFrames = 0;
  const ds = Math.max(1, Math.round(sr / 12000)), dsr = sr / ds;
  for (let start = 0, fi = 0; start + N <= total; start += hop, fi++) {
    let e = 0, z = 0;
    for (let i = 0; i < N; i++) {
      const v = mono[start + i]; e += v * v;
      if (i && ((v >= 0) !== (mono[start + i - 1] >= 0))) z++;
      re[i] = v * win[i]; im[i] = 0;
    }
    const rms = Math.sqrt(e / N);
    F.rms.push(rms);
    if (rms < 0.003) { prevMag = null; F.flux.push(0); continue; } // ~-50 dBFS gate
    activeFrames++;
    fft(re, im);
    const half = N / 2;
    const mag = new Float32Array(half);
    let sum = 0, wsum = 0, logSum = 0, flux = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.hypot(re[k], im[k]); mag[k] = m;
      sum += m; wsum += m * k * binHz; logSum += Math.log(m + 1e-12);
      if (prevMag) { const d = m - prevMag[k]; if (d > 0) flux += d; }
      const f = k * binHz, p = m * m;
      if (f < 100) F.bands[0] += p; else if (f < 300) F.bands[1] += p; else if (f < 1000) F.bands[2] += p; else if (f < 4000) F.bands[3] += p; else F.bands[4] += p;
    }
    F.centroid.push(wsum / (sum + 1e-12));
    F.flatness.push(Math.exp(logSum / (half - 1)) / (sum / (half - 1) + 1e-12));
    let acc = 0, ro = 0; const target = sum * 0.85;
    for (let k = 1; k < half; k++) { acc += mag[k]; if (acc >= target) { ro = k * binHz; break; } }
    F.rolloff.push(ro);
    F.zcr.push(z / N * sr);
    F.flux.push(flux / (sum + 1e-12));
    prevMag = mag;
    // pitch clarity via normalized autocorrelation on a decimated frame (every 2nd frame)
    if (fi % 2 === 0) {
      const M = Math.floor(N / ds); const x = new Float32Array(M);
      for (let i = 0; i < M; i++) x[i] = mono[start + i * ds];
      const minLag = Math.floor(dsr / 1000), maxLag = Math.min(M - 1, Math.floor(dsr / 50));
      let e0 = 0; for (let i = 0; i < M; i++) e0 += x[i] * x[i];
      let best = 0, bestLag = 0;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let s = 0, el = 0;
        for (let i = 0; i + lag < M; i++) { s += x[i] * x[i + lag]; el += x[i + lag] * x[i + lag]; }
        const r = s / Math.sqrt(e0 * el + 1e-12);
        if (r > best) { best = r; bestLag = lag; }
      }
      F.clarity.push(best);
      if (best > 0.75) { voicedFrames++; F.f0.push(dsr / bestLag); }
    }
  }
  // onset detection from flux with adaptive threshold
  let onsets = 0;
  const fl = F.flux;
  for (let i = 2; i < fl.length - 1; i++) {
    let loc = 0; const w0 = Math.max(0, i - 8), w1 = Math.min(fl.length, i + 8);
    for (let j = w0; j < w1; j++) loc += fl[j]; loc /= (w1 - w0);
    if (fl[i] > fl[i - 1] && fl[i] >= fl[i + 1] && fl[i] > loc * 1.5 + 0.05) onsets++;
  }
  const dur = total / sr;
  const activeDur = activeFrames * hop / sr;
  const bandTotal = F.bands.reduce((a, b) => a + b, 0) + 1e-12;
  // pitch continuity (vocals glide; keys/guitar jump)
  let jumps = 0;
  for (let i = 1; i < F.f0.length; i++) { const r = Math.abs(Math.log2(F.f0[i] / F.f0[i - 1])); if (r > 0.08) jumps++; }
  const rmsActive = F.rms.filter((r) => r >= 0.003);
  // dynamics: crest between loud and median frames (drums/percussive are spiky)
  const sortedR = [...rmsActive].sort((a, b) => a - b);
  const p90 = sortedR[Math.floor(sortedR.length * 0.9)] || 0, p50 = sortedR[Math.floor(sortedR.length * 0.5)] || 1e-9;
  return {
    duration: dur,
    activeRatio: dur ? activeDur / dur : 0,
    centroid: median(F.centroid),
    flatness: median(F.flatness),
    rolloff: median(F.rolloff),
    zcr: median(F.zcr),
    zcrVar: F.zcr.length ? Math.sqrt(mean(F.zcr.map((v) => (v - mean(F.zcr)) ** 2))) : 0,
    onsetRate: activeDur > 0 ? onsets / activeDur : 0,
    clarity: median(F.clarity),
    voicedRatio: F.clarity.length ? voicedFrames / F.clarity.length : 0,
    f0: median(F.f0),
    pitchJumpRate: F.f0.length > 1 ? jumps / F.f0.length : 0,
    sub: F.bands[0] / bandTotal, low: F.bands[1] / bandTotal, lowMid: F.bands[2] / bandTotal,
    mid: F.bands[3] / bandTotal, high: F.bands[4] / bandTotal,
    dynamics: p90 / p50,
  };
}

const NAME_HINTS = [
  [/(kick|snare|drum|kit|hat|tom|perc|oh\b|overhead|beat)/i, 'drums'],
  [/(bass|sub\b)/i, 'bass'],
  [/(vox|vocal|voice|sing|lead\s?v|bv|choir|scream)/i, 'vocals'],
  [/(gtr|guitar|git|riff|rhythm|axe)/i, 'guitar'],
  [/(key|piano|synth|organ|pad|rhodes|epiano)/i, 'keys'],
];

export function classify(f, name = '') {
  const s = {};
  s.drums = 1.2 * ramp(f.onsetRate, 1.5, 5) + 0.8 * ramp(f.flatness, 0.08, 0.35) + 0.7 * (1 - ramp(f.clarity, 0.5, 0.85))
    + 0.5 * ramp(f.high + f.sub, 0.2, 0.55) + 0.4 * ramp(f.dynamics, 1.8, 4);
  s.bass = 1.5 * ramp(f.sub + f.low, 0.45, 0.8) + 0.9 * (1 - ramp(f.centroid, 250, 900)) + 0.5 * ramp(f.clarity, 0.6, 0.9)
    + 0.4 * (f.f0 > 0 && f.f0 < 260 ? 1 : 0) - 0.5 * ramp(f.high, 0.1, 0.3);
  s.guitar = 1.0 * bell(f.centroid, 1800, 1100) + 1.0 * ramp(f.mid, 0.25, 0.55) + 0.5 * bell(f.flatness, 0.15, 0.12)
    + 0.4 * bell(f.onsetRate, 3, 2.5) + 0.3 * ramp(f.lowMid + f.mid, 0.5, 0.8) + 0.3 * ramp(f.pitchJumpRate, 0.05, 0.3) - 0.4 * ramp(f.sub, 0.2, 0.4);
  s.vocals = 1.2 * ramp(f.voicedRatio, 0.3, 0.75) + 0.6 * bell(f.centroid, 1400, 900) + 0.6 * ramp(f.zcrVar, 400, 2000)
    + 0.5 * (f.f0 > 90 && f.f0 < 900 ? 1 : 0) + 0.5 * (1 - ramp(f.pitchJumpRate, 0.15, 0.45)) - 0.6 * ramp(f.onsetRate, 3, 7) - 0.5 * ramp(f.sub, 0.15, 0.35);
  s.keys = 0.9 * bell(f.centroid, 1100, 800) + 0.7 * ramp(f.clarity, 0.55, 0.85) + 0.6 * ramp(f.pitchJumpRate, 0.15, 0.5)
    + 0.4 * bell(f.onsetRate, 2, 2) + 0.4 * (1 - ramp(f.flatness, 0.05, 0.2)) + 0.3 * ramp(f.low + f.lowMid, 0.3, 0.6);
  s.other = 1.2;
  for (const [re, inst] of NAME_HINTS) if (re.test(name)) s[inst] += 1.5;
  const entries = Object.entries(s).sort((a, b) => b[1] - a[1]);
  const [best, second] = entries;
  const confidence = Math.max(0.05, Math.min(0.95, (best[1] - second[1]) / 1.5 + 0.3));
  return { instrument: best[0], confidence, scores: s };
}

export function analyzeBuffers(buffers, name) {
  // mix down up to ~30s from the given AudioBuffer-like objects {sampleRate, getChannelData, numberOfChannels, length}
  if (!buffers.length) return null;
  const sr = buffers[0].sampleRate;
  const maxLen = Math.floor(30 * sr);
  let len = 0; for (const b of buffers) len += b.length;
  len = Math.min(len, maxLen);
  const mono = new Float32Array(len);
  let off = 0;
  for (const b of buffers) {
    const n = Math.min(b.length, len - off); if (n <= 0) break;
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) mono[off + i] += d[i] / b.numberOfChannels; }
    off += n;
  }
  const f = extractFeatures(mono, sr);
  if (f.activeRatio < 0.02) return { instrument: 'other', confidence: 0, scores: {}, features: f, silent: true };
  return { ...classify(f, name), features: f };
}
