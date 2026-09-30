import './storage-migrate.js';
// Auduio v0.3.1 — UI controller.
import { Engine } from './audio/engine.js';
import { EFFECT_TYPES, EASY_PARAMS, EFFECT_HELP, PARAM_HELP } from './audio/effects.js';
import { INSTRUMENT_TYPES, PAD_ORDER, wavetableFrame } from './audio/instruments.js';
import { allowed, requiredTier, getTier, setTier, TIERS, TIER_LABELS, BASIC_ROLES, onTierChange } from './tiers.js';
import { analyzeBuffers, extractFeatures } from './audio/detect.js';
import { PRESETS, INSTRUMENTS, INSTRUMENT_LABELS, ROLES, defaultPresetName } from './audio/presets.js';
import { SCALES, NOTE_NAMES, noteName } from './audio/pitchdsp.js';
import { chromaFromBuffer, chromaFromNotes, detectKey } from './audio/keydetect.js';
import { detectTransients, quantizeBuffer } from './audio/timecorrect.js';
import { TapTempo, detectBufferTempo, mixToMono } from './audio/tempo.js';
import { drawWaveform, LivePeaks, drawScope as drawScopeLine } from './ui/waveform.js';
import { createPhone, wantsPhone } from './ui/phone.js';
import { createTutorial } from './ui/tutorial.js';
import { icon, setIcon } from './ui/icons.js';
import { BANDS } from './audio/adaptive.js';
import { newProject, newTrack, DB, exportProjectZip, importProjectFile, uid, TRACK_COLORS, encodeWav } from './project.js';
import { createKnob, createFader, fromNorm, fmt as fmtParam } from './ui/controls.js';
import { h, $, $$, toast, prefs, savePrefs, haptic } from './ui/dom.js';
import { tap, addViz, drawSpectrum, drawCurve, drawScope, drawHistory, drawPitch, openVisualizer } from './ui/viz.js';
import { openPianoRoll } from './ui/pianoroll.js';
import { History } from './history.js';
import { validateProject, validateRack } from './validate.js';
import { MIDI, createMidiOut, engineMidi } from './midi.js';
import { createCompKeys } from './ui/compkeys.js';
import { createSeqView } from './ui/seqview.js';
import { createDrumRack } from './ui/drumrack.js';
import { lockKey } from './audio/sequencer.js';
import { splitClip, splitAllAt, splitAtRange, deleteSection } from './clipedit.js';
import { MIDI_FX_TYPES, MIDI_FX_HELP, midiFxDefaults } from './audio/midifx.js';
import { randomizeValues } from './randomize.js';
import { createBrowser } from './ui/browser.js';
import { pluginSupport } from './plugins/host.js';
import { createPluginApi, pluginCard } from './plugins/native.js';
import { cryptoAvailable, pinIsSet, setPin, clearPin, verifyPin, isEncrypted, encryptBytes, decryptBytes } from './security.js';

export const engine = new Engine();
const S = { project: null, selected: null, view: 'session', zoom: 40, sel: null, clipboard: null, deferredInstall: null,
  devices: { inputs: [], outputs: [] }, follow: false, expanded: new Set(), learn: { active: false, target: null }, slotRec: new Map(), midiRec: null };
const history = new History(() => JSON.stringify(S.project), (snap) => restoreSnapshot(snap));
window.__daw = { engine, S, history, MIDI }; // debugging / automated tests
let seqView = null, drumRack = null; // step sequencer view (ui/seqview.js), created after the phone UI helpers

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
  const beats = Math.max(0, pos - (S.project.gridOffset || 0)) / bd; return `${Math.floor(beats / bpb) + 1}.${Math.floor(beats % bpb) + 1}.${Math.floor((beats % 1) * 4) + 1}`;
};
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
const keyName = (k) => `${NOTE_NAMES[k.root]} ${k.scale}`;
function change(label, fn, coalesce) { history.push(label, coalesce); fn(); markDirty(); }
// ---- feature tiers (placeholder, local setting only)
const tierShort = (f) => TIER_LABELS[requiredTier(f)].split(' ')[0];
function lockBadge(feature) { return allowed(feature) ? null : h('span', { class: 'lock', title: `${TIER_LABELS[requiredTier(feature)]} feature — tiers are a local placeholder setting (Preferences)` }, icon('lock'), ' ' + tierShort(feature)); }
function gate(feature, what) {
  if (allowed(feature)) return true;
  const need = requiredTier(feature);
  const dlg = openDialog(what + ' (locked)', h('div', {}, h('p', {}, `${what} is part of the ${TIER_LABELS[need]} tier. Current tier: ${TIER_LABELS[getTier()]}.`),
    h('p', { class: 'hint' }, 'Tiers are a placeholder: there are no payments, accounts or licence checks yet. For testing you can switch tier freely (also in Menu → Preferences).')),
    [{ label: 'Cancel', value: 'cancel' }, { label: `Switch to ${TIER_LABELS[need]} (testing)`, value: 'switch', primary: true }]);
  dlg.addEventListener('close', () => { if (dlg.returnValue === 'switch') { setTier(need); toast('Tier: ' + TIER_LABELS[need] + ' — try again'); } }, { once: true });
  return false;
}
onTierChange(() => { if (S.project) renderAll(); if (browser) browser.render(); });

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

// Arrangement clip waveform: only the visible part of the clip is drawn, at full resolution for the
// current zoom (peak mipmaps make this cheap), so waveforms stay sharp at any zoom level.
const dbToGain = (db) => Math.pow(10, (db || 0) / 20);
function drawArrClip(el) {
  const c = el._clip, t = el._track; if (!c || c.type === 'midi' || !el.isConnected) return;
  const cv = el.querySelector('canvas'); const sc = el.closest('.arr-scroll'); if (!cv || !sc) return;
  const clipL = c.start * S.zoom, clipW = Math.max(4, c.duration * S.zoom);
  const visL = Math.max(0, sc.scrollLeft - 200 - clipL), visR = Math.min(clipW, sc.scrollLeft + sc.clientWidth + 200 - clipL);
  if (visR <= visL) { cv.style.width = '0px'; return; }
  cv.style.left = visL + 'px'; cv.style.width = (visR - visL) + 'px';
  const rate = Math.pow(2, (c.transpose || 0) / 12);
  const a = (c.offset || 0) + (visL / S.zoom) * rate, b = (c.offset || 0) + (visR / S.zoom) * rate;
  drawWaveform(cv, engine.buffers.get(c.bufferId), { startSec: a, endSec: b, color: t.color, gain: dbToGain(c.gain) });
  drawFades(cv, c, visL, visR);
  const fi = el.querySelector('.fh.fi'), fo = el.querySelector('.fh.fo');
  if (fi) fi.style.left = Math.min(clipW - 8, (c.fadeIn || 0) * S.zoom) + 'px';
  if (fo) fo.style.right = Math.min(clipW - 8, (c.fadeOut || 0) * S.zoom) + 'px';
}
// fade in / out shapes over the waveform (clip-relative px range visL..visR is what the canvas shows)
function drawFades(cv, c, visL, visR) {
  const fi = (c.fadeIn || 0) * S.zoom, fo = (c.fadeOut || 0) * S.zoom, W = c.duration * S.zoom; if (!fi && !fo) return;
  const g = cv.getContext('2d'), sx = cv.width / Math.max(1, visR - visL), H = cv.height, X = (x) => (x - visL) * sx;
  g.save(); g.fillStyle = 'rgba(0,0,0,.45)'; g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = Math.max(1, devicePixelRatio || 1);
  if (fi > 0) { g.beginPath(); g.moveTo(X(0), 0); g.lineTo(X(fi), 0); g.lineTo(X(0), H); g.closePath(); g.fill(); g.beginPath(); g.moveTo(X(0), H); g.lineTo(X(fi), 0); g.stroke(); }
  if (fo > 0) { g.beginPath(); g.moveTo(X(W), 0); g.lineTo(X(W - fo), 0); g.lineTo(X(W), H); g.closePath(); g.fill(); g.beginPath(); g.moveTo(X(W - fo), 0); g.lineTo(X(W), H); g.stroke(); }
  g.restore();
}
let clipRedrawPending = false;
function scheduleClipRedraw() { if (clipRedrawPending) return; clipRedrawPending = true; requestAnimationFrame(() => { clipRedrawPending = false; $$('#arrangeView .aclip').forEach((el) => { if (el._clip && el._clip.type !== 'midi') drawArrClip(el); }); }); }

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
// Touch: after a long-press (menu opens), moving the finger picks the clip up and drags it.
function touchDragOnHold(el, getSrc) {
  let armedAt = null, hx = 0, hy = 0;
  el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') return; armedAt = null; const pe = e; hx = e.clientX; hy = e.clientY;
    clearTimeout(el._holdT); el._holdT = setTimeout(() => { armedAt = pe; startClipDrag(getSrc(), pe, el, { onStart: () => closeMenus() }); }, 540); });
  const clear = () => clearTimeout(el._holdT);
  el.addEventListener('pointerup', clear); el.addEventListener('pointercancel', clear);
  el.addEventListener('pointermove', (e) => { if (!armedAt && e.pointerType === 'touch' && Math.hypot(e.clientX - hx, e.clientY - hy) > 10) clear(); });
  el.addEventListener('touchmove', (e) => { if (armedAt && e.cancelable) e.preventDefault(); }, { passive: false });
  el.addEventListener('touchend', () => { armedAt = null; });
}
const consumedLongPress = (el) => { if (el._longPressed) { el._longPressed = false; return true; } return false; };
// ---- About, privacy, licences
const APP_VERSION = '0.5.1';
const PRIVACY_NOTE = 'Auduio has no accounts, no analytics, no telemetry and no ads. It does not collect, track or send any personal data, projects or recordings. Projects and settings stay on your device (browser storage, or files you export yourself). Network use: the web version downloads the app itself; the desktop installer for Windows may download Microsoft\'s WebView2 runtime if it is missing. Microphone and MIDI devices are only used after you allow them, and only on your device.';
function aboutDialog() {
  openDialog('About Auduio', h('div', { class: 'about' },
    h('p', {}, `Auduio v${APP_VERSION}: a music workstation for recording, arranging and sequencing, in the browser, on the desktop and on phones. Works offline once loaded. © 2026 thebrainwaves. All rights reserved.`),
    h('p', { class: 'hint' }, 'Plugins (desktop app only): VST3 and CLAP on Windows, macOS and Linux. Audio Unit plugins are not supported.'),
    h('h4', {}, 'Privacy'), h('p', { class: 'privacy' }, PRIVACY_NOTE),
    h('h4', {}, 'Licences and trademarks'),
    h('p', { class: 'hint' }, 'Auduio uses open-source components; their notices are listed under Licences. VST is a trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries. All other product names belong to their owners; Auduio is not affiliated with them.'),
    h('p', {}, h('button', { type: 'button', class: 'small lic-btn', onclick: () => licencesDialog() }, 'Licences…')),
    h('p', { class: 'hint' }, 'Shortcuts: Space play/stop · R record · M computer keyboard · Shift+M metronome · Tab switch view · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo · Ctrl/Cmd+C/V/D copy/paste/duplicate · Delete remove clip · Ctrl/Cmd+E or S split at playhead · X cut tool · B browser · Arrow keys nudge the selected clip (Alt = 1 ms).')));
}
async function licencesDialog() {
  const pre = h('pre', { class: 'lic-text', tabindex: 0, 'aria-label': 'Third-party notices' }, 'Loading…');
  openDialog('Licences', h('div', { class: 'lic' },
    h('p', { class: 'hint' }, 'Third-party software used by Auduio (all builds), with their licences. Plugin APIs: VST 3 (MIT, Steinberg Media Technologies GmbH) and CLAP (MIT, Alexandre Bique). VST is a trademark of Steinberg Media Technologies GmbH.'), pre));
  try { const r = await fetch('THIRD-PARTY-NOTICES.txt'); pre.textContent = r.ok ? await r.text() : 'The notices file could not be loaded (' + r.status + ').'; }
  catch (e) { pre.textContent = 'The notices file could not be loaded: ' + e.message; }
}
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
  project.key = project.key || { root: 0, scale: 'major' }; project.midiMap = project.midiMap || []; project.gridOffset = +project.gridOffset || 0;
  { const bar = (60 / (project.bpm || 120)) * (project.beatsPerBar || 4), L = project.loop;
    project.loop = L && isFinite(L.start) && isFinite(L.end) && L.end > L.start ? { on: !!L.on, start: Math.max(0, +L.start), end: +L.end } : { on: false, start: project.gridOffset, end: project.gridOffset + 4 * bar }; }
  for (const t of project.tracks) {
    t.kind = t.kind || 'audio'; t.slots = t.slots || []; while (t.slots.length < project.scenes) t.slots.push(null);
    t.arrangement = t.arrangement || []; t.fx = t.fx || []; t.adaptive = t.adaptive || { enabled: false, amount: 60 };
    t.midiInput = t.midiInput || 'all'; t.fromBar = t.fromBar || 1;
    if (t.kind === 'midi' && !t.inst) t.inst = { type: 'synth', values: {} };
    if (t.kind === 'midi') t.midiFx = Array.isArray(t.midiFx) ? t.midiFx : [];
    if (t.kind !== 'midi') delete t.seq;
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
  if (S.pluginApi) S.pluginApi.sync(true);
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
    if (n.inst && n.inst.setPads) engine.syncPads(t);
    if (n.midi) { n.midi.track = t; n.midi.sync(); }
    engine.syncTrack(t); engine.syncAdaptive(t);
    if (JSON.stringify(o.arrangement) !== JSON.stringify(t.arrangement)) engine.rescheduleTrack(t);
    if (n.sessionMidi) { const c = t.slots[n.sessionSlot]; if (c && c.type === 'midi') n.sessionMidi.clip = c; else engine.stopTrackClip(t); }
    if (n.sessionSource && !t.slots[n.sessionSlot]) engine.stopTrackClip(t);
  }
  engine.routeAll();
  applyFxDiff('master', old.master.fx, p.master.fx, () => engine.setMasterFx(p.master.fx));
  engine.syncMaster(); engine.updateBpmFx(); engine.nextClick = null; if (engine.tempo.mode === 'follow') engine.tempo.follower.reset(p.bpm);
  if (S.selected !== 'master' && !track(S.selected)) S.selected = p.tracks[0] ? p.tracks[0].id : 'master';
  $('#bpm').value = p.bpm; $('#projName').textContent = p.name;
  engine.setLoop();
  if (S.pluginApi) S.pluginApi.sync(false).then(() => renderDevices());
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
      target.arrangement.push(c); trimUnder(target, c); engine.rescheduleTrack(target);
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


// ------------------------------------------------------------------ auto-timing: tap tempo, detect, follow, clip BPM
const tapper = new TapTempo();
function tapTempo() {
  if (!gate('tempo.tap', 'Tap tempo')) return;
  const b = tapper.tap(performance.now() / 1000); haptic(12);
  const btn = $('#btnTap'); btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash');
  if (b) { history.push('Tap tempo', 'tap'); engine.setTempo(b, { keepPhase: true }); $('#bpm').value = S.project.bpm; markDirty(); }
}
function updateTempoButton() {
  const b = $('#btnTempo'); if (!b) return; const T = engine.tempo, e = T.est;
  b.classList.toggle('on', T.listening); b.classList.toggle('follow', T.mode === 'follow');
  const conf = e ? e.confidence : 0;
  b.textContent = T.listening ? (e && conf > 0.3 ? '≈' + Math.round(e.bpm) : '≈…') + (T.mode === 'follow' ? ' ⟳' : '') : '≈';
  b.dataset.conf = !T.listening ? '' : conf >= 0.6 ? 'hi' : conf >= 0.35 ? 'mid' : 'lo';
  b.title = T.listening ? `Live tempo ${e ? e.bpm.toFixed(1) + ' BPM, confidence ' + Math.round(conf * 100) + '%' : '(listening…)'}${T.mode === 'follow' ? ' — following' : ''}` : 'Auto-timing: detect the band\'s tempo, follow it live, lock it';
}
let tempoPop = null;
function updateTempoPop() {
  if (!tempoPop || !tempoPop.isConnected) return; const T = engine.tempo, e = T.est, q = (s) => tempoPop.querySelector(s);
  q('.tp-bpm').textContent = e ? e.bpm.toFixed(1) : '—';
  q('.tp-conf i').style.width = Math.round((e ? e.confidence : 0) * 100) + '%';
  q('.tp-conf').title = 'Confidence ' + Math.round((e ? e.confidence : 0) * 100) + '%';
  q('.tp-confv').textContent = e ? Math.round(e.confidence * 100) + '%' : T.listening ? 'listening…' : 'off';
  q('.tp-alt').textContent = e ? 'or ' + e.alternatives.map((a) => a.toFixed(0)).join(' / ') : '';
  const d = T.detect; const det = q('.tp-detect');
  det.textContent = d ? `Listening… ${Math.round((d.progress || 0) * 100)}%` : 'Detect tempo (≈8 bars)'; det.classList.toggle('busy', !!d);
  q('.tp-follow').checked = T.mode === 'follow';
  q('.tp-grid').textContent = `Grid offset ${Math.round((S.project.gridOffset || 0) * 1000)} ms`;
}
function tempoPopover(anchor) {
  closeMenus();
  const T = engine.tempo, ok = allowed('tempo.detect');
  const useBpm = (b, label) => { if (!b) return; history.push(label); engine.setTempo(b, { keepPhase: true }); $('#bpm').value = S.project.bpm; markDirty(); toast(`Tempo ${S.project.bpm} BPM`, 1500); };
  const startOn = h('input', { type: 'checkbox', checked: prefs.tempoStartOnDownbeat !== false, onchange: (e) => { prefs.tempoStartOnDownbeat = e.target.checked; savePrefs(); } });
  const lock = h('input', { type: 'checkbox', checked: !!T.lockOnDetect, onchange: (e) => { T.lockOnDetect = e.target.checked; } });
  const follow = h('input', { type: 'checkbox', class: 'tp-follow', checked: T.mode === 'follow', onchange: (e) => {
    if (e.target.checked && !gate('tempo.detect', 'Follow the band\'s tempo')) { e.target.checked = false; return; }
    engine.setTempoFollow(e.target.checked, { lock: lock.checked }); if (e.target.checked) toast('Following the band\'s tempo', 1500);
  } });
  const clickOff = h('input', { type: 'number', min: -200, max: 200, step: 1, value: T.clickOffsetMs, class: 'num', title: 'Move the metronome click earlier (+) or later (−) if it feels off with your setup', onchange: (e) => { T.clickOffsetMs = Math.max(-200, Math.min(200, +e.target.value || 0)); engine.nextClick = null; } });
  tempoPop = h('div', { class: 'popover tempo-pop' },
    h('div', { class: 'tp-live' }, h('span', { class: 'tp-bpm' }, '—'), h('span', { class: 'tp-unit' }, 'BPM'), h('span', { class: 'tp-conf', 'aria-label': 'Confidence' }, h('i')), h('span', { class: 'tp-confv hint' }, ''), lockBadge('tempo.detect')),
    h('div', { class: 'row' },
      h('button', { class: 'small', title: 'Use the live estimate as the project tempo', onclick: () => { if (!gate('tempo.detect', 'Live tempo detection')) return; T.est && useBpm(T.est.bpm, 'Use detected tempo'); } }, 'Use'),
      h('button', { class: 'small', title: 'Half time: halve the project tempo', onclick: () => useBpm(S.project.bpm / 2, 'Half time') }, '÷2'),
      h('button', { class: 'small', title: 'Double time: double the project tempo', onclick: () => useBpm(S.project.bpm * 2, 'Double time') }, '×2'),
      h('span', { class: 'tp-alt hint' })),
    h('button', { class: 'tp-detect primary', title: 'Listen to armed inputs and playing tracks for about 8 bars, then set the tempo and the downbeat', onclick: async () => {
      if (!gate('tempo.detect', 'Detect tempo')) return;
      if (T.detect) { engine.stopTempoListen(); return; }
      await engine.resume(); history.push('Detect tempo');
      const est = await engine.detectTempo({ bars: S.detectBars || 8, startOnDownbeat: startOn.checked });
      if (!est || est.confidence < 0.3) { toast('No steady beat found — play a few bars with a clear rhythm (or tap the tempo).', 3500); return; }
      $('#bpm').value = S.project.bpm; updateTransportUI(); markDirty(); haptic(20);
      toast(`Tempo ${S.project.bpm.toFixed(1)} BPM (${Math.round(est.confidence * 100)}%)${engine.playing ? ' — metronome on the downbeat' : ''}`, 3500);
    } }, 'Detect tempo (≈8 bars)'),
    h('label', { title: 'When stopped: start the transport and metronome exactly on the next downbeat' }, startOn, ' Start on the downbeat with click'),
    h('label', { title: 'Keep tracking a live band: smooth, rate-limited tempo changes (moves the metronome and tempo-synced effects)' }, follow, ' Follow the band (live)'),
    h('label', { title: 'Stop following once the tempo has been steady and confident for a couple of seconds' }, lock, ' Lock once detected'),
    h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Click offset'), clickOff, h('span', { class: 'hint' }, 'ms'),
      h('span', { class: 'tp-grid hint' }), h('button', { class: 'small', title: 'Put bar 1 back at 0:00', onclick: () => { change('Reset grid offset', () => { S.project.gridOffset = 0; engine.nextClick = null; }); updateTempoPop(); } }, 'Reset')),
    h('p', { class: 'hint' }, 'Listens to armed inputs and playing tracks. Use headphones so the click does not leak into the mic. Tap tempo: TAP button or T key.'));
  document.body.append(tempoPop);
  if (ok && !T.listening) { T.keepListening = true; engine.startTempoListen(); }
  const r = anchor.getBoundingClientRect(); const pr = tempoPop.getBoundingClientRect();
  tempoPop.style.left = Math.max(4, Math.min(r.left, innerWidth - pr.width - 4)) + 'px'; tempoPop.style.top = Math.min(r.bottom + 4, innerHeight - pr.height - 4) + 'px';
  updateTempoPop();
  const onDown = (ev) => { if (tempoPop && tempoPop.contains(ev.target)) { document.addEventListener('pointerdown', onDown, { once: true }); return; } closeTempoPop(); };
  setTimeout(() => document.addEventListener('pointerdown', onDown, { once: true }), 0);
}
function closeTempoPop() {
  if (tempoPop) { tempoPop.remove(); tempoPop = null; }
  const T = engine.tempo; if (T.keepListening) { T.keepListening = false; if (T.mode === 'off' && !T.detect) engine.stopTempoListen(); }
}
// BPM of an imported/recorded clip; optionally use it as the project tempo and align the clip to the bar grid
function clipTempoDialog(t, c, where) {
  if (!gate('tempo.detect', 'Clip tempo detection')) return;
  const buf = engine.buffers.get(c.bufferId); if (!buf) return toast('No audio in this clip.');
  const dur = where === 'arr' ? c.duration : Math.min(buf.duration, c.loopLength || buf.duration);
  const r = detectBufferTempo(buf, { fromSec: where === 'arr' ? c.offset || 0 : 0, durSec: dur, beatsPerBar: S.project.beatsPerBar || 4 });
  if (!r || r.confidence < 0.2) return toast('No steady tempo found in this clip.', 3000);
  c.bpm = Math.round(r.bpm * 10) / 10;
  const bpmIn = h('input', { type: 'number', min: 40, max: 300, step: 0.1, value: c.bpm, class: 'num' });
  const align = h('input', { type: 'checkbox', checked: where === 'arr' });
  const content = h('div', { class: 'clip-tempo' },
    h('p', {}, `Detected `, h('b', {}, `${r.bpm.toFixed(1)} BPM`), ` (confidence ${Math.round(r.confidence * 100)}%). Half/double: ${r.alternatives.map((a) => a.toFixed(1)).join(' / ')}.`),
    h('label', {}, 'Project tempo ', bpmIn, ' BPM'),
    where === 'arr' ? h('label', { title: 'Move the clip so its first detected downbeat sits exactly on a bar line' }, align, ' Also shift the clip so its downbeat lands on a bar line') : null,
    h('p', { class: 'hint' }, 'Audio is not time-stretched; the project grid, metronome and tempo-synced effects follow the new tempo. Detection is a heuristic — check it by ear.'));
  const dlg = openDialog('Clip tempo — ' + (c.name || 'clip'), content, [{ label: 'Close', value: 'cancel' }, { label: 'Set project tempo from clip', value: 'ok', primary: true }]);
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const b = Math.max(40, Math.min(300, +bpmIn.value || r.bpm)); const scale = b / r.bpm;
    change('Tempo from clip', () => {
      S.project.bpm = Math.round(b * 100) / 100; engine.updateBpmFx(); engine.nextClick = null;
      if (where === 'arr' && align.checked) {
        const db = c.start + (r.downbeatSec) * 1; const bar = engine.barDur, o = S.project.gridOffset || 0;
        let target = o + Math.round((db - o) / bar) * bar; if (c.start + (target - db) < 0) target += bar; c.start = Math.max(0, c.start + (target - db)); engine.rescheduleTrack(t);
      }
    });
    void scale; $('#bpm').value = S.project.bpm; renderAll(); toast(`Project tempo ${S.project.bpm} BPM`, 2000);
  }, { once: true });
  return r;
}

// ------------------------------------------------------------------ transport + recording
function updateTransportUI() {
  $('#btnPlay').classList.toggle('on', engine.playing);
  $('#btnRec').classList.toggle('on', engine.recording);
  $('#btnMetro').classList.toggle('on', engine.metronome);
  updateLoopUI();
  const ar = engine.autoRec.state; const b = $('#btnAutoRec');
  b.classList.toggle('on', ar !== 'off'); b.classList.toggle('waiting', ar === 'waiting');
  b.textContent = ar === 'waiting' ? 'WAIT' : 'AUTO';
  if (typeof phone !== 'undefined' && phone.active && phone.tab !== 'mix' && phone.tab !== 'effects') phone.render();
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
engine.on('loop', () => updateLoopUI());
engine.on('session', () => updateSessionStates());
engine.on('autorecord', () => { toast('Sound detected — recording'); haptic(20); });
engine.on('key', (k) => { toast(`Band key → ${k.name}`, 1800); updateKeyButton(); });
engine.on('tempo', () => { const b = $('#bpm'); if (b && document.activeElement !== b) b.value = S.project.bpm; markDirty(); clearTimeout(S._tempoRender); S._tempoRender = setTimeout(() => { if (S.view === 'arrange') renderArrange(); }, 600); });
engine.on('tempoest', () => { updateTempoButton(); updateTempoPop(); });
engine.on('tempostate', () => { updateTempoButton(); updateTempoPop(); });
engine.on('tempodetect', () => updateTempoPop());
engine.on('tempolock', ({ bpm }) => { toast(`Tempo locked at ${bpm.toFixed(1)} BPM`, 2500); haptic(20); updateTempoButton(); updateTempoPop(); });
engine.on('recorded', (results) => {
  if (!results.length) return;
  history.push('Record');
  for (const r of results) {
    const id = addBuffer(r.buffer);
    const clip = { id: uid('c'), bufferId: id, start: r.startPos, offset: r.offset, duration: r.duration, name: (r.auto ? 'Auto ' : 'Rec ') + new Date().toLocaleTimeString() };
    if (r.takes && r.takes.length > 1) {
      // loop recording: every pass is a take of the same recording; the last complete pass is used
      clip.takes = r.takes.map((k) => ({ start: k.start, offset: k.offset, duration: k.duration }));
      const full = clip.takes.map((k, i) => [k, i]).filter(([k]) => Math.abs(k.start - r.loop.start) < 0.01 && k.duration >= (r.loop.end - r.loop.start) - 0.02);
      clip.take = full.length ? full[full.length - 1][1] : clip.takes.length - 1;
      Object.assign(clip, clip.takes[clip.take]); clip.name = 'Loop take ' + new Date().toLocaleTimeString();
      toast(`Loop recording: ${clip.takes.length} takes kept. Using take ${clip.take + 1}; pick another in the clip menu or clip detail.`, 4200);
    }
    r.track.arrangement.push(clip);
    if (r.warning) toast(r.warning, 4000);
  }
  if (!results.some((r) => r.takes && r.takes.length > 1)) toast(`Recorded ${results.length} take(s) into the arrangement.`);
  renderArrange(); markDirty();
});
// MIDI arrangement recording
engine.on('recstart', ({ startPos }) => {
  S.liveRec = { startPos, peaks: new Map() };
  const tracks = S.project.tracks.filter((t) => t.kind === 'midi' && t.arm);
  S.midiRec = tracks.length ? { startPos, tracks: new Map(tracks.map((t) => [t.id, { open: new Map(), notes: [] }])) } : null;
});
engine.on('recstop', function ({ stopPos }) {
  S.liveRec = null; $$('.rec-live').forEach((e) => e.remove());
  const R = S.midiRec; S.midiRec = null; if (!R) return;
  const bd = engine.beatDur; let made = 0;
  const LP = arguments[0].loop; // loop recording: passes are merged (overdub) into one clip over the loop
  if (LP) { R.startPos = Math.min(R.startPos, LP.start); stopPos = LP.end; }
  for (const [tid, r] of R.tracks) {
    for (const [n, o] of r.open) r.notes.push({ n, v: o.v, t: o.pos, d: Math.max(0.05, (LP ? LP.end : stopPos) - o.pos) });
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
  const dst = n.midi || n.inst; on ? dst.noteOn(note, vel) : dst.noteOff(note);
  if (t.seq && seqView) seqView.onNote(t, note, vel, on);
  const pos = engine.position(), now = engine.ctx.currentTime;
  const R = S.midiRec && S.midiRec.tracks.get(t.id);
  if (R && engine.recording) {
    if (on) R.open.set(note, { v: vel, pos });
    else { const o = R.open.get(note); if (o) { const L = engine.loopSpan; R.notes.push({ n: note, v: o.v, t: o.pos, d: pos >= o.pos ? pos - o.pos : L ? L.end - o.pos : 0.1 }); R.open.delete(note); } }
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
  if (typeof m.fx === 'string' && m.fx.startsWith('plugin:')) return S.pluginApi && S.pluginApi.rt.has(m.fx.slice(7)) ? { key: m.key, label: m.key, min: 0, max: 1, def: 0 } : null;
  if (m.fx === 'inst') { const t = track(m.trackId); const C = t && t.inst && INSTRUMENT_TYPES[t.inst.type]; return C && C.params.find((p) => p.key === m.key); }
  const list = m.trackId === 'master' ? S.project.master.fx : (track(m.trackId) || { fx: [] }).fx;
  const d = list[m.fx]; return d && EFFECT_TYPES[d.type].params.find((p) => p.key === m.key);
}
// Set any device parameter live (knob, MIDI CC). Undo steps are coalesced per parameter.
function setParam(trackId, fx, key, v, fromMidi = false) {
  if (seqView && seqView.capture(trackId, fx, key, v)) return; // sequencer P-Lock mode: becomes a step lock
  if (typeof fx === 'string' && fx.startsWith('plugin:')) { if (S.pluginApi) S.pluginApi.setParam(fx.slice(7), +key, v); return; }
  history.push('Change ' + key, `p:${trackId}:${fx}:${key}`);
  if (fx === 'inst') { const n = engine.tracks.get(trackId); if (n && n.inst) n.inst.set(key, v); }
  else engine.setFxParam(trackId, fx, key, v);
  markDirty();
}

// ------------------------------------------------------------------ view toolbar (undo/redo, clip ops, key, auto-mix)
function viewTools(extra = []) {
  const b = (cls, label, title, fn, disabled) => h('button', { class: cls, title, onclick: fn, disabled: !!disabled }, label);
  return h('div', { class: 'view-tools' },
    b('adv', 'Copy', 'Copy selected clip (Ctrl/Cmd+C)', () => clipOp('copy'), !S.sel), b('adv', 'Paste', 'Paste clip (Ctrl/Cmd+V) at the playhead / into the selected slot', () => clipOp('paste'), !S.clipboard),
    b('adv', 'Dup', 'Duplicate selected clip (Ctrl/Cmd+D)', () => clipOp('dup'), !S.sel), b('', 'Del', 'Delete selected clip (Delete)', () => clipOp('del'), !S.sel),
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
    change('Paste clip', () => { t.arrangement.push(c); trimUnder(t, c); engine.rescheduleTrack(t); });
    S.sel = { kind: 'arr', trackId: t.id, clipId: c.id }; renderArrange(); return;
  }
  if (op === 'split' && (!sc || !sc.c || S.sel.kind !== 'arr')) { splitTrackAtPlayhead(); return; }
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
    if (S.sel.kind === 'arr') { const d = { ...JSON.parse(JSON.stringify(c)), id: uid('c'), start: c.start + c.duration }; change('Duplicate clip', () => { t.arrangement.push(d); trimUnder(t, d); engine.rescheduleTrack(t); }); S.sel = { kind: 'arr', trackId: t.id, clipId: d.id }; renderArrange(); }
    else { const free = t.slots.findIndex((x, i) => !x && i > sc.slot); if (free < 0) return toast('No free slot below'); change('Duplicate clip', () => { t.slots[free] = JSON.parse(JSON.stringify(c)); }); S.sel = { kind: 'slot', trackId: t.id, slot: free }; renderSession(); }
    return;
  }
  if (op === 'split' && S.sel.kind === 'arr') {
    const p = engine.position();
    if (p <= c.start || p >= c.start + c.duration) return splitTrackAtPlayhead(t);
    splitClipAt(t, c, p);
  }
}
// ------------------------------------------------------------------ clip cutting (Ctrl/Cmd+E, Cut tool, loop edges, delete section)
function splitClipAt(t, c, p) {
  if (!(p > c.start + 1e-6 && p < c.start + c.duration - 1e-6)) { toast('That point is not inside the clip.'); return null; }
  let right = null;
  change('Split clip', () => { right = splitClip(t.arrangement, c, p, () => uid('c'), clipRate); engine.rescheduleTrack(t); });
  haptic(12); renderArrange(); if (typeof phone !== 'undefined' && phone.active) phone.render();
  return right;
}
function splitTrackAtPlayhead(t = track(S.selected)) {
  const p = engine.position();
  if (!t || !t.arrangement || !t.arrangement.some((c) => p > c.start + 1e-6 && p < c.start + c.duration - 1e-6)) return toast('Nothing to split: move the playhead over a clip (or select a clip) and press Ctrl/Cmd+E.', 2600);
  change('Split at playhead', () => { splitAllAt(t.arrangement, p, () => uid('c'), clipRate); engine.rescheduleTrack(t); });
  haptic(12); renderArrange(); toast('Split at ' + fmtPos(p), 1200);
}
const editTracks = () => S.project.tracks.filter((t) => t.kind !== 'group');
function splitAtLoop() {
  const L = S.project.loop; let n = 0;
  change('Split at loop edges', () => { for (const t of editTracks()) { const k = splitAtRange(t.arrangement, L.start, L.end, () => uid('c'), clipRate); if (k) { n += k; engine.rescheduleTrack(t); } } });
  if (!n) toast('No clips cross the loop edges.'); else toast(`Split ${n} clip${n === 1 ? '' : 's'} at the loop edges (${loopLabel()}).`, 2000);
  renderArrange();
}
function deleteLoopSection(ripple) {
  const L = S.project.loop, a = L.start, b = L.end;
  change(ripple ? 'Cut out loop section' : 'Delete loop section', () => {
    for (const t of editTracks()) { t.arrangement = deleteSection(t.arrangement, a, b, () => uid('c'), { ripple }, clipRate); engine.rescheduleTrack(t); }
  });
  S.sel = null; haptic(14); renderArrange();
  toast(ripple ? `Removed ${loopLabel()} and closed the gap. Undo: Ctrl/Cmd+Z` : `Cleared ${loopLabel()} on all tracks. Undo: Ctrl/Cmd+Z`, 2600);
}
function setTool(tool) { S.tool = S.tool === tool ? null : tool; $('#arrangeView').classList.toggle('razor', S.tool === 'razor'); $$('.cut-btn').forEach((b) => { b.classList.toggle('on', S.tool === 'razor'); b.setAttribute('aria-pressed', String(S.tool === 'razor')); }); if (S.tool === 'razor') toast('Cut tool: click a clip where you want to cut it (Alt/Shift: no snap). Press X or Esc to leave.', 2600); }
function editMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 2, [
    { label: 'Split at playhead (Ctrl/Cmd+E)', fn: () => clipOp('split') },
    { label: 'Cut tool: click to split (X)', fn: () => setTool('razor') },
    { label: 'Split at loop edges', fn: () => splitAtLoop() },
    '-', { label: 'Delete loop section (leave a gap)', fn: () => deleteLoopSection(false) },
    { label: 'Cut out loop section (close the gap)', fn: () => deleteLoopSection(true) },
  ]);
}
function renderToolsState() { syncBottomToSelection(); $$('.view-tools').forEach((vt) => { vt.querySelectorAll('button').forEach((b) => { if (/^(Copy|Dup|Del)$/.test(b.textContent)) b.disabled = !S.sel; if (b.textContent === 'Paste') b.disabled = !S.clipboard; if (b.dataset.needsArr) b.disabled = !(S.sel && S.sel.kind === 'arr'); }); }); }

// ------------------------------------------------------------------ session view
function renderSession() {
  const root = $('#sessionView'); root.innerHTML = '';
  if (!root._dropBound) { root._dropBound = true; bindSessionDrop(root); }
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
  col.append(h('div', { class: 'slots group-slots' }, h('button', { class: 'fold', title: t.folded ? 'Unfold: show the tracks in this group' : 'Fold: hide the tracks in this group', onclick: () => toggleFold(t) }, icon(t.folded ? 'chevRight' : 'chevDown'), ' ' + n + (n === 1 ? ' track' : ' tracks'))));
  col.append(h('button', { class: 'stop-clip', title: 'Stop all clips in this group', onclick: () => groupMembers(t).forEach((m) => engine.stopTrackClip(m)) }, icon('stop')));
  col.append(mixerStrip(t));
  return col;
}
function applySessionScale() { const r = document.documentElement.style; r.setProperty('--sscale', prefs.sessionScale); }
function trackHeader(t) {
  const hd = h('div', { class: 'col-head' + (S.selected === t.id ? ' sel' : ''), style: { '--c': t.color }, title: `${t.name} — tap to show its devices, double-tap to rename, long-press for more` },
    h('span', { class: 'kind' }, t.kind === 'group' ? icon('group') : t.kind === 'midi' ? icon(t.instrument === 'drums' ? 'drums' : 'note') : ''),
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
    t.kind !== 'group' ? { label: 'Group this track' + (allowed('grouping') ? '' : ' (locked)'), fn: () => groupTrack(t) } : null,
    S.project.tracks.some((g) => g.kind === 'group' && g.id !== t.id) ? { label: 'Move to group…', fn: () => groupMenu(t, x, y) } : null,
    t.groupId ? { label: 'Remove from group', fn: () => setGroup(t, null) } : null,
    t.kind === 'group' ? { label: 'Ungroup (keep tracks)', fn: () => ungroup(t) } : null,
    t.kind === 'group' ? { label: t.folded ? 'Unfold' : 'Fold', fn: () => toggleFold(t) } : null,
    '-',
    { label: 'Delete track', fn: () => { if (confirm(`Delete track "${t.name}"? (Undo is available)`)) deleteTrack(t.id); } },
  ]);
}
function renameTrack(t) { const n = prompt('Track name', t.name); if (n) change('Rename track', () => { t.name = n.slice(0, 32); renderAll(); }); }
function syncMonitor() { if (S.project && (engine.autoMonitorId !== S.selected || engine.autoMonitor !== (prefs.autoMonitor !== false))) engine.setAutoMonitor(S.selected, prefs.autoMonitor !== false); }
function selectTrack(id) {
  engine.setAutoMonitor(id, prefs.autoMonitor !== false);
  if (S.bottom === 'clip') { S.bottom = 'devices'; S.selected = id; renderDevices(); }
  if (S.selected === id) return;
  S.selected = id;
  $$('#sessionView .col-head').forEach((e) => e.classList.toggle('sel', e.closest('.col').dataset.id === id));
  $$('#arrangeView .lane-head').forEach((e) => e.classList.toggle('sel', e.dataset.id === id));
  renderDevices();
  if (seqView) seqView.render(); // the sequencer side panel follows the selected track
}
function sessionColumn(t) {
  const col = h('div', { class: 'col' + (t.kind === 'midi' ? ' midi' : ''), 'data-id': t.id, style: { '--c': t.color } });
  col.append(trackHeader(t));
  const slots = h('div', { class: 'slots' });
  t.slots.forEach((clip, i) => {
    const s = h('div', { class: 'slot' + (clip ? ' has-clip' : '') + (S.sel && S.sel.kind === 'slot' && S.sel.trackId === t.id && S.sel.slot === i ? ' selected' : ''), 'data-slot': i,
      title: clip ? `${clip.name || 'Clip'} — tap to launch, long-press for options${clip.type === 'midi' ? ', double-tap to edit notes' : ''}` : (t.arm ? 'Tap to record here' : 'Empty slot — arm the track to record, long-press for options') });
    if (clip) {
      s.append(h('button', { class: 'slot-launch', title: 'Launch in the session (starts on the next bar)', 'aria-label': 'Launch clip', onclick: (e) => { e.stopPropagation(); if (!consumedLongPress(s)) onSlotClick(t, i, true); } }, icon('play')), h('span', { class: 'clip-name' }, clip.name || 'Clip'), h('div', { class: 'prog' }));
      const cv = h('canvas', { class: 'mini-wave' }); s.append(cv);
      requestAnimationFrame(() => clip.type === 'midi' ? drawNotes(cv, clip, t.color) : drawWaveform(cv, engine.buffers.get(clip.bufferId), { startSec: clip.loopStart || 0, endSec: (clip.loopStart || 0) + (clip.loopLength || 1), color: t.color, stereo: false, gain: dbToGain(clip.gain) }));
    } else s.append(h('span', { class: 'slot-btn' }));
    s.addEventListener('click', () => { if (s._dragMoved) { s._dragMoved = false; return; } if (!consumedLongPress(s)) onSlotClick(t, i); });
    if (clip && clip.bufferId && clip.type !== 'midi') bindAudition(s, () => ({ t, c: t.slots[i], key: `slot:${t.id}:${i}` }));
    if (clip) { s.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') startClipDrag({ kind: 'slot', t, i }, e, s); }); touchDragOnHold(s, () => ({ kind: 'slot', t, i })); }
    s.addEventListener('dblclick', () => { if (clip && clip.type === 'midi') editMidiClip(t, clip); else if (!clip && t.kind === 'midi') newMidiClipInSlot(t, i); });
    longPress(s, (x, y) => slotMenu(t, i, x, y));
    slots.append(s);
  });
  col.append(slots);
  col.append(h('button', { class: 'stop-clip', title: 'Stop this track\'s clip (at the next bar)', 'aria-label': 'Stop clip', onclick: () => engine.stopTrackClip(t) }, icon('stop')));
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
    { label: 'Pick up / move… (then tap “Place here”)', fn: () => pickUp({ kind: 'slot', t, i }) },
    { label: 'Move to Arrangement @ playhead', fn: () => { placeClip({ kind: 'slot', t, i }, { kind: 'arr', trackId: t.id, pos: snapPos(engine.position()) }); toast('Moved to the Arrangement view'); } },
    clip.type === 'midi' ? { label: 'Edit notes (piano roll)', fn: () => editMidiClip(t, clip) } : null,
    clip.type === 'midi' ? null : { label: 'Detect tempo (BPM)…', fn: () => clipTempoDialog(t, clip, 'slot') },
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
function editMidiClip(t, clip, keepView) {
  // Undo/redo inside the piano roll: the snapshot restore replaces the clip object, so find it again and reopen
  const loc = clip.id ? { id: clip.id } : { slot: t.slots.indexOf(clip) };
  const relocate = () => { const t2 = track(t.id); if (!t2) return null; const c2 = loc.id ? t2.arrangement.find((x) => x.id === loc.id) : t2.slots[loc.slot]; return c2 && c2.type === 'midi' ? { t: t2, c: c2 } : null; };
  const pr = openPianoRoll({ clip, title: `${t.name} · ${clip.name || 'MIDI'}`, color: t.color, history, view: keepView,
    onUndo: (isRedo) => { const v = { ...pr.view }; pr.close(); isRedo ? redo() : undo(); const r = relocate(); if (r) editMidiClip(r.t, r.c, v); },
    onChange: (what) => { if (what === 'length' && clip.id) clip.duration = clip.lengthBeats * engine.beatDur; markDirty(); if (what === 'close') { renderSession(); renderArrange(); } },
    preview: (n) => { const nd = engine.tracks.get(t.id); if (nd && nd.inst) { engine.resume(); (nd.midi || nd.inst).playNote(n, 90, engine.ctx.currentTime, 0.25); } } });
}
async function onSlotClick(t, i, launch = false) {
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
  if (t.slots[i]) { if (launch || t.slots[i].type === 'midi' || !t.slots[i].bufferId) engine.launchSlot(t, i); return; } // audio: tap = audition (see bindAudition)
  if (t.arm) {
    if (n.rec || SR) return toast('This track is already recording.');
    if (t.kind === 'midi') return startMidiSlotRecording(t, i);
    try { await engine.recordSlot(t, i); } catch (e) { toast(e.message); }
  } else {
    selectTrack(t.id);
    if (!wasSel) toast(t.kind === 'midi' ? 'Empty slot — double-tap to create a MIDI clip, or arm the track to record.' : 'Empty slot — arm the track to record here, or long-press for import/paste.', 2200);
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
  for (let i = 0; i < S.project.scenes; i++) slots.append(h('div', { class: 'slot scene', title: `Launch scene ${i + 1} (all clips in this row)`, onclick: () => { engine.resume(); engine.launchScene(i); haptic(8); } }, h('span', { class: 'play-ico' }, icon('play')), ` ${i + 1}`));
  col.append(slots);
  col.append(h('button', { class: 'stop-clip', title: 'Stop all clips', onclick: () => engine.stopAllClips() }, icon('stop'), ' All'));
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
    t.kind === 'group' ? null : btn('arm', icon('record'), t.arm, () => toggleArm(t), t.kind === 'midi' ? 'Arm: record MIDI and receive MIDI keyboard input' : 'Arm for recording (asks for microphone access)'),
    t.kind === 'group' ? null : h('span', { class: 'sig', 'data-sig': t.id, title: 'Input signal indicator (green = signal, purple = loud, red = clipping)' }),
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
// Deepest arrangement zoom: 2 px per sample, capped so the timeline stays below the browsers'
// maximum element width (~16 million px); very long songs therefore stop a little short of sample level.
function maxZoom() { const sr = (engine.ctx && engine.ctx.sampleRate) || 48000; return Math.max(400, Math.min(sr * 2, 16e6 / Math.max(1, arrLength()))); }
function zoomLabel() {
  const sr = (engine.ctx && engine.ctx.sampleRate) || 48000, spp = sr / S.zoom; // samples per pixel
  if (spp <= 4) return spp < 1 ? `1 sample = ${(1 / spp).toFixed(1)} px` : `1 px = ${spp.toFixed(1)} samples`;
  const ms = 1000 / S.zoom; return ms < 10 ? `1 px = ${ms.toFixed(2)} ms` : '';
}
// Fine time ruler for deep zoom: ticks in ms / samples for the visible part only (redrawn on scroll)
function drawFineRuler() {
  const sc = $('#arrangeView .arr-scroll'), cv = $('#arrangeView .fine-ruler'); if (!sc || !cv) return;
  const on = S.zoom * engine.beatDur > 600; cv.hidden = !on; if (!on) return;
  const dpr = devicePixelRatio || 1, W = sc.clientWidth, H = cv.clientHeight || 12;
  cv.style.left = sc.scrollLeft + 'px'; cv.style.width = W + 'px';
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const t0 = sc.scrollLeft / S.zoom, span = W / S.zoom;
  const nice = [1, 2, 5]; let step = 1e-6; outer: for (let e = -6; e < 3; e++) for (const m of nice) { step = m * Math.pow(10, e); if (step * S.zoom >= 70) break outer; }
  g.fillStyle = 'rgba(221,214,254,.8)'; g.font = '9px sans-serif';
  for (let k = Math.ceil(t0 / step); k * step <= t0 + span; k++) {
    const t = k * step, x = (t - t0) * S.zoom; g.fillRect(Math.round(x), H - 5, 1, 5);
    const lbl = step < 0.001 ? (t * 1000).toFixed(3) + ' ms' : step < 1 ? (t * 1000).toFixed(step < 0.01 ? 1 : 0) + ' ms' : t.toFixed(0) + ' s';
    g.fillText(lbl, x + 2, H - 5);
  }
}
function setZoom(z, anchorX) {
  const sc = $('#arrangeView .arr-scroll'); if (!sc) { S.zoom = z; return; }
  const r = sc.getBoundingClientRect(); const ax = anchorX == null ? r.width / 2 : anchorX - r.left;
  const t = (sc.scrollLeft + ax) / S.zoom;
  S.zoom = Math.max(4, Math.min(maxZoom(), z));
  renderArrange();
  const sc2 = $('#arrangeView .arr-scroll'); sc2.scrollLeft = t * S.zoom - ax; S._arrScroll = sc2.scrollLeft;
}
function renderArrange() {
  const root = $('#arrangeView'); const prevTop = S._arrTop || 0; root.innerHTML = ''; root.classList.toggle('razor', S.tool === 'razor');
  if (prefs.laneH) root.style.setProperty('--lane-h', prefs.laneH + 'px'); else root.style.removeProperty('--lane-h');
  const len = arrLength(), W = len * S.zoom;
  const needArr = (label, title, fn) => { const b = h('button', { class: 'adv', title, onclick: fn, disabled: !(S.sel && S.sel.kind === 'arr') }, label); b.dataset.needsArr = '1'; return b; };
  root.append(viewTools([
    h('button', { class: 'split-btn', title: 'Split at the playhead (Ctrl/Cmd+E or S): the selected clip, or every clip under the playhead on the selected track', onclick: () => clipOp('split') }, icon('cut'), 'Split'),
    h('button', { class: 'cut-btn' + (S.tool === 'razor' ? ' on' : ''), 'aria-pressed': String(S.tool === 'razor'), title: 'Cut tool (X): click a clip where you want to cut it', onclick: () => setTool('razor') }, 'Cut tool'),
    h('button', { class: 'edit-btn', title: 'More cutting: split at the loop edges, delete or cut out the loop section', 'aria-label': 'Edit menu', onclick: (e) => editMenu(e.currentTarget) }, 'Edit', icon('chevDown')),
    needArr('Quantize…', 'Quantize: move notes/hits in the selected clip onto the beat grid', () => quantizeDialog()),
    needArr('BPM…', 'Detect the tempo of the selected audio clip and optionally use it as the project tempo', () => { const sc = selectedClip(); if (sc && sc.c && sc.c.type !== 'midi') clipTempoDialog(sc.t, sc.c, 'arr'); else toast('Select an audio clip first.'); }),
    h('button', { class: 'snap-btn' + (prefs.snap !== false ? ' on' : ''), title: 'Snap clips to the beat grid when placing or moving them. Hold Alt or Shift while dropping to place freely.', onclick: () => toggleSnap() }, prefs.snap !== false ? 'Snap: on' : 'Snap: off'),
    h('span', { class: 'sep' }),
    h('button', { title: 'Zoom out', onclick: () => setZoom(S.zoom / 1.5) }, '−'),
    h('button', { title: 'Zoom in (or pinch / Ctrl+wheel). Zooms down to single samples.', onclick: () => setZoom(S.zoom * 1.5) }, '+'),
    h('span', { class: 'zoom-info dim', title: 'Current zoom level' }, zoomLabel()),
    h('button', { class: 'lane-size', title: 'Track height: taller lanes show bigger waveforms (stereo clips split into L/R lanes)', 'aria-label': 'Track height', onclick: () => { const L = [0, 90, 140]; const i = (L.indexOf(prefs.laneH || 0) + 1) % L.length; prefs.laneH = L[i]; savePrefs(); renderArrange(); } }, icon('height')),
    h('button', { class: 'follow adv' + (S.follow ? ' on' : ''), title: 'Keep the playhead in view', onclick: (e) => { S.follow = !S.follow; e.target.classList.toggle('on', S.follow); } }, 'Follow'),
  ]));
  const body = h('div', { class: 'arr-body' });
  const heads = h('div', { class: 'arr-heads' }, h('div', { class: 'ruler-spacer' }));
  const scroll = h('div', { class: 'arr-scroll' });
  const content = h('div', { class: 'arr-content', style: { width: W + 'px' } });
  const ruler = h('div', { class: 'ruler', title: 'Tap to move the playhead. Drag along the ruler to set a loop; drag the loop bar to move it, its edges to resize (Alt = no snap), double-click it to switch the loop on/off.' });
  const bd = engine.barDur; const step = S.zoom * bd < 30 ? 4 : S.zoom * bd < 60 ? 2 : 1;
  for (let b = 0; b * bd < len; b += step) ruler.append(h('span', { style: { left: (engine.gridOffset + b * bd) * S.zoom + 'px' } }, String(b + 1)));
  if (S.zoom * engine.beatDur >= 60) { const bpb = S.project.beatsPerBar || 4; for (let k = 0; k * engine.beatDur < len; k++) if (k % bpb) ruler.append(h('span', { class: 'beat', style: { left: (engine.gridOffset + k * engine.beatDur) * S.zoom + 'px' } }, `${Math.floor(k / bpb) + 1}.${(k % bpb) + 1}`)); }
  ruler.append(h('canvas', { class: 'fine-ruler', hidden: true }));
  ruler.append(h('div', { class: 'loop-brace', role: 'slider', 'aria-label': 'Loop region' }, h('i', { class: 'lb-l' }), h('i', { class: 'lb-r' })));
  bindLoopRuler(ruler, content);
  content.append(ruler, h('div', { class: 'loop-shade' }));
  content.style.setProperty('--bar', bd * S.zoom + 'px');
  content.style.setProperty('--beat', engine.beatDur * S.zoom + 'px');
  for (const { t, depth, hidden } of displayOrder()) {
    if (hidden) continue;
    const isG = t.kind === 'group';
    const lh = h('div', { class: 'lane-head' + (S.selected === t.id ? ' sel' : '') + (isG ? ' group' : '') + (depth ? ' in-group' : ''), 'data-id': t.id, style: { '--c': t.color, '--depth': depth }, title: `${t.name} — tap to select, long-press for options` },
      h('div', { class: 'lh-name' }, isG ? '' : t.kind === 'midi' ? icon(t.instrument === 'drums' ? 'drums' : 'note') : '', t.name),
      h('div', { class: 'lh-btns' },
        isG ? h('button', { class: 'tbtn fold', title: t.folded ? 'Unfold group' : 'Fold group', onclick: (e) => { e.stopPropagation(); toggleFold(t); } }, icon(t.folded ? 'chevRight' : 'chevDown'))
          : h('button', { class: 'tbtn arm' + (t.arm ? ' on' : ''), title: 'Arm for recording', 'aria-label': 'Arm for recording', onclick: (e) => { e.stopPropagation(); toggleArm(t); } }, icon('record')),
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
  scroll.append(content); requestAnimationFrame(updateLoopUI);
  const ov = h('canvas', { class: 'overview', title: 'Overview — tap or drag to scroll' });
  scroll.addEventListener('scroll', () => { heads.scrollTop = scroll.scrollTop; S._arrScroll = scroll.scrollLeft; S._arrTop = scroll.scrollTop; drawOverview(); scheduleClipRedraw(); drawFineRuler(); });
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
    const proj = files.filter((f) => /\.(auduio|webdaw|zip|json|enc)$/i.test(f.name));
    if (proj.length) return importProject(proj[0]);
    const audio = files.filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|oga|flac|m4a|aac|webm|opus|aif|aiff)$/i.test(f.name));
    if (!audio.length) return toast('Drop audio files (wav, mp3, ogg, flac, m4a…)');
    await engine.resume();
    const { pos, trackId } = hit(e.clientX, e.clientY);
    await importAudioAt(audio, snapPos(pos, e), trackId);
  });
  longPress(scroll, (x, y, ev) => {
    if (ev && ev.target && ev.target.closest && ev.target.closest('.aclip')) return;
    const { pos, trackId } = hit(x, y); const t = trackId && track(trackId);
    const q = snapPos(pos, ev);
    contextMenu(x, y, [
      { label: `Import audio here (${fmtPos(q)})…`, fn: async () => { const f = await pickFiles('audio/*'); if (f.length) { await engine.resume(); importAudioAt(f, q, t && t.kind === 'audio' ? t.id : null); } } },
      t && t.kind === 'midi' ? { label: 'New MIDI clip here (4 bars)', fn: () => newMidiClipArr(t, q) } : null,
      S.clipboard ? { label: 'Paste here', fn: () => { S.sel = t ? { kind: 'arr', trackId: t.id, clipId: null } : null; engine.setPosition(q); clipOp('paste'); } } : null,
      { label: 'Move playhead here', fn: () => engine.setPosition(q) },
    ]);
  });
  scroll.addEventListener('dblclick', (e) => { if (e.target.closest('.aclip')) return; const { pos, trackId } = hit(e.clientX, e.clientY); const t = trackId && track(trackId); if (t && t.kind === 'midi') newMidiClipArr(t, Math.floor(pos / engine.barDur) * engine.barDur); });
  scroll.addEventListener('pointerdown', (e) => { if (!e.target.closest('.aclip') && S.sel && S.sel.kind === 'arr') { S.sel = null; $$('.aclip.sel').forEach((x) => x.classList.remove('sel')); renderToolsState(); } });
  attachPinch(scroll, { start: () => { S._pan0 = [scroll.scrollLeft, scroll.scrollTop]; return S.zoom; }, pan: (dx, dy) => { scroll.scrollTop = S._pan0[1] - dy; }, zoom: (z0, k, m) => { const nz = Math.max(4, Math.min(maxZoom(), z0 * k)); if (Math.abs(nz - S.zoom) / S.zoom > 0.04) setZoom(nz, m.x); } });
  // overview scrollbar
  const ovDrag = (e) => { const r = ov.getBoundingClientRect(); const f = (e.clientX - r.left) / r.width; scroll.scrollLeft = f * W - scroll.clientWidth / 2; };
  ov.addEventListener('pointerdown', (e) => { ov.setPointerCapture(e.pointerId); ovDrag(e); ov.onpointermove = ovDrag; });
  ov.addEventListener('pointerup', () => { ov.onpointermove = null; });
  scroll.scrollLeft = S._arrScroll || 0; scroll.scrollTop = prevTop;
  requestAnimationFrame(() => { drawOverview(); drawFineRuler(); });
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
    h('div', { class: 'aclip-name' }, c.name || '', c.takes && c.takes.length > 1 ? h('span', { class: 'take-badge', title: 'Loop-recorded clip: take ' + ((c.take || 0) + 1) + ' of ' + c.takes.length }, `T${(c.take || 0) + 1}/${c.takes.length}`) : null), h('canvas'),
    c.type === 'midi' ? null : h('i', { class: 'fh fi', title: 'Fade in: drag right (Alt/Shift = free, no snap)' }),
    c.type === 'midi' ? null : h('i', { class: 'fh fo', title: 'Fade out: drag left (Alt/Shift = free, no snap)' }));
  el._clip = c; el._track = t;
  requestAnimationFrame(() => c.type === 'midi' ? drawNotes($('canvas', el), c, t.color) : drawArrClip(el));
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); if (c.type === 'midi') editMidiClip(t, c); });
  longPress(el, (x, y) => {
    S.sel = { kind: 'arr', trackId: t.id, clipId: c.id }; renderToolsState();
    const r = el.getBoundingClientRect(), here = snapPos(c.start + (x - r.left) / S.zoom);
    contextMenu(x, y, [
      { label: 'Split here', fn: () => splitClipAt(t, c, here) },
      { label: 'Pick up / move… (then tap “Place here”)', fn: () => pickUp({ kind: 'arr', t, c }) },
      { label: 'Move to Session (first free slot)', fn: () => { const i = t.slots.findIndex((x) => !x); placeClip({ kind: 'arr', t, c }, { kind: 'slot', trackId: t.id, slot: i < 0 ? t.slots.length : i }); toast('Moved to the Session view'); } },
      c.type === 'midi' ? { label: 'Edit notes (piano roll)', fn: () => editMidiClip(t, c) } : null,
      { label: 'Copy', fn: () => clipOp('copy') }, { label: 'Duplicate', fn: () => clipOp('dup') },
      { label: 'Split at playhead (Ctrl/Cmd+E)', fn: () => clipOp('split') },
      { label: 'Split at loop edges', fn: () => splitAtLoop() },
      { label: 'Quantize…', fn: () => quantizeDialog() },
      c.type === 'midi' ? null : { label: 'Detect tempo (BPM)…', fn: () => clipTempoDialog(t, c, 'arr') },
      { label: 'Rename…', fn: () => { const n = prompt('Clip name', c.name); if (n) change('Rename clip', () => { c.name = n.slice(0, 64); renderArrange(); }); } },
      { label: 'Loop this clip (Ctrl/Cmd+L)', fn: () => loopToSelection() },
      ...(c.takes && c.takes.length > 1 ? ['-', ...c.takes.map((k, i) => ({ label: `Take ${i + 1} (${k.duration.toFixed(1)} s)${i === (c.take || 0) ? ' - in use' : ''}`, fn: () => useTake(t, c, i) }))] : []),
      '-', { label: 'Delete', fn: () => clipOp('del') },
    ]);
  });
  el.addEventListener('pointermove', (e) => { if (S.tool !== 'razor') { if (c.type !== 'midi' && e.pointerType !== 'touch' && !e.buttons) { const ex = e.clientX - el.getBoundingClientRect().left; el.style.cursor = el.offsetWidth > 24 && (ex < 6 || el.offsetWidth - ex < 6) ? 'ew-resize' : ''; } return; } const r = el.getBoundingClientRect(), p = snapPos(c.start + (e.clientX - r.left) / S.zoom, e); el.style.setProperty('--cut-x', (p - c.start) * S.zoom + 'px'); });
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !e.isPrimary) return;
    if (S.tool === 'razor' && e.button === 0) { e.stopPropagation(); e.preventDefault(); const r = el.getBoundingClientRect(); S.sel = { kind: 'arr', trackId: t.id, clipId: c.id }; splitClipAt(t, c, snapPos(c.start + (e.clientX - r.left) / S.zoom, e)); return; }
    S.sel = { kind: 'arr', trackId: t.id, clipId: c.id };
    $$('.aclip.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); renderToolsState();
    if (c.type !== 'midi' && e.button === 0 && e.target.classList.contains('fh')) { e.stopPropagation(); e.preventDefault(); return startClipEdit(t, c, el, e, e.target.classList.contains('fi') ? 'fadeIn' : 'fadeOut'); }
    const ex = e.clientX - el.getBoundingClientRect().left, edgePx = e.pointerType === 'touch' ? 0 : 6;
    if (c.type !== 'midi' && e.button === 0 && edgePx && el.offsetWidth > 24 && (ex < edgePx || el.offsetWidth - ex < edgePx)) { e.stopPropagation(); e.preventDefault(); return startClipEdit(t, c, el, e, ex < edgePx ? 'trimStart' : 'trimEnd'); }
    if (e.pointerType !== 'touch') startClipDrag({ kind: 'arr', t, c }, e, el); // touch: long-press picks the clip up (see touchDragOnHold)
  });
  touchDragOnHold(el, () => ({ kind: 'arr', t, c }));
  if (c.bufferId && c.type !== 'midi') bindAudition(el, () => ({ t, c, key: 'arr:' + c.id }));
  return el;
}

// ------------------------------------------------------------------ v0.5.1 micro editing
// Trim a clip's start/end or drag its fades in the arrangement. Snaps to the beat grid unless Snap is
// off or Alt/Shift is held (then free, rounded to 0.1 ms). One undo step per gesture.
const MS = 0.001;
function clipBounds(t, c) { const buf = engine.buffers.get(c.bufferId), r = clipRate(c); return { maxEnd: buf ? c.start + (buf.duration - (c.offset || 0)) / r : Infinity, minStart: Math.max(0, c.start - (c.offset || 0) / r) }; }
function applyClipEdit(t, c, mode, pos, ev) {
  const free = !snapOn(ev), q = (x) => free ? Math.round(x * 10000) / 10000 : snapPos(x, ev);
  const r = clipRate(c), { maxEnd, minStart } = clipBounds(t, c), end = c.start + c.duration, minLen = 0.005;
  if (mode === 'trimStart') { const ns = Math.max(minStart, Math.min(end - minLen, q(pos))); c.offset = Math.max(0, (c.offset || 0) + (ns - c.start) * r); c.duration = end - ns; c.start = ns; }
  else if (mode === 'trimEnd') { const ne = Math.min(maxEnd, Math.max(c.start + minLen, q(pos))); c.duration = ne - c.start; }
  else if (mode === 'fadeIn') c.fadeIn = Math.max(0, Math.min(c.duration - (c.fadeOut || 0), q(pos) - c.start));
  else if (mode === 'fadeOut') c.fadeOut = Math.max(0, Math.min(c.duration - (c.fadeIn || 0), end - q(pos)));
  if (c.fadeIn > c.duration) c.fadeIn = c.duration; if ((c.fadeIn || 0) + (c.fadeOut || 0) > c.duration) c.fadeOut = Math.max(0, c.duration - (c.fadeIn || 0));
}
function startClipEdit(t, c, el, e, mode) {
  const content = el.closest('.arr-content'); if (!content) return;
  history.push({ trimStart: 'Trim clip start', trimEnd: 'Trim clip end', fadeIn: 'Fade in', fadeOut: 'Fade out' }[mode]);
  const move = (ev) => {
    ev.preventDefault(); const pos = (ev.clientX - content.getBoundingClientRect().left) / S.zoom;
    applyClipEdit(t, c, mode, pos, ev);
    el.style.left = c.start * S.zoom + 'px'; el.style.width = Math.max(4, c.duration * S.zoom) + 'px'; drawArrClip(el);
    engine.rescheduleTrack(t); markDirty(); if (S.clipView && S.clipView.draw) S.clipView.draw();
  };
  const up = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); el._dragMoved = true; if (S.bottom === 'clip') renderDevices(); };
  window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
}
// Arrow-key nudge of the selected arrangement clip: grid step (beat), Alt = 1 ms, Alt+Shift = 10 ms.
function nudgeSelected(dir, ev) {
  const sc = S.sel && S.sel.kind === 'arr' ? selectedClip() : null; if (!sc || !sc.c) return false;
  const step = ev.altKey ? (ev.shiftKey ? 10 : 1) * MS : engine.beatDur; const { t, c } = sc;
  change('Nudge clip', () => { c.start = Math.max(0, Math.round((c.start + dir * step) * 1e6) / 1e6); }, 'nudge' + c.id);
  engine.rescheduleTrack(t);
  const el = $(`#arrangeView .aclip[data-clip="${c.id}"]`); if (el) { el.style.left = c.start * S.zoom + 'px'; if (c.type !== 'midi') drawArrClip(el); }
  if (S.bottom === 'clip') renderDevices();
  return true;
}
// exact numbers for a selected arrangement clip (clip detail panel)
function setClipNumber(t, c, field, v) {
  if (!isFinite(v)) return;
  change({ start: 'Clip position', duration: 'Clip length', offset: 'Clip offset', fadeIn: 'Fade in', fadeOut: 'Fade out' }[field] || 'Clip', () => {
    const r = clipRate(c), buf = engine.buffers.get(c.bufferId), bl = buf ? buf.duration : Infinity;
    if (field === 'start') c.start = Math.max(0, v);
    else if (field === 'duration') c.duration = Math.max(0.005, Math.min((bl - (c.offset || 0)) / r, v));
    else if (field === 'offset') { c.offset = Math.max(0, Math.min(bl - 0.005, v)); c.duration = Math.min(c.duration, (bl - c.offset) / r); }
    else if (field === 'fadeIn') c.fadeIn = Math.max(0, Math.min(c.duration - (c.fadeOut || 0), v));
    else if (field === 'fadeOut') c.fadeOut = Math.max(0, Math.min(c.duration - (c.fadeIn || 0), v));
  });
  engine.rescheduleTrack(t); if (S.view === 'arrange') renderArrange(); renderDevices();
}

// ------------------------------------------------------------------ v0.3 free clip placement
// One placement model for everything: audio files, arrangement clips and session clips can go on any track,
// any time position (snapped to the beat grid unless Snap is off or Alt/Shift is held) or any session slot, and
// empty space creates a new track. The clip that lands wins: clips underneath on the same track are trimmed /
// split / removed. Every placement is one undo step.
// ------------------------------------------------------------------ v0.3.1 arrangement loop
// project.loop = { on, start, end } in seconds. Saved with the project; every edit is one undo step.
function loopSnap(pos, ev, mode = 'round') {
  pos = Math.max(0, pos); if (ev && (ev.altKey || ev.shiftKey)) return pos; if (prefs.snap === false && !(ev && ev.forceSnap)) return pos;
  const q = engine.beatDur * S.zoom >= 10 ? engine.beatDur : engine.barDur, o = engine.gridOffset;
  const f = mode === 'floor' ? Math.floor : mode === 'ceil' ? Math.ceil : Math.round;
  return Math.max(0, f((pos - o) / q + (mode === 'round' ? 0 : 1e-6 * (mode === 'floor' ? 1 : -1))) * q + o);
}
function loopMinLen(ev) { return ev && (ev.altKey || ev.shiftKey) || prefs.snap === false ? 0.05 : (engine.beatDur * S.zoom >= 10 ? engine.beatDur : engine.barDur); }
function applyLoop(label, fn) { change(label, fn); engine.setLoop(); updateLoopUI(); }
function toggleLoop(force) {
  const L = S.project.loop; const on = force != null ? !!force : !L.on;
  applyLoop(on ? 'Loop on' : 'Loop off', () => { L.on = on; });
  toast(on ? `Loop on: ${loopLabel()}` : 'Loop off', 1400);
}
function barOf(pos) { return Math.round((pos - engine.gridOffset) / engine.barDur * 100) / 100 + 1; }
function loopLabel() { const L = S.project.loop; const a = barOf(L.start), b = barOf(L.end); const nice = (x) => Number.isInteger(x) ? String(x) : x.toFixed(2); return Number.isInteger(a) && Number.isInteger(b) ? `bars ${a}–${b - 1}` : `${nice(a)} – ${nice(b)}`; }
function loopInfo() { const L = S.project.loop, bars = (L.end - L.start) / engine.barDur; return { on: !!L.on, start: L.start, end: L.end, startBar: Math.floor(barOf(L.start) + 1e-6), bars: Math.round(bars * 100) / 100, label: loopLabel() }; }
function setLoopBars(startBar, bars, on = true) {
  startBar = Math.max(1, Math.round(startBar)); bars = Math.max(1, bars);
  const start = engine.gridOffset + (startBar - 1) * engine.barDur, end = start + bars * engine.barDur;
  applyLoop('Loop bars', () => { Object.assign(S.project.loop, { start, end, on }); });
}
// Ctrl/Cmd+L: loop the selected arrangement clip, or the 4 bars at the playhead when nothing is selected
function loopToSelection() {
  const sc = S.sel && S.sel.kind === 'arr' ? selectedClip() : null;
  let start, end;
  if (sc && sc.c) { start = sc.c.start; end = sc.c.start + sc.c.duration; }
  else { start = engine.barFloor(engine.position()); end = start + 4 * engine.barDur; }
  if (end - start < 0.05) return;
  applyLoop('Loop selection', () => { Object.assign(S.project.loop, { start, end, on: true }); });
  toast(`Loop on: ${loopLabel()}`, 1400);
}
function updateLoopUI() {
  if (!S.project) return; const L = S.project.loop;
  const b = $('#btnLoop'); if (b) { b.classList.toggle('on', !!L.on); b.setAttribute('aria-pressed', String(!!L.on)); }
  const br = $('#arrangeView .loop-brace'), sh = $('#arrangeView .loop-shade');
  if (br) { br.style.left = L.start * S.zoom + 'px'; br.style.width = Math.max(2, (L.end - L.start) * S.zoom) + 'px'; br.classList.toggle('off', !L.on); br.setAttribute('aria-valuetext', loopLabel() + (L.on ? ' (on)' : ' (off)')); }
  if (sh) { sh.style.left = L.start * S.zoom + 'px'; sh.style.width = Math.max(0, (L.end - L.start) * S.zoom) + 'px'; sh.hidden = !L.on; }
}
function bindLoopRuler(ruler, content) {
  let D = null;
  const secAt = (e) => (e.clientX - content.getBoundingClientRect().left) / S.zoom;
  ruler.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const L = S.project.loop, br = e.target.closest('.loop-brace');
    const edge = Math.max(6, e.pointerType === 'touch' ? 14 : 7) / S.zoom, x = secAt(e);
    let mode = 'new';
    if (br) mode = e.target.classList.contains('lb-l') || x - L.start < edge ? 'l' : e.target.classList.contains('lb-r') || L.end - x < edge ? 'r' : 'move';
    D = { mode, x0: x, cx: e.clientX, s0: L.start, e0: L.end, pushed: false, id: e.pointerId, moved: false };
    try { ruler.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  ruler.addEventListener('pointermove', (e) => {
    if (!D || e.pointerId !== D.id) return;
    if (!D.moved && Math.abs(e.clientX - D.cx) < 4) return;
    D.moved = true;
    const L = S.project.loop, x = secAt(e), minL = loopMinLen(e);
    if (!D.pushed) { history.push('Loop region'); D.pushed = true; ruler.classList.add('dragging'); }
    if (D.mode === 'move') { const len = D.e0 - D.s0; let s0 = loopSnap(D.s0 + (x - D.x0), e); s0 = Math.max(0, s0); L.start = s0; L.end = s0 + len; }
    else if (D.mode === 'l') L.start = Math.max(0, Math.min(loopSnap(x, e), L.end - minL));
    else if (D.mode === 'r') L.end = Math.max(loopSnap(x, e), L.start + minL);
    else { const a = Math.min(D.x0, x), b = Math.max(D.x0, x); L.start = loopSnap(a, e, e.altKey ? 'round' : 'floor'); L.end = Math.max(loopSnap(b, e, e.altKey ? 'round' : 'ceil'), L.start + minL); L.on = true; }
    updateLoopUI();
  });
  const end = (e) => {
    if (!D || e.pointerId !== D.id) return; const d = D; D = null; ruler.classList.remove('dragging');
    if (!d.moved) { if (d.mode === 'new' || e.type === 'pointercancel') { if (e.type !== 'pointercancel') engine.setPosition(Math.max(0, d.x0)); } return; }
    engine.setLoop(); markDirty(); updateLoopUI(); if (phone.active) phone.render();
  };
  ruler.addEventListener('pointerup', end); ruler.addEventListener('pointercancel', end);
  ruler.addEventListener('dblclick', (e) => { const L = S.project.loop, x = secAt(e); const br = ruler.querySelector('.loop-brace').getBoundingClientRect(); if (x >= L.start && x <= L.end && e.clientY >= br.top - 3) toggleLoop(); });
}
function useTake(t, c, i) {
  if (!c.takes || !c.takes[i]) return;
  change('Pick take', () => { Object.assign(c, c.takes[i]); c.take = i; engine.rescheduleTrack(t); });
  S.clipView = null; renderArrange(); renderDevices(); toast(`Using take ${i + 1} of ${c.takes.length}`, 1200);
}
function setView(v) { S.view = v === 'arrange' ? 'arrange' : 'session'; renderAll(); }
const snapOn = (ev) => prefs.snap !== false && !(ev && (ev.altKey || ev.shiftKey));
function snapPos(pos, ev) { pos = Math.max(0, pos); if (!snapOn(ev)) return pos; const q = engine.beatDur; return Math.max(0, Math.round((pos - engine.gridOffset) / q) * q + engine.gridOffset); }
function toggleSnap() { prefs.snap = prefs.snap === false; savePrefs(); $$('.snap-btn').forEach((b) => { b.classList.toggle('on', prefs.snap !== false); b.textContent = prefs.snap !== false ? 'Snap: on' : 'Snap: off'; }); toast(prefs.snap !== false ? 'Snap to beat grid on (hold Alt/Shift to place freely)' : 'Snap off — clips go exactly where you drop them', 1600); }
const clipRate = (c) => (c.type === 'midi' ? 1 : Math.pow(2, (c.transpose || 0) / 12));
// Trim/split/remove clips on track t that `top` overlaps. Mutates in place (call inside a history step).
function trimUnder(t, top) {
  const a = top.start, b = top.start + top.duration, eps = 1e-6, add = [];
  t.arrangement = t.arrangement.filter((o) => {
    if (o === top) return true;
    const oa = o.start, ob = o.start + o.duration;
    if (ob <= a + eps || oa >= b - eps) return true;            // no overlap
    if (oa >= a - eps && ob <= b + eps) return false;           // fully covered: remove
    if (oa < a && ob > b) {                                     // top sits inside: split into two
      const right = { ...JSON.parse(JSON.stringify(o)), id: uid('c'), start: b, offset: (o.offset || 0) + (b - oa) * clipRate(o), duration: ob - b };
      delete right.fadeIn; delete o.fadeOut;
      o.duration = a - oa; add.push(right); return true;
    }
    if (oa < a) { o.duration = a - oa; delete o.fadeOut; return true; } // tail covered: shorten
    delete o.fadeIn;
    const cut = b - oa; o.start = b; o.offset = (o.offset || 0) + cut * clipRate(o); o.duration -= cut; return true; // head covered
  });
  t.arrangement.push(...add);
}
// session clip <-> arrangement clip conversions
function slotToArrClip(sc, start) {
  const c = JSON.parse(JSON.stringify(sc)); const buf = sc.bufferId && engine.buffers.get(sc.bufferId);
  c.id = uid('c'); c.start = start;
  if (sc.type === 'midi') { c.offset = 0; c.duration = sc.lengthBeats * engine.beatDur; }
  else { c.offset = sc.loopStart || 0; c.duration = (sc.loopLength || (buf ? buf.duration - c.offset : 1)) / clipRate(sc); }
  delete c.loopLength; delete c.loopStart; return c;
}
function arrToSlotClip(c) {
  const s = JSON.parse(JSON.stringify(c)); delete s.id; delete s.start; delete s.offset; delete s.duration; delete s.fadeIn; delete s.fadeOut;
  if (c.type === 'midi') { s.lengthBeats = c.lengthBeats || Math.max(1, Math.round(c.duration / engine.beatDur)); }
  else { s.loopStart = c.offset || 0; s.loopLength = c.duration * clipRate(c); }
  return s;
}
function newTrackFor(isMidi, name) {
  const t = newTrack(S.project, name || null, isMidi ? 'midi' : 'audio', 'synth');
  if (isMidi) { t.instrument = 'keys'; t.instrumentSource = 'manual'; }
  S.project.tracks.push(t); engine.addTrack(t); return t;
}
function stopSlotIfPlaying(t, i) { const n = engine.tracks.get(t.id); if (n && n.sessionSlot === i) engine.stopTrackClip(t); }
// src: {kind:'arr', t, c} | {kind:'slot', t, i}; dst: {kind:'arr', trackId|null, pos} | {kind:'slot', trackId|null, slot}
function placeClip(src, dst, { copy = false } = {}) {
  const clip = src.kind === 'arr' ? src.c : src.t.slots[src.i]; if (!clip) return false;
  const isMidi = clip.type === 'midi';
  let t = dst.trackId ? track(dst.trackId) : null;
  if (t && (t.kind === 'group' || (t.kind === 'midi') !== isMidi)) { toast(isMidi ? 'MIDI clips go on MIDI tracks — placed on a new track' : 'Audio clips go on audio tracks — placed on a new track', 2200); t = null; }
  if (dst.kind === 'slot' && src.kind === 'slot' && t === src.t && dst.slot === src.i) return false;
  history.push(copy ? 'Copy clip' : 'Move clip');
  if (!t) t = newTrackFor(isMidi, (clip.name || '').slice(0, 24) || null);
  // remove from source (move)
  if (!copy) {
    if (src.kind === 'arr') { src.t.arrangement = src.t.arrangement.filter((x) => x !== clip); if (src.t !== t) engine.rescheduleTrack(src.t); }
    else { stopSlotIfPlaying(src.t, src.i); src.t.slots[src.i] = null; }
  }
  if (dst.kind === 'arr') {
    let c;
    if (src.kind === 'arr') { c = copy ? { ...JSON.parse(JSON.stringify(clip)), id: uid('c') } : clip; c.start = Math.max(0, dst.pos); }
    else c = slotToArrClip(clip, Math.max(0, dst.pos));
    t.arrangement.push(c); trimUnder(t, c); engine.rescheduleTrack(t);
    S.sel = { kind: 'arr', trackId: t.id, clipId: c.id };
  } else {
    while (t.slots.length <= dst.slot) t.slots.push(null);
    stopSlotIfPlaying(t, dst.slot);
    t.slots[dst.slot] = src.kind === 'slot' ? (copy ? JSON.parse(JSON.stringify(clip)) : clip) : arrToSlotClip(clip);
    if (dst.slot >= S.project.scenes) S.project.scenes = dst.slot + 1;
    S.sel = { kind: 'slot', trackId: t.id, slot: dst.slot };
  }
  S.selected = t.id; markDirty(); renderAll();
  return true;
}
// ---- drop-target hit testing shared by pointer drags and file drops
function dropTargetAt(x, y, grabSec = 0, ev = null) {
  const els = document.elementsFromPoint(x, y);
  const viewBtn = els.find((e) => e.matches && e.matches('.views button[data-view]'));
  if (viewBtn) return { kind: 'view', view: viewBtn.dataset.view, el: viewBtn };
  const lane = els.find((e) => e.classList && e.classList.contains('lane'));
  if (lane) {
    const content = lane.closest('.arr-content') || lane.parentElement; const r = content.getBoundingClientRect();
    return { kind: 'arr', trackId: lane.dataset.id || null, pos: snapPos((x - r.left) / S.zoom - grabSec, ev), lane };
  }
  const slot = els.find((e) => e.classList && e.classList.contains('slot') && !e.classList.contains('scene') && e.dataset.slot != null);
  if (slot) { const col = slot.closest('.col[data-id]'); if (col && !col.classList.contains('group')) return { kind: 'slot', trackId: col.dataset.id, slot: +slot.dataset.slot, el: slot }; }
  if (els.some((e) => e.classList && (e.classList.contains('session-grid') || e.classList.contains('add-col')))) {
    const firstSlot = document.querySelector('#sessionView .col[data-id] .slot'); let row = 0;
    if (firstSlot) { const r = firstSlot.getBoundingClientRect(); row = Math.max(0, Math.min(S.project.scenes - 1, Math.floor((y - r.top) / r.height))); }
    return { kind: 'slot', trackId: null, slot: row, el: null };
  }
  return null;
}
// ---- pointer drag of a clip (arrangement or session), across tracks and across views (hover the view tab)
function startClipDrag(src, e, el, { onStart } = {}) {
  if (e.button > 0) return;
  const sx = e.clientX, sy = e.clientY; let moved = false, ghost = null, tgt = null, viewTimer = null, hl = null;
  const clip = src.kind === 'arr' ? src.c : src.t.slots[src.i];
  const er = el.getBoundingClientRect();
  const grabSec = src.kind === 'arr' ? (sx - er.left) / S.zoom : 0;
  const durPx = () => Math.max(24, (src.kind === 'arr' ? clip.duration : slotToArrClip(clip, 0).duration) * S.zoom);
  const color = src.t.color;
  const onMove = (ev) => {
    if (!moved) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return; moved = true; if (onStart) onStart(); el.classList.add('dragging'); document.body.classList.add('clip-dragging');
      ghost = h('div', { class: 'clip-ghost', style: { '--c': color } }, h('span', {}, clip.name || 'Clip')); document.body.append(ghost); }
    ev.preventDefault();
    tgt = dropTargetAt(ev.clientX, ev.clientY, grabSec, ev);
    if (hl) { hl.classList.remove('drop-target'); hl = null; }
    clearTimeout(viewTimer); viewTimer = null;
    if (tgt && tgt.kind === 'view') { const v = tgt.view; if (v !== S.view) viewTimer = setTimeout(() => { setView(v); haptic(10); }, 450); tgt = null; }
    if (tgt && tgt.kind === 'arr') {
      const content = tgt.lane.closest('.arr-content') || tgt.lane.parentElement; const cr = content.getBoundingClientRect(), lr = tgt.lane.getBoundingClientRect();
      Object.assign(ghost.style, { left: cr.left + tgt.pos * S.zoom + 'px', top: lr.top + 2 + 'px', width: durPx() + 'px', height: Math.max(20, lr.height - 4) + 'px' });
      ghost.classList.toggle('new', !tgt.trackId); ghost.classList.remove('slotg');
      ghost.dataset.pos = tgt.pos.toFixed(4);
    } else if (tgt && tgt.kind === 'slot') {
      if (tgt.el) { hl = tgt.el; hl.classList.add('drop-target'); const r = hl.getBoundingClientRect(); Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); }
      else Object.assign(ghost.style, { left: ev.clientX - 50 + 'px', top: ev.clientY - 14 + 'px', width: '100px', height: '28px' });
      ghost.classList.add('slotg'); ghost.classList.toggle('new', !tgt.trackId);
    } else if (ghost) Object.assign(ghost.style, { left: ev.clientX - 50 + 'px', top: ev.clientY - 14 + 'px', width: '100px', height: '28px' });
  };
  const onUp = (ev) => {
    window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); window.removeEventListener('pointercancel', onCancel, true);
    clearTimeout(viewTimer); if (hl) hl.classList.remove('drop-target'); if (ghost) ghost.remove();
    el.classList.remove('dragging'); document.body.classList.remove('clip-dragging');
    if (!moved) return;
    if (el.setAttribute) el._dragMoved = true;
    if (tgt && (tgt.kind === 'arr' || tgt.kind === 'slot')) placeClip(src, tgt, { copy: ev.ctrlKey || ev.metaKey });
  };
  const onCancel = () => { moved = moved && false; onUp({}); };
  window.addEventListener('pointermove', onMove, true); window.addEventListener('pointerup', onUp, true); window.addEventListener('pointercancel', onCancel, true);
}
// ---- "pick up & place" (touch friendly; also works across views and in phone mode)
function pickUp(src) {
  const clip = src.kind === 'arr' ? src.c : src.t.slots[src.i]; if (!clip) return;
  S.carry = { src, target: null }; haptic(20); closeMenus();
  renderCarryBar();
  toast('Picked up — tap a track position or a slot, then “Place here”', 2600);
}
function renderCarryBar() {
  $$('.carry-bar').forEach((e) => e.remove()); $$('.carry-mark').forEach((e) => e.remove());
  if (!S.carry) { document.body.classList.remove('carrying'); return; }
  document.body.classList.add('carrying');
  const { src, target } = S.carry; const clip = src.kind === 'arr' ? src.c : src.t.slots[src.i];
  const where = !target ? 'Tap where it should go' : target.kind === 'arr' ? `${target.trackId ? track(target.trackId).name : 'New track'} · ${fmtPos(target.pos)}` : `${target.trackId ? track(target.trackId).name : 'New track'} · slot ${target.slot + 1}`;
  const bar = h('div', { class: 'carry-bar', role: 'status' },
    h('span', { class: 'carry-name', style: { '--c': src.t.color } }, icon('move'), ' ' + (clip ? clip.name || 'Clip' : 'Clip')), h('span', { class: 'carry-where' }, where),
    h('button', { class: 'primary carry-place', disabled: !target, onclick: () => { const c = S.carry; S.carry = null; renderCarryBar(); if (c && c.target) placeClip(c.src, c.target); } }, 'Place here'),
    h('button', { class: 'carry-cancel', onclick: () => { S.carry = null; renderCarryBar(); } }, 'Cancel'));
  document.body.append(bar);
  if (target && target.kind === 'arr' && target.lane && target.lane.isConnected) {
    const content = target.lane.closest('.arr-content'); if (content) content.append(h('div', { class: 'carry-mark', style: { left: target.pos * S.zoom + 'px', top: target.lane.offsetTop + 'px', height: target.lane.offsetHeight + 'px' } }));
  }
  if (target && target.kind === 'slot' && target.el && target.el.isConnected) target.el.classList.add('drop-target');
}
// while carrying, taps on lanes/slots choose the target instead of their normal action
document.addEventListener('click', (e) => {
  if (!S.carry || e.target.closest('.carry-bar, .views, #menu, .ctx-menu, dialog')) return;
  const t = dropTargetAt(e.clientX, e.clientY, 0, e); if (!t || t.kind === 'view') return;
  e.preventDefault(); e.stopPropagation();
  $$('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  S.carry.target = t; haptic(8); renderCarryBar();
}, true);
// ---- file drops onto session slots / empty session space
async function importAudioToSlot(files, trackId, slot) {
  let t = trackId ? track(trackId) : null; if (t && t.kind !== 'audio') t = null;
  let n = 0; const bufs = [];
  for (const f of files) { try { bufs.push([f, await decodeFile(f)]); } catch (e) { toast(`Could not decode ${f.name}: ${e.message || e}`); } }
  if (!bufs.length) return 0;
  history.push('Import audio');
  if (!t) t = newTrackFor(false, bufs[0][0].name.replace(/\.[^.]+$/, '').slice(0, 24));
  for (const [f, buf] of bufs) {
    const i = slot + n; while (t.slots.length <= i) t.slots.push(null); if (i >= S.project.scenes) S.project.scenes = i + 1;
    stopSlotIfPlaying(t, i);
    t.slots[i] = { bufferId: addBuffer(buf), name: f.name.replace(/\.[^.]+$/, '').slice(0, 32), loopLength: buf.duration }; n++;
  }
  S.sel = { kind: 'slot', trackId: t.id, slot }; S.selected = t.id; markDirty(); renderAll();
  toast(`Placed ${n} file(s) in ${t.name}, slot ${slot + 1}${n > 1 ? '…' + (slot + n) : ''}`);
  return n;
}
const isAudioFile = (f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|oga|flac|m4a|aac|webm|opus|aif|aiff)$/i.test(f.name);
function bindSessionDrop(root) {
  root.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy';
    $$('.drop-target').forEach((x) => x.classList.remove('drop-target')); const t = dropTargetAt(e.clientX, e.clientY); if (t && t.el) t.el.classList.add('drop-target'); } });
  root.addEventListener('dragleave', () => $$('.drop-target').forEach((x) => x.classList.remove('drop-target')));
  root.addEventListener('drop', async (e) => {
    $$('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    const proj = files.find((f) => /\.(auduio|webdaw|zip|json|enc)$/i.test(f.name)); if (proj) return importProject(proj);
    const audio = files.filter(isAudioFile); if (!audio.length) return toast('Drop audio files (wav, mp3, ogg, flac, m4a…)');
    await engine.resume();
    const t = dropTargetAt(e.clientX, e.clientY);
    await importAudioToSlot(audio, t && t.kind === 'slot' ? t.trackId : null, t && t.kind === 'slot' ? t.slot : 0);
  });
}

// ------------------------------------------------------------------ v0.3.1 audition (hear a clip the moment you touch it)
// Press = starts immediately through the track's effects (no quantize, transport untouched). Hold and release = stops.
// Quick tap = keeps playing until you tap it again (or tap another clip / press Esc / start the transport).
function startAudition(t, c, opts = {}) {
  const A = engine.auditionClip(t, c, opts); if (!A) return null;
  const tr = S.project.tracks, anySolo = tr.some((x) => x.solo);
  if (t.mute || (anySolo && !t.solo)) toast(`${t.name} is ${t.mute ? 'muted' : 'not soloed'} — unmute it to hear the preview`, 1800);
  return A;
}
function bindAudition(el, get) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || S.carry || e.target.closest('.slot-launch, button, input, select')) return;
    const g = get(); if (!g || !g.c || !g.c.bufferId) return;
    if (engine.audition && engine.audition.key === g.key) { engine.stopAudition(); return; } // second tap stops
    engine.resume(); if (!startAudition(g.t, g.c, { key: g.key })) return;
    const x0 = e.clientX, y0 = e.clientY, t0 = performance.now(), key = g.key;
    const done = () => { window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('pointermove', mv, true); };
    const mine = () => engine.audition && engine.audition.key === key;
    const up = () => { done(); if (mine() && performance.now() - t0 > 380) engine.stopAudition(); }; // held: stop on release; tap: latch
    const cancel = () => { done(); if (mine()) engine.stopAudition(); };
    const mv = (ev) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) cancel(); }; // turned into a drag / scroll
    window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cancel, true); window.addEventListener('pointermove', mv, true);
  });
}
engine.on('audition', (A) => {
  $$('.auditioning').forEach((e) => e.classList.remove('auditioning'));
  if (A && A.key) {
    const [kind, a, b] = A.key.split(':');
    const el = kind === 'slot' ? $(`#sessionView .col[data-id="${a}"] .slot[data-slot="${b}"]`) : kind === 'arr' ? $(`#arrangeView .aclip[data-clip="${a}"]`) : null;
    if (el) el.classList.add('auditioning');
  }
  $$('.preview-btn').forEach((b) => b.classList.toggle('on', !!(A && S.clipView && A.key === 'detail')));
  if (S.clipView && S.clipView.draw) S.clipView.draw();
});

// ------------------------------------------------------------------ device panel (compact cards, expand on demand)
const FX_COLORS = { pitch: '#3ecf8e', eq: '#8B5CF6', compressor: '#4a9cff', maximizer: '#6366F1', limiter: '#d36bff', distortion: '#EF4444', amp: '#F43F5E', delay: '#2fc6d6', reverb: '#14B8A6', chorus: '#60A5FA', autopan: '#A78BFA', tremolo: '#ff5fa2', rack: '#9aa4ad' };

// ------------------------------------------------------------------ clip detail view (bottom panel)
// Selecting an audio clip shows it here: large zoomable waveform, start/end (or loop) markers, gain,
// transpose (repitch), transient markers (the same detector Quantize uses) and the beat grid.
S.bottom = 'devices';
function syncBottomToSelection() {
  const key = S.sel ? JSON.stringify(S.sel) : '';
  if (key === S._selKey) return; S._selKey = key;
  const sc = selectedClip();
  if (sc && sc.c && sc.c.type !== 'midi' && sc.c.bufferId) { S.bottom = 'clip'; S.selected = sc.t.id; S.clipView = null; renderDevices(); }
  else if (S.bottom === 'clip') { S.bottom = 'devices'; renderDevices(); }
}
const transientCache = new WeakMap();
function transientsOf(buf) { let r = transientCache.get(buf); if (!r) { r = detectTransients(mixToMono(buf), buf.sampleRate).map((i) => i / buf.sampleRate); transientCache.set(buf, r); } return r; }
function bottomTabs(active) {
  const sc = selectedClip(); const canClip = sc && sc.c && sc.c.type !== 'midi' && sc.c.bufferId;
  return h('span', { class: 'bottom-tabs', role: 'tablist' },
    h('button', { class: 'small' + (active === 'clip' ? ' on' : ''), role: 'tab', disabled: !canClip, title: canClip ? 'Clip detail: waveform, markers, gain, transpose' : 'Select an audio clip to see its details', onclick: () => { S.bottom = 'clip'; renderDevices(); } }, 'Clip'),
    h('button', { class: 'small' + (active === 'devices' ? ' on' : ''), role: 'tab', title: 'Effects and instrument of the selected track', onclick: () => { S.bottom = 'devices'; renderDevices(); } }, 'Devices'));
}
function renderClipDetail(head, panel, sc) {
  const { t, c } = sc; const isArr = S.sel.kind === 'arr'; const buf = engine.buffers.get(c.bufferId);
  head.append(bottomTabs('clip'), h('span', { class: 'dev-title', style: { '--c': t.color } }, (c.name || 'Clip') + ' · ' + t.name));
  if (!buf) { panel.append(h('p', { class: 'hint' }, 'Audio not loaded.')); return; }
  const V = S.clipView && S.clipView.id === (c.id || c.bufferId) ? S.clipView : (S.clipView = { id: c.id || c.bufferId, v0: 0, v1: buf.duration, tr: prefs.showTransients !== false });
  const rate = () => Math.pow(2, (c.transpose || 0) / 12);
  const region = () => isArr ? [c.offset || 0, (c.offset || 0) + c.duration * rate()] : [c.loopStart || 0, (c.loopStart || 0) + (c.loopLength || buf.duration)];
  const live = (what) => { engine.updateClipLive(t, c, what); markDirty(); if (S.view === 'arrange') scheduleClipRedraw(); };
  const trBtn = h('button', { class: 'small' + (V.tr ? ' on' : ''), title: 'Show transient markers (the hits Quantize moves onto the grid)', onclick: () => { V.tr = !V.tr; prefs.showTransients = V.tr; savePrefs(); trBtn.classList.toggle('on', V.tr); draw(); } }, 'Transients');
  const prevBtn = h('button', { class: 'small preview-btn' + (engine.audition && engine.audition.c === c ? ' on' : ''), title: 'Preview this clip through the track (click again to stop). Tip: tap anywhere on the waveform to hear it from there.', 'aria-label': 'Preview clip',
    onclick: () => { if (engine.audition && engine.audition.c === c) engine.stopAudition(); else { engine.resume(); startAudition(t, c, { key: 'detail' }); } } }, icon('play'), ' Preview');
  const takesUI = isArr && c.takes && c.takes.length > 1 ? h('span', { class: 'takes', role: 'group', 'aria-label': 'Loop takes' }, h('span', { class: 'dim' }, 'Take'),
    c.takes.map((k, i) => h('button', { class: 'small take' + (i === (c.take || 0) ? ' on' : ''), 'aria-pressed': String(i === (c.take || 0)), title: `Use take ${i + 1} (${k.duration.toFixed(1)} s)`, onclick: () => useTake(t, c, i) }, String(i + 1)))) : null;
  head.append(...[prevBtn, takesUI, trBtn].filter(Boolean),
    h('button', { class: 'small', title: 'Quantize: move the hits onto the beat grid', onclick: () => quantizeDialog() }, 'Quantize…'),
    h('button', { class: 'small', title: 'Detect this clip\'s tempo (BPM)', onclick: () => clipTempoDialog(t, c, isArr ? 'arr' : 'slot') }, 'BPM…', lockBadge('tempo.detect')),
    h('button', { class: 'small', title: 'Zoom out', onclick: () => zoom(1.6) }, '−'), h('button', { class: 'small', title: 'Zoom in (or pinch / Ctrl+wheel)', onclick: () => zoom(1 / 1.6) }, '+'),
    h('button', { class: 'small', title: 'Show the whole sample', onclick: () => { V.v0 = 0; V.v1 = buf.duration; draw(); } }, 'Fit'),
    h('button', { class: 'collapse small', onclick: () => { $('#devicePanel').classList.toggle('collapsed'); }, title: 'Show/hide the panel', 'aria-label': 'Show or hide the panel' }, icon('chevDown')));
  const ctrls = h('div', { class: 'clip-ctrls' });
  const gainK = createKnob({ key: 'gain', label: 'Gain', min: -24, max: 24, def: 0, unit: 'dB', help: 'Clip volume' }, c.gain || 0, (v) => { history.push('Clip gain', 'cg' + (c.id || c.bufferId)); c.gain = v; live('gain'); draw(); });
  const st = Math.round(c.transpose || 0), ct = Math.round(((c.transpose || 0) - st) * 100);
  const trK = createKnob({ key: 'transpose', label: 'Transpose', min: -24, max: 24, def: 0, step: 1, unit: 'st', help: 'Repitch in semitones (pitch and speed change together, like a tape)' }, st, (v) => { history.push('Transpose', 'tp' + (c.id || c.bufferId)); c.transpose = Math.round(v) + (Math.round(((c.transpose || 0) - Math.round(c.transpose || 0)) * 100)) / 100; live('transpose'); draw(); });
  const dtK = createKnob({ key: 'detune', label: 'Detune', min: -50, max: 50, def: 0, step: 1, unit: 'ct', help: 'Fine repitch in cents' }, ct, (v) => { history.push('Detune', 'dt' + (c.id || c.bufferId)); c.transpose = Math.round(c.transpose || 0) + Math.round(v) / 100; live('transpose'); draw(); });
  const info = h('div', { class: 'clip-info hint' });
  // exact numbers (seconds with ms precision; fades in ms). Enter or leaving the field applies it.
  const numF = (label, val, field, { scale = 1, step = 0.001, title } = {}) => h('label', { class: 'cnum', title },
    h('span', {}, label), h('input', { type: 'number', step, min: 0, value: String(Math.round(val * scale * 1000) / 1000), 'data-field': field,
      onchange: (e) => { const v = parseFloat(e.target.value); if (!isFinite(v)) return; if (isArr) setClipNumber(t, c, field, v / scale); else setSlotLoop(field, v / scale); } }));
  const setSlotLoop = (field, v) => { change('Loop markers', () => { if (field === 'loopStart') { const end = (c.loopStart || 0) + (c.loopLength || buf.duration); c.loopStart = Math.max(0, Math.min(buf.duration - 0.005, v)); c.loopLength = Math.max(0.005, Math.min(buf.duration - c.loopStart, end - c.loopStart)); } else c.loopLength = Math.max(0.005, Math.min(buf.duration - (c.loopStart || 0), v)); }); live('loop'); renderDevices(); };
  const nums = h('div', { class: 'clip-nums', role: 'group', 'aria-label': 'Exact clip numbers' },
    isArr ? [numF('Position s', c.start, 'start', { title: 'Where the clip starts on the timeline (seconds). ' + fmtPos(c.start) }),
      numF('Length s', c.duration, 'duration', { title: 'Clip length on the timeline (seconds)' }),
      numF('Offset s', c.offset || 0, 'offset', { title: 'Where playback starts inside the audio file (seconds)' }),
      numF('Fade in ms', c.fadeIn || 0, 'fadeIn', { scale: 1000, step: 0.1, title: 'Fade in length (milliseconds). Also: drag the small handle at the clip\'s top-left corner.' }),
      numF('Fade out ms', c.fadeOut || 0, 'fadeOut', { scale: 1000, step: 0.1, title: 'Fade out length (milliseconds). Also: drag the handle at the top-right corner.' })]
      : [numF('Loop start s', c.loopStart || 0, 'loopStart', { title: 'Loop start inside the audio file (seconds)' }), numF('Loop length s', c.loopLength || buf.duration, 'loopLength', { title: 'Loop length (seconds)' })]);
  ctrls.append(gainK, trK, dtK, nums, info);
  const wrap = h('div', { class: 'clip-wave-wrap' });
  const wave = h('canvas', { class: 'clip-wave' }), over = h('canvas', { class: 'clip-over' });
  wrap.append(wave, over);
  panel.append(h('div', { class: 'clip-detail' }, ctrls, wrap));
  const minSpan = Math.min(buf.duration, 32 / buf.sampleRate); // deepest zoom: 32 samples across the view
  function zoom(f, at = 0.5) { const span = V.v1 - V.v0, c0 = V.v0 + span * at; const ns = Math.max(minSpan, Math.min(buf.duration, span * f)); V.v0 = Math.max(0, Math.min(buf.duration - ns, c0 - ns * at)); V.v1 = V.v0 + ns; draw(); }
  const tx = (sec) => (sec - V.v0) / (V.v1 - V.v0) * wrap.clientWidth;
  const sx = (x) => V.v0 + x / Math.max(1, wrap.clientWidth) * (V.v1 - V.v0);
  function draw() {
    if (!wrap.isConnected) return;
    drawWaveform(wave, buf, { startSec: V.v0, endSec: V.v1, color: t.color, bg: '#101013', gain: dbToGain(c.gain) });
    const dpr = devicePixelRatio || 1, w = Math.round(wrap.clientWidth * dpr), hh = Math.round(wrap.clientHeight * dpr);
    if (over.width !== w) over.width = w; if (over.height !== hh) over.height = hh;
    const g = over.getContext('2d'); g.clearRect(0, 0, w, hh); g.save(); g.scale(dpr, dpr);
    const W = wrap.clientWidth, H = wrap.clientHeight, [a, b] = region();
    // beat grid (project tempo, relative to the region start as it sits on the timeline)
    const beatBuf = engine.beatDur * rate(); const bpb = S.project.beatsPerBar || 4;
    if ((V.v1 - V.v0) / beatBuf < 400) for (let k = Math.floor((V.v0 - a) / beatBuf); a + k * beatBuf < V.v1; k++) { const x = tx(a + k * beatBuf); g.fillStyle = k % bpb === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.06)'; g.fillRect(Math.round(x), 0, 1, H); }
    // outside the played region
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, Math.max(0, tx(a)), H); g.fillRect(tx(b), 0, W, H);
    if (V.tr) { g.fillStyle = 'rgba(221,214,254,.75)'; for (const s of transientsOf(buf)) { if (s < V.v0 || s > V.v1) continue; const x = tx(s); g.fillRect(Math.round(x), 0, 1, H); g.beginPath(); g.moveTo(x - 4, 0); g.lineTo(x + 4, 0); g.lineTo(x, 6); g.fill(); } }
    const flag = (x, col, label, right) => { g.fillStyle = col; g.fillRect(Math.round(x) - 1, 0, 2, H); g.beginPath(); if (right) { g.moveTo(x, 0); g.lineTo(x - 12, 0); g.lineTo(x, 12); } else { g.moveTo(x, 0); g.lineTo(x + 12, 0); g.lineTo(x, 12); } g.fill(); g.font = '10px sans-serif'; g.fillText(label, right ? x - 34 : x + 14, 10); };
    if (isArr && (c.fadeIn || c.fadeOut)) { const r0 = rate(); g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1; g.beginPath();
      if (c.fadeIn) { g.moveTo(tx(a), H); g.lineTo(tx(a + c.fadeIn * r0), 0); } if (c.fadeOut) { g.moveTo(tx(b - c.fadeOut * r0), 0); g.lineTo(tx(b), H); } g.stroke(); }
    flag(tx(a), '#A78BFA', isArr ? 'Start' : 'Loop', false); flag(tx(b), '#EF4444', isArr ? 'End' : 'Loop end', true);
    // playhead
    const n = engine.tracks.get(t.id); let ph = null;
    if (engine.playing) {
      if (isArr) { const p = engine.position(); if (p >= c.start && p < c.start + c.duration) ph = (c.offset || 0) + (p - c.start) * rate(); }
      else if (n && n.sessionSource && n.sessionSource._clip === c) { const L = b - a, el = (engine.ctx.currentTime - n.sessionStart) * rate(); if (el >= 0) ph = a + (el % L); }
    }
    if (ph != null && ph >= V.v0 && ph <= V.v1) { g.fillStyle = '#fff'; g.fillRect(Math.round(tx(ph)), 0, 1.5, H); }
    if (engine.audition && engine.audition.c === c) { const ap = engine.auditionPos(); if (ap != null && ap >= V.v0 && ap <= V.v1) { g.fillStyle = '#EF4444'; g.fillRect(Math.round(tx(ap)), 0, 2, H); } }
    g.restore();
    const spp = (V.v1 - V.v0) * buf.sampleRate / Math.max(1, W);
    info.dataset.spp = spp.toFixed(3);
    info.textContent = (spp < 4 ? `Sample view (${spp < 1 ? (1 / spp).toFixed(1) + ' px per sample' : spp.toFixed(1) + ' samples per px'}) · ` : '') + `${isArr ? 'Start' : 'Loop'} ${a.toFixed(3)} s · ${isArr ? 'End' : 'Length'} ${(isArr ? b : b - a).toFixed(3)} s · ${buf.numberOfChannels > 1 ? 'Stereo' : 'Mono'} ${Math.round(buf.sampleRate / 100) / 10} kHz${c.bpm ? ' · ' + c.bpm + ' BPM' : ''}${c.transpose ? ' · repitch ' + (c.transpose > 0 ? '+' : '') + c.transpose.toFixed(2) + ' st' : ''}`;
  }
  V.draw = draw;
  // interaction: drag markers, pan, wheel/pinch zoom, double-tap = fit
  const pts = new Map(); let drag = null, pinch = null, lastTap = 0;
  over.addEventListener('pointerdown', (e) => {
    over.setPointerCapture(e.pointerId); pts.set(e.pointerId, e.offsetX);
    if (pts.size === 2) { const [p1, p2] = [...pts.values()]; pinch = { d: Math.abs(p1 - p2) || 1, v0: V.v0, v1: V.v1, mid: sx((p1 + p2) / 2) }; drag = null; return; }
    const [a, b] = region(), x = e.offsetX;
    if (Date.now() - lastTap < 300) { V.v0 = 0; V.v1 = buf.duration; draw(); lastTap = 0; return; } lastTap = Date.now();
    if (Math.abs(x - tx(a)) < 10) drag = { m: 'start' }; else if (Math.abs(x - tx(b)) < 10) drag = { m: 'end' };
    else drag = { m: 'pan', x, v0: V.v0, v1: V.v1, t0: performance.now(), moved: false };
    if (drag.m !== 'pan') history.push(isArr ? 'Clip markers' : 'Loop markers', 'mk' + (c.id || c.bufferId));
  });
  over.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) { const [a, b] = region(); over.style.cursor = Math.abs(e.offsetX - tx(a)) < 10 || Math.abs(e.offsetX - tx(b)) < 10 ? 'ew-resize' : 'grab'; return; }
    pts.set(e.pointerId, e.offsetX);
    if (pinch && pts.size === 2) { const [p1, p2] = [...pts.values()]; const f = pinch.d / (Math.abs(p1 - p2) || 1); const span = Math.max(minSpan, Math.min(buf.duration, (pinch.v1 - pinch.v0) * f)); V.v0 = Math.max(0, Math.min(buf.duration - span, pinch.mid - span / 2)); V.v1 = V.v0 + span; draw(); return; }
    if (!drag) return;
    const sec = Math.max(0, Math.min(buf.duration, sx(e.offsetX)));
    if (drag.m === 'pan' && Math.abs(e.offsetX - drag.x) > 4) drag.moved = true;
    if (drag.m === 'pan') { const d = (e.offsetX - drag.x) / wrap.clientWidth * (drag.v1 - drag.v0); const span = drag.v1 - drag.v0; V.v0 = Math.max(0, Math.min(buf.duration - span, drag.v0 - d)); V.v1 = V.v0 + span; draw(); return; }
    const r = rate();
    if (isArr) {
      if (drag.m === 'start') { const end = (c.offset || 0) + c.duration * r; const ns = Math.min(sec, end - 0.001); const dOff = ns - (c.offset || 0); c.start = Math.max(0, c.start + dOff / r); c.offset = ns; c.duration = (end - ns) / r; }
      else { const ne = Math.max(sec, (c.offset || 0) + 0.001); c.duration = (ne - (c.offset || 0)) / r; }
      engine.rescheduleTrack(t); if (S.view === 'arrange') { const el = $(`#arrangeView .aclip[data-clip="${c.id}"]`); if (el) { el.style.left = c.start * S.zoom + 'px'; el.style.width = Math.max(4, c.duration * S.zoom) + 'px'; drawArrClip(el); } }
    } else {
      if (drag.m === 'start') { const end = (c.loopStart || 0) + (c.loopLength || buf.duration); const ns = Math.min(sec, end - 0.01); c.loopStart = ns; c.loopLength = end - ns; }
      else { c.loopLength = Math.max(0.01, sec - (c.loopStart || 0)); }
      live('loop');
    }
    markDirty(); draw();
  });
  const up = (e) => {
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (drag && drag.m !== 'pan' && !isArr) renderSession();
    // a tap (no drag) on the waveform auditions from that point; tapping while it plays stops it
    if (drag && drag.m === 'pan' && !drag.moved && e.type === 'pointerup' && performance.now() - drag.t0 < 400) {
      if (engine.audition && engine.audition.c === c) engine.stopAudition(); else { engine.resume(); startAudition(t, c, { from: sx(e.offsetX), loop: false, key: 'detail' }); }
    }
    drag = null;
  };
  over.addEventListener('pointerup', up); over.addEventListener('pointercancel', up);
  over.addEventListener('wheel', (e) => { e.preventDefault(); if (e.ctrlKey || e.metaKey || !e.shiftKey) zoom(e.deltaY > 0 ? 1.25 : 0.8, e.offsetX / wrap.clientWidth); else { const span = V.v1 - V.v0, d = e.deltaY / wrap.clientWidth * span; V.v0 = Math.max(0, Math.min(buf.duration - span, V.v0 + d)); V.v1 = V.v0 + span; draw(); } }, { passive: false });
  new ResizeObserver(() => draw()).observe(wrap);
  requestAnimationFrame(draw);
}

function renderDevices() {
  const panel = $('#devices'); panel.innerHTML = '';
  const isMaster = S.selected === 'master';
  const t = isMaster ? null : track(S.selected);
  const head = $('#devHead'); head.innerHTML = '';
  if (!isMaster && !t) return;
  if (S.bottom === 'clip') { const sc = selectedClip(); if (sc && sc.c && sc.c.type !== 'midi' && sc.c.bufferId) { $('#devicePanel').classList.add('clip-mode'); return renderClipDetail(head, panel, sc); } S.bottom = 'devices'; }
  $('#devicePanel').classList.remove('clip-mode');
  head.append(bottomTabs('devices'));
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
  } }, h('option', { value: '' }, '+ FX'), Object.entries(EFFECT_TYPES).filter(([k]) => k !== 'rack').map(([k, C]) => h('option', { value: k }, C.label + (allowed('fx.' + k) ? '' : ` (${tierShort('fx.' + k)} tier)`))),
    h('optgroup', { label: 'Racks' + (allowed('fx.rack') ? '' : ` (${tierShort('fx.rack')} tier)`) }, Object.keys(allRackPresets()).map((n) => h('option', { value: 'rack:' + n }, 'Rack: ' + n))));
  head.append(add);
  if (t && t.kind === 'midi') head.append(h('select', { class: 'add-midifx', title: 'Add a MIDI effect in front of the instrument (arpeggiator, chord, scale...)', onchange: (e) => {
    const v = e.target.value; e.target.value = ''; if (v) addMidiFx(t, v);
  } }, h('option', { value: '' }, '+ MIDI FX'), Object.entries(MIDI_FX_TYPES).map(([k, C]) => h('option', { value: k }, C.label))));
  head.append(h('span', { class: 'rand-group', title: 'Randomizer' },
    h('button', { class: 'small rand-chain', title: 'Randomize every effect in this chain (musical mode keeps levels safe; Ctrl/Cmd+Z undoes)', onclick: () => randomizeScope(tid, 'chain') }, icon('dice'), 'Chain'),
    isMaster ? null : h('button', { class: 'small rand-track', title: 'Randomize the whole track: MIDI effects, instrument and effects', onclick: () => randomizeScope(tid, 'track') }, icon('dice'), 'Track')));
  head.append(h('button', { class: 'small learn-btn adv' + (S.learn.active ? ' on' : ''), title: 'MIDI Learn: tap this, tap a knob, then move a knob/fader on your MIDI controller', onclick: toggleLearn }, 'Learn'));
  head.append(h('button', { class: 'collapse small', onclick: () => { $('#devicePanel').classList.toggle('collapsed'); }, title: 'Show/hide the device panel', 'aria-label': 'Show or hide the device panel' }, icon('chevDown')));

  if (t && t.kind === 'midi') {
    (t.midiFx || []).forEach((d, i) => panel.append(midiFxCard(t, i)));
    const native = S.pluginApi && S.pluginApi.isNative(t);
    if (!native) panel.append(instrumentCard(t));
    if (t.plugins && S.pluginApi) t.plugins.forEach((e, i) => panel.append(pluginCard(S.pluginApi, t, i, pluginUi)));
    else if (t.plugins) panel.append(h('div', { class: 'device pl-missing', title: pluginSupport().reason }, h('div', { class: 'dev-bar' }, h('span', { class: 'dev-kind' }, icon('plug')), h('span', { class: 'dev-name' }, t.plugins.map((e) => e.name).join(', '))),
      h('div', { class: 'dev-body' }, h('div', { class: 'pl-status' }, 'Plugins on this track need the Auduio desktop app. They are kept in the project and play again there.'))));
    if (native && fxList.length) panel.append(h('div', { class: 'pl-note', title: 'Plugin tracks render in the native engine and play straight to the audio device.' }, 'Built-in effects after a plugin instrument are bypassed (the plugin plays in the native engine). Use plugin effects here instead.'));
  }
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
  const C = EFFECT_TYPES[d.type]; const color = FX_COLORS[d.type] || '#8B5CF6';
  const ekey = `${tid}:${idx}:${d.type}`; const expanded = S.expanded.has(ekey);
  const rebuild = (label, mut) => { change(label, () => { mut(); tid === 'master' ? engine.setMasterFx(fxList) : engine.setTrackFx(t); }); renderDevices(); };
  const card = h('div', { class: 'device' + (d.enabled === false ? ' off' : '') + (expanded ? ' expanded' : ''), 'data-type': d.type, style: { '--fx': color }, title: EFFECT_HELP[d.type] || C.label });
  card.append(h('div', { class: 'dev-bar' },
    h('button', { class: 'pwr' + (d.enabled !== false ? ' on' : ''), title: 'On/off (bypass)', onclick: (e) => { change('Bypass', () => { d.enabled = d.enabled === false; engine.setFxEnabled(tid, idx, d.enabled); }); card.classList.toggle('off', !d.enabled); e.currentTarget.classList.toggle('on', d.enabled); haptic(8); } }, icon('power')),
    h('span', { class: 'dev-name' }, C.label),
    h('button', { class: 'adv', title: 'Move left', onclick: () => { if (idx > 0) rebuild('Move effect', () => { [fxList[idx - 1], fxList[idx]] = [fxList[idx], fxList[idx - 1]]; }); } }, '‹'),
    h('button', { class: 'adv', title: 'Move right', onclick: () => { if (idx < fxList.length - 1) rebuild('Move effect', () => { [fxList[idx + 1], fxList[idx]] = [fxList[idx], fxList[idx + 1]]; }); } }, '›'),
    ...randButtons(() => fxTargets(tid, fxList, idx), tid),
    h('button', { class: 'expand', title: expanded ? 'Collapse (show main controls only)' : 'Expand (all controls + bigger display)', onclick: () => { expanded ? S.expanded.delete(ekey) : S.expanded.add(ekey); renderDevices(); } }, icon(expanded ? 'chevUp' : 'chevDown')),
    h('button', { class: 'rm', title: 'Remove effect', 'aria-label': 'Remove effect', onclick: () => rebuild('Remove effect', () => fxList.splice(idx, 1)) }, icon('close'))));
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
    markLock(el, d, p.key);
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
    A.gains.forEach((v, i) => { const y = (v / 6) * (hh / 2) * 0.9; g.fillStyle = v >= 0 ? '#3ecf8e' : '#EF4444'; g.fillRect(i * bw + bw * 0.2, hh / 2 - Math.max(0, y), bw * 0.6, Math.abs(y) || 1);
      g.fillStyle = '#9aa4ad'; g.font = `${9 * devicePixelRatio}px sans-serif`; g.fillText(BANDS[i].name.slice(0, 5), i * bw + 2, hh - 2); });
  });
  card.append(h('div', { class: 'dev-bar' }, h('button', { class: 'pwr on', title: 'Turn adaptive off', onclick: () => { change('Adaptive', () => { t.adaptive.enabled = false; engine.syncAdaptive(t); }); renderDevices(); } }, icon('power')), h('span', { class: 'dev-name' }, 'Adaptive · ' + INSTRUMENT_LABELS[t.instrument || 'other'])),
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
    } }, ['synth', 'wavetable'].map((k) => h('option', { value: k }, INSTRUMENT_TYPES[k].label + (allowed('inst.' + k) ? '' : ' (locked)'))));
    ts.value = type; bar.append(ts);
    if (C.presets) bar.append(h('select', { class: 'inst-preset', title: 'Synth preset', onchange: (e) => { const nm = e.target.value; e.target.value = ''; if (nm && I) { change('Synth preset', () => I.applyPreset(nm)); renderDevices(); } } },
      h('option', { value: '' }, 'Preset…'), Object.keys(C.presets).map((k) => h('option', { value: k }, k))));
    if (!allowed('inst.' + type)) bar.append(lockBadge('inst.' + type));
  }
  bar.append(...randButtons(() => [instTarget(t)].filter(Boolean), t.id));
  bar.append(h('button', { class: 'expand', title: expanded ? 'Collapse' : 'Expand (all controls)', onclick: () => { expanded ? S.expanded.delete(ekey) : S.expanded.add(ekey); renderDevices(); } }, icon(expanded ? 'chevUp' : 'chevDown')));
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
  if (type === 'drums') { /* 128-pad drum rack (ui/drumrack.js) */ }
  else {
    const base = S.kbdOct || 48;
    for (let i = 0; i < (expanded ? 25 : 13); i++) { const nn = base + i; const black = [1, 3, 6, 8, 10].includes(nn % 12); const k = h('button', { class: 'key' + (black ? ' black' : ''), title: noteName(nn) }); bindPad(k, nn); pads.append(k); }
    const wheel = (label, cls, min, onV, spring) => { const r = h('input', { type: 'range', class: 'wheel ' + cls, min, max: 1, step: 0.01, value: spring ? 0 : (I ? I.modWheelValue : 0), title: label, 'aria-label': label, orient: 'vertical' });
      r.addEventListener('input', () => { if (I) onV(+r.value); }); if (spring) { const back = () => { r.value = 0; if (I) onV(0); }; r.addEventListener('pointerup', back); r.addEventListener('change', back); } return r; };
    body.append(h('div', { class: 'kbd-row' },
      h('div', { class: 'oct' }, h('button', { title: 'Octave down', onclick: () => { S.kbdOct = Math.max(24, (S.kbdOct || 48) - 12); renderDevices(); } }, '−'), h('span', {}, noteName(S.kbdOct || 48)), h('button', { title: 'Octave up', onclick: () => { S.kbdOct = Math.min(84, (S.kbdOct || 48) + 12); renderDevices(); } }, '+')),
      wheel('Pitch bend (±2 semitones, springs back)', 'bend', -1, (v) => I.pitchBend(v), true), wheel('Mod wheel (vibrato)', 'mod', 0, (v) => I.modWheel(v), false), pads));
  }
  if (type === 'drums') body.append(h('div', { class: 'dr-wrap' }, drumRack.rack(t, false), drumRack.editor(t, false)));
  const knobs = h('div', { class: 'knobs' });
  for (const p of C.params) {
    if (!expanded && !p.easy) continue;
    const onC = (v) => setParam(t.id, 'inst', p.key, v);
    const el = p.type === 'select' ? selectParam(p, I ? I.values[p.key] : p.def, onC) : knobFor(t.id, 'inst', p, I ? I.values[p.key] : p.def, onC, C.label);
    markLock(el, t.inst, p.key);
    if (!p.easy) el.classList.add('adv');
    knobs.append(el);
  }
  body.append(knobs); card.append(body);
  return card;
}

// ------------------------------------------------------------------ MIDI effects (in front of the instrument)
function addMidiFx(t, type, at) {
  if (!t || t.kind !== 'midi' || !MIDI_FX_TYPES[type]) return false;
  if ((t.midiFx || []).length >= 8) { toast('Up to 8 MIDI effects per track.'); return false; }
  change('Add ' + MIDI_FX_TYPES[type].label, () => { t.midiFx = t.midiFx || []; t.midiFx.splice(at == null ? t.midiFx.length : at, 0, midiFxDefaults(type)); engine.setMidiFx(t); });
  S.expanded.add(`${t.id}:mfx${t.midiFx.length - 1}:${type}`); renderDevices();
  return true;
}
function midiFxCard(t, idx) {
  const d = t.midiFx[idx], C = MIDI_FX_TYPES[d.type], color = '#EF4444';
  const ekey = `${t.id}:mfx${idx}:${d.type}`, expanded = S.expanded.has(ekey);
  const rebuild = (label, mut) => { change(label, () => { mut(); engine.setMidiFx(t); }); renderDevices(); };
  const card = h('div', { class: 'device midifx' + (d.enabled === false ? ' off' : '') + (expanded ? ' expanded' : ''), 'data-type': d.type, style: { '--fx': color }, title: MIDI_FX_HELP[d.type] || C.label });
  card.append(h('div', { class: 'dev-bar' },
    h('button', { class: 'pwr' + (d.enabled !== false ? ' on' : ''), title: 'On/off (bypass)', onclick: () => rebuild('Bypass', () => { d.enabled = d.enabled === false; }) }, icon('power')),
    h('span', { class: 'dev-kind', title: 'MIDI effect' }, icon('midi')), h('span', { class: 'dev-name' }, C.label),
    h('button', { class: 'adv', title: 'Move left', onclick: () => { if (idx > 0) rebuild('Move MIDI effect', () => { const L = t.midiFx; [L[idx - 1], L[idx]] = [L[idx], L[idx - 1]]; }); } }, '‹'),
    h('button', { class: 'adv', title: 'Move right', onclick: () => { if (idx < t.midiFx.length - 1) rebuild('Move MIDI effect', () => { const L = t.midiFx; [L[idx + 1], L[idx]] = [L[idx], L[idx + 1]]; }); } }, '›'),
    ...randButtons(() => [midiFxTarget(t, idx)], t.id),
    h('button', { class: 'expand', title: expanded ? 'Collapse' : 'Expand (all controls)', onclick: () => { expanded ? S.expanded.delete(ekey) : S.expanded.add(ekey); renderDevices(); } }, icon(expanded ? 'chevUp' : 'chevDown')),
    h('button', { class: 'rm', title: 'Remove MIDI effect', 'aria-label': 'Remove MIDI effect', onclick: () => rebuild('Remove MIDI effect', () => t.midiFx.splice(idx, 1)) }, icon('close'))));
  const knobs = h('div', { class: 'knobs' });
  for (const p of C.params) {
    if (!expanded && !p.easy) continue;
    const onC = (v) => { history.push('Change ' + p.label, `mfx:${t.id}:${idx}:${p.key}`); d.values[p.key] = v; markDirty(); if (p.key === 'keySource') renderDevices(); };
    const el = p.type === 'select' ? selectParam(p, d.values[p.key], onC) : createKnob(p, d.values[p.key], onC);
    if (d.type === 'scale' && (p.key === 'root') && d.values.keySource !== 'manual') el.classList.add('dim');
    markLock(el, d, p.key);
    if (!p.easy) el.classList.add('adv');
    knobs.append(el);
  }
  if (d.type === 'scale' || d.type === 'random' || (d.type === 'chord' && d.values.fit === 'on')) knobs.prepend(h('div', { class: 'pitch-key', title: 'Song key (tap to change)', onclick: (e) => keyPopover(e.currentTarget) }, d.type === 'scale' && d.values.keySource === 'manual' ? `${d.values.root} ${d.values.scale}` : keyName(S.project.key)));
  card.append(h('div', { class: 'dev-body' }, knobs));
  return card;
}

// Everything a sequencer step can p-lock on a track: instrument, audio effects, hosted plugin parameters.
function paramCatalog(t) {
  const out = [], add = (fx, dev, p, value) => out.push({ fx, key: String(p.key), label: `${dev}: ${p.label}`, min: p.min, max: p.max, def: p.def, type: p.type, options: p.options, value: value != null ? value : p.def,
    fmt: (v) => (p.type === 'select' ? String(v) : fmtParam(p, v)) });
  const native = S.pluginApi && S.pluginApi.isNative(t);
  if (t.kind === 'midi' && t.inst && !native) { const C = INSTRUMENT_TYPES[t.inst.type], n = engine.tracks.get(t.id); if (C) C.params.forEach((p) => add('inst', C.label, p, n && n.inst && n.inst.values ? n.inst.values[p.key] : t.inst.values[p.key])); }
  if (!native) (t.fx || []).forEach((d, i) => { const C = EFFECT_TYPES[d.type]; if (C && d.type !== 'rack') C.params.forEach((p) => add(i, C.label, p, d.values[p.key])); });
  if (t.plugins && S.pluginApi) for (const e of t.plugins) { const r = S.pluginApi.rt.get(e.id); if (!r) continue;
    S.pluginApi.visibleParams(e.id).slice(0, 256).forEach((p) => out.push({ fx: 'plugin:' + e.id, key: String(p.i), label: `${e.name}: ${p.name}`, min: 0, max: 1, def: p.def, value: e.values[p.i] ?? r.values[p.i] ?? p.def, fmt: (v) => (+v).toFixed(2) })); }
  return out;
}
// ------------------------------------------------------------------ randomizer (every device: instruments, MIDI fx, audio fx, racks, plugins)
// A target = one device: its parameter definitions, the object that stores its values + locks, and a setter.
function instTarget(t) {
  const n = engine.tracks.get(t.id); if (!n || !n.inst || !t.inst) return null; const C = INSTRUMENT_TYPES[t.inst.type];
  return { label: C.label, type: t.inst.type, defs: C.params, holder: t.inst, values: () => n.inst.values, set: (k, v) => n.inst.set(k, v) };
}
function midiFxTarget(t, i) { const d = t.midiFx[i], C = MIDI_FX_TYPES[d.type]; return { label: C.label, type: d.type, defs: C.params, holder: d, values: () => d.values, set: (k, v) => { d.values[k] = v; } }; }
function fxTargets(tid, list, idx) {
  const d = list[idx]; if (!d) return []; const C = EFFECT_TYPES[d.type], I = engine.fxInstances(tid)[idx];
  const out = [];
  if (d.type === 'rack' && I && I.chains) {
    d.chains.forEach((c, ci) => c.fx.forEach((fd, fi) => { const inner = I.chains[ci] && I.chains[ci].fx[fi]; if (!inner) return;
      out.push({ label: `${C.label} ${c.name}: ${EFFECT_TYPES[fd.type].label}`, type: fd.type, defs: EFFECT_TYPES[fd.type].params, holder: fd, values: () => inner.values, set: (k, v) => { inner.set(k, v); fd.values = inner.values; } }); }));
  }
  out.push({ label: C.label, type: d.type, defs: C.params, holder: d, values: () => d.values, set: (k, v) => engine.setFxParam(tid, idx, k, v) });
  return out;
}
function scopeTargets(tid, scope) {
  const isM = tid === 'master', t = isM ? null : track(tid), list = isM ? S.project.master.fx : t ? t.fx : [];
  const out = [];
  if (scope === 'track' && t && t.kind === 'midi') { (t.midiFx || []).forEach((d, i) => out.push(midiFxTarget(t, i))); const it = instTarget(t); if (it) out.push(it); }
  if (t && t.plugins && S.pluginApi) t.plugins.forEach((e) => { if (scope === 'track' || !e.instrument) out.push(S.pluginApi.target(t, e.id)); });
  list.forEach((d, i) => out.push(...fxTargets(tid, list, i)));
  if (scope === 'track' && t && t.seq && seqView) out.unshift(seqView.target(t));
  return out.filter(Boolean);
}
const randSettings = () => ({ amount: Math.max(0, Math.min(100, prefs.randAmount == null ? 50 : +prefs.randAmount)) / 100, mode: prefs.randMode === 'chaos' ? 'chaos' : 'musical' });
// One undo step per randomize. Locked params are never touched; musical mode keeps output levels.
function randomizeTargets(targets, label) {
  targets = targets.filter(Boolean);
  if (!targets.length) { toast('Nothing to randomize here.'); return 0; }
  if (!gate('randomize', 'Randomizer')) return 0;
  const o = randSettings(), plan = [];
  for (const T of targets) { const ch = T.plan ? T.plan(o) : randomizeValues(T.defs, T.values(), { ...o, locks: T.holder.locks, deviceType: T.type }); if (Object.keys(ch).length) plan.push([T, ch]); }
  const n = plan.reduce((a, [, ch]) => a + Object.keys(ch).length, 0);
  if (!n) { toast(o.amount ? 'Nothing changed: all parameters are locked.' : 'Amount is 0 %: nothing to change.'); return 0; }
  for (const [T, ch] of plan) if (T.prepare) T.prepare(Object.keys(ch)); // plugins: remember old values so undo can restore them
  change(label, () => { for (const [T, ch] of plan) { for (const [k, v] of Object.entries(ch)) T.set(k, v); if (T.commit) T.commit(); } });
  renderDevices(); haptic(12); if (seqView && plan.some(([T]) => T.type === 'seq')) seqView.render();
  $$('#devices .device').forEach((c) => { c.classList.remove('rand-flash'); void c.offsetWidth; c.classList.add('rand-flash'); });
  toast(`${label}: ${n} parameter${n === 1 ? '' : 's'} changed${o.mode === 'musical' ? ' (musical)' : ''}. Undo: Ctrl/Cmd+Z`, 2600);
  return n;
}
function randomizeScope(tid, scope) {
  const t = tid === 'master' ? null : track(tid);
  return randomizeTargets(scopeTargets(tid, scope), scope === 'track' ? `Randomize track ${t ? t.name : ''}`.trim() : 'Randomize chain');
}
function randButtons(getTargets, tid) {
  const go = () => { const T = getTargets(); randomizeTargets(T, 'Randomize ' + (T[T.length - 1] ? T[T.length - 1].label : 'device')); };
  return [
    h('button', { class: 'rand-btn', title: 'Randomize this device (musical: keeps volume safe). Ctrl/Cmd+Z undoes. Arrow: amount, locks, chain/track.', 'aria-label': 'Randomize device', onclick: go }, icon('dice')),
    h('button', { class: 'rand-more', title: 'Randomizer options: amount, musical/chaos, lock parameters', 'aria-label': 'Randomizer options', onclick: (e) => randPopover(e.currentTarget, getTargets, tid, go) }, icon('chevDown')),
  ];
}
function toggleLock(holder, key) {
  const L = new Set(holder.locks || []); L.has(key) ? L.delete(key) : L.add(key);
  if (L.size) holder.locks = [...L]; else delete holder.locks;
  markDirty();
}
function markLock(el, holder, key) {
  if (!holder || !(holder.locks || []).includes(key)) return el;
  el.classList.add('rlocked');
  el.append(h('button', { class: 'rlock-ico', title: 'Locked: the randomizer leaves this alone. Click to unlock.', 'aria-label': 'Unlock parameter', onclick: (e) => { e.stopPropagation(); toggleLock(holder, key); renderDevices(); } }, icon('lock')));
  return el;
}
function randPopover(anchor, getTargets, tid, go) {
  closeMenus();
  const targets = getTargets(), main = targets[targets.length - 1]; if (!main) return;
  const set = randSettings();
  const pct = h('span', { class: 'rp-val' }, Math.round(set.amount * 100) + ' %');
  const amt = h('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round(set.amount * 100), 'aria-label': 'Randomize amount', class: 'rp-amount',
    oninput: (e) => { prefs.randAmount = +e.target.value; pct.textContent = e.target.value + ' %'; savePrefs(); } });
  const hint = h('p', { class: 'hint rp-hint' });
  const modeBtn = (m, label) => h('button', { class: 'rp-mode' + (set.mode === m ? ' on' : ''), 'data-mode': m, 'aria-pressed': String(set.mode === m), onclick: (e) => {
    prefs.randMode = m; savePrefs(); $$('.rp-mode', pop).forEach((b) => { b.classList.toggle('on', b.dataset.mode === m); b.setAttribute('aria-pressed', String(b.dataset.mode === m)); }); showHint(); } }, label);
  const showHint = () => { hint.textContent = (prefs.randMode === 'chaos') ? 'Chaos: everything that is not locked, full range. Output levels can jump, so turn down first.' : 'Musical: output volume and gain stay where they are, feedback, resonance and drive stay in a safe range, EQ boosts are balanced.'; };
  showHint();
  const chips = h('div', { class: 'rp-locks' });
  const drawChips = () => {
    chips.innerHTML = '';
    for (const T of targets) {
      if (targets.length > 1) chips.append(h('div', { class: 'rp-dev' }, T.label));
      for (const p of T.defs) { if (p.type === 'set') continue; const on = (T.holder.locks || []).includes(p.key);
        chips.append(h('button', { class: 'rp-chip' + (on ? ' on' : ''), 'aria-pressed': String(on), title: on ? 'Locked: click to allow randomizing' : 'Click to lock (the randomizer will not change it)', onclick: () => { toggleLock(T.holder, p.key); drawChips(); renderDevices(); } }, icon(on ? 'lock' : 'unlock'), p.label)); }
    }
  };
  drawChips();
  const lockAll = (on) => { for (const T of targets) { if (on) T.holder.locks = T.defs.filter((p) => p.type !== 'set').map((p) => p.key); else delete T.holder.locks; } markDirty(); drawChips(); renderDevices(); };
  const pop = h('div', { class: 'popover rand-pop', role: 'dialog', 'aria-label': 'Randomizer' },
    h('div', { class: 'rp-title' }, icon('dice'), h('span', {}, 'Randomize: ' + main.label)),
    h('label', { class: 'rp-row' }, h('span', {}, 'Amount'), amt, pct),
    h('div', { class: 'rp-row rp-modes', role: 'group', 'aria-label': 'Mode' }, modeBtn('musical', 'Musical'), modeBtn('chaos', 'Chaos')),
    hint,
    h('div', { class: 'rp-sub' }, h('span', {}, 'Lock parameters'), h('button', { class: 'small', onclick: () => lockAll(true) }, 'Lock all'), h('button', { class: 'small', onclick: () => lockAll(false) }, 'Unlock all')),
    chips,
    h('div', { class: 'rp-actions' },
      h('button', { class: 'primary rp-go', onclick: go }, icon('dice'), 'Device'),
      h('button', { class: 'rp-chain', onclick: () => randomizeScope(tid, 'chain') }, icon('dice'), 'Chain'),
      tid !== 'master' ? h('button', { class: 'rp-track', onclick: () => randomizeScope(tid, 'track') }, icon('dice'), 'Track') : null,
      h('button', { class: 'rp-undo', title: 'Undo (Ctrl/Cmd+Z)', onclick: () => undo(), 'aria-label': 'Undo' }, icon('undo'), 'Undo')));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect(), pr = pop.getBoundingClientRect();
  pop.style.left = Math.max(4, Math.min(r.left - pr.width / 2, innerWidth - pr.width - 4)) + 'px';
  pop.style.top = (r.top - pr.height - 6 > 4 ? r.top - pr.height - 6 : Math.min(r.bottom + 6, innerHeight - pr.height - 4)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, { once: true }), 0);
}

// ------------------------------------------------------------------ device browser (desktop sidebar)
const INST_HELP = { synth: 'Analog synth: 3 oscillators, filter, envelopes.', wavetable: 'Wavetable synth: morphing tables, unison, LFO.', drums: 'Drum kit: 128 pads with built-in drum sounds; put your own samples on any pad.' };
function browserSections() {
  const sup = pluginSupport();
  const plug = S.plugins || { list: [], status: '' };
  return [
    { id: 'inst', label: 'Instruments', icon: 'synth', color: '#8B5CF6', items: Object.entries(INSTRUMENT_TYPES).map(([k, C]) => ({ kind: 'inst', type: k, label: C.label, help: INST_HELP[k] || C.label, locked: !allowed('inst.' + k), color: '#8B5CF6' })) },
    { id: 'midifx', label: 'MIDI Effects', icon: 'midi', color: '#EF4444', items: Object.entries(MIDI_FX_TYPES).map(([k, C]) => ({ kind: 'midifx', type: k, label: C.label, help: MIDI_FX_HELP[k], color: '#EF4444' })) },
    { id: 'fx', label: 'Audio Effects', icon: 'wave', color: '#A78BFA', items: Object.entries(EFFECT_TYPES).filter(([k]) => k !== 'rack').map(([k, C]) => ({ kind: 'fx', type: k, label: C.label, help: EFFECT_HELP[k] || C.label, locked: !allowed('fx.' + k), color: FX_COLORS[k] })) },
    { id: 'racks', label: 'Racks', icon: 'rack', color: '#9aa4ad', items: Object.keys(allRackPresets()).map((n) => ({ kind: 'rack', type: 'rack', name: n, label: n, search: 'rack', help: 'Rack: parallel chains with macro knobs.', locked: !allowed('fx.rack'), drag: { kind: 'rack', type: 'rack', name: n } })) },
    { id: 'samples', label: 'My Samples', icon: 'drums', color: '#c4b5fd',
      note: S.library.length ? '' : 'Your own sounds for the drum pads. Drop audio files (or a folder) on a pad, or press Add samples.',
      actions: [{ label: 'Add samples', icon: 'folder', title: 'Load audio files onto the drum pads of the selected drum track (several files fill the next pads)', run: () => { const t = drumTarget(); if (t) drumRack.pick(t, drumRack.selOf(t), false); } }],
      items: S.library.map((x) => ({ kind: 'sample', type: 'sample', id: x.id, label: x.name, badge: x.dur ? x.dur.toFixed(x.dur < 10 ? 2 : 1) + ' s' : '', search: 'sample drum pad', help: 'Your sample: drag it onto a drum pad, or double-click to put it on the selected pad.', drag: { kind: 'sample', id: x.id }, color: '#c4b5fd' })) },
    { id: 'plugins', label: 'Plugins', icon: 'plug', color: '#F87171', noteIcon: sup.desktop ? null : 'desktop', noteKind: sup.desktop ? '' : 'desktop-only',
      note: sup.desktop ? (plug.status || (plug.list.length ? '' : 'No plugins yet. Scan your plugin folders.')) : 'Desktop app only. ' + sup.reason,
      actions: sup.desktop && S.pluginApi ? [{ label: 'Scan', icon: 'refresh', title: 'Scan plugin folders (runs in a separate process, so a broken plugin cannot crash Auduio)', run: () => S.pluginApi.scan() }] : null,
      items: sup.desktop ? [...plug.list].sort((a, b) => (b.isInstrument ? 1 : 0) - (a.isInstrument ? 1 : 0)).map((p) => ({ kind: 'plugin', type: 'plugin', uid: p.uid, instrument: !!p.isInstrument, label: p.name, badge: (p.isInstrument ? 'Inst ' : 'FX ') + p.format, search: `${p.vendor || ''} ${p.format} ${p.category || ''}`, help: `${p.name} (${p.format}${p.vendor ? ', ' + p.vendor : ''})${p.isInstrument ? ' - instrument' : ' - effect'}`, color: '#F87171', drag: { kind: 'plugin', type: 'plugin', uid: p.uid, name: p.name, instrument: !!p.isInstrument } })) : [] },
  ];
}
function browserTargetAt(x, y) {
  const els = document.elementsFromPoint(x, y);
  for (const e of els) {
    if (!e.closest) continue;
    const c = e.closest('#sessionView .col[data-id], #arrangeView .lane-head[data-id], #arrangeView .lane[data-id]');
    if (c && c.dataset.id) { const id = c.dataset.id; if (id === 'master' || track(id)) return { trackId: id, el: c.classList.contains('col') ? (c.querySelector('.col-head') || c) : c }; }
    const dp = e.closest('#devicePanel'); if (dp && S.selected) return { trackId: S.selected, el: $('#devices') };
    if (e.closest('#main')) return { trackId: 'new', el: $('#main') };
  }
  return null;
}
// add a browser item to a track. trackId: null = selected track, 'new' = create a fitting track
// the drum track that samples go to: the selected one, else the first, else a new one
function drumTarget() {
  const isD = (t) => t && t.kind === 'midi' && t.inst && t.inst.type === 'drums';
  let t = track(S.selected); if (isD(t)) return t;
  t = S.project.tracks.find(isD); if (t) { S.selected = t.id; renderAll(); return t; }
  t = addTrack(null, 'midi', 'drums'); return t;
}
function addBrowserItem(it, trackId) {
  if (!S.project || !it) return;
  if (it.kind === 'sample') { const sel = track(trackId && trackId !== 'new' ? trackId : S.selected); const t = sel && sel.kind === 'midi' && sel.inst && sel.inst.type === 'drums' ? sel : drumTarget(); if (t) { S.selected = t.id; drumRack.assignLibrary(t, it.padNote != null ? it.padNote : drumRack.selOf(t), it.id, it.label).then(() => renderDevices()); } return; }
  const want = it.kind === 'inst' || it.kind === 'midifx' || (it.kind === 'plugin' && it.instrument) ? 'midi' : 'any';
  let t = trackId === 'new' ? null : track(trackId || S.selected);
  const isMaster = (trackId || S.selected) === 'master' && trackId !== 'new';
  if (it.kind === 'inst' && !gate('inst.' + it.type, INSTRUMENT_TYPES[it.type].label)) return;
  if ((it.kind === 'fx' || it.kind === 'rack') && !gate('fx.' + it.type, EFFECT_TYPES[it.type].label)) return;
  if (it.kind === 'plugin') return S.pluginApi ? S.pluginApi.addToTrack(it, t, isMaster) : toast(pluginSupport().reason, 5000);
  if (isMaster && want === 'midi') t = null;
  if (t && t.kind === 'group' && want === 'midi') t = null;
  if (!t && !isMaster) {
    // no fitting track: make one (single undo step together with the device)
    if (want === 'midi') t = addTrack(null, 'midi', it.kind === 'inst' ? it.type : 'synth');
    else t = addTrack(null, 'audio');
    if (!t) return;
    if (it.kind === 'inst') { toast(`New MIDI track with ${INSTRUMENT_TYPES[it.type].label}`); return; }
    return addDeviceTo(t, false, it, true);
  }
  if (want === 'midi' && t.kind !== 'midi') { t = addTrack(null, 'midi', it.kind === 'inst' ? it.type : 'synth'); if (!t) return; if (it.kind === 'inst') return toast(`New MIDI track with ${INSTRUMENT_TYPES[it.type].label}`); return addDeviceTo(t, false, it, true); }
  addDeviceTo(t, isMaster, it, false);
}
function addDeviceTo(t, isMaster, it, sameStep) {
  const run = (label, fn) => { if (sameStep) { fn(); markDirty(); } else change(label, fn); };
  S.selected = isMaster ? 'master' : t.id;
  if (it.kind === 'inst') {
    if (t.inst && t.inst.type === it.type) { toast(`${t.name} already uses ${INSTRUMENT_TYPES[it.type].label}`); renderAll(); return; }
    run('Instrument', () => { t.inst = { type: it.type, values: {} }; t.instrument = it.type === 'drums' ? 'drums' : 'keys'; t.instrumentSource = 'manual'; engine.setInstrument(t); });
  } else if (it.kind === 'midifx') {
    if ((t.midiFx || []).length >= 8) return toast('Up to 8 MIDI effects per track.');
    run('Add ' + MIDI_FX_TYPES[it.type].label, () => { t.midiFx = t.midiFx || []; t.midiFx.push(midiFxDefaults(it.type)); engine.setMidiFx(t); });
    S.expanded.add(`${t.id}:mfx${t.midiFx.length - 1}:${it.type}`);
  } else {
    const list = isMaster ? S.project.master.fx : t.fx;
    const def = it.kind === 'rack' ? { type: 'rack', enabled: true, ...rackPresetDef(it.name) } : { type: it.type, enabled: true, values: {} };
    run('Add effect', () => { list.push(def); isMaster ? engine.setMasterFx(list) : engine.setTrackFx(t); });
    S.expanded.add(`${isMaster ? 'master' : t.id}:${list.length - 1}:${def.type}`);
  }
  $('#devicePanel').classList.remove('collapsed');
  renderAll();
  setTimeout(() => { const d = $('#devices'); if (d && it.kind !== 'midifx' && it.kind !== 'inst') d.scrollLeft = d.scrollWidth; }, 0);
  const what = it.kind === 'inst' ? INSTRUMENT_TYPES[it.type].label : it.kind === 'midifx' ? MIDI_FX_TYPES[it.type].label : it.kind === 'rack' ? 'Rack: ' + it.name : EFFECT_TYPES[it.type].label;
  toast(`Added ${what} to ${isMaster ? 'Master' : t.name}`, 1800);
}
const plSearch = new Map();
const pluginUi = {
  randButtons: (g, tid) => randButtons(g, tid), toggleLock: (holder, key) => { toggleLock(holder, key); },
  renderDevices: () => renderDevices(), isExpanded: (k) => S.expanded.has(k), toggleExpanded: (k) => { S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k); renderDevices(); },
  searchOf: (id) => plSearch.get(id), setSearch: (id, v) => plSearch.set(id, v),
  mapped: (fx, key) => S.project.midiMap.some((m) => m.fx === fx && m.key === key),
  learn: { active: () => S.learn.active, set: (tg) => { $$('.learn-target').forEach((x) => x.classList.remove('learn-target')); S.learn.target = tg; toast(`Now move a control on your MIDI device for "${tg.label}"`, 2500); } },
};
function initPlugins() {
  if (S.pluginApi || !pluginSupport().desktop) return;
  S.pluginApi = createPluginApi({ engine, getProject: () => S.project, change, history, markDirty, renderAll: () => renderAll(), renderDevices: () => renderDevices(),
    renderBrowser: () => { if (browser) browser.render(); }, addTrack: (n, k, i) => addTrack(n, k, i), select: (id) => { S.selected = id; },
    onParamsChanged: (pid) => { const c = document.querySelector(`#devices .device[data-plugin="${pid}"]`); if (!c) return; const r = S.pluginApi.rt.get(pid);
      $$('.pl-row', c).forEach((row) => { const i = +row.dataset.i, v = r.values[i]; if (v != null && row.setValue && !row.contains(document.activeElement)) { row.setValue(v); const p = r.byIndex.get(i); const val = $('.pl-val', row); if (p && p.text && val) val.textContent = p.text; } }); } });
  S.plugins = S.pluginApi;
  S.pluginApi.paramHook = (pid, i, v) => { if (!seqView) return false; const t = S.project && S.project.tracks.find((x) => (x.plugins || []).some((e) => e.id === pid)); return !!t && seqView.capture(t.id, 'plugin:' + pid, String(i), v); };
  S.pluginApi.init().then((ok) => { if (S.project) renderDevices(); if (ok) { engineMidi.attachIn(S.pluginApi.client); if (engineMidi.inAvailable && S.project && S.project.tracks.some((t) => t.arm && t.kind === 'midi')) MIDI.init(); engineMidi.attach(S.pluginApi.client).then(() => { if (seqView && S.project) renderAll(); }); } });
}
let browser = null;
function initBrowser() {
  if (browser || !$('#browser')) return;
  browser = createBrowser({ root: $('#browser'), sections: browserSections, onAdd: addBrowserItem, resolveTarget: browserTargetAt, onLayout: () => { if (S.project) { renderArrange(); } } });
}

// ------------------------------------------------------------------ racks (parallel chains + macros), presets
const RACK_KEY = 'auduio.rackPresets';
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
    } }, h('option', { value: '' }, '+'), Object.entries(EFFECT_TYPES).filter(([k]) => k !== 'rack').map(([k, C]) => h('option', { value: k }, C.label + (allowed('fx.' + k) ? '' : ' (locked)'))));
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
          h('button', { class: 'pwr' + (fd.enabled !== false ? ' on' : ''), title: 'On/off', onclick: () => { change('Bypass', () => { fd.enabled = fd.enabled === false; f.setEnabled(fd.enabled); }); renderDevices(); } }, icon('power')),
          h('button', { class: 'inner-name', title: open ? 'Collapse' : 'Show controls', onclick: () => { open ? S.expanded.delete(okey) : S.expanded.add(okey); renderDevices(); } }, C.label + ' ', icon(open ? 'chevUp' : 'chevDown')),
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
    toast(`Quantized ${res.onsets.length} hits (largest shift ${Math.round(res.moved * 1000)} ms).`); renderAll();
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
    h('p', {}, 'MIDI: ' + (MIDI.supported ? ((MIDI.access || MIDI.engineInputs.length) ? `${MIDI.inputs().length} input(s): ${MIDI.inputs().map((i) => i.name).join(', ') || '—'}` : 'available (connects when you arm a MIDI track)') : MIDI.notice()) + (engineMidi.available ? ` MIDI out via the audio engine: ${engineMidi.ports.map((p) => p.name).join(', ') || 'no output ports found'}.` : '')),
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
async function loadAllPadSamples() { await Promise.all(S.project.tracks.flatMap((t) => Object.values((t.inst && t.inst.pads) || {}).map((p) => engine.ensureBuffer(p.bufferId)))); }
async function exportProject() { await saveNow(); await loadAllPadSamples(); await shareOrDownload(exportProjectZip(S.project, engine.buffers), baseName() + '.auduio.zip', 'application/zip'); }
async function exportEncrypted() {
  if (!cryptoAvailable()) return toast('Encryption needs a secure (https) context.');
  const pw = await askPassword('Export encrypted', true); if (pw == null) return;
  if (pw.length < 6) return toast('Use at least 6 characters.');
  await saveNow(); toast('Encrypting…', 1200);
  await loadAllPadSamples();
  const bytes = new Uint8Array(await exportProjectZip(S.project, engine.buffers).arrayBuffer());
  const enc = await encryptBytes(bytes, pw);
  await shareOrDownload(new Blob([enc], { type: 'application/octet-stream' }), baseName() + '.auduio.enc', 'application/octet-stream');
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
    h('label', { class: 'chk', title: 'Simple one-screen-at-a-time layout for phones' }, 'Phone layout ',
      h('select', { id: 'phoneModeSel', onchange: (e) => { prefs.phoneMode = e.target.value; savePrefs(); closeDialog(); applyPhoneMode(); } },
        [['auto', 'Automatic (small or touch screens)'], ['on', 'Always simple phone layout'], ['off', 'Always full layout']].map(([v, l]) => h('option', { value: v, selected: (prefs.phoneMode || 'auto') === v }, l)))),
    h('label', { class: 'chk', title: 'When a track is armed and selected you hear its input through its effects. Use headphones to avoid feedback.' }, h('input', { type: 'checkbox', checked: prefs.autoMonitor !== false, onchange: (e) => { prefs.autoMonitor = e.target.checked; savePrefs(); engine.setAutoMonitor(S.selected, prefs.autoMonitor); } }), ' Hear the selected armed track (auto-monitor, use headphones)'),
    chk('haptics', 'Haptic feedback (vibration)', 'Vibrates on knob detents and button presses where supported (not on iPhone/iPad Safari)'),
    h('fieldset', {}, h('legend', {}, 'Auto-record when sound starts (AUTO button)'), h('label', {}, 'Threshold (dBFS) ', thr), h('label', {}, 'Pre-roll (s) ', pre)),
    h('fieldset', {}, h('legend', {}, 'PIN lock'), pinRow),
    h('fieldset', { class: 'tier-set' }, h('legend', {}, 'Tier (placeholder)'),
      h('select', { id: 'tierSel', onchange: (e) => { setTier(e.target.value); toast('Tier: ' + TIER_LABELS[e.target.value]); } }, TIERS.map((x) => h('option', { value: x, selected: x === getTier() }, TIER_LABELS[x]))),
      h('p', { class: 'hint' }, 'Placeholder only — no payments, accounts or licence checks. Every tier can be switched to freely for testing. Features above your tier show a lock badge; existing projects keep playing.')),
    h('button', { type: 'button', onclick: () => { closeDialog(); startTutorial(); } }, 'Replay the tutorial')));
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
  $$('.help-bar').forEach((e) => e.remove());
  if (helpMode) document.body.append(h('div', { class: 'help-bar', role: 'status' }, h('span', {}, 'Help mode: tap anything to see what it does.'),
    h('button', { class: 'small primary', onclick: () => { toggleHelp(); startTutorial(); } }, 'Replay tutorial'), h('button', { class: 'small', onclick: () => openManual() }, 'User manual'), h('button', { class: 'small', onclick: () => toggleHelp() }, 'Exit help')));
}
// the user manual ships with the app (same origin, works offline in the installed app)
const MANUAL_URL = 'manual/Auduio-Manual.pdf';
function openManual() {
  // app webviews (Tauri) do not open new windows, so save the PDF there instead; browsers open it in a new tab
  if (window.__TAURI__) { const a = h('a', { href: MANUAL_URL, download: 'Auduio-Manual.pdf' }); document.body.append(a); a.click(); a.remove(); toast('Manual saved to your Downloads folder'); return; }
  window.open(MANUAL_URL, '_blank', 'noopener');
}
document.addEventListener('click', (e) => {
  if (!helpMode || e.target.closest('#btnHelp, .help-bar')) return;
  const el = e.target.closest('[title], [data-help], [aria-label]'); if (!el) return;
  e.preventDefault(); e.stopPropagation(); showHelpBubble(el, e.clientX, e.clientY);
}, true);
// ------------------------------------------------------------------ interactive tutorial (replaces the v0.2 guide)
const tutorial = createTutorial();
const PHONE_STEPS = [
  { target: '#startBtn', text: 'Tap here to turn on the sound.' },
  { target: '.ph-add .ph-big, .ph-arm', text: 'Each voice or instrument gets its own track — add one here, or use the track you already have.', before: () => phone.show('tracks') },
  { target: '.ph-recbtn', text: 'Tap the big red button to record, and tap it again to stop.', before: () => phone.show('record') },
  { target: '.ph-automix', text: 'Auto-Mix sets up the sound of all your tracks for you.', before: () => phone.show('mix') },
  { target: '.ph-addfx', text: 'Add an effect, like “Space” for a room sound or “Make it louder”.', before: () => phone.show('effects') },
  { target: '.ph-save', text: 'Save your song or share it with someone here.', before: () => phone.show('more') },
];
const DESKTOP_STEPS = [
  { target: '#startBtn', text: 'Click here to start the audio engine.' },
  { target: '#btnRec', text: 'Arm a track with its round arm button, then press Record (or R).' },
  { target: '#btnAutoMix', text: 'Auto-Mix sets up EQ, compression and effects for every track.' },
  { target: '#btnMenu', text: 'Save, export or share your project from this menu.' },
];
function startTutorial(fromStart = false) {
  closeMenus(); if ($('#dlg').open) closeDialog();
  const list = (phone && phone.active) || (!S.project && wantsPhone()) ? PHONE_STEPS : DESKTOP_STEPS;
  tutorial.start(fromStart || !S.project ? list : list.slice(1));
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
    ['Simple phone layout', () => { prefs.phoneMode = 'on'; savePrefs(); phone.setActive(true); }],
    ['Tutorial', () => startTutorial()],
    ['User manual (PDF)', openManual],
    ['-'],
    ['Install app', installApp],
    ['About', () => aboutDialog()],
  ];
  const m = $('#menu'); m.innerHTML = '';
  for (const [label, fn] of items) m.append(label === '-' ? h('hr') : h('button', { onclick: () => { closeMenus(); fn(); } }, label));
}
async function installApp() {
  if (S.deferredInstall) { S.deferredInstall.prompt(); S.deferredInstall = null; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openDialog('Install', h('p', {}, ios ? 'In Safari tap the Share button, then “Add to Home Screen”.' : 'Use your browser menu: “Install app” or “Add to Home screen”.'));
}

// ------------------------------------------------------------------ render loop
function renderAll() {
  if (!S.project) return;
  if (S.sel && S.sel.kind === 'arr' && S.sel.clipId && !selectedClip()) S.sel = null; // selection may point at a clip removed by undo/move
  syncBottomToSelection();
  $('#sessionView').hidden = S.view !== 'session';
  $('#arrangeView').hidden = S.view !== 'arrange';
  $$('.views button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  renderSession(); renderArrange(); renderDevices(); updateTransportUI(); updateKeyButton();
  seqView.render();
  if (typeof phone !== 'undefined' && phone.active) phone.render();
  syncMonitor();
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
  if (!grad || cv._gw !== w || cv._gh !== hh) { grad = horiz ? g.createLinearGradient(0, 0, w, 0) : g.createLinearGradient(0, hh, 0, 0); grad.addColorStop(0, '#2fb57a'); grad.addColorStop(0.7, '#3ecf8e'); grad.addColorStop(0.86, '#A855F7'); grad.addColorStop(1, '#ff4d4d'); cv._grad = grad; cv._gw = w; cv._gh = hh; }
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

// ------------------------------------------------------------------ live waveforms while recording + master scope
function liveTakes() {
  // arrangement takes and session-slot audio recordings -> [{ tid, rec, kind, slot, startPos }]
  const out = [];
  if (engine.recording && engine.recTakes && S.liveRec) for (const k of engine.recTakes) out.push({ tid: k.t.id, rec: k.rec, kind: 'arr', startPos: S.liveRec.startPos });
  for (const [id, n] of engine.tracks) if (n.rec && n.rec.rec) out.push({ tid: id, rec: n.rec.rec, kind: 'slot', slot: n.rec.slot, when: n.rec.when });
  return out;
}
const livePeakMap = new Map();
function livePeaksFor(key, rec) {
  let L = livePeakMap.get(key); if (!L || L.rec !== rec) { L = { rec, lp: new LivePeaks(engine.ctx.sampleRate), used: 0 }; livePeakMap.set(key, L); }
  const ch = rec.chunks || []; for (; L.used < ch.length; L.used++) if (ch[L.used] && ch[L.used][0]) L.lp.append(ch[L.used]);
  return L.lp;
}
function drawLiveRecording() {
  const takes = liveTakes(); if (!takes.length) { if (livePeakMap.size) { livePeakMap.clear(); $$('.rec-live').forEach((e) => e.remove()); } return; }
  const pos = engine.position();
  for (const k of takes) {
    const t = track(k.tid); if (!t) continue; const lp = livePeaksFor(k.tid + ':' + k.kind, k.rec);
    let host = null, left = 0, width = 0;
    let passStart = k.startPos; if (k.kind === 'arr' && engine.loopSpan && pos < k.startPos - 0.01) passStart = engine.loopSpan.start;
    if (k.kind === 'arr' && S.view === 'arrange') { host = $(`#arrangeView .lane[data-id="${k.tid}"]`); left = passStart * S.zoom; width = Math.max(2, (pos - passStart) * S.zoom); }
    else if (k.kind === 'slot' && S.view === 'session') host = $(`#sessionView .col[data-id="${k.tid}"] .slot[data-slot="${k.slot}"]`);
    if (!host) continue;
    let el = host.querySelector('.rec-live');
    if (!el) { el = h('div', { class: 'rec-live', style: { '--c': t.color } }, h('span', { class: 'rec-live-label' }, 'REC'), h('canvas')); host.append(el); }
    if (k.kind === 'arr') { el.style.left = left + 'px'; el.style.width = width + 'px'; }
    // show the last few seconds scrolling in (session) or the whole take (arrangement)
    const dur = lp.duration, cv = el.querySelector('canvas');
    if (dur > 0.02) drawWaveform(cv, lp, k.kind === 'arr' ? (passStart !== k.startPos ? { startSec: Math.max(0, dur - (pos - passStart)), endSec: dur, color: '#EF4444', stereo: false } : { startSec: 0, endSec: Math.max(dur, (pos - k.startPos) || dur), color: '#EF4444', stereo: false }) : { startSec: Math.max(0, dur - 4), endSec: Math.max(4, dur), color: '#EF4444', stereo: false });
  }
}
let scopeBuf = null;
function drawMasterScope() {
  const cv = $('#masterScope'); if (!cv || !engine.scopeAn || !cv.offsetParent) return;
  if (!scopeBuf) scopeBuf = new Float32Array(engine.scopeAn.fftSize);
  drawScopeLine(cv, engine.scopeAn, scopeBuf);
}

let lastScope = 0, lastClipDraw = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!S.project || document.hidden) return;
  engine.pollMeters();
  const pos = engine.position();
  $('#posDisplay').textContent = fmtPos(pos);
  $$('canvas[data-meter]').forEach((cv) => { if (cv.offsetParent) drawMeter(cv, cv.dataset.meter); });
  drawMeter($('#masterMeterTop'), 'master');
  if (ts - lastScope > 33) { lastScope = ts; drawMasterScope(); drawLiveRecording(); }
  phone.frame(ts);
  seqView.frame(ts);
  if (S.bottom === 'clip' && (engine.playing || engine.audition) && S.clipView && S.clipView.draw && ts - lastClipDraw > 66) { lastClipDraw = ts; S.clipView.draw(); }
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
  $('#btnLoop').addEventListener('click', () => { haptic(8); toggleLoop(); });
  $('#btnTap').addEventListener('pointerdown', (e) => { e.preventDefault(); tapTempo(); });
  $('#btnTap').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapTempo(); } });
  $('#btnTempo').addEventListener('click', (e) => { e.stopPropagation(); if (tempoPop) closeTempoPop(); else tempoPopover(e.currentTarget); });
  $('#btnUndo').addEventListener('click', undo); $('#btnRedo').addEventListener('click', redo);
  $('#btnEasy').addEventListener('click', toggleEasy);
  $('#btnHelp').addEventListener('click', toggleHelp);
  $('#btnAutoMix').addEventListener('click', () => autoMixDialog());
  $('#bpm').addEventListener('change', (e) => {
    const v = Math.round(Math.max(40, Math.min(300, +e.target.value || 120)) * 10) / 10; e.target.value = v;
    change('Tempo', () => { S.project.bpm = v; engine.updateBpmFx(); }); renderArrange();
  });
  $$('.views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
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
      else if (k === 'l') { e.preventDefault(); loopToSelection(); }
      else if (k === 'e') { e.preventDefault(); clipOp('split'); }
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 'r') toggleRecord();
    else if (k === 'm') { if (e.shiftKey) $('#btnMetro').click(); else compKeys.toggle(); }
    else if (k === 't') tapTempo();
    else if (k === 's') clipOp('split');
    else if (k === 'x') setTool('razor');
    else if (e.key === 'Escape' && S.tool) setTool(S.tool);
    else if (k === 'b' && browser && !phone.active) browser.toggle();
    else if (e.key === 'Tab') { e.preventDefault(); S.view = S.view === 'session' ? 'arrange' : 'session'; renderAll(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel) { e.preventDefault(); clipOp('del'); } }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest('[role=slider], .knob, .fader, button[role=tab]')) { if (nudgeSelected(e.key === 'ArrowLeft' ? -1 : 1, e)) e.preventDefault(); }
    else if (e.key === 'Escape') { closeMenus(); if (helpMode) toggleHelp(); if (S.carry) { S.carry = null; renderCarryBar(); } engine.stopAudition(); }
  });
  // drag & drop outside the arrangement: projects or audio as new tracks
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault(); if (!engine.ctx || !S.project) return;
    const files = [...e.dataTransfer.files];
    const proj = files.find((f) => /\.(zip|auduio|webdaw|json|enc)$/i.test(f.name));
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
  engine.lazyLoader = (id) => DB.loadBuffer(id, engine.ctx); // drum-pad samples load on first use
  initPlugins();
  S.devices = await engine.listDevices().catch(() => ({ inputs: [], outputs: [] }));
  let loaded = null;
  try { const id = await DB.lastProjectId(); if (id) loaded = await DB.loadProject(id, engine.ctx); } catch (e) { console.warn('IndexedDB load failed', e); }
  if (loaded) {
    try { const v = validateProject(loaded.project); loaded.project = v.project; } catch (e) { console.warn('stored project failed validation, starting new', e); loaded = null; }
  }
  if (loaded) await loadProjectData(loaded.project, loaded.buffers); else await newProjectFlow(2);
  library.load();
  $('#startOverlay').remove();
  initBrowser();
  phone.setActive(wantsPhone());
  syncMonitor();
  requestAnimationFrame(frame);
  if (engine.ctx.state !== 'running') toast('Audio is suspended by the browser — tap anywhere to resume.', 5000);
}

// ------------------------------------------------------------------ phone mode
async function saveAndShare() { await saveNow(); toast('Saved in this browser', 1200); await exportProject(); }
// ------------------------------------------------------------------ drum rack (128 pads, user samples) + "My Samples"
S.library = [];
const library = {
  list: () => S.library,
  async load() { try { S.library = (await DB.getLibrary()).filter((x) => x && typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(x.id)).map((x) => ({ id: x.id, name: String(x.name || 'Sample').slice(0, 40), dur: +x.dur || 0 })); } catch (e) { S.library = []; } if (browser) browser.render(); },
  add(entries, bufs) {
    const have = new Set(S.library.map((x) => x.id));
    for (const e of entries) if (!have.has(e.id)) S.library.unshift(e);
    S.library = S.library.slice(0, 512);
    // the audio is stored right away so the sample stays available in other projects
    Promise.all((bufs || []).map(([id, b]) => DB.putBuffer(id, b))).then(() => DB.setLibrary(S.library)).catch((e) => console.warn('My Samples: could not store', e));
    if (browser) browser.render();
  },
  remove(id) { S.library = S.library.filter((x) => x.id !== id); DB.setLibrary(S.library).catch(() => {}); if (browser) browser.render(); },
};
function usedNotes(t) {
  const used = new Set();
  for (const c of [...(t.slots || []), ...(t.arrangement || [])]) if (c && c.type === 'midi') (c.notes || []).forEach((x) => used.add(x.n));
  if (t.seq) (t.seq.patterns || []).forEach((p) => (p.steps || []).slice(0, p.len).forEach((st) => st && st.on && (st.n || []).forEach((x) => used.add(x))));
  return used;
}
// big-button sheet (phone) with the same look as the phone clip sheet
function actionSheet(title, items) {
  const host = $('#phone') || document.body;
  const sheet = h('div', { class: 'ph-sheet', role: 'dialog', 'aria-label': title });
  const close = () => sheet.remove();
  // opened by a long-press: the click from lifting that finger must not hit the sheet, so only a new press counts
  let armed = false; sheet.addEventListener('pointerdown', () => { armed = true; }, true);
  const tap = (fn) => (e) => { if (!armed) { e.preventDefault(); return; } fn(); };
  sheet.addEventListener('click', (e) => { if (armed && e.target === sheet) close(); });
  sheet.append(h('div', { class: 'ph-sheet-card' }, h('h3', { class: 'ph-h' }, title),
    h('div', { class: 'ph-col' }, items.map((it) => h('button', { class: 'ph-big', onclick: tap(() => { close(); it.fn(); }) }, h('span', { class: 'b1' }, it.label)))),
    h('button', { class: 'ph-big', onclick: tap(close) }, h('span', { class: 'b1' }, 'Cancel'))));
  host.append(sheet); haptic(15);
}
drumRack = createDrumRack({ S, engine, change, uid, noteEvent: (t, n, v, on) => noteEvent(t, n, v, on), contextMenu: (x, y, items) => contextMenu(x, y, items),
  sheet: (title, items) => actionSheet(title, items), usedNotes, library, markChanged: () => { if (browser) browser.render(); },
  refreshSeq: () => seqView.render() });
window.__daw.drumRack = drumRack; window.__daw.library = library;
seqView = createSeqView({ drumRack, S, engine, change, markDirty, track, renderAll: () => renderAll(), renderDevices: () => renderDevices(), addTrack: (n, k, i) => addTrack(n, k, i),
  select: (id) => { S.selected = id; syncMonitor(); }, randButtons, loopInfo, toggleLoop, paramCatalog, SCALES,
  phoneActive: () => phone.active, phoneSeqOpen: () => phone.seqOpen, phoneRender: () => phone.render(), onLayout: () => { if (S.project) renderArrange(); } });
seqView.mount($('#seqPanel'));
engine.seq.midiOut = createMidiOut(() => engine.ctx);
engine.seq.onSwitch = () => { markDirty(); };
engine.pluginLock = (t, pid, i, v, at, dur) => S.pluginApi && S.pluginApi.lockParam && S.pluginApi.lockParam(pid, i, v, at, dur);
const phone = createPhone({ seqView, drumRack,
  S, engine, history, track, change, markDirty, renderAll, renderDevices, togglePlay, toggleRecord, toggleAutoRecord, toggleArm, addTrack, renameTrack,
  autoMixDialog, gate, lockBadge, EFFECT_TYPES, EASY_PARAMS, EFFECT_HELP, setParam, fmtParam, fmtPos, undo, redo, tapTempo, tempoPopover, prefsDialog,
  projectsDialog, saveAndShare, startTutorial, openManual, toggleHelp, updateTransportUI, liveTakes, livePeaksFor, placeClip, snapPos, startAudition, syncMonitor, icon,
  toggleLoop, loopInfo, setLoopBars, splitClipAt, splitAtLoop, clipOp,
});
function applyPhoneMode() { const on = wantsPhone(); if (on !== phone.active) { phone.setActive(on); if (!on) renderAll(); } }
addEventListener('resize', () => { if (S.project && (prefs.phoneMode || 'auto') === 'auto') applyPhoneMode(); });
window.__daw.phone = phone; window.__daw.tutorial = tutorial; window.__daw.seq = seqView;
const compKeys = createCompKeys({ targets: () => (S.project ? midiTargets('screen') : []), noteOn: (t, n, v) => noteEvent(t, n, v, true), noteOff: (t, n) => noteEvent(t, n, 0, false),
  hint: (m) => toast(m, 3000), onToggle: (on) => { const b = $('#btnKeys'); if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } haptic(8); } });
window.__daw.compKeys = compKeys;
{ const b = $('#btnKeys'); if (b) { b.addEventListener('click', () => compKeys.toggle()); b.classList.toggle('on', compKeys.on); b.setAttribute('aria-pressed', String(compKeys.on)); } }

bindUI();
['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (engine.ctx && engine.ctx.state !== 'running') engine.resume(); }, { passive: true }));
$('#startBtn').addEventListener('click', start);
(async () => {
  if (pinIsSet()) { $('#startOverlay').hidden = true; await lockScreen(); $('#startOverlay').hidden = false; }
  // first run: interactive tutorial starts on the "start audio" button (v0.2 guide users count as done)
  if (!prefs.tutorialDone && !prefs.guideDone) startTutorial(true);
})();
// Native shells (Tauri desktop, Capacitor Android/iOS) ship the files locally: no service worker needed.
const NATIVE_SHELL = !!(window.__TAURI_INTERNALS__ || window.__TAURI__ || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()));
if ('serviceWorker' in navigator && !NATIVE_SHELL && location.protocol !== 'file:' && !location.search.includes('nosw')) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
}
