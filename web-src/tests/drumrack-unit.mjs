// Unit tests (Node) for the 128-pad drum rack model (src/js/audio/drumrack.js). Run: node tests/drumrack-unit.mjs
const DR = await import('../src/js/audio/drumrack.js');
const { validateProject } = await import('../src/js/validate.js');
const { usedBufferIds, lazyBufferIds } = await import('../src/js/project.js');
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 300) : ''}`); };
const bytes = (s, extra = []) => { const b = new Uint8Array(16); [...s].forEach((c, i) => (b[i] = c.charCodeAt(0))); extra.forEach(([i, v]) => (b[i] = v)); return b; };
const wav = bytes('RIFF\0\0\0\0WAVE'), aif = bytes('FORM\0\0\0\0AIFF'), flac = bytes('fLaC'), ogg = bytes('OggS'), id3 = bytes('ID3'), mp3 = bytes('', [[0, 0xff], [1, 0xfb]]);

ok('128 pads, notes 0-127; default 4x4 view starts at the kick (36)', DR.PAD_COUNT === 128 && DR.DEFAULT_VIEW === 36);
ok('View scrolls in whole rows of 4 and is clamped to 0..112', DR.clampView(37) === 36 && DR.clampView(39) === 40 && DR.clampView(-9) === 0 && DR.clampView(200) === 112 && DR.clampView('x') === 0);
ok('Overview: 4 wide x 32 tall, lowest notes bottom-left, highest top-right', DR.overviewNote(0, 31) === 0 && DR.overviewNote(3, 31) === 3 && DR.overviewNote(3, 0) === 127 && DR.overviewNote(0, 22) === 36);
ok('Overview click centres the 4-row window on the clicked row (clamped)', DR.viewFromOverviewRow(22) === 32 && DR.viewFromOverviewRow(0) === 112 && DR.viewFromOverviewRow(31) === 0, [DR.viewFromOverviewRow(22), DR.viewFromOverviewRow(0), DR.viewFromOverviewRow(31)]);
ok('4x4 grid: bottom-left = lowest note, top-right = highest', DR.gridNote(36, 3, 0) === 36 && DR.gridNote(36, 0, 3) === 51 && DR.gridNote(36, 2, 1) === 41);
ok('Pad names: user name, else GM drum name, else note name', DR.padName(36) === 'Kick' && DR.padName(38) === 'Snare' && DR.padName(0) === 'C-1' && DR.padName(60) === 'C4' && DR.padName(36, { 36: { name: 'My Kick' } }) === 'My Kick');
ok('Sample names: extension and control/markup characters removed, length-limited', DR.cleanName('kick<b>\u0007.wav') === 'kickb' && DR.cleanName('x'.repeat(90)).length === 40 && DR.cleanName('') === 'Sample');
{ const p = DR.newPad('s1', 'Snare 01.wav'); ok('newPad defaults: full sample, 0 dB, 0 st, one-shot, no choke', p.name === 'Snare 01' && p.start === 0 && p.end === 1 && p.gain === 0 && p.pitch === 0 && p.mode === 'one' && p.choke === 0, JSON.stringify(p)); }
{ const p = DR.sanitizePad({ bufferId: 's1', name: 'A', start: -1, end: 5, gain: 99, pitch: 7.6, mode: 'weird', choke: 44, extra: 1 });
  ok('sanitizePad clamps every field and drops unknown keys', p.start === 0 && p.end === 1 && p.gain === 12 && p.pitch === 8 && p.mode === 'one' && p.choke === 8 && !('extra' in p), JSON.stringify(p)); }
ok('sanitizePad: bad buffer id or start>=end handled', DR.sanitizePad({ bufferId: '../x' }) === null && DR.sanitizePad({ bufferId: 's', start: 0.8, end: 0.5 }).start === 0);
{ const P = DR.sanitizePads({ 36: { bufferId: 's1' }, 128: { bufferId: 's2' }, '-1': { bufferId: 's3' }, abc: { bufferId: 's4' }, 60: { bufferId: 'bad id' }, 127: { bufferId: 's5', mode: 'gate' } });
  ok('sanitizePads keeps only notes 0-127 with valid pads', JSON.stringify(Object.keys(P)) === '["36","127"]' && P[127].mode === 'gate', JSON.stringify(P)); }
ok('Folder / multi-file drop fills consecutive pads and stops at 127', JSON.stringify(DR.fillTargets(36, 3)) === '[36,37,38]' && DR.fillTargets(120, 20).length === 8 && DR.fillTargets(0, 500).length === 128);
ok('Files sort naturally (kick2 before kick10)', DR.sortFiles([{ name: 'kick10.wav' }, { name: 'kick2.wav' }, { name: 'Kick1.wav' }]).map((f) => f.name).join() === 'Kick1.wav,kick2.wav,kick10.wav');
ok('Magic bytes recognised: WAV, AIFF, FLAC, OGG, MP3 (ID3 + frame sync)', DR.sniffAudio(wav) === 'wav' && DR.sniffAudio(aif) === 'aiff' && DR.sniffAudio(flac) === 'flac' && DR.sniffAudio(ogg) === 'ogg' && DR.sniffAudio(id3) === 'mp3' && DR.sniffAudio(mp3) === 'mp3' && DR.sniffAudio(bytes('%PDF-1.7')) === null);
ok('File check: accepted types pass', DR.checkSampleFile('a.wav', 1000, wav) === null && DR.checkSampleFile('b.AIF', 10, aif) === null && DR.checkSampleFile('c.mp3', 10, id3) === null && DR.checkSampleFile('d.flac', 10, flac) === null && DR.checkSampleFile('e.ogg', 10, ogg) === null);
ok('File check: wrong extension, empty, too large, fake content and mismatches are rejected with a reason',
  /not a supported/.test(DR.checkSampleFile('x.exe', 10, wav)) && /empty/.test(DR.checkSampleFile('x.wav', 0, wav)) && /larger than 50 MB/.test(DR.checkSampleFile('x.wav', 60 * 1048576, wav))
  && /not audio/.test(DR.checkSampleFile('x.wav', 10, bytes('<html>'))) && /contains MP3/.test(DR.checkSampleFile('x.wav', 10, id3)));
{ const r = DR.playRegion({ start: 0.25, end: 0.75 }, 2); ok('Trim: the pad plays only its start..end part', r.offset === 0.5 && r.length === 1); }
{ const sr = 1000, l = new Float32Array(40 * sr).fill(0.5), r = l.slice(); const c = DR.compactChannels([l, r], sr);
  ok('Memory: identical stereo becomes mono, long files are cut to 30 s', c.chans.length === 1 && c.chans[0].length === 30 * sr && c.cut);
  r[5] = -0.5; ok('Real stereo stays stereo', DR.compactChannels([l.subarray(0, 100), r.subarray(0, 100)], sr).chans.length === 2); }
{ const d = new Float32Array(1000); d[10] = 1; d[900] = -0.5; const pk = DR.peaks(d, 10); ok('Peaks for the mini waveform (min/max per column)', pk.length === 20 && pk[1] === 1 && pk[18] === -0.5); }
// project integration: pads survive validation, their audio is referenced, and they load lazily
{ const raw = { format: 'webdaw-project', version: 2, id: 'p1', name: 'x', bpm: 120, tracks: [{ id: 't1', kind: 'midi', name: 'D', slots: [], arrangement: [{ id: 'c1', bufferId: 'b1', start: 0, duration: 1, offset: 0 }], inst: { type: 'drums', values: {}, pads: { 36: { bufferId: 's1', name: 'K' }, 200: { bufferId: 's2' }, 38: { bufferId: 'b1', name: 'shared' } } } }] };
  let v; try { v = validateProject(raw); } catch (e) { ok('validateProject accepts drum pads', false, e.message); }
  if (v) {
    const P = v.project.tracks[0].inst.pads;
    ok('Import validation keeps valid pads, drops out-of-range ones', P && P[36] && P[36].name === 'K' && !P[200] && P[38], JSON.stringify(P));
    ok('Pad samples count as project audio (saved + exported inside the project)', v.bufferIds.has('s1') && usedBufferIds(v.project).has('s1'));
    const lz = lazyBufferIds(v.project); ok('Pad-only samples load lazily; audio also used by clips loads right away', lz.has('s1') && !lz.has('b1'), JSON.stringify([...lz]));
  }
  const bad = { ...raw, tracks: [{ ...raw.tracks[0], inst: { type: 'synth', values: {}, pads: { 36: { bufferId: 's1' } } } }] };
  ok('Pads on a non-drum instrument are dropped', !validateProject(bad).project.tracks[0].inst.pads); }

const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} drum rack unit checks passed`);
process.exit(pass === results.length ? 0 : 1);
