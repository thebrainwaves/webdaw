// Waveform rendering (Ableton-style): per-channel peak mipmaps (min/max/RMS) cached per AudioBuffer,
// zoom-aware drawing that picks the right mipmap level (or raw samples when zoomed far in), stereo as
// two lanes when tall enough, live peaks for recordings, and a small oscilloscope. Canvas 2D only;
// the expensive part (peaks) is computed once per buffer and cached.
const BASE = 64;           // samples per block at level 0
const cache = new WeakMap();

function buildLevels(chData, len) {
  // level 0 from samples, then each level halves the resolution (min of mins, max of maxes, RMS of RMS)
  const n0 = Math.ceil(len / BASE), mn = new Float32Array(n0), mx = new Float32Array(n0), rms = new Float32Array(n0);
  for (let i = 0; i < n0; i++) {
    let a = 1, b = -1, s = 0; const e = Math.min(len, (i + 1) * BASE);
    for (let j = i * BASE; j < e; j++) { const v = chData[j]; if (v < a) a = v; if (v > b) b = v; s += v * v; }
    mn[i] = a; mx[i] = b; rms[i] = Math.sqrt(s / Math.max(1, e - i * BASE));
  }
  const levels = [{ block: BASE, mn, mx, rms }];
  while (levels[levels.length - 1].mn.length > 64) {
    const p = levels[levels.length - 1], n = Math.ceil(p.mn.length / 2);
    const L = { block: p.block * 2, mn: new Float32Array(n), mx: new Float32Array(n), rms: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      const a = 2 * i, b = Math.min(p.mn.length - 1, a + 1);
      L.mn[i] = Math.min(p.mn[a], p.mn[b]); L.mx[i] = Math.max(p.mx[a], p.mx[b]); L.rms[i] = Math.sqrt((p.rms[a] ** 2 + p.rms[b] ** 2) / 2);
    }
    levels.push(L);
  }
  return levels;
}
export function getPeaks(buf) {
  let p = cache.get(buf); if (p) return p;
  p = { sr: buf.sampleRate, length: buf.length, channels: [] };
  for (let c = 0; c < buf.numberOfChannels; c++) p.channels.push({ levels: buildLevels(buf.getChannelData(c), buf.length), data: buf.getChannelData(c) });
  cache.set(buf, p); return p;
}
// incremental peaks for a recording in progress: append channel chunks as they arrive
export class LivePeaks {
  constructor(sr) { this.sr = sr; this.length = 0; this.chans = []; this.pend = []; this.channels = []; }
  append(chunk) { // chunk: array of Float32Array (one per channel)
    chunk.forEach((d, c) => {
      if (!this.chans[c]) { this.chans[c] = { mn: [], mx: [], rms: [] }; this.pend[c] = []; }
      const P = this.pend[c]; for (let i = 0; i < d.length; i++) P.push(d[i]);
      const C = this.chans[c];
      while (P.length >= BASE) { let a = 1, b = -1, s = 0; for (let j = 0; j < BASE; j++) { const v = P[j]; if (v < a) a = v; if (v > b) b = v; s += v * v; } C.mn.push(a); C.mx.push(b); C.rms.push(Math.sqrt(s / BASE)); P.splice(0, BASE); }
    });
    this.length += chunk[0] ? chunk[0].length : 0;
    this.channels = this.chans.map((C) => ({ levels: [{ block: BASE, mn: C.mn, mx: C.mx, rms: C.rms }] }));
  }
  get duration() { return this.length / this.sr; }
}

// draw buf (or peaks object) between startSec..endSec (buffer time) into canvas (sized to its CSS box)
// opts: color (waveform), bg, stereo ('auto'|true|false), gain (linear, scales the drawing), grid: [{x:0..1, strong}]
export function drawWaveform(canvas, src, { startSec = 0, endSec = null, color = '#8B5CF6', bg = null, stereo = 'auto', gain = 1, center = true } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.min(8192, Math.round(canvas.clientWidth * dpr))), hh = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w; if (canvas.height !== hh) canvas.height = hh;
  const g = canvas.getContext('2d'); g.clearRect(0, 0, w, hh);
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, hh); }
  if (!src) return;
  const P = src.channels ? src : getPeaks(src); const sr = P.sr, len = P.length;
  if (!P.channels.length || !len) return { lanes: 0, block: 0, spp: 0 };
  if (endSec == null) endSec = len / sr;
  const nCh = P.channels.length, lanes = stereo === true || (stereo === 'auto' && nCh > 1 && canvas.clientHeight >= 40) ? Math.min(2, nCh) : 1;
  const spp = Math.max(1e-6, (endSec - startSec) * sr / w); // samples per pixel
  const laneH = hh / lanes; let usedBlock = 0;
  for (let lane = 0; lane < lanes; lane++) {
    const y0 = lane * laneH, mid = y0 + laneH / 2, amp = laneH / 2 * 0.95 * gain;
    const chIdx = lanes === 1 ? null : lane;
    if (lanes > 1 && lane > 0) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, y0, w, Math.max(1, dpr)); }
    const chans = chIdx == null ? P.channels : [P.channels[chIdx]];
    if (spp < 1.5 && chans[0].data) {
      // zoomed far in: draw the sample curve
      g.strokeStyle = color; g.lineWidth = Math.max(1, dpr * 1.2); g.beginPath();
      for (let x = 0; x < w; x++) { const i = Math.floor(startSec * sr + x * spp); let v = 0; for (const c of chans) v += (c.data[i] || 0); v /= chans.length; const y = mid - v * amp; x ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke(); usedBlock = 1; continue;
    }
    // choose the finest level whose block is <= samples per pixel
    let li = 0; const lv = chans[0].levels; while (li + 1 < lv.length && lv[li + 1].block <= spp) li++;
    const block = lv[li].block; usedBlock = block;
    const peakCol = color, rmsCol = shade(color, 0.45);
    g.fillStyle = peakCol; g.globalAlpha = 0.75;
    const cols = new Float32Array(w * 3);
    for (let x = 0; x < w; x++) {
      const s0 = startSec * sr + x * spp, s1 = s0 + spp; const a = Math.floor(s0 / block), b = Math.max(a + 1, Math.ceil(s1 / block));
      let mn = 0, mx = 0, r = 0, cnt = 0;
      for (const c of chans) { const L = c.levels[li]; const e = Math.min(b, L.mn.length); for (let i = Math.max(0, a); i < e; i++) { if (L.mn[i] < mn) mn = L.mn[i]; if (L.mx[i] > mx) mx = L.mx[i]; r += L.rms[i] * L.rms[i]; cnt++; } }
      cols[x * 3] = mn; cols[x * 3 + 1] = mx; cols[x * 3 + 2] = cnt ? Math.sqrt(r / cnt) : 0;
      if (s0 >= len) break;
      const top = mid - mx * amp, bot = mid - mn * amp; g.fillRect(x, top, 1, Math.max(1, bot - top));
    }
    g.globalAlpha = 1; g.fillStyle = rmsCol;
    for (let x = 0; x < w; x++) { const r = cols[x * 3 + 2] * amp; if (r > 0.3) g.fillRect(x, mid - r, 1, 2 * r); }
    if (center) { g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, Math.round(mid), w, 1); }
  }
  // expose what was drawn (lanes, mipmap block size in samples; 1 = raw samples) for tests / debugging
  canvas.dataset.lanes = lanes; canvas.dataset.block = usedBlock; canvas.dataset.spp = spp.toFixed(2);
  return { lanes, block: usedBlock, spp };
}
// lighten (amt>0) a #rrggbb colour toward white
export function shade(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex;
  const n = parseInt(m[1], 16); let r = n >> 16, gg = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * amt); gg = Math.round(gg + (255 - gg) * amt); b = Math.round(b + (255 - b) * amt);
  return `rgb(${r},${gg},${b})`;
}
export function tint(hex, alpha) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return `rgba(139,92,246,${alpha})`; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`; }

// small oscilloscope: rising-zero-crossing trigger for a stable picture
export function drawScope(canvas, an, buf) {
  const dpr = window.devicePixelRatio || 1; const w = Math.round(canvas.clientWidth * dpr), hh = Math.round(canvas.clientHeight * dpr); if (!w || !hh) return;
  if (canvas.width !== w) canvas.width = w; if (canvas.height !== hh) canvas.height = hh;
  const g = canvas.getContext('2d'); g.clearRect(0, 0, w, hh); g.fillStyle = '#0e0f11'; g.fillRect(0, 0, w, hh);
  an.getFloatTimeDomainData(buf);
  let start = 0; for (let i = 1; i < buf.length / 2; i++) if (buf[i - 1] < 0 && buf[i] >= 0) { start = i; break; }
  const n = Math.min(buf.length - start, Math.floor(buf.length / 2));
  if (!canvas._grad || canvas._gw !== w) { const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#8B5CF6'); gr.addColorStop(1, '#EF4444'); canvas._grad = gr; canvas._gw = w; }
  g.strokeStyle = canvas._grad; g.lineWidth = Math.max(1, dpr); g.beginPath();
  let peak = 0;
  for (let x = 0; x < w; x++) { const v = buf[start + Math.floor(x / w * n)] || 0; peak = Math.max(peak, Math.abs(v)); const y = hh / 2 - v * hh * 0.45; x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  return peak;
}
