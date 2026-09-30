// Unit tests (Node, no browser) for the device randomizer and the MIDI effects. Run: node tests/randomize-unit.mjs
import fs from 'node:fs'; import path from 'node:path';
globalThis.window = globalThis.window || {};
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { randomizeValues, isKeptParam, musicalRange } = await import('../src/js/randomize.js');
const { MIDI_FX_TYPES, MidiFxChain, midiFxDefaults, snapToScale } = await import('../src/js/audio/midifx.js');
const { EFFECT_TYPES } = await import('../src/js/audio/effects.js');
const { INSTRUMENT_TYPES } = await import('../src/js/audio/instruments.js');
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 400) : ''}`); };
let seed = 12345; const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const defaults = (defs) => Object.fromEntries(defs.map((p) => [p.key, p.def]));
const within = (p, v) => p.type === 'select' ? p.options.includes(v) : v >= p.min - 1e-9 && v <= p.max + 1e-9;

// 1. every native device: values stay in range and valid, for both modes and many runs
{
  let bad = []; const all = [...Object.entries(EFFECT_TYPES), ...Object.entries(INSTRUMENT_TYPES), ...Object.entries(MIDI_FX_TYPES)];
  for (const [type, C] of all) for (const mode of ['musical', 'chaos']) {
    let v = defaults(C.params);
    for (let i = 0; i < 60; i++) { const ch = randomizeValues(C.params, v, { amount: 1, mode, rng, deviceType: type }); v = { ...v, ...ch };
      for (const p of C.params) if (p.type !== 'set' && !within(p, v[p.key])) bad.push(`${type}.${p.key}=${v[p.key]}`); }
  }
  ok('All native instruments, audio effects and MIDI effects randomize to valid in-range values (60 runs x 2 modes each)', !bad.length && all.length >= 21, bad.slice(0, 5).join(', ') + ` devices=${all.length}`);
}
// 2. musical mode keeps output levels
{
  const cases = [['maximizer', ['gain', 'ceiling']], ['limiter', ['input', 'ceiling']], ['compressor', ['makeup']], ['distortion', ['level']], ['amp', ['master']]];
  const bad = [];
  for (const [type, keys] of cases) { const C = EFFECT_TYPES[type]; const v = defaults(C.params); for (let i = 0; i < 100; i++) { const ch = randomizeValues(C.params, v, { amount: 1, rng, deviceType: type }); for (const k of keys) if (k in ch) bad.push(type + '.' + k); } }
  for (const type of ['synth', 'wavetable', 'drums']) { const C = INSTRUMENT_TYPES[type]; for (let i = 0; i < 100; i++) if ('gain' in randomizeValues(C.params, defaults(C.params), { amount: 1, rng, deviceType: type })) bad.push(type + '.gain'); }
  ok('Musical mode never changes output level params (maximizer gain/ceiling, limiter input/ceiling, compressor makeup, distortion level, amp master, instrument gain)', !bad.length, bad.slice(0, 6).join(','));
  const M = EFFECT_TYPES.maximizer; let changed = 0; for (let i = 0; i < 30; i++) if ('gain' in randomizeValues(M.params, defaults(M.params), { amount: 1, mode: 'chaos', rng })) changed++;
  ok('Chaos mode does randomize level params (only locks protect them)', changed > 20, 'changed ' + changed + '/30');
}
// 3. musical ranges: feedback, resonance, drive, mix, envelopes
{
  const worst = { fb: 0, reso: 0, drive: 0, mixMax: 0, mixMin: 100, attack: 0 };
  for (let i = 0; i < 300; i++) {
    const d = randomizeValues(EFFECT_TYPES.delay.params, defaults(EFFECT_TYPES.delay.params), { amount: 1, rng, deviceType: 'delay' });
    if (d.feedback != null) worst.fb = Math.max(worst.fb, d.feedback);
    if (d.mix != null) { worst.mixMax = Math.max(worst.mixMax, d.mix); worst.mixMin = Math.min(worst.mixMin, d.mix); }
    const s = randomizeValues(INSTRUMENT_TYPES.synth.params, defaults(INSTRUMENT_TYPES.synth.params), { amount: 1, rng, deviceType: 'synth' });
    if (s.reso != null) worst.reso = Math.max(worst.reso, s.reso); if (s.drive != null) worst.drive = Math.max(worst.drive, s.drive);
    if (s.aA != null) worst.attack = Math.max(worst.attack, s.aA);
  }
  ok('Musical mode keeps delay feedback <= 70 % of range, mix 10..60 %, synth resonance <= 70 %, drive <= 60 %, attack short enough to be playable',
    worst.fb <= 0.7 * 95 + 0.5 && worst.mixMax <= 60.5 && worst.mixMin >= 9.5 && worst.reso <= 70.5 && worst.drive <= 60.5 && worst.attack <= 1 * Math.pow(3000, 0.55) + 1, JSON.stringify(worst));
  let maxBoost = 0; for (let i = 0; i < 300; i++) { const C = EFFECT_TYPES.eq; const v = { ...defaults(C.params), ...randomizeValues(C.params, defaults(C.params), { amount: 1, rng, deviceType: 'eq' }) };
    maxBoost = Math.max(maxBoost, ['lowGain', 'm1Gain', 'm2Gain', 'highGain'].reduce((a, k) => a + Math.max(0, v[k]), 0)); }
  ok('Musical mode balances EQ boosts (sum of boosts <= +6 dB, so a random EQ cannot make the track clip)', maxBoost <= 6.3, 'max total boost ' + maxBoost.toFixed(2));
  const semis = new Set(); for (let i = 0; i < 200; i++) { const s = randomizeValues(INSTRUMENT_TYPES.synth.params, defaults(INSTRUMENT_TYPES.synth.params), { amount: 1, rng, deviceType: 'synth' }); if (s.o2semi != null) semis.add(s.o2semi); }
  ok('Musical mode transposes oscillators by musical intervals only (octave, fifth, fourth)', [...semis].every((x) => [-12, -7, -5, 0, 5, 7, 12].includes(x)) && semis.size >= 3, [...semis].join(','));
}
// 4. locks, amount
{
  const C = EFFECT_TYPES.eq, v = defaults(C.params);
  let touched = 0; for (let i = 0; i < 100; i++) { const ch = randomizeValues(C.params, v, { amount: 1, mode: 'chaos', rng, locks: ['lowGain', 'hpf'] }); if ('lowGain' in ch || 'hpf' in ch) touched++; }
  ok('Locked params are never changed (100 chaos runs)', touched === 0);
  ok('Amount 0 changes nothing', Object.keys(randomizeValues(C.params, v, { amount: 0, rng })).length === 0);
  let dSmall = 0, dBig = 0; for (let i = 0; i < 200; i++) { const a = randomizeValues(C.params, v, { amount: 0.1, mode: 'chaos', rng }), b = randomizeValues(C.params, v, { amount: 1, mode: 'chaos', rng });
    dSmall += Math.abs((a.m1Gain ?? 0) - 0); dBig += Math.abs((b.m1Gain ?? 0) - 0); }
  ok('Amount scales how far values move (10 % moves much less than 100 %)', dSmall * 4 < dBig, `avg |d| ${(dSmall / 200).toFixed(2)} vs ${(dBig / 200).toFixed(2)} dB`);
  const sel = randomizeValues(EFFECT_TYPES.reverb.params, defaults(EFFECT_TYPES.reverb.params), { amount: 1, mode: 'chaos', rng: () => 0.99 });
  ok('Select params (e.g. reverb space) are randomized to valid options', !sel.space || EFFECT_TYPES.reverb.params.find((p) => p.key === 'space').options.includes(sel.space), JSON.stringify(sel));
}
// 5. plugin-style params (normalized, labels)
{
  const defs = [{ key: '0', label: 'Master Volume', min: 0, max: 1, def: 0.7, plugin: true }, { key: '1', label: 'Filter Cutoff', min: 0, max: 1, def: 0.5, plugin: true }, { key: '2', label: 'Delay Feedback', min: 0, max: 1, def: 0.2, plugin: true }, { key: '3', label: 'Osc A Level', min: 0, max: 1, def: 0.8, plugin: true }];
  let vol = 0, fb = 0; for (let i = 0; i < 200; i++) { const ch = randomizeValues(defs, defaults(defs), { amount: 1, rng }); if ('0' in ch) vol++; if (ch['2'] != null) fb = Math.max(fb, ch['2']); }
  ok('Plugin params: musical mode keeps "Master Volume" and caps "Delay Feedback" by parameter name', vol === 0 && fb <= 0.701 && isKeptParam(defs[0]) && !isKeptParam(defs[1]) && musicalRange(defs[2])[1] === 0.7, `vol changed ${vol}, max fb ${fb}`);
}
// 6. MIDI effects chain (fake engine + recording instrument)
function rig(defs, extra = {}) {
  const calls = [];
  const sink = { playNote: (n, v, t, d) => calls.push({ f: 'play', n, v, t, d }), noteOn: (n, v, t) => calls.push({ f: 'on', n, v, t }), noteOff: (n, t) => calls.push({ f: 'off', n, t }), allOff: () => calls.push({ f: 'alloff' }) };
  const engine = { project: { key: { root: 0, scale: 'major' }, bpm: 120 }, beatDur: 0.5, playing: false, gridOffset: 0, ctx: { currentTime: 0 }, ...extra };
  const track = { midiFx: defs.map((d) => { const x = midiFxDefaults(d.type); Object.assign(x.values, d.values || {}); if (d.enabled === false) x.enabled = false; return x; }) };
  return { chain: new MidiFxChain(engine, track, sink), calls, engine, track };
}
{
  const { chain, calls } = rig([{ type: 'chord', values: { shape: 'major' } }]);
  chain.playNote(60, 100, 1, 0.5);
  ok('Chord: one note in -> major triad out (60, 64, 67) with softer upper notes', calls.map((c) => c.n).join() === '60,64,67' && calls[1].v < 100 && calls.every((c) => c.t === 1 && c.d === 0.5), JSON.stringify(calls));
  calls.length = 0; chain.noteOn(62, 90, 2); chain.noteOff(62, 3);
  ok('Chord live: noteOff releases every note of the chord it started', calls.filter((c) => c.f === 'on').map((c) => c.n).join() === '62,66,69' && calls.filter((c) => c.f === 'off').map((c) => c.n).sort().join() === '62,66,69', JSON.stringify(calls));
}
{
  const { chain, calls } = rig([{ type: 'scale' }]);
  for (const n of [60, 61, 63, 66, 70]) chain.playNote(n, 100, 0, 0.1);
  ok('Scale: notes snap into the song key (C major)', calls.every((c) => [0, 2, 4, 5, 7, 9, 11].includes(c.n % 12)), calls.map((c) => c.n).join());
  ok('snapToScale works for A minor', snapToScale(68, 9, 'minor') % 12 !== 8);
}
{
  const { chain, calls } = rig([{ type: 'velocity', values: { offset: -20, max: 90 } }, { type: 'notelength', values: { mode: 'fixed', length: '1/16', gate: 100 } }]);
  chain.playNote(60, 127, 0, 2);
  ok('Velocity + Note Length: 127 -> clamp 90, 2 s note -> 1/16 at 120 BPM (0.125 s)', calls[0].v === 90 && Math.abs(calls[0].d - 0.125) < 1e-9, JSON.stringify(calls));
}
{
  const { chain, calls } = rig([{ type: 'random', values: { chance: 100, range: 5, inKey: 'on' } }]);
  for (let i = 0; i < 50; i++) chain.playNote(60, 100, 0, 0.1);
  ok('Random (in key): every note moved within range and inside C major', calls.every((c) => c.n !== 60 && Math.abs(c.n - 60) <= 7 && [0, 2, 4, 5, 7, 9, 11].includes(c.n % 12)), [...new Set(calls.map((c) => c.n))].join());
}
{
  const { chain, calls, engine } = rig([{ type: 'arp', values: { mode: 'up', rate: '1/8', octaves: 1, gate: 50, accent: 0 } }]);
  chain.noteOn(64, 100, 0); chain.noteOn(60, 100, 0); chain.noteOn(67, 100, 0);
  for (let t = 0; t < 1.5; t += 0.05) { engine.ctx.currentTime = t; chain.tick(t, t + 0.1); }
  const seq = calls.filter((c) => c.f === 'play');
  ok('Arpeggiator (up, 1/8 at 120 BPM): held C-E-G play as 60,64,67,60,... every 0.25 s with 50 % gate',
    seq.slice(0, 6).map((c) => c.n).join() === '60,64,67,60,64,67' && seq.slice(0, 6).every((c, i) => Math.abs(c.t - i * 0.25) < 1e-6 && Math.abs(c.d - 0.125) < 1e-9), JSON.stringify(seq.slice(0, 7).map((c) => [c.n, +c.t.toFixed(3)])));
  calls.length = 0; chain.noteOff(60, 1.6); chain.noteOff(64, 1.6); chain.noteOff(67, 1.6);
  for (let t = 1.6; t < 2.5; t += 0.05) { engine.ctx.currentTime = t; chain.tick(t, t + 0.1); }
  ok('Arpeggiator stops when the keys are released', !calls.some((c) => c.f === 'play'), JSON.stringify(calls.slice(0, 3)));
  const r2 = rig([{ type: 'arp', values: { mode: 'updown', rate: '1/16', octaves: 2 } }]);
  r2.chain.playNote(60, 100, 0, 1); r2.chain.playNote(64, 100, 0, 1);
  for (let t = 0; t < 1.2; t += 0.05) { r2.engine.ctx.currentTime = t; r2.chain.tick(t, t + 0.1); }
  const s2 = r2.calls.filter((c) => c.f === 'play').map((c) => c.n);
  ok('Arpeggiator from clip notes (up/down, 2 octaves): 60,64,72,76,72,64,... and stops after the notes end', s2.slice(0, 7).join() === '60,64,72,76,72,64,60' && s2.length === 8, s2.join());
}
{
  const { chain, calls } = rig([{ type: 'chord', enabled: false }]);
  chain.playNote(60, 100, 0, 0.1);
  ok('Bypassed MIDI effects pass notes through unchanged', calls.length === 1 && calls[0].n === 60);
}
{
  // hosted plugin parameters (normalized, only names known)
  const names = ['Global Volume', 'A Osc 1 Type', 'A Filter 1 Type', 'A Filter 1 Cutoff', 'A Filter 1 Resonance', 'FX Chain Bypass', 'Active Scene', 'Scene Mode', 'A Amp EG Attack', 'A Osc 1 Pitch', 'Polyphony Limit', 'A VCA Gain', 'Main Out Vol', 'Env1 Sustain'];
  const defs = names.map((n, i) => ({ key: String(i), label: n, min: 0, max: 1, def: 0.5, plugin: true }));
  const cur = Object.fromEntries(defs.map((p) => [p.key, 0.5]));
  const out = randomizeValues(defs, cur, { amount: 1, mode: 'musical', rng });
  const changedNames = Object.keys(out).map((k) => names[+k]);
  const kept = ['Global Volume', 'A Osc 1 Type', 'A Filter 1 Type', 'FX Chain Bypass', 'Active Scene', 'Scene Mode', 'Polyphony Limit', 'A VCA Gain', 'Main Out Vol'];
  ok('Plugin params, musical: volume, bypass, polyphony and structure selectors (osc/filter type, scene mode) are kept; sound params change', kept.every((n) => !changedNames.includes(n)) && ['A Filter 1 Cutoff', 'A Filter 1 Resonance', 'A Osc 1 Pitch'].every((n) => changedNames.includes(n)), changedNames.join(', '));
  const ch = randomizeValues(defs, cur, { amount: 1, mode: 'chaos', rng, locks: ['0'] });
  ok('Plugin params, chaos: everything but locked changes', !('0' in ch) && Object.keys(ch).length >= names.length - 2, Object.keys(ch).length + ' changed');
  const res = Object.keys(out).find((k) => names[+k] === 'A Filter 1 Resonance'), att = Object.keys(out).find((k) => names[+k] === 'A Amp EG Attack'), sus = Object.keys(out).find((k) => names[+k] === 'Env1 Sustain');
  ok('Plugin params, musical: resonance <= 0.7, attack <= 0.55, sustain >= 0.3', out[res] <= 0.7 && (att == null || out[att] <= 0.55) && (sus == null || out[sus] >= 0.3), JSON.stringify({ res: out[res], att: out[att], sus: out[sus] }));
}
{
  const { validateProject } = await import('../src/js/validate.js');
  const base = { format: 'auduio-project', version: 2, id: 'p1', name: 'p', bpm: 120, scenes: 1, tracks: [{ id: 'tm1', name: 'Poly Synth', kind: 'midi', color: '#8B5CF6', slots: [null], arrangement: [], fx: [], inst: { type: 'synth', values: {} },
    plugins: [{ id: 'plA', uid: 'VST3-Wave Synth 2-abc', name: 'Wave Synth 2', format: 'VST3', instrument: true, state: 'QUJD', values: { 3: 0.25, 99999: 1, x: 0.5, 5: 7 }, locks: ['3', 'zz'], macros: [{ name: 'Bright', value: 0.4, targets: [{ i: 3, min: 0, max: 1 }] }], auto: { 3: [[4, 0.5], [0, 0.1], 'bad'] } },
      { id: 'b"ad<id>', uid: 'VST3-Fx', name: 'FX', state: 'not base64!!', values: {} }] }],
    midiMap: [{ ch: 0, cc: 20, trackId: 'tm1', fx: 'plugin:plA', key: '3' }, { ch: 0, cc: 21, trackId: 'tm1', fx: 'plugin:plA', key: 'nope' }] };
  let v = null, err = null; try { v = validateProject(JSON.parse(JSON.stringify(base))).project; } catch (e) { err = e.message; }
  const pl = v && v.tracks[0].plugins;
  ok('Project validation keeps plugins (uid, state, values, locks, macros, sorted automation) and drops junk', pl && pl.length === 2 && pl[0].state === 'QUJD' && JSON.stringify(pl[0].values) === '{"3":0.25,"5":1}' && pl[0].locks.join() === '3' && pl[0].macros[0].targets[0].i === 3 && JSON.stringify(pl[0].auto['3']) === '[[0,0.1],[4,0.5]]' && pl[1].id === 'badid' && pl[1].state == null && v.midiMap.length === 1, err || JSON.stringify(pl));
  let rej = null; try { validateProject({ ...base, tracks: [{ ...base.tracks[0], plugins: [{ name: 'no uid' }] }] }); } catch (e) { rej = e.message; }
  ok('A plugin entry without a uid is rejected', /plugin/.test(rej || ''), rej);
  let many = null; try { validateProject({ ...base, tracks: [{ ...base.tracks[0], plugins: Array.from({ length: 9 }, (_, i) => ({ uid: 'u' + i })) }] }); } catch (e) { many = e.message; }
  ok('More than 8 plugins per track is rejected', /too many plugins/.test(many || ''), many);
}
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-randomize-unit.json'), JSON.stringify(results, null, 2));
process.exit(passed === results.length ? 0 : 1);
