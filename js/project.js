// Project model, IndexedDB persistence, WAV encode/decode, and a minimal ZIP (store) reader/writer.
import { MASTER_PRESET } from './audio/presets.js';
import { validateProject } from './validate.js';

// varied, no yellows/oranges (v0.3 purple/red theme)
export const TRACK_COLORS = ['#EF4444', '#8B5CF6', '#3ecf8e', '#2fc6d6', '#4a9cff', '#d36bff', '#ff5fa2', '#9bd44a', '#6366F1', '#14B8A6', '#F43F5E', '#9aa4ad'];
export const NUM_SCENES = 8;
export const uid = (p = 'id') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

export function newProject(name = 'Untitled') {
  return {
    format: 'webdaw-project', version: 2, id: uid('p'), name, bpm: 120, beatsPerBar: 4, scenes: NUM_SCENES, key: { root: 0, scale: 'major' }, midiMap: [],
    created: Date.now(), modified: Date.now(),
    master: { volume: 0, fx: JSON.parse(JSON.stringify(MASTER_PRESET)).map((f) => ({ ...f, enabled: true })) },
    tracks: [],
  };
}
export function newTrack(project, name, kind = 'audio', instType = 'synth') {
  const i = project.tracks.length;
  const t = {
    id: uid('t'), kind, name: name || `${i + 1} ${kind === 'midi' ? (instType === 'drums' ? 'Drums' : 'Synth') : 'Audio'}`, color: TRACK_COLORS[i % TRACK_COLORS.length],
    midiInput: 'all', role: null, roleSource: null, fromBar: 1, adaptive: { enabled: false, amount: 60 },
    volume: 0, pan: 0, mute: false, solo: false, arm: false, monitor: false,
    inputDeviceId: 'default', inputChannel: '0',
    instrument: null, instrumentSource: null, detection: null, preset: null,
    fx: [], slots: new Array(project.scenes || NUM_SCENES).fill(null), arrangement: [],
  };
  if (kind === 'midi') t.inst = { type: instType, values: {} };
  t.groupId = null; t.folded = false;
  return t;
}

// --------------------------------------------------------------- IndexedDB
const DB_NAME = 'webdaw', DB_VER = 1;
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('buffers')) db.createObjectStore('buffers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const res = fn(t);
    t.oncomplete = () => resolve(res && res.result !== undefined ? res.result : res);
    t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
export const DB = {
  async saveProject(project, buffers) {
    const db = await openDB();
    project.modified = Date.now();
    const used = usedBufferIds(project);
    await tx(db, ['projects', 'buffers', 'meta'], 'readwrite', (t) => {
      t.objectStore('projects').put(JSON.parse(JSON.stringify(project)));
      for (const id of used) {
        const b = buffers.get(id); if (!b || b._saved) continue;
        const chans = []; for (let c = 0; c < b.numberOfChannels; c++) chans.push(b.getChannelData(c).slice());
        t.objectStore('buffers').put({ id, sampleRate: b.sampleRate, channels: chans });
        b._saved = true;
      }
      t.objectStore('meta').put({ key: 'lastProject', value: project.id });
    });
    db.close();
  },
  async loadProject(id, ctx) {
    const db = await openDB();
    const project = await new Promise((res, rej) => { const r = db.transaction('projects').objectStore('projects').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (!project) { db.close(); return null; }
    const buffers = new Map();
    for (const bid of usedBufferIds(project)) {
      const rec = await new Promise((res) => { const r = db.transaction('buffers').objectStore('buffers').get(bid); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      if (!rec) continue;
      const b = ctx.createBuffer(rec.channels.length, rec.channels[0].length, rec.sampleRate);
      rec.channels.forEach((d, c) => b.getChannelData(c).set(d));
      b._saved = true;
      buffers.set(bid, b);
    }
    db.close();
    return { project, buffers };
  },
  async lastProjectId() {
    const db = await openDB();
    const v = await new Promise((res) => { const r = db.transaction('meta').objectStore('meta').get('lastProject'); r.onsuccess = () => res(r.result && r.result.value); r.onerror = () => res(null); });
    db.close(); return v;
  },
  async listProjects() {
    const db = await openDB();
    const all = await new Promise((res) => { const r = db.transaction('projects').objectStore('projects').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
    db.close();
    return all.map((p) => ({ id: p.id, name: p.name, modified: p.modified, tracks: p.tracks.length })).sort((a, b) => b.modified - a.modified);
  },
  async deleteProject(id) {
    const db = await openDB();
    await tx(db, ['projects'], 'readwrite', (t) => t.objectStore('projects').delete(id));
    db.close();
    await DB.gcBuffers();
  },
  async gcBuffers() {
    const db = await openDB();
    const projects = await new Promise((res) => { const r = db.transaction('projects').objectStore('projects').getAll(); r.onsuccess = () => res(r.result || []); });
    const keep = new Set(); projects.forEach((p) => usedBufferIds(p).forEach((id) => keep.add(id)));
    const keys = await new Promise((res) => { const r = db.transaction('buffers').objectStore('buffers').getAllKeys(); r.onsuccess = () => res(r.result || []); });
    await tx(db, ['buffers'], 'readwrite', (t) => { keys.forEach((k) => { if (!keep.has(k)) t.objectStore('buffers').delete(k); }); });
    db.close();
  },
};
export function usedBufferIds(project) {
  const s = new Set();
  for (const t of project.tracks) {
    t.slots.forEach((c) => c && c.bufferId && s.add(c.bufferId));
    t.arrangement.forEach((c) => c.bufferId && s.add(c.bufferId));
  }
  return s;
}

// --------------------------------------------------------------- WAV
export function encodeWav(buffer, bits = 16) {
  const nc = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
  const bps = bits / 8, dataLen = len * nc * bps;
  const ab = new ArrayBuffer(44 + dataLen), v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true);
  ws(36, 'data'); v.setUint32(40, dataLen, true);
  const chans = []; for (let c = 0; c < nc; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nc; c++) {
    const s = Math.max(-1, Math.min(1, chans[c][i]));
    if (bits === 16) { v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    else if (bits === 24) { const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; }
    else { v.setFloat32(o, chans[c][i], true); o += 4; }
  }
  return new Uint8Array(ab);
}
export function decodeWav(bytes, ctx) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null;
  let o = 12, fmt = null;
  while (o + 8 <= bytes.length) {
    const id = str(o, 4), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = { format: v.getUint16(o + 8, true), nc: v.getUint16(o + 10, true), sr: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
      if (fmt.nc < 1 || fmt.nc > 8 || fmt.sr < 8000 || fmt.sr > 192000 || ![8, 16, 24, 32].includes(fmt.bits) || ![1, 3].includes(fmt.format)) throw new Error('Unsupported WAV format in project');
    }
    else if (id === 'data' && fmt) {
      const bps = fmt.bits / 8, frames = Math.floor(size / (bps * fmt.nc));
      const buf = ctx.createBuffer(fmt.nc, Math.max(1, frames), fmt.sr);
      const chans = []; for (let c = 0; c < fmt.nc; c++) chans.push(buf.getChannelData(c));
      let p = o + 8;
      for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.nc; c++) {
        let s;
        if (fmt.bits === 16) s = v.getInt16(p, true) / 32768;
        else if (fmt.bits === 24) { let x = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16); if (x & 0x800000) x |= ~0xffffff; s = x / 8388608; }
        else if (fmt.bits === 32 && fmt.format === 3) s = v.getFloat32(p, true);
        else if (fmt.bits === 32) s = v.getInt32(p, true) / 2147483648;
        else s = (bytes[p] - 128) / 128;
        chans[c][i] = s; p += bps;
      }
      return buf;
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

// --------------------------------------------------------------- ZIP (stored, no compression; audio doesn't compress well anyway)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zipFiles(files) { // files: [{name, data:Uint8Array}]
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
export const ZIP_LIMITS = { maxZipBytes: 1024 * 1024 * 1024, maxEntries: 2000, maxEntryBytes: 400 * 1024 * 1024, maxTotalBytes: 1536 * 1024 * 1024, maxJsonBytes: 8 * 1024 * 1024 };
// Only these entry names are accepted in a project archive (no paths, no traversal, no other types).
const ENTRY_RE = /^(project\.json|audio\/[A-Za-z0-9_-]{1,48}\.wav)$/;
export async function unzip(bytes, limits = ZIP_LIMITS) {
  if (bytes.length > limits.maxZipBytes) throw new Error('Archive too large');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = v.getUint16(eocd + 10, true); let p = v.getUint32(eocd + 16, true);
  if (count > limits.maxEntries) throw new Error('Too many entries in archive');
  const dec = new TextDecoder(); const out = Object.create(null); let total = 0;
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), lho = v.getUint32(p + 42, true);
    if (p + 46 + nlen > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt archive directory');
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (!ENTRY_RE.test(name)) throw new Error(`Rejected archive entry "${name.slice(0, 60)}" (unexpected file or path)`);
    if (name in out) throw new Error('Duplicate archive entry');
    const usize = v.getUint32(p + 24, true);
    if (csize > limits.maxEntryBytes || usize > limits.maxEntryBytes || (name === 'project.json' && usize > limits.maxJsonBytes)) throw new Error('Archive entry too large');
    if (lho + 30 > bytes.length || v.getUint32(lho, true) !== 0x04034b50) throw new Error('Corrupt archive entry');
    const lnlen = v.getUint16(lho + 26, true), lelen = v.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    if (start + csize > bytes.length) throw new Error('Corrupt archive entry size');
    let data = bytes.subarray(start, start + csize);
    if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Compressed zip entries are not supported in this browser');
      // stream-decompress with a hard cap (zip-bomb protection)
      const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const parts = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; if (got > Math.min(limits.maxEntryBytes, usize || limits.maxEntryBytes)) { reader.cancel(); throw new Error('Archive entry expands beyond its declared/allowed size'); } parts.push(value); }
      data = new Uint8Array(got); let o2 = 0; for (const q of parts) { data.set(q, o2); o2 += q.length; }
    } else if (method !== 0) throw new Error('Unsupported zip compression method ' + method);
    else if (csize !== usize) throw new Error('Corrupt stored entry');
    total += data.length; if (total > limits.maxTotalBytes) throw new Error('Archive expands too large');
    out[name] = data;
    p += 46 + nlen + elen + clen;
  }
  return out;
}

export function exportProjectZip(project, buffers, bits = 16) {
  const files = [{ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(project, null, 1)) }];
  for (const id of usedBufferIds(project)) { const b = buffers.get(id); if (b) files.push({ name: `audio/${id}.wav`, data: encodeWav(b, bits) }); }
  return zipFiles(files);
}
export async function importProjectFile(bytes, ctx) {
  let raw, files = Object.create(null);
  const parse = (u8) => { if (u8.length > ZIP_LIMITS.maxJsonBytes) throw new Error('project.json too large'); try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(u8)); } catch (e) { throw new Error('project.json is not valid JSON'); } };
  if (bytes[0] === 0x7b) raw = parse(bytes); // '{' plain JSON (no audio)
  else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    files = await unzip(bytes);
    if (!files['project.json']) throw new Error('project.json missing in archive');
    raw = parse(files['project.json']);
  } else throw new Error('Unknown file type (expected a .webdaw.zip project)');
  const { project, bufferIds } = validateProject(raw);
  // every audio file must be referenced by the project (reject unknown payloads)
  for (const name of Object.keys(files)) if (name !== 'project.json' && !bufferIds.has(name.slice(6, -4))) throw new Error(`Unreferenced file in archive: ${name}`);
  const buffers = new Map();
  for (const bid of bufferIds) {
    const f = files[`audio/${bid}.wav`]; if (!f) continue;
    const b = decodeWav(f, ctx);
    if (!b) throw new Error(`Audio ${bid} is not a valid WAV file`);
    buffers.set(bid, b);
  }
  return { project, buffers };
}
