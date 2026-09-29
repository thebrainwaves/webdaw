//! Plugin scanning. Every plugin file is probed in its own child process ("auduio-engine --scan-one ..."),
//! so a plugin that crashes or hangs while loading cannot take down the engine (or the app). Crashing /
//! hanging files are remembered in a block list and skipped until the user asks for a full rescan.
use crate::protocol::{emit, log, PROTOCOL_VERSION};
use crate::util::{data_dir, mtime_ms};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const FORMATS: [&str; 2] = ["VST3", "CLAP"];

#[derive(Default)]
struct State { plugins: Vec<Value>, failed: Vec<Value>, paths: Vec<String> }

pub struct Scanner { st: Arc<Mutex<State>>, running: Arc<AtomicBool>, cancel: Arc<AtomicBool> }

fn home() -> String { std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default() }
fn expand(p: &str) -> PathBuf { if let Some(r) = p.strip_prefix('~') { PathBuf::from(format!("{}{}", home(), r)) } else { PathBuf::from(p) } }
fn sep() -> char { if cfg!(windows) { ';' } else { ':' } }

pub fn default_paths(format: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    match format {
        "VST3" => {
            #[cfg(all(unix, not(target_os = "macos")))]
            out.extend(["~/.vst3/", "/usr/lib/vst3/", "/usr/local/lib/vst3/"].map(String::from));
            #[cfg(target_os = "macos")]
            out.extend(["~/Library/Audio/Plug-Ins/VST3", "/Library/Audio/Plug-Ins/VST3"].map(String::from));
            #[cfg(windows)]
            {
                let common = std::env::var("CommonProgramFiles").unwrap_or_else(|_| "C:\\Program Files\\Common Files".into());
                out.push(format!("{common}\\VST3"));
                if let Ok(l) = std::env::var("LOCALAPPDATA") { out.push(format!("{l}\\Programs\\Common\\VST3")); }
            }
        }
        _ => {
            #[cfg(all(unix, not(target_os = "macos")))]
            out.extend(["~/.clap/", "/usr/lib/clap/", "/usr/local/lib/clap/"].map(String::from));
            #[cfg(target_os = "macos")]
            out.extend(["~/Library/Audio/Plug-Ins/CLAP", "/Library/Audio/Plug-Ins/CLAP"].map(String::from));
            #[cfg(windows)]
            {
                let common = std::env::var("CommonProgramFiles").unwrap_or_else(|_| "C:\\Program Files\\Common Files".into());
                out.push(format!("{common}\\CLAP"));
                if let Ok(l) = std::env::var("LOCALAPPDATA") { out.push(format!("{l}\\Programs\\Common\\CLAP")); }
            }
            if let Ok(cp) = std::env::var("CLAP_PATH") { out.extend(cp.split(sep()).filter(|s| !s.is_empty()).map(String::from)); }
        }
    }
    if let Ok(e) = std::env::var(format!("AUDUIO_{format}_PATH")) { out.extend(e.split(sep()).filter(|s| !s.is_empty()).map(String::from)); }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

pub fn format_for_file(p: &Path) -> &'static str {
    if p.extension().map(|e| e.eq_ignore_ascii_case("clap")).unwrap_or(false) { "CLAP" } else { "VST3" }
}
fn find_files(dir: &Path, ext: &str, out: &mut Vec<PathBuf>, depth: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
    entries.sort();
    for p in entries {
        let is_plugin = p.extension().map(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(false);
        if is_plugin { out.push(p); } else if p.is_dir() && depth < 8 { find_files(&p, ext, out, depth + 1); }
    }
}

impl Scanner {
    pub fn new() -> Scanner { let s = Scanner { st: Arc::new(Mutex::new(State::default())), running: Arc::new(AtomicBool::new(false)), cancel: Arc::new(AtomicBool::new(false)) }; s.load_cache(); s }
    fn load_cache(&self) {
        let j: Value = std::fs::read_to_string(data_dir().join("plugin-cache.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let mut st = self.st.lock().unwrap();
        st.plugins = j["plugins"].as_array().cloned().unwrap_or_default();
        st.failed = j["failed"].as_array().cloned().unwrap_or_default();
    }
    pub fn is_scanning(&self) -> bool { self.running.load(Ordering::SeqCst) }
    pub fn cancel(&self) { self.cancel.store(true, Ordering::SeqCst); }
    pub fn as_json(&self) -> Value { cache_json(&self.st, self.is_scanning()) }
    pub fn find(&self, uid: &str) -> Option<Value> { self.st.lock().unwrap().plugins.iter().find(|p| p["uid"].as_str() == Some(uid)).cloned() }
    pub fn start(&self, extra: Vec<String>, rescan: bool, timeout_ms: u64) -> bool {
        if self.running.swap(true, Ordering::SeqCst) { return false; }
        self.cancel.store(false, Ordering::SeqCst);
        let (st, running, cancel) = (self.st.clone(), self.running.clone(), self.cancel.clone());
        let timeout = Duration::from_millis(timeout_ms.clamp(2000, 300_000));
        std::thread::spawn(move || { run(&st, &cancel, extra, rescan, timeout); running.store(false, Ordering::SeqCst); emit_done(&st, &cancel); });
        true
    }
}

fn cache_json(st: &Mutex<State>, scanning: bool) -> Value {
    let s = st.lock().unwrap();
    json!({ "plugins": s.plugins, "failed": s.failed, "paths": s.paths, "scanning": scanning })
}
fn emit_done(st: &Mutex<State>, cancel: &AtomicBool) {
    let mut v = cache_json(st, false);
    v["cancelled"] = json!(cancel.load(Ordering::SeqCst));
    emit("scan.done", v.as_object().cloned());
}

fn run(st: &Mutex<State>, cancel: &AtomicBool, extra: Vec<String>, rescan: bool, timeout: Duration) {
    let mut jobs: Vec<(&str, PathBuf)> = vec![];
    let mut all_paths: Vec<String> = vec![];
    for f in FORMATS {
        let mut dirs = default_paths(f);
        dirs.extend(extra.iter().cloned());
        for d in &dirs { if !all_paths.contains(d) { all_paths.push(d.clone()); } }
        let ext = if f == "CLAP" { "clap" } else { "vst3" };
        let mut files = vec![];
        for d in &dirs { let p = expand(d); if p.is_absolute() && p.is_dir() { find_files(&p, ext, &mut files, 0); } }
        let mut seen = std::collections::HashSet::new();
        for p in files { if seen.insert(p.clone()) { jobs.push((f, p)); } }
    }
    let (old_plugins, old_failed) = { let mut s = st.lock().unwrap(); s.paths = all_paths; (s.plugins.clone(), s.failed.clone()) };
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("auduio-engine"));
    let (mut new_plugins, mut new_failed) = (vec![], vec![]);
    let total = jobs.len();
    for (done, (format, file)) in jobs.into_iter().enumerate() {
        if cancel.load(Ordering::SeqCst) { break; }
        let fs = file.to_string_lossy().into_owned();
        emit("scan.progress", json!({ "done": done, "total": total, "current": fs }).as_object().cloned());
        let modified = mtime_ms(&file);
        if !rescan {
            let reused: Vec<Value> = old_plugins.iter().filter(|p| p["file"].as_str() == Some(fs.as_str()) && p["modified"].as_i64() == Some(modified) && p["format"].as_str() == Some(format)).cloned().collect();
            if !reused.is_empty() { new_plugins.extend(reused); continue; }
            let blocked: Vec<Value> = old_failed.iter().filter(|p| p["file"].as_str() == Some(fs.as_str()) && p["modified"].as_i64() == Some(modified)).cloned().collect();
            if !blocked.is_empty() { new_failed.extend(blocked); continue; }
        }
        let out = std::env::temp_dir().join(format!("auduio-scan-{}-{done}.json", std::process::id()));
        let _ = std::fs::remove_file(&out);
        let mut reason = String::new();
        match std::process::Command::new(&exe).arg("--scan-one").arg(format).arg(&file).arg(&out)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::inherit()).spawn() {
            Err(_) => reason = "could not start scanner process".into(),
            Ok(mut child) => {
                let t0 = Instant::now();
                let code = loop {
                    match child.try_wait() {
                        Ok(Some(s)) => break Some(s),
                        Ok(None) if t0.elapsed() > timeout || cancel.load(Ordering::SeqCst) => { let _ = child.kill(); let _ = child.wait(); break None; }
                        Ok(None) => std::thread::sleep(Duration::from_millis(15)),
                        Err(_) => break None,
                    }
                };
                match code {
                    None => reason = "timed out (plugin hangs while loading)".into(),
                    Some(s) => {
                        let res: Value = std::fs::read_to_string(&out).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
                        match res.as_array() {
                            Some(a) if !a.is_empty() => for d in a { let mut d = d.clone(); d["modified"] = json!(modified); new_plugins.push(d); },
                            _ => reason = if s.code() == Some(2) { "no plugin found in file".into() } else { format!("crashed while loading (exit code {})", s.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into())) },
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&out);
        if !reason.is_empty() {
            log(&format!("scan failed: {fs}: {reason}"));
            new_failed.push(json!({ "file": fs, "format": format, "reason": reason, "modified": modified }));
        }
    }
    { let mut s = st.lock().unwrap(); s.plugins = new_plugins; s.failed = new_failed; }
    let s = st.lock().unwrap();
    let _ = std::fs::write(data_dir().join("plugin-cache.json"), serde_json::to_string(&json!({ "plugins": s.plugins, "failed": s.failed, "version": PROTOCOL_VERSION })).unwrap_or_default());
}

/// child mode: probe one file, write a JSON array of descriptions to `out`. Returns the exit code.
pub fn scan_one_main(format: &str, file: &str, out: &str) -> i32 {
    let p = Path::new(file);
    let res = match format { "VST3" => crate::vst3host::scan_file(p), "CLAP" => crate::claphost::scan_file(p), _ => return 3 };
    match res {
        Ok(list) => { let _ = std::fs::write(out, serde_json::to_string(&list).unwrap_or_default()); if list.is_empty() { 2 } else { 0 } }
        Err(e) => { log(&format!("{file}: {e}")); let _ = std::fs::write(out, "[]"); 2 }
    }
}
