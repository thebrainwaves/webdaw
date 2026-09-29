// Unit tests (Node) for clip cutting (src/js/clipedit.js). Run: node tests/clipedit-unit.mjs
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { splitClip, splitAllAt, splitAtRange, deleteSection, defaultRate } = await import('../src/js/clipedit.js');
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 300) : ''}`); };
let n = 0; const id = () => 'n' + ++n;
const near = (a, b) => Math.abs(a - b) < 1e-9;
const audio = (start, dur, extra = {}) => ({ id: id(), type: 'audio', bufferId: 'b1', start, duration: dur, offset: 0, ...extra });
const midi = (start, dur) => ({ id: id(), type: 'midi', start, duration: dur, offset: 0, lengthBeats: 8, notes: [{ t: 0, d: 1, n: 60, v: 100 }, { t: 5, d: 1, n: 64, v: 90 }] });

{ const L = [audio(2, 4)]; const r = splitClip(L, L[0], 3, id);
  ok('Split audio clip at 3 s: left 2-3, right 3-6 with source offset 1 s', L.length === 2 && near(L[0].duration, 1) && near(r.start, 3) && near(r.duration, 3) && near(r.offset, 1) && r.id !== L[0].id); }
{ const L = [audio(0, 4, { transpose: 12, offset: 0.5 })]; const r = splitClip(L, L[0], 1, id);
  ok('Split a transposed (+12, 2x rate) clip: source offset advances at the playback rate', near(r.offset, 0.5 + 2)); }
{ const L = [midi(0, 4)]; const r = splitClip(L, L[0], 2.5, id);
  ok('Split MIDI clip: both halves keep the notes, the right half starts 2.5 s into them', near(r.offset, 2.5) && r.notes.length === 2 && L[0].notes.length === 2 && r.notes !== L[0].notes); }
{ const L = [audio(0, 4)];
  ok('Split outside / at the very edge does nothing', splitClip(L, L[0], 4, id) === null && splitClip(L, L[0], 0, id) === null && splitClip(L, L[0], 9, id) === null && L.length === 1); }
{ const L = [audio(0, 4), audio(5, 4), midi(3, 4)]; const r = splitAllAt(L, 3.5, id);
  ok('Split all at 3.5 s cuts only the clips under it (2 of 3)', r.length === 2 && L.length === 5); }
{ const L = [audio(0, 10)]; const k = splitAtRange(L, 2, 6, id); const s = [...L].sort((a, b) => a.start - b.start);
  ok('Split at loop edges 2-6: three pieces 0-2, 2-6, 6-10, source continuous', k === 2 && s.length === 3 && near(s[1].start, 2) && near(s[1].offset, 2) && near(s[2].start, 6) && near(s[2].offset, 6) && near(s[2].duration, 4)); }
{ const L = deleteSection([audio(0, 10), audio(3, 2), audio(12, 2), audio(-1, 3)], 2, 6, id);
  const s = L.sort((a, b) => a.start - b.start).map((c) => [c.start, c.duration, c.offset].map((x) => +x.toFixed(3)).join('/'));
  ok('Delete section 2-6 (gap): spanning clip keeps both ends, inner clip removed, head-overlap trimmed, later clip untouched', JSON.stringify(s) === JSON.stringify(['-1/3/0', '0/2/0', '6/4/6', '12/2/0']), JSON.stringify(s)); }
{ const L = deleteSection([audio(0, 10), audio(12, 2), audio(4, 4)], 2, 6, id, { ripple: true });
  const s = L.sort((a, b) => a.start - b.start || a.offset - b.offset).map((c) => [c.start, c.duration, c.offset].map((x) => +x.toFixed(3)).join('/'));
  ok('Cut out section 2-6 (close gap): later material moves left by 4 s and joins up', JSON.stringify(s) === JSON.stringify(['0/2/0', '2/2/2', '2/4/6', '8/2/0']), JSON.stringify(s)); }
{ const L = [audio(0, 4)]; ok('Delete an empty range is a no-op', deleteSection(L, 3, 3, id).length === 1 && near(L[0].duration, 4)); }
ok('defaultRate: MIDI 1, audio 2^(transpose/12)', defaultRate({ type: 'midi', transpose: 12 }) === 1 && near(defaultRate({ transpose: -12 }), 0.5));

const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} passed`);
fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-clipedit-unit.json'), JSON.stringify({ when: new Date().toISOString(), pass, total: results.length, results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
