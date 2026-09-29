// WebDAW v0.2 — UI controller.
import { Engine } from './audio/engine.js';
import { EFFECT_TYPES, EASY_PARAMS, EFFECT_HELP, PARAM_HELP } from './audio/effects.js';
import { INSTRUMENT_TYPES, PAD_ORDER, wavetableFrame } from './audio/instruments.js';
import { allowed, requiredTier, getTier, setTier, TIERS, TIER_LABELS, BASIC_ROLES, onTierChange } from './tiers.js';
import { analyzeBuffers, extractFeatures } from './audio/detect.js';
import { PRESETS, INSTRUMENTS, INSTRUMENT_LABELS, ROLES, defaultPresetName } from './audio/presets.js';
import { SCALES, NOTE_NAMES, noteName } from './audio/pitchdsp.js';
import { chromaFromBuffer, chromaFromNotes, detectKey } from './audio/keydetect.js';
import { quantizeBuffer } from './audio/timecorrect.js';
import { BANDS } from './audio/adaptive.js';
import { newProject, newTrack, DB, exportProjectZip, importProjectFile, uid, TRACK_COLORS, encodeWav } from './project.js';
import { createKnob, createFader, fromNorm } from './ui/controls.js';
import { h, $, $$, toast, prefs, savePrefs, haptic } from './ui/dom.js';
import { tap, addViz, drawSpectrum, drawCurve, drawScope, drawHistory, drawPitch, openVisualizer } from './ui/viz.js';
import { openPianoRoll } from './ui/pianoroll.js';
import { History } from './history.js';
import { validateProject, validateRack } from './validate.js';
import { MIDI } from './midi.js';
import { cryptoAvailable, pinIsSet, setPin, clearPin, verifyPin, isEncrypted, encryptBytes, decryptBytes } from './security.js';

export const engine = new Engine();
const S = { project: null, selected: null, view: 'session', zoom: 40, sel: null, clipboard: null, deferredInstall: null,
  devices: { inputs: [], outputs: [] }, follow: false, expanded: new Set(), learn: { active: false, target: null }, slotRec: new Map(), midiRec: null };
const history = new History(() => JSON.stringify(S.project), (snap) => restoreSnapshot(snap));
window.__daw = { engine, S, history, MIDI }; // debugging / automated tests

// ------------------------------------------------------------------ utils
let saveTimer;
function markDirty() { clearTimeout(saveTimer); const ss = $('#saveState'); if (ss) ss.textContent = '•'; saveTimer = setTimeout(saveNow, 1200); }
async function saveNow() {
  clearTimeout(saveTimer);
  try { await DB.saveProject(S.project, engine.buffers); $('#saveState').textContent = ''; $('#saveState').title = 'Saved in this browser'; }
  catch (e) { console.warn(e); $('#saveState').textContent = '!'; toast('Could not save to browser storage: ' + e.message); }
}
const track = (id) => S.project.tracks.find((t) => t.id === id);
const fmtPos = (pos) => {
  const bd = engine.beatDur, bpb = S.project.beatsPerBar || 4;
  const beats = Math.max(0, pos) / bd; return `${Math.floor(beats / bpb) + 1}.${Math.floor(beats % bpb) + 1}.${Math.floor((beats % 1) * 4) + 1}`;
};
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
const keyName = (k) => `${NOTE_NAMES[k.root]} ${k.scale}`;
function change(label, fn, coalesce) { history.push(label, coalesce); fn(); markDirty(); }
// ---- feature tiers (placeholder, local setting only)
const tierShort = (f) => TIER_LABELS[requiredTier(f)].split(' ')[0];
function lockBadge(feature) { return allowed(feature) ? null : h('span', { class: 'lock', title: `${TIER_LABELS[requiredTier(feature)]} feature — tiers are a local placeholder setting (Preferences)` }, '🔒' + tierShort(feature)); }
function gate(feature, what) {
  if (allowed(feature)) return true;
  const need = requiredTier(feature);
  const dlg = openDialog('🔒 ' + what, h('div', {}, h('p', {}, `${what} is part of the ${TIER_LABELS[need]} tier. Current tier: ${TIER_LABELS[getTier()]}.`),
    h('p', { class: 'hint' }, 'Tiers are a placeholder: there are no payments, accounts or licence checks yet. For testing you can switch tier freely (also in ☰ → Preferences).')),
    [{ label: 'Cancel', value: 'cancel' }, { label: `Switch to ${TIER_LABELS[need]} (testing)`, value: 'switch', primary: true }]);
  dlg.addEventListener('close', () => { if (dlg.returnValue === 'switch') { setTier(need); toast('Tier: ' + TIER_LABELS[need] + ' — try again'); } }, { once: true });
  return false;
}
onTierChange(() => { if (S.project) renderAll(); });

// waveform peaks
const peakCache = new WeakMap();
function peaks(buf) {
  let p = peakCache.get(buf); if (p) return p;
  const block = 256, n = Math.ceil(buf.length / block); p = new Float32Array(n * 2);
  const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) { let mn = 1, mx = -1; for (let j = i * block; j < Math.min(buf.length, (i + 1) * block); j++) for (const d of chans) { const v = d[j]; if (v < mn) mn = v; if (v > mx) mx = v; } p[i * 2] = mn; p[i * 2 + 1] = mx; }
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
    let mn = 0, mx = 0; for (let i = a; i < b && i * 2 < p.length; i++) { if (p[i * 2] < mn) mn = p[i * 2]; if (p[i * 2 + 1] > mx) mx = p[i * 2 + 1]; }
    g.fillRect(x, (0.5 - mx * 0.5) * hh, 1, Math.max(1, (mx - mn) * 0.5 * hh));
  }
}
function drawNotes(canvas, clip, color = 'rgba(0,0,0,.6)', beats = null) {
  const w = canvas.width = Math.max(1, Math.min(4096, Math.round(canvas.clientWidth * devicePixelRatio)));
  const hh = canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  const g = canvas.getContext('2d'); g.clearRect(0, 0, w, hh); g.fillStyle = color;
  if (!clip.notes.length) return;
  const lo = Math.min(...clip.notes.map((n) => n.n)) - 1, hi = Math.max(...clip.notes.map((n) => n.n)) + 1, L = beats || clip.lengthBeats;
  const nh = Math.max(1, hh / (hi - lo + 1));
  for (const n of clip.notes) g.fillRect((n.t / L) * w, (hi - n.n) * nh, Math.max(1, (n.d / L) * w - 1), Math.max(1, nh - 1));
}

// ------------------------------------------------------------------ menus, help, dialogs
function contextMenu(x, y, items) {
  closeMenus();
  const m = h('div', { class: 'ctxmenu', role: 'menu' }, items.filter(Boolean).map((it) => it === '-' ? h('hr') : h('button', { role: 'menuitem', onclick: () => { closeMenus(); it.fn(); } }, it.label)));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, { once: true }), 0);
}
function onDocDown(e) { if (!e.target.closest('.ctxmenu, #menu, .popover')) closeMenus(); else document.addEventListener('pointerdown', onDocDown, { once: true }); }
function closeMenus() { $$('.ctxmenu, .popover').forEach((m) => m.remove()); $('#menu').classList.remove('open'); }
function longPress(el, fn) {
  let timer, sx, sy;
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(e.clientX, e.clientY, e); });
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { el._longPressed = true; haptic(15); fn(sx, sy, e); }, 520);
  });
  const clear = () => clearTimeout(timer);
  el.addEventListener('pointerup', clear); el.addEventListener('pointercancel', clear);
  el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clear(); });
}
const consumedLongPress = (el) => { if (el._longPressed) { el._longPressed = false; return true; } return false; };
function openDialog(title, content, buttons = [{ label: 'Close' }], cls = '') {
  const dlg = $('#dlg'); dlg.innerHTML = ''; dlg.className = cls;
  const form = h('form', { method: 'dialog' }, h('h3', {}, title), content,
    h('div', { class: 'dlg-btns' }, buttons.map((b) => h('button', { value: b.value || 'close', class: b.primary ? 'primary' : '', onclick: b.fn, type: b.type || 'submit' }, b.label))));
  dlg.append(form);
  if (dlg.open) dlg.close();
  dlg.showModal ? dlg.showModal() : dlg.setAttribute('open', '');
  return dlg;
}
function closeDialog() { const d = $('#dlg'); if (d.close) { if (d.open) d.close(); } else d.removeAttribute('open'); }
function askPassword(title, confirm = false) {
  return new Promise((resolve) => {
    const p1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6, placeholder: 'Password', 'aria-label': 'Password' });
    const p2 = confirm ? h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat password', 'aria-label': 'Repeat password' }) : null;
    const dlg = openDialog(title, h('div', { class: 'settings' }, p1, p2, h('p', { class: 'hint' }, confirm ? 'AES-256-GCM, key derived from the password with PBKDF2 (310,000 iterations). If you forget the password the file cannot be recovered.' : 'Enter the password used when exporting.')),
      [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }]);
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      if (confirm && p1.value !== p2.value) { toast('Passwords do not match'); return resolve(null); }
      resolve(p1.value);
    }, { once: true });
    setTimeout(() => p1.focus(), 50);
  });
}
// Help mode: tap anything to read its explanation instead of activating it
function showHelpBubble(el, x, y) {
  const text = el.dataset.help || el.title || el.getAttribute('aria-label');
  if (!text) return false;
  closeMenus();
  const b = h('div', { class: 'popover help-bubble', role: 'tooltip' }, text);
  document.body.append(b);
  const r = b.getBoundingClientRect();
  b.style.left = Math.max(4, Math.min(x - r.width / 2, innerWidth - r.width - 4)) + 'px';
  b.style.top = Math.max(4, Math.min(y + 14, innerHeight - r.height - 4)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, { once: true }), 0);
  return true;
}

// ------------------------------------------------------------------ project lifecycle
function normalise(project) {
  project.key = project.key || { root: 0, scale: 'major' }; project.midiMap = project.midiMap || [];
  for (const t of project.tracks) {
    t.kind = t.kind || 'audio'; t.slots = t.slots || []; while (t.slots.length < project.scenes) t.slots.push(null);
    t.arrangement = t.arrangement || []; t.fx = t.fx || []; t.adaptive = t.adaptive || { enabled: false, amount: 60 };
    t.midiInput = t.midiInput || 'all'; t.fromBar = t.fromBar || 1;
    if (t.kind === 'midi' && !t.inst) t.inst = { type: 'synth', values: {} };
    t.groupId = t.groupId || null; t.folded = !!t.folded;
    t.arm = false; // never auto-open inputs on load
  }
  return project;
}
async function loadProjectData(project, buffers) {
  engine.stop(); engine.stop();
  S.project = normalise(project);
  engine.buffers = buffers || new Map();
  engine.loadProject(S.project);
  S.selected = S.project.tracks[0] ? S.project.tracks[0].id : 'master'; S.sel = null;
  $('#bpm').value = S.project.bpm; $('#projName').textContent = S.project.name;
  history.clear();
  renderAll();
}
async function newProjectFlow(withTracks = 2) {
  const p = newProject('Untitled ' + new Date().toLocaleDateString());
  for (let i = 0; i < withTracks; i++) p.tracks.push(newTrack(p));
  await loadProjectData(p, new Map());
  markDirty();
}
// Undo/redo restore: apply the snapshot as a diff so playback keeps running and effect
// instances are updated in place when only parameter values changed.
function applyFxDiff(trackId, oldFx, newFx, rebuild) {
  const inst = engine.fxInstances(trackId);
  const rackShape = (f) => JSON.stringify((f.chains || []).map((c) => (c.fx || []).map((x) => x.type + (x.enabled !== false))));
  const sameShape = oldFx.length === newFx.length && oldFx.every((f, i) => f.type === newFx[i].type && (f.type !== 'rack' || rackShape(f) === rackShape(newFx[i]))) && inst.length === newFx.length;
  if (!sameShape) return rebuild();
  newFx.forEach((f, i) => {
    const I = inst[i];
    if (f.type === 'rack') {
      I.rdef = f; f.macroMap = f.macroMap || [];
      f.chains.forEach((c, ci) => { const ic = I.chains[ci]; ic.def = c; I.syncChain(ic, false);
        c.fx.forEach((fd, fi) => { const inner = ic.fx[fi]; for (const [k, v] of Object.entries(fd.values)) if (inner.values[k] !== v) inner.set(k, v); fd.values = inner.values; }); });
    }
    for (const [k, v] of Object.entries(f.values)) if (I.values[k] !== v) I.set(k, v);
    if (I.enabled !== (f.enabled !== false)) I.setEnabled(f.enabled !== false);
    f.values = I.values;
  });
}
function restoreSnapshot(json) {
  const p = normalise(JSON.parse(json)), old = S.project;
  for (const t of p.tracks) { const o = old.tracks.find((x) => x.id === t.id); if (o) { t.arm = o.arm; t._channels = o._channels; } }
  const newIds = new Set(p.tracks.map((t) => t.id));
  S.project = p; engine.project = p;
  for (const o of old.tracks) if (!newIds.has(o.id)) engine.removeTrack(o.id);
  for (const t of p.tracks) {
    const o = old.tracks.find((x) => x.id === t.id);
    if (!o) { engine.addTrack(t); continue; }
    applyFxDiff(t.id, o.fx, t.fx, () => engine.setTrackFx(t));
    const n = engine.tracks.get(t.id);
    if (JSON.stringify(o.inst) !== JSON.stringify(t.inst)) {
      if (n.inst && o.inst && t.inst && o.inst.type === t.inst.type) { for (const [k, v] of Object.entries(t.inst.values)) if (n.inst.values[k] !== v) n.inst.set(k, v); t.inst.values = n.inst.values; }
      else engine.setInstrument(t);
    } else if (n.inst) t.inst.values = n.inst.values;
    engine.syncTrack(t); engine.syncAdaptive(t);
    if (JSON.stringify(o.arrangement) !== JSON.stringify(t.arrangement)) engine.rescheduleTrack(t);
    if (n.sessionMidi) { const c = t.slots[n.sessionSlot]; if (c && c.type === 'midi') n.sessionMidi.clip = c; else engine.stopTrackClip(t); }
    if (n.sessionSource && !t.slots[n.sessionSlot]) engine.stopTrackClip(t);
  }
  engine.routeAll();
  applyFxDiff('master', old.master.fx, p.master.fx, () => engine.setMasterFx(p.master.fx));
  engine.syncMaster(); engine.updateBpmFx();
  if (S.selected !== 'master' && !track(S.selected)) S.selected = p.tracks[0] ? p.tracks[0].id : 'master';
  $('#bpm').value = p.bpm; $('#projName').textContent = p.name;
  S.sel = null; renderAll(); markDirty();
}
function undo() { const l = history.undo(); toast(l ? 'Undo: ' + l : 'Nothing to undo', 1200); haptic(8); }
function redo() { const l = history.redo(); toast(l ? 'Redo: ' + l : 'Nothing to redo', 1200); haptic(8); }
history.onChange(() => { $$('.btn-undo').forEach((b) => (b.disabled = !history.canUndo())); $$('.btn-redo').forEach((b) => (b.disabled = !history.canRedo())); });

// ------------------------------------------------------------------ track ops
function addTrack(name, kind = 'audio', instType = 'synth') {
  if (kind === 'group' && !gate('grouping', 'Track groups')) return null;
  if (kind === 'midi' && instType === 'wavetable' && !gate('inst.wavetable', 'Wavetable synth')) return null;
  history.push(kind === 'midi' ? 'Add MIDI track' : kind === 'group' ? 'Add group' : 'Add track');
  const t = newTrack(S.project, name || (kind === 'group' ? 'Group ' + (S.project.tracks.filter((x) => x.kind === 'group').length + 1) : null), kind, instType);
  if (kind === 'midi') { t.instrument = instType === 'drums' ? 'drums' : 'keys'; t.instrumentSource = 'manual'; }
  S.project.tracks.push(t); engine.addTrack(t); S.selected = t.id;
  renderAll(); markDirty();
  return t;
}
function deleteTrack(id) {
  history.push('Delete track');
  const g = track(id);
  if (g && g.kind === 'group') S.project.tracks.forEach((x) => { if (x.groupId === id) x.groupId = g.groupId || null; });
  S.project.tracks = S.project.tracks.filter((t) => t.id !== id);
  engine.removeTrack(id);
  if (S.selected === id) S.selected = S.project.tracks[0] ? S.project.tracks[0].id : 'master';
  renderAll(); markDirty();
}
async function toggleArm(t) {
  t.arm = !t.arm;
  if (t.kind === 'midi') {
    if (t.arm) { const ok = await MIDI.init(); if (!ok) toast(MIDI.notice() || ('MIDI unavailable: ' + (MIDI.error || MIDI.status)), 5000); }
    renderAll(); return;
  }
  if (t.arm) {
    try {
      const chain = await engine.attachInput(t);
      if (chain.warning) toast(chain.warning, 4000);
      t._channels = chain.channels;
      if (!S.devices.inputs.some((d) => d.label)) S.devices = await engine.listDevices();
    } catch (e) { t.arm = false; toast('Input error: ' + (e.message || e.name)); console.warn(e); }
  } else { const n = engine.tracks.get(t.id); engine.detachInput(n); engine.releaseUnusedInputs(); }
  engine.syncTrack(t); renderAll();
}
async function reattachIfArmed(t) {
  if (!t.arm || t.kind === 'midi') return;
  try { const c = await engine.attachInput(t); t._channels = c.channels; if (c.warning) toast(c.warning, 4000); engine.releaseUnusedInputs(); } catch (e) { toast('Input error: ' + e.message); }
  renderAll();
}
function addBuffer(buf) { const id = uid('b'); engine.buffers.set(id, buf); return id; }
function applyPreset(t, instrument, presetName) {
  const list = (PRESETS[instrument] || PRESETS.other)[presetName] || [];
  t.preset = presetName;
  const all = JSON.parse(JSON.stringify(list));
  t.fx = all.filter((f) => allowed('fx.' + f.type)).map((f) => ({ ...f, enabled: true }));
  if (t.fx.length < all.length) toast(`Preset “${presetName}”: ${all.length - t.fx.length} effect(s) skipped (not in the ${TIER_LABELS[getTier()]} tier).`, 3000);
  engine.setTrackFx(t); engine.syncAdaptive(t);
}

// ------------------------------------------------------------------ track groups (group buses, fold/unfold, nesting)
function displayOrder() {
  const tr = S.project.tracks, out = [], seen = new Set();
  const inGroup = (t) => t.groupId && tr.some((g) => g.id === t.groupId && g.kind === 'group');
  const visit = (t, depth, hidden) => {
    if (seen.has(t.id) || depth > 8) return; seen.add(t.id); out.push({ t, depth, hidden });
    if (t.kind === 'group') for (const c of tr) if (c.groupId === t.id) visit(c, depth + 1, hidden || t.folded);
  };
  for (const t of tr) if (!inGroup(t)) visit(t, 0, false);
  for (const t of tr) if (!seen.has(t.id)) visit(t, 0, false); // safety (cycles)
  return out;
}
function groupMembers(g) { const out = []; const walk = (id, d) => { if (d > 8) return; for (const x of S.project.tracks) if (x.groupId === id) { out.push(x); if (x.kind === 'group') walk(x.id, d + 1); } }; walk(g.id, 0); return out; }
function toggleFold(g) { g.folded = !g.folded; markDirty(); renderSession(); renderArrange(); haptic(6); }
function setGroup(t, gid) {
  if (gid && (gid === t.id || (t.kind === 'group' && groupMembers(t).some((m) => m.id === gid)))) return toast('A group cannot contain itself.');
  change(gid ? 'Move to group' : 'Remove from group', () => { t.groupId = gid; engine.routeAll(); });
  renderAll();
}
function groupTrack(t) {
  if (!gate('grouping', 'Track groups')) return;
  history.push('Group track');
  const g = newTrack(S.project, 'Group ' + (S.project.tracks.filter((x) => x.kind === 'group').length + 1), 'group');
  g.groupId = t.groupId || null; g.color = t.color;
  S.project.tracks.splice(S.project.tracks.indexOf(t), 0, g);
  engine.addTrack(g); t.groupId = g.id; engine.routeAll();
  S.selected = g.id; renderAll(); markDirty();
}
function ungroup(g) {
  history.push('Ungroup');
  S.project.tracks.forEach((x) => { if (x.groupId === g.id) x.groupId = g.groupId || null; });
  S.project.tracks = S.project.tracks.filter((x) => x !== g); engine.removeTrack(g.id);
  if (S.selected === g.id) S.selected = S.project.tracks[0] ? S.project.tracks[0].id : 'master';
  renderAll(); markDirty();
}
function groupMenu(t, x, y) {
  const groups = S.project.tracks.filter((g) => g.kind === 'group' && g.id !== t.id && g.id !== t.groupId && !(t.kind === 'group' && groupMembers(t).includes(g)));
  if (!groups.length) return toast('No other groups. Use “Group this track” first.');
  contextMenu(x, y, groups.map((g) => ({ label: '→ ' + g.name, fn: () => setGroup(t, g.id) })));
}

// ------------------------------------------------------------------ audio import (incl. arrangement drop-to-position)
async function decodeFile(f) {
  if (f.size > 1024 * 1024 * 1024) throw new Error('file larger than 1 GB');
  return engine.ctx.decodeAudioData(await f.arrayBuffer());
}
async function importAudioFiles(files) {
  let n = 0;
  for (const f of files) {
    try {
      const buf = await decodeFile(f);
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
// Place files at a timeline position on a track (or new tracks when trackId is null)
async function importAudioAt(files, pos, trackId) {
  let placed = 0, t = trackId ? track(trackId) : null;
  if (t && t.kind === 'midi') t = null;
  history.push('Import audio');
  for (const f of files) {
    try {
      const buf = await decodeFile(f);
      let target = t;
      if (!target) { target = newTrack(S.project, f.name.replace(/\.[^.]+$/, '').slice(0, 24)); S.project.tracks.push(target); engine.addTrack(target); }
      const id = addBuffer(buf);
      const c = { id: uid('c'), bufferId: id, start: Math.max(0, pos), offset: 0, duration: buf.duration, name: f.name.replace(/\.[^.]+$/, '').slice(0, 32) };
      target.arrangement.push(c); engine.rescheduleTrack(target);
      S.sel = { kind: 'arr', trackId: target.id, clipId: c.id };
      placed++;
      if (!t) pos += 0; // multiple files on empty space -> one new track each, same position
    } catch (e) { toast(`Could not decode ${f.name}: ${e.message || e}`); }
  }
  if (placed) { toast(`Placed ${placed} file(s) at ${fmtPos(pos)}`); renderArrange(); renderSession(); markDirty(); }
  return placed;
}
function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, hidden: true }); if (multiple) inp.multiple = true;
    inp.addEventListener('change', () => { resolve([...inp.files]); inp.remove(); });
    document.body.append(inp); inp.click();
  });
}

// ------------------------------------------------------------------ transport + recording
function updateTransportUI() {
  $('#btnPlay').classList.toggle('on', engine.playing);
  $('#btnRec').classList.toggle('on', engine.recording);
  $('#btnMetro').classList.toggle('on', engine.metronome);
  const ar = engine.autoRec.state; const b = $('#btnAutoRec');
  b.classList.toggle('on', ar !== 'off'); b.classList.toggle('waiting', ar === 'waiting');
  b.textContent = ar === 'waiting' ? 'WAIT' : 'AUTO';
}
async function togglePlay() { await engine.resume(); engine.playing ? engine.stop() : engine.play(); }
async function toggleRecord() {
  await engine.resume();
  try { if (engine.recording || engine.autoRec.state === 'waiting') await engine.stopRecording(); else await engine.startRecording(); }
  catch (e) { toast(e.message); }
}
async function toggleAutoRecord() {
  await engine.resume();
  if (engine.autoRec.state !== 'off') { await engine.stopRecording(); return; }
  try { await engine.armAutoRecord({ threshold: prefs.autoRecThreshold, preroll: prefs.autoRecPreroll }); toast(`Waiting for sound above ${prefs.autoRecThreshold} dBFS (pre-roll ${prefs.autoRecPreroll}s)…`, 3000); }
  catch (e) { toast(e.message); }
}
engine.on('transport', updateTransportUI);
engine.on('session', () => updateSessionStates());
engine.on('autorecord', () => { toast('Sound detected — recording'); haptic(20); });
engine.on('key', (k) => { toast(`Band key → ${k.name}`, 1800); updateKeyButton(); });
engine.on('recorded', (results) => {
  if (!results.length) return;
  history.push('Record');
  for (const r of results) {
    const id = addBuffer(r.buffer);
    r.track.arrangement.push({ id: uid('c'), bufferId: id, start: r.startPos, offset: r.offset, duration: r.duration, name: (r.auto ? 'Auto ' : 'Rec ') + new Date().toLocaleTimeString() });
    if (r.warning) toast(r.warning, 4000);
  }
  toast(`Recorded ${results.length} take(s) into the arrangement.`); renderArrange(); markDirty();
});
// MIDI arrangement recording
engine.on('recstart', ({ startPos }) => {
  const tracks = S.project.tracks.filter((t) => t.kind === 'midi' && t.arm);
  S.midiRec = tracks.length ? { startPos, tracks: new Map(tracks.map((t) => [t.id, { open: new Map(), notes: [] }])) } : null;
});
engine.on('recstop', ({ stopPos }) => {
  const R = S.midiRec; S.midiRec = null; if (!R) return;
  const bd = engine.beatDur; let made = 0;
  for (const [tid, r] of R.tracks) {
    for (const [n, o] of r.open) r.notes.push({ n, v: o.v, t: o.pos, d: stopPos - o.pos });
    if (!r.notes.length) continue;
    const t = track(tid); if (!t) continue;
    if (!made) history.push('Record MIDI');
    const dur = Math.max(bd, stopPos - R.startPos);
    t.arrangement.push({ id: uid('c'), type: 'midi', name: 'MIDI ' + new Date().toLocaleTimeString(), start: R.startPos, offset: 0, duration: dur, lengthBeats: dur / bd,
      notes: r.notes.map((x) => ({ n: x.n, v: x.v, t: Math.max(0, (x.t - R.startPos) / bd), d: Math.max(0.05, x.d / bd) })) });
    made++;
  }
  if (made) { toast(`Recorded MIDI on ${made} track(s).`); renderArrange(); markDirty(); }
});

// ------------------------------------------------------------------ MIDI input / on-screen notes
function midiTargets(inputId) {
  const armed = S.project.tracks.filter((t) => t.kind === 'midi' && t.arm && (t.midiInput === 'all' || t.midiInput === inputId || inputId === 'screen'));
  if (armed.length) return armed;
  const sel = track(S.selected); return sel && sel.kind === 'midi' ? [sel] : [];
}
function noteEvent(t, note, vel, on) {
  const n = engine.tracks.get(t.id); if (!n || !n.inst) return;
  if (engine.ctx.state !== 'running') engine.resume();
  on ? n.inst.noteOn(note, vel) : n.inst.noteOff(note);
  const pos = engine.position(), now = engine.ctx.currentTime;
  const R = S.midiRec && S.midiRec.tracks.get(t.id);
  if (R && engine.recording) {
    if (on) R.open.set(note, { v: vel, pos });
    else { const o = R.open.get(note); if (o) { R.notes.push({ n: note, v: o.v, t: o.pos, d: pos - o.pos }); R.open.delete(note); } }
  }
  const SR = S.slotRec.get(t.id);
  if (SR && now >= SR.startT - 0.02) {
    if (on) SR.open.set(note, { v: vel, time: now });
    else { const o = SR.open.get(note); if (o) { SR.notes.push({ n: note, v: o.v, time: o.time, end: now }); SR.open.delete(note); } }
  }
  flashTrack(t.id);
}
function flashTrack(id) { $$(`[data-sig="${id}"]`).forEach((e) => { e.classList.add('midi'); clearTimeout(e._mt); e._mt = setTimeout(() => e.classList.remove('midi'), 120); }); }
MIDI.onNote = (inputId, ch, note, vel, on) => { if (!S.project) return; for (const t of midiTargets(inputId)) noteEvent(t, note, vel, on); };
MIDI.onCC = (inputId, ch, cc, value) => {
  if (!S.project) return;
  if (S.learn.active && S.learn.target) {
    history.push('MIDI learn');
    const tg = S.learn.target;
    S.project.midiMap = S.project.midiMap.filter((m) => !(m.ch === ch && m.cc === cc) && !(m.trackId === tg.trackId && m.fx === tg.fx && m.key === tg.key));
    S.project.midiMap.push({ ch, cc, ...tg });
    toast(`Mapped CC ${cc} (ch ${ch + 1}) → ${tg.label}`); haptic(15);
    S.learn.target = null; $$('.knob.learn-target').forEach((k) => k.classList.remove('learn-target')); renderDevices(); markDirty();
    return;
  }
  if (cc === 1) for (const t of midiTargets(inputId)) { const n = engine.tracks.get(t.id); if (n && n.inst && n.inst.modWheel) n.inst.modWheel(value / 127); }
  for (const m of S.project.midiMap) {
    if (m.ch !== ch || m.cc !== cc) continue;
    const p = paramDef(m); if (!p) continue;
    const v = p.type === 'select' ? p.options[Math.min(p.options.length - 1, Math.floor(value / 128 * p.options.length))] : fromNorm(p, value / 127);
    setParam(m.trackId, m.fx, m.key, v, true);
    const el = $(`[data-learn="${m.trackId}:${m.fx}:${m.key}"]`); if (el && el.setValue) el.setValue(v);
  }
};
MIDI.onDevices = () => { if (S.project) renderSession(); };
MIDI.onBend = (inputId, ch, v) => { if (!S.project) return; for (const t of midiTargets(inputId)) { const n = engine.tracks.get(t.id); if (n && n.inst && n.inst.pitchBend) n.inst.pitchBend(v); } };
function paramDef(m) {
  if (m.fx === 'inst') { const t = track(m.trackId); const C = t && t.inst && INSTRUMENT_TYPES[t.inst.type]; return C && C.params.find((p) => p.key === m.key); }
  const list = m.trackId === 'master' ? S.project.master.fx : (track(m.trackId) || { fx: [] }).fx;
  const d = list[m.fx]; return d && EFFECT_TYPES[d.type].params.find((p) => p.key === m.key);
}
// Set any device parameter live (knob, MIDI CC). Undo steps are coalesced per parameter.
function setParam(trackId, fx, key, v, fromMidi = false) {
  history.push('Change ' + key, `p:${trackId}:${fx}:${key}`);
  if (fx === 'inst') { const n = engine.tracks.get(trackId); if (n && n.inst) n.inst.set(key, v); }
  else engine.setFxParam(trackId, fx, key, v);
  markDirty();
}

// ------------------------------------------------------------------ view toolbar (undo/redo, clip ops, key, auto-mix)
function viewTools(extra = []) {
  const b = (cls, label, title, fn, disabled) => h('button', { class: cls, title, onclick: fn, disabled: !!disabled }, label);
  return h('div', { class: 'view-tools' },
    b('adv', 'Copy', 'Copy selected clip (Ctrl/⌘+C)', () => clipOp('copy'), !S.sel), b('adv', 'Paste', 'Paste clip (Ctrl/⌘+V) at the playhead / into the selected slot', () => clipOp('paste'), !S.clipboard),
    b('adv', 'Dup', 'Duplicate selected clip (Ctrl/⌘+D)', () => clipOp('dup'), !S.sel), b('', 'Del', 'Delete selected clip (Delete)', () => clipOp('del'), !S.sel),
    ...extra,
    h('span', { class: 'sep' }),
    h('button', { class: 'key-btn', title: 'Song key used by Pitch Correct (tap to change, detect, or follow the band)', onclick: (e) => keyPopover(e.currentTarget) }, 'Key: ' + keyName(S.project.key) + (S.project.keyFollow ? ' ⟳' : '')));
}
function updateKeyButton() { $$('.key-btn').forEach((b) => (b.textContent = 'Key: ' + keyName(S.project.key) + (S.project.keyFollow ? ' ⟳' : ''))); }
function setKey(k, label = 'Change key') { change(label, () => { S.project.key = { root: k.root, scale: k.scale }; engine.updateBpmFx(); }); updateKeyButton(); }
function keyPopover(anchor) {
  closeMenus();
  const root = h('select', { 'aria-label': 'Key root', onchange: () => setKey({ root: +root.value, scale: scale.value }) }, NOTE_NAMES.map((n, i) => h('option', { value: i }, n)));
  const scale = h('select', { 'aria-label': 'Scale', onchange: () => setKey({ root: +root.value, scale: scale.value }) }, Object.keys(SCALES).map((s) => h('option', { value: s }, s)));
  root.value = S.project.key.root; scale.value = S.project.key.scale;
  const follow = h('input', { type: 'checkbox', checked: !!S.project.keyFollow, onchange: (e) => { if (e.target.checked && !gate('keyfollow', 'Follow the band (live key detection)')) { e.target.checked = false; return; } change('Follow band key', () => { S.project.keyFollow = e.target.checked; if (e.target.checked) engine.keyFollower.reset(); }); updateKeyButton(); } });
  const pop = h('div', { class: 'popover key-pop' },
    h('div', { class: 'row' }, root, scale),
    h('button', { onclick: async () => { const k = await detectProjectKey(); if (k) { root.value = k.root; scale.value = k.scale; setKey(k, 'Detect key'); toast(`Detected key: ${k.name} (${Math.round(k.confidence * 100)}%)`, 3000); } } }, 'Auto-detect from project'),
    h('label', { title: 'Continuously estimate the key from all non-drum tracks while playing, with hysteresis' }, follow, ' Follow the band (live) ', lockBadge('keyfollow')),
    h('p', { class: 'hint' }, 'Pitch Correct devices set to “Key from: global” use this key. Changes apply instantly while playing.'));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect(); const pr = pop.getBoundingClientRect();
  pop.style.left = Math.max(4, Math.min(r.left, innerWidth - pr.width - 4)) + 'px'; pop.style.top = Math.min(r.bottom + 4, innerHeight - pr.height - 4) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, { once: true }), 0);
}
async function detectProjectKey() {
  const chroma = new Float64Array(12);
  for (const t of S.project.tracks) {
    if (t.instrument === 'drums' || (t.inst && t.inst.type === 'drums')) continue;
    const notes = [...t.arrangement, ...t.slots].filter((c) => c && c.type === 'midi').flatMap((c) => c.notes);
    if (notes.length) { const c = chromaFromNotes(notes); const s = c.reduce((a, b) => a + b, 0) || 1; c.forEach((v, i) => (chroma[i] += v / s)); }
    for (const b of trackBuffers(t)) { await new Promise((r) => setTimeout(r, 0)); const c = chromaFromBuffer(b); const s = c.reduce((a, x) => a + x, 0) || 1; c.forEach((v, i) => (chroma[i] += v / s)); }
  }
  const k = detectKey(chroma);
  if (!k) toast('No tonal audio or MIDI found to detect the key.');
  return k;
}

// ------------------------------------------------------------------ clipboard + clip operations
function selectedClip() {
  const s = S.sel; if (!s) return null; const t = track(s.trackId); if (!t) return null;
  if (s.kind === 'arr') { const c = t.arrangement.find((x) => x.id === s.clipId); return c ? { t, c } : null; }
  return t.slots[s.slot] ? { t, c: t.slots[s.slot], slot: s.slot } : { t, c: null, slot: s.slot };
}
function clipOp(op) {
  const sc = selectedClip();
  if (op === 'copy') { if (!sc || !sc.c) return; S.clipboard = JSON.parse(JSON.stringify(sc.c)); toast('Copied clip', 1000); renderToolsState(); return; }
  if (op === 'paste') {
    if (!S.clipboard) return toast('Clipboard is empty');
    const cb = JSON.parse(JSON.stringify(S.clipboard));
    if (S.sel && S.sel.kind === 'slot') {
      const t = track(S.sel.trackId); if (!t) return;
      if ((cb.type === 'midi') !== (t.kind === 'midi')) return toast(cb.type === 'midi' ? 'Paste MIDI clips on MIDI tracks' : 'Paste audio clips on audio tracks');
      change('Paste clip', () => { t.slots[S.sel.slot] = cb.type === 'midi' ? { type: 'midi', name: cb.name, lengthBeats: cb.lengthBeats, notes: cb.notes } : { bufferId: cb.bufferId, name: cb.name, loopLength: cb.loopLength || cb.duration, gain: cb.gain }; });
      renderSession(); return;
    }
    let t = S.sel ? track(S.sel.trackId) : track(S.selected);
    if (!t || (cb.type === 'midi') !== (t.kind === 'midi')) t = S.project.tracks.find((x) => (cb.type === 'midi') === (x.kind === 'midi'));
    if (!t) return toast('No suitable track to paste on');
    const buf = cb.bufferId && engine.buffers.get(cb.bufferId);
    const dur = cb.duration || (cb.type === 'midi' ? cb.lengthBeats * engine.beatDur : Math.min(buf ? buf.duration : 1, cb.loopLength || 1));
    const c = { ...cb, id: uid('c'), start: engine.position(), offset: cb.offset || 0, duration: dur }; delete c.loopLength;
    change('Paste clip', () => { t.arrangement.push(c); engine.rescheduleTrack(t); });
    S.sel = { kind: 'arr', trackId: t.id, clipId: c.id }; renderArrange(); return;
  }
  if (!sc || !sc.c) return;
  const { t, c } = sc;
  if (op === 'del') {
    change('Delete clip', () => {
      if (S.sel.kind === 'arr') { t.arrangement = t.arrangement.filter((x) => x !== c); engine.rescheduleTrack(t); }
      else { const n = engine.tracks.get(t.id); if (n.sessionSlot === sc.slot) engine.stopTrackClip(t); t.slots[sc.slot] = null; }
    });
    S.sel = null; renderAll(); return;
  }
  if (op === 'dup') {
    if (S.sel.kind === 'arr') { const d = { ...JSON.parse(JSON.stringify(c)), id: uid('c'), start: c.start + c.duration }; change('Duplicate clip', () => { t.arrangement.push(d); engine.rescheduleTrack(t); }); S.sel = { kind: 'arr', trackId: t.id, clipId: d.id }; renderArrange(); }
    else { const free = t.slots.findIndex((x, i) => !x && i > sc.slot); if (free < 0) return toast('No free slot below'); change('Duplicate clip', () => { t.slots[free] = JSON.parse(JSON.stringify(c)); }); S.sel = { kind: 'slot', trackId: t.id, slot: free }; renderSession(); }
    return;
  }
  if (op === 'split' && S.sel.kind === 'arr') {
    const p = engine.position();
    if (p <= c.start || p >= c.start + c.duration) return toast('Move the playhead inside the selected clip to split.');
    const cut = p - c.start;
    change('Split clip', () => {
      const right = { ...JSON.parse(JSON.stringify(c)), id: uid('c'), start: p, offset: (c.offset || 0) + cut, duration: c.duration - cut };
      c.duration = cut; t.arrangement.push(right); engine.rescheduleTrack(t);
    });
    renderArrange();
  }
}
function renderToolsState() { $$('.view-tools').forEach((vt) => { vt.querySelectorAll('button').forEach((b) => { if (/^(Copy|Dup|Del)$/.test(b.textContent)) b.disabled = !S.sel; if (b.textContent === 'Paste') b.disabled = !S.clipboard; if (b.dataset.needsArr) b.disabled = !(S.sel && S.sel.kind === 'arr'); }); }); }

// ------------------------------------------------------------------ session view
function renderSession() {
  const root = $('#sessionView'); root.innerHTML = '';
  root.append(viewTools());
  const grid = h('div', { class: 'session-grid' });
  for (const { t, depth, hidden } of displayOrder()) {
    if (hidden) continue;
    const col = t.kind === 'group' ? groupColumn(t) : sessionColumn(t);
    if (depth) { col.classList.add('in-group'); col.style.setProperty('--depth', depth); }
    grid.append(col);
  }
  grid.append(h('div', { class: 'col add-col' },
    h('button', { class: 'add-track', onclick: () => addTrack(), title: 'Add an audio track (microphone / line input)' }, '+ Audio'),
    h('button', { class: 'add-track', onclick: () => addTrack(null, 'midi', 'synth'), title: 'Add a MIDI track with the built-in polyphonic synth' }, '+ Synth'),
    h('button', { class: 'add-track', onclick: () => addTrack(null, 'midi', 'drums'), title: 'Add a MIDI drum track with synthesized kits' }, '+ Drums'),
    h('button', { class: 'add-track adv', onclick: () => addTrack(null, 'group'), title: 'Add a group bus (own effects and fader). Put tracks in it via the track menu (long-press / right-click).' }, '+ Group', lockBadge('grouping'))));
  grid.append(masterColumn());
  const wrap = h('div', { class: 'session-scroll' }, grid);
  root.append(wrap);
  attachPinch(wrap, {
    start: () => prefs.sessionScale,
    zoom: (s0, k) => { prefs.sessionScale = Math.max(0.7, Math.min(1.8, s0 * k)); applySessionScale(); },
    end: () => savePrefs(),
  });
  applySessionScale();
  updateSessionStates();
}
function groupColumn(t) {
  const col = h('div', { class: 'col group' + (t.folded ? ' folded' : ''), 'data-id': t.id, style: { '--c': t.color } });
  col.append(trackHeader(t));
  const n = groupMembers(t).length;
  col.append(h('div', { class: 'slots group-slots' }, h('button', { class: 'fold', title: t.folded ? 'Unfold: show the tracks in this group' : 'Fold: hide the tracks in this group', onclick: () => toggleFold(t) }, (t.folded ? '▸ ' : '▾ ') + n + (n === 1 ? ' track' : ' tracks'))));
  col.append(h('button', { class: 'stop-clip', title: 'Stop all clips in this group', onclick: () => groupMembers(t).forEach((m) => engine.stopTrackClip(m)) }, '■'));
  col.append(mixerStrip(t));
  return col;
}
function applySessionScale() { const r = document.documentElement.style; r.setProperty('--sscale', prefs.sessionScale); }
function trackHeader(t) {
  const hd = h('div', { class: 'col-head' + (S.selected === t.id ? ' sel' : ''), style: { '--c': t.color }, title: `${t.name} — tap to show its devices, double-tap to rename, long-press for more` },
    h('span', { class: 'kind' }, t.kind === 'group' ? '▤' : t.kind === 'midi' ? (t.inst && t.inst.type === 'drums' ? '🥁' : '♪') : ''),
    h('span', { class: 'name' }, t.name),
    t.role && ROLES[t.role] ? h('span', { class: 'inst-tag', title: 'Auto-Mix role: ' + ROLES[t.role].label }, ROLES[t.role].label.slice(0, 4)) : t.instrument ? h('span', { class: 'inst-tag', title: 'Instrument' }, INSTRUMENT_LABELS[t.instrument].slice(0, 3)) : null);
  hd.addEventListener('click', () => { if (consumedLongPress(hd)) return; selectTrack(t.id); });
  hd.addEventListener('dblclick', () => renameTrack(t));
  longPress(hd, (x, y) => trackMenu(t, x, y));
  return hd;
}
function trackMenu(t, x, y) {
  contextMenu(x, y, [
    { label: 'Rename…', fn: () => renameTrack(t) },
    { label: 'Next colour', fn: () => change('Track colour', () => { t.color = TRACK_COLORS[(TRACK_COLORS.indexOf(t.color) + 1) % TRACK_COLORS.length]; renderAll(); }) },
    t.kind === 'audio' ? { label: 'Detect instrument', fn: () => detectTrack(t, true) } : null,
    '-',
    t.kind !== 'group' ? { label: 'Group this track' + (allowed('grouping') ? '' : ' 🔒'), fn: () => groupTrack(t) } : null,
    S.project.tracks.some((g) => g.kind === 'group' && g.id !== t.id) ? { label: 'Move to group…', fn: () => groupMenu(t, x, y) } : null,
    t.groupId ? { label: 'Remove from group', fn: () => setGroup(t, null) } : null,
    t.kind === 'group' ? { label: 'Ungroup (keep tracks)', fn: () => ungroup(t) } : null,
    t.kind === 'group' ? { label: t.folded ? 'Unfold' : 'Fold', fn: () => toggleFold(t) } : null,
    '-',
    { label: 'Delete track', fn: () => { if (confirm(`Delete track "${t.name}"? (Undo is available)`)) deleteTrack(t.id); } },
  ]);
}
function renameTrack(t) { const n = prompt('Track name', t.name); if (n) change('Rename track', () => { t.name = n.slice(0, 32); renderAll(); }); }
function selectTrack(id) {
  if (S.selected === id) return;
  S.selected = id;
  $$('#sessionView .col-head').forEach((e) => e.classList.toggle('sel', e.closest('.col').dataset.id === id));
  $$('#arrangeView .lane-head').forEach((e) => e.classList.toggle('sel', e.dataset.id === id));
  renderDevices();
}
function sessionColumn(t) {
  const col = h('div', { class: 'col' + (t.kind === 'midi' ? ' midi' : ''), 'data-id': t.id, style: { '--c': t.color } });
  col.append(trackHeader(t));
  const slots = h('div', { class: 'slots' });
  t.slots.forEach((clip, i) => {
    const s = h('div', { class: 'slot' + (clip ? ' has-clip' : '') + (S.sel && S.sel.kind === 'slot' && S.sel.trackId === t.id && S.sel.slot === i ? ' selected' : ''), 'data-slot': i,
      title: clip ? `${clip.name || 'Clip'} — tap to launch, long-press for options${clip.type === 'midi' ? ', double-tap to edit notes' : ''}` : (t.arm ? 'Tap to record here' : 'Empty slot — arm the track to record, long-press for options') });
    if (clip) {
      s.append(h('span', { class: 'play-ico' }, '▶'), h('span', { class: 'clip-name' }, clip.name || 'Clip'), h('div', { class: 'prog' }));
      const cv = h('canvas', { class: 'mini-wave' }); s.append(cv);
      requestAnimationFrame(() => clip.type === 'midi' ? drawNotes(cv, clip, 'rgba(0,0,0,.4)') : drawWave(cv, engine.buffers.get(clip.bufferId), 0, clip.loopLength, 'rgba(0,0,0,.35)'));
    } else s.append(h('span', { class: 'slot-btn' }));
    s.addEventListener('click', () => { if (!consumedLongPress(s)) onSlotClick(t, i); });
    s.addEventListener('dblclick', () => { if (clip && clip.type === 'midi') editMidiClip(t, clip); else if (!clip && t.kind === 'midi') newMidiClipInSlot(t, i); });
    longPress(s, (x, y) => slotMenu(t, i, x, y));
    slots.append(s);
  });
  col.append(slots);
  col.append(h('button', { class: 'stop-clip', title: 'Stop this track\'s clip (at the next bar)', onclick: () => engine.stopTrackClip(t) }, '■'));
  col.append(mixerStrip(t));
  return col;
}
function slotMenu(t, i, x, y) {
  const clip = t.slots[i];
  S.sel = { kind: 'slot', trackId: t.id, slot: i }; renderToolsState();
  if (!clip) return contextMenu(x, y, [
    t.kind === 'midi' ? { label: 'New MIDI clip (4 bars)', fn: () => newMidiClipInSlot(t, i) } : { label: 'Import audio here…', fn: async () => { const f = await pickFiles('audio/*', false); if (f[0]) { try { const buf = await decodeFile(f[0]); change('Import audio', () => { t.slots[i] = { bufferId: addBuffer(buf), name: f[0].name.replace(/\.[^.]+$/, '').slice(0, 32), loopLength: buf.duration }; }); renderSession(); } catch (e) { toast('Could not decode: ' + e.message); } } } },
    S.clipboard ? { label: 'Paste', fn: () => clipOp('paste') } : null,
  ]);
  contextMenu(x, y, [
    clip.type === 'midi' ? { label: 'Edit notes (piano roll)', fn: () => editMidiClip(t, clip) } : null,
    { label: 'Rename…', fn: () => { const n = prompt('Clip name', clip.name); if (n) change('Rename clip', () => { clip.name = n.slice(0, 64); renderSession(); }); } },
    { label: 'Copy', fn: () => clipOp('copy') }, { label: 'Duplicate', fn: () => clipOp('dup') },
    { label: 'Copy to arrangement @ playhead', fn: () => {
      const buf = clip.bufferId && engine.buffers.get(clip.bufferId);
      const dur = clip.type === 'midi' ? clip.lengthBeats * engine.beatDur : Math.min(buf.duration, clip.loopLength || buf.duration);
      change('Copy to arrangement', () => { t.arrangement.push({ ...JSON.parse(JSON.stringify(clip)), id: uid('c'), start: engine.position(), offset: 0, duration: dur }); delete t.arrangement[t.arrangement.length - 1].loopLength; engine.rescheduleTrack(t); });
      renderArrange(); toast('Copied to arrangement');
    } },
    clip.type !== 'midi' ? { label: 'Export clip as WAV', fn: () => download(new Blob([encodeWav(engine.buffers.get(clip.bufferId))], { type: 'audio/wav' }), (clip.name || 'clip') + '.wav') } : null,
    '-',
    { label: 'Delete clip', fn: () => clipOp('del') },
  ]);
}
function newMidiClipInSlot(t, i) {
  const clip = { type: 'midi', name: 'MIDI ' + (i + 1), lengthBeats: 4 * (S.project.beatsPerBar || 4), notes: [] };
  change('New MIDI clip', () => { t.slots[i] = clip; });
  renderSession(); editMidiClip(t, clip);
}
function editMidiClip(t, clip) {
  openPianoRoll({ clip, title: `${t.name} · ${clip.name || 'MIDI'}`, color: t.color, history,
    onChange: (what) => { if (what === 'length' && clip.id) clip.duration = clip.lengthBeats * engine.beatDur; markDirty(); if (what === 'close') { renderSession(); renderArrange(); } },
    preview: (n) => { const nd = engine.tracks.get(t.id); if (nd && nd.inst) { engine.resume(); nd.inst.playNote(n, 90, engine.ctx.currentTime, 0.25); } } });
}
async function onSlotClick(t, i) {
  await engine.resume();
  const n = engine.tracks.get(t.id);
  const wasSel = S.sel && S.sel.kind === 'slot' && S.sel.trackId === t.id && S.sel.slot === i;
  S.sel = { kind: 'slot', trackId: t.id, slot: i };
  $$('#sessionView .slot.selected').forEach((e) => e.classList.remove('selected'));
  const el = $(`#sessionView .col[data-id="${t.id}"] .slot[data-slot="${i}"]`); if (el) el.classList.add('selected');
  renderToolsState(); haptic(6);
  // MIDI slot recording
  const SR = S.slotRec.get(t.id);
  if (SR && SR.slot === i) return stopMidiSlotRecording(t, SR);
  if (n.rec && n.rec.slot === i) {
    const res = await engine.stopSlotRecording(t);
    if (res) {
      change('Record clip', () => { t.slots[i] = { bufferId: addBuffer(res.buffer), name: 'Rec ' + (i + 1), loopLength: res.loopLength }; });
      if (res.warning) toast(res.warning, 4000);
      renderSession(); engine.playRecordedSlot(t, i, res.startT);
    } else toast('Nothing was recorded.');
    return;
  }
  if (t.slots[i]) { engine.launchSlot(t, i); return; }
  if (t.arm) {
    if (n.rec || SR) return toast('This track is already recording.');
    if (t.kind === 'midi') return startMidiSlotRecording(t, i);
    try { await engine.recordSlot(t, i); } catch (e) { toast(e.message); }
  } else {
    selectTrack(t.id);
    if (!wasSel) toast(t.kind === 'midi' ? 'Empty slot — double-tap to create a MIDI clip, or arm (●) to record.' : 'Empty slot — arm the track (●) to record here, or long-press for import/paste.', 2200);
  }
}
function startMidiSlotRecording(t, i) {
  if (!engine.playing) engine.play(engine.barFloor(engine.startPos));
  const startT = engine.ctx.currentTime < engine.startCtxTime + 0.01 ? engine.startCtxTime : engine.nextBarTime();
  S.slotRec.set(t.id, { slot: i, startT, notes: [], open: new Map() });
  updateSessionStates(); toast('MIDI recording starts at the next bar — tap the slot again to stop.', 2000);
}
function stopMidiSlotRecording(t, SR) {
  const stopT = Math.max(engine.nextBarTime(), SR.startT + engine.barDur);
  SR.stopping = true; updateSessionStates();
  setTimeout(() => {
    S.slotRec.delete(t.id);
    for (const [n, o] of SR.open) SR.notes.push({ n, v: o.v, time: o.time, end: stopT });
    const bd = engine.beatDur, lengthBeats = Math.max(1, Math.round((stopT - SR.startT) / bd));
    const notes = SR.notes.filter((x) => x.time < stopT).map((x) => ({ n: x.n, v: x.v, t: Math.max(0, (x.time - SR.startT) / bd), d: Math.max(0.05, (Math.min(x.end, stopT) - x.time) / bd) }));
    const clip = { type: 'midi', name: 'MIDI ' + (SR.slot + 1), lengthBeats, notes };
    change('Record MIDI clip', () => { t.slots[SR.slot] = clip; });
    const n = engine.tracks.get(t.id);
    if (engine.playing) engine.startSessionMidi(t, n, SR.slot, clip, stopT);
    renderSession();
  }, Math.max(0, (stopT - engine.ctx.currentTime) * 1000 - 60));
}
function updateSessionStates() {
  if (!S.project) return;
  for (const t of S.project.tracks) {
    const n = engine.tracks.get(t.id); if (!n) continue;
    const col = $(`#sessionView .col[data-id="${t.id}"]`); if (!col) continue;
    const SR = S.slotRec.get(t.id);
    $$('.slot', col).forEach((s) => {
      const i = +s.dataset.slot;
      const playing = n.sessionSlot === i && engine.playing;
      const queued = playing && n.queued && n.queued.slot === i && n.queued.when > engine.ctx.currentTime;
      s.classList.toggle('playing', playing && !queued);
      s.classList.toggle('queued', !!queued);
      s.classList.toggle('recording', !!((n.rec && n.rec.slot === i) || (SR && SR.slot === i)));
      s.classList.toggle('armed', t.arm && !t.slots[i]);
    });
  }
}
function masterColumn() {
  const col = h('div', { class: 'col master-col', 'data-id': 'master' });
  const hd = h('div', { class: 'col-head' + (S.selected === 'master' ? ' sel' : ''), style: { '--c': '#bbb' }, title: 'Master bus — tap to show the master chain' }, h('span', { class: 'name' }, 'Master'));
  hd.addEventListener('click', () => selectTrack('master'));
  col.append(hd);
  const slots = h('div', { class: 'slots' });
  for (let i = 0; i < S.project.scenes; i++) slots.append(h('div', { class: 'slot scene', title: `Launch scene ${i + 1} (all clips in this row)`, onclick: () => { engine.resume(); engine.launchScene(i); haptic(8); } }, h('span', { class: 'play-ico' }, '▶'), ` ${i + 1}`));
  col.append(slots);
  col.append(h('button', { class: 'stop-clip', title: 'Stop all clips', onclick: () => engine.stopAllClips() }, '■ All'));
  const strip = h('div', { class: 'strip' });
  const faderRow = h('div', { class: 'fader-row' });
  faderRow.append(createFader(S.project.master.volume, (v) => { history.push('Master volume', 'mvol'); S.project.master.volume = v; engine.syncMaster(); markDirty(); }));
  faderRow.append(h('canvas', { class: 'meter', 'data-meter': 'master' }));
  strip.append(faderRow);
  col.append(strip);
  return col;
}
function inputOptions(t) {
  if (t.kind === 'midi') {
    const sel = h('select', { class: 'in-dev', title: 'MIDI input for this track', onchange: (e) => change('MIDI input', () => { t.midiInput = e.target.value; }) },
      h('option', { value: 'all' }, 'All MIDI'), MIDI.inputs().map((i) => h('option', { value: i.id }, i.name)));
    sel.value = t.midiInput || 'all'; if (!sel.value) sel.value = 'all';
    return [sel];
  }
  const sel = h('select', { class: 'in-dev', title: 'Input device', onchange: (e) => { change('Input device', () => { t.inputDeviceId = e.target.value; }); reattachIfArmed(t); } });
  sel.append(h('option', { value: 'default' }, 'Default in'));
  for (const d of S.devices.inputs) if (d.deviceId && d.deviceId !== 'default') sel.append(h('option', { value: d.deviceId }, d.label || 'Input ' + d.deviceId.slice(0, 4)));
  sel.value = t.inputDeviceId || 'default'; if (!sel.value) sel.value = 'default';
  const chCount = Math.max(2, t._channels || 2);
  const ch = h('select', { class: 'in-ch adv', title: 'Input channel (Stereo uses channels 1+2)', onchange: (e) => { change('Input channel', () => { t.inputChannel = e.target.value; }); reattachIfArmed(t); } });
  for (let c = 0; c < Math.min(16, chCount); c++) ch.append(h('option', { value: String(c) }, `In ${c + 1}`));
  ch.append(h('option', { value: 'stereo' }, 'Stereo'));
  ch.value = t.inputChannel;
  return [sel, ch];
}
function mixerStrip(t) {
  const strip = h('div', { class: 'strip' });
  strip.append(t.kind === 'group' ? h('div', { class: 'strip-row grp-label' }, 'Group bus') : h('div', { class: 'strip-row' }, ...inputOptions(t)));
  const btn = (cls, label, on, fn, title) => h('button', { class: `tbtn ${cls}` + (on ? ' on' : ''), onclick: fn, title }, label);
  strip.append(h('div', { class: 'strip-row btns' },
    t.kind === 'group' ? null : btn('arm', '●', t.arm, () => toggleArm(t), t.kind === 'midi' ? 'Arm: record MIDI and receive MIDI keyboard input' : 'Arm for recording (asks for microphone access)'),
    t.kind === 'group' ? null : h('span', { class: 'sig', 'data-sig': t.id, title: 'Input signal indicator (green = signal, yellow = loud, red = clipping)' }),
    t.kind === 'audio' ? btn('mon adv', 'IN', t.monitor, () => change('Monitor', () => { t.monitor = !t.monitor; engine.syncTrack(t); renderAll(); }), 'Input monitoring: hear the input through the effects (use headphones!)') : null,
    btn('mute', 'M', t.mute, () => change('Mute', () => { t.mute = !t.mute; engine.syncTrack(t); renderAll(); }), 'Mute'),
    btn('solo', 'S', t.solo, () => change('Solo', () => { t.solo = !t.solo; engine.syncMutes(); renderAll(); }), 'Solo')));
  const pan = createKnob({ key: 'pan', label: 'Pan', min: -1, max: 1, def: 0, help: 'Left/right position' }, t.pan, (v) => { history.push('Pan', 'pan' + t.id); t.pan = v; engine.syncTrack(t); markDirty(); }, { small: true });
  pan.classList.add('adv'); strip.append(pan);
  const faderRow = h('div', { class: 'fader-row' });
  faderRow.append(createFader(t.volume, (v) => { history.push('Volume', 'vol' + t.id); t.volume = v; engine.syncTrack(t); markDirty(); }));
  faderRow.append(h('canvas', { class: 'meter', 'data-meter': t.id }));
  strip.append(faderRow);
  return strip;
}

// ------------------------------------------------------------------ touch gestures: pinch-zoom + two-finger pan
function attachPinch(el, { start, zoom, pan, end }) {
  const pts = new Map(); let g = null;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) g = { d0: dist(), m0: mid(), s0: start(mid()) }; });
  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g && pts.size === 2) { e.preventDefault(); const m = mid(); zoom(g.s0, dist() / g.d0, m); if (pan) pan(m.x - g.m0.x, m.y - g.m0.y, g); }
  }, { passive: false });
  const up = (e) => { if (!pts.delete(e.pointerId)) return; if (g && pts.size < 2) { g = null; end && end(); } };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); const s = start({ x: e.clientX, y: e.clientY }); zoom(s, Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY }); end && end(); }, { passive: false });
}

// ------------------------------------------------------------------ arrangement view
function arrLength() {
  let end = 0;
  for (const t of S.project.tracks) for (const c of t.arrangement) end = Math.max(end, c.start + c.duration);
  return Math.max(end + engine.barDur * 8, engine.barDur * 32, engine.position() + engine.barDur * 4);
}
function setZoom(z, anchorX) {
  const sc = $('#arrangeView .arr-scroll'); if (!sc) { S.zoom = z; return; }
  const r = sc.getBoundingClientRect(); const ax = anchorX == null ? r.width / 2 : anchorX - r.left;
  const t = (sc.scrollLeft + ax) / S.zoom;
  S.zoom = Math.max(4, Math.min(400, z));
  renderArrange();
  const sc2 = $('#arrangeView .arr-scroll'); sc2.scrollLeft = t * S.zoom - ax; S._arrScroll = sc2.scrollLeft;
}
function renderArrange() {
  const root = $('#arrangeView'); const prevTop = S._arrTop || 0; root.innerHTML = '';
  const len = arrLength(), W = len * S.zoom;
  const needArr = (label, title, fn) => { const b = h('button', { class: 'adv', title, onclick: fn, disabled: !(S.sel && S.sel.kind === 'arr') }, label); b.dataset.needsArr = '1'; return b; };
  root.append(viewTools([
    needArr('Split', 'Split the selected clip at the playhead (S)', () => clipOp('split')),
    needArr('Quantize…', 'Quantize: move notes/hits in the selected clip onto the beat grid', () => quantizeDialog()),
    h('span', { class: 'sep' }),
    h('button', { title: 'Zoom out', onclick: () => setZoom(S.zoom / 1.5) }, '−'),
    h('button', { title: 'Zoom in (or pinch / Ctrl+wheel)', onclick: () => setZoom(S.zoom * 1.5) }, '+'),
    h('button', { class: 'follow adv' + (S.follow ? ' on' : ''), title: 'Keep the playhead in view', onclick: (e) => { S.follow = !S.follow; e.target.classList.toggle('on', S.follow); } }, 'Follow'),
  ]));
  const body = h('div', { class: 'arr-body' });
  const heads = h('div', { class: 'arr-heads' }, h('div', { class: 'ruler-spacer' }));
  const scroll = h('div', { class: 'arr-scroll' });
  const content = h('div', { class: 'arr-content', style: { width: W + 'px' } });
  const ruler = h('div', { class: 'ruler', title: 'Tap to move the playhead' });
  const bd = engine.barDur; const step = S.zoom * bd < 30 ? 4 : S.zoom * bd < 60 ? 2 : 1;
  for (let b = 0; b * bd < len; b += step) ruler.append(h('span', { style: { left: b * bd * S.zoom + 'px' } }, String(b + 1)));
  ruler.addEventListener('pointerdown', (e) => { const r = content.getBoundingClientRect(); engine.setPosition((e.clientX - r.left) / S.zoom); });
  content.append(ruler);
  content.style.setProperty('--bar', bd * S.zoom + 'px');
  content.style.setProperty('--beat', engine.beatDur * S.zoom + 'px');
  for (const { t, depth, hidden } of displayOrder()) {
    if (hidden) continue;
    const isG = t.kind === 'group';
    const lh = h('div', { class: 'lane-head' + (S.selected === t.id ? ' sel' : '') + (isG ? ' group' : '') + (depth ? ' in-group' : ''), 'data-id': t.id, style: { '--c': t.color, '--depth': depth }, title: `${t.name} — tap to select, long-press for options` },
      h('div', { class: 'lh-name' }, isG ? '' : t.kind === 'midi' ? (t.inst && t.inst.type === 'drums' ? '🥁 ' : '♪ ') : '', t.name),
      h('div', { class: 'lh-btns' },
        isG ? h('button', { class: 'tbtn fold', title: t.folded ? 'Unfold group' : 'Fold group', onclick: (e) => { e.stopPropagation(); toggleFold(t); } }, t.folded ? '▸' : '▾')
          : h('button', { class: 'tbtn arm' + (t.arm ? ' on' : ''), title: 'Arm for recording', onclick: (e) => { e.stopPropagation(); toggleArm(t); } }, '●'),
        isG ? null : h('span', { class: 'sig', 'data-sig': t.id }),
        h('button', { class: 'tbtn mute' + (t.mute ? ' on' : ''), title: 'Mute', onclick: (e) => { e.stopPropagation(); change('Mute', () => { t.mute = !t.mute; engine.syncTrack(t); }); renderAll(); } }, 'M'),
        h('button', { class: 'tbtn solo' + (t.solo ? ' on' : ''), title: 'Solo', onclick: (e) => { e.stopPropagation(); change('Solo', () => { t.solo = !t.solo; engine.syncMutes(); }); renderAll(); } }, 'S'),
        h('canvas', { class: 'meter h', 'data-meter': t.id })));
    lh.addEventListener('click', () => { if (!consumedLongPress(lh)) selectTrack(t.id); });
    longPress(lh, (x, y) => trackMenu(t, x, y));
    heads.append(lh);
    const lane = h('div', { class: 'lane' + (t.kind === 'midi' ? ' midi' : '') + (isG ? ' group-lane' : ''), 'data-id': isG ? '' : t.id, style: { '--c': t.color } });
    for (const c of t.arrangement) lane.append(arrClip(t, c));
    content.append(lane);
  }
  content.append(h('div', { class: 'lane drop-new', title: 'Drop audio files here to create new tracks' }, h('span', {}, 'Drop audio here for a new track · long-press for options')));
  heads.append(h('div', { class: 'add-row' },
    h('button', { class: 'add-track small', onclick: () => addTrack(), title: 'Add audio track' }, '+ Audio'),
    h('button', { class: 'add-track small', onclick: () => addTrack(null, 'midi', 'synth'), title: 'Add synth track' }, '+ Synth'),
    h('button', { class: 'add-track small', onclick: () => addTrack(null, 'midi', 'drums'), title: 'Add drum track' }, '+ Drums')));
  content.append(h('div', { class: 'playhead' }));
  scroll.append(content);
  const ov = h('canvas', { class: 'overview', title: 'Overview — tap or drag to scroll' });
  scroll.addEventListener('scroll', () => { heads.scrollTop = scroll.scrollTop; S._arrScroll = scroll.scrollLeft; S._arrTop = scroll.scrollTop; drawOverview(); });
  body.append(heads, scroll);
  root.append(body, ov);
  // --- lane hit testing (drop + long-press)
  const hit = (x, y) => {
    const r = content.getBoundingClientRect(); const pos = Math.max(0, (x - r.left) / S.zoom);
    const lane = document.elementsFromPoint(x, y).find((e) => e.classList && e.classList.contains('lane'));
    return { pos, trackId: lane && lane.dataset.id ? lane.dataset.id : null };
  };
  scroll.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; content.classList.add('dropping'); } });
  scroll.addEventListener('dragleave', () => content.classList.remove('dropping'));
  scroll.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); content.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    const proj = files.filter((f) => /\.(webdaw|zip|json|enc)$/i.test(f.name));
    if (proj.length) return importProject(proj[0]);
    const audio = files.filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|oga|flac|m4a|aac|webm|opus|aif|aiff)$/i.test(f.name));
    if (!audio.length) return toast('Drop audio files (wav, mp3, ogg, flac, m4a…)');
    await engine.resume();
    const { pos, trackId } = hit(e.clientX, e.clientY);
    const q = e.shiftKey ? pos : Math.round(pos / engine.beatDur) * engine.beatDur;
    await importAudioAt(audio, q, trackId);
  });
  longPress(scroll, (x, y, ev) => {
    if (ev && ev.target && ev.target.closest && ev.target.closest('.aclip')) return;
    const { pos, trackId } = hit(x, y); const t = trackId && track(trackId);
    const q = Math.round(pos / engine.beatDur) * engine.beatDur;
    contextMenu(x, y, [
      { label: `Import audio here (${fmtPos(q)})…`, fn: async () => { const f = await pickFiles('audio/*'); if (f.length) { await engine.resume(); importAudioAt(f, q, t && t.kind === 'audio' ? t.id : null); } } },
      t && t.kind === 'midi' ? { label: 'New MIDI clip here (4 bars)', fn: () => newMidiClipArr(t, q) } : null,
      S.clipboard ? { label: 'Paste here', fn: () => { S.sel = t ? { kind: 'arr', trackId: t.id, clipId: null } : null; engine.setPosition(q); clipOp('paste'); } } : null,
      { label: 'Move playhead here', fn: () => engine.setPosition(q) },
    ]);
  });
  scroll.addEventListener('dblclick', (e) => { if (e.target.closest('.aclip')) return; const { pos, trackId } = hit(e.clientX, e.clientY); const t = trackId && track(trackId); if (t && t.kind === 'midi') newMidiClipArr(t, Math.floor(pos / engine.barDur) * engine.barDur); });
  scroll.addEventListener('pointerdown', (e) => { if (!e.target.closest('.aclip') && S.sel && S.sel.kind === 'arr') { S.sel = null; $$('.aclip.sel').forEach((x) => x.classList.remove('sel')); renderToolsState(); } });
  attachPinch(scroll, { start: () => { S._pan0 = [scroll.scrollLeft, scroll.scrollTop]; return S.zoom; }, pan: (dx, dy) => { scroll.scrollTop = S._pan0[1] - dy; }, zoom: (z0, k, m) => { const nz = Math.max(4, Math.min(400, z0 * k)); if (Math.abs(nz - S.zoom) / S.zoom > 0.04) setZoom(nz, m.x); } });
  // overview scrollbar
  const ovDrag = (e) => { const r = ov.getBoundingClientRect(); const f = (e.clientX - r.left) / r.width; scroll.scrollLeft = f * W - scroll.clientWidth / 2; };
  ov.addEventListener('pointerdown', (e) => { ov.setPointerCapture(e.pointerId); ovDrag(e); ov.onpointermove = ovDrag; });
  ov.addEventListener('pointerup', () => { ov.onpointermove = null; });
  scroll.scrollLeft = S._arrScroll || 0; scroll.scrollTop = prevTop;
  requestAnimationFrame(drawOverview);
}
function drawOverview() {
  const ov = $('#arrangeView .overview'), sc = $('#arrangeView .arr-scroll'); if (!ov || !sc) return;
  const w = ov.width = Math.round(ov.clientWidth * devicePixelRatio), hh = ov.height = Math.round(ov.clientHeight * devicePixelRatio);
  const g = ov.getContext('2d'); g.clearRect(0, 0, w, hh);
  const len = arrLength(), n = Math.max(1, S.project.tracks.length), lh = hh / n;
  S.project.tracks.forEach((t, i) => { g.fillStyle = t.color + 'cc'; for (const c of t.arrangement) g.fillRect(c.start / len * w, i * lh + 1, Math.max(1, c.duration / len * w), Math.max(1, lh - 2)); });
  const W = len * S.zoom; g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = devicePixelRatio;
  g.strokeRect(sc.scrollLeft / W * w + 0.5, 0.5, Math.max(4, sc.clientWidth / W * w) - 1, hh - 1);
  g.fillStyle = '#fff'; g.fillRect(engine.position() / len * w, 0, devicePixelRatio, hh);
}
function newMidiClipArr(t, pos) {
  const lb = 4 * (S.project.beatsPerBar || 4);
  const c = { id: uid('c'), type: 'midi', name: 'MIDI', start: pos, offset: 0, lengthBeats: lb, duration: lb * engine.beatDur, notes: [] };
  change('New MIDI clip', () => { t.arrangement.push(c); });
  S.sel = { kind: 'arr', trackId: t.id, clipId: c.id }; renderArrange(); editMidiClip(t, c);
}
function arrClip(t, c) {
  const isSel = S.sel && S.sel.kind === 'arr' && S.sel.clipId === c.id;
  const el = h('div', { class: 'aclip' + (c.type === 'midi' ? ' midi' : '') + (isSel ? ' sel' : ''), 'data-clip': c.id, style: { left: c.start * S.zoom + 'px', width: Math.max(4, c.duration * S.zoom) + 'px' }, title: (c.name || 'Clip') + ' — drag to move (Shift = no snap), long-press for options' + (c.type === 'midi' ? ', double-tap to edit notes' : '') },
    h('div', { class: 'aclip-name' }, c.name || ''), h('canvas'));
  requestAnimationFrame(() => c.type === 'midi' ? drawNotes($('canvas', el), c, 'rgba(0,0,0,.5)') : drawWave($('canvas', el), engine.buffers.get(c.bufferId), c.offset, c.duration));
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); if (c.type === 'midi') editMidiClip(t, c); });
  longPress(el, (x, y) => {
    S.sel = { kind: 'arr', trackId: t.id, clipId: c.id }; renderToolsState();
    contextMenu(x, y, [
      c.type === 'midi' ? { label: 'Edit notes (piano roll)', fn: () => editMidiClip(t, c) } : null,
      { label: 'Copy', fn: () => clipOp('copy') }, { label: 'Duplicate', fn: () => clipOp('dup') },
      { label: 'Split at playhead', fn: () => clipOp('split') },
      { label: 'Quantize…', fn: () => quantizeDialog() },
      { label: 'Rename…', fn: () => { const n = prompt('Clip name', c.name); if (n) change('Rename clip', () => { c.name = n.slice(0, 64); renderArrange(); }); } },
      '-', { label: 'Delete', fn: () => clipOp('del') },
    ]);
  });
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !e.isPrimary) return;
    S.sel = { kind: 'arr', trackId: t.id, clipId: c.id };
    $$('.aclip.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); renderToolsState();
    const sx = e.clientX, sy = e.clientY, s0 = c.start; let moved = false, pushed = false;
    const move = (ev) => {
      const dx = ev.clientX - sx;
      if (!moved && Math.abs(dx) < 6) { if (Math.abs(ev.clientY - sy) > 10) cleanup(); return; }
      if (!moved) { moved = true; try { el.setPointerCapture(e.pointerId); } catch (err) {} }
      if (!pushed) { history.push('Move clip'); pushed = true; }
      let ns = Math.max(0, s0 + dx / S.zoom);
      if (!ev.shiftKey) { const q = engine.beatDur; ns = Math.round(ns / q) * q; }
      c.start = ns; el.style.left = ns * S.zoom + 'px';
    };
    const cleanup = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    const up = () => { cleanup(); if (moved) { markDirty(); engine.rescheduleTrack(t); drawOverview(); } };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  return el;
}

// ------------------------------------------------------------------ device panel (compact cards, expand on demand)
const FX_COLORS = { pitch: '#3ecf8e', eq: '#ffa529', compressor: '#4a9cff', maximizer: '#8a7dff', limiter: '#d36bff', distortion: '#ff764d', delay: '#2fc6d6', reverb: '#9bd44a' };
function renderDevices() {
  const panel = $('#devices'); panel.innerHTML = '';
  const isMaster = S.selected === 'master';
  const t = isMaster ? null : track(S.selected);
  const head = $('#devHead'); head.innerHTML = '';
  if (!isMaster && !t) return;
  const tid = isMaster ? 'master' : t.id;
  const fxList = isMaster ? S.project.master.fx : t.fx;
  head.append(h('span', { class: 'dev-title', style: { '--c': isMaster ? '#bbb' : t.color }, title: 'Devices of the selected track' }, isMaster ? 'Master' : t.name));
  if (!isMaster && t.kind !== 'group') {
    const roleNote = t.role && ROLES[t.role] ? ` · ${ROLES[t.role].label}` : '';
    const inst = h('select', { class: 'inst-sel', title: 'Instrument type (auto-detected or chosen) — selects the preset family' + roleNote, onchange: (e) => {
      const v = e.target.value;
      change('Instrument', () => { if (v === '') { t.instrument = null; t.instrumentSource = null; } else { t.instrument = v; t.instrumentSource = 'manual'; applyPreset(t, v, defaultPresetName(v)); } });
      renderAll();
    } }, h('option', { value: '' }, 'Instr: —'), INSTRUMENTS.map((i) => h('option', { value: i }, INSTRUMENT_LABELS[i] + (t.instrument === i && t.instrumentSource === 'auto' ? ` (auto ${Math.round((t.detection?.confidence || 0) * 100)}%)` : ''))));
    inst.value = t.instrument || '';
    head.append(inst);
    const presets = PRESETS[t.instrument || 'other'];
    const ps = h('select', { class: 'preset-sel', title: 'Preset effect chain', onchange: (e) => { change('Preset', () => applyPreset(t, t.instrument || 'other', e.target.value)); renderDevices(); } },
      h('option', { value: '', disabled: true }, 'Preset…'), Object.keys(presets).map((p) => h('option', { value: p }, p)));
    ps.value = presets[t.preset] ? t.preset : '';
    head.append(ps);
    if (t.kind !== 'group') head.append(h('button', { class: 'small adapt-btn' + (t.adaptive.enabled ? ' on' : ''), title: 'Live adaptive EQ/compression: gently steers this track toward a target sound for its instrument while you play (rate-limited, max ±6 dB). Tap to toggle.', onclick: () => {
      if (!t.adaptive.enabled && !gate('adaptive', 'Adaptive mode')) return;
      change('Adaptive', () => { t.adaptive.enabled = !t.adaptive.enabled; engine.syncAdaptive(t); }); renderDevices();
    } }, 'Adapt', lockBadge('adaptive')));
  }
  const add = h('select', { class: 'add-fx', title: 'Add an effect to the end of the chain', onchange: (e) => {
    const val = e.target.value; e.target.value = ''; if (!val) return;
    const [type, preset] = val.split(':');
    if (!gate('fx.' + type, EFFECT_TYPES[type].label)) return;
    const def = type === 'rack' ? { type, enabled: true, ...rackPresetDef(preset) } : { type, enabled: true, values: {} };
    change('Add effect', () => { fxList.push(def); isMaster ? engine.setMasterFx(fxList) : engine.setTrackFx(t); });
    S.expanded.add(`${tid}:${fxList.length - 1}:${type}`);
    renderDevices();
    setTimeout(() => { const d = $('#devices'); d.scrollLeft = d.scrollWidth; }, 0);
  } }, h('option', { value: '' }, '+ FX'), Object.entries(EFFECT_TYPES).filter(([k]) => k !== 'rack').map(([k, C]) => h('option', { value: k }, C.label + (allowed('fx.' + k) ? '' : ` 🔒${tierShort('fx.' + k)}`))),
    h('optgroup', { label: 'Racks' + (allowed('fx.rack') ? '' : ` 🔒${tierShort('fx.rack')}`) }, Object.keys(allRackPresets()).map((n) => h('option', { value: 'rack:' + n }, 'Rack: ' + n))));
  head.append(add);
  head.append(h('button', { class: 'small learn-btn adv' + (S.learn.active ? ' on' : ''), title: 'MIDI Learn: tap this, tap a knob, then move a knob/fader on your MIDI controller', onclick: toggleLearn }, 'Learn'));
  head.append(h('button', { class: 'collapse small', onclick: () => { $('#devicePanel').classList.toggle('collapsed'); }, title: 'Show/hide the device panel' }, '▾'));

  if (t && t.kind === 'midi') panel.append(instrumentCard(t));
  if (t && t.adaptive.enabled) panel.append(adaptiveCard(t));
  const instances = engine.fxInstances(tid);
  if (!fxList.length && !(t && t.kind === 'midi')) panel.append(h('div', { class: 'empty-chain' }, isMaster ? 'Master chain is empty.' : 'No effects. Add one (+ FX), pick a preset, or use Auto-Mix.'));
  fxList.forEach((d, idx) => panel.append(deviceCard(tid, fxList, d, idx, instances[idx], t)));
}
function toggleLearn() {
  if (!S.learn.active && !MIDI.supported) return toast(MIDI.notice(), 5000);
  S.learn.active = !S.learn.active; S.learn.target = null;
  document.body.classList.toggle('learn', S.learn.active);
  $$('.learn-btn').forEach((b) => b.classList.toggle('on', S.learn.active));
  if (S.learn.active) { MIDI.init().then((ok) => { if (!ok) toast('MIDI unavailable: ' + (MIDI.error || MIDI.status)); }); toast('MIDI Learn: tap a knob, then move a control on your MIDI device.', 3500); }
}
function knobFor(tid, fxIdx, p, value, onChange, label) {
  const key = `${tid}:${fxIdx}:${p.key}`;
  const k = createKnob({ ...p, help: p.help || PARAM_HELP[p.key] }, value, onChange, { learnKey: key });
  k.addEventListener('pointerdown', (e) => {
    if (!S.learn.active) return;
    e.stopPropagation(); $$('.knob.learn-target').forEach((x) => x.classList.remove('learn-target')); k.classList.add('learn-target');
    S.learn.target = { trackId: tid, fx: fxIdx, key: p.key, label: `${label} ${p.label}` }; toast(`Now move a control on your MIDI device for “${label} ${p.label}”`, 2500);
  }, true);
  if (S.project.midiMap.some((m) => m.trackId === tid && m.fx === fxIdx && m.key === p.key)) k.classList.add('mapped');
  if (!p.easy && p._adv) k.classList.add('adv');
  return k;
}
function selectParam(p, value, onChange) {
  const s = h('label', { class: 'sel-param', title: p.help || PARAM_HELP[p.key] || p.label }, h('span', {}, p.label),
    h('select', { onchange: (e) => onChange(e.target.value) }, p.options.map((o) => h('option', { value: o }, o))));
  $('select', s).value = value; return s;
}
function deviceCard(tid, fxList, d, idx, inst, t) {
  const C = EFFECT_TYPES[d.type]; const color = FX_COLORS[d.type] || '#ffa529';
  const ekey = `${tid}:${idx}:${d.type}`; const expanded = S.expanded.has(ekey);
  const rebuild = (label, mut) => { change(label, () => { mut(); tid === 'master' ? engine.setMasterFx(fxList) : engine.setTrackFx(t); }); renderDevices(); };
  const card = h('div', { class: 'device' + (d.enabled === false ? ' off' : '') + (expanded ? ' expanded' : ''), 'data-type': d.type, style: { '--fx': color }, title: EFFECT_HELP[d.type] || C.label });
  card.append(h('div', { class: 'dev-bar' },
    h('button', { class: 'pwr' + (d.enabled !== false ? ' on' : ''), title: 'On/off (bypass)', onclick: (e) => { change('Bypass', () => { d.enabled = d.enabled === false; engine.setFxEnabled(tid, idx, d.enabled); }); card.classList.toggle('off', !d.enabled); e.currentTarget.classList.toggle('on', d.enabled); haptic(8); } }, '⏻'),
    h('span', { class: 'dev-name' }, C.label),
    h('button', { class: 'adv', title: 'Move left', onclick: () => { if (idx > 0) rebuild('Move effect', () => { [fxList[idx - 1], fxList[idx]] = [fxList[idx], fxList[idx - 1]]; }); } }, '‹'),
    h('button', { class: 'adv', title: 'Move right', onclick: () => { if (idx < fxList.length - 1) rebuild('Move effect', () => { [fxList[idx + 1], fxList[idx]] = [fxList[idx], fxList[idx + 1]]; }); } }, '›'),
    h('button', { class: 'expand', title: expanded ? 'Collapse (show main controls only)' : 'Expand (all controls + bigger display)', onclick: () => { expanded ? S.expanded.delete(ekey) : S.expanded.add(ekey); renderDevices(); } }, expanded ? '▴' : '▾'),
    h('button', { title: 'Remove effect', onclick: () => rebuild('Remove effect', () => fxList.splice(idx, 1)) }, '×')));
  if (d.type === 'rack') { card.append(rackBody(tid, idx, d, inst, expanded)); if (!allowed('fx.rack')) $('.dev-name', card).append(lockBadge('fx.rack')); return card; }
  if (!allowed('fx.' + d.type)) $('.dev-name', card).append(' ', lockBadge('fx.' + d.type));
  const body = h('div', { class: 'dev-body' });
  if (inst) body.append(fxViz(d, inst, color, expanded));
  const knobs = h('div', { class: 'knobs' });
  const easy = EASY_PARAMS[d.type] || [];
  const onParam = (p) => (v) => { setParam(tid, idx, p.key, v); if (p.key === 'keySource' || p.key === 'root' || p.key === 'scale') updatePitchKeyLabel(card, d); };
  for (const p of C.params) {
    const isEasy = easy.includes(p.key);
    if (!expanded && !isEasy) continue;
    const el = p.type === 'select' ? selectParam(p, d.values[p.key], onParam(p)) : knobFor(tid, idx, p, d.values[p.key], onParam(p), C.label);
    if (!isEasy) el.classList.add('adv');
    if (d.type === 'pitch' && (p.key === 'root' || p.key === 'scale') && d.values.keySource !== 'manual') el.classList.add('dim');
    knobs.append(el);
  }
  if (d.type === 'pitch') {
    knobs.prepend(h('div', { class: 'pitch-key', title: 'Correction key (tap to change the global key)', onclick: (e) => keyPopover(e.currentTarget) }, pitchKeyText(d)));
    if (expanded) knobs.append(h('button', { class: 'small', title: 'Analyse the project audio/MIDI and set the global key', onclick: async () => { const k = await detectProjectKey(); if (k) { setKey(k, 'Detect key'); toast(`Detected key: ${k.name}`, 2500); renderDevices(); } } }, 'Detect key'),
      h('span', { class: 'hint adv' }, inst ? `DSP: ${inst.engineKind}` : ''));
  }
  body.append(knobs); card.append(body);
  return card;
}
const pitchKeyText = (d) => d.values.keySource === 'manual' ? `${d.values.root} ${d.values.scale}` : `${keyName(S.project.key)}${S.project.keyFollow ? ' ⟳' : ''}`;
function updatePitchKeyLabel(card, d) { const el = $('.pitch-key', card); if (el) el.textContent = pitchKeyText(d); $$('.sel-param', card).forEach((s) => { const k = $('span', s).textContent; if (k === 'Key' || k === 'Scale') s.classList.toggle('dim', d.values.keySource !== 'manual'); }); }
// per-effect live display
function fxViz(d, inst, color, big) {
  const cv = h('canvas', { class: 'fx-viz' + (big ? ' big' : '') });
  const ctx = engine.ctx;
  if (d.type === 'eq') {
    const an = tap(ctx, inst.output, 2048); const N = 96, freqs = new Float32Array(N); for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
    addViz(cv, (g, w, hh) => { drawSpectrum(g, w, hh, an, '#8a939c'); if (inst.response) drawCurve(g, w, hh, freqs, inst.response(freqs), color); });
  } else if (['compressor', 'maximizer', 'limiter'].includes(d.type)) {
    const hist = new Array(90).fill(0);
    addViz(cv, (g, w, hh) => { const r = inst.getReduction(); hist.push(r); hist.shift(); drawHistory(g, w, hh, hist, 18, color, `GR ${r.toFixed(1)} dB`); });
  } else if (['distortion', 'delay', 'amp', 'chorus', 'tremolo', 'autopan'].includes(d.type)) {
    const an = tap(ctx, inst.output, 2048); addViz(cv, (g, w, hh) => drawScope(g, w, hh, an, color));
  } else if (d.type === 'reverb') {
    const an = tap(ctx, inst.output, 2048); addViz(cv, (g, w, hh) => drawSpectrum(g, w, hh, an, color));
  } else if (d.type === 'pitch') {
    inst.onSnap = () => haptic(6);
    addViz(cv, (g, w, hh) => drawPitch(g, w, hh, inst.history, inst.readout, noteName, color));
  }
  cv.addEventListener('click', () => cv.closest('.device').querySelector('.expand').click());
  return cv;
}
function adaptiveCard(t) {
  const n = engine.tracks.get(t.id); const A = n.adaptive;
  const card = h('div', { class: 'device adaptive', style: { '--fx': '#2fc6d6' }, title: 'Live adaptive EQ/compressor (pre-effects). It measures the dry signal and moves 5 EQ bands by at most 0.3 dB per step toward the target for the instrument, bounded to ±6 dB.' });
  const st = h('div', { class: 'adapt-status' }, A.status);
  const cv = h('canvas', { class: 'fx-viz' });
  addViz(cv, (g, w, hh) => {
    st.textContent = A.status;
    g.clearRect(0, 0, w, hh); const bw = w / BANDS.length;
    g.strokeStyle = '#ffffff22'; g.beginPath(); g.moveTo(0, hh / 2); g.lineTo(w, hh / 2); g.stroke();
    A.gains.forEach((v, i) => { const y = (v / 6) * (hh / 2) * 0.9; g.fillStyle = v >= 0 ? '#3ecf8e' : '#ff764d'; g.fillRect(i * bw + bw * 0.2, hh / 2 - Math.max(0, y), bw * 0.6, Math.abs(y) || 1);
      g.fillStyle = '#9aa4ad'; g.font = `${9 * devicePixelRatio}px sans-serif`; g.fillText(BANDS[i].name.slice(0, 5), i * bw + 2, hh - 2); });
  });
  card.append(h('div', { class: 'dev-bar' }, h('button', { class: 'pwr on', title: 'Turn adaptive off', onclick: () => { change('Adaptive', () => { t.adaptive.enabled = false; engine.syncAdaptive(t); }); renderDevices(); } }, '⏻'), h('span', { class: 'dev-name' }, 'Adaptive · ' + INSTRUMENT_LABELS[t.instrument || 'other'])),
    h('div', { class: 'dev-body' }, cv, st, h('div', { class: 'knobs' }, createKnob({ key: 'amount', label: 'Amount', min: 0, max: 100, def: 60, unit: '%', help: 'How strongly the adaptive processing may steer.' }, t.adaptive.amount, (v) => { history.push('Adaptive amount', 'adapt' + t.id); t.adaptive.amount = v; engine.syncAdaptive(t); markDirty(); }))));
  return card;
}
function instrumentCard(t) {
  const n = engine.tracks.get(t.id); const I = n && n.inst; const type = t.inst.type;
  const C = INSTRUMENT_TYPES[type]; const ekey = t.id + ':inst'; const expanded = S.expanded.has(ekey);
  const card = h('div', { class: 'device inst' + (expanded ? ' expanded' : ''), style: { '--fx': t.color }, title: C.label + ' — play with a MIDI keyboard, the on-screen keys/pads, or draw notes in the piano roll' });
  const bar = h('div', { class: 'dev-bar' });
  if (type === 'drums') bar.append(h('span', { class: 'dev-name' }, C.label));
  else {
    const ts = h('select', { class: 'inst-type', title: 'Synth engine', onchange: (e) => {
      const nt = e.target.value; e.target.value = type;
      if (!gate('inst.' + nt, INSTRUMENT_TYPES[nt].label)) return;
      change('Synth type', () => { t.inst = { type: nt, values: {} }; engine.setInstrument(t); }); renderDevices();
    } }, ['synth', 'wavetable'].map((k) => h('option', { value: k }, INSTRUMENT_TYPES[k].label + (allowed('inst.' + k) ? '' : ' 🔒'))));
    ts.value = type; bar.append(ts);
    if (C.presets) bar.append(h('select', { class: 'inst-preset', title: 'Synth preset', onchange: (e) => { const nm = e.target.value; e.target.value = ''; if (nm && I) { change('Synth preset', () => I.applyPreset(nm)); renderDevices(); } } },
      h('option', { value: '' }, 'Preset…'), Object.keys(C.presets).map((k) => h('option', { value: k }, k))));
    if (!allowed('inst.' + type)) bar.append(lockBadge('inst.' + type));
  }
  bar.append(h('button', { class: 'expand', title: expanded ? 'Collapse' : 'Expand (all controls)', onclick: () => { expanded ? S.expanded.delete(ekey) : S.expanded.add(ekey); renderDevices(); } }, expanded ? '▴' : '▾'));
  card.append(bar);
  const body = h('div', { class: 'dev-body' });
  if (type === 'wavetable' && I) {
    const cv = h('canvas', { class: 'fx-viz wt-viz' + (expanded ? ' big' : ''), title: 'Wavetable: faint lines = frames of the table, bright line = current (LFO-modulated) position' });
    addViz(cv, (g, w, hh) => {
      g.clearRect(0, 0, w, hh); const N = 96, frames = 7, dx = w * 0.12 / frames, dy = hh * 0.35 / frames;
      for (let f = frames - 1; f >= 0; f--) { const wave = wavetableFrame(I.values.table, f / (frames - 1), N); g.strokeStyle = 'rgba(255,255,255,' + (0.08 + 0.04 * (frames - f)) + ')'; g.lineWidth = devicePixelRatio; g.beginPath();
        for (let i = 0; i < N; i++) { const x = f * dx + (i / (N - 1)) * (w - w * 0.14), y = hh * 0.62 - f * dy - wave[i] * hh * 0.22; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
      const pos = I.displayPos(), wave = wavetableFrame(I.values.table, pos, N), off = pos * (frames - 1);
      g.strokeStyle = t.color; g.lineWidth = 2 * devicePixelRatio; g.shadowColor = t.color; g.shadowBlur = 6 * devicePixelRatio; g.beginPath();
      for (let i = 0; i < N; i++) { const x = off * dx + (i / (N - 1)) * (w - w * 0.14), y = hh * 0.62 - off * dy - wave[i] * hh * 0.22; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); g.shadowBlur = 0;
      g.fillStyle = '#9aa4ad'; g.font = `${9 * devicePixelRatio}px sans-serif`; g.fillText(`${I.values.table} · pos ${Math.round(pos * 100)}% · ${I.activeCount()} voice(s)`, 4 * devicePixelRatio, hh - 4 * devicePixelRatio);
    });
    body.append(cv);
  }
  const play = (note, on) => { noteEvent(t, note, 100, on); if (on) haptic(5); };
  const pads = h('div', { class: type === 'drums' ? 'pads' : 'minikeys', title: type === 'drums' ? 'Drum pads (recordable when the track is armed)' : 'Mini keyboard (recordable when the track is armed)' });
  const bindPad = (el, note) => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('down'); play(note, true); });
    const off = () => { if (el.classList.contains('down')) { el.classList.remove('down'); play(note, false); } };
    el.addEventListener('pointerup', off); el.addEventListener('pointerleave', off); el.addEventListener('pointercancel', off);
  };
  if (type === 'drums') for (const [note, name] of PAD_ORDER.slice(0, expanded ? 11 : 8)) { const p = h('button', { class: 'pad' }, name); bindPad(p, note); pads.append(p); }
  else {
    const base = S.kbdOct || 48;
    for (let i = 0; i < (expanded ? 25 : 13); i++) { const nn = base + i; const black = [1, 3, 6, 8, 10].includes(nn % 12); const k = h('button', { class: 'key' + (black ? ' black' : ''), title: noteName(nn) }); bindPad(k, nn); pads.append(k); }
    const wheel = (label, cls, min, onV, spring) => { const r = h('input', { type: 'range', class: 'wheel ' + cls, min, max: 1, step: 0.01, value: spring ? 0 : (I ? I.modWheelValue : 0), title: label, 'aria-label': label, orient: 'vertical' });
      r.addEventListener('input', () => { if (I) onV(+r.value); }); if (spring) { const back = () => { r.value = 0; if (I) onV(0); }; r.addEventListener('pointerup', back); r.addEventListener('change', back); } return r; };
    body.append(h('div', { class: 'kbd-row' },
      h('div', { class: 'oct' }, h('button', { title: 'Octave down', onclick: () => { S.kbdOct = Math.max(24, (S.kbdOct || 48) - 12); renderDevices(); } }, '−'), h('span', {}, noteName(S.kbdOct || 48)), h('button', { title: 'Octave up', onclick: () => { S.kbdOct = Math.min(84, (S.kbdOct || 48) + 12); renderDevices(); } }, '+')),
      wheel('Pitch bend (±2 semitones, springs back)', 'bend', -1, (v) => I.pitchBend(v), true), wheel('Mod wheel (vibrato)', 'mod', 0, (v) => I.modWheel(v), false), pads));
  }
  if (type === 'drums') body.append(pads);
  const knobs = h('div', { class: 'knobs' });
  for (const p of C.params) {
    if (!expanded && !p.easy) continue;
    const onC = (v) => setParam(t.id, 'inst', p.key, v);
    const el = p.type === 'select' ? selectParam(p, I ? I.values[p.key] : p.def, onC) : knobFor(t.id, 'inst', p, I ? I.values[p.key] : p.def, onC, C.label);
    if (!p.easy) el.classList.add('adv');
    knobs.append(el);
  }
  body.append(knobs); card.append(body);
  return card;
}

// ------------------------------------------------------------------ racks (parallel chains + macros), presets
const RACK_KEY = 'webdaw.rackPresets';
const BUILTIN_RACKS = {
  'Empty': { chains: [{ name: 'Chain 1', fx: [] }], macroMap: [] },
  'Parallel Crush': { chains: [{ name: 'Dry', fx: [] }, { name: 'Crush', volume: -10, fx: [{ type: 'compressor', values: { threshold: -38, ratio: 12, attack: 1, release: 90, makeup: 12 } }] }],
    macroMap: [{ macro: 0, chain: 1, fx: 0, key: 'threshold', min: -20, max: -50 }], values: { macro1: 50 } },
  'Wide Space': { chains: [{ name: 'Dry', fx: [] }, { name: 'Chorus', volume: -6, fx: [{ type: 'chorus', values: { mix: 100, depth: 60 } }] }, { name: 'Verb', volume: -8, fx: [{ type: 'reverb', values: { mix: 100, space: 'hall' } }] }],
    macroMap: [{ macro: 0, chain: 2, fx: 0, key: 'decay', min: 0.8, max: 6 }, { macro: 1, chain: 1, fx: 0, key: 'depth', min: 10, max: 100 }], values: { macro1: 30, macro2: 50 } },
};
function userRackPresets() { try { const o = JSON.parse(localStorage.getItem(RACK_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
function allRackPresets() { return { ...BUILTIN_RACKS, ...userRackPresets() }; }
function rackPresetDef(name) {
  const p = allRackPresets()[name] || BUILTIN_RACKS.Empty;
  try {
    const v = validateRack(p); // user presets come from storage: sanitise like imported projects
    v.chains.forEach((c) => (c.fx = c.fx.filter((f) => allowed('fx.' + f.type))));
    v.macroMap = v.macroMap.filter((m) => v.chains[m.chain] && v.chains[m.chain].fx[m.fx]);
    return { ...v, values: { ...(p.values || {}) } };
  } catch (e) { toast('Rack preset invalid: ' + e.message); return { chains: [{ name: 'Chain 1', fx: [] }], macroMap: [], values: {} }; }
}
function saveRackPreset(d) {
  const name = (prompt('Rack preset name', 'My Rack') || '').trim().slice(0, 32); if (!name) return;
  if (BUILTIN_RACKS[name]) return toast('That name is used by a built-in preset.');
  const all = userRackPresets(); all[name] = JSON.parse(JSON.stringify({ chains: d.chains, macroMap: d.macroMap, values: d.values }));
  try { localStorage.setItem(RACK_KEY, JSON.stringify(all)); toast(`Saved rack preset “${name}” (in this browser)`); renderDevices(); } catch (e) { toast('Could not save: ' + e.message); }
}
function rackBody(tid, idx, d, inst, expanded) {
  const body = h('div', { class: 'dev-body rack-body' });
  if (!inst) return body;
  const learnOn = (m) => S.macroLearn && S.macroLearn.tid === tid && S.macroLearn.idx === idx && S.macroLearn.m === m;
  const macros = h('div', { class: 'knobs macros' });
  EFFECT_TYPES.rack.params.forEach((p) => macros.append(knobFor(tid, idx, p, d.values[p.key], (v) => setParam(tid, idx, p.key, v), 'Rack')));
  body.append(macros);
  body.append(h('div', { class: 'map-row' }, [0, 1, 2, 3].map((m) => {
    const n = d.macroMap.filter((x) => x.macro === m).length;
    return h('button', { class: 'map-btn' + (learnOn(m) ? ' on' : ''), title: `Map Macro ${m + 1}: tap here, then tap a knob inside the rack (${n} mapped). Tap again to stop.`, onclick: () => {
      if (learnOn(m)) S.macroLearn = null; else { S.macroLearn = { tid, idx, m }; S.expanded.add(`${tid}:${idx}:rack`); toast(`Tap a knob inside the rack to map it to Macro ${m + 1}`, 2500); }
      document.body.classList.toggle('maplearn', !!S.macroLearn); renderDevices();
    } }, `M${m + 1}${n ? '·' + n : ''}`);
  })));
  // live update of inner knobs when a macro moves
  const cardKnobs = new Map();
  inst.onMacro = (changed) => changed.forEach((m) => { const el = cardKnobs.get(`${m.chain}:${m.fx}:${m.key}`); const v = inst.chains[m.chain].fx[m.fx].values[m.key]; if (el) { if (el.setValue) el.setValue(v); else { const s = $('select', el); if (s) s.value = v; } } });
  if (!expanded) { body.append(h('div', { class: 'hint rack-sum' }, `${d.chains.length} chain(s): ${d.chains.map((c) => c.name + (c.fx.length ? ' (' + c.fx.map((f) => EFFECT_TYPES[f.type].label).join(', ') + ')' : '')).join(' ‖ ')}`)); return body; }
  d.chains.forEach((c, ci) => {
    const ic = inst.chains[ci]; if (!ic) return;
    const addSel = h('select', { class: 'add-fx small', title: 'Add an effect to this chain', onchange: (e) => {
      const type = e.target.value; e.target.value = ''; if (!type || !gate('fx.' + type, EFFECT_TYPES[type].label)) return;
      change('Add effect to chain', () => { c.fx.push({ type, enabled: true, values: {} }); inst.rebuildChain(ci); });
      S.expanded.add(`${tid}:${idx}:c${ci}:${c.fx.length - 1}`); renderDevices();
    } }, h('option', { value: '' }, '+'), Object.entries(EFFECT_TYPES).filter(([k]) => k !== 'rack').map(([k, C]) => h('option', { value: k }, C.label + (allowed('fx.' + k) ? '' : ' 🔒'))));
    const row = h('div', { class: 'chain' + (c.mute ? ' muted' : '') },
      h('div', { class: 'chain-head' },
        h('span', { class: 'chain-name', title: 'Chain name (double-tap to rename)', ondblclick: () => { const n = prompt('Chain name', c.name); if (n) change('Rename chain', () => { c.name = n.slice(0, 32); renderDevices(); }); } }, c.name),
        h('button', { class: 'tbtn mute' + (c.mute ? ' on' : ''), title: 'Mute this chain', onclick: () => { change('Chain mute', () => { c.mute = !c.mute; inst.syncChain(ic, false); }); renderDevices(); } }, 'M'),
        createKnob({ key: 'vol', label: 'Vol', min: -60, max: 12, def: 0, unit: 'dB', help: 'Chain volume' }, c.volume || 0, (v) => { history.push('Chain volume', `cv:${tid}:${idx}:${ci}`); c.volume = v; inst.syncChain(ic, false); markDirty(); }, { small: true }),
        createKnob({ key: 'pan', label: 'Pan', min: -1, max: 1, def: 0, help: 'Chain pan' }, c.pan || 0, (v) => { history.push('Chain pan', `cp:${tid}:${idx}:${ci}`); c.pan = v; inst.syncChain(ic, false); markDirty(); }, { small: true }),
        addSel,
        h('button', { class: 'small', title: 'Remove this chain', onclick: () => { change('Remove chain', () => inst.removeChain(ci)); renderDevices(); } }, '×')));
    const fxRow = h('div', { class: 'chain-fx' });
    c.fx.forEach((fd, fi) => {
      const f = ic.fx[fi]; if (!f) return; const C = EFFECT_TYPES[fd.type]; const okey = `${tid}:${idx}:c${ci}:${fi}`; const open = S.expanded.has(okey);
      const chip = h('div', { class: 'inner-fx' + (open ? ' open' : '') + (fd.enabled === false ? ' off' : '') },
        h('div', { class: 'inner-bar' },
          h('button', { class: 'pwr' + (fd.enabled !== false ? ' on' : ''), title: 'On/off', onclick: () => { change('Bypass', () => { fd.enabled = fd.enabled === false; f.setEnabled(fd.enabled); }); renderDevices(); } }, '⏻'),
          h('button', { class: 'inner-name', title: open ? 'Collapse' : 'Show controls', onclick: () => { open ? S.expanded.delete(okey) : S.expanded.add(okey); renderDevices(); } }, C.label + (open ? ' ▴' : ' ▾')),
          h('button', { title: 'Remove from chain', onclick: () => { change('Remove effect', () => { c.fx.splice(fi, 1); d.macroMap = d.macroMap.filter((m) => !(m.chain === ci && m.fx === fi)).map((m) => (m.chain === ci && m.fx > fi ? { ...m, fx: m.fx - 1 } : m)); inst.rdef.macroMap = d.macroMap; inst.rebuildChain(ci); }); renderDevices(); } }, '×')));
      if (open) {
        const kn = h('div', { class: 'knobs' });
        for (const p of C.params) {
          const onC = (v) => { history.push('Change ' + p.key, `rp:${tid}:${idx}:${ci}:${fi}:${p.key}`); f.set(p.key, v); markDirty(); };
          const el = p.type === 'select' ? selectParam(p, fd.values[p.key], onC) : createKnob({ ...p, help: p.help || PARAM_HELP[p.key] }, fd.values[p.key], onC, { small: true });
          cardKnobs.set(`${ci}:${fi}:${p.key}`, el);
          if (d.macroMap.some((m) => m.chain === ci && m.fx === fi && m.key === p.key)) el.classList.add('mapped');
          el.addEventListener('pointerdown', (e) => {
            const L = S.macroLearn; if (!L || L.tid !== tid || L.idx !== idx) return;
            e.stopPropagation(); e.preventDefault();
            const cur = fd.values[p.key];
            const range = p.type === 'select' ? [0, 1] : [cur, (cur - p.min) < (p.max - p.min) / 2 ? p.max : p.min];
            change('Map macro', () => { d.macroMap = d.macroMap.filter((m) => !(m.chain === ci && m.fx === fi && m.key === p.key)); d.macroMap.push({ macro: L.m, chain: ci, fx: fi, key: p.key, min: range[0], max: range[1] }); inst.rdef.macroMap = d.macroMap; });
            toast(`Macro ${L.m + 1} → ${C.label} ${p.label} (from the current value toward ${fmtRange(p, range[1])})`, 2500); haptic(12);
            S.macroLearn = null; document.body.classList.remove('maplearn'); renderDevices();
          }, true);
          kn.append(el);
        }
        chip.append(kn);
      }
      fxRow.append(chip);
    });
    if (!c.fx.length) fxRow.append(h('span', { class: 'hint' }, 'dry (no effects)'));
    row.append(fxRow); body.append(row);
  });
  body.append(h('div', { class: 'rack-btns' },
    d.chains.length < 6 ? h('button', { class: 'small', title: 'Add a parallel chain', onclick: () => { change('Add chain', () => inst.addChain({ name: 'Chain ' + (d.chains.length + 1), volume: 0, pan: 0, mute: false, fx: [] })); renderDevices(); } }, '+ Chain') : null,
    h('button', { class: 'small', title: 'Save this rack as a preset in this browser', onclick: () => saveRackPreset(d) }, 'Save preset…'),
    d.macroMap.length ? h('button', { class: 'small', title: 'Remove all macro mappings', onclick: () => { change('Clear macro maps', () => { d.macroMap = []; inst.rdef.macroMap = d.macroMap; }); renderDevices(); } }, 'Clear maps') : null,
    h('span', { class: 'hint' }, 'Chains run in parallel and are summed.')));
  return body;
}
const fmtRange = (p, v) => (p.type === 'select' ? 'the last option' : `${Math.round(v * 100) / 100}${p.unit ? ' ' + p.unit : ''}`);

// ------------------------------------------------------------------ auto-mix setup / detection
const TARGET_RMS = { drums: -17, bass: -19, vocals: -18, guitar: -20, keys: -22, other: -21 };
// Audio of a track (AudioBuffer-likes). fromSec > 0 analyses only arrangement audio after that time.
function trackBuffers(t, fromSec = 0) {
  const out = [];
  const view = (b, startSmp, len) => ({ sampleRate: b.sampleRate, numberOfChannels: b.numberOfChannels, length: len, duration: len / b.sampleRate, getChannelData: (c) => b.getChannelData(c).subarray(startSmp, startSmp + len) });
  for (const c of t.arrangement) {
    const b = c.type !== 'midi' && engine.buffers.get(c.bufferId); if (!b) continue;
    if (!fromSec) { if (!out.some((x) => x === b || x._src === b)) out.push(b); continue; }
    const cut = Math.max(0, fromSec - c.start); if (cut >= c.duration) continue;
    const s0 = Math.floor(((c.offset || 0) + cut) * b.sampleRate), len = Math.min(b.length - s0, Math.floor((c.duration - cut) * b.sampleRate));
    if (len > b.sampleRate * 0.2) { const v = view(b, s0, len); v._src = b; out.push(v); }
  }
  if (!fromSec || !out.length) t.slots.forEach((c) => { const b = c && c.type !== 'midi' && engine.buffers.get(c.bufferId); if (b && !out.includes(b)) out.push(b); });
  return out;
}
function mixMono(bufs, maxSec = 30) {
  if (!bufs.length) return null; const sr = bufs[0].sampleRate; let len = 0; for (const b of bufs) len += b.length; len = Math.min(len, Math.floor(maxSec * sr));
  const m = new Float32Array(len); let o = 0;
  for (const b of bufs) { const n = Math.min(b.length, len - o); if (n <= 0) break; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) m[o + i] += d[i] / b.numberOfChannels; } o += n; }
  return { mono: m, sr };
}
const DRUM_HINTS = [[/kick|bd\b|bassdrum/i, 'drum_kick'], [/snare|sd\b/i, 'drum_snare'], [/hat|hh\b/i, 'drum_hihat'], [/tom/i, 'drum_toms'], [/oh\b|overhead|cym/i, 'drum_overheads'], [/room|amb/i, 'drum_room'], [/kit|drums?\b|beat/i, 'drum_kit']];
// Heuristic role suggestion. Returns {role, why}. The user's choice always wins.
function suggestRole(t, fromBar = 1) {
  if (t.kind === 'midi') return t.inst && t.inst.type === 'drums' ? { role: 'drum_kit', why: 'MIDI drum track' } : { role: 'keys', why: 'MIDI synth track' };
  const bufs = trackBuffers(t, Math.max(0, (fromBar - 1) * engine.barDur));
  if (!bufs.length) { const hint = DRUM_HINTS.find(([re]) => re.test(t.name)); return hint ? { role: hint[1], why: 'track name' } : { role: 'other', why: 'no audio yet' }; }
  const res = analyzeBuffers(bufs, t.name);
  if (!res || res.silent) return { role: 'other', why: 'silent' };
  const conf = Math.round(res.confidence * 100);
  const mm = mixMono(bufs); const f = extractFeatures(mm.mono, mm.sr);
  if (res.instrument === 'drums') {
    const hint = DRUM_HINTS.find(([re]) => re.test(t.name)); if (hint) return { role: hint[1], why: 'name + drums ' + conf + '%' };
    let role = 'drum_kit';
    if (f.sub + f.low > 0.55 && f.centroid < 700) role = 'drum_kick';
    else if (f.high > 0.45 && f.centroid > 4500 && f.onsetRate > 3) role = 'drum_hihat';
    else if (f.high > 0.35 && f.dynamics < 2.2) role = 'drum_overheads';
    else if (f.lowMid + f.mid > 0.5 && f.centroid > 1200 && f.centroid < 4000 && f.onsetRate < 4.5) role = 'drum_snare';
    else if (f.low + f.lowMid > 0.5 && f.clarity > 0.4 && f.onsetRate < 2.5) role = 'drum_toms';
    else if (f.dynamics < 1.8 && f.activeRatio > 0.8) role = 'drum_room';
    return { role, why: `drums ${conf}% · centroid ${Math.round(f.centroid)} Hz` };
  }
  if (res.instrument === 'bass') return { role: f.flatness > 0.12 ? 'bass_amp' : 'bass_di', why: `bass ${conf}%` };
  if (res.instrument === 'guitar') return { role: f.flatness > 0.3 ? 'gtr_death' : f.flatness > 0.2 ? 'gtr_highgain' : f.flatness > 0.12 ? 'gtr_crunch' : (f.high > 0.2 ? 'gtr_acoustic' : 'gtr_clean'), why: `guitar ${conf}%` };
  if (res.instrument === 'vocals') return { role: /bv|back|choir|harm/i.test(t.name) ? 'vox_backing' : 'vox_lead', why: `vocals ${conf}%` };
  if (res.instrument === 'keys') return { role: 'keys', why: `keys ${conf}%` };
  return { role: 'other', why: `unsure (${conf}%)` };
}
async function detectTrack(t, applyNow) {
  await engine.resume();
  const s = suggestRole(t, t.fromBar || 1);
  if (applyNow && s.role !== 'other') { change('Detect instrument', () => applyRole(t, s.role, 'auto')); renderAll(); toast(`"${t.name}" → ${ROLES[s.role].label} (${s.why}). Change it any time.`, 3500); }
  else if (applyNow) toast(`"${t.name}": ${s.why}`);
  return s;
}
function applyRole(t, role, source) {
  const R = ROLES[role]; if (!R || !R.instrument) return;
  t.role = role; t.roleSource = source; t.instrument = R.instrument; t.instrumentSource = source === 'auto' ? 'auto' : 'manual';
  if (t.kind === 'midi' && R.instrument === 'drums') { applyPreset(t, 'drums', 'Punchy Bus'); return; }
  const presets = PRESETS[R.instrument] || PRESETS.other;
  applyPreset(t, R.instrument, presets[R.preset] ? R.preset : defaultPresetName(R.instrument));
}
function gainStage(t) {
  const bufs = trackBuffers(t, Math.max(0, ((t.fromBar || 1) - 1) * engine.barDur)); if (!bufs.length) return;
  let s = 0, n = 0;
  for (const b of bufs) for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i += 4) { const v = d[i]; if (Math.abs(v) > 0.003) { s += v * v; n++; } } }
  if (n) { const rms = 10 * Math.log10(s / n + 1e-12); t.volume = Math.max(-18, Math.min(6, Math.round((TARGET_RMS[t.instrument || 'other'] - rms) * 2) / 2 * 0.5)); engine.syncTrack(t); }
}
const BASIC_DOWN = { drum_kick: 'drum_kit', drum_snare: 'drum_kit', drum_hihat: 'drum_kit', drum_toms: 'drum_kit', drum_overheads: 'drum_kit', drum_room: 'drum_kit', bass_amp: 'bass_di', gtr_death: 'gtr_highgain', gtr_acoustic: 'gtr_clean', vox_backing: 'vox_lead' };
const tierRole = (r) => (allowed('automix.full') ? r : BASIC_DOWN[r] || r);
function roleSelect(value) {
  const sel = h('select', { class: 'role-sel', 'aria-label': 'Role' });
  const groups = {};
  for (const [k, r] of Object.entries(ROLES)) { if (!allowed('automix.full') && !BASIC_ROLES.includes(k)) continue; if (k === 'auto') { sel.append(h('option', { value: k }, r.label)); continue; } (groups[r.group] = groups[r.group] || h('optgroup', { label: r.group })).append(h('option', { value: k }, r.label)); }
  Object.values(groups).forEach((g) => sel.append(g)); sel.value = tierRole(value || 'auto'); if (!sel.value) sel.value = 'auto';
  return sel;
}
function autoMixDialog() {
  if (!S.project.tracks.length) return toast('Add tracks first.');
  const rows = S.project.tracks.map((t) => {
    const sel = roleSelect(t.role && t.roleSource === 'manual' ? t.role : 'auto');
    const from = h('input', { type: 'number', min: 1, max: 999, value: t.fromBar || 1, class: 'from-bar', title: 'Analyse from this bar (skip count-ins, silence or a different intro)', 'aria-label': 'From bar' });
    const sug = h('span', { class: 'sug hint' }, '…');
    if (!allowed('automix.full')) from.disabled = true;
    const doSuggest = () => { const s = suggestRole(t, +from.value || 1); s.role = tierRole(s.role); sug.textContent = '→ ' + ROLES[s.role].label + ' (' + s.why + ')'; sug.dataset.role = s.role; };
    const row = h('div', { class: 'am-row', style: { '--c': t.color } }, h('span', { class: 'am-name' }, t.name), sel, h('label', { class: 'am-from adv' }, 'from bar ', from),
      h('button', { type: 'button', class: 'small', title: 'Suggest a role from the audio', onclick: doSuggest }, 'Suggest'), sug);
    return { t, sel, from, sug, doSuggest, row };
  });
  const content = h('div', { class: 'automix-setup' },
    h('p', { class: 'hint' }, 'Tell Auto-Mix what each track is. “Auto” uses the suggestion (a heuristic — check it); any role you pick always wins. Apply sets EQ/compression/effects presets and rough levels. Everything stays editable and undoable.'),
    ...rows.map((r) => r.row),
    allowed('automix.full') ? null : h('p', { class: 'hint' }, lockBadge('automix.full'), ' Basic Auto-Mix: main instrument roles. Full Auto-Mix (drum pieces, amp/acoustic/backing variants, “from bar”) and pitch correction in vocal presets are in the Mid tier.'));
  const dlg = openDialog('Auto-Mix setup', content, [
    { label: 'Suggest all', type: 'button', fn: async (e) => { e.preventDefault(); for (const r of rows) { r.sug.textContent = 'analysing…'; await new Promise((res) => setTimeout(res, 0)); r.doSuggest(); } } },
    { label: 'Cancel', value: 'cancel' },
    { label: 'Apply', value: 'apply', primary: true },
  ], 'automix-dlg');
  setTimeout(async () => { for (const r of rows) { await new Promise((res) => setTimeout(res, 0)); if (dlg.open) r.doSuggest(); } }, 50);
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'apply') return;
    history.push('Auto-Mix');
    const summary = [];
    for (const r of rows) {
      const t = r.t; t.fromBar = Math.max(1, Math.min(999, +r.from.value || 1));
      let role = r.sel.value, src = 'manual';
      if (role === 'auto') { role = tierRole(r.sug.dataset.role || suggestRole(t, t.fromBar).role); src = 'auto'; }
      if (t.kind === 'group') { summary.push(`${t.name}: group (skipped)`); continue; }
      applyRole(t, role, src); gainStage(t);
      summary.push(`${t.name}: ${ROLES[role].label}${src === 'auto' ? ' (auto)' : ''}`);
    }
    renderAll(); markDirty();
    toast('Auto-Mix applied — ' + summary.join(' · '), 5000);
  }, { once: true });
}

// ------------------------------------------------------------------ quantize (audio: transient cut-and-shift, MIDI: notes)
function quantizeDialog() {
  const sc = selectedClip(); if (!sc || !sc.c) return toast('Select a clip first.');
  const { t, c } = sc;
  const grid = h('select', {}, [['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/8T', 1 / 3]].map(([l, v]) => h('option', { value: v }, l))); grid.value = '0.5';
  const str = h('input', { type: 'range', min: 0, max: 100, value: 75 }); const strL = h('span', {}, '75%'); str.addEventListener('input', () => (strL.textContent = str.value + '%'));
  const sens = h('input', { type: 'range', min: 1, max: 4, step: 0.1, value: 1.6 });
  const content = h('div', { class: 'settings' }, h('label', {}, 'Grid ', grid), h('label', {}, 'Strength ', str, strL),
    c.type === 'midi' ? null : h('label', {}, 'Transient sensitivity ', sens),
    h('p', { class: 'hint' }, c.type === 'midi' ? 'Moves note starts toward the grid.' : 'Detects hits (transients) and moves each slice toward the grid, with short crossfades. Works best on drums and percussive parts; sustained notes can get small artefacts. Undo restores the original.'));
  const dlg = openDialog('Quantize ' + (c.name || 'clip'), content, [{ label: 'Cancel', value: 'cancel' }, { label: 'Quantize', value: 'ok', primary: true }]);
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const g = +grid.value, s = +str.value / 100;
    if (c.type === 'midi') {
      change('Quantize notes', () => { c.notes.forEach((n) => { const q = Math.round(n.t / g) * g; n.t = Math.max(0, n.t + (q - n.t) * s); }); if (S.sel.kind === 'arr') engine.rescheduleTrack(t); });
      toast('Quantized ' + c.notes.length + ' notes'); renderAll(); return;
    }
    const buf = engine.buffers.get(c.bufferId); if (!buf) return;
    const isArr = S.sel.kind === 'arr';
    const res = quantizeBuffer(engine.ctx, buf, { clipStartSec: isArr ? c.start : 0, offsetSec: isArr ? c.offset || 0 : 0, gridSec: g * engine.beatDur, strength: s, sensitivity: +sens.value });
    if (!res.moved) return toast(`No hits needed moving (${res.onsets.length} transients found).`);
    change('Quantize audio', () => { c.bufferId = addBuffer(res.buffer); if (isArr) engine.rescheduleTrack(t); });
    toast(`Quantized: moved ${res.moved} of ${res.onsets.length} hits.`); renderAll();
  }, { once: true });
}

// ------------------------------------------------------------------ menus & dialogs
async function audioSettings() {
  await engine.resume();
  S.devices = await engine.listDevices();
  const ctx = engine.ctx;
  const needPerm = !S.devices.inputs.some((d) => d.label);
  const outSel = h('select', { disabled: !Engine.outputSelectionSupported(), onchange: async (e) => { try { await engine.setOutputDevice(e.target.value); toast('Output device changed'); } catch (err) { toast(err.message); } } },
    h('option', { value: 'default' }, 'System default'), S.devices.outputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => h('option', { value: d.deviceId }, d.label || 'Output')));
  const lat = h('input', { type: 'number', value: engine.latencyOffsetMs, step: 1, min: -200, max: 500, onchange: (e) => { engine.latencyOffsetMs = +e.target.value || 0; localStorage.setItem('latOffset', engine.latencyOffsetMs); } });
  const content = h('div', { class: 'settings' },
    h('p', {}, `Sample rate: ${ctx.sampleRate} Hz · base latency: ${((ctx.baseLatency || 0) * 1000).toFixed(1)} ms · output latency: ${((ctx.outputLatency || 0) * 1000).toFixed(1)} ms · state: ${ctx.state} · DSP: ${engine.workletOK ? 'AudioWorklet' : 'ScriptProcessor fallback'}`),
    h('label', {}, 'Output device ', outSel, Engine.outputSelectionSupported() ? '' : h('small', {}, ' (not supported in this browser — uses system output)')),
    h('p', {}, `Inputs detected: ${S.devices.inputs.length} `, needPerm ? h('button', { type: 'button', onclick: async () => { try { await engine.requestMicPermission(); closeDialog(); audioSettings(); renderAll(); } catch (e) { toast('Permission denied: ' + e.message); } } }, 'Allow microphone to list inputs') : ''),
    h('ul', { class: 'dev-list' }, S.devices.inputs.map((d) => h('li', {}, d.label || '(unnamed input)'))),
    h('label', {}, 'Extra record latency compensation (ms) ', lat),
    h('p', {}, 'MIDI: ' + (MIDI.supported ? (MIDI.access ? `${MIDI.inputs().length} input(s): ${MIDI.inputs().map((i) => i.name).join(', ') || '—'}` : 'available (connects when you arm a MIDI track)') : MIDI.notice())),
    h('p', { class: 'hint' }, 'Choose input device and channel per track in the session mixer strip. Use headphones when monitoring.'));
  openDialog('Audio & MIDI settings', content);
}
async function projectsDialog() {
  const list = await DB.listProjects();
  const content = h('div', { class: 'proj-list' }, list.length ? list.map((p) => h('div', { class: 'proj-row' + (p.id === S.project.id ? ' current' : '') },
    h('span', {}, `${p.name} · ${p.tracks} tracks · ${new Date(p.modified).toLocaleString()}`),
    h('button', { type: 'button', onclick: async () => { await saveNow(); const r = await DB.loadProject(p.id, engine.ctx); closeDialog(); if (r) loadProjectData(r.project, r.buffers); } }, 'Open'),
    p.id !== S.project.id ? h('button', { type: 'button', onclick: async () => { if (confirm('Delete project "' + p.name + '"?')) { await DB.deleteProject(p.id); closeDialog(); projectsDialog(); } } }, 'Delete') : '')) : 'No saved projects.');
  openDialog('Projects (stored in this browser)', content);
}
async function shareOrDownload(blob, name, type) {
  const file = typeof File !== 'undefined' ? new File([blob], name, { type }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: S.project.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
  toast(`Exported ${name} (${(blob.size / 1048576).toFixed(1)} MB)`);
}
const baseName = () => (S.project.name || 'project').replace(/[^\w\- ]+/g, '_');
async function exportProject() { await saveNow(); await shareOrDownload(exportProjectZip(S.project, engine.buffers), baseName() + '.webdaw.zip', 'application/zip'); }
async function exportEncrypted() {
  if (!cryptoAvailable()) return toast('Encryption needs a secure (https) context.');
  const pw = await askPassword('Export encrypted', true); if (pw == null) return;
  if (pw.length < 6) return toast('Use at least 6 characters.');
  await saveNow(); toast('Encrypting…', 1200);
  const bytes = new Uint8Array(await exportProjectZip(S.project, engine.buffers).arrayBuffer());
  const enc = await encryptBytes(bytes, pw);
  await shareOrDownload(new Blob([enc], { type: 'application/octet-stream' }), baseName() + '.webdaw.enc', 'application/octet-stream');
}
async function importProject(file) {
  try {
    if (file.size > 1024 * 1024 * 1024 + 64) throw new Error('file too large');
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (isEncrypted(bytes)) {
      const pw = await askPassword('Encrypted project — password'); if (pw == null) return;
      try { bytes = await decryptBytes(bytes, pw); } catch (e) { return toast('Wrong password or damaged file.', 4000); }
    }
    const { project, buffers } = await importProjectFile(bytes, engine.ctx);
    await saveNow();
    await loadProjectData(project, buffers);
    await saveNow();
    toast(`Imported project "${project.name}" (${project.tracks.length} tracks)`);
  } catch (e) { console.warn(e); toast('Import rejected: ' + e.message, 5000); }
}
function prefsDialog() {
  const chk = (key, label, help, after) => h('label', { class: 'chk', title: help }, h('input', { type: 'checkbox', checked: !!prefs[key], onchange: (e) => { prefs[key] = e.target.checked; savePrefs(); applyPrefs(); after && after(); } }), ' ' + label);
  const thr = h('input', { type: 'number', min: -70, max: -6, step: 1, value: prefs.autoRecThreshold, onchange: (e) => { prefs.autoRecThreshold = Math.max(-70, Math.min(-6, +e.target.value || -40)); savePrefs(); } });
  const pre = h('input', { type: 'number', min: 0, max: 5, step: 0.25, value: prefs.autoRecPreroll, onchange: (e) => { prefs.autoRecPreroll = Math.max(0, Math.min(5, +e.target.value || 0)); savePrefs(); } });
  const pinRow = h('div', { class: 'pin-row' });
  const renderPin = () => {
    pinRow.innerHTML = '';
    if (!cryptoAvailable()) { pinRow.append(h('p', { class: 'hint' }, 'PIN lock needs a secure (https) context.')); return; }
    if (pinIsSet()) pinRow.append(h('span', {}, 'PIN lock is ON '), h('button', { type: 'button', onclick: async () => { const p = prompt('Current PIN'); if (p && await verifyPin(p)) { clearPin(); toast('PIN removed'); renderPin(); } else if (p) toast('Wrong PIN'); } }, 'Remove PIN'));
    else pinRow.append(h('button', { type: 'button', onclick: async () => { const p = prompt('New PIN (4–8 digits)'); if (!p) return; if (prompt('Repeat PIN') !== p) return toast('PINs do not match'); try { await setPin(p); toast('PIN set'); renderPin(); } catch (e) { toast(e.message); } } }, 'Set PIN…'));
    pinRow.append(h('p', { class: 'hint' }, 'Casual lock only: it stops someone casually opening the app on this device. It does NOT encrypt your projects, which stay readable in browser storage. Use “Export encrypted…” to protect files.'));
  };
  renderPin();
  openDialog('Preferences', h('div', { class: 'settings' },
    chk('easy', 'Easy Mode (fewer controls, bigger labels)', 'Hides advanced controls and enlarges text and touch targets'),
    chk('hc', 'High contrast', 'Stronger colours and outlines'),
    chk('haptics', 'Haptic feedback (vibration)', 'Vibrates on knob detents and button presses where supported (not on iPhone/iPad Safari)'),
    h('fieldset', {}, h('legend', {}, 'Auto-record when sound starts (AUTO button)'), h('label', {}, 'Threshold (dBFS) ', thr), h('label', {}, 'Pre-roll (s) ', pre)),
    h('fieldset', {}, h('legend', {}, 'PIN lock'), pinRow),
    h('fieldset', { class: 'tier-set' }, h('legend', {}, 'Tier (placeholder)'),
      h('select', { id: 'tierSel', onchange: (e) => { setTier(e.target.value); toast('Tier: ' + TIER_LABELS[e.target.value]); } }, TIERS.map((x) => h('option', { value: x, selected: x === getTier() }, TIER_LABELS[x]))),
      h('p', { class: 'hint' }, 'Placeholder only — no payments, accounts or licence checks. Every tier can be switched to freely for testing. Features above your tier show a 🔒 badge; existing projects keep playing.')),
    h('button', { type: 'button', onclick: () => { closeDialog(); prefs.guideDone = false; savePrefs(); showGuide(); } }, 'Show the quick guide again')));
}
function applyPrefs() {
  document.body.classList.toggle('easy', !!prefs.easy);
  document.body.classList.toggle('hc', !!prefs.hc);
  $$('#btnEasy').forEach((b) => b.classList.toggle('on', !!prefs.easy));
}
function toggleEasy() { prefs.easy = !prefs.easy; savePrefs(); applyPrefs(); toast(prefs.easy ? 'Easy Mode on: main controls only' : 'Easy Mode off: all controls', 1500); }
let helpMode = false;
function toggleHelp() {
  helpMode = !helpMode; document.body.classList.toggle('helpmode', helpMode); $('#btnHelp').classList.toggle('on', helpMode);
  if (helpMode) toast('Help mode: tap anything to see what it does. Tap ? again to exit.', 3000);
}
document.addEventListener('click', (e) => {
  if (!helpMode || e.target.closest('#btnHelp')) return;
  const el = e.target.closest('[title], [data-help], [aria-label]'); if (!el) return;
  e.preventDefault(); e.stopPropagation(); showHelpBubble(el, e.clientX, e.clientY);
}, true);
const GUIDE = [
  ['Welcome to WebDAW', 'A compact studio in your browser. This 5-step guide shows the basics. You can replay it from ☰ → Preferences.'],
  ['Record', 'Tap ● on a track to arm it (the browser asks for the microphone). The small light shows input signal. Tap an empty slot to record a loop, or the top ● for the timeline. AUTO starts recording when you begin playing.'],
  ['Play instruments', 'Add “+ Synth” or “+ Drums” tracks. Play with the on-screen keys/pads or a MIDI keyboard; double-tap a MIDI clip to edit notes.'],
  ['Mix', 'Tap Auto-Mix to tell the app what each track is — it sets EQ, compression and effects. Effects are small cards; tap ▾ to expand. Everything can be changed while playing and undone (↶).'],
  ['Help', 'Tap ? then any control for an explanation. “Easy” shows fewer, bigger controls. Your work saves automatically in this browser.'],
];
function showGuide(step = 0) {
  $$('.guide').forEach((g) => g.remove());
  if (step >= GUIDE.length) { prefs.guideDone = true; savePrefs(); return; }
  const [title, text] = GUIDE[step];
  const g = h('div', { class: 'guide', role: 'dialog', 'aria-label': title },
    h('div', { class: 'guide-card' }, h('div', { class: 'guide-step' }, `${step + 1} / ${GUIDE.length}`), h('h3', {}, title), h('p', {}, text),
      h('div', { class: 'dlg-btns' }, h('button', { onclick: () => { prefs.guideDone = true; savePrefs(); g.remove(); } }, 'Skip'), h('button', { class: 'primary', onclick: () => showGuide(step + 1) }, step === GUIDE.length - 1 ? 'Done' : 'Next'))));
  document.body.append(g);
}
function menuActions() {
  const items = [
    ['New project', () => { if (confirm('Start a new project? (current one stays saved in this browser)')) saveNow().then(() => newProjectFlow()); }],
    ['Projects…', projectsDialog],
    ['Rename project…', () => { const n = prompt('Project name', S.project.name); if (n) change('Rename project', () => { S.project.name = n.slice(0, 64); $('#projName').textContent = S.project.name; }); }],
    ['Save now', () => saveNow().then(() => toast('Saved to this browser'))],
    ['Export project (.zip)', exportProject],
    ['Export encrypted…', exportEncrypted],
    ['Import project…', () => $('#fileProject').click()],
    ['-'],
    ['Import audio files as tracks…', () => $('#fileAudio').click()],
    ['Visualizer (full screen)', () => openVisualizer(engine.ctx, engine.master.out)],
    ['Audio & MIDI settings…', audioSettings],
    ['Preferences…', prefsDialog],
    ['-'],
    ['Install app', installApp],
    ['About', () => openDialog('About WebDAW', h('div', {}, h('p', {}, 'WebDAW v0.2 — a browser DAW built on the Web Audio API. Works offline once loaded; makes no network requests besides loading itself. Projects are saved in this browser (IndexedDB); use Export/Import to move them.'),
      h('p', { class: 'hint' }, 'Shortcuts: Space play/stop · R record · M metronome · Tab switch view · Ctrl/⌘+Z undo · Ctrl/⌘+Shift+Z or Ctrl+Y redo · Ctrl/⌘+C/V/D copy/paste/duplicate · Delete remove clip · S split.')))],
  ];
  const m = $('#menu'); m.innerHTML = '';
  for (const [label, fn] of items) m.append(label === '-' ? h('hr') : h('button', { onclick: () => { closeMenus(); fn(); } }, label));
}
async function installApp() {
  if (S.deferredInstall) { S.deferredInstall.prompt(); S.deferredInstall = null; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openDialog('Install', h('p', {}, ios ? 'In Safari tap the Share button, then “Add to Home Screen”.' : 'Use your browser menu → “Install app” / “Add to Home screen”.'));
}

// ------------------------------------------------------------------ render loop
function renderAll() {
  if (!S.project) return;
  $('#sessionView').hidden = S.view !== 'session';
  $('#arrangeView').hidden = S.view !== 'arrange';
  $$('.views button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  renderSession(); renderArrange(); renderDevices(); updateTransportUI(); updateKeyButton();
}
const meterState = new WeakMap();
function drawMeter(cv, id) {
  const m = engine.meters.get(id) || { peak: [0, 0] };
  let st = meterState.get(cv); if (!st) { st = { v: [0, 0], hold: [0, 0], ht: [0, 0] }; meterState.set(cv, st); }
  const horiz = cv.classList.contains('h');
  const w = Math.round(cv.clientWidth * devicePixelRatio), hh = Math.round(cv.clientHeight * devicePixelRatio); if (!w || !hh) return;
  if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
  const g = cv.getContext('2d'); g.clearRect(0, 0, w, hh); g.fillStyle = '#0e0f11'; g.fillRect(0, 0, w, hh);
  let grad = cv._grad;
  if (!grad || cv._gw !== w || cv._gh !== hh) { grad = horiz ? g.createLinearGradient(0, 0, w, 0) : g.createLinearGradient(0, hh, 0, 0); grad.addColorStop(0, '#2fb57a'); grad.addColorStop(0.7, '#3ecf8e'); grad.addColorStop(0.86, '#f2d33a'); grad.addColorStop(1, '#ff4d4d'); cv._grad = grad; cv._gw = w; cv._gh = hh; }
  const now = performance.now();
  for (let c = 0; c < 2; c++) {
    const p = m.peak[c] || 0; st.v[c] = Math.max(p, st.v[c] * 0.88); // smooth fall
    const n = Math.max(0, Math.min(1, (20 * Math.log10(st.v[c] + 1e-9) + 60) / 66));
    if (n >= st.hold[c] || now - st.ht[c] > 1200) { st.hold[c] = n; st.ht[c] = now; }
    g.fillStyle = grad;
    if (horiz) { g.fillRect(0, c * hh / 2, n * w, hh / 2 - 1); g.fillStyle = '#fff9'; g.fillRect(st.hold[c] * w - 1, c * hh / 2, 1.5, hh / 2 - 1); }
    else { g.fillRect(c * w / 2, hh * (1 - n), w / 2 - 1, hh * n); g.fillStyle = '#fff9'; g.fillRect(c * w / 2, hh * (1 - st.hold[c]), w / 2 - 1, 1.5); }
  }
}
let lastOv = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!S.project || document.hidden) return;
  engine.pollMeters();
  const pos = engine.position();
  $('#posDisplay').textContent = fmtPos(pos);
  $$('canvas[data-meter]').forEach((cv) => { if (cv.offsetParent) drawMeter(cv, cv.dataset.meter); });
  drawMeter($('#masterMeterTop'), 'master');
  // input signal LEDs
  $$('.sig[data-sig]').forEach((el) => {
    const n = engine.tracks.get(el.dataset.sig); const db = n && n.inputChain ? n.inputLevel || -100 : -100;
    el.dataset.lv = db > -1 ? 'clip' : db > -12 ? 'hot' : db > -50 ? 'on' : '';
  });
  if (S.view === 'arrange') {
    const ph = $('#arrangeView .playhead'); if (ph) ph.style.transform = `translateX(${pos * S.zoom}px)`;
    const sc = $('#arrangeView .arr-scroll');
    if (sc && S.follow && engine.playing) { const x = pos * S.zoom; if (x > sc.scrollLeft + sc.clientWidth * 0.8 || x < sc.scrollLeft) sc.scrollLeft = x - sc.clientWidth * 0.2; }
    if (engine.playing && ts - lastOv > 250) { lastOv = ts; drawOverview(); }
  }
  if (S.view === 'session' && engine.playing) {
    for (const [id, n] of engine.tracks) {
      if (n.sessionSlot == null || n.sessionSlot < 0) continue;
      const el = $(`#sessionView .col[data-id="${id}"] .slot[data-slot="${n.sessionSlot}"] .prog`); if (!el) continue;
      let L, t0;
      if (n.sessionSource) { L = n.sessionSource.loopEnd || n.sessionSource.buffer.duration; t0 = n.sessionStart; }
      else if (n.sessionMidi) { L = n.sessionMidi.clip.lengthBeats * engine.beatDur; t0 = n.sessionMidi.start; }
      else continue;
      const t = engine.ctx.currentTime - t0; el.style.transform = `scaleX(${t > 0 ? (t % L) / L : 0})`;
    }
  }
  const rec = engine.recording || S.slotRec.size || [...engine.tracks.values()].some((n) => n.rec);
  document.body.classList.toggle('is-recording', !!rec);
}

// ------------------------------------------------------------------ boot
function bindUI() {
  $('#btnPlay').addEventListener('click', () => { haptic(10); togglePlay(); });
  $('#btnStop').addEventListener('click', () => { haptic(10); engine.stop(); });
  $('#btnRec').addEventListener('click', () => { haptic(14); toggleRecord(); });
  $('#btnAutoRec').addEventListener('click', () => { haptic(10); toggleAutoRecord(); });
  $('#btnMetro').addEventListener('click', () => { engine.metronome = !engine.metronome; engine.nextClick = null; updateTransportUI(); });
  $('#btnUndo').addEventListener('click', undo); $('#btnRedo').addEventListener('click', redo);
  $('#btnEasy').addEventListener('click', toggleEasy);
  $('#btnHelp').addEventListener('click', toggleHelp);
  $('#btnAutoMix').addEventListener('click', () => autoMixDialog());
  $('#bpm').addEventListener('change', (e) => {
    const v = Math.max(40, Math.min(300, +e.target.value || 120)); e.target.value = v;
    change('Tempo', () => { S.project.bpm = v; engine.updateBpmFx(); }); renderArrange();
  });
  $$('.views button').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.view; renderAll(); }));
  $('#btnMenu').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#menu'); const open = !m.classList.contains('open'); closeMenus(); if (open) { m.classList.add('open'); setTimeout(() => document.addEventListener('pointerdown', (ev) => { if (!ev.target.closest('#menu')) closeMenus(); }, { once: true }), 0); } });
  $('#fileProject').addEventListener('change', (e) => { if (e.target.files[0]) importProject(e.target.files[0]); e.target.value = ''; });
  $('#fileAudio').addEventListener('change', (e) => { if (e.target.files.length) importAudioFiles([...e.target.files]); e.target.value = ''; });
  document.addEventListener('keydown', (e) => {
    if (!S.project || e.target.closest('input, select, textarea') || $('#dlg').open || $('.pianoroll')) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod) {
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'c') { e.preventDefault(); clipOp('copy'); }
      else if (k === 'v') { e.preventDefault(); clipOp('paste'); }
      else if (k === 'd') { e.preventDefault(); clipOp('dup'); }
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 'r') toggleRecord();
    else if (k === 'm') $('#btnMetro').click();
    else if (k === 's') clipOp('split');
    else if (e.key === 'Tab') { e.preventDefault(); S.view = S.view === 'session' ? 'arrange' : 'session'; renderAll(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel) { e.preventDefault(); clipOp('del'); } }
    else if (e.key === 'Escape') { closeMenus(); if (helpMode) toggleHelp(); }
  });
  // drag & drop outside the arrangement: projects or audio as new tracks
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault(); if (!engine.ctx || !S.project) return;
    const files = [...e.dataTransfer.files];
    const proj = files.find((f) => /\.(zip|webdaw|json|enc)$/i.test(f.name));
    if (proj) importProject(proj); else if (files.length) importAudioFiles(files);
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.deferredInstall = e; });
  window.addEventListener('pagehide', () => { if (S.project) saveNow(); });
  navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', async () => { S.devices = await engine.listDevices(); renderSession(); });
  menuActions(); applyPrefs();
}
// casual PIN lock (not encryption) shown before anything else
function lockScreen() {
  return new Promise((resolve) => {
    const ov = $('#lockOverlay'); ov.hidden = false;
    const inp = $('#pinInput'), msg = $('#pinMsg'); let fails = 0, until = 0;
    const tryIt = async () => {
      if (Date.now() < until) { msg.textContent = `Wait ${Math.ceil((until - Date.now()) / 1000)} s`; return; }
      if (await verifyPin(inp.value)) { ov.hidden = true; resolve(); return; }
      fails++; inp.value = ''; haptic(40);
      if (fails >= 3) until = Date.now() + Math.min(60000, 2000 * 2 ** (fails - 3));
      msg.textContent = 'Wrong PIN' + (fails >= 3 ? ` — wait ${Math.round((until - Date.now()) / 1000)} s` : '');
    };
    $('#pinBtn').addEventListener('click', tryIt);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryIt(); });
    setTimeout(() => inp.focus(), 50);
  });
}
async function start() {
  $('#startBtn').disabled = true;
  try { await engine.init(); await engine.resume(); }
  catch (e) { $('#startMsg').textContent = 'Audio could not start: ' + e.message; $('#startBtn').disabled = false; return; }
  engine.latencyOffsetMs = +localStorage.getItem('latOffset') || 0;
  S.devices = await engine.listDevices().catch(() => ({ inputs: [], outputs: [] }));
  let loaded = null;
  try { const id = await DB.lastProjectId(); if (id) loaded = await DB.loadProject(id, engine.ctx); } catch (e) { console.warn('IndexedDB load failed', e); }
  if (loaded) {
    try { const v = validateProject(loaded.project); loaded.project = v.project; } catch (e) { console.warn('stored project failed validation, starting new', e); loaded = null; }
  }
  if (loaded) await loadProjectData(loaded.project, loaded.buffers); else await newProjectFlow(2);
  $('#startOverlay').remove();
  requestAnimationFrame(frame);
  if (engine.ctx.state !== 'running') toast('Audio is suspended by the browser — tap anywhere to resume.', 5000);
  if (!prefs.guideDone) showGuide();
}

bindUI();
['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (engine.ctx && engine.ctx.state !== 'running') engine.resume(); }, { passive: true }));
$('#startBtn').addEventListener('click', start);
(async () => { if (pinIsSet()) { $('#startOverlay').hidden = true; await lockScreen(); $('#startOverlay').hidden = false; } })();
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !location.search.includes('nosw')) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
}
