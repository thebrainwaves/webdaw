//! Auduio desktop shell: a native window around the bundled Auduio web app (../web).
//! Most audio work happens in the web app (Web Audio). Tracks that use VST3/AU plugins run in
//! the native audio engine sidecar (auduio-engine, see sidecar.rs and docs/PLUGIN-HOSTING.md);
//! this shell supervises that process and relays its newline-delimited JSON protocol:
//!   invoke("engine_send", { line })  -> one command to the engine (started on first use)
//!   event  "engine://msg"             <- every line the engine prints (replies and events)
//!   event  "engine://exit"            <- { code, restarting } when the engine process ends
//!   invoke("engine_status")           -> { running, path, found }

#[cfg(desktop)]
pub mod sidecar;

#[cfg(desktop)]
mod engine_bridge {
    use crate::sidecar::{default_engine_path, Sidecar};
    use std::sync::Arc;
    use tauri::{AppHandle, Emitter, Manager, State};

    pub struct Engine(pub Arc<Sidecar>);

    pub fn init(app: &AppHandle) {
        let (a1, a2, a3) = (app.clone(), app.clone(), app.clone());
        let mut env = vec![];
        if let Ok(dir) = app.path().app_data_dir() {
            env.push(("AUDUIO_ENGINE_DATA".to_string(), dir.display().to_string()));
        }
        let sc = Sidecar::new(
            default_engine_path(),
            env,
            Arc::new(move |line| { let _ = a1.emit("engine://msg", line); }),
            Arc::new(move |line| { let _ = a2.emit("engine://log", line); }),
            Arc::new(move |code, restarting| {
                let _ = a3.emit("engine://exit", serde_json::json!({ "code": code, "restarting": restarting }));
            }),
        );
        app.manage(Engine(sc));
    }

    #[tauri::command]
    pub fn engine_send(line: String, engine: State<'_, Engine>) -> Result<(), String> {
        engine.0.send(&line)
    }

    #[tauri::command]
    pub fn engine_status(engine: State<'_, Engine>) -> serde_json::Value {
        let p = engine.0.exe();
        serde_json::json!({ "running": engine.0.running(), "path": p.display().to_string(), "found": p.is_file() })
    }

    #[tauri::command]
    pub fn engine_restart(engine: State<'_, Engine>) -> Result<bool, String> {
        engine.0.stop(std::time::Duration::from_secs(3));
        engine.0.ensure_started()
    }

    pub fn shutdown(app: &AppHandle) {
        if let Some(e) = app.try_state::<Engine>() { e.0.stop(std::time::Duration::from_secs(3)); }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().setup(|app| {
        use tauri::Manager;
        if let Some(win) = app.get_webview_window("main") {
            enable_media(&win);
        }
        #[cfg(desktop)]
        engine_bridge::init(app.handle());
        Ok(())
    });
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        engine_bridge::engine_send,
        engine_bridge::engine_status,
        engine_bridge::engine_restart
    ]);
    let app = builder.build(tauri::generate_context!()).expect("error while building Auduio");
    app.run(|_handle, _event| {
        #[cfg(desktop)]
        if let tauri::RunEvent::Exit = _event {
            engine_bridge::shutdown(_handle);
        }
    });
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
