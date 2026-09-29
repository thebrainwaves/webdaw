// Audio engine: context, master bus, tracks, transport, session/arrangement playback, recording.
import { createEffect } from './effects.js';
import { createInstrument } from './instruments.js';
import { Adaptive } from './adaptive.js';
import { KeyFollower } from './keyfollow.js';
import { TempoAnalyzer, TempoFollower } from './tempo.js';

const dbToLin = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

export class Engine {
  constructor() {
    this.ctx = null;
    this.tracks = new Map();   // id -> node bundle
    this.buffers = new Map();  // bufferId -> AudioBuffer
    this.inputs = new Map();   // deviceId -> {stream, source, splitter, channels}
    this.meters = new Map();   // id -> {peak:[l,r], rms:[l,r]}
    this.playing = false;
    this.recording = false;
    this.startCtxTime = 0; this.startPos = 0;
    this.project = null;
    this.metronome = false;
    this.latencyOffsetMs = 0;
    this.listeners = {};
    this.workletOK = false;
    this.procLagExtra = 0;
  }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  emit(ev, data) { (this.listeners[ev] || []).forEach((f) => f(data)); }

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    // AudioWorklet is used for recording/metering/gate. Guard with a timeout: some environments
    // (e.g. certain headless/container Chromium builds) never resolve addModule().
    try {
      if (this.ctx.audioWorklet) {
        const load = this.ctx.audioWorklet.addModule(new URL('./worklets.js', import.meta.url)).then(() => true);
        this.workletOK = await Promise.race([load, new Promise((r) => setTimeout(() => r(false), 4000))]);
      }
    } catch (e) { this.workletOK = false; }
    if (!this.workletOK) console.info('AudioWorklet unavailable - using ScriptProcessor/Analyser fallbacks');
    const ctx = this.ctx;
    this.sink = ctx.createGain(); this.sink.gain.value = 0; this.sink.connect(ctx.destination); // pulls silent nodes
    this.master = { input: ctx.createGain(), out: ctx.createGain(), fx: [] };
    this.master.meter = this.makeMeter('master');
    this.master.out.connect(this.master.meter);
    this.master.meter.connect(ctx.destination);
    this.scopeAn = ctx.createAnalyser(); this.scopeAn.fftSize = 2048; this.master.out.connect(this.scopeAn);
    this.metroGain = ctx.createGain(); this.metroGain.gain.value = 0.5; this.metroGain.connect(ctx.destination);
    this._sched = setInterval(() => this.schedulerTick(), 25);
    this._sense = setInterval(() => this.senseTick(), 50);
    this.autoRec = { threshold: -40, preroll: 1, state: 'off' };
    this.keySum = ctx.createGain(); this.keyFollower = new KeyFollower(ctx, this.keySum);
    // tempo detection bus: every track input (playback, pre-FX) + armed inputs; never the metronome
    this.tempoSum = ctx.createGain();
    this.tempo = { listening: false, mode: 'off', lockOnDetect: false, est: null, analyzer: null, follower: new TempoFollower(), goodRuns: 0, clickOffsetMs: 0 };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.resume(); });
  }
  // resume() can stay pending (no output device, iOS interruptions) - never block the UI on it
  async resume() {
    if (!this.ctx || this.ctx.state === 'running') return;
    try { await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 1500))]); } catch (e) {}
  }

  makeMeter(id) {
    if (this.workletOK) {
      const n = new AudioWorkletNode(this.ctx, 'meter-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      n.port.onmessage = (e) => this.meters.set(id, e.data);
      return n;
    }
    // fallback: analyser-based meter
    const g = this.ctx.createGain();
    const an = this.ctx.createAnalyser(); an.fftSize = 512; g.connect(an);
    const arr = new Float32Array(512);
    g._poll = () => { an.getFloatTimeDomainData(arr); let p = 0, s = 0; for (const v of arr) { p = Math.max(p, Math.abs(v)); s += v * v; } const r = Math.sqrt(s / 512); this.meters.set(id, { peak: [p, p], rms: [r, r] }); };
    this._fallbackMeters = this._fallbackMeters || []; this._fallbackMeters.push(g);
    return g;
  }
  pollMeters() { (this._fallbackMeters || []).forEach((g) => g._poll()); }

  // ------------------------------------------------------------------ project / tracks
  loadProject(project) {
    for (const id of [...this.tracks.keys()]) this.removeTrack(id);
    this.project = project;
    this.setMasterFx(project.master.fx);
    this.syncMaster();
    for (const t of project.tracks) this.addTrack(t);
    this.routeAll();
  }
  setMasterFx(fxList) {
    const m = this.master;
    m.fx.forEach((f) => f.dispose());
    m.fx = fxList.map((d) => { const f = createEffect(this.ctx, d.type, d.values, d.enabled !== false, d); d.values = f.values; return f; });
    this.wireChain(m.input, m.fx, m.out);
  }
  syncMaster() { const v = this.project.master.volume; this.master.out.gain.setTargetAtTime(dbToLin(v), this.ctx.currentTime, 0.01); }
  wireChain(input, fx, out) {
    try { input.disconnect(); } catch (e) {}
    fx.forEach((f) => { try { f.output.disconnect(); } catch (e) {} });
    let node = input;
    for (const f of fx) { node.connect(f.input); node = f.output; }
    node.connect(out);
    this.updateBpmFx();
  }
  addTrack(t) {
    const ctx = this.ctx;
    const n = { id: t.id, input: ctx.createGain(), fx: [], post: ctx.createGain(), vol: ctx.createGain(),
      pan: ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(), mute: ctx.createGain(),
      monitor: ctx.createGain(), sources: [], sessionSource: null, sessionSlot: -1, queued: null, rec: null, inputChain: null };
    n.meter = this.makeMeter(t.id);
    n.monitor.gain.value = 0;
    n.monitor.connect(n.input);
    n.adaptive = new Adaptive(ctx);
    n.input.connect(n.adaptive.input);
    this.tracks.set(t.id, n);
    this.setInstrument(t);
    this.syncAdaptive(t);
    n.post.connect(n.vol).connect(n.pan).connect(n.mute).connect(n.meter);
    this.routeTrack(t);
    this.tracks.set(t.id, n);
    this.setTrackFx(t);
    this.syncTrack(t);
    return n;
  }
  removeTrack(id) {
    const n = this.tracks.get(id); if (!n) return;
    this.stopTrackSources(n, 0, true);
    if (n.rec) try { n.rec.node.disconnect(); } catch (e) {}
    this.detachInput(n);
    [n.input, n.post, n.vol, n.pan, n.mute, n.meter, n.monitor].forEach((x) => { try { x.disconnect(); } catch (e) {} });
    n.fx.forEach((f) => f.dispose());
    if (n.inst) n.inst.dispose();
    n.adaptive.dispose();
    this.tracks.delete(id); this.meters.delete(id);
    if (this.project) this.routeAll();
  }
  // ------------------------------------------------------------------ group buses
  // A track with groupId feeds that group track's input instead of the master (nesting allowed,
  // cycles are ignored and fall back to the master).
  groupOf(t) {
    const seen = new Set([t.id]); let g = t.groupId && this.project.tracks.find((x) => x.id === t.groupId);
    for (let x = g; x; x = x.groupId && this.project.tracks.find((y) => y.id === x.groupId)) { if (seen.has(x.id)) return null; seen.add(x.id); if (x.kind !== 'group') return null; }
    return g && g.kind === 'group' ? g : null;
  }
  routeTrack(t) {
    const n = this.tracks.get(t.id); if (!n) return;
    const g = this.groupOf(t); const dest = g && this.tracks.get(g.id) ? this.tracks.get(g.id).input : this.master.input;
    if (n.dest === dest) return;
    try { n.meter.disconnect(); } catch (e) {}
    n.meter.connect(dest); n.dest = dest;
  }
  routeAll() { for (const t of this.project.tracks) this.routeTrack(t); this.syncMutes(); }
  setTrackFx(t) {
    const n = this.tracks.get(t.id); if (!n) return;
    n.fx.forEach((f) => f.dispose());
    n.fx = t.fx.map((d) => { const f = createEffect(this.ctx, d.type, d.values, d.enabled !== false, d); d.values = f.values; return f; });
    this.wireChain(n.adaptive.output, n.fx, n.post);
  }
  // MIDI tracks get an instrument feeding the track input
  setInstrument(t) {
    const n = this.tracks.get(t.id); if (!n) return;
    if (n.inst) { n.inst.dispose(); n.inst = null; }
    if (t.kind !== 'midi') return;
    n.inst = createInstrument(this.ctx, t.inst);
    t.inst = { type: n.inst.type, values: n.inst.values };
    n.inst.output.connect(n.input);
  }
  syncAdaptive(t) {
    const n = this.tracks.get(t.id); if (!n) return;
    const a = t.adaptive || { enabled: false, amount: 60 };
    n.adaptive.amount = a.amount != null ? a.amount : 60;
    n.adaptive.instrument = t.instrument || 'other';
    // feed the key follower with every non-drum track (pre-FX)
    const tonal = t.kind !== 'group' && t.instrument !== 'drums' && !(t.kind === 'midi' && t.inst && t.inst.type === 'drums');
    if (tonal !== !!n.keyTapped) { try { tonal ? n.input.connect(this.keySum) : n.input.disconnect(this.keySum); } catch (e) {} n.keyTapped = tonal; }
    if (n.adaptive.enabled !== !!a.enabled) n.adaptive.setEnabled(!!a.enabled);
    const tt = t.kind !== 'group';
    if (tt !== !!n.tempoTapped) { try { tt ? n.input.connect(this.tempoSum) : n.input.disconnect(this.tempoSum); } catch (e) {} n.tempoTapped = tt; }
  }
  fxInstances(trackId) { return trackId === 'master' ? this.master.fx : (this.tracks.get(trackId) || { fx: [] }).fx; }
  setFxParam(trackId, idx, key, value) { const f = this.fxInstances(trackId)[idx]; if (f) f.set(key, value); }
  setFxEnabled(trackId, idx, on) { const f = this.fxInstances(trackId)[idx]; if (f) f.setEnabled(on); }
  updateBpmFx() {
    if (!this.project) return;
    const all = [...this.master.fx]; this.tracks.forEach((n) => all.push(...n.fx));
    all.forEach((f) => { if (f.setBpm) f.setBpm(this.project.bpm); if (f.setGlobalKey) f.setGlobalKey(this.project.key); });
  }
  syncTrack(t) {
    const n = this.tracks.get(t.id); if (!n) return;
    const now = this.ctx.currentTime;
    n.vol.gain.setTargetAtTime(dbToLin(t.volume), now, 0.01);
    if (n.pan.pan) n.pan.pan.setTargetAtTime(t.pan, now, 0.01);
    this.syncMutes();
    // explicit IN (monitor) always wins; otherwise the selected armed audio track is auto-monitored
    const auto = this.autoMonitor !== false && this.autoMonitorId === t.id && t.kind !== 'midi';
    n.monitor.gain.setTargetAtTime(t.arm && (t.monitor || auto) ? 1 : 0, now, 0.01);
  }
  setAutoMonitor(trackId, on = this.autoMonitor !== false) {
    const prev = this.autoMonitorId; this.autoMonitorId = trackId; this.autoMonitor = on;
    for (const id of new Set([prev, trackId])) { const t = id && this.project && this.project.tracks.find((x) => x.id === id); if (t) this.syncTrack(t); }
  }
  isMonitoring(t) { const n = this.tracks.get(t.id); return !!(n && n.monitor.gain.value > 0.5) || !!(t.arm && (t.monitor || (this.autoMonitor !== false && this.autoMonitorId === t.id && t.kind !== 'midi'))); }
  // ---- audition: hear a clip / slot immediately through its track's chain (no quantize, independent of the transport)
  auditionClip(t, c, { from = null, loop = null, key = '' } = {}) {
    this.stopAudition();
    const n = this.tracks.get(t.id); const buf = c && c.bufferId && this.buffers.get(c.bufferId); if (!n || !buf) return null;
    const ctx = this.ctx, rate = Math.pow(2, (c.transpose || 0) / 12), isSlot = c.start == null;
    const a = Math.max(0, isSlot ? (c.loopStart || 0) : (c.offset || 0));
    const b = Math.min(buf.duration, a + (isSlot ? (c.loopLength || buf.duration - a) : c.duration * rate));
    if (b - a < 0.005) return null;
    const off = from != null ? Math.max(a, Math.min(b - 0.005, from)) : a;
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    const g = ctx.createGain(); const lvl = Math.pow(10, (c.gain || 0) / 20); const now = ctx.currentTime;
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(lvl, now + 0.004);
    src.connect(g); g.connect(n.input);
    const lp = loop == null ? isSlot : loop;
    if (lp) { src.loop = true; src.loopStart = a; src.loopEnd = b; src.start(now, off); } else src.start(now, off, b - off);
    const A = this.audition = { key, t, c, src, g, startCtx: now, off, a, b, rate, loop: lp };
    src.onended = () => { try { g.disconnect(); } catch (e) {} if (this.audition === A) { this.audition = null; this.emit('audition', null); } };
    this.emit('audition', A); return A;
  }
  auditionPos() {
    const A = this.audition; if (!A) return null; let p = A.off + Math.max(0, this.ctx.currentTime - A.startCtx) * A.rate;
    if (A.loop && p > A.b) p = A.a + ((p - A.a) % (A.b - A.a)); return Math.min(p, A.b);
  }
  stopAudition() {
    const A = this.audition; if (!A) return; this.audition = null; const now = this.ctx.currentTime;
    try { A.g.gain.cancelScheduledValues(now); A.g.gain.setValueAtTime(A.g.gain.value, now); A.g.gain.linearRampToValueAtTime(0, now + 0.012); A.src.stop(now + 0.015); } catch (e) {}
    this.emit('audition', null);
  }
  syncMutes() {
    const tr = this.project.tracks, anySolo = tr.some((t) => t.solo);
    const ancestors = (t) => { const out = []; for (let g = this.groupOf(t); g && out.length < 16; g = this.groupOf(g)) out.push(g); return out; };
    const soloOK = (t) => t.solo || ancestors(t).some((g) => g.solo) || (t.kind === 'group' && tr.some((x) => x.solo && ancestors(x).includes(t)));
    for (const t of tr) {
      const n = this.tracks.get(t.id); if (!n) continue;
      const audible = !t.mute && (!anySolo || soloOK(t));
      n.mute.gain.setTargetAtTime(audible ? 1 : 0, this.ctx.currentTime, 0.01);
    }
  }

  // ------------------------------------------------------------------ inputs
  async listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { inputs: [], outputs: [] };
    const d = await navigator.mediaDevices.enumerateDevices();
    return { inputs: d.filter((x) => x.kind === 'audioinput'), outputs: d.filter((x) => x.kind === 'audiooutput') };
  }
  async requestMicPermission() {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  }
  async getInput(deviceId) {
    const key = deviceId || 'default';
    if (this.inputs.has(key)) return this.inputs.get(key);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Microphone input needs HTTPS (or localhost) and a supporting browser.');
    // iOS 17+/Safari: ask for a play-and-record audio session so output keeps working while the mic is open
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) {}
    const constraints = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } } };
    if (deviceId && deviceId !== 'default') constraints.audio.deviceId = { exact: deviceId };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch (e) {
      // some devices/browsers (notably iOS) reject channelCount; retry with a plain request
      if (e.name === 'OverconstrainedError' || e.name === 'TypeError') {
        const c2 = { audio: deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true };
        stream = await navigator.mediaDevices.getUserMedia(c2);
      } else throw e;
    }
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    const source = this.ctx.createMediaStreamSource(stream);
    // channel count actually delivered (iOS Safari typically delivers 1-2 channels)
    const channels = Math.max(1, Math.min(32, settings.channelCount || source.channelCount || 1));
    const splitter = this.ctx.createChannelSplitter(Math.max(2, channels));
    source.connect(splitter);
    const inp = { stream, source, splitter, channels, latency: settings.latency || 0, label: track.label };
    this.inputs.set(key, inp);
    this.emit('inputs');
    return inp;
  }
  detachInput(n) {
    if (n.inputChain) { try { n.inputChain.gain.disconnect(); n.inputChain.from.disconnect(n.inputChain.gain); } catch (e) {} n.inputChain = null; }
    n.inputLevel = -100;
  }
  // Input sensing (signal indicator), auto-record trigger, adaptive processing steps.
  senseTick() {
    if (!this.ctx || !this.project) return;
    let maxDb = -100;
    this.tracks.forEach((n) => {
      const ic = n.inputChain; if (!ic) return;
      ic.analyser.getFloatTimeDomainData(ic.buf);
      let pk = 0; for (let i = 0; i < ic.buf.length; i++) { const v = Math.abs(ic.buf[i]); if (v > pk) pk = v; }
      const db = 20 * Math.log10(pk + 1e-9);
      n.inputLevel = Math.max(db, (n.inputLevel || -100) - 3); // peak hold with decay
      if (db > maxDb) maxDb = db;
    });
    if (this.autoRec.state === 'waiting') {
      this.trimWaiting();
      if (maxDb >= this.autoRec.threshold) this.triggerAutoRecord();
    }
    this._adaptTick = ((this._adaptTick || 0) + 1) % 5;
    if (this._adaptTick === 2 && this.project.keyFollow) {
      const k = this.keyFollower.step();
      if (k) { this.project.key = { root: k.root, scale: k.scale }; this.updateBpmFx(); this.emit('key', k); }
    }
    this._tempoTick = ((this._tempoTick || 0) + 1) % 10;
    if (this._tempoTick === 0 && this.tempo.listening) this.tempoStep();
    if (this._adaptTick === 0) this.tracks.forEach((n) => { if (n.adaptive.enabled && (this.playing || n.inputChain)) n.adaptive.step(); });
  }
  // ------------------------------------------------------------------ auto-record (sound-activated with pre-roll)
  async armAutoRecord(opts = {}) {
    Object.assign(this.autoRec, opts);
    const armed = this.project.tracks.filter((t) => t.arm && t.kind !== 'midi');
    if (!armed.length) throw new Error('Arm at least one audio track to use auto-record.');
    for (const t of armed) { const n = this.tracks.get(t.id); if (!n.inputChain) await this.attachInput(t); }
    const now = this.ctx.currentTime;
    this.recTakes = armed.map((t) => { const n = this.tracks.get(t.id); const rec = this.makeRecorder(n); rec.node.port.postMessage({ type: 'start', time: now }); rec.firstTime = now; return { t, n, rec, auto: true }; });
    this.autoRec.state = 'waiting';
    this.emit('transport');
  }
  trimWaiting() {
    const sr = this.ctx.sampleRate, keep = (this.autoRec.preroll + 0.5) * sr;
    for (const k of this.recTakes || []) {
      let total = k.rec.chunks.reduce((s, c) => s + c[0].length, 0);
      while (k.rec.chunks.length > 1 && total - k.rec.chunks[0][0].length > keep) { const n = k.rec.chunks.shift()[0].length; total -= n; k.rec.firstTime += n / sr; }
    }
  }
  triggerAutoRecord() {
    this.autoRec.state = 'recording';
    const trig = this.ctx.currentTime;
    if (!this.playing) this.play();
    for (const k of this.recTakes) { k.trigTime = trig; }
    this.recording = true;
    this.emit('autorecord', { time: trig }); this.emit('transport');
  }
  cancelAutoRecord() {
    for (const k of this.recTakes || []) { k.rec.node.port.postMessage({ type: 'stop', time: this.ctx.currentTime }); try { k.rec.node.disconnect(); } catch (e) {} }
    this.recTakes = null; this.autoRec.state = 'off'; this.emit('transport');
  }
  // Connect the chosen device/channel to a track (used for arming/monitoring/recording).
  async attachInput(t) {
    const n = this.tracks.get(t.id); if (!n) return null;
    this.detachInput(n);
    const inp = await this.getInput(t.inputDeviceId);
    const gain = this.ctx.createGain();
    let warning = null, from, stereo = false;
    if (t.inputChannel === 'stereo') {
      from = inp.source; stereo = inp.channels >= 2;
      if (!stereo) warning = 'Device delivers mono only; recording mono.';
      inp.source.connect(gain);
    } else {
      let ch = parseInt(t.inputChannel, 10) || 0;
      if (ch >= inp.channels) { warning = `Input channel ${ch + 1} not available (device gives ${inp.channels}); using channel 1.`; ch = 0; }
      from = inp.splitter;
      gain.channelCount = 1; gain.channelCountMode = 'explicit';
      inp.splitter.connect(gain, ch, 0);
    }
    gain.connect(n.monitor); gain.connect(this.tempoSum);
    const analyser = this.ctx.createAnalyser(); analyser.fftSize = 1024; gain.connect(analyser);
    n.inputChain = { gain, from, stereo, latency: inp.latency, warning, channels: inp.channels, analyser, buf: new Float32Array(1024) };
    return n.inputChain;
  }
  releaseUnusedInputs() {
    const used = new Set(this.project.tracks.filter((t) => t.arm && t.kind !== 'midi').map((t) => t.inputDeviceId || 'default'));
    for (const [k, inp] of this.inputs) {
      if (!used.has(k)) { inp.stream.getTracks().forEach((x) => x.stop()); try { inp.source.disconnect(); } catch (e) {} this.inputs.delete(k); }
    }
  }

  // ------------------------------------------------------------------ transport
  get barDur() { return (60 / this.project.bpm) * (this.project.beatsPerBar || 4); }
  get beatDur() { return 60 / this.project.bpm; }
  position() { return this.playing ? this.startPos + (this.ctx.currentTime - this.startCtxTime) : this.startPos; }
  posToTime(pos) { return this.startCtxTime + (pos - this.startPos); }
  // grid offset (s): bar lines sit at gridOffset + k*barDur. Set by tempo detection/follow so the
  // metronome lands on the band's downbeat; 0 for normal projects.
  get gridOffset() { return (this.project && this.project.gridOffset) || 0; }
  barFloor(pos) { const o = this.gridOffset; return o + Math.floor((pos - o) / this.barDur + 1e-6) * this.barDur; }
  nextBarTime() {
    const pos = this.position(), bd = this.barDur, o = this.gridOffset;
    let nb = o + Math.ceil((pos - o + 0.02) / bd) * bd;
    return this.posToTime(nb);
  }
  play(fromPos, atCtxTime) {
    this.stopAudition();
    if (this.playing) return;
    this.resume();
    if (fromPos != null) this.startPos = fromPos;
    this.startCtxTime = Math.max(this.ctx.currentTime + 0.06, atCtxTime || 0);
    this.playing = true;
    this.nextClick = null;
    this.midiSchedEnd = this.startCtxTime;
    for (const t of this.project.tracks) this.scheduleArrangement(t);
    this.emit('transport');
  }
  stop() {
    if (this.recording) this.stopRecording();
    const pos = this.position();
    this.playing = false;
    this.tracks.forEach((n) => { this.stopTrackSources(n, 0, true); n.queued = null; if (n.inst) n.inst.allOff(); });
    if (this.autoRec.state === 'waiting') this.cancelAutoRecord();
    // pressing stop while stopped returns to start (like most DAWs)
    this.startPos = pos === this.startPos ? 0 : pos;
    this.emit('transport'); this.emit('session');
  }
  setPosition(pos) {
    const was = this.playing;
    if (was) { this.playing = false; this.tracks.forEach((n) => { this.stopTrackSources(n, 0, false); if (n.inst && !n.sessionMidi) n.inst.allOff(); }); }
    this.startPos = Math.max(0, pos);
    if (was) this.play();
    this.emit('transport');
  }
  stopTrackSources(n, when = 0, includeSession = true) {
    n.sources.forEach((s) => { try { s.stop(when); } catch (e) {} });
    n.sources = [];
    if (includeSession && n.sessionSource) { try { n.sessionSource.stop(when); } catch (e) {} n.sessionSource = null; n.sessionSlot = -1; }
    if (includeSession && n.sessionMidi) { n.sessionMidi = null; n.sessionSlot = -1; }
  }
  // Re-schedule one track's arrangement audio from the current playhead (used for live clip edits,
  // so other tracks keep playing untouched).
  rescheduleTrack(t) {
    const n = this.tracks.get(t.id); if (!n || !this.playing || n.sessionSource || n.sessionMidi) return;
    const now = this.ctx.currentTime + 0.03;
    n.sources.forEach((s) => { try { s.stop(now); } catch (e) {} }); n.sources = [];
    this.scheduleArrangement(t, this.startPos + (now - this.startCtxTime));
  }
  scheduleArrangement(t, fromPos) {
    const n = this.tracks.get(t.id); if (!n || n.sessionSource || n.sessionMidi) return;
    const pos = fromPos != null ? fromPos : this.startPos;
    for (const c of t.arrangement) {
      if (c.type === 'midi') continue; // MIDI clips are scheduled by the lookahead scheduler
      const buf = this.buffers.get(c.bufferId); if (!buf) continue;
      const end = c.start + c.duration;
      if (end <= pos) continue;
      const src = this.ctx.createBufferSource(); src.buffer = buf;
      // transpose = repitch (tape-style: pitch and speed change together); timeline length stays c.duration
      const rate = Math.pow(2, (c.transpose || 0) / 12); src.playbackRate.value = rate;
      const g = this.ctx.createGain(); g.gain.value = dbToLin(c.gain || 0);
      src.connect(g).connect(n.input);
      const when = Math.max(this.ctx.currentTime, this.posToTime(Math.max(pos, c.start)));
      const offs = c.offset + Math.max(0, pos - c.start) * rate;
      const dur = (c.duration - Math.max(0, pos - c.start)) * rate;
      try { src.start(when, offs, dur); } catch (e) { continue; }
      src._clipId = c.id; src._gain = g;
      n.sources.push(src);
    }
  }
  schedulerTick() {
    if (!this.ctx || !this.playing) return;
    this.pollMeters();
    this.scheduleMidi();
    if (!this.metronome && !this.countIn) return;
    const bd = this.beatDur, ahead = this.ctx.currentTime + 0.12, o = this.gridOffset, bpb = this.project.beatsPerBar || 4;
    // click k sits at position o + k*bd; the acoustic click is moved earlier by the output latency
    // (+ user click offset) so it is heard on the beat. After a tempo/offset change the index is
    // recomputed without re-clicking a beat that was already scheduled.
    const lat = (this.tempo.mode !== 'off' || this.project.gridOffset ? (this.ctx.outputLatency || this.ctx.baseLatency || 0) : 0) - this.tempo.clickOffsetMs / 1000;
    if (this.nextClick == null) {
      const from = Math.max(this.position(), this.lastClickPos != null && this.lastClickCtx > this.ctx.currentTime - 1 ? this.lastClickPos + bd * 0.5 : -Infinity);
      this.nextClick = Math.ceil((from - o - 0.001) / bd);
    }
    while (this.posToTime(o + this.nextClick * bd) - lat < ahead) {
      const pos = o + this.nextClick * bd, t = this.posToTime(pos) - lat;
      if (t >= this.ctx.currentTime - 0.01) { this.click(t, ((this.nextClick % bpb) + bpb) % bpb === 0); this.lastClickPos = pos; this.lastClickCtx = t; this.emit('click', { t, pos, k: this.nextClick }); }
      this.nextClick++;
    }
  }
  // live clip edits from the clip detail view: gain in place; transpose/loop via a short reschedule
  updateClipLive(t, c, what) {
    const n = this.tracks.get(t.id); if (!n) return;
    const now = this.ctx.currentTime;
    if (what === 'gain') {
      n.sources.forEach((s) => { if (s._clipId === c.id && s._gain) s._gain.gain.setTargetAtTime(dbToLin(c.gain || 0), now, 0.01); });
      if (n.sessionSource && n.sessionSource._clip === c && n.sessionSource._gain) n.sessionSource._gain.gain.setTargetAtTime(dbToLin(c.gain || 0), now, 0.01);
      return;
    }
    if (n.sessionSource && n.sessionSource._clip === c) {
      const src = n.sessionSource, buf = src.buffer, ls = Math.max(0, Math.min(buf.duration - 0.01, c.loopStart || 0));
      src.playbackRate.setValueAtTime(Math.pow(2, (c.transpose || 0) / 12), now);
      src.loopStart = ls; src.loopEnd = ls + Math.min(c.loopLength || buf.duration, buf.duration - ls);
      return;
    }
    this.rescheduleTrack(t);
  }
  // ------------------------------------------------------------------ tempo (auto-timing)
  // change tempo; keepPhase re-anchors the grid so the beat position at the playhead stays continuous
  setTempo(bpm, { keepPhase = true } = {}) {
    bpm = Math.max(40, Math.min(300, Math.round(bpm * 100) / 100));
    const old = this.project.bpm; if (Math.abs(bpm - old) < 1e-6) return;
    if (this.playing && keepPhase) { const p = this.position(), o = this.gridOffset; this.project.gridOffset = p - (p - o) * old / bpm; }
    this.project.bpm = bpm; this.updateBpmFx(); this.nextClick = null; this.emit('tempo', { bpm });
  }
  startTempoListen() {
    const T = this.tempo; if (T.listening) return;
    T.analyzer = new TempoAnalyzer(this.ctx.sampleRate, { windowSec: 12 });
    const size = 2048; const sp = this.ctx.createScriptProcessor(size, 1, 1);
    // ScriptProcessor input lags its playbackTime by ~two buffers in Chromium (measured with scheduled clicks in tests/e2e-tempo.mjs)
    sp.onaudioprocess = (e) => { const x = e.inputBuffer.getChannelData(0); T.analyzer.push(new Float32Array(x), e.playbackTime - 2 * size / this.ctx.sampleRate - this.procLagExtra); };
    this.tempoSum.connect(sp); sp.connect(this.sink); T.sp = sp; T.listening = true; T.est = null; T.goodRuns = 0; T.startedAt = this.ctx.currentTime;
    this.emit('tempostate');
  }
  stopTempoListen() {
    const T = this.tempo; if (!T.listening) return;
    try { this.tempoSum.disconnect(T.sp); T.sp.disconnect(); } catch (e) {} T.sp.onaudioprocess = null; T.sp = null; T.listening = false; T.mode = 'off';
    if (T.detect) { const d = T.detect; T.detect = null; d.resolve(null); }
    this.emit('tempostate');
  }
  inputLatencyForTempo() {
    // detections from live inputs arrive late by the input latency; playback tracks do not
    if (this.playing && this.project.tracks.some((t) => t.arrangement.length || t.slots.some(Boolean))) return 0;
    let l = 0; this.tracks.forEach((n) => { if (n.inputChain) l = Math.max(l, n.inputChain.latency || 0); }); return l;
  }
  tempoStep() {
    const T = this.tempo, now = this.ctx.currentTime; if (!T.analyzer) return;
    const heard = T.analyzer.seconds();
    const est = T.analyzer.analyse({ windowSec: T.detect ? Math.min(32, heard) : 10, beatsPerBar: this.project.beatsPerBar || 4, prefer: T.mode === 'follow' && T.follower.bpm ? T.follower.bpm : null });
    if (est) { const lat = this.inputLatencyForTempo(); est.beatTimes = est.beatTimes.map((t) => t - lat); est.downbeatTime -= lat; est.lastBeatTime -= lat; }
    T.est = est; this.emit('tempoest', est);
    if (T.detect) {
      const d = T.detect, bars = d.bars, bpb = this.project.beatsPerBar || 4;
      const need = est && est.confidence > 0.3 ? Math.max(4, bars * bpb * 60 / est.bpm) : 1e9;
      d.progress = Math.min(1, heard / Math.min(need, d.maxSec)); this.emit('tempodetect', d);
      if (heard >= Math.min(need, d.maxSec) || heard >= d.maxSec) { T.detect = null; this.applyDetected(est, d); d.resolve(est); if (T.mode === 'off') this.stopTempoListen(); }
      return;
    }
    if (T.mode === 'follow') {
      if (T.follower.bpm == null) T.follower.reset(this.project.bpm);
      const u = T.follower.update(est, now);
      if (u.changed) this.setTempo(u.bpm, { keepPhase: true });
      if (est && est.confidence >= 0.5 && this.playing) {
        // phase from a short recent window (a long window lags while the tempo drifts)
        const pe = T.analyzer.analyse({ windowSec: 5, beatsPerBar: this.project.beatsPerBar || 4, prefer: this.project.bpm });
        if (pe && pe.confidence >= 0.4) { const lat = this.inputLatencyForTempo(); pe.lastBeatTime -= lat; this.nudgePhase(pe); }
      }
      if (T.lockOnDetect) {
        T.goodRuns = est && est.confidence >= 0.6 && Math.abs(est.bpm - this.project.bpm) < 1 ? T.goodRuns + 1 : 0;
        if (T.goodRuns >= 4) { T.mode = 'off'; this.emit('tempolock', { bpm: this.project.bpm }); this.stopTempoListen(); }
      }
    }
  }
  // move the grid toward the detected beat phase (max 20 ms per 0.5 s step: smooth, no jumps)
  nudgePhase(est) {
    const bd = this.beatDur, pos = this.startPos + (est.lastBeatTime - this.startCtxTime), o = this.gridOffset;
    let err = (pos - o) % bd; if (err < 0) err += bd; if (err > bd / 2) err -= bd;
    const step = Math.max(-0.02, Math.min(0.02, err * 0.5)); if (Math.abs(step) < 0.0005) return;
    this.project.gridOffset = o + step; this.nextClick = null;
  }
  // put the detected tempo + downbeat into the project; if stopped, optionally start on the next downbeat
  applyDetected(est, { startOnDownbeat = true } = {}) {
    if (!est || est.confidence < 0.3) return false;
    const bpb = this.project.beatsPerBar || 4;
    this.project.bpm = Math.round(est.bpm * 100) / 100; this.updateBpmFx(); this.emit('tempo', { bpm: this.project.bpm });
    const barDur = this.barDur, now = this.ctx.currentTime, outLat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    if (this.playing) {
      const dbPos = this.startPos + (est.downbeatTime - this.startCtxTime);
      this.project.gridOffset = ((dbPos % barDur) + barDur) % barDur;
    } else if (startOnDownbeat) {
      // predict the next downbeat; position 0 = that downbeat; the metronome click is advanced by the output latency
      let T = est.downbeatTime; const lead = 0.25 + outLat; if (T < now + lead) T += Math.ceil((now + lead - T) / barDur) * barDur;
      this.project.gridOffset = 0; this.startPos = 0; this.metronome = true; this.play(0, T);
    }
    this.nextClick = null; void bpb;
    return true;
  }
  detectTempo({ bars = 8, maxSec = 30, startOnDownbeat = true } = {}) {
    this.startTempoListen();
    if (this.tempo.detect) this.tempo.detect.resolve(null);
    return new Promise((resolve) => { this.tempo.detect = { bars, maxSec, startOnDownbeat, resolve, progress: 0 }; });
  }
  setTempoFollow(on, { lock = false } = {}) {
    const T = this.tempo; T.lockOnDetect = lock;
    if (on) { this.startTempoListen(); T.mode = 'follow'; T.follower.reset(this.project.bpm); T.goodRuns = 0; }
    else { T.mode = 'off'; if (!T.detect && !T.keepListening) this.stopTempoListen(); }
    this.emit('tempostate');
  }
  click(t, accent) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.35, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g).connect(this.metroGain); o.start(t); o.stop(t + 0.07);
  }

  // ------------------------------------------------------------------ session clips
  launchSlot(t, slot) {
    const n = this.tracks.get(t.id); const clip = t.slots[slot];
    if (!n || !clip) return;
    if (clip.type === 'midi') {
      if (!this.playing) this.play(this.barFloor(this.startPos));
      const when = this.ctx.currentTime < this.startCtxTime ? this.startCtxTime : this.nextBarTime();
      return this.startSessionMidi(t, n, slot, clip, when);
    }
    const buf = this.buffers.get(clip.bufferId); if (!buf) return;
    if (!this.playing) this.play();
    const when = this.ctx.currentTime < this.startCtxTime ? this.startCtxTime : this.nextBarTime();
    this.startSessionSource(t, n, slot, buf, clip, when, 0);
  }
  startSessionSource(t, n, slot, buf, clip, when, offset) {
    // stop arrangement + current session clip at the launch point
    n.sources.forEach((s) => { try { s.stop(when); } catch (e) {} }); n.sources = [];
    if (n.sessionSource) { try { n.sessionSource.stop(when); } catch (e) {} }
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const ls = Math.max(0, Math.min(buf.duration - 0.01, clip.loopStart || 0));
    const loopLen = Math.min(clip.loopLength || buf.duration, buf.duration - ls);
    const rate = Math.pow(2, (clip.transpose || 0) / 12); src.playbackRate.value = rate;
    src.loopStart = ls; src.loopEnd = ls + loopLen;
    const g = this.ctx.createGain(); g.gain.value = dbToLin(clip.gain || 0);
    src.connect(g).connect(n.input); src._gain = g; src._clip = clip;
    src.start(when, ls + ((offset * rate) % loopLen));
    n.sessionSource = src; n.sessionSlot = slot; n.queued = { slot, when };
    n.sessionStart = when - offset;
    setTimeout(() => { if (n.queued && n.queued.when === when) n.queued = null; this.emit('session'); }, Math.max(0, (when - this.ctx.currentTime) * 1000) + 20);
    this.emit('session');
  }
  startSessionMidi(t, n, slot, clip, when) {
    n.sources.forEach((s) => { try { s.stop(when); } catch (e) {} }); n.sources = [];
    if (n.sessionSource) { try { n.sessionSource.stop(when); } catch (e) {} n.sessionSource = null; }
    if (n.sessionMidi) n.sessionMidi.stopAt = when;
    const loopLen = Math.max(0.25, clip.lengthBeats || 4) * this.beatDur;
    const next = { clip, start: when, loopLen, stopAt: Infinity, slot };
    // keep the old clip running until the switch point, then swap
    const prev = n.sessionMidi; n.sessionMidiPrev = prev; n.sessionMidi = next;
    n.sessionSlot = slot; n.queued = { slot, when }; n.sessionStart = when;
    setTimeout(() => { if (n.queued && n.queued.when === when) n.queued = null; n.sessionMidiPrev = null; this.emit('session'); }, Math.max(0, (when - this.ctx.currentTime) * 1000) + 20);
    this.emit('session');
  }
  // Lookahead MIDI scheduler: session MIDI loops + arrangement MIDI clips -> instrument notes
  scheduleMidi() {
    const now = this.ctx.currentTime, from = Math.max(this.midiSchedEnd || now, now), to = now + 0.15;
    if (to <= from) return;
    const bd = this.beatDur;
    for (const t of this.project.tracks) {
      const n = this.tracks.get(t.id); if (!n || !n.inst) continue;
      const loops = [n.sessionMidiPrev, n.sessionMidi].filter(Boolean);
      if (loops.length) {
        for (const L of loops) {
          const k0 = Math.floor((from - L.start) / L.loopLen), k1 = Math.floor((to - L.start) / L.loopLen);
          for (let k = Math.max(0, k0); k <= k1; k++) for (const nt of L.clip.notes) {
            const tn = L.start + k * L.loopLen + nt.t * bd;
            if (tn >= from && tn < to && tn < L.stopAt && nt.t * bd < L.loopLen) n.inst.playNote(nt.n, nt.v, tn, Math.min(nt.d * bd, L.stopAt - tn));
          }
        }
        continue;
      }
      if (n.sessionSource) continue;
      const p0 = this.startPos + (from - this.startCtxTime), p1 = this.startPos + (to - this.startCtxTime);
      for (const c of t.arrangement) {
        if (c.type !== 'midi' || c.start > p1 || c.start + c.duration < p0) continue;
        for (const nt of c.notes) {
          const off = nt.t * bd - (c.offset || 0); if (off < 0 || off >= c.duration) continue;
          const pn = c.start + off;
          if (pn >= p0 && pn < p1) n.inst.playNote(nt.n, nt.v, this.posToTime(pn), Math.min(nt.d * bd, c.duration - off));
        }
      }
    }
    this.midiSchedEnd = to;
  }
  stopTrackClip(t) {
    const n = this.tracks.get(t.id); if (!n) return;
    if (n.sessionMidi) {
      const when = this.playing ? this.nextBarTime() : this.ctx.currentTime;
      n.sessionMidi.stopAt = when; const cur = n.sessionMidi;
      setTimeout(() => { if (n.sessionMidi === cur) { n.sessionMidi = null; n.sessionSlot = -1; this.emit('session'); } }, Math.max(0, (when - this.ctx.currentTime) * 1000));
      return;
    }
    if (!n.sessionSource) return;
    const when = this.playing ? this.nextBarTime() : 0;
    try { n.sessionSource.stop(when); } catch (e) {}
    n.sessionSource = null; n.sessionSlot = -1;
    this.emit('session');
  }
  launchScene(scene) {
    for (const t of this.project.tracks) {
      if (t.slots[scene]) this.launchSlot(t, scene); else this.stopTrackClip(t);
    }
  }
  stopAllClips() { this.project.tracks.forEach((t) => this.stopTrackClip(t)); }

  // ------------------------------------------------------------------ recording
  inputLatency(n) {
    const out = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const inp = (n.inputChain && n.inputChain.latency) || 0;
    return Math.max(0, out + inp + this.latencyOffsetMs / 1000);
  }
  makeRecorder(n) {
    if (!this.workletOK) return this.makeFallbackRecorder(n);
    const channels = n.inputChain.stereo ? 2 : 1;
    const node = new AudioWorkletNode(this.ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { channels } });
    n.inputChain.gain.connect(node);
    node.connect(this.sink);
    const rec = { node, channels, chunks: [], done: null };
    rec.done = new Promise((resolve) => {
      node.port.onmessage = (e) => {
        if (e.data.type === 'data') rec.chunks.push(e.data.channels);
        else if (e.data.type === 'done') resolve();
      };
    });
    return rec;
  }
  // ScriptProcessorNode fallback recorder with the same start/stop-at-time interface.
  makeFallbackRecorder(n) {
    const ctx = this.ctx, channels = n.inputChain.stereo ? 2 : 1, size = 2048;
    const node = ctx.createScriptProcessor(size, channels, 1);
    const rec = { node, channels, chunks: [], done: null };
    let start = Infinity, stop = Infinity, active = false, resolveDone;
    rec.done = new Promise((r) => { resolveDone = r; });
    node.port = { postMessage: (m) => { if (m.type === 'start') { start = m.time; stop = Infinity; active = true; } else if (m.type === 'stop') stop = m.time; } };
    node.onaudioprocess = (e) => {
      if (!active) return;
      const len = e.inputBuffer.length, sr = ctx.sampleRate;
      const t0 = e.playbackTime - len / sr; // input block was captured ~one block before its playback time
      const i0 = Math.max(0, Math.round((start - t0) * sr)), i1 = Math.min(len, Math.round((stop - t0) * sr));
      if (i1 > i0 && !rec.chunks.length && t0 > start + 1 / sr) {
        // first block arrived after the requested start: pad with silence to keep timing/length exact
        const pad = Math.round((t0 - start) * sr); const z = []; for (let c = 0; c < channels; c++) z.push(new Float32Array(pad));
        rec.chunks.push(z);
      }
      if (i1 > i0) {
        const out = [];
        for (let c = 0; c < channels; c++) out.push(e.inputBuffer.getChannelData(Math.min(c, e.inputBuffer.numberOfChannels - 1)).slice(i0, i1));
        rec.chunks.push(out);
      }
      if (stop <= t0 + len / sr) { active = false; resolveDone(); }
    };
    n.inputChain.gain.connect(node);
    node.connect(this.sink);
    return rec;
  }
  finishRecorder(rec) {
    const len = rec.chunks.reduce((s, c) => s + c[0].length, 0);
    try { rec.node.disconnect(); } catch (e) {}
    if (!len) return null;
    const buf = this.ctx.createBuffer(rec.channels, len, this.ctx.sampleRate);
    for (let c = 0; c < rec.channels; c++) {
      const d = buf.getChannelData(c); let off = 0;
      for (const ch of rec.chunks) { d.set(ch[c], off); off += ch[c].length; }
    }
    return buf;
  }
  // Arrangement ("live") recording of all armed tracks from the current playhead.
  async startRecording() {
    const armedAll = this.project.tracks.filter((t) => t.arm);
    if (!armedAll.length) throw new Error('Arm at least one track (its round arm button) to record.');
    const armed = armedAll.filter((t) => t.kind !== 'midi');
    for (const t of armed) { const n = this.tracks.get(t.id); if (!n.inputChain) await this.attachInput(t); }
    if (!this.playing) this.play();
    const when = Math.max(this.ctx.currentTime, this.startCtxTime);
    const startPos = this.startPos + (when - this.startCtxTime);
    this.recTakes = armed.map((t) => {
      const n = this.tracks.get(t.id);
      const rec = this.makeRecorder(n);
      rec.node.port.postMessage({ type: 'start', time: when });
      return { t, n, rec, startPos };
    });
    this.recording = true; this.recStartPos = startPos;
    this.emit('recstart', { startPos, when });
    this.emit('transport');
  }
  async stopRecording() {
    if (this.autoRec.state === 'waiting') { this.cancelAutoRecord(); return []; }
    if (!this.recording) return [];
    this.recording = false; this.autoRec.state = 'off';
    const when = this.ctx.currentTime;
    this.emit('recstop', { stopPos: this.startPos + (when - this.startCtxTime) });
    const takes = this.recTakes || []; this.recTakes = null;
    takes.forEach((k) => k.rec.node.port.postMessage({ type: 'stop', time: when }));
    this.emit('transport');
    const results = [];
    for (const k of takes) {
      await Promise.race([k.rec.done, new Promise((r) => setTimeout(r, 1500))]);
      const buf = this.finishRecorder(k.rec);
      if (!buf) continue;
      if (k.auto) {
        // keep audio from (trigger - preroll); place so its first sample lines up with the transport
        const keepFrom = Math.max(k.rec.firstTime, k.trigTime - this.autoRec.preroll);
        let startPos = this.startPos + (keepFrom - this.startCtxTime);
        let off = keepFrom - k.rec.firstTime;
        if (startPos < 0) { off -= startPos; startPos = 0; }
        off += this.inputLatency(k.n);
        if (off < buf.duration) results.push({ track: k.t, buffer: buf, startPos, offset: off, duration: buf.duration - off, warning: k.n.inputChain && k.n.inputChain.warning, auto: true });
        continue;
      }
      const lat = Math.min(this.inputLatency(k.n), buf.duration);
      results.push({ track: k.t, buffer: buf, startPos: k.startPos, offset: lat, duration: buf.duration - lat, warning: k.n.inputChain && k.n.inputChain.warning });
    }
    this.emit('recorded', results);
    return results;
  }
  // Session recording into an empty slot: starts at next bar, stops at the next bar after stopSlotRecording().
  async recordSlot(t, slot) {
    const n = this.tracks.get(t.id);
    if (!n.inputChain) await this.attachInput(t);
    if (!this.playing) this.play(this.barFloor(this.startPos));
    const when = this.ctx.currentTime < this.startCtxTime + 0.01 ? this.startCtxTime : this.nextBarTime();
    const rec = this.makeRecorder(n);
    rec.node.port.postMessage({ type: 'start', time: when });
    n.rec = { rec, slot, when };
    this.emit('session');
  }
  async stopSlotRecording(t) {
    const n = this.tracks.get(t.id); if (!n || !n.rec) return null;
    const { rec, slot, when: startT } = n.rec;
    let stopT = this.playing ? this.nextBarTime() : this.ctx.currentTime;
    if (stopT <= startT + 0.05) stopT = startT + this.barDur;
    rec.node.port.postMessage({ type: 'stop', time: stopT });
    n.rec.stopping = stopT;
    this.emit('session');
    const waitMs = Math.max(0, (stopT - this.ctx.currentTime) * 1000) + 1500;
    await Promise.race([rec.done, new Promise((r) => setTimeout(r, waitMs))]);
    n.rec = null;
    const buf = this.finishRecorder(rec);
    if (!buf) { this.emit('session'); return null; }
    // latency compensation: shift audio earlier by trimming the start and padding the end
    const lat = Math.floor(this.inputLatency(n) * buf.sampleRate);
    if (lat > 0 && lat < buf.length) {
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); d.copyWithin(0, lat); d.fill(0, d.length - lat); }
    }
    const bars = Math.max(1, Math.round(buf.duration / this.barDur));
    const loopLength = bars * this.barDur;
    let out = buf;
    if (buf.duration < loopLength) { // pad to a whole number of bars so the loop stays in time
      out = this.ctx.createBuffer(buf.numberOfChannels, Math.ceil(loopLength * buf.sampleRate), buf.sampleRate);
      for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c));
    }
    return { buffer: out, slot, loopLength, startT, stopT, warning: n.inputChain && n.inputChain.warning };
  }
  // Start a freshly recorded clip in sync (called after the buffer is available)
  playRecordedSlot(t, slot, startT) {
    const n = this.tracks.get(t.id); const clip = t.slots[slot];
    if (!this.playing || !clip) return;
    const buf = this.buffers.get(clip.bufferId);
    const now = this.ctx.currentTime + 0.03;
    this.startSessionSource(t, n, slot, buf, clip, now, now - startT);
  }

  async setOutputDevice(id) {
    if (!this.ctx.setSinkId) throw new Error('Output device selection is not supported in this browser.');
    await this.ctx.setSinkId(id === 'default' ? '' : id);
  }
  static outputSelectionSupported() { const AC = window.AudioContext || window.webkitAudioContext; return !!(AC && AC.prototype.setSinkId); }

  // live input capture for instrument detection when a track has no clips
  async captureInput(t, seconds = 4) {
    const n = this.tracks.get(t.id);
    if (!n.inputChain) await this.attachInput(t);
    const rec = this.makeRecorder(n);
    const now = this.ctx.currentTime;
    rec.node.port.postMessage({ type: 'start', time: now });
    rec.node.port.postMessage({ type: 'stop', time: now + seconds });
    await Promise.race([rec.done, new Promise((r) => setTimeout(r, seconds * 1000 + 1500))]);
    return this.finishRecorder(rec);
  }
}
