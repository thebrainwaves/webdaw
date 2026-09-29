// Synthetic impulse responses generated in code (no external IR files).
// Each IR = early reflections + exponentially decaying filtered stereo noise
// with frequency-dependent decay (highs decay faster), optional modulation.

export const IR_TYPES = {
  room:    { label: 'Room',    decay: 0.7, predelay: 0.004, er: 8,  erSpread: 0.025, damp: 6000, density: 1.0, lowCut: 120 },
  chamber: { label: 'Chamber', decay: 1.4, predelay: 0.012, er: 10, erSpread: 0.04,  damp: 7000, density: 1.0, lowCut: 100 },
  hall:    { label: 'Hall',    decay: 2.8, predelay: 0.025, er: 12, erSpread: 0.08,  damp: 5000, density: 1.0, lowCut: 80 },
  plate:   { label: 'Plate',   decay: 2.0, predelay: 0.0,   er: 0,  erSpread: 0,     damp: 11000, density: 1.6, lowCut: 200 },
  cathedral:{ label: 'Cathedral', decay: 5.5, predelay: 0.04, er: 14, erSpread: 0.12, damp: 3800, density: 1.0, lowCut: 60 },
  spring:  { label: 'Spring',  decay: 1.6, predelay: 0.0,   er: 0,  erSpread: 0,     damp: 4500, density: 0.8, lowCut: 250, spring: true },
};

// Simple deterministic PRNG so IRs are stable across sessions.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
}

export function generateIR(ctx, type = 'hall', opts = {}) {
  const p = { ...IR_TYPES[type] || IR_TYPES.hall };
  const decay = (opts.decay != null ? opts.decay : p.decay);
  const damp = opts.damp != null ? opts.damp : p.damp;
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * Math.min(8, decay * 1.5 + p.predelay + 0.1)));
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.floor(p.predelay * sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const rand = rng(1234 + c * 7919 + type.length * 31);
    // Late tail: noise * exp decay, filtered by a one-pole lowpass whose cutoff drops over time
    let lp = 0, hp = 0, prev = 0;
    const t60 = decay;
    const k = Math.log(1000) / (t60 * sr); // amplitude falls 60 dB at t60
    for (let i = pre; i < len; i++) {
      const t = (i - pre);
      let n = rand();
      if (p.density > 1) n = n * 0.6 + rand() * 0.4;
      if (p.density < 1 && Math.abs(n) < 0.3) n *= 0.2;
      const env = Math.exp(-k * t);
      // cutoff slides from damp down to damp/4 over the tail
      const frac = Math.min(1, t / (t60 * sr));
      const fc = damp * (1 - 0.75 * frac);
      const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
      lp += a * (n - lp);
      // high-pass to remove mud
      const ah = Math.exp(-2 * Math.PI * p.lowCut / sr);
      hp = ah * (hp + lp - prev);
      prev = lp;
      // fade-in to avoid click and give a smooth build-up
      const fadeIn = Math.min(1, t / (0.004 * sr + 1));
      let v = hp * env * fadeIn;
      if (p.spring) v *= 1 + 0.6 * Math.sin(2 * Math.PI * 7.5 * t / sr) * Math.exp(-t / (0.5 * sr));
      d[i] = v;
    }
    // Early reflections
    const erRand = rng(99 + c * 13);
    for (let r = 0; r < p.er; r++) {
      const time = p.predelay * 0.3 + Math.abs(erRand()) * p.erSpread + r * 0.002;
      const idx = Math.floor(time * sr);
      if (idx < len) d[idx] += erRand() * 0.8 * Math.exp(-r * 0.18);
    }
    if (p.spring) {
      // characteristic spring "boing" chirp
      for (let i = 0; i < Math.min(len, sr * 0.35); i++) {
        const t = i / sr;
        d[i] += 0.25 * Math.sin(2 * Math.PI * (300 + 2500 * t) * t) * Math.exp(-t * 9);
      }
    }
  }
  // normalise energy so different types have similar loudness
  let e = 0;
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) e += d[i] * d[i]; }
  const norm = 1 / Math.sqrt(e / 2 + 1e-9) * 0.9;
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] *= norm; }
  return buf;
}
