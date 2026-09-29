// Live adaptive processing: a gentle per-track EQ + compressor that slowly steers the incoming
// signal's spectral balance and dynamics toward a target for the chosen instrument.
// Rate-limited (max 0.3 dB per 250 ms step), bounded (+-6 dB), bypassable, and it only adapts
// while there is signal. It does not touch the user's own effects.

export const BANDS = [
  { type: 'lowshelf', f: 100, lo: 40, hi: 160, name: 'low' },
  { type: 'peaking', f: 300, lo: 200, hi: 450, name: 'mud', q: 1.1 },
  { type: 'peaking', f: 1000, lo: 700, hi: 1500, name: 'mid', q: 0.9 },
  { type: 'peaking', f: 3200, lo: 2200, hi: 4800, name: 'presence', q: 1.0 },
  { type: 'highshelf', f: 9000, lo: 7000, hi: 14000, name: 'air' },
];
// Target band levels in dB relative to the mean of all bands (rough pink-ish curves per instrument).
export const TARGETS = {
  drums:  [4, -1, -2, 0, 1],
  bass:   [8, 2, -2, -6, -14],
  guitar: [-4, 1, 3, 2, -6],
  vocals: [-6, 0, 2, 3, -1],
  keys:   [1, 1, 1, -1, -4],
  other:  [1, 0, 0, -1, -3],
};
// Per-instrument compressor intent: dB above RMS for threshold, ratio
const COMP = { drums: [5, 3], bass: [3, 4], guitar: [5, 2.5], vocals: [3, 3.5], keys: [6, 2], other: [6, 2] };

export class Adaptive {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain(); this.output = ctx.createGain();
    this.filters = BANDS.map((b) => { const f = ctx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.f; if (b.q) f.Q.value = b.q; f.gain.value = 0; return f; });
    this.comp = ctx.createDynamicsCompressor(); this.comp.ratio.value = 2; this.comp.threshold.value = 0; this.comp.knee.value = 10; this.comp.attack.value = 0.01; this.comp.release.value = 0.15;
    this.makeup = ctx.createGain();
    this.analyser = null;
    this.gains = BANDS.map(() => 0); this.smoothed = null; this.thr = 0; this.enabled = false; this.amount = 60;
    this.instrument = 'other'; this.status = 'Off'; this.level = -100;
    this.route();
  }
  route() {
    try { this.input.disconnect(); } catch (e) {}
    this.filters.forEach((f) => { try { f.disconnect(); } catch (e) {} }); try { this.comp.disconnect(); this.makeup.disconnect(); } catch (e) {}
    if (!this.enabled) { this.input.connect(this.output); if (this.analyser) { try { this.analyser.disconnect(); } catch (e) {} this.analyser = null; } return; }
    let n = this.input; for (const f of this.filters) { n.connect(f); n = f; }
    n.connect(this.comp).connect(this.makeup).connect(this.output);
    if (!this.analyser) { this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.6; this.fbuf = new Float32Array(this.analyser.frequencyBinCount); this.tbuf = new Float32Array(this.analyser.fftSize); }
    this.input.connect(this.analyser); // measure the dry signal
  }
  setEnabled(on) {
    this.enabled = !!on;
    if (!on) { this.reset(); this.status = 'Bypassed'; }
    this.route();
  }
  reset() { const t = this.ctx.currentTime; this.gains = this.gains.map(() => 0); this.filters.forEach((f) => f.gain.setTargetAtTime(0, t, 0.3)); this.comp.threshold.setTargetAtTime(0, t, 0.3); this.makeup.gain.setTargetAtTime(1, t, 0.3); this.smoothed = null; this.thr = 0; }
  // one control step (called every ~250 ms by the engine)
  step() {
    if (!this.enabled || !this.analyser) return;
    const a = this.analyser; a.getFloatTimeDomainData(this.tbuf);
    let s = 0, pk = 0; for (const v of this.tbuf) { s += v * v; const x = Math.abs(v); if (x > pk) pk = x; }
    const rmsDb = 10 * Math.log10(s / this.tbuf.length + 1e-12); this.level = rmsDb;
    if (rmsDb < -50) { this.status = 'Waiting for signal…'; return; }
    a.getFloatFrequencyData(this.fbuf);
    const binHz = this.ctx.sampleRate / a.fftSize;
    const bandDb = BANDS.map((b) => { let e = 0, n = 0; for (let k = Math.floor(b.lo / binHz); k <= Math.ceil(b.hi / binHz) && k < this.fbuf.length; k++) { e += Math.pow(10, this.fbuf[k] / 10); n++; } return 10 * Math.log10(e / Math.max(1, n) + 1e-20); });
    if (!this.smoothed) this.smoothed = bandDb.slice(); else this.smoothed = this.smoothed.map((v, i) => v * 0.85 + bandDb[i] * 0.15);
    const mean = this.smoothed.reduce((x, y) => x + y, 0) / this.smoothed.length;
    const target = TARGETS[this.instrument] || TARGETS.other;
    const amt = this.amount / 100, t = this.ctx.currentTime, actions = [];
    this.smoothed.forEach((v, i) => {
      const dev = (v - mean) - target[i];
      const desired = Math.max(-6, Math.min(6, -dev * 0.5 * amt));
      const stepMax = 0.3;
      const g = this.gains[i] + Math.max(-stepMax, Math.min(stepMax, desired - this.gains[i]));
      this.gains[i] = g;
      this.filters[i].gain.setTargetAtTime(g, t, 0.4);
      if (Math.abs(g) >= 1) actions.push(`${g > 0 ? '+' : ''}${g.toFixed(1)} dB ${BANDS[i].name}`);
    });
    const [above, ratio] = COMP[this.instrument] || COMP.other;
    const wantThr = Math.max(-40, Math.min(-3, rmsDb + above));
    this.thr += Math.max(-0.5, Math.min(0.5, wantThr - this.thr));
    this.comp.threshold.setTargetAtTime(this.thr, t, 0.4); this.comp.ratio.setTargetAtTime(1 + (ratio - 1) * amt, t, 0.4);
    const gr = -this.comp.reduction;
    this.makeup.gain.setTargetAtTime(Math.pow(10, Math.min(6, gr * 0.6) / 20), t, 0.8);
    this.status = (actions.length ? actions.join(', ') : 'Balanced') + ` · GR ${gr.toFixed(1)} dB`;
  }
  toJSON() { return { enabled: this.enabled, amount: this.amount }; }
  dispose() { try { this.input.disconnect(); this.output.disconnect(); } catch (e) {} }
}
