// Device randomizer. Pure functions (no DOM/audio) so the same logic randomizes native instruments,
// audio effects, MIDI effects and hosted plugins (whose parameters arrive as normalized 0..1 values).
//
// randomizeValues(defs, values, opts) -> { key: newValue } for every parameter it changed.
//   defs     parameter definitions: { key, label, min, max, def, curve:'log', step, type:'select', options }
//   opts     { amount: 0..1, mode: 'musical'|'chaos', locks: Set|Array of keys, rng: () => 0..1, deviceType }
// amount blends from the current value toward a random target (0 = nothing, 1 = fully random).
// Musical mode never touches output level params, keeps feedback/resonance/drive in a sane range, keeps
// envelopes playable, uses musical intervals for transpose params and balances EQ boosts so the result
// does not get louder (clipping). Locked params are never touched in either mode.

// parameters that set output level: never randomized in musical mode (a random +24 dB is how you clip)
const KEEP = /^(gain|level|makeup|master|ceiling|input|volume|output|out|outgain|keysource|root|scale|poly|velsens)$/i;
// plugin parameters only have names: keep global/output levels and switches that silence or detune the sound
const KEEP_LABEL = /(master|output|main|out|global|scene( [a-d])?)\s*(vol|volume|gain|level)|^(volume|vol|gain|level|output|master|out)$|bypass|mute|solo|polyphony|poly limit|voices|\bmpe\b|\bmidi\b|vca gain|amp gain|pre-filter gain|pitch ?bend|tuning|octave|\bpan law|oversampl/i;
// plugin structure selectors (filter/oscillator type, routing, play/scene mode): musical mode tweaks the sound
// of the current patch instead of rebuilding it, because a random filter type + routing is the usual cause of silence
const PLUGIN_STRUCT = /type|subtype|config|routing|\broute|\bmode\b|split|algorithm|active scene|scene select/i;
// [lo, hi] fraction of the (log-)range allowed in musical mode, by key/label pattern
const RANGES = [
  [/feedback|fdbk|^fb$|regen/i, 0, 0.7],
  [/reso|^q$|emphasis/i, 0, 0.7],
  [/drive|dist|saturat|overdrive|crush/i, 0, 0.6],
  [/^mix$|wet|dry\/wet/i, 0.1, 0.6],
  [/^hpf$|low\s*cut|lowcut/i, 0, 0.45],
  [/^lpf$|high\s*cut/i, 0.55, 1],
  [/cutoff/i, 0.3, 1],
  [/(^a|attack|^fa|^aa|^ea)$|attack/i, 0, 0.55],
  [/^(ar|fr|er)$|release/i, 0.05, 0.7],
  [/^(as|fs|es)$|sustain/i, 0.3, 1],
  [/decay$/i, 0.05, 0.7],
  [/gate$/i, 0, 0.4],
  [/glide|portamento/i, 0, 0.15],
  [/threshold/i, 0.35, 0.9],
  [/gain$/i, 0.25, 0.75], // EQ band gains (+-18 -> about +-9 dB)
  [/volume|level|\bvol\b|amount/i, 0.45, 0.85], // oscillator / layer levels: audible, not clipping
];
const TYPE_RANGES = {
  amp: { gain: [0, 0.7] },
  compressor: { mix: [0.4, 1] },
  notelength: { gate: [0.1, 0.5] },
  velocity: { min: [0, 0.35], max: [0.7, 1], offset: [0.35, 0.65], drive: [0.25, 0.75] },
  random: { chance: [0, 0.6] },
  arp: { gate: [0.3, 1] },
  drums: { tune: [0.3, 0.7] },
  pitch: { mix: [0.6, 1], amount: [0.3, 1] },
};
const TYPE_KEEP = { amp: new Set(['master']), maximizer: new Set(['gain', 'ceiling']), limiter: new Set(['input', 'ceiling']), scale: new Set(['keySource', 'root', 'scale']) };
const INTERVALS = [-12, -7, -5, 0, 0, 5, 7, 12];

const isLog = (p) => p.curve === 'log' && p.min > 0;
function toNorm(p, v) { if (isLog(p)) return Math.log(v / p.min) / Math.log(p.max / p.min); return (v - p.min) / (p.max - p.min || 1); }
function fromNorm(p, n) {
  n = Math.max(0, Math.min(1, n));
  let v = isLog(p) ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min);
  if (p.step) v = Math.round(v / p.step) * p.step;
  else if (isLog(p)) v = +v.toPrecision(3);
  else { const span = p.max - p.min; v = +v.toFixed(span >= 100 ? 0 : span >= 10 ? 1 : span >= 1 ? 2 : 3); }
  return Math.max(p.min, Math.min(p.max, v));
}
export function isKeptParam(p, deviceType) {
  if (TYPE_KEEP[deviceType]) { if (TYPE_KEEP[deviceType].has(p.key)) return true; }
  if (deviceType === 'amp' && p.key === 'gain') return false; // amp "gain" is the drive knob
  return p.plugin ? KEEP_LABEL.test(p.label || '') || KEEP.test(p.label || '') || PLUGIN_STRUCT.test(p.label || '') : KEEP.test(p.key);
}
export function musicalRange(p, deviceType) {
  const T = TYPE_RANGES[deviceType]; if (T && T[p.key]) return T[p.key];
  const s = p.plugin ? p.label || '' : p.key;
  for (const [re, lo, hi] of RANGES) if (re.test(s)) return [lo, hi];
  return [0, 1];
}
const hasLock = (locks, k) => (locks instanceof Set ? locks.has(k) : Array.isArray(locks) && locks.includes(k));

export function randomizeValues(defs, values, opts = {}) {
  const amount = Math.max(0, Math.min(1, opts.amount == null ? 0.5 : opts.amount));
  const musical = opts.mode !== 'chaos', rng = opts.rng || Math.random, type = opts.deviceType;
  const out = {};
  if (!amount) return out;
  for (const p of defs) {
    if (hasLock(opts.locks, p.key) || p.type === 'set' || p.readOnly) continue;
    if (musical && isKeptParam(p, type)) continue;
    const cur = values[p.key] != null ? values[p.key] : p.def;
    if (p.type === 'select') {
      if (!p.options || p.options.length < 2) continue;
      if (rng() < amount) { const o = p.options[Math.floor(rng() * p.options.length)]; if (o !== cur) out[p.key] = o; }
      continue;
    }
    if (typeof cur !== 'number' || !(p.max > p.min)) continue;
    let v;
    if (musical && /semi$|^transpose$|^shift$/i.test(p.key) && p.step >= 1 && p.max >= 12) {
      // musical intervals (octave / fifth / fourth) instead of random semitones
      v = rng() < amount ? Math.max(p.min, Math.min(p.max, INTERVALS[Math.floor(rng() * INTERVALS.length)])) : cur;
    } else {
      const [lo, hi] = musical ? musicalRange(p, type) : [0, 1];
      const target = lo + rng() * (hi - lo);
      let n = toNorm(p, cur) + (target - toNorm(p, cur)) * amount;
      if (musical) n = Math.max(Math.min(lo, toNorm(p, cur)), Math.min(Math.max(hi, toNorm(p, cur)), n));
      v = fromNorm(p, n);
    }
    if (v !== cur) out[p.key] = v;
  }
  if (musical) balanceBoosts(defs, values, out, opts.locks);
  return out;
}
// musical mode: EQ-style boosts must not add up to a louder signal. Sum of positive dB gains is kept <= +6.
function balanceBoosts(defs, values, out, locks) {
  const gains = defs.filter((p) => /gain$/i.test(p.key) && p.key.length > 4 && p.min < 0 && p.max > 0 && !hasLock(locks, p.key));
  if (gains.length < 2) return;
  const val = (p) => (out[p.key] != null ? out[p.key] : values[p.key] != null ? values[p.key] : p.def);
  const boost = gains.reduce((a, p) => a + Math.max(0, val(p)), 0);
  if (boost <= 6) return;
  const k = 6 / boost; for (const p of gains) { const v = val(p); if (v > 0) out[p.key] = fromNorm(p, toNorm(p, v * k)); }
}
export const RANDOM_DEFAULTS = { amount: 50, mode: 'musical' };
