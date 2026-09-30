// Plugin host client (VST3 and CLAP). Plugins run in the native audio engine sidecar that ships with
// the Auduio desktop app (Tauri shell + auduio-engine, written in Rust). The web app, Android and iOS cannot host
// plugins: they show the Plugins section as desktop-only. See docs/PLUGIN-HOSTING.md.
//
// Transport: newline-delimited JSON. In the desktop app every line goes through the Tauri command
// `engine_send` and every engine line arrives as the Tauri event `engine://msg` (see apps/src-tauri/src/lib.rs).
const W = typeof window !== 'undefined' ? window : {};
export const IS_TAURI = !!(W.__TAURI_INTERNALS__ || W.__TAURI__);
export const IS_CAPACITOR = !!(W.Capacitor && W.Capacitor.isNativePlatform && W.Capacitor.isNativePlatform());
export function pluginSupport() {
  if (IS_TAURI) return { desktop: true, reason: '' };
  if (IS_CAPACITOR) return { desktop: false, reason: 'Plugins (VST3, CLAP) are available in the Auduio desktop app for Windows, macOS and Linux. Phones and tablets cannot load them.' };
  return { desktop: false, reason: 'Plugins (VST3, CLAP) need the Auduio desktop app for Windows, macOS or Linux. Browsers cannot load them.' };
}

function tauriTransport(onLine, onExit) {
  const T = W.__TAURI__, I = W.__TAURI_INTERNALS__;
  const invoke = (T && T.core && T.core.invoke) || (I && I.invoke && ((c, a) => I.invoke(c, a)));
  if (!invoke) throw new Error('Tauri API unavailable');
  const ready = (async () => {
    if (T && T.event && T.event.listen) {
      await T.event.listen('engine://msg', (e) => onLine(e.payload));
      await T.event.listen('engine://exit', (e) => onExit(e.payload || {}));
    } else throw new Error('Tauri events unavailable (withGlobalTauri must be on)');
  })();
  return { ready, send: (line) => invoke('engine_send', { line }), status: () => invoke('engine_status').catch(() => null) };
}
// Request/response + events over the engine protocol. request() resolves with `result` or rejects with `error`.
export class EngineClient {
  constructor() {
    this.pending = new Map(); this.nextId = 1; this.listeners = new Map(); this.info = null; this.transport = null;
    this.clock = { offset: null, at: 0 };
  }
  async connect() {
    if (this.transport) return this.readyP;
    const onLine = (l) => this.onLine(l), onExit = (x) => this.onExit(x);
    this.transport = tauriTransport(onLine, onExit);
    this.readyP = (async () => {
      await this.transport.ready;
      this.info = await this.request('hello', {}, 20000);
      return this.info;
    })();
    return this.readyP;
  }
  onLine(line) {
    let m; try { m = typeof line === 'string' ? JSON.parse(line) : line; } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.id != null && this.pending.has(m.id)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
      m.ok ? p.res(m.result) : p.rej(new Error(m.error || 'engine error'));
      return;
    }
    if (m.event) this.fire(m.event, m);
  }
  onExit(x) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.rej(new Error('audio engine stopped')); }
    this.pending.clear(); this.clock.offset = null;
    this.fire('exit', x || {});
  }
  on(ev, fn) { if (!this.listeners.has(ev)) this.listeners.set(ev, new Set()); this.listeners.get(ev).add(fn); return () => this.listeners.get(ev).delete(fn); }
  fire(ev, m) { const L = this.listeners.get(ev); if (L) for (const fn of L) { try { fn(m); } catch (e) { console.error(e); } } }
  request(cmd, args = {}, timeoutMs = 15000) {
    if (!this.transport) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`engine timeout: ${cmd}`)); }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      Promise.resolve(this.transport.send(JSON.stringify({ id, cmd, ...args }))).catch((e) => { clearTimeout(timer); this.pending.delete(id); rej(e instanceof Error ? e : new Error(String(e))); });
    });
  }
  // fire-and-forget (notes, live param moves): errors are ignored on purpose, replies are dropped
  post(cmd, args = {}) { if (!this.transport) return; const id = this.nextId++; Promise.resolve(this.transport.send(JSON.stringify({ id, cmd, ...args }))).catch(() => {}); }
  // map AudioContext time -> engine sample clock seconds (both are monotonic audio clocks; re-synced periodically)
  async syncClock(ctx) {
    const t0 = ctx.currentTime, p0 = performance.now();
    const r = await this.request('clock');
    const rtt = (performance.now() - p0) / 1000;
    if (!r.running) { this.clock.offset = null; return null; }
    const mid = t0 + rtt / 2, off = r.seconds - mid;
    this.clock.offset = this.clock.offset == null || Math.abs(off - this.clock.offset) > 0.05 ? off : this.clock.offset * 0.8 + off * 0.2;
    this.clock.at = performance.now();
    return this.clock.offset;
  }
  toEngineTime(ctxTime, ctx) {
    if (this.clock.offset == null) return undefined; // no device clock: play immediately
    const webLat = (ctx && (ctx.outputLatency || ctx.baseLatency)) || 0, natLat = (this.info && this.info.device && this.info.device.outputLatency) || 0;
    return ctxTime + this.clock.offset + Math.max(0, webLat - natLat);
  }
}

// Stands in for a Web Audio instrument on a MIDI track whose instrument is a hosted plugin. The track's
// MIDI effects chain (arp, chord...) feeds it exactly like a built-in synth; notes go to the native engine
// with engine timestamps, so scheduled notes stay sample-accurate there.
export class NativeInstrumentProxy {
  constructor(ctx, client, trackId, label) {
    this.ctx = ctx; this.client = client; this.trackId = trackId; this.type = 'plugin'; this.label = label || 'Plugin';
    this.output = ctx.createGain(); this.output.gain.value = 0; this.values = {}; this.held = new Set(); this.modWheelValue = 0;
  }
  send(events) { this.client.post('midi', { trackId: this.trackId, events }); }
  ev(ctxTime, d) { const t = ctxTime == null ? undefined : this.client.toEngineTime(ctxTime, this.ctx); return t == null ? { d } : { t, d }; }
  playNote(note, vel, t, dur) {
    const v = Math.max(1, Math.min(127, Math.round(vel))), n = Math.max(0, Math.min(127, Math.round(note)));
    const now = this.ctx.currentTime, start = t == null || t < now ? now : t, d = Math.max(0.01, dur || 0.1);
    if (this.client.clock.offset != null) {
      const on = start > now + 0.005 ? this.ev(start, [0x90, n, v]) : { d: [0x90, n, v] };
      this.send([on, this.ev(start + d, [0x80, n, 0])]);
    } else { // engine has no running device clock (e.g. offline): approximate with timers
      setTimeout(() => this.send([{ d: [0x90, n, v] }]), Math.max(0, (start - now) * 1000));
      setTimeout(() => this.send([{ d: [0x80, n, 0] }]), Math.max(10, (start - now + d) * 1000));
    }
  }
  noteOn(note, vel, t) { this.held.add(note); this.send([this.ev(t, [0x90, note & 127, Math.max(1, Math.min(127, vel | 0))])]); }
  noteOff(note, t) { this.held.delete(note); this.send([this.ev(t, [0x80, note & 127, 0])]); }
  allOff() { this.held.clear(); this.client.post('notesOff', { trackId: this.trackId }); }
  modWheel(v) { this.modWheelValue = v; this.send([{ d: [0xB0, 1, Math.round(Math.max(0, Math.min(1, v)) * 127)] }]); }
  pitchBend(v) { const x = Math.round((Math.max(-1, Math.min(1, v)) + 1) * 8191.5); this.send([{ d: [0xE0, x & 127, (x >> 7) & 127] }]); }
  set() {} applyPreset() {} activeCount() { return this.held.size; }
  dispose() { this.allOff(); try { this.output.disconnect(); } catch (e) {} }
}
