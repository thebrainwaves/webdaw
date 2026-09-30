# Plugin hosting in the Auduio desktop app (VST3, CLAP)

> **Current state (v0.5.1):** every desktop release ships the Rust engine in `../engine-rs`: VST3 and CLAP on
> Windows, macOS and Linux. Audio Units are not supported. The earlier C++ engine has been removed from the repository.

Auduio's audio engine is Web Audio, and a browser can't load native plugins. So the desktop app (Tauri)
ships a second process next to the window: **auduio-engine**, a small native audio engine written in
Rust (`../engine-rs`). The window talks to it over a pipe.

```
 Auduio window (Tauri webview)                     auduio-engine (Rust, separate process)  
 ┌───────────────────────────┐   invoke engine_send  ┌──────────────────────────────────────┐
 │ web app (Web Audio tracks) │ ───────────────────▶ │ stdin: NDJSON commands               │
 │ plugins/host.js  (client)  │                      │ tracks -> plugin chain -> device out │
 │ plugins/native.js (model,  │ ◀─────────────────── │ stdout: NDJSON replies + events      │
 │   card, macros, automation)│   event engine://msg │ editor windows (plugin's own GUI)    │
 └───────────────────────────┘                      │ scanner: 1 child process per file    │
          ▲  src-tauri/src/sidecar.rs supervises it │   (auduio-engine --scan-one ...)     │
          └──────── spawn, restart on crash ────────└──────────────────────────────────────┘
```

## Routing decision: plugin tracks render in the native engine

Two designs were possible:

1. **Stream plugin audio back into Web Audio.** Every block goes engine → IPC → webview → an
   AudioWorklet. Each hop adds buffering (IPC, the JS event loop, worklet ring buffers), the two
   audio clocks drift (two devices, or the same device opened twice), and any hiccup in the webview
   is heard as a dropout. It would also push about 1.5 MB/s per stereo track through JSON or base64.
2. **Tracks with plugins run in the native engine** and play straight to the audio device.

**Auduio uses option 2.** It's the robust choice: the audio path stays native from MIDI in to the
speaker, with sample-accurate MIDI and parameter timing inside the engine and no clock drift.

- A MIDI track whose instrument is a plugin is a *native track*. Its notes still go through Auduio's
  own MIDI effects (arpeggiator, chord, scale and so on) in the web app. The resulting notes go to
  the engine with **engine timestamps**. The web app maps `AudioContext.currentTime` to the engine's
  sample clock with a `clock` round trip every 3 s, plus an output-latency difference, so scheduled
  notes land on the right sample.
- The track's volume, pan and mute/solo, plus group and master volume, are mirrored to the engine
  (`track.set`).
- Plugin effects go after the plugin instrument on the same track.
- Limitations in v1 (all documented in the UI):
  - Auduio's built-in Web Audio effects on a native track are bypassed.
  - The web master effects don't process native tracks.
  - Plugin effects on audio tracks need audio sent *to* the engine. That's planned, and so is
    "freeze to audio".
- Offline rendering is implemented in the engine (`render`: MIDI in → WAV out) as the basis for
  bounce, freeze and export.

## Protocol (newline-delimited JSON, protocol 1)

Every request is `{"id": <n>, "cmd": "<name>", ...args}`. The reply is
`{"id": <n>, "ok": true, "result": ...}` or `{"id": <n>, "ok": false, "error": "..."}`.
Events look like `{"event": "<name>", ...}`. Logs go to stderr.

| Command | Arguments | Result |
|---|---|---|
| `hello` / `ping` | | engine version, protocol, host, formats, device, dataDir |
| `clock` | | `{samples, sampleRate, seconds, running}` |
| `audio.devices` | | device types, current device |
| `audio.open` | `type?, device?, sampleRate?, bufferSize?` | device info (incl. `outputLatency`) |
| `audio.close` | | |
| `scan` | `paths?: []` | starts a background scan. Events: `scan.progress {done,total,file}`, `scan.done {plugins, failed}` |
| `scan.cancel`, `plugins.list` | | cached list `{plugins:[{uid,name,vendor,format,category,isInstrument,file,...}], failed, paths}` |
| `plugin.load` | `trackId, uid (or file), state?, slot?` | `{instanceId, plugin, hasEditor, latency, params:[...]}` |
| `plugin.unload` | `instanceId` | |
| `plugin.params` | `instanceId` | every parameter: `{i, id, name, label, def, value, text, steps, discrete, bool, automatable, meta, category, options?, hidden?}` |
| `param.set` | `instanceId, index, value (0..1), t?, notify?` | `{texts}`. `t` = engine time (sample-accurate). `notify` = behave like a move in the plugin's window |
| `param.setMany` | `instanceId, values: [[index, value], ...], t?` | `{texts}` |
| `editor.open` / `editor.close` | `instanceId` | `{width, height}`. Event: `editor.closed` |
| `state.get` / `state.set` | `instanceId, data?` | standard base64 of the plugin's state chunk |
| `midi` | `trackId, events: [{t?, d:[status, d1, d2]}]` | channel messages only (SysEx is rejected) |
| `notesOff` | `trackId` | all notes off |
| `transport` | `playing, bpm, ppq` | exposed to plugins through the host play head |
| `track.set` | `trackId, gainDb?, pan?, mute?` | |
| `track.remove` | `trackId` | unloads that track's plugins |
| `render` | `trackId, seconds, notes:[{t,n,v,d}], wav?` | offline render: `{peak, rms, samples, sampleRate, wav?}` |
| `midiout.list` / `midiout.send` / `midiout.allOff` / `midiout.close` | | hardware MIDI out (see engine-rs/README.md) |
| `midiin.list` / `midiin.open` / `midiin.close` | `port` | hardware MIDI in; events `{"event":"midiin", port, d:[...]}` |
| `quit` | | clean exit. EOF on stdin also quits |

Events:
- `ready`: sent once at start-up.
- `params`: about 20 Hz. Its `changes` field is `[[index, value, text], ...]`, which covers edits
  made in the plugin's own window, and its `gestures` field carries touch begin/end.
- `meters`, `scan.progress`, `scan.done`, `editor.closed`.

Tauri side (`src-tauri/src/lib.rs`, `sidecar.rs`):
- `invoke("engine_send", {line})` starts the engine on first use. `engine_status` and
  `engine_restart` also exist.
- Engine output arrives as the event `engine://msg`, one line each. There are also `engine://log`
  (stderr) and `engine://exit` (`{code, restarting}`).

## What the UI does with it

- **Browser sidebar → Plugins:**
  - The Scan button runs the scan in separate processes.
  - The list shows instruments first ("Inst VST3", "FX VST3").
  - You can double-click, drag onto a track, or use the + button.
- **Plugin device card:**
  - "Open plugin window" button (the plugin's own editor).
  - Searchable list of all visible parameters. Each has a slider, the plugin's value text and a
    lock button.
  - 8 macros: press Map, then click parameters.
  - **Auto** records automation while playing: moves in the card, in the plugin window, from macros
    or from a MIDI controller. Playback happens during transport.
  - MIDI Learn works on any plugin parameter (the Learn button, then click a parameter row, then move
    a controller).
- **Randomizer:**
  - Works on the plugin card, and through "Randomize chain" / "Randomize track".
  - Musical mode never touches output/master volume, bypass, mute, polyphony, tuning/octave, pitch
    bend range and similar parameters.
  - It keeps structure selectors (filter/oscillator *type*, routing, play/scene mode) as they are,
    and caps resonance, feedback and envelope ranges.
  - Chaos mode changes everything except locked parameters. One undo step restores all of them.
  - Measured with Surge XT (20 seeds each, 1 s note): 0 silent and 0 clipping results at amounts 50%
    and 75%. At 100%, 3 of 20 came out very quiet.
- **Project:**
  - `t.plugins[]` stores the plugin identity, the state chunk (at most 8 MB), the touched parameter
    values, locks, macros and automation lanes.
  - Loading or undo re-syncs the engine.
  - If the engine crashes, the supervisor restarts it (at most 5 times per minute) and the app
    reloads the plugins from their saved state.

## Security

- **Separate process.** A crashing plugin takes down the engine, not the Auduio window. The window
  notices (`engine://exit`), the engine restarts, and plugins reload from their last saved state.
- **Scanning is out of process too.** Each plugin file is probed by a child process
  (`auduio-engine --scan-one <format> <file> <out.json>`) with a timeout. A file that crashes or
  hangs goes on a block list (`failed`) and is skipped next time. The cache is
  `<app data>/plugin-cache.json`.
- **stdin/stdout only.** The engine opens no network port and no socket; only the app that spawned
  it can talk to it.
- The Tauri relay only forwards **one JSON object per call** (no newlines, at most 16 MB). Engine
  lines are capped too.
- The web app validates `t.plugins` on project import:
  - uid/name lengths are checked
  - state must be base64 and at most 8 MB
  - parameter indices are bounded
  - there are at most 8 plugins per track, 8 macros and 20k automation points
- MIDI accepts channel messages only. SysEx is rejected.
- The engine has no networking code at all.
- Plugins are still native code running with the user's rights, like in every DAW. Only load
  plugins you trust.

## Graceful fallback

`plugins/host.js → pluginSupport()` returns `desktop: true` only inside the Tauri app.
- **Browser (web app):** the Plugins section reads "Desktop app only. Plugins (VST3, CLAP) need the
  Auduio desktop app for Windows, macOS or Linux".
- **Android/iOS (Capacitor):** the same, with a phone-specific message.
- **Phone layout:** the sidebar is hidden.
- A project with plugins opened on the web keeps them. Those tracks show a "needs the desktop app"
  card and play the built-in synth.

## Building

```bash
# engine (any OS; Rust stable)
cargo build --release --manifest-path engine-rs/Cargo.toml
node scripts/place-engine.mjs          # -> src-tauri/binaries/auduio-engine-<triple>[.exe]
npm run tauri build                    # bundles it via tauri.conf.json bundle.externalBin

# tests
DISPLAY=:0 node engine-rs/test/engine-test.mjs       # protocol + a real VST3 (AUDUIO_TEST_VST3_DIR); AUDUIO_TEST_FORMAT=CLAP for CLAP
AUDUIO_ENGINE=engine-rs/target/release/auduio-engine cargo test --manifest-path src-tauri/Cargo.toml --lib sidecar
node ../web-src/tests/e2e-plugins.mjs                  # web UI (Chromium) driving the real engine + Surge XT
```

- **Linux build dependencies:** `libasound2-dev`.
- **Windows:** Rust with the MSVC toolchain (Visual Studio 2022 Build Tools).
- **macOS:** Xcode command-line tools. The workflow builds both architectures and joins them with `lipo`.
- **CI:** `.github/workflows/desktop.yml` builds the engine on windows-latest, macos-latest and
  ubuntu-22.04 before `tauri-action`, then runs a protocol self-test.

## Windows notes (the first target)

- Scanned folders:
  - `C:\Program Files\Common Files\VST3` (the standard folder)
  - `%LOCALAPPDATA%\Programs\Common\VST3` (per-user)
  - plus `AUDUIO_VST3_PATH` (`;`-separated)
- Most commercial synths install their VST3 into the common folder. After Scan they appear under Plugins → Inst.
- The audio device is WASAPI (shared) by default. ASIO needs the Steinberg ASIO SDK licence and is
  not enabled.
- The engine is spawned with `CREATE_NO_WINDOW` (no console flashes).
- Unsigned builds trigger SmartScreen. Sign both `Auduio.exe` and `auduio-engine.exe`.

## Not done yet / known gaps

- **Audio Units (macOS):** not supported, by design. VST3 and CLAP only.
- **Plugin effects on audio tracks** (audio to the engine) and **freeze/bounce in the UI:** the
  engine has `render`, but there's no UI yet.
- **Sidechain inputs, multi-output instruments, plugin latency compensation against Web Audio
  tracks:** the engine reports `latency`, but it isn't compensated yet.
- **Surge XT state restore:** after `state.set`, the sound comes back immediately, but Surge
  publishes the restored values to the host's parameter list lazily, so the card can show old
  numbers until the next change.
- **Verified on Linux (x86_64)** with real VST3 and CLAP plugins, the editor window and the full Tauri app;
  the Windows engine passes the same tests under wine. macOS is compile-checked only. Nothing has run on
  real Windows or Mac hardware yet.

## Licence

Releases ship only the Rust engine (`engine-rs`), whose dependencies are all permissive (MIT / Apache-2.0 /
BSD / ISC / Zlib / Unicode / MPL-2.0 unmodified; cargo-deny gates for `engine-rs` and `src-tauri` in CI). No JUCE
code is used or shipped. The VST 3 SDK is MIT-licensed since version 3.8.0 (the Rust `vst3` crate's bindings are generated
from the 3.8.0 headers). CLAP is MIT. Use of the "VST" name follows Steinberg's rules: the notice "VST is a
trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries" appears in About and the
release notes, and no VST logo is used.
