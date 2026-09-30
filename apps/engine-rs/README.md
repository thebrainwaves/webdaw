# auduio-engine (Rust)

Auduio's native plugin host, shipped on Windows, macOS and Linux. It speaks newline-delimited JSON on stdin/stdout
(protocol 1) and keeps the plugin-cache file, plugin uids and plugin-state format of earlier Auduio versions, so older
projects keep loading. The previous C++ engine has been removed from the repository.

| | |
|---|---|
| Plugin formats | VST3 (Steinberg VST3 SDK interfaces, MIT since SDK 3.8, via the `vst3` crate), CLAP (`clap-sys`) |
| Audio I/O | `cpal`: ALSA on Linux, WASAPI on Windows ("Windows Audio"), CoreAudio on macOS. No ASIO. |
| Scanning | every plugin file is probed in its own child process (`auduio-engine --scan-one`), with a timeout; crashing or hanging plugins land in `failed` and don't affect the engine |
| Realtime | the audio callback takes no locks and makes no allocations: the graph is swapped through an SPSC ring (`rtrb`), old graphs and unloaded plugins are freed on the main thread, and MIDI, parameters and meters go through preallocated rings and atomics. Build with `--features rt-alloc-check` to count heap allocations inside the callback (0 in the tests). |
| Editors | Linux X11 (`x11rb`, with the VST3 `IRunLoop` and CLAP timer/fd support), Windows Win32, macOS AppKit `NSWindow` (content `NSView` handed to VST3 `kPlatformTypeNSView` / CLAP `cocoa`; Objective-C runtime calls, no extra crates) |
| MIDI in | Commands `midiin.list`, `midiin.open {port}`, `midiin.close`; `{"event":"midiin"}` events. Channel messages only, max 16 ports, 2000 msgs/s per port. `AUDUIO_MIDI_TEST_SOURCE=1` adds a test port fed by `midiin.inject`. |
| MIDI out | `midir`: ALSA sequencer on Linux, CoreMIDI on macOS, WinMM on Windows. Commands `midiout.list`, `midiout.send {port, events:[{d:[bytes], dt:seconds}]}`, `midiout.allOff`, `midiout.close`; a sender thread plays events at their deadlines. Channel messages only (no SysEx or system messages), max 4096 events per call, 10 s ahead, 65536 queued. For the desktop app on macOS/Linux, whose webviews have no Web MIDI. `AUDUIO_MIDI_TEST_SINK=<file>` adds a logging test port. |
| Licences | `cargo deny check licenses` (see `deny.toml`) allows only MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0 and MPL-2.0 |

## Build and test

```sh
cargo build --release                                  # -> target/release/auduio-engine
cargo test --release                                   # unit tests (plugin ids, base64, state blob)
cargo deny check licenses                              # licence gate (cargo install cargo-deny)
node ../scripts/place-engine.mjs                       # copy into src-tauri/binaries for the desktop app

# protocol + real plugin tests (default test plugin: the free Surge XT, not bundled):
AUDUIO_ENGINE=$PWD/target/release/auduio-engine DISPLAY=:0 node test/engine-test.mjs
AUDUIO_ENGINE=$PWD/target/release/auduio-engine AUDUIO_TEST_FORMAT=CLAP AUDUIO_TEST_CLAP_DIR=/path/to/clap DISPLAY=:0 node test/engine-test.mjs

# Windows build tested on Linux under wine (apt install gcc-mingw-w64-x86-64 wine64), with Windows Surge XT:
cargo build --release --target x86_64-pc-windows-gnu
printf '#!/bin/sh\nexec wine %s/target/x86_64-pc-windows-gnu/release/auduio-engine.exe "$@"\n' "$PWD" > /tmp/wine-engine.sh && chmod +x /tmp/wine-engine.sh
AUDUIO_TEST_WINE=1 AUDUIO_ENGINE=/tmp/wine-engine.sh AUDUIO_TEST_VST3_DIR=/path/to/win/vst3 DISPLAY=:0 node test/engine-test.mjs
```

Environment variables: `AUDUIO_ENGINE_DATA` (cache folder), `AUDUIO_VST3_PATH` / `AUDUIO_CLAP_PATH` (extra search
folders, separated by `:`, or `;` on Windows), `CLAP_PATH` (the standard CLAP one).

## Source map

- `main.rs`: arguments, stdin reader thread, main loop (poll on stdin wake-up, X11 and plugin fds, timers)
- `engine.rs`: the protocol commands 
- `audio.rs`: cpal device, realtime graph, track mixing (linear balance pan, 0 dB at centre), offline render
- `vst3host.rs`, `claphost.rs`: format hosts (scan, instance, params, MIDI, state, editor)
- `scanner.rs`: out-of-process scanning and the cache. `util.rs`: plugin uids, base64 and state blob (format compatible with earlier Auduio versions)
- `runloop.rs`: main-thread timers and fd watches for plugins. `window.rs`: editor windows. `rtcheck.rs`: allocation counter
- `midiout.rs`: hardware MIDI output (scheduler thread, message validation, test sink). `midiin.rs`: hardware MIDI input

## Not done yet

- Audio Units (macOS) are not supported, by design: VST3 and CLAP only on every platform
- macOS is compile-checked only (`cargo check --target aarch64-apple-darwin / x86_64-apple-darwin`); the NSView editor
  windows and CoreMIDI output haven't run on a real Mac yet
- Windows: the MinGW build passes the full engine test (VST3 + CLAP, Win32 editor) and e2e-plugins under wine; the
  MSVC build the CI ships is compile-checked here and self-tested in CI. Not yet run on real Windows hardware
- VST3 `kIoChanged` / latency-change restarts and CLAP `request_restart` are acknowledged but don't rebuild buses yet
- Sidechain inputs aren't fed (main bus only)
- MIDI input through the engine is tested with the test source only (no hardware MIDI device in the test box)
