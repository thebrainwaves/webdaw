// Node unit tests for the tempo module (pure JS). Run: node tests/tempo-unit.mjs
import { clickTrack, detectBufferTempo, TempoAnalyzer, TempoFollower, TapTempo } from '../src/js/audio/tempo.js';
const sr = 44100; let pass = 0, fail = 0; const results = [];
const ok = (name, c, d = '') => { (c ? pass++ : fail++); results.push({ name, pass: !!c, detail: d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${d ? '  — ' + d : ''}`); };
const fakeBuf = (x) => ({ sampleRate: sr, length: x.length, numberOfChannels: 1, getChannelData: () => x });
const wrap = (e, P) => { e = ((e % P) + P) % P; return e > P / 2 ? e - P : e; };
function checkClicks(bpm, opts = {}, tolBpm = 0.3, tolMs = 12) {
  const secs = Math.max(8 * 4 * 60 / bpm, 6);
  const { x, clicks } = clickTrack(sr, secs, bpm, opts);
  const r = detectBufferTempo(fakeBuf(x));
  if (!r) return ok(`clicks ${bpm} BPM ${JSON.stringify(opts)}`, false, 'no estimate');
  const P = 60 / r.bpm; const down = clicks.filter((c) => c.down).map((c) => c.t);
  const signed = clicks.map((c) => wrap(r.phaseSec - c.t, P)).reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)); const phErr = Math.abs(signed) * 1000; if (process.env.SIGNED) console.log('signed', signed);
  const dbErr = Math.min(...down.map((t) => Math.abs(r.downbeatSec - t))) * 1000;
  ok(`clicks ${bpm} BPM ${Object.keys(opts).length ? JSON.stringify(opts) : ''}`, Math.abs(r.bpm - bpm) <= tolBpm && phErr <= tolMs && dbErr <= tolMs + 5,
    `got ${r.bpm.toFixed(2)} conf ${r.confidence.toFixed(2)} phase err ${phErr.toFixed(1)} ms downbeat err ${dbErr.toFixed(1)} ms`);
  return r;
}
for (const b of [60, 72, 90, 100, 120, 128, 140, 160, 174, 200]) checkClicks(b);
checkClicks(97, { start: 0.37 });
checkClicks(118, { jitter: 0.008, noise: 0.03 }, 0.8, 20);
checkClicks(84, { accent: 1.3 });
// drum pattern: kick 1+3, snare 2+4, 8th hats  -> must report the beat, not the 8th-note rate (half/double)
function drums(bpm, secs, sixteenths = false) {
  const x = new Float32Array(sr * secs), bd = 60 / bpm; let rnd = 7; const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const hit = (t, kind) => { const s0 = Math.round(t * sr); for (let i = 0; i < sr * 0.2 && s0 + i < x.length; i++) {
    const tt = i / sr; let v = 0;
    if (kind === 'k') v = 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 12);
    else if (kind === 's') v = 0.5 * r() * Math.exp(-tt * 25) + 0.3 * Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt * 20);
    else v = 0.12 * r() * Math.exp(-tt * 90);
    x[s0 + i] += v; } };
  for (let b = 0; b * bd < secs - 0.3; b++) {
    const t = b * bd; hit(t, b % 2 === 0 ? 'k' : 's');
    const sub = sixteenths ? 4 : 2; for (let j = 0; j < sub; j++) hit(t + j * bd / sub, 'h');
  }
  return x;
}
for (const [b, s16] of [[90, false], [70, false], [100, true], [128, false]]) {
  const r = detectBufferTempo(fakeBuf(drums(b, 8 * 4 * 60 / b, s16)));
  ok(`drum groove ${b} BPM${s16 ? ' (16th hats)' : ' (8th hats)'} -> beat level (not half/double), downbeat on a kick`, r && Math.abs(r.bpm - b) < 0.5 && Math.round(r.downbeatSec / (60 / b)) % 2 === 0 && Math.abs(r.downbeatSec / (60 / b) - Math.round(r.downbeatSec / (60 / b))) < 0.05, r ? `got ${r.bpm.toFixed(2)} (alts ${r.alternatives.join('/')}), conf ${r.confidence.toFixed(2)}, downbeat at ${r.downbeatSec.toFixed(3)} s = beat ${(r.downbeatSec / (60 / b)).toFixed(2)}` : 'none');
}
// silence / noise -> no confident estimate
{ const x = new Float32Array(sr * 8); let s = 3; for (let i = 0; i < x.length; i++) x[i] = ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2;
  const r = detectBufferTempo(fakeBuf(x)); ok('white noise gives no confident tempo', !r || r.confidence < 0.3, r ? `conf ${r.confidence.toFixed(2)} (${r.bpm.toFixed(1)})` : 'null'); }
ok('silence gives no estimate', !detectBufferTempo(fakeBuf(new Float32Array(sr * 8))));

// streaming analyser + follower over a drifting click track (100 -> 110 BPM over 40 s, then steady)
function follow(bpmFn, secs, opts = {}) {
  const { x } = clickTrack(sr, secs, bpmFn, opts);
  const an = new TempoAnalyzer(sr, { windowSec: 8 }), fol = new TempoFollower(); const trace = []; const chunk = 2048;
  for (let i = 0, next = 0.5; i < x.length; i += chunk) {
    an.push(x.subarray(i, i + chunk), i / sr);
    const t = (i + chunk) / sr;
    if (t >= next) { next += 0.5; const est = an.analyse({ prefer: fol.bpm }); const u = fol.update(est, t); trace.push({ t, bpm: u.bpm, est: est && est.bpm, conf: est && est.confidence }); }
  }
  return { trace, fol };
}
{
  const ramp = (t) => (t < 10 ? 100 : t < 40 ? 100 + (t - 10) / 30 * 10 : 110);
  const { trace } = follow(ramp, 60);
  // true tempo seen by an 8 s window lags ~4 s; allow the lag + slew
  const errs = trace.filter((p) => p.t > 12 && p.bpm).map((p) => Math.abs(p.bpm - ramp(p.t - 4)));
  const maxErr = Math.max(...errs), end = trace.at(-1).bpm;
  let maxRate = 0; for (let i = 1; i < trace.length; i++) if (trace[i].bpm && trace[i - 1].bpm) maxRate = Math.max(maxRate, Math.abs(trace[i].bpm - trace[i - 1].bpm) / (trace[i].t - trace[i - 1].t));
  ok('Follow: tracks a 100->110 BPM drift (rate-limited)', maxErr < 1.6 && Math.abs(end - 110) < 0.5 && maxRate <= 1.5 + 1e-6, `max err ${maxErr.toFixed(2)} BPM, final ${end.toFixed(2)}, max slew ${maxRate.toFixed(2)} BPM/s`);
}
{
  const { trace, fol } = follow(120, 40, { jitter: 0.01 });
  const vals = trace.filter((p) => p.t > 6 && p.bpm).map((p) => p.bpm); const spread = Math.max(...vals) - Math.min(...vals);
  ok('Follow: steady 120 BPM with ±10 ms human jitter stays put (hysteresis)', spread < 0.7 && Math.abs(vals.at(-1) - 120) < 0.6 && fol.changes <= 4, `spread ${spread.toFixed(2)} BPM, changes ${fol.changes}, final ${vals.at(-1).toFixed(2)}`);
}
{
  const fol = new TempoFollower(); fol.update({ bpm: 120, confidence: 0.9 }, 0);
  const u = fol.update({ bpm: 241, confidence: 0.9 }, 0.5); const u2 = fol.update({ bpm: 60.2, confidence: 0.9 }, 1);
  ok('Follow: double/half-time estimates are folded to the followed octave', Math.abs(u.bpm - 120) < 0.01 && Math.abs(u2.bpm - 120) < 0.01, `${u.bpm} ${u2.bpm}`);
  const u3 = fol.update({ bpm: 130, confidence: 0.1 }, 1.5); ok('Follow: low-confidence estimates are ignored', u3.bpm === 120);
}
{ const tt = new TapTempo(); let b; for (let i = 0; i < 6; i++) b = tt.tap(10 + i * 0.5 + (i % 2 ? 0.01 : -0.01)); ok('Tap tempo averages taps (≈120)', Math.abs(b - 120) < 1.5, String(b));
  tt.tap(20); ok('Tap tempo resets after a pause', tt.bpm() === null); }
console.log(`\n${pass}/${pass + fail} tempo unit checks passed`);
import('node:fs').then((fs) => fs.writeFileSync(new URL('./last-results-tempo-unit.json', import.meta.url), JSON.stringify({ pass, fail, results }, null, 1)));
process.exitCode = fail ? 1 : 0;
