// Offline time correction ("quantize audio"): detect transients, move each segment toward the grid
// by `strength`, rebuild the clip with short crossfades. Gaps are filled by granular extension of the
// segment tail; overlaps are truncated. Works best on percussive / clearly articulated material;
// sustained or legato material can show audible seams.

export function detectTransients(mono, sr, sensitivity = 1.5) {
  const hop = 256, N = 1024, env = [];
  for (let s = 0; s + N <= mono.length; s += hop) {
    let e = 0; for (let i = 0; i < N; i++) { const v = mono[s + i]; e += v * v; }
    env.push(Math.sqrt(e / N));
  }
  const onsets = [];
  let lastOn = -1e9;
  for (let i = 2; i < env.length - 1; i++) {
    const rise = env[i] - Math.max(env[i - 1], env[i - 2] * 0.9);
    let loc = 0; const a = Math.max(0, i - 12); for (let j = a; j < i; j++) loc += env[j]; loc /= Math.max(1, i - a);
    const t = i * hop;
    if (rise > 0.01 && env[i] > loc * sensitivity && env[i] > 0.02 && t - lastOn > sr * 0.06) {
      // refine: first sample in the window exceeding 30% of the local peak
      let pk = 0; for (let j = 0; j < N && t + j < mono.length; j++) pk = Math.max(pk, Math.abs(mono[t + j]));
      let k = t; for (let j = 0; j < N && t + j < mono.length; j++) if (Math.abs(mono[t + j]) > pk * 0.3) { k = t + j; break; }
      onsets.push(Math.max(0, k - Math.round(sr * 0.002)));
      lastOn = t;
    }
  }
  return onsets;
}

// buffer: AudioBuffer; clipStartSec: where the clip's offset 0 sits on the timeline; gridSec: grid size
export function quantizeBuffer(ctx, buffer, { clipStartSec = 0, offsetSec = 0, gridSec = 0.125, strength = 1, sensitivity = 1.5 } = {}) {
  const sr = buffer.sampleRate, len = buffer.length, nc = buffer.numberOfChannels;
  const mono = new Float32Array(len);
  for (let c = 0; c < nc; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / nc; }
  const onsets = detectTransients(mono, sr, sensitivity);
  if (!onsets.length) return { buffer, moved: 0, onsets: [] };
  // timeline position of sample i = clipStartSec + (i/sr - offsetSec)
  const targets = onsets.map((o) => {
    const tl = clipStartSec + o / sr - offsetSec;
    const g = Math.round(tl / gridSec) * gridSec;
    return Math.max(0, Math.round(o + (g - tl) * strength * sr));
  });
  // keep ordering monotonic
  for (let i = 1; i < targets.length; i++) if (targets[i] <= targets[i - 1] + sr * 0.02) targets[i] = targets[i - 1] + Math.round(sr * 0.02);
  const out = ctx.createBuffer(nc, len, sr);
  const fade = Math.round(sr * 0.003);
  const segs = [];
  // leading audio before first onset stays in place (up to the first target)
  segs.push({ src: 0, dst: 0, len: Math.min(onsets[0], targets[0]) });
  for (let i = 0; i < onsets.length; i++) {
    const srcStart = onsets[i], srcEnd = i + 1 < onsets.length ? onsets[i + 1] : len;
    const dst = targets[i], dstEnd = i + 1 < targets.length ? targets[i + 1] : len;
    segs.push({ src: srcStart, srcLen: srcEnd - srcStart, dst, len: Math.max(0, Math.min(dstEnd, len) - dst) });
  }
  for (let c = 0; c < nc; c++) {
    const s = buffer.getChannelData(c), o = out.getChannelData(c);
    for (const g of segs) {
      const srcLen = g.srcLen != null ? g.srcLen : g.len;
      for (let j = 0; j < g.len; j++) {
        let v;
        if (j < srcLen) v = s[g.src + j];
        else { // granular extension: loop the last 40 ms of the segment with crossfades
          const gl = Math.max(64, Math.min(srcLen, Math.round(sr * 0.04))), half = gl >> 1;
          const k = (j - srcLen) % half, base = g.src + srcLen - gl;
          const w = k / half;
          v = s[base + half + k] * (1 - w) + s[base + k] * w;
        }
        // fade in/out at segment boundaries
        const fin = g.dst > 0 && j < fade ? j / fade : 1;
        const fout = g.len - j < fade ? (g.len - j) / fade : 1;
        const idx = g.dst + j; if (idx < len) o[idx] += v * fin * fout;
      }
    }
  }
  const moved = targets.reduce((m, t, i) => Math.max(m, Math.abs(t - onsets[i]) / sr), 0);
  return { buffer: out, moved, onsets, targets };
}
