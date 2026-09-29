// AudioWorklet processors: recorder, meter, noise gate.
// Loaded once via audioWorklet.addModule().

class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = (options.processorOptions && options.processorOptions.channels) || 1;
    this.startFrame = Infinity;
    this.stopFrame = Infinity;
    this.recording = false;
    this.buf = [];
    this.bufLen = 0;
    this.chunk = 4096;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'start') {
        this.startFrame = Math.round(m.time * sampleRate);
        this.stopFrame = Infinity;
        this.recording = true;
        this.resetBuf();
      } else if (m.type === 'stop') {
        this.stopFrame = Math.round(m.time * sampleRate);
      }
    };
    this.resetBuf();
  }
  resetBuf() {
    this.buf = [];
    for (let c = 0; c < this.channels; c++) this.buf.push(new Float32Array(this.chunk));
    this.bufLen = 0;
  }
  flush(final) {
    if (this.bufLen > 0) {
      const out = this.buf.map((b) => b.slice(0, this.bufLen));
      this.port.postMessage({ type: 'data', channels: out }, out.map((a) => a.buffer));
    }
    this.resetBuf();
    if (final) this.port.postMessage({ type: 'done' });
  }
  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    const n = 128;
    const f0 = currentFrame;
    for (let i = 0; i < n; i++) {
      const f = f0 + i;
      if (f < this.startFrame) continue;
      if (f >= this.stopFrame) {
        this.recording = false;
        this.flush(true);
        return true;
      }
      for (let c = 0; c < this.channels; c++) {
        const ch = input[c] || input[0];
        this.buf[c][this.bufLen] = ch ? ch[i] : 0;
      }
      this.bufLen++;
      if (this.bufLen >= this.chunk) this.flush(false);
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);

class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peak = [0, 0];
    this.sum = [0, 0];
    this.count = 0;
    this.interval = Math.round(sampleRate / 30);
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let c = 0; c < 2; c++) {
      const ch = input[c] || input[0];
      if (output[c]) {
        if (ch) output[c].set(ch);
      }
      if (!ch) continue;
      let p = this.peak[c], s = this.sum[c];
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > p) p = v;
        s += ch[i] * ch[i];
      }
      this.peak[c] = p; this.sum[c] = s;
    }
    this.count += 128;
    if (this.count >= this.interval) {
      this.port.postMessage({
        peak: [this.peak[0], this.peak[1]],
        rms: [Math.sqrt(this.sum[0] / this.count), Math.sqrt(this.sum[1] / this.count)],
      });
      this.peak = [0, 0]; this.sum = [0, 0]; this.count = 0;
    }
    return true;
  }
}
registerProcessor('meter-processor', MeterProcessor);

// Noise gate with hysteresis, attack/hold/release. Params via AudioParams.
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0 },
      { name: 'release', defaultValue: 0.08, minValue: 0.005, maxValue: 2 },
      { name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    this.env = 0; this.gain = 0; this.hold = 0;
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input.length) return true;
    const thr = Math.pow(10, params.threshold[0] / 20);
    const thrClose = thr * 0.6;
    const rel = params.release[0];
    const enabled = params.enabled[0] > 0.5;
    const envCoef = Math.exp(-1 / (0.002 * sampleRate));
    const envRel = Math.exp(-1 / (0.03 * sampleRate));
    const att = 1 - Math.exp(-1 / (0.0008 * sampleRate));
    const relC = 1 - Math.exp(-1 / (rel * sampleRate));
    const holdSamples = 0.02 * sampleRate;
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let lv = 0;
      for (let c = 0; c < input.length; c++) { const v = Math.abs(input[c][i]); if (v > lv) lv = v; }
      this.env = lv > this.env ? envCoef * this.env + (1 - envCoef) * lv : envRel * this.env + (1 - envRel) * lv;
      let target;
      if (this.env > thr) { target = 1; this.hold = holdSamples; }
      else if (this.env > thrClose && this.gain > 0.5) { target = 1; }
      else if (this.hold > 0) { this.hold--; target = 1; }
      else target = 0;
      this.gain += (target - this.gain) * (target > this.gain ? att : relC);
      const g = enabled ? this.gain : 1;
      for (let c = 0; c < output.length; c++) {
        const ch = input[c] || input[0];
        output[c][i] = ch[i] * g;
      }
    }
    return true;
  }
}
registerProcessor('gate-processor', GateProcessor);
