//! Process supervisor for the native audio engine (auduio-engine, JUCE C++; see ../engine and
//! docs/PLUGIN-HOSTING.md). Pure std: no Tauri types, so it is unit-tested on its own
//! (cargo test) and the Tauri glue in lib.rs stays thin.
//!
//! Protocol: newline-delimited JSON on the child's stdin/stdout. Each stdout line is handed to
//! `on_line` unchanged (the web app parses it); stderr lines go to `on_log`. The supervisor only
//! enforces framing and size limits, restarts the engine if it dies (crashing plugin), and never
//! opens a network port: the engine is reachable only through this pipe.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Largest single message the UI may send (plugin state chunks are base64 inside JSON).
pub const MAX_LINE: usize = 16 * 1024 * 1024;
/// Restart budget: at most this many automatic restarts per minute, then stay down until asked.
const MAX_RESTARTS_PER_MIN: usize = 5;

pub type LineFn = Arc<dyn Fn(String) + Send + Sync>;
pub type ExitFn = Arc<dyn Fn(Option<i32>, bool) + Send + Sync>;

pub struct Sidecar {
    exe: PathBuf,
    env: Vec<(String, String)>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
    generation: Arc<AtomicU32>,
    restarts: Arc<Mutex<Vec<Instant>>>,
    on_line: LineFn,
    on_log: LineFn,
    on_exit: ExitFn,
}

impl Sidecar {
    pub fn new(exe: PathBuf, env: Vec<(String, String)>, on_line: LineFn, on_log: LineFn, on_exit: ExitFn) -> Arc<Self> {
        Arc::new(Sidecar {
            exe,
            env,
            stdin: Arc::new(Mutex::new(None)),
            child: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU32::new(0)),
            restarts: Arc::new(Mutex::new(Vec::new())),
            on_line,
            on_log,
            on_exit,
        })
    }

    pub fn exe(&self) -> &PathBuf { &self.exe }

    pub fn running(&self) -> bool { self.stdin.lock().unwrap().is_some() }

    /// Start the engine if it is not running. Returns Ok(true) if a new process was spawned.
    pub fn ensure_started(self: &Arc<Self>) -> Result<bool, String> {
        if self.running() { return Ok(false); }
        self.stopping.store(false, Ordering::SeqCst);
        self.spawn().map(|_| true)
    }

    fn spawn(self: &Arc<Self>) -> Result<(), String> {
        if !self.exe.is_file() {
            return Err(format!("audio engine not found at {}", self.exe.display()));
        }
        let mut cmd = Command::new(&self.exe);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in &self.env { cmd.env(k, v); }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("could not start audio engine: {e}"))?;
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        *self.stdin.lock().unwrap() = child.stdin.take();
        *self.child.lock().unwrap() = Some(child);

        let on_log = self.on_log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) { on_log(line); }
        });
        let me = self.clone();
        std::thread::spawn(move || {
            let mut rd = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match rd.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if buf.len() > MAX_LINE { (me.on_log)("dropped oversized engine message".into()); continue; }
                        let s = String::from_utf8_lossy(&buf).trim_end().to_string();
                        if !s.is_empty() { (me.on_line)(s); }
                    }
                }
            }
            me.reap(gen);
        });
        Ok(())
    }

    /// stdout closed: the process ended (quit, crash, or killed). Report and maybe restart.
    fn reap(self: &Arc<Self>, gen: u32) {
        if self.generation.load(Ordering::SeqCst) != gen { return; }
        *self.stdin.lock().unwrap() = None;
        let code = self.child.lock().unwrap().take().and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
        let stopping = self.stopping.load(Ordering::SeqCst);
        let will_restart = !stopping && self.allow_restart();
        (self.on_exit)(code, will_restart);
        if will_restart {
            std::thread::sleep(Duration::from_millis(300));
            if !self.stopping.load(Ordering::SeqCst) {
                if let Err(e) = self.spawn() { (self.on_log)(e); }
            }
        }
    }

    fn allow_restart(&self) -> bool {
        let mut r = self.restarts.lock().unwrap();
        let now = Instant::now();
        r.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        if r.len() >= MAX_RESTARTS_PER_MIN { return false; }
        r.push(now);
        true
    }

    /// Send one protocol line (a JSON object). Framing is enforced here so a UI bug can never
    /// inject a second command or an unbounded buffer.
    pub fn send(self: &Arc<Self>, line: &str) -> Result<(), String> {
        let line = line.trim();
        if line.len() > MAX_LINE { return Err("message too large".into()); }
        if line.contains('\n') || line.contains('\r') { return Err("message must be a single line".into()); }
        if !(line.starts_with('{') && line.ends_with('}')) { return Err("message must be a JSON object".into()); }
        self.ensure_started()?;
        let mut g = self.stdin.lock().unwrap();
        let w = g.as_mut().ok_or("audio engine is not running")?;
        w.write_all(line.as_bytes()).and_then(|_| w.write_all(b"\n")).and_then(|_| w.flush())
            .map_err(|e| format!("audio engine pipe closed: {e}"))
    }

    /// Ask the engine to quit, then kill it if it does not exit in time. No restart afterwards.
    pub fn stop(&self, wait: Duration) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(mut w) = self.stdin.lock().unwrap().take() {
            let _ = w.write_all(b"{\"cmd\":\"quit\"}\n");
            let _ = w.flush();
        }
        let deadline = Instant::now() + wait;
        loop {
            let mut g = self.child.lock().unwrap();
            match g.as_mut() {
                None => return,
                Some(c) => match c.try_wait() {
                    Ok(Some(_)) => { *g = None; return; }
                    _ if Instant::now() >= deadline => { let _ = c.kill(); let _ = c.wait(); *g = None; return; }
                    _ => {}
                },
            }
            drop(g);
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Kill without asking (tests / crash simulation). Restart logic applies.
    pub fn kill(&self) {
        if let Some(c) = self.child.lock().unwrap().as_mut() { let _ = c.kill(); }
    }
}

/// Where the bundled engine lives: Tauri copies `externalBin` sidecars next to the app
/// executable without the target-triple suffix. AUDUIO_ENGINE overrides (development).
pub fn default_engine_path() -> PathBuf {
    if let Some(p) = std::env::var_os("AUDUIO_ENGINE") { return PathBuf::from(p); }
    let name = if cfg!(windows) { "auduio-engine.exe" } else { "auduio-engine" };
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(name))).unwrap_or_else(|| PathBuf::from(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn engine() -> Option<PathBuf> {
        std::env::var_os("AUDUIO_ENGINE").map(PathBuf::from).filter(|p| p.is_file())
    }

    #[test]
    fn rejects_bad_framing_without_starting() {
        let s = Sidecar::new(PathBuf::from("/nonexistent/engine"), vec![], Arc::new(|_| {}), Arc::new(|_| {}), Arc::new(|_, _| {}));
        assert!(s.send("{\"a\":1}\n{\"b\":2}").unwrap_err().contains("single line"));
        assert!(s.send("hello").unwrap_err().contains("JSON object"));
        assert!(s.send("{\"cmd\":\"ping\"}").unwrap_err().contains("not found"));
    }

    #[test]
    fn talks_to_the_real_engine_and_restarts_after_a_crash() {
        let Some(exe) = engine() else { eprintln!("AUDUIO_ENGINE not set: skipped"); return; };
        let (tx, rx) = mpsc::channel::<String>();
        let (etx, erx) = mpsc::channel::<(Option<i32>, bool)>();
        let tx = Mutex::new(tx); let etx = Mutex::new(etx);
        let s = Sidecar::new(exe, vec![("AUDUIO_ENGINE_DATA".into(), std::env::temp_dir().join("auduio-sidecar-test").display().to_string())],
            Arc::new(move |l| { let _ = tx.lock().unwrap().send(l); }), Arc::new(|_| {}),
            Arc::new(move |c, r| { let _ = etx.lock().unwrap().send((c, r)); }));
        let wait_for = |needle: &str| -> String {
            let end = Instant::now() + Duration::from_secs(20);
            while Instant::now() < end {
                if let Ok(l) = rx.recv_timeout(Duration::from_millis(200)) { if l.contains(needle) { return l; } }
            }
            panic!("timed out waiting for {needle}");
        };
        s.send("{\"id\":1,\"cmd\":\"ping\"}").unwrap();
        wait_for("\"ready\"");
        let pong = wait_for("\"id\":1");
        assert!(pong.contains("\"ok\":true"), "{pong}");
        s.kill();
        let (_, restarting) = erx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(restarting, "should restart after an unexpected exit");
        wait_for("\"ready\"");
        s.send("{\"id\":2,\"cmd\":\"ping\"}").unwrap();
        assert!(wait_for("\"id\":2").contains("\"ok\":true"));
        s.stop(Duration::from_secs(5));
        let (code, restarting) = erx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(!restarting && code == Some(0), "clean quit, got {code:?}");
        assert!(!s.running());
    }
}
