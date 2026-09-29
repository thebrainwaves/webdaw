// Web MIDI input: feature detection, input listing, message parsing. Routing, recording and
// MIDI-learn live in main.js via the callbacks below.
export const MIDI = {
  supported: typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function',
  access: null, status: 'idle', error: null,
  onNote: null,   // (inputId, ch, note, velocity, isOn, timeStamp)
  onCC: null,     // (inputId, ch, cc, value)
  onDevices: null,
  onBend: null,   // (inputId, ch, value -1..1)
  async init() {
    if (!this.supported) { this.status = 'unsupported'; return false; }
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
  inputs() { return this.access ? [...this.access.inputs.values()].map((i) => ({ id: i.id, name: i.name || 'MIDI input', state: i.state })) : []; },
  handle(inputId, e) {
    const d = e.data; if (!d || d.length < 2) return;
    const st = d[0] & 0xf0, ch = d[0] & 0x0f;
    if (st === 0x90 && d[2] > 0) this.onNote && this.onNote(inputId, ch, d[1], d[2], true, e.timeStamp);
    else if (st === 0x80 || (st === 0x90 && d[2] === 0)) this.onNote && this.onNote(inputId, ch, d[1], 0, false, e.timeStamp);
    else if (st === 0xb0) this.onCC && this.onCC(inputId, ch, d[1], d[2]);
    else if (st === 0xe0 && d.length > 2) this.onBend && this.onBend(inputId, ch, (((d[2] << 7) | d[1]) - 8192) / 8192);
  },
  notice() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (this.supported) return null;
    return ios ? 'Web MIDI is not available in Safari on iPhone/iPad (Apple does not support it). You can still play MIDI tracks with the on-screen keyboard/pads and edit notes in the piano roll.'
      : 'This browser has no Web MIDI support. Use Chrome, Edge or Firefox on desktop/Android for MIDI keyboards; the on-screen keyboard and piano roll still work.';
  },
};
