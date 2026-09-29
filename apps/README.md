# WebDAW desktop app (Tauri 2)

This is a native desktop shell around the WebDAW web app for macOS, Windows and Linux. The app itself is the unchanged web build. The shell adds a real window, a dock/taskbar icon, installers, and microphone access.

## Build locally
Requirements: Node 20 or newer, Rust stable, and the platform prerequisites from https://tauri.app/start/prerequisites/.
On Debian/Ubuntu: `libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.

```sh
npm install
node scripts/sync-web.mjs ../daw   # builds the web app and copies dist/ to ./web
npx tauri build                    # installers go to src-tauri/target/release/bundle/
npx tauri dev                      # run it in a window without packaging
```

Linux only: `npx tauri build --bundles deb,appimage`. `scripts/smoke-linux.sh` launches the build on a virtual display, saves screenshots and captures the page console (`WEBDAW_CONSOLE=1`).

## Microphone
- **macOS:** `Info.plist` has `NSMicrophoneUsageDescription`, and `entitlements.plist` has `com.apple.security.device.audio-input`. macOS asks for permission the first time you record.
- **Windows:** WebView2 shows its own permission prompt.
- **Linux (WebKitGTK):** `src/lib.rs` turns on media streams and grants audio-capture and device-info permission requests. Audio goes through GStreamer and PulseAudio/PipeWire. The AppImage bundles the GStreamer plugins.

## CI and releases
`.github/workflows/desktop.yml` builds a universal macOS .dmg, a Windows .msi and NSIS .exe, and a Linux .deb and .AppImage. When you push a `v*` tag it drafts a GitHub Release with the installers attached. Signing and notarization secrets are commented-out placeholders.

## Install
- **macOS:** open the .dmg and drag WebDAW to Applications. Unsigned builds need right-click, then Open, the first time.
- **Windows:** run `WebDAW_x.y.z_x64-setup.exe` or the `.msi`. If SmartScreen warns about an unsigned build, choose More info, then Run anyway.
- **Linux:** run `sudo apt install ./WebDAW_0.3.1_amd64.deb`, or `chmod +x WebDAW_0.3.1_amd64.AppImage && ./WebDAW_0.3.1_amd64.AppImage`.
