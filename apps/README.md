# Auduio desktop and mobile apps

These are native shells around the Auduio web app (formerly WebDAW), which runs unchanged inside each one:
- **Desktop (Tauri 2):** macOS, Windows and Linux.
- **Mobile (Capacitor 8):** Android and iOS.

The shells add a real window or app icon, installers, and microphone access. The service worker is skipped inside the shells, because the files are bundled.

## Web app
`node scripts/sync-web.mjs <web source dir>` builds the web app and copies its `dist/` into `./web`. The default source dir is `../daw`, or `$AUDUIO_SRC`. On the app-source branch it is `../web-src`.

## Desktop
Requirements: Node 20 or newer, Rust stable, and the prerequisites from https://tauri.app/start/prerequisites/.
On Debian/Ubuntu: `libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.

```sh
npm install
node scripts/sync-web.mjs ../daw
cargo build --release --manifest-path engine-rs/Cargo.toml
node scripts/place-engine.mjs                # native plugin engine -> src-tauri/binaries/ (required by externalBin)
npx tauri build                              # installers go to src-tauri/target/release/bundle/
npx tauri build --bundles deb                # Linux: .deb only (no AppImage)
scripts/smoke-linux.sh                       # headless launch test (Xvfb): screenshots + page console
```

VST3 / CLAP plugins: the desktop app ships a native audio engine sidecar (`engine-rs/`, Rust) that hosts plugins
in a separate process, on Windows, macOS and Linux (no Audio Units). Protocol, routing, security and build notes:
[docs/PLUGIN-HOSTING.md](docs/PLUGIN-HOSTING.md) and [engine-rs/README.md](engine-rs/README.md). On Linux the engine
needs `libasound2-dev`. Licence gates: `cargo deny check licenses` in `engine-rs/` and `src-tauri/`. Third-party notices: `node scripts/gen-notices.mjs` (CI runs it on every build).

Microphone access by platform:
- **macOS:** `NSMicrophoneUsageDescription` in `src-tauri/Info.plist`, plus the audio-input entitlement in `entitlements.plist`.
- **Windows:** WebView2 shows its own prompt.
- **Linux:** `src-tauri/src/lib.rs` turns on WebKitGTK media streams and grants audio-capture requests.

## Android
Requirements: Node 22 or newer (Capacitor 8), JDK 21 and the Android SDK (platform 36, build-tools 35 and 36).

```sh
npm install
node scripts/sync-web.mjs ../daw && npx cap sync android
cd android && ./gradlew assembleDebug        # -> android/app/build/outputs/apk/debug/app-debug.apk
```

What the Android shell adds:
- **Permissions:** `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`. Capacitor's WebChromeClient asks for the runtime permission when the page calls getUserMedia, then grants the WebView request.
- **`MainActivity`:** allows media playback without a user gesture, routes the volume keys to media volume, and keeps the screen on while the app is in front. Android pauses the WebView, and with it a running recording, when the screen goes off.
- **Orientation:** portrait and landscape.
- **Icons and splash:** generated from `daw/src/icons`.

Sideloading steps for users are in `INSTALL-ANDROID.md`. Debug APKs are signed with the build machine's debug key (`~/.android/debug.keystore`). An update installs over an existing app only if it is signed with the same key, so for real distribution create a release keystore (see the comments in `.github/workflows/android.yml`).

## iOS (prepared, not built here)
The `ios/` project has:
- `NSMicrophoneUsageDescription`
- `UIBackgroundModes: audio`, so a recording keeps going when the screen locks
- portrait and landscape orientations
- the app icon and splash

To build on a Mac with Xcode 16 or newer: `npx cap sync ios && npx cap open ios`. Then set your Team under Signing & Capabilities and run on a device.

## CI
- `.github/workflows/desktop.yml` builds a macOS universal .dmg, a Windows .msi and NSIS .exe, and a Linux .deb (no AppImage).
- `.github/workflows/android.yml` builds a debug APK.
- On a `v*` tag, both attach their files to a draft GitHub Release.
- Signing secrets are commented-out placeholders.
