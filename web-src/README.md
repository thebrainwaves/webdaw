# Auduio (v0.5.1)

Auduio was called WebDAW until v0.3.1. Saved projects and settings carry over automatically, and old `.webdaw.zip` files still import; new exports are `.auduio.zip`.

A browser DAW packaged as an installable PWA. It uses vanilla ES modules with no framework and no bundler. The build step copies `src/` to `dist/` and adds the service-worker precache list.

## Run locally
```
npm run build                  # src/ -> dist/
npm run serve                  # http://localhost:8080/
npm run serve:subpath          # http://localhost:8080/daw/  (simulates a GitHub Pages project subpath)
npm run dev                    # serve src/ directly (add ?nosw to the URL to skip the service worker)
npm test                       # v0.1 headless e2e (Playwright + Chromium, fake mic); DAW_BROWSER=firefox for Firefox
node tests/e2e-v2.mjs          # v0.2 feature suite (mocked Web MIDI, racks, groups, tiers, pitch, security, phone)
node tests/tempo-unit.mjs      # v0.3 tempo detection unit tests (synthetic click tracks / grooves, Node only)
node tests/e2e-tempo.mjs       # v0.3 auto-timing in a real browser (tap, detect, follow, clip BPM)
node tests/e2e-v3.mjs          # v0.3 phone mode, tutorial, theme, waveforms/clip detail, free clip placement
node tests/e2e-v031.mjs        # v0.3.1 no-emoji UI scan, click-to-audition, clip preview, auto-monitor
node tests/e2e-loop.mjs        # v0.3.1 loop brace, looped playback, loop-recording takes, phone loop controls
node tests/e2e-rename.mjs      # v0.3.1 rename to Auduio: visible name, .auduio.zip export, old file import, storage migration
node tests/randomize-unit.mjs  # v0.4 randomizer logic (musical/chaos, locks, safe levels), Node only
node tests/e2e-v04.mjs         # v0.4 browser sidebar, MIDI effects, randomizer on every device (screenshots -> shots/)
node tests/e2e-plugins.mjs     # v0.4 plugin hosting: this UI driving the real native engine + Surge XT (skips if not built)
```
The mic needs HTTPS or localhost. GitHub Pages serves over HTTPS.

## Publish
Publish the contents of `dist/`. Every path is relative, so the app works from any subpath.

## Layout
- `src/js/audio/engine.js`: AudioContext, master bus, tracks, transport, session/arrangement playback, recording, input/output devices
- `src/js/audio/effects.js`: EQ, compressor, maximizer, limiter, delay, convolution reverb, amp/distortion
- `src/js/audio/ir.js`: synthetic impulse responses (room, chamber, hall, plate, cathedral, spring)
- `src/js/audio/worklets.js`: AudioWorklet recorder, meter and noise gate
- `src/js/audio/detect.js`: heuristic instrument detection (FFT features and fuzzy rules)
- `src/js/audio/presets.js`: auto-mix preset chains per instrument, plus the master chain
- `src/js/project.js`: project model, IndexedDB, WAV encode/decode, ZIP export/import
- `src/js/ui/controls.js`: knobs and faders (pointer events, touch-friendly)
- `src/js/main.js`: UI (session grid, arrangement, device panel, menus, dialogs, groups, racks, tiers)
- `src/js/audio/synths.js`: polyphonic Analog Synth (3 osc + sub, drift, ladder LPF with drive, glide) and Wavetable Synth (code-generated tables, morph, unison)
- `src/js/audio/instruments.js`: drum sampler plus the instrument registry
- `src/js/audio/pitchdsp.js`, `timecorrect.js`: YIN pitch detection and correction, transient quantize
- `src/js/audio/keydetect.js`, `keyfollow.js`: key detection and live "follow the band"
- `src/js/audio/adaptive.js`: live adaptive EQ/compressor
- `src/js/tiers.js`: **feature-tier config (Basic/Mid/Large)**, one file to edit
- `src/js/audio/tempo.js`: onset detection, tempo/beat estimation, streaming analyser, follow controller, tap tempo, test click tracks
- `src/js/ui/waveform.js`: peak mipmaps (min/max/RMS), zoom-aware canvas waveform drawing, live-recording peaks, oscilloscope
- `src/js/ui/phone.js`: simple phone layout (Record / Tracks / Mix / Effects / More)
- `src/js/ui/tutorial.js`: interactive first-run tutorial
- `src/js/midi.js`, `ui/pianoroll.js`, `history.js`, `security.js`, `validate.js`: Web MIDI, piano roll, undo/redo, PIN/encryption, import validation

## What's new in v0.4
- **Browser sidebar** (desktop layouts; press B or the arrow to collapse it to an icon rail). It lists Instruments, MIDI Effects, Audio Effects, Racks and Plugins, with search. Drag an item onto a track, double-click it, or use its + button. Items dropped on empty space create a fitting new track.
- **MIDI effects** in front of the instrument on MIDI tracks: Arpeggiator (synced to the transport, also works while stopped), Chord, Scale (follows the song key), Note Length, Velocity and Random.
- **Randomizer on every device** (instruments, MIDI effects, audio effects, rack chains, plugins):
  - A dice button randomizes the device. The options arrow sets the amount and switches between Musical and Chaos.
  - Per-parameter locks (lock icon on the knob, or chips in the options).
  - "Randomize chain" and "Randomize track". Every randomize is one undo step.
  - Musical mode keeps output levels where they are, keeps feedback, resonance and drive in a safe range, uses musical intervals for transpose, and balances EQ boosts.
- **Plugins (desktop app only):**
  - Loads VST3 and CLAP plugins (no Audio Units) through a native audio engine sidecar, and scans plugin folders in separate processes.
  - The plugin's own window opens from its device card. The card also has a parameter list with search, randomize, macros, MIDI learn and automation recording.
  - The web app, Android and iOS show the Plugins section as desktop-only.
  - See `../daw-apps/docs/PLUGIN-HOSTING.md` (apps branch: `apps/docs/PLUGIN-HOSTING.md`).

## What's new in v0.3.1
- Renamed to Auduio. The visible name, manifest, export extension (`.auduio.zip`, `.auduio.enc`) and the desktop and mobile app ids all changed. Projects saved in the old `webdaw` IndexedDB database are copied into the new `auduio` one the first time you open it, and the old database is left untouched. Settings saved under the old `webdaw.*` keys are copied too. The project file format id stays `webdaw-project`, so older versions can still open new files; `auduio-project` is also accepted.
- A recording machine, not a toy: all emoji are gone. The UI uses monochrome SVG line icons (`src/js/ui/icons.js`) or plain text, with flatter surfaces, tighter type and tabular numbers. The purple/red accents and phone-mode touch sizes are unchanged.
- Click to hear: pressing an audio clip in the Arrangement or an audio slot in Session auditions it right away through the track's effects, with no launch quantize. Hold it to preview until you let go, or tap it once to latch and tap again to stop. Session slots have a separate play button for a quantized launch. In clip detail, use the Preview button or tap the waveform to play from that point. Esc stops a preview.
- Auto-monitor (Preferences): hear the selected armed track's input. Use headphones.
- Loop bar: the loop brace sits on the Arrangement ruler.
  - Drag along the ruler to set a loop. Drag the bar to move it, or drag its edges to resize. It snaps to beats (bars when zoomed out); hold Alt to place it freely.
  - Double-click the brace, or use the Loop button in the transport, to switch the loop on or off. Ctrl/Cmd+L loops the selected clip, or the 4 bars at the playhead.
  - Playback wraps seamlessly: every pass is scheduled sample-accurately ahead of time and the metronome keeps an even beat.
  - Recording while the loop is on keeps every pass as a take of one recording. The clip uses the last complete pass; pick another take with the Take buttons in clip detail or the clip menu. MIDI loop recording merges the passes into one clip (overdub).
  - Phone mode has a Loop toggle plus "loop these bars" controls (start bar, 1/2/4/8 bars).
  - The loop is saved with the project and every change can be undone.
- Fix: per-track meters stayed at zero in the analyser fallback (when AudioWorklet is unavailable), for example during audition.
- In the desktop and mobile app shells the service worker is skipped, because those apps bundle their files.

## What's new in v0.3
- **Auto-timing:** live tempo detection from armed inputs and playing tracks (confidence shown, 60–200 BPM, ÷2/×2), “Detect tempo” (listens ~8 bars, sets BPM and downbeat), Follow mode (smooth, rate-limited, optional lock), tap tempo (T key) and BPM detection on clips with “set project tempo from clip”. Tap is Basic tier, the rest Mid.
- **Phone mode:** turns on automatically on small/touch screens (Preferences or ☰ to change). One screen at a time with a bottom tab bar, 48px+ targets, plain-language labels (“Make it louder” — Compressor), a big record button, a large waveform, swipe between tracks.
- **Tutorial:** 6 interactive one-sentence steps on phones (4 on desktop) that highlight the real control. Skippable; replay from Help mode, ☰ → Tutorial, Preferences or phone More.
- **Theme:** purple primary (#8B5CF6) and red for record/arm (#EF4444). Knob arcs use a purple→red gradient; no yellow/orange left.
- **Waveforms:** Clip waveforms in the clip colour, drawn from cached peak mipmaps (stays sharp at any zoom; raw samples when zoomed far in), L/R lanes on tall tracks (↕). A clip detail view (bottom panel) shows a zoomable waveform with draggable start/end or loop markers, gain, transpose/detune (repitch), a transient overlay (the hits Quantize moves) and the beat grid. A live waveform scrolls in while recording. A master oscilloscope sits in the header.
- **Free clip placement:** drop audio files on any track/time/slot (empty space = new track). Drag clips between tracks, and between Arrangement and Session by hovering the view tab. Snap toggle (beat grid; Alt/Shift bypasses). Overlapped clips underneath are trimmed, split or removed. On touch screens, long-press a clip and drag, or use “Pick up / move…” then “Place here”. All undoable.

## What's new in v0.2
- **Instruments:** polyphonic Analog and Wavetable synths with voice stealing, velocity, pitch bend and mod wheel, plus presets.
- **MIDI:** MIDI tracks, Web MIDI input (not available on iOS Safari), recording into the arrangement and session slots, a piano roll, and MIDI learn.
- **Effects:** chorus, auto-pan and tremolo (tempo-syncable), and a guitar amp sim.
- **Racks:** parallel chains with per-chain volume, pan and mute; 4 macros mappable to inner params; rack presets saved locally.
- **Group tracks:** a group bus with its own effects and fader, fold/unfold, and nesting.
- **Editing:**
  - Undo/redo that applies in place without stopping playback.
  - Copy, paste, duplicate, delete and split.
  - Drag-and-drop audio import at the drop position.
  - Pinch-zoom and an overview bar.
- **Fine control:** Shift/Alt-drag or a two-finger touch on a knob steps gain params by 0.01 dB and other params proportionally, with a readout. Double-tap resets.
- **Auto-Mix and correction:**
  - An Auto-Mix setup pop-up with per-track roles and "from bar".
  - Adaptive EQ/compressor.
  - Pitch correction and transient quantize.
  - Key detection and follow-the-band.
- **Recording:** input LEDs, and auto-record on sound with pre-roll.
- **Accessibility:** Easy Mode, help mode, high contrast and a first-run guide.
- **Security:**
  - Strict CSP and strict zip validation.
  - A PBKDF2 PIN (a casual lock only).
  - AES-GCM encrypted export (`.enc`).
- **Tiers:** Basic, Mid and Large, set in `src/js/tiers.js`.
  - **Placeholder only.** There are no payments or licensing. The tier is a local setting (Menu → Preferences) and any tier can be switched to for testing.
  - The default is `large` (`DEFAULT_TIER`).


## Project file format
The export is an `.auduio.zip` file (older versions wrote `.webdaw.zip`; both import) (stored, uncompressed). It contains `project.json` and `audio/<bufferId>.wav` (16-bit PCM). Import also accepts a zip that uses deflate compression, provided the browser supports DecompressionStream.
