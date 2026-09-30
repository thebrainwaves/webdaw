// MIDI input: feature detection, input listing, message parsing. Routing, recording and MIDI-learn live in
// main.js via the callbacks below. Sources: Web MIDI (browsers, Windows desktop app) and, where the webview has
// no Web MIDI (macOS/Linux desktop app), the native engine's MIDI input (engine command midiin.*; channel
// messages only, rate-limited in the engine). Engine input ids are "engine:<port name>".
export const MIDI = {
  webSupported: typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function',
  get supported() { return this.webSupported || engineMidi.inAvailable; },
  access: null, status: 'idle', error: null, engineInputs: [],
  onNote: null,   // (inputId, ch, note, velocity, isOn, timeStamp)
  onCC: null,     // (inputId, ch, cc, value)
  onDevices: null,
  onBend: null,   // (inputId, ch, value -1..1)
  async init() {
    if (!this.webSupported) {
      if (!engineMidi.inAvailable) { this.status = 'unsupported'; return false; }
      await engineMidi.openInputs(); this.status = 'ready'; return true;
    }
    if (this.access) return true;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.status = 'ready';
      const attach = () => { for (const inp of this.access.inputs.values()) inp.onmidimessage = (e) => this.handle(inp.id, e); if (this.onDevices) this.onDevices(this.inputs()); };
      attach();
      this.access.onstatechange = attach;
      return true;
    } catch (e) { this.status = 'denied'; this.error = e.message || String(e); return false; }
  },
  inputs() { const web = this.access ? [...this.access.inputs.values()].map((i) => ({ id: i.id, name: i.name || 'MIDI input', state: i.state })) : []; const names = new Set(web.map((i) => i.name)); return web.concat(this.engineInputs.filter((i) => !names.has(i.name))); },
  handle(inputId, e) {
    const d = e.data; if (!d || d.length < 2 || d[0] >= 0xf0) return;
    const st = d[0] & 0xf0, ch = d[0] & 0x0f;
    if (st === 0x90 && d[2] > 0) this.onNote && this.onNote(inputId, ch, d[1], d[2], true, e.timeStamp);
    else if (st === 0x80 || (st === 0x90 && d[2] === 0)) this.onNote && this.onNote(inputId, ch, d[1], 0, false, e.timeStamp);
    else if (st === 0xb0) this.onCC && this.onCC(inputId, ch, d[1], d[2]);
    else if (st === 0xe0 && d.length > 2) this.onBend && this.onBend(inputId, ch, (((d[2] << 7) | d[1]) - 8192) / 8192);
  },
  notice() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (this.supported) return null;
    if (typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)) return 'MIDI devices are handled by the audio engine, which is not running. Restart Auduio; the on-screen keyboard, the computer keyboard (M) and the piano roll still work.';
    return ios ? 'Web MIDI is not available in Safari on iPhone/iPad (Apple does not support it). You can still play MIDI tracks with the on-screen keyboard/pads and edit notes in the piano roll.'
      : 'This browser has no Web MIDI support. Use Chrome, Edge or Firefox on desktop/Android for MIDI keyboards; the on-screen keyboard and piano roll still work.';
  },
};

// Web MIDI output for the step sequencer (external synths, drum machines, hardware). Only note on/off and
// all-notes-off are sent; no SysEx (access is requested with sysex:false). Timestamps are converted from
// AudioContext time to the performance.now() clock Web MIDI uses, including the audio output latency so
// hardware and Auduio's own sound line up.
// Desktop app (Tauri) on macOS/Linux: the webview has no Web MIDI, so output goes through the native audio
// engine instead (engine command midiout.*, channel messages only). Engine ports get ids "engine:<name>".
export const ENGINE_PREFIX = 'engine:';
export const engineMidi = {
  client: null, ports: [],
  attach(client) { this.client = client && client.info && client.info.midiOut ? client : null; return this.refresh(); },
  async refresh() {
    if (!this.client) { this.ports = []; return this.ports; }
    try { const r = await this.client.request('midiout.list', {}, 5000); this.ports = (r.ports || []).slice(0, 64).map((p) => ({ id: ENGINE_PREFIX + p.id, name: String(p.name || 'MIDI output').slice(0, 64), state: 'connected', engine: true })); }
    catch (e) { this.ports = []; }
    return this.ports;
  },
  get available() { return !!this.client; },
  // ---- MIDI input through the engine
  inClient: null, inTimer: null, opened: new Set(),
  attachIn(client) {
    this.inClient = client && client.info && client.info.midiIn ? client : null;
    if (!this.inClient || this._inHooked === client) return;
    this._inHooked = client;
    client.on('midiin', (m) => { if (!Array.isArray(m.d) || typeof m.port !== 'string') return; MIDI.handle(ENGINE_PREFIX + m.port.slice(0, 256), { data: m.d.slice(0, 3), timeStamp: performance.now() }); });
    client.on('exit', () => { this.opened.clear(); });
  },
  get inAvailable() { return !!this.inClient; },
  async openInputs() {
    const c = this.inClient; if (!c) return [];
    try {
      const r = await c.request('midiin.list', {}, 5000);
      const ports = (r.ports || []).slice(0, 16);
      const before = MIDI.engineInputs.map((i) => i.id).join('|');
      MIDI.engineInputs = ports.map((p) => ({ id: ENGINE_PREFIX + p.id, name: String(p.name || 'MIDI input').slice(0, 64), state: 'connected', engine: true }));
      for (const p of ports) if (!this.opened.has(p.id)) { try { await c.request('midiin.open', { port: p.id }, 5000); this.opened.add(p.id); } catch (e) { console.warn('MIDI input', p.id, e.message); } }
      if (!this.inTimer) this.inTimer = setInterval(() => { if (this.inClient) this.openInputs(); }, 5000); // hot-plug
      if (MIDI.onDevices && before !== MIDI.engineInputs.map((i) => i.id).join('|')) MIDI.onDevices(MIDI.inputs());
    } catch (e) { MIDI.engineInputs = []; }
    return MIDI.engineInputs;
  },
};
export function outputs() {
  const web = MIDI.access ? [...MIDI.access.outputs.values()].map((o) => ({ id: o.id, name: (o.name || 'MIDI output').slice(0, 64), state: o.state })) : [];
  const names = new Set(web.map((o) => o.name));
  return web.concat(engineMidi.ports.filter((p) => !names.has(p.name)));
}
export function createMidiOut(getCtx) {
  const used = new Map(); // port id -> Set(channel index)
  const find = (id) => {
    if (id && id.startsWith(ENGINE_PREFIX)) return engineMidi.client && engineMidi.ports.some((p) => p.id === id) ? { id, engine: id.slice(ENGINE_PREFIX.length) } : null;
    const outs = MIDI.access ? [...MIDI.access.outputs.values()] : [];
    const o = (id && outs.find((x) => x.id === id)) || (!id ? outs[0] : null) || null;
    if (o || id) return o;
    const e = engineMidi.client && engineMidi.ports[0]; // "First output" with no Web MIDI
    return e ? { id: e.id, engine: e.id.slice(ENGINE_PREFIX.length) } : null;
  };
  const delay = (ctx, at) => Math.max(0, at - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0));
  const stamp = (ctx, at) => performance.now() + delay(ctx, at) * 1000;
  return {
    sent: 0,
    note(portId, ch, n, v, at, dur) {
      const o = find(portId), ctx = getCtx(); if (!o || !ctx) return false;
      const c = (Math.max(1, Math.min(16, ch | 0)) - 1) & 15, nn = n & 127, vv = Math.max(1, Math.min(127, v | 0));
      try {
        if (o.engine) engineMidi.client.post('midiout.send', { port: o.engine, events: [{ d: [0x90 | c, nn, vv], dt: delay(ctx, at) }, { d: [0x80 | c, nn, 0], dt: delay(ctx, at + Math.max(0.005, dur)) }] });
        else { o.send([0x90 | c, nn, vv], stamp(ctx, at)); o.send([0x80 | c, nn, 0], stamp(ctx, at + Math.max(0.005, dur))); }
        this.sent++;
      } catch (e) { return false; }
      if (!used.has(o.id)) used.set(o.id, new Set()); used.get(o.id).add(c);
      return true;
    },
    allOff() {
      for (const [id, chs] of used) {
        const o = find(id); if (!o) continue;
        if (o.engine) { try { engineMidi.client.post('midiout.allOff', { port: o.engine }); } catch (e) {} continue; }
        for (const c of chs) { try { if (o.clear) o.clear(); o.send([0xb0 | c, 123, 0]); } catch (e) {} }
      }
      used.clear();
    },
  };
}
