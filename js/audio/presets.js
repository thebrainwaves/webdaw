// Auto-mix preset chains per instrument. Each preset = ordered list of effects with parameter values.
// Values are starting points modelled on common mixing practice, not magic; tweak to taste.

export const INSTRUMENTS = ['guitar', 'bass', 'drums', 'vocals', 'keys', 'other'];
export const INSTRUMENT_LABELS = { guitar: 'Guitar', bass: 'Bass', drums: 'Drums', vocals: 'Vocals', keys: 'Keys', other: 'Other' };

const eq = (v) => ({ type: 'eq', values: v });
const comp = (v) => ({ type: 'compressor', values: v });
const dist = (v) => ({ type: 'distortion', values: v });
const delay = (v) => ({ type: 'delay', values: v });
const verb = (v) => ({ type: 'reverb', values: v });
const lim = (v) => ({ type: 'limiter', values: v });

export const PRESETS = {
  guitar: {
    'Clean (DI)':       [eq({ hpf: 90, m1Freq: 300, m1Gain: -2.5, m1Q: 1.2, m2Freq: 3000, m2Gain: 2, highGain: 1.5, lpf: 14000 }), comp({ threshold: -20, ratio: 3, attack: 15, release: 150, makeup: 3 }), delay({ sync: '1/8d', feedback: 25, mix: 12, tone: 4000 }), verb({ space: 'room', decay: 1.0, mix: 14 })],
    'Crunch Amp':       [dist({ voicing: 'crunch', drive: 45, tight: 90, bass: 1, mid: 1, treble: 1, presence: 2, cab: 'open', gate: -75 }), eq({ hpf: 90, m1Freq: 400, m1Gain: -2, lpf: 11000 }), comp({ threshold: -16, ratio: 2, attack: 20, release: 120, makeup: 1 }), verb({ space: 'room', decay: 0.9, mix: 10 })],
    'High Gain Rhythm': [dist({ voicing: 'highgain', drive: 60, tight: 140, bass: 2, mid: -2, treble: 2, presence: 3, cab: 'closed', gate: -62 }), eq({ hpf: 100, m1Freq: 250, m1Gain: -3, m1Q: 1.4, m2Freq: 3500, m2Gain: 1.5, lpf: 10000 }), comp({ threshold: -14, ratio: 2, attack: 25, release: 100 }), verb({ space: 'room', decay: 0.7, mix: 6 })],
    'Death Metal':      [dist({ voicing: 'death', drive: 80, tight: 200, bass: 3, mid: -5, treble: 3, presence: 5, cab: 'closed', gate: -55 }), eq({ hpf: 110, m1Freq: 500, m1Gain: -3, m1Q: 1.2, m2Freq: 2800, m2Gain: 2, lpf: 9000 }), comp({ threshold: -12, ratio: 2, attack: 30, release: 80 })],
    'Lead':             [dist({ voicing: 'highgain', drive: 70, tight: 110, mid: 3, presence: 2, cab: 'closed', gate: -70 }), eq({ hpf: 110, m2Freq: 1800, m2Gain: 2 }), delay({ sync: '1/4', feedback: 35, mix: 22, pingpong: 'on' }), verb({ space: 'hall', decay: 2.2, mix: 18 })],
  },
  bass: {
    'Tight DI':  [eq({ hpf: 35, lowFreq: 80, lowGain: 2, m1Freq: 250, m1Gain: -3, m1Q: 1.2, m2Freq: 800, m2Gain: 1.5, highFreq: 5000, highGain: -2, lpf: 9000 }), comp({ threshold: -22, ratio: 4, attack: 8, release: 120, makeup: 4 })],
    'Growl':     [dist({ voicing: 'overdrive', drive: 30, tight: 40, bass: 3, mid: 2, treble: -2, presence: 0, cab: 'off', gate: -80, level: 2 }), eq({ hpf: 35, m1Freq: 250, m1Gain: -3, m2Freq: 1200, m2Gain: 3 }), comp({ threshold: -20, ratio: 5, attack: 5, release: 100, makeup: 3 })],
    'Sub Heavy': [eq({ hpf: 28, lowFreq: 60, lowGain: 4, m1Freq: 350, m1Gain: -4, highGain: -4, lpf: 5000 }), comp({ threshold: -24, ratio: 6, attack: 10, release: 150, makeup: 5 })],
  },
  drums: {
    'Punchy Bus': [eq({ hpf: 30, lowFreq: 70, lowGain: 2.5, m1Freq: 400, m1Gain: -3, m1Q: 1, m2Freq: 4000, m2Gain: 2, highFreq: 10000, highGain: 2.5 }), comp({ threshold: -20, ratio: 4, attack: 20, release: 100, makeup: 4, mix: 60 }), verb({ space: 'room', decay: 0.6, mix: 8 }), lim({ input: 2, ceiling: -1 })],
    'Big Room':   [eq({ hpf: 30, lowGain: 2, m1Freq: 500, m1Gain: -2, highGain: 3 }), comp({ threshold: -24, ratio: 6, attack: 10, release: 80, makeup: 6, mix: 50 }), verb({ space: 'chamber', decay: 1.3, mix: 16 })],
    'Metal Kit':  [eq({ hpf: 35, lowFreq: 60, lowGain: 3, m1Freq: 350, m1Gain: -5, m1Q: 1.3, m2Freq: 5000, m2Gain: 4, highGain: 2 }), comp({ threshold: -18, ratio: 5, attack: 5, release: 60, makeup: 4, mix: 70 }), lim({ input: 3, ceiling: -1 })],
  },
  vocals: {
    'Pop Vocal':   [eq({ hpf: 100, m1Freq: 300, m1Gain: -2.5, m1Q: 1.2, m2Freq: 3500, m2Gain: 2.5, highFreq: 10000, highGain: 3 }), comp({ threshold: -22, ratio: 4, attack: 5, release: 90, makeup: 5 }), delay({ sync: '1/4', feedback: 20, mix: 10, tone: 3500, pingpong: 'on' }), verb({ space: 'plate', decay: 1.8, mix: 16, predelay: 30 })],
    'Rock Vocal':  [eq({ hpf: 110, m1Freq: 400, m1Gain: -3, m2Freq: 2500, m2Gain: 3, highGain: 2 }), comp({ threshold: -20, ratio: 6, attack: 3, release: 60, makeup: 6 }), dist({ voicing: 'overdrive', drive: 5, tight: 150, cab: 'off', gate: -90, level: 8 }), verb({ space: 'room', decay: 1.1, mix: 12 })],
    'Scream':      [eq({ hpf: 150, m1Freq: 500, m1Gain: -3, m2Freq: 3000, m2Gain: 2, lpf: 12000 }), comp({ threshold: -16, ratio: 8, attack: 2, release: 50, makeup: 4 }), verb({ space: 'room', decay: 0.8, mix: 10 })],
    'Ambient':     [eq({ hpf: 120, m2Freq: 5000, m2Gain: 2, highGain: 3 }), comp({ threshold: -24, ratio: 3, attack: 10, release: 150, makeup: 4 }), delay({ sync: '1/4', feedback: 45, mix: 25, pingpong: 'on' }), verb({ space: 'hall', decay: 4, mix: 30 })],
  },
  keys: {
    'Piano':      [eq({ hpf: 40, m1Freq: 300, m1Gain: -2, m2Freq: 3000, m2Gain: 1.5, highGain: 1 }), comp({ threshold: -18, ratio: 2, attack: 20, release: 200, makeup: 2 }), verb({ space: 'hall', decay: 2.2, mix: 16 })],
    'Synth Pad':  [eq({ hpf: 120, m1Freq: 400, m1Gain: -2, highGain: 2 }), comp({ threshold: -20, ratio: 2, attack: 40, release: 300, makeup: 2 }), delay({ sync: '1/8d', feedback: 30, mix: 15, pingpong: 'on' }), verb({ space: 'cathedral', decay: 4, mix: 28 })],
    'Organ Grit': [dist({ voicing: 'overdrive', drive: 25, cab: 'combo', gate: -90, tight: 60 }), eq({ hpf: 60 }), verb({ space: 'spring', decay: 1.5, mix: 15 })],
  },
  other: {
    'Gentle Polish': [eq({ hpf: 40, m1Freq: 300, m1Gain: -1.5, highGain: 1.5 }), comp({ threshold: -18, ratio: 2, attack: 15, release: 150, makeup: 2 }), verb({ space: 'room', decay: 1, mix: 10 })],
    'Clean Slate':   [],
  },
};

export function defaultPresetName(instrument) {
  return Object.keys(PRESETS[instrument] || PRESETS.other)[0];
}

export const MASTER_PRESET = [
  { type: 'eq', values: { hpf: 25, lowFreq: 90, lowGain: 0.5, m1Freq: 350, m1Gain: -0.5, highFreq: 11000, highGain: 1 } },
  { type: 'compressor', values: { threshold: -14, ratio: 2, attack: 30, release: 200, knee: 10, makeup: 1 } },
  { type: 'maximizer', values: { gain: 2, ceiling: -0.5, release: 80, character: 50 } },
  { type: 'limiter', values: { input: 0, ceiling: -0.3, release: 50 } },
];
