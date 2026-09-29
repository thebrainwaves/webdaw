// Key detection (Krumhansl-Schmuckler): pitch-class histogram from MIDI notes (duration-weighted)
// and from audio (FFT chroma), correlated against major/minor key profiles.
import { NOTE_NAMES } from './pitchdsp.js';

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr; } } }
}

export function chromaFromBuffer(buf, maxSeconds = 40) {
  const sr = buf.sampleRate, N = 8192, hop = 4096, chroma = new Float64Array(12);
  const total = Math.min(buf.length, Math.floor(maxSeconds * sr));
  const mono = new Float32Array(total);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < total; i++) mono[i] += d[i]; }
  const re = new Float32Array(N), im = new Float32Array(N), win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const kMin = Math.ceil(55 / (sr / N)), kMax = Math.floor(4000 / (sr / N));
  const pcOfBin = new Int8Array(kMax + 1).fill(-1);
  for (let k = kMin; k <= kMax; k++) { const midi = 69 + 12 * Math.log2(k * sr / N / 440); pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12; }
  for (let s = 0; s + N <= total; s += hop) {
    let e = 0; for (let i = 0; i < N; i++) { const v = mono[s + i]; e += v * v; re[i] = v * win[i]; im[i] = 0; }
    if (e / N < 1e-6) continue;
    fft(re, im);
    for (let k = kMin; k <= kMax; k++) chroma[pcOfBin[k]] += Math.sqrt(Math.hypot(re[k], im[k]));
  }
  return chroma;
}

export function chromaFromNotes(notes) {
  const c = new Float64Array(12);
  for (const n of notes) c[((n.n % 12) + 12) % 12] += Math.max(0.1, n.d) * (n.v / 127);
  return c;
}

function corr(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / 12, mb = b.reduce((x, y) => x + y, 0) / 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db + 1e-12);
}

export function detectKey(chroma) {
  const total = chroma.reduce((x, y) => x + y, 0);
  if (!(total > 0)) return null;
  const results = [];
  for (let root = 0; root < 12; root++) {
    const rot = (p) => Array.from({ length: 12 }, (_, i) => p[(i - root + 12) % 12]);
    results.push({ root, scale: 'major', r: corr(chroma, rot(MAJOR)) });
    results.push({ root, scale: 'minor', r: corr(chroma, rot(MINOR)) });
  }
  results.sort((a, b) => b.r - a.r);
  const best = results[0];
  return { root: best.root, scale: best.scale, name: `${NOTE_NAMES[best.root]} ${best.scale}`, confidence: Math.max(0, Math.min(1, (best.r - results[1].r) * 5 + best.r * 0.5)), candidates: results.slice(0, 3) };
}
