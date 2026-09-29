// Hosted plugins in the desktop app: project model <-> native engine, plus the plugin device card.
//
// Routing (see docs/PLUGIN-HOSTING.md): a MIDI track whose instrument is a plugin is a "native track". Its notes
// (after the track's MIDI effects) go to the native engine with engine timestamps; the plugin chain renders there
// and plays straight to the audio device. Audio is never streamed back into Web Audio (an IPC round trip adds
// latency and drifts). Web effects of that track do not apply; the track's volume/pan/mute (plus group and
// master volume) are mirrored to the engine. Offline render (bounce/freeze) is done by the engine's `render`.
//
// Project model, per track: t.plugins = [{ id, uid, name, format, vendor, instrument, enabled, state (base64),
//   values: { paramIndex: 0..1 } (every parameter Auduio has touched, so undo can restore it), locks: [index],
//   macros: [{ name, value, targets: [{ i, min, max }] }] (8), auto: { paramIndex: [[beat, value], ...] } }]
import { EngineClient, NativeInstrumentProxy, pluginSupport } from './host.js';
import { h, toast } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createKnob } from '../ui/controls.js';

const MAX_ROWS = 60;
const newId = () => 'pl' + Math.random().toString(36).slice(2, 9);

export function createPluginApi(deps) {
  const { engine, change, history, markDirty, renderAll, renderDevices, addTrack } = deps;
  const project = () => deps.getProject();
  const client = new EngineClient();
  const rt = new Map(); // plugin entry id -> { instanceId, trackId, params, byIndex, values, hasEditor, loading, error, touched }
  const api = { order: new Map(), list: [], status: '', connected: false, device: null, scanning: false, client, rt, recArm: new Set(), mapMode: null };
  const trackOf = (pid) => { const p = project(); if (!p) return null; for (const t of p.tracks) { const e = (t.plugins || []).find((x) => x.id === pid); if (e) return { t, e }; } return null; };
  const isNative = (t) => !!(t && t.kind === 'midi' && t.plugins && t.plugins[0] && t.plugins[0].instrument);
  api.isNative = isNative;

  engine.instrumentFactory = (ctx, t) => (isNative(t) && api.connected ? new NativeInstrumentProxy(ctx, client, t.id, t.plugins[0].name) : null);

  api.init = async () => {
    if (!pluginSupport().desktop) return false;
    try {
      const info = await client.connect();
      api.connected = true; api.info = info;
      try { api.device = await client.request('audio.open', {}, 20000); client.info.device = api.device; } catch (e) { api.device = null; api.status = 'No audio output for plugins: ' + e.message; }
      const L = await client.request('plugins.list');
      api.list = (L.plugins || []).sort((a, b) => a.name.localeCompare(b.name));
      if (!api.list.length) api.status = api.status || 'No plugins yet. Scan your plugin folders.';
      client.on('scan.progress', (m) => { api.status = `Scanning ${m.done || 0}/${m.total || '?'}: ${String(m.file || '').split(/[\\/]/).pop()}`; deps.renderBrowser(); });
      client.on('scan.done', (m) => {
        api.scanning = false; api.list = (m.plugins || []).sort((a, b) => a.name.localeCompare(b.name));
        const bad = (m.failed || []).length; api.status = `${api.list.length} plugin${api.list.length === 1 ? '' : 's'} found` + (bad ? `, ${bad} skipped (crashed or timed out while scanning)` : '');
        deps.renderBrowser(); toast(api.status, 3000);
      });
      client.on('params', onParams);
      client.on('editor.closed', () => {});
      client.on('exit', (x) => {
        api.connected = !!x.restarting; for (const r of rt.values()) { r.instanceId = null; r.error = 'engine restarted'; }
        toast(x.restarting ? 'The plugin engine stopped (a plugin may have crashed). Restarting it and reloading your plugins...' : 'The plugin engine stopped.', 5000);
        if (x.restarting) setTimeout(() => { client.transport = null; api.init().then(() => api.sync(true)); }, 1500);
        renderDevices();
      });
      setInterval(tick, 40); setInterval(() => { if (api.device) client.syncClock(engine.ctx).catch(() => {}); }, 3000);
      if (api.device) await client.syncClock(engine.ctx).catch(() => {});
      await api.sync(true);
      deps.renderBrowser();
      return true;
    } catch (e) { api.connected = false; api.status = 'Plugin engine unavailable: ' + e.message; deps.renderBrowser(); return false; }
  };
  api.scan = async () => {
    if (!api.connected) return toast(api.status || 'Plugin engine is not running.', 4000);
    api.scanning = true; api.status = 'Scanning plugin folders (each plugin is checked in a separate process)...'; deps.renderBrowser();
    try { await client.request('scan', {}, 10000); } catch (e) { api.scanning = false; api.status = 'Scan failed: ' + e.message; deps.renderBrowser(); }
  };

  // ------------------------------------------------------------ project <-> engine
  async function load(t, e, slot) {
    const r = { trackId: t.id, loading: true, params: [], byIndex: new Map(), values: {}, touched: new Map() };
    rt.set(e.id, r);
    try {
      const args = { trackId: t.id, uid: e.uid, name: e.name, slot };
      if (e.file) args.file = e.file; if (e.state) args.state = e.state;
      const L = await client.request('plugin.load', args, 60000);
      Object.assign(r, { instanceId: L.instanceId, hasEditor: L.hasEditor, latency: L.latency, loading: false, error: null });
      setParamsList(r, L.params);
      const vals = Object.entries(e.values || {}).filter(([k, v]) => r.byIndex.has(+k) && Math.abs(r.values[k] - v) > 1e-5).map(([k, v]) => [+k, v]);
      if (vals.length) { await client.request('param.setMany', { instanceId: r.instanceId, values: vals }); vals.forEach(([k, v]) => (r.values[k] = v)); }
      if (!e.file && L.plugin && L.plugin.file) e.file = L.plugin.file;
    } catch (err) { r.loading = false; r.error = err.message; }
    renderDevices();
    return r;
  }
  function setParamsList(r, params) {
    r.params = params || []; r.byIndex = new Map(r.params.map((p) => [p.i, p]));
    for (const p of r.params) { r.values[p.i] = p.value; }
  }
  function unload(pid) { const r = rt.get(pid); rt.delete(pid); if (r && r.instanceId) client.post('plugin.unload', { instanceId: r.instanceId }); }
  // bring the engine in line with the project (load, after undo/redo, after an engine restart)
  api.sync = async (full) => {
    const p = project(); if (!p || !api.connected) return;
    const want = new Map();
    for (const t of p.tracks) (t.plugins || []).forEach((e, i) => want.set(e.id, { t, e, i }));
    for (const pid of [...rt.keys()]) if (!want.has(pid) || (want.get(pid).t.id !== rt.get(pid).trackId)) unload(pid);
    for (const t of p.tracks) {
      if (t.kind !== 'midi') continue;
      const order = (t.plugins || []).map((e) => e.id).join(',');
      if (!full && api.order.has(t.id) && api.order.get(t.id) !== order && (t.plugins || []).length) { (t.plugins || []).forEach((e) => unload(e.id)); client.post('track.remove', { trackId: t.id }); }
      for (const [i, e] of (t.plugins || []).entries()) {
        const r = rt.get(e.id);
        if (!r || !r.instanceId && !r.loading) await load(t, e, i);
        else if (r.instanceId) {
          const vals = Object.entries(e.values || {}).filter(([k, v]) => Math.abs((r.values[k] ?? -1) - v) > 1e-5).map(([k, v]) => [+k, v]);
          if (vals.length) { client.post('param.setMany', { instanceId: r.instanceId, values: vals }); vals.forEach(([k, v]) => (r.values[k] = v)); }
        }
      }
      api.order.set(t.id, order);
      const n = engine.tracks.get(t.id);
      if (n && (n.inst && n.inst.type === 'plugin') !== isNative(t)) engine.setInstrument(t);
    }
    api.lastMix = new Map();
  };

  api.addToTrack = async (it, t, isMaster) => {
    const info = api.list.find((p) => p.uid === it.uid) || { uid: it.uid, name: it.name || 'Plugin', format: 'VST3', isInstrument: !!it.instrument };
    if (!api.connected) return toast(api.status || 'Plugin engine is not running.', 4000);
    const entry = { id: newId(), uid: info.uid, name: info.name, format: info.format || 'VST3', vendor: info.vendor || '', instrument: !!info.isInstrument, enabled: true, file: info.file, values: {}, macros: defaultMacros(), auto: {} };
    if (entry.instrument) {
      if (!t || isMaster || t.kind !== 'midi') { t = addTrack(null, 'midi', 'synth'); if (!t) return; t.name = info.name.slice(0, 32); }
      change('Add plugin ' + info.name, () => { t.plugins = [entry, ...(t.plugins || []).filter((e) => !e.instrument)]; });
    } else {
      if (!t || !isNative(t)) return toast('Plugin effects go after a plugin instrument (on its track). Audio tracks through plugin effects are planned; for now use the built-in effects there.', 6000);
      if (t.plugins.length >= 8) return toast('Up to 8 plugins per track.');
      change('Add plugin ' + info.name, () => { t.plugins.push(entry); });
    }
    deps.select(t.id);
    await api.sync(false);
    toast(`Added ${info.name} to ${t.name}`, 1800);
    renderAll();
  };
  api.remove = (t, pid) => { change('Remove plugin', () => { t.plugins = t.plugins.filter((e) => e.id !== pid); if (!t.plugins.length) delete t.plugins; }); unload(pid); api.sync(false).then(renderAll); };
  api.openEditor = async (pid) => {
    const r = rt.get(pid); if (!r || !r.instanceId) return toast('The plugin is not loaded.', 2500);
    try { await client.request('editor.open', { instanceId: r.instanceId }, 30000); } catch (e) { toast('Could not open the plugin window: ' + e.message, 4000); }
  };

  // ------------------------------------------------------------ parameters
  const now = () => performance.now();
  // set a plugin parameter from Auduio (slider, macro, MIDI learn). history: coalesced undo step per parameter
  api.setParam = (pid, i, v, opts = {}) => {
    const f = trackOf(pid), r = rt.get(pid); if (!f || !r) return;
    v = Math.max(0, Math.min(1, +v)); i = +i;
    if (f.e.values[i] == null && r.values[i] != null) f.e.values[i] = r.values[i]; // so undo can go back to it
    if (opts.history !== false) history.push('Change ' + ((r.byIndex.get(i) || {}).name || 'parameter'), `pl:${pid}:${i}`);
    f.e.values[i] = v; r.values[i] = v; r.touched.set(i, now());
    if (r.instanceId) client.post('param.set', { instanceId: r.instanceId, index: i, value: v });
    recordAuto(f.e, i, v);
    stateSoon(pid); if (opts.history !== false) markDirty();
  };
  function onParams(m) {
    let pid = null; for (const [k, r] of rt) if (r.instanceId === m.instanceId) pid = k;
    if (!pid) return; const r = rt.get(pid), f = trackOf(pid); if (!f) return;
    let changed = false;
    for (const [i, v, text] of m.changes || []) {
      const p = r.byIndex.get(i); if (p && text != null) p.text = text;
      if (Math.abs((r.values[i] ?? -1) - v) < 1e-4) { if (p) p.value = v; continue; } // echo of our own change
      if (!changed) history.push('Plugin edit: ' + f.e.name, 'ple:' + pid);
      changed = true;
      if (f.e.values[i] == null && r.values[i] != null) f.e.values[i] = r.values[i];
      r.values[i] = v; if (p) p.value = v; f.e.values[i] = v; r.touched.set(i, now());
      recordAuto(f.e, i, v);
    }
    if (changed) { markDirty(); stateSoon(pid); }
    deps.onParamsChanged && deps.onParamsChanged(pid, m);
  }
  const stateTimers = new Map();
  function stateSoon(pid) {
    clearTimeout(stateTimers.get(pid));
    stateTimers.set(pid, setTimeout(async () => {
      const r = rt.get(pid), f = trackOf(pid); if (!r || !r.instanceId || !f) return;
      try { const s = await client.request('state.get', { instanceId: r.instanceId }); if (s.data && s.data.length <= 8 * 1024 * 1024) { f.e.state = s.data; markDirty(); } } catch (e) {}
    }, 1500));
  }
  api.captureStates = async () => { for (const pid of rt.keys()) { clearTimeout(stateTimers.get(pid)); const r = rt.get(pid), f = trackOf(pid); if (r && r.instanceId && f) { try { const s = await client.request('state.get', { instanceId: r.instanceId }); f.e.state = s.data; } catch (e) {} } } };

  // ------------------------------------------------------------ randomizer target
  api.visibleParams = (pid) => { const r = rt.get(pid); return r ? r.params.filter((p) => !p.hidden && p.automatable !== false) : []; };
  api.target = (t, pid) => {
    const e = (t.plugins || []).find((x) => x.id === pid), r = rt.get(pid); if (!e || !r || !r.instanceId) return null;
    const pend = [];
    const defs = api.visibleParams(pid).map((p) => ({ key: String(p.i), label: p.name, min: 0, max: 1, def: p.def, plugin: true,
      ...(p.options && p.options.length > 1 ? { type: 'select', options: p.options.map((_, k) => k / (p.options.length - 1)) } : {}) }));
    return { label: e.name, type: 'plugin', defs, holder: e, values: () => Object.fromEntries(Object.entries(r.values).map(([k, v]) => [String(k), v])),
      prepare: (keys) => { for (const k of keys) if (e.values[k] == null && r.values[k] != null) e.values[k] = r.values[k]; },
      set: (k, v) => { e.values[k] = v; r.values[k] = v; const pp = r.byIndex.get(+k); if (pp) pp.value = v; pend.push([+k, v]); },
      commit: () => { if (pend.length) client.post('param.setMany', { instanceId: r.instanceId, values: pend.splice(0) }); stateSoon(pid); } };
  };

  // ------------------------------------------------------------ macros + automation
  function defaultMacros() { return Array.from({ length: 8 }, (_, k) => ({ name: 'Macro ' + (k + 1), value: 0, targets: [] })); }
  api.setMacro = (pid, mi, v) => {
    const f = trackOf(pid); if (!f) return; const m = f.e.macros && f.e.macros[mi]; if (!m) return;
    history.push('Macro ' + (mi + 1), `plm:${pid}:${mi}`);
    m.value = v; for (const x of m.targets) api.setParam(pid, x.i, x.min + (x.max - x.min) * v, { history: false });
    markDirty();
  };
  api.toggleMacroTarget = (pid, mi, i) => {
    const f = trackOf(pid); if (!f) return; f.e.macros = f.e.macros && f.e.macros.length ? f.e.macros : defaultMacros();
    const m = f.e.macros[mi], r = rt.get(pid), cur = r ? r.values[i] ?? 0 : 0;
    change('Map macro', () => { const k = m.targets.findIndex((x) => x.i === i); if (k >= 0) m.targets.splice(k, 1); else if (m.targets.length < 32) m.targets.push({ i, min: 0, max: 1 }); });
    return cur;
  };
  const beatNow = () => engine.position() / engine.beatDur;
  function recordAuto(e, i, v) {
    if (!engine.playing || !api.recArm.has(e.id)) return;
    e.auto = e.auto || {}; const lane = e.auto[i] || (e.auto[i] = []); const b = +beatNow().toFixed(3);
    const last = lane.lastRec; // overwrite what was there since the previous recorded point
    if (last != null && b > last) for (let k = lane.length - 1; k >= 0; k--) if (lane[k][0] > last && lane[k][0] <= b) lane.splice(k, 1);
    let k = lane.findIndex((q) => q[0] > b); if (k < 0) k = lane.length; lane.splice(k, 0, [b, +v.toFixed(4)]);
    Object.defineProperty(lane, 'lastRec', { value: b, enumerable: false, writable: true, configurable: true });
    if (lane.length > 20000) lane.shift();
  }
  api.clearAuto = (t, pid) => { const e = t.plugins.find((x) => x.id === pid); if (e) change('Clear automation', () => { e.auto = {}; }); renderDevices(); };
  const valueAt = (lane, b) => { if (!lane.length) return null; if (b <= lane[0][0]) return lane[0][1]; for (let k = 1; k < lane.length; k++) if (lane[k][0] >= b) { const [b0, v0] = lane[k - 1], [b1, v1] = lane[k]; return b1 > b0 ? v0 + (v1 - v0) * (b - b0) / (b1 - b0) : v1; } return lane[lane.length - 1][1]; };

  // ------------------------------------------------------------ periodic: automation playback, mix, transport
  let lastPlay = null, lastBpm = null;
  api.lastMix = new Map();
  function tick() {
    const p = project(); if (!p || !api.connected || !engine.ctx) return;
    if (engine.playing !== lastPlay || p.bpm !== lastBpm) { lastPlay = engine.playing; lastBpm = p.bpm; client.post('transport', { playing: !!engine.playing, bpm: p.bpm, ppq: beatNow() }); }
    const b = beatNow(), T = now();
    for (const t of p.tracks) {
      if (!t.plugins) continue;
      if (isNative(t)) { // mirror the web mix to the native track (it bypasses the Web Audio graph)
        const n = engine.tracks.get(t.id); let db = (t.volume || 0) + (p.master.volume || 0);
        for (let g = engine.groupOf(t), k = 0; g && k < 16; g = engine.groupOf(g), k++) db += g.volume || 0;
        const mute = n ? n.mute.gain.value < 0.5 : !!t.mute, key = `${db.toFixed(2)}|${(t.pan || 0).toFixed(3)}|${mute}`;
        if (api.lastMix.get(t.id) !== key) { api.lastMix.set(t.id, key); client.post('track.set', { trackId: t.id, gainDb: db, pan: t.pan || 0, mute }); }
      }
      if (!engine.playing) continue;
      for (const e of t.plugins) {
        const r = rt.get(e.id); if (!r || !r.instanceId || !e.auto) continue;
        const vals = [];
        for (const [k, lane] of Object.entries(e.auto)) {
          const i = +k; if (T - (r.touched.get(i) || 0) < 400) continue; // the user is moving it right now
          if (api.recArm.has(e.id) && T - (r.touched.get(i) || 0) < 1200) continue;
          const v = valueAt(lane, b); if (v == null || Math.abs((r.values[i] ?? -1) - v) < 0.002) continue;
          r.values[i] = v; const pp = r.byIndex.get(i); if (pp) pp.value = v; vals.push([i, v]);
        }
        if (vals.length) client.post('param.setMany', { instanceId: r.instanceId, values: vals });
      }
    }
  }
  return api;
}

// ------------------------------------------------------------------ the plugin device card
// ui: { randButtons, markLock, toggleLock, renderDevices, learn: { active, set(target) }, mapped(fx, key), expanded(key) }
export function pluginCard(api, t, idx, ui) {
  const e = t.plugins[idx], r = api.rt.get(e.id), ekey = `${t.id}:pl:${e.id}`, expanded = ui.isExpanded(ekey);
  const card = h('div', { class: 'device plugin' + (expanded ? ' expanded' : ''), 'data-type': 'plugin', 'data-plugin': e.id, style: { '--fx': e.instrument ? '#8B5CF6' : '#EF4444' }, title: `${e.name} (${e.format}${e.vendor ? ', ' + e.vendor : ''}) - runs in the native plugin engine` });
  card.append(h('div', { class: 'dev-bar' },
    h('span', { class: 'dev-kind', title: e.instrument ? 'Plugin instrument' : 'Plugin effect' }, icon('plug')),
    h('span', { class: 'dev-name' }, e.name),
    h('span', { class: 'fmt-badge' }, e.format),
    h('button', { class: 'pl-editor', title: 'Open the plugin\'s own window', 'aria-label': 'Open plugin window', disabled: !(r && r.instanceId && r.hasEditor), onclick: () => api.openEditor(e.id) }, icon('editor')),
    ...ui.randButtons(() => [api.target(t, e.id)].filter(Boolean), t.id),
    h('button', { class: 'expand', title: expanded ? 'Collapse' : 'Expand (all parameters)', onclick: () => ui.toggleExpanded(ekey) }, icon(expanded ? 'chevUp' : 'chevDown')),
    h('button', { class: 'rm', title: 'Remove plugin', 'aria-label': 'Remove plugin', onclick: () => api.remove(t, e.id) }, icon('close'))));
  const body = h('div', { class: 'dev-body pl-body' });
  if (!r || r.loading) { body.append(h('div', { class: 'pl-status' }, 'Loading...')); card.append(body); return card; }
  if (r.error || !r.instanceId) { body.append(h('div', { class: 'pl-status err' }, 'Not loaded: ' + (r.error || 'unknown error'))); card.append(body); return card; }
  const vis = api.visibleParams(e.id);
  // macros
  e.macros = e.macros && e.macros.length === 8 ? e.macros : Array.from({ length: 8 }, (_, k) => (e.macros && e.macros[k]) || { name: 'Macro ' + (k + 1), value: 0, targets: [] });
  const macros = h('div', { class: 'knobs pl-macros' });
  e.macros.forEach((m, mi) => {
    const k = createKnob({ key: 'm' + mi, label: /^Macro \d$/.test(m.name) ? 'M' + (mi + 1) : m.name.slice(0, 7), min: 0, max: 100, def: 0, unit: '%', help: `${m.name}: moves ${m.targets.length} mapped parameter(s). Use Map, then click parameters below.` }, Math.round(m.value * 100), (v) => api.setMacro(e.id, mi, v / 100));
    const wrap = h('div', { class: 'pl-macro' + (api.mapMode && api.mapMode.pid === e.id && api.mapMode.mi === mi ? ' mapping' : '') }, k,
      h('button', { class: 'small pl-map' + (api.mapMode && api.mapMode.pid === e.id && api.mapMode.mi === mi ? ' on' : ''), title: 'Map parameters to this macro: click, then click parameters in the list. Click again to finish.', onclick: () => { api.mapMode = api.mapMode && api.mapMode.pid === e.id && api.mapMode.mi === mi ? null : { pid: e.id, mi }; ui.renderDevices(); } }, m.targets.length ? `Map (${m.targets.length})` : 'Map'));
    macros.append(wrap);
  });
  body.append(macros);
  // tools: search, automation
  const autoCount = Object.keys(e.auto || {}).length;
  const list = h('div', { class: 'pl-params', role: 'list' });
  const search = h('input', { type: 'search', class: 'pl-search', placeholder: `Search ${vis.length} parameters`, 'aria-label': 'Search plugin parameters', value: ui.searchOf(e.id) || '' });
  const drawList = () => {
    list.innerHTML = ''; const q = search.value.trim().toLowerCase(); ui.setSearch(e.id, search.value);
    const rows = vis.filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, expanded ? MAX_ROWS * 4 : MAX_ROWS);
    const map = api.mapMode && api.mapMode.pid === e.id ? e.macros[api.mapMode.mi] : null;
    for (const p of rows) {
      const locked = (e.locks || []).includes(String(p.i)), mapped = map && map.targets.some((x) => x.i === p.i), hasAuto = e.auto && e.auto[p.i];
      const val = h('span', { class: 'pl-val' }, p.text || (r.values[p.i] ?? p.value).toFixed(2));
      const sl = h('input', { type: 'range', min: 0, max: 1, step: 0.001, value: r.values[p.i] ?? p.value, 'aria-label': p.name, title: p.name,
        oninput: (ev) => { api.setParam(e.id, p.i, +ev.target.value); val.textContent = (+ev.target.value).toFixed(2); } });
      const row = h('div', { class: 'pl-row' + (locked ? ' rlocked' : '') + (mapped ? ' mapped' : '') + (ui.mapped('plugin:' + e.id, String(p.i)) ? ' learned' : ''), role: 'listitem', 'data-learn': `${t.id}:plugin:${e.id}:${p.i}`, 'data-i': p.i },
        h('span', { class: 'pl-name', title: p.name }, p.name), sl, val,
        hasAuto ? h('span', { class: 'pl-auto', title: 'This parameter has automation' }, 'A') : null,
        h('button', { class: 'pl-lock' + (locked ? ' on' : ''), title: locked ? 'Locked: the randomizer leaves this alone' : 'Lock (randomizer will not change it)', 'aria-label': locked ? 'Unlock parameter' : 'Lock parameter', onclick: () => { ui.toggleLock(e, String(p.i)); drawList(); } }, icon(locked ? 'lock' : 'unlock')));
      row.setValue = (v) => { sl.value = v; val.textContent = (+v).toFixed(2); };
      row.addEventListener('pointerdown', (ev) => {
        if (api.mapMode && api.mapMode.pid === e.id) { ev.preventDefault(); ev.stopPropagation(); api.toggleMacroTarget(e.id, api.mapMode.mi, p.i); drawList(); return; }
        if (ui.learn.active()) { ev.preventDefault(); ev.stopPropagation(); ui.learn.set({ trackId: t.id, fx: 'plugin:' + e.id, key: String(p.i), label: `${e.name} ${p.name}` }); row.classList.add('learn-target'); }
      }, true);
      list.append(row);
    }
    if (!rows.length) list.append(h('div', { class: 'pl-status' }, 'No parameter matches.'));
  };
  search.addEventListener('input', drawList);
  body.append(h('div', { class: 'pl-tools' }, search,
    h('button', { class: 'small pl-rec' + (api.recArm.has(e.id) ? ' on' : ''), title: 'Record automation: while playing, parameter moves (here, in the plugin window, macros, MIDI controller) are recorded', onclick: () => { api.recArm.has(e.id) ? api.recArm.delete(e.id) : api.recArm.add(e.id); ui.renderDevices(); } }, h('span', { class: 'rec-dot' }), 'Auto'),
    autoCount ? h('button', { class: 'small', title: 'Delete all automation of this plugin', onclick: () => api.clearAuto(t, e.id) }, `Clear (${autoCount})`) : null));
  body.append(list); drawList();
  card.append(body);
  return card;
}
