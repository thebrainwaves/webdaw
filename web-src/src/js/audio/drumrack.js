// Drum Rack model (pure, unit tested): 128 pads = MIDI notes 0-127, user samples per pad.
// A pad with a sample: { bufferId, name, start, end, gain, pitch, mode, choke }. Pads without a sample
// play the built-in synthesized kit. t.inst.pads is a sparse object keyed by note number.

export const PAD_COUNT = 128;
export const PAD_LIMITS = { maxFileBytes: 50 * 1024 * 1024, maxSeconds: 30, maxFiles: 128, nameLen: 40, chokeGroups: 8 };
export const SAMPLE_EXT = ['wav', 'wave', 'aif', 'aiff', 'aifc', 'mp3', 'flac', 'ogg', 'oga'];
export const SAMPLE_ACCEPT = '.wav,.wave,.aif,.aiff,.aifc,.mp3,.flac,.ogg,.oga,audio/wav,audio/x-wav,audio/aiff,audio/x-aiff,audio/mpeg,audio/flac,audio/ogg';
export const DEFAULT_VIEW = 36; // like Ableton: the 4x4 view starts at the kick (note 36)
const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteLabel = (n) => NN[n % 12] + (Math.floor(n / 12) - 1); // same naming as the rest of Auduio: 60 = C4, 36 = C2
const GM = { 35: 'Kick 2', 36: 'Kick', 37: 'Rim', 38: 'Snare', 39: 'Clap', 40: 'Snare 2', 41: 'Tom L', 42: 'Hat', 43: 'Tom L2', 44: 'Pedal Hat', 45: 'Tom M', 46: 'Open Hat', 47: 'Tom M2', 48: 'Tom H', 49: 'Crash', 50: 'Tom H2', 51: 'Ride', 52: 'China', 53: 'Ride Bell', 54: 'Tamb', 55: 'Splash', 56: 'Cowbell', 57: 'Crash 2', 59: 'Ride 2' };
export function padName(n, pads) { const p = pads && pads[n]; return (p && p.name) || GM[n] || noteLabel(n); }

// the 4x4 view scrolls in whole rows of 4; its lowest note is a multiple of 4 in 0..112
export const clampView = (lo) => Math.max(0, Math.min(PAD_COUNT - 16, Math.round((+lo || 0) / 4) * 4));
// overview strip: 4 wide x 32 tall, lowest notes at the bottom (like Ableton). cell -> note and back
export const overviewNote = (col, rowFromTop) => (31 - rowFromTop) * 4 + col;
export const viewFromOverviewRow = (rowFromTop) => clampView((31 - rowFromTop) * 4 - 6); // centre the 4-row window on the clicked row
// 4x4 grid cell (row 0 = top) -> note, bottom-left is the lowest note
export const gridNote = (lo, row, col) => lo + (3 - row) * 4 + col;

export function newPad(bufferId, name) {
  return { bufferId, name: cleanName(name), start: 0, end: 1, gain: 0, pitch: 0, mode: 'one', choke: 0 };
}
export function cleanName(s) {
  return String(s == null ? '' : s).replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, PAD_LIMITS.nameLen) || 'Sample';
}
const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
export function sanitizePad(p) {
  if (!p || typeof p !== 'object' || typeof p.bufferId !== 'string' || !ID_RE.test(p.bufferId)) return null;
  let start = num(p.start, 0, 0.999, 0), end = num(p.end, 0.001, 1, 1);
  if (end - start < 0.001) { start = 0; end = 1; }
  return { bufferId: p.bufferId, name: cleanName(p.name), start, end, gain: num(p.gain, -48, 12, 0), pitch: Math.round(num(p.pitch, -48, 48, 0)),
    mode: p.mode === 'gate' ? 'gate' : 'one', choke: Math.round(num(p.choke, 0, PAD_LIMITS.chokeGroups, 0)) };
}
export function sanitizePads(obj) {
  const out = {}; if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of Object.keys(obj).slice(0, PAD_COUNT * 2)) {
    if (!/^\d{1,3}$/.test(k) || +k >= PAD_COUNT) continue;
    const p = sanitizePad(obj[k]); if (p) out[+k] = p;
  }
  return out;
}
export const padBufferIds = (pads) => Object.values(pads || {}).map((p) => p && p.bufferId).filter(Boolean);

// dropping several files: fill consecutive pads from `start` upwards (stops at note 127)
export function fillTargets(start, count) {
  const out = []; for (let n = start; n < PAD_COUNT && out.length < Math.min(count, PAD_LIMITS.maxFiles); n++) out.push(n);
  return out;
}
// natural sort for folder drops (kick2 before kick10)
export const sortFiles = (files) => [...files].sort((a, b) => String(a.webkitRelativePath || a.name).localeCompare(String(b.webkitRelativePath || b.name), undefined, { numeric: true, sensitivity: 'base' }));

// file checks before decoding: extension + size + magic bytes must agree
export function extOf(name) { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
export function sniffAudio(bytes) {
  const b = bytes, s = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (!b || b.length < 12) return null;
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
  if (s(0, 4) === 'FORM' && (s(8, 4) === 'AIFF' || s(8, 4) === 'AIFC')) return 'aiff';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}
const FAMILY = { wav: 'wav', wave: 'wav', aif: 'aiff', aiff: 'aiff', aifc: 'aiff', mp3: 'mp3', flac: 'flac', ogg: 'ogg', oga: 'ogg' };
// returns null when fine, otherwise a plain-language reason
export function checkSampleFile(name, size, head) {
  const ext = extOf(name);
  if (!SAMPLE_EXT.includes(ext)) return 'not a supported audio file (use WAV, AIFF, MP3, FLAC or OGG)';
  if (!size) return 'the file is empty';
  if (size > PAD_LIMITS.maxFileBytes) return `larger than ${PAD_LIMITS.maxFileBytes / 1048576} MB`;
  const kind = sniffAudio(head);
  if (!kind) return 'the file content is not audio';
  if (kind !== FAMILY[ext]) return `the file says .${ext} but contains ${kind.toUpperCase()}`;
  return null;
}

// part of the sample a pad plays (seconds)
export function playRegion(pad, duration) {
  const a = Math.max(0, Math.min(1, pad.start || 0)) * duration, b = Math.max(0, Math.min(1, pad.end == null ? 1 : pad.end)) * duration;
  return { offset: a, length: Math.max(0.001, b - a) };
}
// memory: a stereo file whose channels are identical is stored as mono; long files are cut to maxSeconds
export function compactChannels(chans, sampleRate) {
  const max = Math.floor(PAD_LIMITS.maxSeconds * sampleRate); let cut = false;
  let out = chans.map((c) => { if (c.length > max) { cut = true; return c.subarray(0, max); } return c; });
  if (out.length > 2) out = out.slice(0, 2);
  if (out.length === 2) { const [l, r] = out; let same = true; for (let i = 0; i < l.length; i++) if (Math.abs(l[i] - r[i]) > 1e-6) { same = false; break; } if (same) out = [l]; }
  return { chans: out, cut };
}
// min/max peaks for a small waveform picture
export function peaks(data, n) {
  const out = new Float32Array(n * 2), step = Math.max(1, Math.floor(data.length / n));
  for (let i = 0; i < n; i++) { let lo = 0, hi = 0; const a = i * step, b = Math.min(data.length, a + step); for (let j = a; j < b; j += Math.max(1, (step >> 6))) { const v = data[j]; if (v < lo) lo = v; if (v > hi) hi = v; } out[2 * i] = lo; out[2 * i + 1] = hi; }
  return out;
}
