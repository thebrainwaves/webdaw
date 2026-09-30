// Drum Rack UI: 128 pads = MIDI notes 0-127. A tiny 4x32 overview of all pads (pads with
// your own sample are lit) sits beside the 4x4 pad view; click or drag in the overview to choose which 16
// pads are shown. Pads take user samples (drag and drop files or a folder, or "Load sample"), each with
// trim, gain, pitch, one-shot/gate and choke group. All edits go through api.change() (undoable).
import { h, $$, toast, haptic } from './dom.js';
import { icon } from './icons.js';
import { DEVICE_MIME } from './browser.js';
import * as DR from '../audio/drumrack.js';

export function createDrumRack(api) {
  const { S, engine } = api;
  S.padView = S.padView || {}; S.padSel = S.padSel || {};
  const peakCache = new Map(); // bufferId -> Float32Array peaks (small; the waveform pictures)
  const pads = (t) => (t.inst && t.inst.pads) || {};
  const viewOf = (t) => DR.clampView(S.padView[t.id] != null ? S.padView[t.id] : DR.DEFAULT_VIEW);
  const selOf = (t) => { const s = S.padSel[t.id]; return s != null ? s : viewOf(t); };
  const name = (t, n) => DR.padName(n, pads(t));
  const isDrumTrack = (t) => !!(t && t.kind === 'midi' && t.inst && t.inst.type === 'drums');

  // update every rack on screen in place (device card, phone, sequencer). Elements under the finger/mouse are
  // kept (so drags and long-presses keep working); only the 4x4 grid is rebuilt when the view moves.
  let seqDirty = false;
  function syncOverview(el, t) {
    const lo = viewOf(t), sel = selOf(t), P = pads(t);
    const win = el.querySelector('.dr-ovwin'); if (win) win.style.top = ((31 - (lo / 4 + 3)) / 32 * 100) + '%';
    el.setAttribute('aria-valuenow', lo); el.setAttribute('aria-valuetext', `Pads ${DR.noteLabel(lo)} to ${DR.noteLabel(lo + 15)}`);
    el.querySelectorAll('.dr-ovc').forEach((c) => { const n = +c.dataset.n; c.classList.toggle('sel', n === sel); c.classList.toggle('has', !!P[n]); });
  }
  function refresh(t, what = 'all') {
    $$(`.dr-ov[data-tid="${t.id}"]`).forEach((el) => syncOverview(el, t));
    $$(`.dr-rack[data-tid="${t.id}"]`).forEach((el) => {
      const phone = el.classList.contains('phone'), g = el.querySelector('.dr-grid'), lo = viewOf(t);
      if (what === 'sel' && g && +g.dataset.lo === lo) { g.querySelectorAll('.dr-pad').forEach((p) => p.classList.toggle('sel', +p.dataset.note === selOf(t))); }
      else if (g) g.replaceWith(grid(t, phone));
      const r = el.querySelector('.dr-range'); if (r) r.textContent = `${DR.noteLabel(lo)}-${DR.noteLabel(lo + 15)}`;
    });
    $$(`.dr-edit[data-tid="${t.id}"]`).forEach((el) => el.replaceWith(editor(t, el.classList.contains('phone'))));
    if (what !== 'sel') { if ($$('.dr-ov.seq').some((e) => e._drag)) seqDirty = true; else if (api.refreshSeq) api.refreshSeq(); }
  }
  function setView(t, lo, quiet) {
    lo = DR.clampView(lo); if (lo === viewOf(t)) return;
    S.padView[t.id] = lo; if (!quiet) haptic(4); refresh(t, 'view');
  }
  function select(t, n) { if (S.padSel[t.id] === n) return; S.padSel[t.id] = n; refresh(t, 'sel'); }

  // ------------------------------------------------------------ overview strip (4 wide x 32 tall)
  function overview(t, kind = '') {
    const P = pads(t), lo = viewOf(t), sel = selOf(t);
    const used = api.usedNotes ? api.usedNotes(t) : new Set();
    const cells = [];
    for (let r = 0; r < 32; r++) for (let c = 0; c < 4; c++) {
      const n = DR.overviewNote(c, r);
      cells.push(h('i', { class: 'dr-ovc' + (P[n] ? ' has' : '') + (used.has(n) ? ' used' : '') + (n === sel ? ' sel' : ''), 'data-n': n }));
    }
    const winTop = (31 - (lo / 4 + 3)) / 32 * 100;
    const el = h('div', { class: 'dr-ov' + (kind ? ' ' + kind : ''), 'data-tid': t.id, role: 'slider', tabindex: 0, 'aria-label': 'Pad overview: choose which 16 of the 128 pads are shown',
      'aria-valuemin': 0, 'aria-valuemax': 112, 'aria-valuenow': lo, 'aria-valuetext': `Pads ${DR.noteLabel(lo)} to ${DR.noteLabel(lo + 15)}`,
      title: `All 128 pads. Lit = your own sample${used.size ? ', dot = used in a pattern or clip' : ''}. Click or drag to show other pads (now ${DR.noteLabel(lo)}-${DR.noteLabel(lo + 15)}).` },
    h('div', { class: 'dr-ovgrid' }, cells), h('div', { class: 'dr-ovwin', style: { top: winTop + '%' } }));
    const at = (e) => { const r = el.getBoundingClientRect(); const row = Math.max(0, Math.min(31, Math.floor((e.clientY - r.top) / r.height * 32))); setView(t, DR.viewFromOverviewRow(row)); };
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture && el.setPointerCapture(e.pointerId); el._drag = true; at(e); });
    el.addEventListener('pointermove', (e) => { if (el._drag) at(e); });
    const end = () => { el._drag = false; if (seqDirty) { seqDirty = false; if (api.refreshSeq) api.refreshSeq(); } }; el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => { const v = viewOf(t); if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); setView(t, v + (e.key === 'PageUp' ? 16 : 4)); } if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); setView(t, v - (e.key === 'PageDown' ? 16 : 4)); } });
    el.addEventListener('wheel', (e) => { e.preventDefault(); setView(t, viewOf(t) + (e.deltaY < 0 ? 4 : -4)); }, { passive: false });
    return el;
  }

  // ------------------------------------------------------------ waveform pictures
  function peaksOf(id, n = 48) {
    const key = id + ':' + n; if (peakCache.has(key)) return peakCache.get(key);
    const b = engine.buffers.get(id); if (!b) return null;
    const p = DR.peaks(b.getChannelData(0), n); peakCache.set(key, p); return p;
  }
  function drawWave(cv, pad, color, big) {
    const draw = () => {
      const pk = peaksOf(pad.bufferId, big ? 160 : 40); if (!pk) return;
      const dpr = devicePixelRatio || 1, w = cv.width = Math.max(1, cv.clientWidth * dpr), hh = cv.height = Math.max(1, cv.clientHeight * dpr), n = pk.length / 2;
      const g = cv.getContext('2d'); g.clearRect(0, 0, w, hh);
      const a = pad.start * w, b = pad.end * w;
      if (big) { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, a, hh); g.fillRect(b, 0, w - b, hh); }
      g.fillStyle = color; g.globalAlpha = 0.9;
      for (let i = 0; i < n; i++) { const x = i / n * w, lo = pk[2 * i], hi = pk[2 * i + 1]; const inside = x >= a && x <= b; g.globalAlpha = inside ? 0.95 : 0.3; g.fillRect(x, hh / 2 - hi * hh / 2, Math.max(1, w / n - (big ? 0.5 : 0)), Math.max(1, (hi - lo) * hh / 2)); }
      g.globalAlpha = 1;
      if (big) { g.fillStyle = '#ef4444'; g.fillRect(a, 0, 2 * dpr, hh); g.fillRect(b - 2 * dpr, 0, 2 * dpr, hh); }
    };
    if (engine.buffers.get(pad.bufferId)) requestAnimationFrame(draw);
    else engine.ensureBuffer(pad.bufferId).then((b) => { if (b) requestAnimationFrame(draw); });
  }

  // ------------------------------------------------------------ 4x4 pads
  function grid(t, phone) {
    const lo = viewOf(t), sel = selOf(t), P = pads(t);
    const g = h('div', { class: 'dr-grid', role: 'grid', 'data-lo': lo, 'aria-label': `Pads ${DR.noteLabel(lo)} to ${DR.noteLabel(lo + 15)}` });
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const n = DR.gridNote(lo, r, c), pad = P[n];
      const cv = pad ? h('canvas', { class: 'dr-wave', 'aria-hidden': 'true' }) : null;
      const el = h('button', { class: 'dr-pad' + (pad ? ' has' : '') + (n === sel ? ' sel' : ''), 'data-note': n, role: 'gridcell',
        title: `${name(t, n)} (${DR.noteLabel(n)}). Tap to play. ${phone ? 'Hold' : 'Right-click'} for Load sample / Clear. Drop audio files here${pad ? '' : ' (several files fill the next pads)'}.` },
      h('span', { class: 'dr-name' }, name(t, n)), h('span', { class: 'dr-note' }, DR.noteLabel(n)), cv,
      pad && pad.choke ? h('span', { class: 'dr-choke', title: 'Choke group ' + pad.choke }, 'C' + pad.choke) : null);
      if (cv) drawWave(cv, pad, '#c4b5fd', false);
      bindPad(t, el, n, phone);
      g.append(el);
    }
    return g;
  }
  function rack(t, phone) {
    const lo = viewOf(t);
    const nav = h('div', { class: 'dr-nav' },
      h('button', { class: 'sq-mini', 'aria-label': 'Show higher pads', title: 'Higher pads', onclick: () => setView(t, viewOf(t) + 4) }, icon('chevUp')),
      h('span', { class: 'dr-range' }, `${DR.noteLabel(lo)}-${DR.noteLabel(lo + 15)}`),
      h('button', { class: 'sq-mini', 'aria-label': 'Show lower pads', title: 'Lower pads', onclick: () => setView(t, viewOf(t) - 4) }, icon('chevDown')));
    return h('div', { class: 'dr-rack' + (phone ? ' phone' : ''), 'data-tid': t.id }, h('div', { class: 'dr-side' }, overview(t), nav), grid(t, phone));
  }
  function bindPad(t, el, n, phone) {
    let timer = null, long = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return; e.preventDefault(); long = false;
      el.classList.add('down'); api.noteEvent(t, n, 100, true); haptic(6); select(t, n);
      if (e.pointerType !== 'mouse') timer = setTimeout(() => { long = true; el.classList.remove('down'); api.noteEvent(t, n, 100, false); padMenu(t, n, e.clientX, e.clientY, true); }, 500);
    });
    const off = () => { clearTimeout(timer); if (el.classList.contains('down')) { el.classList.remove('down'); api.noteEvent(t, n, 100, false); } };
    el.addEventListener('pointerup', off); el.addEventListener('pointerleave', off); el.addEventListener('pointercancel', off);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!long) padMenu(t, n, e.clientX, e.clientY, phone || e.pointerType === 'touch'); });
    el.addEventListener('dragover', (e) => { const ty = [...(e.dataTransfer?.types || [])]; if (ty.includes('Files') || ty.includes(DEVICE_MIME)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', async (e) => {
      el.classList.remove('drop'); const dt = e.dataTransfer; if (!dt) return;
      const dev = dt.getData(DEVICE_MIME);
      if (dev) { let d = null; try { d = JSON.parse(dev); } catch (x) {} if (d && d.kind === 'sample') { e.preventDefault(); e.stopPropagation(); assignLibrary(t, n, d.id); } return; }
      if (![...dt.types].includes('Files')) return;
      e.preventDefault(); e.stopPropagation();
      const files = await filesFromDrop(dt); loadFiles(t, files, n);
    });
  }
  function padMenu(t, n, x, y, sheet) {
    const pad = pads(t)[n];
    const items = [
      { label: pad ? 'Replace sample...' : 'Load sample...', fn: () => pick(t, n, false) },
      { label: 'Load a folder (fills pads from here)...', fn: () => pick(t, n, true) },
      pad ? { label: 'Clear pad', fn: () => clearPad(t, n) } : null,
      { label: 'Play', fn: () => { api.noteEvent(t, n, 100, true); setTimeout(() => api.noteEvent(t, n, 100, false), 200); } },
    ].filter(Boolean);
    if (sheet && api.sheet) api.sheet(`${name(t, n)} (${DR.noteLabel(n)})`, items); else api.contextMenu(x, y, items);
  }

  // ------------------------------------------------------------ pad editor (selected pad)
  function editor(t, phone) {
    const n = selOf(t), pad = pads(t)[n];
    const box = h('div', { class: 'dr-edit' + (phone ? ' phone' : ''), 'data-tid': t.id });
    const head = h('div', { class: 'dr-ehead' }, h('b', {}, name(t, n)), h('span', { class: 'dr-note' }, DR.noteLabel(n) + ' / note ' + n),
      h('button', { class: 'small dr-load', title: 'Choose an audio file for this pad (WAV, AIFF, MP3, FLAC, OGG)', onclick: () => pick(t, n, false) }, icon('folder'), pad ? ' Replace' : ' Load sample'),
      pad ? h('button', { class: 'small dr-clear', title: 'Remove the sample from this pad (Undo brings it back)', onclick: () => clearPad(t, n) }, 'Clear') : null);
    box.append(head);
    if (!pad) { box.append(h('p', { class: 'hint dr-empty' }, 'Built-in sound. Drop an audio file on a pad, or use Load sample. Drop several files or a folder to fill the next pads.')); return box; }
    const cv = h('canvas', { class: 'dr-bigwave', title: 'Drag the red lines (or use Start and End) to trim the sample' });
    box.append(cv); drawWave(cv, pad, '#c4b5fd', true);
    // drag the trim lines on the waveform
    cv.addEventListener('pointerdown', (e) => {
      const r = cv.getBoundingClientRect(), f = (ev) => Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const which = Math.abs(f(e) - pad.start) < Math.abs(f(e) - pad.end) ? 'start' : 'end';
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      const mv = (ev) => { const v = f(ev); set(t, n, which, which === 'start' ? Math.min(v, pad.end - 0.005) : Math.max(v, pad.start + 0.005), true); drawWave(cv, pads(t)[n], '#c4b5fd', true); };
      mv(e); cv.onpointermove = mv; cv.onpointerup = cv.onpointercancel = () => { cv.onpointermove = null; refresh(t); };
    });
    const slider = (key, label, min, max, step, fmt) => {
      const out = h('span', { class: 'dr-val' }, fmt(pad[key]));
      const r = h('input', { type: 'range', min, max, step, value: pad[key], 'aria-label': label, 'data-k': key,
        oninput: (e) => { let v = +e.target.value; if (key === 'start') v = Math.min(v, pad.end - 0.005); if (key === 'end') v = Math.max(v, pad.start + 0.005); set(t, n, key, v, true); out.textContent = fmt(v); if (key === 'start' || key === 'end') drawWave(cv, pads(t)[n], '#c4b5fd', true); } });
      return h('label', { class: 'dr-sl' }, h('span', {}, label), r, out);
    };
    const pct = (v) => Math.round(v * 100) + '%';
    box.append(h('div', { class: 'dr-sliders' },
      slider('start', 'Start', 0, 0.99, 0.001, pct), slider('end', 'End', 0.01, 1, 0.001, pct),
      slider('gain', 'Gain', -24, 12, 0.5, (v) => (v > 0 ? '+' : '') + v + ' dB'), slider('pitch', 'Pitch', -24, 24, 1, (v) => (v > 0 ? '+' : '') + v + ' st')),
    h('div', { class: 'dr-opts' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Play mode' },
        h('button', { class: 'small' + (pad.mode !== 'gate' ? ' on' : ''), 'aria-pressed': String(pad.mode !== 'gate'), title: 'One-shot: the whole sample plays on every hit', onclick: () => { set(t, n, 'mode', 'one'); refresh(t); } }, 'One-shot'),
        h('button', { class: 'small' + (pad.mode === 'gate' ? ' on' : ''), 'aria-pressed': String(pad.mode === 'gate'), title: 'Gate: the sample stops when the note ends (or you let go of the pad)', onclick: () => { set(t, n, 'mode', 'gate'); refresh(t); } }, 'Gate')),
      h('label', { class: 'dr-choke-sel', title: 'Pads in the same choke group cut each other off (like open and closed hi-hat)' }, 'Choke ',
        h('select', { 'aria-label': 'Choke group', onchange: (e) => { set(t, n, 'choke', +e.target.value); refresh(t); } },
          ...Array.from({ length: DR.PAD_LIMITS.chokeGroups + 1 }, (_, i) => h('option', { value: i, selected: pad.choke === i }, i ? 'Group ' + i : 'None'))))));
    return box;
  }
  function set(t, n, key, v, coalesce) {
    api.change('Pad ' + key, () => { const p = t.inst.pads && t.inst.pads[n]; if (p) p[key] = v; engine.syncPads(t); }, coalesce ? `pad:${t.id}:${n}:${key}` : undefined);
  }
  function clearPad(t, n) {
    api.change('Clear pad', () => { const P = { ...pads(t) }; delete P[n]; if (Object.keys(P).length) t.inst.pads = P; else delete t.inst.pads; engine.syncPads(t); });
    toast(`Cleared ${DR.noteLabel(n)} (Undo brings it back)`); refresh(t); api.markChanged && api.markChanged(t);
  }

  // ------------------------------------------------------------ loading files
  function pick(t, n, folder) {
    const inp = h('input', { type: 'file', accept: DR.SAMPLE_ACCEPT, multiple: true, hidden: true });
    if (folder) inp.setAttribute('webkitdirectory', '');
    inp.addEventListener('change', () => { const f = [...inp.files]; inp.remove(); if (f.length) loadFiles(t, f, n); });
    document.body.append(inp); inp.click();
  }
  // files and folders from a drop (folders are read recursively, max 3 levels, max 512 entries)
  async function filesFromDrop(dt) {
    const items = [...(dt.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!items.length || !items.some((e) => e.isDirectory)) return [...dt.files];
    const out = []; let seen = 0;
    const walk = async (entry, depth) => {
      if (seen++ > 512) return;
      if (entry.isFile) { const f = await new Promise((res) => entry.file(res, () => res(null))); if (f) { try { Object.defineProperty(f, 'webkitRelativePath', { value: entry.fullPath }); } catch (e) {} out.push(f); } return; }
      if (entry.isDirectory && depth < 3) {
        const rd = entry.createReader(); let batch;
        do { batch = await new Promise((res) => rd.readEntries(res, () => res([]))); for (const e of batch) await walk(e, depth + 1); } while (batch.length && seen <= 512);
      }
    };
    for (const e of items) await walk(e, 0);
    return out;
  }
  async function decodeSample(f) {
    const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
    const bad = DR.checkSampleFile(f.name, f.size, head); if (bad) throw new Error(bad);
    let buf; try { buf = await engine.ctx.decodeAudioData(await f.arrayBuffer()); } catch (e) { throw new Error('could not be decoded (damaged or unsupported file)'); }
    if (!buf || !buf.length) throw new Error('contains no sound');
    const src = []; for (let c = 0; c < buf.numberOfChannels; c++) src.push(buf.getChannelData(c));
    const { chans, cut } = DR.compactChannels(src, buf.sampleRate);
    const b = engine.ctx.createBuffer(chans.length, chans[0].length, buf.sampleRate); chans.forEach((d, c) => b.copyToChannel(d, c));
    return { b, cut };
  }
  async function loadFiles(t, files, start) {
    if (!isDrumTrack(t)) return;
    const all = DR.sortFiles(files), audio = all.filter((f) => DR.SAMPLE_EXT.includes(DR.extOf(f.name)));
    if (!audio.length) { toast('No audio files found. Use WAV, AIFF, MP3, FLAC or OGG.'); return 0; }
    const room = DR.fillTargets(start, audio.length);
    const loaded = [], problems = []; let k = 0, cut = 0;
    toast(audio.length > 1 ? `Loading ${Math.min(audio.length, room.length)} samples...` : 'Loading sample...', 1500);
    for (const f of audio) {
      if (k >= room.length) break;
      try { const r = await decodeSample(f); const id = api.uid('s'); engine.buffers.set(id, r.b); if (r.cut) cut++; loaded.push([room[k++], DR.newPad(id, f.name), r.b]); }
      catch (e) { problems.push(`${f.name.slice(0, 40)}: ${e.message}`); }
    }
    if (loaded.length) {
      api.change(loaded.length === 1 ? 'Load sample' : `Load ${loaded.length} samples`, () => {
        const P = { ...pads(t) }; for (const [n, p] of loaded) P[n] = p; t.inst.pads = P; engine.syncPads(t);
      });
      S.padSel[t.id] = loaded[0][0];
      const last = loaded[loaded.length - 1][0]; if (last > viewOf(t) + 15 || loaded[0][0] < viewOf(t)) S.padView[t.id] = DR.clampView(loaded[0][0] - (loaded[0][0] % 4));
      if (api.library) api.library.add(loaded.map(([, p, b]) => ({ id: p.bufferId, name: p.name, dur: +b.duration.toFixed(3) })), loaded.map(([, p, b]) => [p.bufferId, b]));
      refresh(t); api.markChanged && api.markChanged(t); haptic(15);
    }
    const skipped = audio.length - loaded.length - problems.length, other = all.length - audio.length;
    const msg = [loaded.length ? `Loaded ${loaded.length} sample${loaded.length > 1 ? 's' : ''} from ${DR.noteLabel(loaded[0][0])}` : 'No sample loaded'];
    if (skipped > 0) msg.push(`${skipped} skipped (no free pads above ${DR.noteLabel(127)})`);
    if (other > 0) msg.push(`${other} non-audio file(s) ignored`);
    if (cut) msg.push(`${cut} cut to ${DR.PAD_LIMITS.maxSeconds} s`);
    if (problems.length) msg.push(`${problems.length} could not be used: ${problems.slice(0, 2).join('; ')}`);
    toast(msg.join('. ') + '.', problems.length ? 6000 : 3000);
    return loaded.length;
  }
  // a "My Samples" entry dropped or double-clicked onto a pad
  async function assignLibrary(t, n, id, nm) {
    if (!isDrumTrack(t)) return false;
    const b = await engine.ensureBuffer(id);
    if (!b) { toast('That sample is no longer available.'); if (api.library) api.library.remove(id); return false; }
    const entry = api.library && api.library.list().find((x) => x.id === id);
    api.change('Load sample', () => { const P = { ...pads(t) }; P[n] = DR.newPad(id, nm || (entry && entry.name) || 'Sample'); t.inst.pads = P; engine.syncPads(t); });
    S.padSel[t.id] = n; refresh(t); api.markChanged && api.markChanged(t); toast(`Loaded onto ${DR.noteLabel(n)}`); return true;
  }

  return { rack, editor, overview, viewOf, setView, selOf, select, loadFiles, assignLibrary, pick, padMenu, name, isDrumTrack, peaksOf,
    rows: (t) => { const lo = viewOf(t); return Array.from({ length: 16 }, (_, i) => lo + i); } };
}
