//! Auduio desktop shell: a native window around the bundled Auduio web app (../web).
//! All audio work happens in the web app (Web Audio). The shell only has to make sure
//! the webview is allowed to use the microphone / audio interface inputs.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                enable_media(&win);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Auduio");
}

/// Linux (WebKitGTK): media capture is off by default and permission requests are denied
/// unless handled. Turn on getUserMedia/enumerateDevices and grant audio capture requests
/// (the app only ever asks for audio). Auduio is a local app with no remote content.
#[cfg(target_os = "linux")]
fn enable_media(win: &tauri::WebviewWindow) {
    let _ = win.with_webview(|wv| {
        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
        let view = wv.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_enable_webaudio(true);
            settings.set_media_playback_requires_user_gesture(false);
            // AUDUIO_CONSOLE=1 prints the web app's console messages to stdout (diagnostics).
            if std::env::var_os("AUDUIO_CONSOLE").is_some() {
                settings.set_enable_write_console_messages_to_stdout(true);
            }
        }
        view.connect_permission_request(|_view, req| {
            use webkit2gtk::glib::ObjectExt;
            if req.is::<webkit2gtk::UserMediaPermissionRequest>()
                || req.is::<webkit2gtk::DeviceInfoPermissionRequest>()
            {
                req.allow();
                return true;
            }
            false
        });
    });
}

/// macOS (WKWebView) asks the user via the system prompt using NSMicrophoneUsageDescription
/// from Info.plist; Windows (WebView2) shows its own permission prompt. Nothing to do here.
#[cfg(not(target_os = "linux"))]
fn enable_media(_win: &tauri::WebviewWindow) {}
