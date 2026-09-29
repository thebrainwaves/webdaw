// Visuals: one shared requestAnimationFrame loop (throttled, paused when the tab is hidden or the
// element is not visible), shared AnalyserNodes per tapped node, and small Canvas2D renderers.
// Canvas2D is GPU-composited in modern browsers; nothing here runs on the audio thread.
const taps = new WeakMap();
export function tap(ctx, node, fftSize = 2048) {
  let an = taps.get(node);
  if (!an) { an = ctx.createAnalyser(); an.fftSize = fftSize; an.smoothingTimeConstant = 0.7; an._f = new Float32Array(an.frequencyBinCount); an._t = new Float32Array(an.fftSize); taps.set(node, an); }
  try { node.connect(an); } catch (e) {} // re-connect after chain rewiring (no-op if already connected)
  return an;
}
const items = new Set();
let last = 0, raf = 0;
export const vizSettings = { fps: 30 };
export function addViz(canvas, draw) { const it = { canvas, draw }; items.add(it); ensure(); return () => items.delete(it); }
function ensure() { if (!raf) raf = requestAnimationFrame(loop); }
function loop(ts) {
  raf = 0;
  if (!items.size) return;
  ensure();
  if (document.hidden || ts - last < 1000 / vizSettings.fps) return;
  last = ts;
  for (const it of items) {
    if (!it.canvas.isConnected) { items.delete(it); continue; }
    if (!it.canvas.offsetParent) continue; // collapsed / hidden
    const c = it.canvas, w = Math.round(c.clientWidth * devicePixelRatio), h = Math.round(c.clientHeight * devicePixelRatio);
    if (!w || !h) continue;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    try { it.draw(c.getContext('2d'), w, h); } catch (e) { items.delete(it); console.warn('viz', e); }
  }
}
const css = (name, fb) => getComputedStyle(document.body).getPropertyValue(name).trim() || fb;
const xOfFreq = (f, w) => (Math.log(f / 20) / Math.log(1000)) * w;

export function drawSpectrum(g, w, h, an, color, fill = true) {
  an.getFloatFrequencyData(an._f);
  const sr = an.context.sampleRate, bins = an._f.length;
  g.clearRect(0, 0, w, h);
  g.beginPath(); g.moveTo(0, h);
  const cols = Math.min(160, w);
  for (let i = 0; i <= cols; i++) {
    const f = 20 * Math.pow(1000, i / cols), k = Math.min(bins - 1, Math.round(f / (sr / 2) * bins));
    const db = an._f[k]; const y = h - Math.max(0, Math.min(1, (db + 100) / 80)) * h;
    g.lineTo((i / cols) * w, y);
  }
  g.lineTo(w, h); g.closePath();
  if (fill) { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, color + '66'); gr.addColorStop(1, color + '08'); g.fillStyle = gr; g.fill(); }
  g.strokeStyle = color; g.lineWidth = devicePixelRatio; g.stroke();
}
export function drawCurve(g, w, h, freqs, mag, color) {
  g.strokeStyle = color; g.lineWidth = 1.5 * devicePixelRatio; g.shadowColor = color; g.shadowBlur = 4 * devicePixelRatio; g.beginPath();
  for (let i = 0; i < freqs.length; i++) { const db = 20 * Math.log10(mag[i] + 1e-9); const y = h / 2 - (db / 24) * (h / 2); const x = xOfFreq(freqs[i], w); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke(); g.shadowBlur = 0;
}
export function drawScope(g, w, h, an, color) {
  an.getFloatTimeDomainData(an._t);
  const d = an._t; let start = 0; for (let i = 1; i < d.length / 2; i++) if (d[i - 1] < 0 && d[i] >= 0) { start = i; break; } // trigger
  g.clearRect(0, 0, w, h); g.strokeStyle = color; g.lineWidth = 1.2 * devicePixelRatio; g.beginPath();
  const n = Math.min(d.length - start, 1024);
  for (let i = 0; i < n; i++) { const x = (i / n) * w, y = h / 2 - d[start + i] * h * 0.45; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
}
export function drawHistory(g, w, h, hist, max, color, label) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = color + '40'; g.strokeStyle = color; g.lineWidth = devicePixelRatio; g.beginPath(); g.moveTo(0, 0);
  hist.forEach((v, i) => g.lineTo((i / (hist.length - 1 || 1)) * w, Math.min(1, v / max) * h));
  g.lineTo(w, 0); g.closePath(); g.fill(); g.stroke();
  if (label) { g.fillStyle = css('--text', '#ccc'); g.font = `${10 * devicePixelRatio}px sans-serif`; g.fillText(label, 4 * devicePixelRatio, h - 4 * devicePixelRatio); }
}
export function drawPitch(g, w, h, hist, readout, noteName, color) {
  g.clearRect(0, 0, w, h);
  const valid = hist.filter((p) => p[0] > 0); const center = valid.length ? valid[valid.length - 1][1] || valid[valid.length - 1][0] : 60;
  const span = 12, y = (m) => h / 2 - ((m - center) / span) * h;
  g.strokeStyle = '#ffffff14'; g.lineWidth = 1;
  for (let m = Math.floor(center - span / 2); m <= center + span / 2; m++) { g.beginPath(); g.moveTo(0, y(m)); g.lineTo(w, y(m)); g.stroke(); }
  const line = (idx, col, lw) => { g.strokeStyle = col; g.lineWidth = lw * devicePixelRatio; g.beginPath(); let pen = false;
    hist.forEach((p, i) => { const x = (i / (hist.length - 1 || 1)) * w; if (p[idx] > 0) { pen ? g.lineTo(x, y(p[idx])) : g.moveTo(x, y(p[idx])); pen = true; } else pen = false; }); g.stroke(); };
  line(0, '#9aa4ad', 1); line(1, color, 1.6);
  g.fillStyle = color; g.font = `600 ${12 * devicePixelRatio}px sans-serif`;
  const txt = readout.f0 ? `${noteName(69 + 12 * Math.log2(readout.f0 / 440))} → ${readout.targetNote != null ? noteName(readout.targetNote) : '–'}` : '—';
  g.fillText(txt, 4 * devicePixelRatio, 14 * devicePixelRatio);
}

// Optional full-screen visualizer (off by default)
export function openVisualizer(ctx, node) {
  const ov = document.createElement('div'); ov.className = 'visualizer'; ov.title = 'Tap to close';
  const c = document.createElement('canvas'); ov.append(c); document.body.append(ov);
  const an = tap(ctx, node, 4096); an.smoothingTimeConstant = 0.8;
  let hue = 30;
  const remove = addViz(c, (g, w, h) => {
    an.getFloatFrequencyData(an._f); an.getFloatTimeDomainData(an._t);
    g.fillStyle = 'rgba(12,12,14,0.35)'; g.fillRect(0, 0, w, h);
    const bars = 96, sr = ctx.sampleRate, bw = w / bars; hue = (hue + 0.2) % 360;
    for (let i = 0; i < bars; i++) {
      const f = 30 * Math.pow(600, i / bars), k = Math.min(an._f.length - 1, Math.round(f / (sr / 2) * an._f.length));
      const v = Math.max(0, Math.min(1, (an._f[k] + 95) / 75)), bh = v * h * 0.7;
      g.fillStyle = `hsla(${(hue + i * 1.5) % 360},80%,55%,0.85)`; g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
    }
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < 1024; i++) { const x = (i / 1024) * w, y = h * 0.35 - an._t[i] * h * 0.25; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  });
  ov.addEventListener('click', () => { remove(); ov.remove(); });
  return ov;
}
