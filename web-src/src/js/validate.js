// Strict schema validation for imported projects. Builds a fresh whitelisted object:
// unknown keys are dropped, numbers clamped, strings length-limited, ids pattern-checked,
// effect/instrument types and parameter keys must be known. Throws on structural problems.
import { EFFECT_TYPES, RACK_LIMITS } from './audio/effects.js';
import { INSTRUMENT_TYPES } from './audio/instruments.js';
import { INSTRUMENTS, ROLES } from './audio/presets.js';
import { SCALES } from './audio/pitchdsp.js';
import { MIDI_FX_TYPES } from './audio/midifx.js';
import { sanitizeSeq } from './audio/sequencer.js';
import { sanitizePads, padBufferIds } from './audio/drumrack.js';

export const LIMITS = { tracks: 128, fxPerTrack: 16, clipsPerTrack: 5000, notesPerClip: 20000, scenes: 64, midiMap: 256, midiFxPerTrack: 8, pluginsPerTrack: 8, pluginParams: 4096, pluginState: 8 * 1024 * 1024, pluginAutoPoints: 20000 };
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
class VErr extends Error {}
const fail = (m) => { throw new VErr('Invalid project: ' + m); };
const num = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def);
const int = (v, lo, hi, def) => Math.round(num(v, lo, hi, def));
const str = (v, max, def = '') => (typeof v === 'string' ? v.slice(0, max).replace(/[\u0000-\u001f]/g, '') : def);
const bool = (v) => v === true;
const id = (v, what) => { if (typeof v !== 'string' || !ID_RE.test(v)) fail(`bad ${what} id`); return v; };
const arr = (v, max, what) => { if (v == null) return []; if (!Array.isArray(v)) fail(`${what} must be a list`); if (v.length > max) fail(`too many ${what} (max ${max})`); return v; };

function params(defs, values) {
  const out = {};
  const src = values && typeof values === 'object' ? values : {};
  for (const p of defs) {
    const v = src[p.key];
    if (p.type === 'select') out[p.key] = p.options.includes(v) ? v : p.def;
    else out[p.key] = num(v, p.min, p.max, p.def);
  }
  return out;
}
export function validateRack(f) {
  const chains = arr(f && f.chains, RACK_LIMITS.chains, 'rack chains').map((c) => {
    if (!c || typeof c !== 'object') fail('bad rack chain');
    return { name: str(c.name, 32, 'Chain'), volume: num(c.volume, -60, 12, 0), pan: num(c.pan, -1, 1, 0), mute: bool(c.mute), fx: fxList(c.fx, false, RACK_LIMITS.fxPerChain) };
  });
  const macroMap = [];
  for (const m of arr(f && f.macroMap, RACK_LIMITS.maps, 'macro mappings')) {
    if (!m || typeof m !== 'object') fail('bad macro mapping');
    const ch = chains[int(m.chain, 0, 99, 0)], fd = ch && ch.fx[int(m.fx, 0, 99, 0)];
    const p = fd && EFFECT_TYPES[fd.type].params.find((x) => x.key === m.key);
    if (!p) continue; // mapping to something that no longer exists: drop it
    const lo = p.type === 'select' ? 0 : p.min, hi = p.type === 'select' ? 1 : p.max;
    macroMap.push({ macro: int(m.macro, 0, RACK_LIMITS.macros - 1, 0), chain: int(m.chain, 0, 99, 0), fx: int(m.fx, 0, 99, 0), key: p.key, min: num(m.min, lo, hi, lo), max: num(m.max, lo, hi, hi) });
  }
  return { chains, macroMap };
}
// randomizer locks: list of parameter keys that the randomizer must not touch
function locks(v, defs) { if (!Array.isArray(v)) return null; const ks = v.filter((k) => defs.some((p) => p.key === k)).slice(0, 64); return ks.length ? ks : null; }
function midiFxList(list) {
  return arr(list, LIMITS.midiFxPerTrack, 'MIDI effects').map((f) => {
    if (!f || typeof f !== 'object' || !MIDI_FX_TYPES[f.type]) fail('unknown MIDI effect type');
    const defs = MIDI_FX_TYPES[f.type].params, out = { type: f.type, enabled: f.enabled !== false, values: params(defs, f.values) };
    const L = locks(f.locks, defs); if (L) out.locks = L;
    return out;
  });
}
// hosted plugins (desktop app): the plugin itself lives in the native engine; the project keeps its identity,
// an opaque base64 state chunk (size-capped), touched parameter values (index -> 0..1), locks, macros, automation
const pidx = (k) => { const i = Number(k); return Number.isInteger(i) && i >= 0 && i < LIMITS.pluginParams ? String(i) : null; };
function pluginList(list) {
  return arr(list, LIMITS.pluginsPerTrack, 'plugins').map((pl) => {
    if (!pl || typeof pl !== 'object' || typeof pl.uid !== 'string' || !pl.uid) fail('bad plugin entry');
    const out = { id: str(pl.id, 40, '').replace(/[^\w-]/g, '') || 'pl' + Math.random().toString(36).slice(2, 8), uid: str(pl.uid, 300), name: str(pl.name, 80, 'Plugin'), format: ['VST3', 'AudioUnit', 'CLAP'].includes(pl.format) ? pl.format : 'VST3',
      vendor: str(pl.vendor || '', 80), instrument: bool(pl.instrument), enabled: pl.enabled !== false, values: {} };
    if (typeof pl.file === 'string') out.file = str(pl.file, 1024);
    if (typeof pl.state === 'string' && pl.state.length <= LIMITS.pluginState && /^[A-Za-z0-9+/=]*$/.test(pl.state)) out.state = pl.state;
    for (const [k, v] of Object.entries(pl.values && typeof pl.values === 'object' ? pl.values : {}).slice(0, LIMITS.pluginParams)) { const i = pidx(k); if (i != null) out.values[i] = num(v, 0, 1, 0); }
    if (Array.isArray(pl.locks)) { const L = pl.locks.map(pidx).filter((x) => x != null).slice(0, LIMITS.pluginParams); if (L.length) out.locks = L; }
    out.macros = arr(pl.macros, 8, 'plugin macros').map((m, mi) => ({ name: str(m && m.name, 24, 'Macro ' + (mi + 1)), value: num(m && m.value, 0, 1, 0),
      targets: arr(m && m.targets, 32, 'macro targets').map((x) => ({ i: int(x && x.i, 0, LIMITS.pluginParams - 1, 0), min: num(x && x.min, 0, 1, 0), max: num(x && x.max, 0, 1, 1) })) }));
    out.auto = {}; let pts = 0;
    for (const [k, lane] of Object.entries(pl.auto && typeof pl.auto === 'object' ? pl.auto : {}).slice(0, 64)) {
      const i = pidx(k); if (i == null || !Array.isArray(lane)) continue;
      const L = lane.slice(0, Math.max(0, LIMITS.pluginAutoPoints - pts)).filter((q) => Array.isArray(q)).map((q) => [num(q[0], 0, 100000, 0), num(q[1], 0, 1, 0)]).sort((a, b) => a[0] - b[0]);
      pts += L.length; if (L.length) out.auto[i] = L;
    }
    return out;
  });
}
function fxList(list, allowRack = true, max = LIMITS.fxPerTrack) {
  return arr(list, max, 'effects').map((f) => {
    if (!f || typeof f !== 'object' || !EFFECT_TYPES[f.type]) fail('unknown effect type');
    if (f.type === 'rack' && !allowRack) fail('racks cannot be nested');
    const out = { type: f.type, enabled: f.enabled !== false, values: params(EFFECT_TYPES[f.type].params, f.values) };
    if (f.type === 'rack') Object.assign(out, validateRack(f));
    const L = locks(f.locks, EFFECT_TYPES[f.type].params); if (L) out.locks = L;
    return out;
  });
}
function notes(list) {
  return arr(list, LIMITS.notesPerClip, 'notes').map((n) => ({ t: num(n && n.t, 0, 100000, 0), d: num(n && n.d, 0.01, 4096, 0.25), n: int(n && n.n, 0, 127, 60), v: int(n && n.v, 1, 127, 100) }));
}
function clip(c, arrangement, bufferIds) {
  if (!c || typeof c !== 'object') fail('bad clip');
  const name = str(c.name, 64);
  if (c.type === 'midi') {
    const lengthBeats = num(c.lengthBeats, 0.25, 4096, 4);
    const out = { type: 'midi', name, lengthBeats, notes: notes(c.notes) };
    if (arrangement) Object.assign(out, { id: id(c.id, 'clip'), start: num(c.start, 0, 86400, 0), offset: num(c.offset, 0, 86400, 0), duration: num(c.duration, 0.01, 86400, 1) });
    return out;
  }
  const bufferId = id(c.bufferId, 'buffer'); bufferIds.add(bufferId);
  const out = { bufferId, name, gain: num(c.gain, -60, 24, 0) };
  if (c.bpm != null) out.bpm = num(c.bpm, 20, 400, 120);
  if (c.transpose != null) out.transpose = num(c.transpose, -24, 24, 0);
  if (arrangement) Object.assign(out, { id: id(c.id, 'clip'), start: num(c.start, 0, 86400, 0), offset: num(c.offset, 0, 86400, 0), duration: num(c.duration, 0.001, 86400, 1) });
  if (arrangement && (c.fadeIn != null || c.fadeOut != null)) { const fi = num(c.fadeIn, 0, out.duration, 0); out.fadeIn = fi; out.fadeOut = num(c.fadeOut, 0, Math.max(0, out.duration - fi), 0); }
  if (arrangement && Array.isArray(c.takes) && c.takes.length > 1) {
    // loop-recording takes: regions of the same recording
    out.takes = c.takes.slice(0, 256).filter((k) => k && typeof k === 'object').map((k) => ({ start: num(k.start, 0, 86400, 0), offset: num(k.offset, 0, 86400, 0), duration: num(k.duration, 0.001, 86400, 1) }));
    out.take = int(c.take, 0, out.takes.length - 1, out.takes.length - 1);
  }
  else if (!arrangement) { out.loopLength = num(c.loopLength, 0.01, 3600, 1); if (c.loopStart != null) out.loopStart = num(c.loopStart, 0, 3600, 0); }
  return out;
}

export function validateProject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not an object');
  // 'webdaw-project' is the file format id (kept from the WebDAW days so older files and versions stay compatible)
  if (raw.format !== 'webdaw-project' && raw.format !== 'auduio-project') fail('not an Auduio project');
  if (![1, 2].includes(raw.version)) fail('unsupported version');
  const scenes = int(raw.scenes, 1, LIMITS.scenes, 8);
  const bufferIds = new Set(), seen = new Set();
  const p = {
    format: 'webdaw-project', version: 2, id: id(raw.id, 'project'), name: str(raw.name, 100, 'Imported'),
    bpm: num(raw.bpm, 20, 400, 120), beatsPerBar: int(raw.beatsPerBar, 1, 16, 4), scenes,
    created: num(raw.created, 0, 1e14, Date.now()), modified: num(raw.modified, 0, 1e14, Date.now()),
    key: { root: int(raw.key && raw.key.root, 0, 11, 0), scale: SCALES[raw.key && raw.key.scale] ? raw.key.scale : 'major' },
    master: { volume: num(raw.master && raw.master.volume, -100, 12, 0), fx: fxList(raw.master && raw.master.fx) },
    tracks: [], midiMap: [], keyFollow: bool(raw.keyFollow), gridOffset: num(raw.gridOffset, -3600, 3600, 0),
  };
  if (raw.loop && typeof raw.loop === 'object') {
    const ls = num(raw.loop.start, 0, 86400, 0), le = num(raw.loop.end, 0, 86400, 0);
    if (le > ls) p.loop = { on: bool(raw.loop.on), start: ls, end: le };
  }
  for (const t of arr(raw.tracks, LIMITS.tracks, 'tracks')) {
    if (!t || typeof t !== 'object') fail('bad track');
    const tid = id(t.id, 'track'); if (seen.has(tid)) fail('duplicate track id'); seen.add(tid);
    const kind = ['midi', 'group'].includes(t.kind) ? t.kind : 'audio';
    const slots = kind === 'group' ? [] : arr(t.slots, LIMITS.scenes, 'slots').slice(0, scenes).map((c) => (c == null ? null : clip(c, false, bufferIds)));
    while (slots.length < scenes) slots.push(null);
    const nt = {
      id: tid, kind, name: str(t.name, 64, 'Track'), color: COLOR_RE.test(t.color) ? t.color : '#9aa4ad',
      volume: num(t.volume, -100, 12, 0), pan: num(t.pan, -1, 1, 0), mute: bool(t.mute), solo: bool(t.solo), arm: false, monitor: bool(t.monitor),
      inputDeviceId: str(t.inputDeviceId, 200, 'default'), inputChannel: /^(\d{1,2}|stereo)$/.test(t.inputChannel) ? t.inputChannel : '0',
      midiInput: str(t.midiInput, 200, 'all'),
      instrument: INSTRUMENTS.includes(t.instrument) ? t.instrument : null,
      instrumentSource: ['auto', 'manual'].includes(t.instrumentSource) ? t.instrumentSource : null,
      role: ROLES[t.role] ? t.role : null, roleSource: ['auto', 'manual'].includes(t.roleSource) ? t.roleSource : null,
      fromBar: int(t.fromBar, 1, 9999, 1), preset: t.preset == null ? null : str(t.preset, 64),
      detection: null, adaptive: { enabled: bool(t.adaptive && t.adaptive.enabled), amount: num(t.adaptive && t.adaptive.amount, 0, 100, 60) },
      groupId: t.groupId == null ? null : id(t.groupId, 'group'), folded: bool(t.folded),
      fx: fxList(t.fx), slots, arrangement: kind === 'group' ? [] : arr(t.arrangement, LIMITS.clipsPerTrack, 'clips').map((c) => clip(c, true, bufferIds)),
    };
    if (kind === 'midi') {
      const it = t.inst && INSTRUMENT_TYPES[t.inst.type] ? t.inst.type : 'synth';
      nt.inst = { type: it, values: params(INSTRUMENT_TYPES[it].params, t.inst && t.inst.values) };
      const L = locks(t.inst && t.inst.locks, INSTRUMENT_TYPES[it].params); if (L) nt.inst.locks = L;
      if (it === 'drums' && t.inst.pads) { const pads = sanitizePads(t.inst.pads); if (Object.keys(pads).length) { nt.inst.pads = pads; padBufferIds(pads).forEach((b) => bufferIds.add(b)); } }
      nt.midiFx = midiFxList(t.midiFx);
      const pl = pluginList(t.plugins); if (pl.length) nt.plugins = pl;
      if (t.seq != null) { const sq = sanitizeSeq(t.seq); if (sq) nt.seq = sq; }
    }
    p.tracks.push(nt);
  }
  for (const t of p.tracks) if (t.groupId && !p.tracks.some((g) => g.id === t.groupId && g.kind === 'group' && g.id !== t.id)) t.groupId = null;
  for (const m of arr(raw.midiMap, LIMITS.midiMap, 'MIDI mappings')) {
    if (!m || !seen.has(m.trackId) && m.trackId !== 'master') continue;
    const plug = typeof m.fx === 'string' && /^plugin:[\w-]{1,40}$/.test(m.fx);
    const target = m.fx === 'inst' ? 'inst' : plug ? m.fx : int(m.fx, 0, LIMITS.fxPerTrack - 1, 0);
    if (plug && pidx(m.key) == null) continue;
    p.midiMap.push({ ch: int(m.ch, 0, 15, 0), cc: int(m.cc, 0, 127, 0), trackId: m.trackId, fx: target, key: str(m.key, 32) });
  }
  return { project: p, bufferIds };
}
