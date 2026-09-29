// Strict schema validation for imported projects. Builds a fresh whitelisted object:
// unknown keys are dropped, numbers clamped, strings length-limited, ids pattern-checked,
// effect/instrument types and parameter keys must be known. Throws on structural problems.
import { EFFECT_TYPES, RACK_LIMITS } from './audio/effects.js';
import { INSTRUMENT_TYPES } from './audio/instruments.js';
import { INSTRUMENTS, ROLES } from './audio/presets.js';
import { SCALES } from './audio/pitchdsp.js';

export const LIMITS = { tracks: 128, fxPerTrack: 16, clipsPerTrack: 5000, notesPerClip: 20000, scenes: 64, midiMap: 256 };
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
function fxList(list, allowRack = true, max = LIMITS.fxPerTrack) {
  return arr(list, max, 'effects').map((f) => {
    if (!f || typeof f !== 'object' || !EFFECT_TYPES[f.type]) fail('unknown effect type');
    if (f.type === 'rack' && !allowRack) fail('racks cannot be nested');
    const out = { type: f.type, enabled: f.enabled !== false, values: params(EFFECT_TYPES[f.type].params, f.values) };
    if (f.type === 'rack') Object.assign(out, validateRack(f));
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
  if (arrangement) Object.assign(out, { id: id(c.id, 'clip'), start: num(c.start, 0, 86400, 0), offset: num(c.offset, 0, 86400, 0), duration: num(c.duration, 0.001, 86400, 1) });
  else out.loopLength = num(c.loopLength, 0.01, 3600, 1);
  return out;
}

export function validateProject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not an object');
  if (raw.format !== 'webdaw-project') fail('not a WebDAW project');
  if (![1, 2].includes(raw.version)) fail('unsupported version');
  const scenes = int(raw.scenes, 1, LIMITS.scenes, 8);
  const bufferIds = new Set(), seen = new Set();
  const p = {
    format: 'webdaw-project', version: 2, id: id(raw.id, 'project'), name: str(raw.name, 100, 'Imported'),
    bpm: num(raw.bpm, 20, 400, 120), beatsPerBar: int(raw.beatsPerBar, 1, 16, 4), scenes,
    created: num(raw.created, 0, 1e14, Date.now()), modified: num(raw.modified, 0, 1e14, Date.now()),
    key: { root: int(raw.key && raw.key.root, 0, 11, 0), scale: SCALES[raw.key && raw.key.scale] ? raw.key.scale : 'major' },
    master: { volume: num(raw.master && raw.master.volume, -100, 12, 0), fx: fxList(raw.master && raw.master.fx) },
    tracks: [], midiMap: [], keyFollow: bool(raw.keyFollow),
  };
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
    }
    p.tracks.push(nt);
  }
  for (const t of p.tracks) if (t.groupId && !p.tracks.some((g) => g.id === t.groupId && g.kind === 'group' && g.id !== t.id)) t.groupId = null;
  for (const m of arr(raw.midiMap, LIMITS.midiMap, 'MIDI mappings')) {
    if (!m || !seen.has(m.trackId) && m.trackId !== 'master') continue;
    const target = m.fx === 'inst' ? 'inst' : int(m.fx, 0, LIMITS.fxPerTrack - 1, 0);
    p.midiMap.push({ ch: int(m.ch, 0, 15, 0), cc: int(m.cc, 0, 127, 0), trackId: m.trackId, fx: target, key: str(m.key, 32) });
  }
  return { project: p, bufferIds };
}
