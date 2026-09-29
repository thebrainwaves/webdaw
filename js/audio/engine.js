// Audio engine: context, master bus, tracks, transport, session/arrangement playback, recording.
import { createEffect } from './effects.js';

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
    this.metroGain = ctx.createGain(); this.metroGain.gain.value = 0.5; this.metroGain.connect(ctx.destination);
    this._sched = setInterval(() => this.schedulerTick(), 25);
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
  }
  setMasterFx(fxList) {
    const m = this.master;
    m.fx.forEach((f) => f.dispose());
    m.fx = fxList.map((d) => { const f = createEffect(this.ctx, d.type, d.values, d.enabled !== false); d.values = f.values; return f; });
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
    n.post.connect(n.vol).connect(n.pan).connect(n.mute).connect(n.meter).connect(this.master.input);
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
    this.tracks.delete(id); this.meters.delete(id);
  }
  setTrackFx(t) {
    const n = this.tracks.get(t.id); if (!n) return;
    n.fx.forEach((f) => f.dispose());
    n.fx = t.fx.map((d) => { const f = createEffect(this.ctx, d.type, d.values, d.enabled !== false); d.values = f.values; return f; });
    this.wireChain(n.input, n.fx, n.post);
  }
  fxInstances(trackId) { return trackId === 'master' ? this.master.fx : (this.tracks.get(trackId) || { fx: [] }).fx; }
  setFxParam(trackId, idx, key, value) { const f = this.fxInstances(trackId)[idx]; if (f) f.set(key, value); }
  setFxEnabled(trackId, idx, on) { const f = this.fxInstances(trackId)[idx]; if (f) f.setEnabled(on); }
  updateBpmFx() {
    if (!this.project) return;
    const all = [...this.master.fx]; this.tracks.forEach((n) => all.push(...n.fx));
    all.forEach((f) => f.setBpm && f.setBpm(this.project.bpm));
  }
  syncTrack(t) {
    const n = this.tracks.get(t.id); if (!n) return;
    const now = this.ctx.currentTime;
    n.vol.gain.setTargetAtTime(dbToLin(t.volume), now, 0.01);
    if (n.pan.pan) n.pan.pan.setTargetAtTime(t.pan, now, 0.01);
    this.syncMutes();
    n.monitor.gain.setTargetAtTime(t.monitor && t.arm ? 1 : 0, now, 0.01);
  }
  syncMutes() {
    const anySolo = this.project.tracks.some((t) => t.solo);
    for (const t of this.project.tracks) {
      const n = this.tracks.get(t.id); if (!n) continue;
      const audible = !t.mute && (!anySolo || t.solo);
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
    gain.connect(n.monitor);
    n.inputChain = { gain, from, stereo, latency: inp.latency, warning, channels: inp.channels };
    return n.inputChain;
  }
  releaseUnusedInputs() {
    const used = new Set(this.project.tracks.filter((t) => t.arm).map((t) => t.inputDeviceId || 'default'));
    for (const [k, inp] of this.inputs) {
      if (!used.has(k)) { inp.stream.getTracks().forEach((x) => x.stop()); try { inp.source.disconnect(); } catch (e) {} this.inputs.delete(k); }
    }
  }

  // ------------------------------------------------------------------ transport
  get barDur() { return (60 / this.project.bpm) * (this.project.beatsPerBar || 4); }
  get beatDur() { return 60 / this.project.bpm; }
  position() { return this.playing ? this.startPos + (this.ctx.currentTime - this.startCtxTime) : this.startPos; }
  posToTime(pos) { return this.startCtxTime + (pos - this.startPos); }
  barFloor(pos) { return Math.floor(pos / this.barDur + 1e-6) * this.barDur; }
  nextBarTime() {
    const pos = this.position(), bd = this.barDur;
    let nb = Math.ceil((pos + 0.02) / bd) * bd;
    return this.posToTime(nb);
  }
  play(fromPos) {
    if (this.playing) return;
    this.resume();
    if (fromPos != null) this.startPos = fromPos;
    this.startCtxTime = this.ctx.currentTime + 0.06;
    this.playing = true;
    this.nextClick = null;
    for (const t of this.project.tracks) this.scheduleArrangement(t);
    this.emit('transport');
  }
  stop() {
    if (this.recording) this.stopRecording();
    const pos = this.position();
    this.playing = false;
    this.tracks.forEach((n) => { this.stopTrackSources(n, 0, true); n.queued = null; });
    // pressing stop while stopped returns to start (like most DAWs)
    this.startPos = pos === this.startPos ? 0 : pos;
    this.emit('transport'); this.emit('session');
  }
  setPosition(pos) {
    const was = this.playing;
    if (was) { this.playing = false; this.tracks.forEach((n) => this.stopTrackSources(n, 0, false)); }
    this.startPos = Math.max(0, pos);
    if (was) this.play();
    this.emit('transport');
  }
  stopTrackSources(n, when = 0, includeSession = true) {
    n.sources.forEach((s) => { try { s.stop(when); } catch (e) {} });
    n.sources = [];
    if (includeSession && n.sessionSource) { try { n.sessionSource.stop(when); } catch (e) {} n.sessionSource = null; n.sessionSlot = -1; }
  }
  scheduleArrangement(t) {
    const n = this.tracks.get(t.id); if (!n || n.sessionSource) return;
    const pos = this.startPos;
    for (const c of t.arrangement) {
      const buf = this.buffers.get(c.bufferId); if (!buf) continue;
      const end = c.start + c.duration;
      if (end <= pos) continue;
      const src = this.ctx.createBufferSource(); src.buffer = buf;
      const g = this.ctx.createGain(); g.gain.value = dbToLin(c.gain || 0);
      src.connect(g).connect(n.input);
      const when = this.posToTime(Math.max(pos, c.start));
      const offs = c.offset + Math.max(0, pos - c.start);
      const dur = c.duration - Math.max(0, pos - c.start);
      try { src.start(when, offs, dur); } catch (e) { continue; }
      n.sources.push(src);
    }
  }
  schedulerTick() {
    if (!this.ctx || !this.playing) return;
    this.pollMeters();
    if (!this.metronome && !this.countIn) return;
    const bd = this.beatDur, ahead = this.ctx.currentTime + 0.12;
    if (this.nextClick == null) {
      const pos = this.position();
      this.nextClick = Math.ceil((pos - 0.001) / bd);
    }
    while (this.posToTime(this.nextClick * bd) < ahead) {
      const t = this.posToTime(this.nextClick * bd);
      if (t >= this.ctx.currentTime - 0.01) this.click(t, this.nextClick % (this.project.beatsPerBar || 4) === 0);
      this.nextClick++;
    }
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
    const loopLen = Math.min(clip.loopLength || buf.duration, buf.duration);
    src.loopStart = 0; src.loopEnd = loopLen;
    const g = this.ctx.createGain(); g.gain.value = dbToLin(clip.gain || 0);
    src.connect(g).connect(n.input);
    src.start(when, offset % loopLen);
    n.sessionSource = src; n.sessionSlot = slot; n.queued = { slot, when };
    n.sessionStart = when - offset;
    setTimeout(() => { if (n.queued && n.queued.when === when) n.queued = null; this.emit('session'); }, Math.max(0, (when - this.ctx.currentTime) * 1000) + 20);
    this.emit('session');
  }
  stopTrackClip(t) {
    const n = this.tracks.get(t.id); if (!n || !n.sessionSource) return;
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
    const armed = this.project.tracks.filter((t) => t.arm);
    if (!armed.length) throw new Error('Arm at least one track (● button) to record.');
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
    this.recording = true;
    this.emit('transport');
  }
  async stopRecording() {
    if (!this.recording) return [];
    this.recording = false;
    const when = this.ctx.currentTime;
    const takes = this.recTakes || []; this.recTakes = null;
    takes.forEach((k) => k.rec.node.port.postMessage({ type: 'stop', time: when }));
    this.emit('transport');
    const results = [];
    for (const k of takes) {
      await Promise.race([k.rec.done, new Promise((r) => setTimeout(r, 1500))]);
      const buf = this.finishRecorder(k.rec);
      if (!buf) continue;
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
