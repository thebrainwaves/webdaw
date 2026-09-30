//! auduio-engine: hosts VST3 and CLAP plugins for the Auduio desktop app and talks to it over
//! stdin/stdout with newline-delimited JSON (protocol 1, compatible with projects saved by earlier Auduio versions).
//!   auduio-engine                      protocol server on stdin/stdout (spawned by the Auduio desktop app)
//!   auduio-engine --scan-one F P OUT   probe one plugin file in isolation (spawned by the scanner)
//!   auduio-engine --version
#[macro_use]
mod protocol;
mod audio;
mod claphost;
mod engine;
mod midiin;
mod midiout;
mod plugin;
mod rtcheck;
mod runloop;
mod scanner;
mod util;
mod vst3host;
mod wav;
mod window;

use std::io::BufRead;
use std::sync::mpsc;
use std::time::{Duration, Instant};

enum Input { Line(String), Eof }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let _ = plugin::MAIN_THREAD.set(std::thread::current().id());
    if args.iter().any(|a| a == "--version") { println!("auduio-engine {} (auduio-rs: VST3 + CLAP)", engine::VERSION); return; }
    if let Some(k) = args.iter().position(|a| a == "--scan-one") {
        let code = if args.len() >= k + 4 { scanner::scan_one_main(&args[k + 1], &args[k + 2], &args[k + 3]) } else { 4 };
        std::process::exit(code);
    }
    runloop::init();
    let (tx, rx) = mpsc::channel::<Input>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut lock = stdin.lock();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match lock.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if buf.len() > protocol::MAX_LINE_BYTES { protocol::log("dropped oversized line"); continue; }
                    let s = String::from_utf8_lossy(&buf).trim().to_string();
                    if s.is_empty() { continue; }
                    if tx.send(Input::Line(s)).is_err() { break; }
                    runloop::wake();
                }
            }
        }
        // parent closed the pipe (app quit or crashed): do not linger
        let _ = tx.send(Input::Eof);
        runloop::wake();
    });

    let mut eng = engine::Engine::new();
    let hello = eng.handle("hello", &serde_json::Value::Null).unwrap_or_default();
    protocol::emit("ready", hello.as_object().cloned());
    let mut next_tick = Instant::now() + Duration::from_millis(50);
    loop {
        let mut deadline = next_tick;
        if let Some(t) = runloop::next_deadline() { if t < deadline { deadline = t; } }
        wait_until(deadline);
        runloop::drain();
        loop {
            match rx.try_recv() {
                Ok(Input::Line(l)) => { eng.dispatch(&l); if eng.quit { break; } }
                Ok(Input::Eof) => { eng.quit = true; break; }
                Err(_) => break,
            }
        }
        if eng.quit { break; }
        eng.window_events();
        runloop::run_due_timers();
        eng.idle();
        if Instant::now() >= next_tick { eng.timer(); next_tick = Instant::now() + Duration::from_millis(50); }
    }
    eng.shutdown();
    // the stdin reader thread may be blocked in read(); exit without waiting for it
    std::process::exit(0);
}

#[cfg(unix)]
fn wait_until(deadline: Instant) {
    let now = Instant::now();
    let ms = if deadline > now { (deadline - now).as_millis().min(1000) as i32 } else { 0 };
    #[cfg(target_os = "macos")]
    let ms = ms.min(10); // plus the CFRunLoop below
    let mut fds = vec![libc::pollfd { fd: runloop::read_fd(), events: libc::POLLIN, revents: 0 }];
    if let Some(x) = window::fd() { fds.push(libc::pollfd { fd: x, events: libc::POLLIN, revents: 0 }); }
    let watched = runloop::watched_fds();
    for &(fd, fl) in &watched {
        let mut ev = 0; if fl & 1 != 0 { ev |= libc::POLLIN; } if fl & 2 != 0 { ev |= libc::POLLOUT; } if ev == 0 { ev = libc::POLLIN; }
        fds.push(libc::pollfd { fd, events: ev, revents: 0 });
    }
    let x_count = fds.len() - watched.len();
    unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, ms); }
    for p in &fds[x_count..] {
        if p.revents != 0 {
            let mut fl = 0u32; if p.revents & libc::POLLIN != 0 { fl |= 1; } if p.revents & libc::POLLOUT != 0 { fl |= 2; } if p.revents & (libc::POLLERR | libc::POLLHUP) != 0 { fl |= 4; }
            runloop::dispatch_fd(p.fd, fl);
        }
    }
    #[cfg(target_os = "macos")]
    unsafe { mac_runloop::run_once(); }
}
#[cfg(target_os = "macos")]
mod mac_runloop {
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" { static kCFRunLoopDefaultMode: *const c_void; fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, ret: u8) -> i32; }
    /// services main-run-loop sources and timers (plugins post work there)
    pub unsafe fn run_once() { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, 1); }
}
#[cfg(windows)]
fn wait_until(deadline: Instant) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MsgWaitForMultipleObjects, QS_ALLINPUT};
    let now = Instant::now();
    let ms = if deadline > now { (deadline - now).as_millis().min(1000) as u32 } else { 0 };
    let h = runloop::handle() as windows_sys::Win32::Foundation::HANDLE;
    unsafe { MsgWaitForMultipleObjects(1, &h, 0, ms, QS_ALLINPUT); }
}
