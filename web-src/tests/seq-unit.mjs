// Unit tests (Node, no browser) for the step sequencer core (src/js/audio/sequencer.js): data model and
// validation, polymetric timing, song chains, probability / ratchet / nudge / swing, recording helpers,
// the lock-respecting randomizer, and the runtime against a fake engine (loop segments, p-locks, MIDI out).
// Run: node tests/seq-unit.mjs
import fs from 'node:fs'; import path from 'node:path';
globalThis.window = globalThis.window || {};
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SQ = await import('../src/js/audio/sequencer.js');
const { validateProject } = await import('../src/js/validate.js');
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 400) : ''}`); };
let seed = 777; const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const pat = (len, rate = '1/16', on = []) => { const p = SQ.newPattern(len, rate); on.forEach((i) => { p.steps[i].on = true; }); return p; };

// ---- data model + validation
{
  const s = SQ.newSeq();
  ok('newSeq: on, slot A active, one 16-step 1/16 pattern, output = this track', s.on && s.active === 0 && s.patterns[0].len === 16 && s.patterns[0].rate === '1/16' && s.out === 'track' && s.ch === 1);
  const bad = { on: 'yes', active: 99, song: true, chain: [{ p: 5, rep: 3 }, { p: 0, rep: 999 }, null, 'x'], out: 'evil', port: 'p'.repeat(500) + '\u0007', ch: 99, locks: ['note', 'bogus', 'note'],
    patterns: [{ len: 500, rate: '1/7', swing: 400, name: 'n'.repeat(80), steps: Array.from({ length: 300 }, (_, i) => ({ on: i % 2 === 0, n: [60, 200, -5, 'x', 61, 62, 63, 64, 65, 66, 67], v: 999, len: 99, gate: -4, prob: 150, rat: 20, nudge: -99,
      pl: { 'inst|cutoff': 800, '__proto__|x': 1, 'bad key': 3, '3|mix': 'wet', 'plugin:plab12|7': 0.5, 'inst|evil': { a: 1 }, 'inst|s': '<script>' } })) }, ...Array(30).fill(null)] };
  const c = SQ.sanitizeSeq(bad), p = c.patterns[0], st = p.steps[0];
  ok('sanitizeSeq clamps lengths/limits: 128 steps max, 16 slots max, channel 1-16, port <= 128 chars without control chars', p.len === 128 && p.steps.length === 128 && c.patterns.length === 16 && c.ch === 16 && c.port.length === 128 && !/[\u0000-\u001f]/.test(c.port), `len=${p.len} slots=${c.patterns.length}`);
  ok('sanitizeSeq clamps step values (vel 1-127, len 0.25-16, gate 1-100, prob 0-100, ratchet 1-8, nudge +-50, <= 8 notes, notes 0-127)',
    st.v === 127 && st.len === 16 && st.gate === 1 && st.prob === 100 && st.rat === 8 && st.nudge === -50 && st.n.length <= 8 && st.n.every((n) => n >= 0 && n <= 127), JSON.stringify(st).slice(0, 200));
  ok('sanitizeSeq keeps only well-formed p-lock keys (inst|key, fx index|key, plugin:id|index) and scalar values; drops __proto__ / objects / markup',
    JSON.stringify(Object.keys(st.pl).sort()) === JSON.stringify(['3|mix', 'inst|cutoff', 'plugin:plab12|7']) && !Object.prototype.hasOwnProperty.call(st.pl, '__proto__') && ({}).x === undefined, JSON.stringify(st.pl));
  ok('sanitizeSeq: unknown rate -> 1/16, swing <= 75, name <= 24, invalid out -> track, bad chain entries dropped, duplicate / unknown field locks dropped',
    p.rate === '1/16' && p.swing === 75 && p.name.length === 24 && c.out === 'track' && c.chain.length === 1 && c.chain[0].p === 0 && c.chain[0].rep === 64 && JSON.stringify(c.locks) === '["note"]', JSON.stringify(c.chain));
  ok('sanitizeSeq: garbage in -> null / safe default pattern', SQ.sanitizeSeq(null) === null && SQ.sanitizeSeq('x') === null && SQ.sanitizeSeq({ patterns: 'no' }).patterns[0].len === 16);
  // full project validation round trip
  const proj = { format: 'auduio-project', version: 2, id: 'proj1', name: 'P', bpm: 120, scenes: 8, tracks: [{ id: 't1', kind: 'midi', name: 'Seq', color: '#8b5cf6', inst: { type: 'synth', values: {} }, fx: [], slots: [], arrangement: [], seq: SQ.newSeq() },
    { id: 't2', kind: 'audio', name: 'Vox', color: '#8b5cf6', fx: [], slots: [], arrangement: [], seq: SQ.newSeq() }], master: { fx: [], volume: 0 } };
  proj.tracks[0].seq.patterns[0].steps[2] = { ...SQ.newStep(64, true), prob: 40, rat: 3, pl: { 'inst|cutoff': 900 } };
  const v = validateProject(JSON.parse(JSON.stringify(proj))).project;
  ok('validateProject keeps a MIDI track\'s sequencer (steps, prob, ratchet, p-locks) and drops seq from audio tracks',
    v.tracks[0].seq && v.tracks[0].seq.patterns[0].steps[2].prob === 40 && v.tracks[0].seq.patterns[0].steps[2].pl['inst|cutoff'] === 900 && !v.tracks[1].seq);
}
// ---- timing
{
  const s = SQ.newSeq(); s.patterns[0] = pat(16);
  const ev = SQ.planSteps(s, 0, 4);
  ok('planSteps: one bar of 1/16 = 16 steps at beat k/4, step index 0..15', ev.length === 16 && ev.every((e, k) => near(e.beat, k / 4) && e.si === k));
  const ev2 = SQ.planSteps(s, 3.9, 4.3);
  ok('planSteps wraps the pattern: beats 3.9-4.3 -> steps 0 (4.0) and 1 (4.25) of the next cycle', ev2.map((e) => e.si).join() === '0,1' && near(ev2[0].beat, 4), ev2.map((e) => e.si + '@' + e.beat).join(' '));
  s.patterns[0].rate = '1/8t';
  ok('Triplet rate 1/8t: 3 steps per beat', SQ.planSteps(s, 0, 1).length === 3);
  // polymeter: 3-step vs 4-step patterns realign after 12 steps
  const a = SQ.newSeq(), b = SQ.newSeq(); a.patterns[0] = pat(3); b.patterns[0] = pat(4);
  const ea = SQ.planSteps(a, 0, 3).map((e) => e.si), eb = SQ.planSteps(b, 0, 3).map((e) => e.si);
  ok('Polymeter: a 3-step and a 4-step track drift and meet again on step 12 (3 beats)', ea.join('') === '012012012012' && eb.join('') === '012301230123' && SQ.planSteps(a, 3, 3.1)[0].si === 0 && SQ.planSteps(b, 3, 3.1)[0].si === 0);
  // polyrhythm: 1/16 vs 1/8t per-track rates
  const c = SQ.newSeq(); c.patterns[0] = pat(16, '1/8t');
  ok('Polyrhythm: per-track rate (1/16 vs 1/8t) gives 16 vs 12 steps per bar', SQ.planSteps(b.patterns[0].len ? { ...b, patterns: [pat(16)] } : b, 0, 4).length === 16 && SQ.planSteps(c, 0, 4).length === 12);
  ok('stepAtBeat: beat 2.3 of a 16-step 1/16 pattern is step 9', SQ.stepAtBeat({ ...s, patterns: [pat(16)] }, 2.3).si === 9);
  // queue: switch at end of current cycle
  const q = SQ.newSeq(); q.patterns = [pat(8), pat(4, '1/8')];
  const at = SQ.nextCycle(q, 1.3, 0);
  const ev3 = SQ.planSteps(q, 1.5, 2.6, { queue: { slot: 1, at } });
  ok('Pattern switch is queued to the end of the current pattern (8 x 1/16 = beat 2) and the new one starts at its step 1',
    near(at, 2) && ev3.filter((e) => e.pi === 0).every((e) => e.beat < 2) && ev3.find((e) => e.pi === 1).si === 0 && near(ev3.find((e) => e.pi === 1).beat, 2), ev3.map((e) => e.pi + ':' + e.si).join(' '));
  // song mode: A x2 (4 steps 1/16 = 1 beat each) then B x1 (2 steps of 1/8 = 1 beat)
  const g = SQ.newSeq(); g.patterns = [pat(4), pat(2, '1/8')]; g.chain = [{ p: 0, rep: 2 }, { p: 1, rep: 1 }]; g.song = true;
  const eg = SQ.planSteps(g, 0, 6);
  ok('Song mode: chain A x2, B x1 plays A A B and loops (total 3 beats)', near(SQ.chainTotal(g), 3) && eg.map((e) => 'AB'[e.pi] + e.si).join(' ') === 'A0 A1 A2 A3 A0 A1 A2 A3 B0 B1 A0 A1 A2 A3 A0 A1 A2 A3 B0 B1', eg.map((e) => 'AB'[e.pi] + e.si).join(' '));
  const sa = SQ.stepAtBeat(g, 2.6);
  ok('Song mode playhead: beat 2.6 = entry 2 (B), step 1', sa.pi === 1 && sa.si === 1 && sa.entry === 1, JSON.stringify(sa));
  ok('Song mode starting mid-chain (beat 1.5) continues correctly', SQ.planSteps(g, 1.5, 2.1).map((e) => 'AB'[e.pi] + e.si).join(' ') === 'A2 A3 B0');
}
// ---- per-step parameters
{
  const p = pat(16); const bd = 0.5, sd = 0.25 * bd;
  const s = { ...SQ.newStep(60, true), rat: 3, nudge: 20, len: 2, gate: 50 };
  const hits = SQ.expandStep(s, p, 2, bd, () => 0.5);
  ok('Ratchet 3: three hits spaced 1/3 step apart; nudge +20 % shifts them late', hits.length === 3 && near(hits[0].dt, 0.2 * sd) && near(hits[1].dt - hits[0].dt, sd / 3), hits.map((x) => x.dt.toFixed(4)).join(','));
  const one = SQ.expandStep({ ...SQ.newStep(60, true), len: 2, gate: 50 }, p, 0, bd);
  ok('Length x gate: 2 steps at 50 % gate = 1 step long', one.length === 1 && near(one[0].dur, sd));
  const chord = SQ.expandStep({ ...SQ.newStep(60, true), n: [60, 64, 67], rat: 2 }, p, 0, bd);
  ok('Chord step with ratchet 2 -> 6 notes', chord.length === 6 && new Set(chord.map((x) => x.n)).size === 3);
  let played = 0; for (let i = 0; i < 2000; i++) if (SQ.expandStep({ ...SQ.newStep(60, true), prob: 30 }, p, 0, bd, rng).length) played++;
  ok('Probability 30 %: plays about 30 % of the time (2000 runs)', played > 500 && played < 700, played);
  ok('Probability 0 % never plays, 100 % always plays', SQ.expandStep({ ...SQ.newStep(60, true), prob: 0 }, p, 0, bd, () => 0).length === 0 && SQ.expandStep(SQ.newStep(60, true), p, 0, bd, () => 0.9999).length === 1);
  const sw = pat(16); sw.swing = 50;
  ok('Swing delays odd steps only', near(SQ.expandStep(SQ.newStep(60, true), sw, 1, bd)[0].dt, 0.25 * sd) && SQ.expandStep(SQ.newStep(60, true), sw, 2, bd)[0].dt === 0);
  ok('Off steps produce nothing', SQ.expandStep(SQ.newStep(60, false), p, 0, bd).length === 0);
}
// ---- editing + recording helpers
{
  const p = pat(16);
  p.steps[20 - 16] && (p.steps[4].on = true);
  SQ.setPatternLength(p, 32); SQ.setPatternLength(p, 8); SQ.setPatternLength(p, 16);
  ok('Changing length keeps step data beyond the length (like the hardware)', p.len === 16 && p.steps.length === 32 && p.steps[4].on);
  const st = SQ.newStep(60);
  SQ.toggleNote(st, 36); SQ.toggleNote(st, 42); const both = [...st.n]; SQ.toggleNote(st, 36); SQ.toggleNote(st, 42);
  ok('Drum rows: toggling notes builds a multi-note step and turning the last one off turns the step off', both.join() === '36,42' && !st.on);
  const r1 = SQ.recordPosition(p, 1.06, 0, true), r2 = SQ.recordPosition(p, 1.06, 0, false);
  ok('Live record: quantize snaps to the nearest step (beat 1.06 -> step 4, nudge 0); unquantized keeps +24 % nudge', r1.si === 4 && r1.nudge === 0 && r2.si === 4 && r2.nudge === 24, JSON.stringify([r1, r2]));
  ok('Live record wraps: beat 4.1 on a 16-step pattern lands on step 0', SQ.recordPosition(p, 4.1).si === 0);
  const s2 = SQ.recordNote(p, 5, 62, 90, { len: 1.3 }); SQ.recordNote(p, 5, 65, 80);
  ok('recordNote: first note sets the step, a second note overdubs a chord; length rounds to 1/4 step', s2.on && s2.n.join() === '62,65' && s2.len === 1.25 && s2.v === 80);
}
// ---- randomizer respects locks
{
  const s = SQ.newSeq(); const p = s.patterns[0];
  p.steps[0] = { ...SQ.newStep(60, true), lock: true, v: 33, prob: 77 };
  p.steps[1] = { ...SQ.newStep(62, true), pl: { 'inst|cutoff': 500 } };
  s.locks = ['note'];
  const before = JSON.stringify(p.steps);
  let fine = true, changed = 0;
  for (let i = 0; i < 30; i++) {
    const out = SQ.randomizeSteps(s, p, { amount: 1, mode: i % 2 ? 'chaos' : 'musical', rng, pool: [48, 50, 52] });
    if (JSON.stringify(out[0]) !== JSON.stringify(p.steps[0])) fine = false;
    if (out.some((x, k) => x.n.join() !== p.steps[k].n.join())) fine = false;
    if (!out[1].pl || out[1].pl['inst|cutoff'] !== 500) fine = false;
    if (out.some((x, k) => JSON.stringify(x) !== JSON.stringify(p.steps[k]))) changed++;
    if (out.some((x) => x.v < 1 || x.v > 127 || x.gate < 1 || x.gate > 100 || x.rat < 1 || x.rat > 8 || x.nudge < -50 || x.nudge > 50 || x.prob < 0 || x.prob > 100)) fine = false;
  }
  ok('Randomize: protected steps untouched, locked field (notes) untouched, p-locks kept, values in range; other steps change', fine && changed === 30 && JSON.stringify(p.steps) === before);
  const z = SQ.randomizeSteps({ ...s, locks: [] }, p, { amount: 0, rng });
  ok('Randomize amount 0 changes nothing', JSON.stringify(z) === JSON.stringify(p.steps));
}
// ---- runtime against a fake engine
{
  const calls = [], outs = [], applied = [];
  const inst = { values: { cutoff: 2000 }, playNote(n, v, t, d) { calls.push({ n, v, t, d, cutoff: this.values.cutoff }); } };
  const fx0 = { values: { mix: 0.2 }, apply(k, v) { applied.push([k, v]); } };
  const engine = { ctx: { currentTime: 10 }, beatDur: 0.5, gridOffset: 0, playing: true, project: { tracks: [] }, position: () => 0 };
  const rt = new SQ.SeqRuntime(engine); engine.seq = rt;
  rt.midiOut = { note: (port, ch, n, v, at, dur) => outs.push({ port, ch, n, v, at, dur }), allOff() {} };
  const t = { id: 'T', seq: SQ.newSeq() }; engine.project.tracks.push(t);
  const p = t.seq.patterns[0]; [0, 4, 8, 12].forEach((i) => { p.steps[i].on = true; });
  p.steps[4].pl = { 'inst|cutoff': 400, '0|mix': 0.9 }; p.steps[8].n = [67];
  // transport at position 0 mapped to ctx 10.0; 2 beats window (1 s)
  rt.schedule(t, { inst, fx: [fx0] }, { c0: 10, c1: 11, p0: 0 }, 1);
  ok('Runtime: 2 beats of a 4-on-the-floor 1/16 pattern -> notes at ctx 10.0, 10.5 (steps 0, 4)', calls.length === 2 && near(calls[0].t, 10) && near(calls[1].t, 10.5), JSON.stringify(calls));
  ok('Runtime p-lock (instrument): the locked note is built with cutoff 400, the value goes back to 2000 right after', calls[1].cutoff === 400 && calls[0].cutoff === 2000 && inst.values.cutoff === 2000);
  // loop segment: positions 1.8-2.0 then loop back to 0-0.2 (loop 0..2 s = 4 beats)
  calls.length = 0;
  rt.schedule(t, { inst, fx: [fx0] }, { c0: 20, c1: 20.2, p0: 1.8 }, 2.0);
  rt.schedule(t, { inst, fx: [fx0] }, { c0: 20.2, c1: 20.4, p0: 0 }, 0.2);
  ok('Runtime follows the loop bar: after the loop jumps back to 0 the pattern restarts at step 1', calls.length === 1 && calls[0].n === 60 && near(calls[0].t, 20.2), JSON.stringify(calls));
  t.seq.out = 'both'; t.seq.port = 'abc'; t.seq.ch = 10; calls.length = 0;
  rt.schedule(t, { inst, fx: [fx0] }, { c0: 30, c1: 30.5, p0: 0 }, 0.5);
  ok('Output "Track + MIDI": the instrument and the external MIDI port (channel 10) both get the note', calls.length === 1 && outs.length === 1 && outs[0].port === 'abc' && outs[0].ch === 10 && outs[0].n === 60 && near(outs[0].at, 30));
  t.seq.out = 'midi'; calls.length = 0; outs.length = 0;
  rt.schedule(t, { inst, fx: [fx0] }, { c0: 40, c1: 40.5, p0: 0 }, 0.5);
  ok('Output "MIDI out": only the external port gets notes', calls.length === 0 && outs.length === 1);
  t.seq.on = true; t.seq.out = 'track';
  // audio-effect p-lock applies at the step time and restores the track's value afterwards
  engine.ctx.currentTime = 50; applied.length = 0;
  rt.schedule(t, { inst, fx: [fx0] }, { c0: 50, c1: 50.8, p0: 0.4 }, 1.2);
  await new Promise((r) => setTimeout(r, 400));
  ok('Runtime p-lock (audio effect): mix goes to 0.9 at the step and back to the track value (0.2) after it', applied.length === 2 && applied[0][1] === 0.9 && applied[1][1] === 0.2 && fx0.values.mix === 0.2, JSON.stringify(applied));
  // queued slot switch commits at the boundary
  t.seq.patterns[1] = pat(4); engine.position = () => 0.3; // beat 0.6
  const immediate = rt.queueSlot(t, 1);
  ok('queueSlot while playing: queued for the end of the current cycle (beat 4), not switched yet', !immediate && t.seq.active === 0 && near(rt.st('T').queue.at, 4));
  rt.schedule(t, { inst, fx: [fx0] }, { c0: 60, c1: 60.2, p0: 2.0 }, 2.2);
  ok('...and it switches when the scheduler reaches that point', t.seq.active === 1 && near(rt.st('T').anchor, 4) && !rt.st('T').queue);
  engine.playing = false; ok('queueSlot while stopped switches at once', rt.queueSlot(t, 0) === true && t.seq.active === 0);
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} passed`);
fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-seq-unit.json'), JSON.stringify({ when: new Date().toISOString(), pass, total: results.length, results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
