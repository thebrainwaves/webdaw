import { Engine } from './audio/engine.js';
import { EFFECT_TYPES } from './audio/effects.js';
import { analyzeBuffers } from './audio/detect.js';
import { PRESETS, INSTRUMENTS, INSTRUMENT_LABELS, defaultPresetName } from './audio/presets.js';
import { newProject, newTrack, DB, exportProjectZip, importProjectFile, uid, TRACK_COLORS, encodeWav } from './project.js';
import { createKnob, createFader } from './ui/controls.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? e.style.setProperty(sk, sv) : (e.style[sk] = sv); }
    else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};

export const engine = new Engine();
const S = { project: null, selected: null, view: 'session', zoom: 40, selClip: null, deferredInstall: null, devices: { inputs: [], outputs: [] } };
window.__daw = { engine, S }; // handy for debugging/tests

// ------------------------------------------------------------------ utils
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
let saveTimer;
function markDirty() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1200); }
async function saveNow() {
  clearTimeout(saveTimer);
  try { await DB.saveProject(S.project, engine.buffers); $('#saveState').textContent = 'Saved'; }
  catch (e) { console.warn(e); $('#saveState').textContent = 'Save failed'; toast('Could not save to browser storage: ' + e.message); }
}
const track = (id) => S.project.tracks.find((t) => t.id === id);
const fmtPos = (pos) => {
  const bd = engine.beatDur, bpb = S.project.beatsPerBar || 4;
  const beats = pos / bd; const bar = Math.floor(beats / bpb) + 1, beat = Math.floor(beats % bpb) + 1, six = Math.floor((beats % 1) * 4) + 1;
  return `${bar}.${beat}.${six}`;
};
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// waveform peak cache
const peakCache = new WeakMap();
function peaks(buf) {
  let p = peakCache.get(buf); if (p) return p;
  const block = 256, n = Math.ceil(buf.length / block); p = new Float32Array(n * 2);
  const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let mn = 1, mx = -1;
    for (let j = i * block; j < Math.min(buf.length, (i + 1) * block); j++) for (const d of chans) { const v = d[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
    p[i * 2] = mn; p[i * 2 + 1] = mx;
  }
  peakCache.set(buf, p); return p;
}
function drawWave(canvas, buf, offset = 0, duration = null, color = 'rgba(0,0,0,.55)') {
  const w = canvas.width = Math.max(1, Math.min(4096, Math.round(canvas.clientWidth * devicePixelRatio)));
  const hh = canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  const g = canvas.getContext('2d'); g.clearRect(0, 0, w, hh); g.fillStyle = color;
  if (!buf) return;
  const p = peaks(buf), block = 256, sr = buf.sampleRate;
  const s0 = offset * sr / block, s1 = (offset + (duration ?? buf.duration - offset)) * sr / block;
  for (let x = 0; x < w; x++) {
    const a = Math.floor(s0 + (x / w) * (s1 - s0)), b = Math.max(a + 1, Math.floor(s0 + ((x + 1) / w) * (s1 - s0)));
    let mn = 0, mx = 0;
    for (let i = a; i < b && i * 2 < p.length; i++) { if (p[i * 2] < mn) mn = p[i * 2]; if (p[i * 2 + 1] > mx) mx = p[i * 2 + 1]; }
    g.fillRect(x, (0.5 - mx * 0.5) * hh, 1, Math.max(1, (mx - mn) * 0.5 * hh));
  }
}

// ------------------------------------------------------------------ context menu
function contextMenu(x, y, items) {
  closeMenus();
  const m = h('div', { class: 'ctxmenu' }, items.map((it) => it === '-' ? h('hr') : h('button', { onclick: () => { closeMenus(); it.fn(); } }, it.label)));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, { once: true }), 0);
}
function onDocDown(e) { if (!e.target.closest('.ctxmenu')) closeMenus(); else document.addEventListener('pointerdown', onDocDown, { once: true }); }
function closeMenus() { $$('.ctxmenu').forEach((m) => m.remove()); $('#menu').classList.remove('open'); }
function longPress(el, fn) {
  let timer, sx, sy;
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(e.clientX, e.clientY); });
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { el._longPressed = true; fn(sx, sy); }, 520);
  });
  const clear = () => clearTimeout(timer);
  el.addEventListener('pointerup', clear); el.addEventListener('pointercancel', clear);
  el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clear(); });
}
const consumedLongPress = (el) => { if (el._longPressed) { el._longPressed = false; return true; } return false; };

// ------------------------------------------------------------------ project lifecycle
async function loadProjectData(project, buffers) {
  engine.stop(); engine.stop();
  S.project = project;
  engine.buffers = buffers || new Map();
  // normalise older/partial project files
  for (const t of project.tracks) {
    t.slots = t.slots || []; while (t.slots.length < project.scenes) t.slots.push(null);
    t.arrangement = t.arrangement || []; t.fx = t.fx || [];
    t.arm = false; // never auto-open inputs on load
  }
  engine.loadProject(project);
  S.selected = project.tracks[0] ? project.tracks[0].id : 'master';
  $('#bpm').value = project.bpm;
  $('#projName').textContent = project.name;
  renderAll();
}
async function newProjectFlow(withTracks = 2) {
  const p = newProject('Untitled ' + new Date().toLocaleDateString());
  for (let i = 0; i < withTracks; i++) p.tracks.push(newTrack(p));
  await loadProjectData(p, new Map());
  markDirty();
}

// ------------------------------------------------------------------ track ops
function addTrack(name) {
  const t = newTrack(S.project, name);
  S.project.tracks.push(t); engine.addTrack(t); S.selected = t.id;
  renderAll(); markDirty();
  return t;
}
function deleteTrack(id) {
  engine.removeTrack(id);
  S.project.tracks = S.project.tracks.filter((t) => t.id !== id);
  if (S.selected === id) S.selected = S.project.tracks[0] ? S.project.tracks[0].id : 'master';
  renderAll(); markDirty();
}
async function toggleArm(t) {
  t.arm = !t.arm;
  if (t.arm) {
    try {
      const chain = await engine.attachInput(t);
      if (chain.warning) toast(chain.warning, 4000);
      t._channels = chain.channels;
      refreshDevices();
    } catch (e) { t.arm = false; toast('Input error: ' + (e.message || e.name)); console.warn(e); }
  } else {
    const n = engine.tracks.get(t.id); engine.detachInput(n); engine.releaseUnusedInputs();
  }
  engine.syncTrack(t); renderAll(); markDirty();
}
async function reattachIfArmed(t) {
  if (!t.arm) return;
  try { const c = await engine.attachInput(t); t._channels = c.channels; if (c.warning) toast(c.warning, 4000); engine.releaseUnusedInputs(); } catch (e) { toast('Input error: ' + e.message); }
  renderAll();
}
function addBuffer(buf) { const id = uid('b'); engine.buffers.set(id, buf); return id; }
function applyPreset(t, instrument, presetName) {
  const list = (PRESETS[instrument] || PRESETS.other)[presetName] || [];
  t.preset = presetName;
  t.fx = JSON.parse(JSON.stringify(list)).map((f) => ({ ...f, enabled: true }));
  engine.setTrackFx(t);
}

// ------------------------------------------------------------------ audio import
async function importAudioFiles(files) {
  let n = 0;
  for (const f of files) {
    try {
      const ab = await f.arrayBuffer();
      const buf = await engine.ctx.decodeAudioData(ab);
      const t = addTrack(f.name.replace(/\.[^.]+$/, '').slice(0, 24));
      const id = addBuffer(buf);
      t.slots[0] = { bufferId: id, name: t.name, loopLength: buf.duration };
      t.arrangement.push({ id: uid('c'), bufferId: id, start: 0, offset: 0, duration: buf.duration, name: t.name });
      n++;
    } catch (e) { toast(`Could not decode ${f.name}: ${e.message || e}`); }
  }
  renderAll(); markDirty();
  if (n) toast(`Imported ${n} file(s) as new tracks (session slot 1 + arrangement at bar 1).`);
}

// ------------------------------------------------------------------ transport
function updateTransportUI() {
  $('#btnPlay').classList.toggle('on', engine.playing);
  $('#btnRec').classList.toggle('on', engine.recording);
  $('#btnMetro').classList.toggle('on', engine.metronome);
}
async function togglePlay() { await engine.resume(); engine.playing ? engine.stop() : engine.play(); }
async function toggleRecord() {
  await engine.resume();
  try {
    if (engine.recording) await engine.stopRecording();
    else await engine.startRecording();
  } catch (e) { toast(e.message); }
}
engine.on('transport', updateTransportUI);
engine.on('session', () => updateSessionStates());
engine.on('recorded', (results) => {
  for (const r of results) {
    const id = addBuffer(r.buffer);
    r.track.arrangement.push({ id: uid('c'), bufferId: id, start: r.startPos, offset: r.offset, duration: r.duration, name: 'Rec ' + new Date().toLocaleTimeString() });
    if (r.warning) toast(r.warning, 4000);
  }
  if (results.length) { toast(`Recorded ${results.length} take(s) into the arrangement.`); renderArrange(); markDirty(); }
});

// ------------------------------------------------------------------ session view
function renderSession() {
  const root = $('#sessionView'); root.innerHTML = '';
  const grid = h('div', { class: 'session-grid' });
  for (const t of S.project.tracks) grid.append(sessionColumn(t));
  grid.append(h('div', { class: 'col add-col' }, h('button', { class: 'add-track', onclick: () => addTrack(), title: 'Add audio track' }, '+ Track')));
  grid.append(masterColumn());
  root.append(grid);
  updateSessionStates();
}
function trackHeader(t) {
  const hd = h('div', { class: 'col-head' + (S.selected === t.id ? ' sel' : ''), style: { '--c': t.color } },
    h('span', { class: 'name' }, t.name),
    t.instrument ? h('span', { class: 'inst-tag', title: 'Instrument' }, INSTRUMENT_LABELS[t.instrument].slice(0, 3)) : null);
  hd.addEventListener('click', () => { if (consumedLongPress(hd)) return; selectTrack(t.id); });
  hd.addEventListener('dblclick', () => renameTrack(t));
  longPress(hd, (x, y) => trackMenu(t, x, y));
  return hd;
}
function trackMenu(t, x, y) {
  contextMenu(x, y, [
    { label: 'Rename…', fn: () => renameTrack(t) },
    { label: 'Next colour', fn: () => { t.color = TRACK_COLORS[(TRACK_COLORS.indexOf(t.color) + 1) % TRACK_COLORS.length]; renderAll(); markDirty(); } },
    { label: 'Detect instrument', fn: () => detectTrack(t, true) },
    '-',
    { label: 'Delete track', fn: () => { if (confirm(`Delete track "${t.name}"?`)) deleteTrack(t.id); } },
  ]);
}
function renameTrack(t) { const n = prompt('Track name', t.name); if (n) { t.name = n.slice(0, 32); renderAll(); markDirty(); } }
function selectTrack(id) {
  S.selected = id;
  $$('.col-head, .lane-head').forEach((e) => e.classList.toggle('sel', e.dataset.id === id || (e.closest('[data-id]') && e.closest('[data-id]').dataset.id === id)));
  renderSession(); renderArrangeHeadsSel(); renderDevices();
}
function sessionColumn(t) {
  const col = h('div', { class: 'col', 'data-id': t.id, style: { '--c': t.color } });
  col.append(trackHeader(t));
  const slots = h('div', { class: 'slots' });
  t.slots.forEach((clip, i) => {
    const s = h('div', { class: 'slot' + (clip ? ' has-clip' : ''), 'data-slot': i });
    if (clip) {
      s.append(h('span', { class: 'play-ico' }, '▶'), h('span', { class: 'clip-name' }, clip.name || 'Clip'), h('div', { class: 'prog' }));
      const cv = h('canvas', { class: 'mini-wave' }); s.append(cv);
      requestAnimationFrame(() => drawWave(cv, engine.buffers.get(clip.bufferId), 0, clip.loopLength, 'rgba(0,0,0,.35)'));
    } else s.append(h('span', { class: 'slot-btn' }));
    s.addEventListener('click', () => { if (!consumedLongPress(s)) onSlotClick(t, i); });
    if (clip) longPress(s, (x, y) => clipMenu(t, i, x, y));
    slots.append(s);
  });
  col.append(slots);
  col.append(h('button', { class: 'stop-clip', title: 'Stop clip', onclick: () => engine.stopTrackClip(t) }, '■'));
  col.append(mixerStrip(t));
  return col;
}
function clipMenu(t, i, x, y) {
  const clip = t.slots[i];
  contextMenu(x, y, [
    { label: 'Rename…', fn: () => { const n = prompt('Clip name', clip.name); if (n) { clip.name = n; renderSession(); markDirty(); } } },
    { label: 'Copy to arrangement @ playhead', fn: () => {
      const buf = engine.buffers.get(clip.bufferId);
      t.arrangement.push({ id: uid('c'), bufferId: clip.bufferId, start: engine.position(), offset: 0, duration: Math.min(buf.duration, clip.loopLength || buf.duration), name: clip.name });
      renderArrange(); markDirty(); toast('Copied to arrangement');
    } },
    { label: 'Export clip as WAV', fn: () => download(new Blob([encodeWav(engine.buffers.get(clip.bufferId))], { type: 'audio/wav' }), (clip.name || 'clip') + '.wav') },
    '-',
    { label: 'Delete clip', fn: () => { if (engine.tracks.get(t.id).sessionSlot === i) engine.stopTrackClip(t); t.slots[i] = null; renderSession(); markDirty(); } },
  ]);
}
async function onSlotClick(t, i) {
  await engine.resume();
  const n = engine.tracks.get(t.id);
  if (n.rec && n.rec.slot === i) {
    const res = await engine.stopSlotRecording(t);
    if (res) {
      const id = addBuffer(res.buffer);
      t.slots[i] = { bufferId: id, name: 'Rec ' + (i + 1), loopLength: res.loopLength };
      if (res.warning) toast(res.warning, 4000);
      renderSession(); markDirty();
      engine.playRecordedSlot(t, i, res.startT);
    } else toast('Nothing was recorded.');
    return;
  }
  if (t.slots[i]) { engine.launchSlot(t, i); return; }
  if (t.arm) {
    if (n.rec) return toast('This track is already recording.');
    try { await engine.recordSlot(t, i); } catch (e) { toast(e.message); }
  } else {
    selectTrack(t.id);
    toast('Empty slot — arm the track (●) to record here, or import audio from the menu.');
  }
}
function updateSessionStates() {
  if (!S.project) return;
  for (const t of S.project.tracks) {
    const n = engine.tracks.get(t.id); if (!n) continue;
    const col = $(`#sessionView .col[data-id="${t.id}"]`); if (!col) continue;
    $$('.slot', col).forEach((s) => {
      const i = +s.dataset.slot;
      const playing = n.sessionSlot === i && engine.playing;
      const queued = playing && n.queued && n.queued.slot === i && n.queued.when > engine.ctx.currentTime;
      s.classList.toggle('playing', playing && !queued);
      s.classList.toggle('queued', !!queued);
      s.classList.toggle('recording', !!(n.rec && n.rec.slot === i));
      s.classList.toggle('armed', t.arm && !t.slots[i]);
    });
  }
}
function scenePlay(i) { engine.resume(); engine.launchScene(i); }
function masterColumn() {
  const col = h('div', { class: 'col master-col', 'data-id': 'master' });
  const hd = h('div', { class: 'col-head' + (S.selected === 'master' ? ' sel' : ''), style: { '--c': '#bbb' } }, h('span', { class: 'name' }, 'Master'));
  hd.addEventListener('click', () => selectTrack('master'));
  col.append(hd);
  const slots = h('div', { class: 'slots' });
  for (let i = 0; i < S.project.scenes; i++) slots.append(h('div', { class: 'slot scene', onclick: () => scenePlay(i) }, h('span', { class: 'play-ico' }, '▶'), ` Scene ${i + 1}`));
  col.append(slots);
  col.append(h('button', { class: 'stop-clip', title: 'Stop all clips', onclick: () => engine.stopAllClips() }, '■ All'));
  const strip = h('div', { class: 'strip' });
  strip.append(h('div', { class: 'strip-row info' }, 'Stereo out'));
  const faderRow = h('div', { class: 'fader-row' });
  faderRow.append(createFader(S.project.master.volume, (v) => { S.project.master.volume = v; engine.syncMaster(); markDirty(); }));
  faderRow.append(h('canvas', { class: 'meter', 'data-meter': 'master' }));
  strip.append(faderRow);
  col.append(strip);
  return col;
}
function inputOptions(t) {
  const sel = h('select', { class: 'in-dev', title: 'Input device', onchange: (e) => { t.inputDeviceId = e.target.value; markDirty(); reattachIfArmed(t); } });
  sel.append(h('option', { value: 'default' }, 'Default in'));
  for (const d of S.devices.inputs) if (d.deviceId && d.deviceId !== 'default') sel.append(h('option', { value: d.deviceId }, d.label || 'Input ' + d.deviceId.slice(0, 4)));
  sel.value = t.inputDeviceId || 'default'; if (!sel.value) sel.value = 'default';
  const chCount = Math.max(2, t._channels || 2);
  const ch = h('select', { class: 'in-ch', title: 'Input channel', onchange: (e) => { t.inputChannel = e.target.value; markDirty(); reattachIfArmed(t); } });
  for (let c = 0; c < Math.min(16, chCount); c++) ch.append(h('option', { value: String(c) }, `In ${c + 1}`));
  ch.append(h('option', { value: 'stereo' }, 'Stereo'));
  ch.value = t.inputChannel;
  return [sel, ch];
}
function mixerStrip(t) {
  const strip = h('div', { class: 'strip' });
  strip.append(h('div', { class: 'strip-row' }, ...inputOptions(t)));
  const btn = (cls, label, on, fn, title) => h('button', { class: `tbtn ${cls}` + (on ? ' on' : ''), onclick: fn, title }, label);
  strip.append(h('div', { class: 'strip-row btns' },
    btn('arm', '●', t.arm, () => toggleArm(t), 'Arm for recording'),
    btn('mon', 'IN', t.monitor, () => { t.monitor = !t.monitor; engine.syncTrack(t); renderAll(); markDirty(); }, 'Input monitoring (use headphones)'),
    btn('mute', 'M', t.mute, () => { t.mute = !t.mute; engine.syncTrack(t); renderAll(); markDirty(); }, 'Mute'),
    btn('solo', 'S', t.solo, () => { t.solo = !t.solo; engine.syncMutes(); renderAll(); markDirty(); }, 'Solo')));
  strip.append(createKnob({ key: 'pan', label: 'Pan', min: -1, max: 1, def: 0 }, t.pan, (v) => { t.pan = v; engine.syncTrack(t); markDirty(); }, { small: true }));
  const faderRow = h('div', { class: 'fader-row' });
  faderRow.append(createFader(t.volume, (v) => { t.volume = v; engine.syncTrack(t); markDirty(); }));
  faderRow.append(h('canvas', { class: 'meter', 'data-meter': t.id }));
  strip.append(faderRow);
  return strip;
}

// ------------------------------------------------------------------ arrangement view
function arrLength() {
  let end = 0;
  for (const t of S.project.tracks) for (const c of t.arrangement) end = Math.max(end, c.start + c.duration);
  return Math.max(end + engine.barDur * 8, engine.barDur * 32, engine.position() + engine.barDur * 4);
}
function renderArrange() {
  const root = $('#arrangeView'); root.innerHTML = '';
  const len = arrLength(), W = len * S.zoom;
  const tools = h('div', { class: 'arr-tools' },
    h('button', { onclick: () => { S.zoom = Math.max(5, S.zoom / 1.5); renderArrange(); } }, '−'),
    h('button', { onclick: () => { S.zoom = Math.min(400, S.zoom * 1.5); renderArrange(); } }, '+'),
    h('button', { class: 'follow' + (S.follow ? ' on' : ''), onclick: (e) => { S.follow = !S.follow; e.target.classList.toggle('on', S.follow); } }, 'Follow'),
    h('span', { class: 'sep' }),
    h('button', { disabled: !S.selClip, onclick: () => clipAction('dup') }, 'Duplicate'),
    h('button', { disabled: !S.selClip, onclick: () => clipAction('split') }, 'Split @ playhead'),
    h('button', { disabled: !S.selClip, onclick: () => clipAction('del') }, 'Delete'));
  const body = h('div', { class: 'arr-body' });
  const heads = h('div', { class: 'arr-heads' }, h('div', { class: 'ruler-spacer' }));
  const scroll = h('div', { class: 'arr-scroll' });
  const content = h('div', { class: 'arr-content', style: { width: W + 'px' } });
  // ruler
  const ruler = h('div', { class: 'ruler' });
  const bd = engine.barDur; const step = S.zoom * bd < 30 ? 4 : S.zoom * bd < 60 ? 2 : 1;
  for (let b = 0; b * bd < len; b += step) ruler.append(h('span', { style: { left: b * bd * S.zoom + 'px' } }, String(b + 1)));
  ruler.addEventListener('pointerdown', (e) => { const r = content.getBoundingClientRect(); engine.setPosition((e.clientX - r.left) / S.zoom); });
  content.append(ruler);
  content.style.setProperty('--bar', bd * S.zoom + 'px');
  content.style.setProperty('--beat', engine.beatDur * S.zoom + 'px');
  for (const t of S.project.tracks) {
    const lh = h('div', { class: 'lane-head' + (S.selected === t.id ? ' sel' : ''), 'data-id': t.id, style: { '--c': t.color } },
      h('div', { class: 'lh-name' }, t.name, t.instrument ? h('span', { class: 'inst-tag' }, INSTRUMENT_LABELS[t.instrument].slice(0, 3)) : ''),
      h('div', { class: 'lh-btns' },
        h('button', { class: 'tbtn arm' + (t.arm ? ' on' : ''), onclick: (e) => { e.stopPropagation(); toggleArm(t); } }, '●'),
        h('button', { class: 'tbtn mute' + (t.mute ? ' on' : ''), onclick: (e) => { e.stopPropagation(); t.mute = !t.mute; engine.syncTrack(t); renderAll(); markDirty(); } }, 'M'),
        h('button', { class: 'tbtn solo' + (t.solo ? ' on' : ''), onclick: (e) => { e.stopPropagation(); t.solo = !t.solo; engine.syncMutes(); renderAll(); markDirty(); } }, 'S'),
        h('canvas', { class: 'meter h', 'data-meter': t.id })));
    lh.addEventListener('click', () => { if (!consumedLongPress(lh)) selectTrack(t.id); });
    longPress(lh, (x, y) => trackMenu(t, x, y));
    heads.append(lh);
    const lane = h('div', { class: 'lane', 'data-id': t.id, style: { '--c': t.color } });
    for (const c of t.arrangement) lane.append(arrClip(t, c));
    content.append(lane);
  }
  heads.append(h('button', { class: 'add-track small', onclick: () => addTrack() }, '+ Track'));
  content.append(h('div', { class: 'playhead' }));
  scroll.append(content);
  scroll.addEventListener('scroll', () => { heads.scrollTop = scroll.scrollTop; });
  body.append(heads, scroll);
  root.append(tools, body);
  if (S._arrScroll) scroll.scrollLeft = S._arrScroll;
  scroll.addEventListener('scroll', () => { S._arrScroll = scroll.scrollLeft; });
}
function renderArrangeHeadsSel() { $$('#arrangeView .lane-head').forEach((e) => e.classList.toggle('sel', e.dataset.id === S.selected)); }
function arrClip(t, c) {
  const el = h('div', { class: 'aclip' + (S.selClip && S.selClip.clip === c ? ' sel' : ''), style: { left: c.start * S.zoom + 'px', width: Math.max(4, c.duration * S.zoom) + 'px' } },
    h('div', { class: 'aclip-name' }, c.name || ''), h('canvas'));
  requestAnimationFrame(() => drawWave($('canvas', el), engine.buffers.get(c.bufferId), c.offset, c.duration));
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    S.selClip = { track: t, clip: c };
    $$('.aclip.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel');
    $$('.arr-tools button[disabled]').forEach((b) => (b.disabled = false));
    const sx = e.clientX, s0 = c.start; let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx; if (Math.abs(dx) > 3) moved = true;
      let ns = Math.max(0, s0 + dx / S.zoom);
      if (!ev.shiftKey) { const q = engine.beatDur; ns = Math.round(ns / q) * q; }
      c.start = ns; el.style.left = ns * S.zoom + 'px';
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); if (moved) { markDirty(); if (engine.playing) engine.setPosition(engine.position()); } };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  return el;
}
function clipAction(kind) {
  const sc = S.selClip; if (!sc) return;
  const { track: t, clip: c } = sc;
  if (kind === 'del') { t.arrangement = t.arrangement.filter((x) => x !== c); S.selClip = null; }
  if (kind === 'dup') { const d = { ...c, id: uid('c'), start: c.start + c.duration }; t.arrangement.push(d); S.selClip = { track: t, clip: d }; }
  if (kind === 'split') {
    const p = engine.position();
    if (p <= c.start || p >= c.start + c.duration) return toast('Move the playhead inside the selected clip to split.');
    const cut = p - c.start;
    const right = { ...c, id: uid('c'), start: p, offset: c.offset + cut, duration: c.duration - cut };
    c.duration = cut; t.arrangement.push(right);
  }
  renderArrange(); markDirty();
}

// ------------------------------------------------------------------ device panel
function renderDevices() {
  const panel = $('#devices'); panel.innerHTML = '';
  const isMaster = S.selected === 'master';
  const t = isMaster ? null : track(S.selected);
  if (!isMaster && !t) return;
  const fxList = isMaster ? S.project.master.fx : t.fx;
  const head = $('#devHead'); head.innerHTML = '';
  head.append(h('span', { class: 'dev-title', style: { '--c': isMaster ? '#bbb' : t.color } }, isMaster ? 'Master' : t.name));
  if (!isMaster) {
    const inst = h('select', { class: 'inst-sel', title: 'Instrument (auto-detected or manual)', onchange: (e) => {
      const v = e.target.value;
      if (v === '') { t.instrument = null; t.instrumentSource = null; }
      else { t.instrument = v; t.instrumentSource = 'manual'; applyPreset(t, v, defaultPresetName(v)); }
      renderAll(); markDirty();
    } }, h('option', { value: '' }, 'Instrument: —'), INSTRUMENTS.map((i) => h('option', { value: i }, INSTRUMENT_LABELS[i] + (t.instrument === i && t.instrumentSource === 'auto' ? ` (auto ${Math.round((t.detection?.confidence || 0) * 100)}%)` : ''))));
    inst.value = t.instrument || '';
    head.append(inst);
    const presets = PRESETS[t.instrument || 'other'];
    const ps = h('select', { class: 'preset-sel', title: 'Preset chain', onchange: (e) => { applyPreset(t, t.instrument || 'other', e.target.value); renderDevices(); markDirty(); } },
      h('option', { value: '', disabled: true }, 'Preset…'), Object.keys(presets).map((p) => h('option', { value: p }, p)));
    ps.value = presets[t.preset] ? t.preset : '';
    head.append(ps);
    head.append(h('button', { class: 'small', onclick: () => detectTrack(t, true), title: 'Analyse this track\'s audio and apply a preset' }, 'Detect'));
  }
  const add = h('select', { class: 'add-fx', onchange: (e) => {
    const type = e.target.value; if (!type) return;
    fxList.push({ type, enabled: true, values: {} });
    isMaster ? engine.setMasterFx(fxList) : engine.setTrackFx(t);
    renderDevices(); markDirty();
    setTimeout(() => { const d = $('#devices'); d.scrollLeft = d.scrollWidth; }, 0);
  } }, h('option', { value: '' }, '+ Add effect'), Object.entries(EFFECT_TYPES).map(([k, C]) => h('option', { value: k }, C.label)));
  head.append(add);
  head.append(h('button', { class: 'collapse small', onclick: () => $('#devicePanel').classList.toggle('collapsed'), title: 'Show/hide devices' }, '▾'));

  const instances = engine.fxInstances(isMaster ? 'master' : t.id);
  if (!fxList.length) panel.append(h('div', { class: 'empty-chain' }, isMaster ? 'Master chain is empty.' : 'No effects. Add one, pick a preset, or run Auto-Mix / Detect.'));
  fxList.forEach((d, idx) => {
    const inst = instances[idx]; const C = EFFECT_TYPES[d.type];
    const rebuild = () => { isMaster ? engine.setMasterFx(fxList) : engine.setTrackFx(t); renderDevices(); markDirty(); };
    const card = h('div', { class: 'device' + (d.enabled === false ? ' off' : ''), 'data-type': d.type },
      h('div', { class: 'dev-bar' },
        h('button', { class: 'pwr' + (d.enabled !== false ? ' on' : ''), title: 'Bypass', onclick: (e) => { d.enabled = d.enabled === false; engine.setFxEnabled(isMaster ? 'master' : t.id, idx, d.enabled); card.classList.toggle('off', !d.enabled); e.target.classList.toggle('on', d.enabled); markDirty(); } }, '⏻'),
        h('span', { class: 'dev-name' }, C.label),
        h('button', { title: 'Move left', onclick: () => { if (idx > 0) { [fxList[idx - 1], fxList[idx]] = [fxList[idx], fxList[idx - 1]]; rebuild(); } } }, '‹'),
        h('button', { title: 'Move right', onclick: () => { if (idx < fxList.length - 1) { [fxList[idx + 1], fxList[idx]] = [fxList[idx], fxList[idx + 1]]; rebuild(); } } }, '›'),
        h('button', { title: 'Remove', onclick: () => { fxList.splice(idx, 1); rebuild(); } }, '×')));
    const body = h('div', { class: 'dev-body' });
    if (d.type === 'eq') { const cv = h('canvas', { class: 'eq-curve' }); body.append(cv); card._eq = { cv, inst }; }
    if (['compressor', 'maximizer', 'limiter'].includes(d.type)) { card._gr = h('div', { class: 'gr' }, h('div', { class: 'gr-fill' }), h('span', {}, 'GR')); body.append(card._gr); card._inst = inst; }
    const knobs = h('div', { class: 'knobs' });
    for (const p of C.params) {
      if (p.type === 'select') {
        const s = h('label', { class: 'sel-param' }, h('span', {}, p.label),
          h('select', { onchange: (e) => { engine.setFxParam(isMaster ? 'master' : t.id, idx, p.key, e.target.value); markDirty(); } },
            p.options.map((o) => h('option', { value: o }, o))));
        $('select', s).value = d.values[p.key];
        knobs.append(s);
      } else {
        knobs.append(createKnob(p, d.values[p.key], (v) => { engine.setFxParam(isMaster ? 'master' : t.id, idx, p.key, v); if (card._eq) drawEQ(card._eq); markDirty(); }));
      }
    }
    body.append(knobs); card.append(body); panel.append(card);
    if (card._eq) requestAnimationFrame(() => drawEQ(card._eq));
  });
}
function drawEQ({ cv, inst }) {
  if (!inst || !inst.response) return;
  const w = cv.width = cv.clientWidth * devicePixelRatio, hh = cv.height = cv.clientHeight * devicePixelRatio;
  const g = cv.getContext('2d'); g.clearRect(0, 0, w, hh);
  const N = 128, freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
  const mag = inst.response(freqs);
  g.strokeStyle = '#333'; g.beginPath(); g.moveTo(0, hh / 2); g.lineTo(w, hh / 2); g.stroke();
  g.strokeStyle = '#ffa529'; g.lineWidth = 1.5 * devicePixelRatio; g.beginPath();
  for (let i = 0; i < N; i++) { const db = 20 * Math.log10(mag[i] + 1e-9); const y = hh / 2 - (db / 24) * (hh / 2); i ? g.lineTo(i / (N - 1) * w, y) : g.moveTo(0, y); }
  g.stroke();
}
function refreshDevices() { S.devices.inputs.length || engine.listDevices().then((d) => { S.devices = d; }); }

// ------------------------------------------------------------------ auto-mix / detection
const TARGET_RMS = { drums: -17, bass: -19, vocals: -18, guitar: -20, keys: -22, other: -21 };
function trackBuffers(t) {
  const out = [];
  t.slots.forEach((c) => { if (c && engine.buffers.get(c.bufferId)) out.push(engine.buffers.get(c.bufferId)); });
  t.arrangement.forEach((c) => { const b = engine.buffers.get(c.bufferId); if (b && !out.includes(b)) out.push(b); });
  return out;
}
async function detectTrack(t, applyNow, opts = {}) {
  let bufs = trackBuffers(t);
  if (!bufs.length) {
    if (!t.arm) { if (!opts.quiet) toast(`"${t.name}": no audio to analyse. Record/import audio, or arm the track to listen live.`); return null; }
    toast(`Listening to "${t.name}" input for 4 s — play your instrument…`, 4500);
    const b = await engine.captureInput(t, 4); if (b) bufs = [b];
  }
  await new Promise((r) => setTimeout(r, 10));
  const res = analyzeBuffers(bufs, t.name);
  if (!res || res.silent) { if (!opts.quiet) toast(`"${t.name}": audio is (nearly) silent.`); return null; }
  t.detection = { instrument: res.instrument, confidence: res.confidence, scores: res.scores, at: Date.now() };
  if (applyNow) {
    t.instrument = res.instrument; t.instrumentSource = 'auto';
    applyPreset(t, res.instrument, defaultPresetName(res.instrument));
    renderAll(); markDirty();
    if (!opts.quiet) toast(`"${t.name}" → ${INSTRUMENT_LABELS[res.instrument]} (${Math.round(res.confidence * 100)}% confidence). Change it in the device panel if wrong.`, 4000);
  }
  return res;
}
async function autoMix() {
  if (!S.project.tracks.length) return toast('Add tracks with audio first.');
  $('#btnAutoMix').classList.add('busy');
  await engine.resume();
  const summary = [];
  for (const t of S.project.tracks) {
    await new Promise((r) => setTimeout(r, 0));
    if (t.instrumentSource === 'manual' && t.instrument) {
      applyPreset(t, t.instrument, t.preset && PRESETS[t.instrument][t.preset] ? t.preset : defaultPresetName(t.instrument));
      summary.push(`${t.name}: ${INSTRUMENT_LABELS[t.instrument]} (manual)`);
    } else {
      if (!trackBuffers(t).length) { summary.push(`${t.name}: no audio`); continue; }
      const res = await detectTrack(t, true, { quiet: true });
      if (!res) { summary.push(`${t.name}: silent`); continue; }
      summary.push(`${t.name}: ${INSTRUMENT_LABELS[res.instrument]} ${Math.round(res.confidence * 100)}%`);
    }
    // rough gain staging from dry RMS towards a per-instrument target
    const bufs = trackBuffers(t);
    if (bufs.length) {
      let s = 0, n = 0;
      for (const b of bufs) for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i += 4) { const v = d[i]; if (Math.abs(v) > 0.003) { s += v * v; n++; } } }
      if (n) { const rms = 10 * Math.log10(s / n + 1e-12); t.volume = Math.max(-18, Math.min(6, Math.round((TARGET_RMS[t.instrument || 'other'] - rms) * 2) / 2 * 0.5)); engine.syncTrack(t); }
    }
  }
  $('#btnAutoMix').classList.remove('busy');
  renderAll(); markDirty();
  toast('Auto-Mix: ' + summary.join(' · '), 6000);
}

// ------------------------------------------------------------------ menus & dialogs
function openDialog(title, content, buttons = [{ label: 'Close' }]) {
  const dlg = $('#dlg'); dlg.innerHTML = '';
  const form = h('form', { method: 'dialog' }, h('h3', {}, title), content, h('div', { class: 'dlg-btns' }, buttons.map((b) => h('button', { value: b.value || 'close', onclick: b.fn }, b.label))));
  dlg.append(form);
  dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '');
}
async function audioSettings() {
  await engine.resume();
  S.devices = await engine.listDevices();
  const ctx = engine.ctx;
  const needPerm = !S.devices.inputs.some((d) => d.label);
  const outSel = h('select', { disabled: !Engine.outputSelectionSupported(), onchange: async (e) => { try { await engine.setOutputDevice(e.target.value); toast('Output device changed'); } catch (err) { toast(err.message); } } },
    h('option', { value: 'default' }, 'System default'), S.devices.outputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => h('option', { value: d.deviceId }, d.label || 'Output')));
  const lat = h('input', { type: 'number', value: engine.latencyOffsetMs, step: 1, min: -200, max: 500, onchange: (e) => { engine.latencyOffsetMs = +e.target.value || 0; localStorage.setItem('latOffset', engine.latencyOffsetMs); } });
  const content = h('div', { class: 'settings' },
    h('p', {}, `Sample rate: ${ctx.sampleRate} Hz · base latency: ${((ctx.baseLatency || 0) * 1000).toFixed(1)} ms · output latency: ${((ctx.outputLatency || 0) * 1000).toFixed(1)} ms · state: ${ctx.state}`),
    h('label', {}, 'Output device ', outSel, Engine.outputSelectionSupported() ? '' : h('small', {}, ' (not supported in this browser — uses system output)')),
    h('p', {}, `Inputs detected: ${S.devices.inputs.length}`, needPerm ? h('button', { type: 'button', onclick: async () => { try { await engine.requestMicPermission(); closeDialog(); audioSettings(); renderAll(); } catch (e) { toast('Permission denied: ' + e.message); } } }, 'Allow microphone to list inputs') : ''),
    h('ul', { class: 'dev-list' }, S.devices.inputs.map((d) => h('li', {}, d.label || '(unnamed input)'))),
    h('label', {}, 'Extra record latency compensation (ms) ', lat),
    h('p', { class: 'hint' }, 'Choose the input device and channel per track in the session mixer strip (In 1/In 2/Stereo). Multi-channel interfaces expose their channels when the browser supports it (Chrome desktop typically; iOS Safari usually 1–2 channels). Use headphones when monitoring.'),
  );
  openDialog('Audio settings', content);
}
function closeDialog() { const d = $('#dlg'); d.close ? d.close() : d.removeAttribute('open'); }
async function projectsDialog() {
  const list = await DB.listProjects();
  const content = h('div', { class: 'proj-list' }, list.length ? list.map((p) => h('div', { class: 'proj-row' + (p.id === S.project.id ? ' current' : '') },
    h('span', {}, `${p.name} · ${p.tracks} tracks · ${new Date(p.modified).toLocaleString()}`),
    h('button', { type: 'button', onclick: async () => { await saveNow(); const r = await DB.loadProject(p.id, engine.ctx); closeDialog(); if (r) loadProjectData(r.project, r.buffers); } }, 'Open'),
    p.id !== S.project.id ? h('button', { type: 'button', onclick: async () => { if (confirm('Delete project "' + p.name + '"?')) { await DB.deleteProject(p.id); closeDialog(); projectsDialog(); } } }, 'Delete') : '')) : 'No saved projects.');
  openDialog('Projects (stored in this browser)', content);
}
async function exportProject() {
  await saveNow();
  const blob = exportProjectZip(S.project, engine.buffers);
  const name = (S.project.name || 'project').replace(/[^\w\- ]+/g, '_') + '.webdaw.zip';
  // Share sheet on phones (AirDrop etc.), else download
  const file = typeof File !== 'undefined' ? new File([blob], name, { type: 'application/zip' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: S.project.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
  toast(`Exported ${name} (${(blob.size / 1048576).toFixed(1)} MB)`);
}
async function importProject(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { project, buffers } = await importProjectFile(bytes, engine.ctx);
    await saveNow();
    await loadProjectData(project, buffers);
    await saveNow();
    toast(`Imported project "${project.name}" (${project.tracks.length} tracks)`);
  } catch (e) { console.error(e); toast('Import failed: ' + e.message, 5000); }
}
function menuActions() {
  const items = [
    ['New project', () => { if (confirm('Start a new project? (current one stays saved in this browser)')) saveNow().then(() => newProjectFlow()); }],
    ['Projects…', projectsDialog],
    ['Rename project…', () => { const n = prompt('Project name', S.project.name); if (n) { S.project.name = n; $('#projName').textContent = n; markDirty(); } }],
    ['Save now', () => saveNow().then(() => toast('Saved to this browser'))],
    ['Export project (.zip)', exportProject],
    ['Import project…', () => $('#fileProject').click()],
    ['-'],
    ['Add audio track', () => addTrack()],
    ['Import audio files as tracks…', () => $('#fileAudio').click()],
    ['Audio settings…', audioSettings],
    ['-'],
    ['Install app', installApp],
    ['About', () => openDialog('About WebDAW', h('div', {}, h('p', {}, 'WebDAW v0.1 — a browser DAW built on the Web Audio API. Works offline once loaded. Projects are saved in this browser (IndexedDB); use Export/Import to move them between devices.'), h('p', { class: 'hint' }, 'Shortcuts: Space = play/stop, R = record, M = metronome, Tab = switch view.')))],
  ];
  const m = $('#menu'); m.innerHTML = '';
  for (const [label, fn] of items) m.append(label === '-' ? h('hr') : h('button', { onclick: () => { closeMenus(); fn(); } }, label));
}
async function installApp() {
  if (S.deferredInstall) { S.deferredInstall.prompt(); S.deferredInstall = null; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openDialog('Install', h('p', {}, ios ? 'In Safari tap the Share button, then “Add to Home Screen”.' : 'Use your browser menu → “Install app” / “Add to Home screen”. (Chrome shows an install icon in the address bar.)'));
}

// ------------------------------------------------------------------ render loop
function renderAll() {
  if (!S.project) return;
  $('#sessionView').hidden = S.view !== 'session';
  $('#arrangeView').hidden = S.view !== 'arrange';
  $$('.views button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  renderSession(); renderArrange(); renderDevices(); updateTransportUI();
  $('#saveState').textContent = '…';
}
const meterState = new Map();
function drawMeter(cv, id) {
  const m = engine.meters.get(id) || { peak: [0, 0] };
  let st = meterState.get(cv); if (!st) { st = [0, 0]; meterState.set(cv, st); }
  const horiz = cv.classList.contains('h');
  const w = cv.width = cv.clientWidth, hh = cv.height = cv.clientHeight;
  if (!w || !hh) return;
  const g = cv.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, w, hh);
  for (let c = 0; c < 2; c++) {
    const p = m.peak[c] || 0; st[c] = Math.max(p, st[c] * 0.9);
    const db = 20 * Math.log10(st[c] + 1e-9); const n = Math.max(0, Math.min(1, (db + 60) / 66));
    g.fillStyle = db > -0.5 ? '#ff4d4d' : db > -9 ? '#f2d33a' : '#3ecf8e';
    if (horiz) g.fillRect(0, c * hh / 2, n * w, hh / 2 - 1); else g.fillRect(c * w / 2, hh * (1 - n), w / 2 - 1, hh * n);
  }
}
function frame() {
  requestAnimationFrame(frame);
  if (!S.project) return;
  engine.pollMeters();
  const pos = engine.position();
  $('#posDisplay').textContent = fmtPos(pos);
  $$('canvas[data-meter]').forEach((cv) => { if (cv.offsetParent) drawMeter(cv, cv.dataset.meter); });
  drawMeter($('#masterMeterTop'), 'master');
  if (S.view === 'arrange') {
    const ph = $('#arrangeView .playhead'); if (ph) ph.style.transform = `translateX(${pos * S.zoom}px)`;
    if (S.follow && engine.playing) { const sc = $('#arrangeView .arr-scroll'); const x = pos * S.zoom; if (x > sc.scrollLeft + sc.clientWidth * 0.8 || x < sc.scrollLeft) sc.scrollLeft = x - sc.clientWidth * 0.2; }
  }
  // session clip progress
  if (S.view === 'session' && engine.playing) {
    for (const [id, n] of engine.tracks) {
      if (!n.sessionSource || n.sessionSlot < 0) continue;
      const el = $(`#sessionView .col[data-id="${id}"] .slot[data-slot="${n.sessionSlot}"] .prog`); if (!el) continue;
      const src = n.sessionSource; const L = src.loopEnd || src.buffer.duration;
      const t = engine.ctx.currentTime - n.sessionStart; el.style.width = (t > 0 ? ((t % L) / L) * 100 : 0) + '%';
    }
  }
  $$('#devices .device').forEach((card) => {
    if (card._gr && card._inst) { const r = Math.min(24, card._inst.getReduction()); $('.gr-fill', card._gr).style.height = (r / 24 * 100) + '%'; }
  });
  if (engine.recording || [...engine.tracks.values()].some((n) => n.rec)) document.body.classList.add('is-recording'); else document.body.classList.remove('is-recording');
}

// ------------------------------------------------------------------ boot
function bindUI() {
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnStop').addEventListener('click', () => engine.stop());
  $('#btnRec').addEventListener('click', toggleRecord);
  $('#btnMetro').addEventListener('click', () => { engine.metronome = !engine.metronome; engine.nextClick = null; updateTransportUI(); });
  $('#bpm').addEventListener('change', (e) => {
    const v = Math.max(40, Math.min(300, +e.target.value || 120)); e.target.value = v;
    S.project.bpm = v; engine.updateBpmFx(); renderArrange(); markDirty();
  });
  $$('.views button').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.view; renderAll(); }));
  $('#btnAutoMix').addEventListener('click', autoMix);
  $('#btnMenu').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#menu'); const open = !m.classList.contains('open'); closeMenus(); if (open) { m.classList.add('open'); setTimeout(() => document.addEventListener('pointerdown', (ev) => { if (!ev.target.closest('#menu')) closeMenus(); }, { once: true }), 0); } });
  $('#fileProject').addEventListener('change', (e) => { if (e.target.files[0]) importProject(e.target.files[0]); e.target.value = ''; });
  $('#fileAudio').addEventListener('change', (e) => { if (e.target.files.length) importAudioFiles([...e.target.files]); e.target.value = ''; });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'r') toggleRecord();
    else if (e.key === 'm') $('#btnMetro').click();
    else if (e.key === 'Tab') { e.preventDefault(); S.view = S.view === 'session' ? 'arrange' : 'session'; renderAll(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selClip && S.view === 'arrange') clipAction('del');
  });
  // drag & drop audio or project files
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault(); if (!engine.ctx) return;
    const files = [...e.dataTransfer.files];
    const proj = files.find((f) => /\.(zip|webdaw|json)$/i.test(f.name));
    if (proj) importProject(proj); else if (files.length) importAudioFiles(files);
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.deferredInstall = e; });
  window.addEventListener('pagehide', () => { if (S.project) saveNow(); });
  navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', async () => { S.devices = await engine.listDevices(); renderSession(); });
  menuActions();
}

async function start() {
  $('#startBtn').disabled = true;
  try {
    await engine.init();
    await engine.resume();
  } catch (e) { $('#startMsg').textContent = 'Audio could not start: ' + e.message; $('#startBtn').disabled = false; return; }
  engine.latencyOffsetMs = +localStorage.getItem('latOffset') || 0;
  S.devices = await engine.listDevices().catch(() => ({ inputs: [], outputs: [] }));
  let loaded = null;
  try { const id = await DB.lastProjectId(); if (id) loaded = await DB.loadProject(id, engine.ctx); } catch (e) { console.warn('IndexedDB load failed', e); }
  if (loaded) await loadProjectData(loaded.project, loaded.buffers); else await newProjectFlow(2);
  $('#startOverlay').remove();
  requestAnimationFrame(frame);
  if (engine.ctx.state !== 'running') toast('Audio is suspended by the browser — tap anywhere to resume.', 5000);
}

bindUI();
// iOS/Android: (re)resume audio on any user gesture (e.g. after a phone call or backgrounding)
['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (engine.ctx && engine.ctx.state !== 'running') engine.resume(); }, { passive: true }));
$('#startBtn').addEventListener('click', start);
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !location.search.includes('nosw')) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
}
