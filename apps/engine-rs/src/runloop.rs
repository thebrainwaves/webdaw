//! Main-thread services for plugins: timers and file-descriptor watches (VST3 Linux::IRunLoop, CLAP
//! timer-support / posix-fd-support), plus a way for other threads to wake the main loop.
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

pub type TimerCb = Rc<dyn Fn()>;
pub type FdCb = Rc<dyn Fn(i32, u32)>;

struct Timer { owner: u64, key: usize, period: Duration, next: Instant, cb: TimerCb }
struct Fd { owner: u64, key: usize, fd: i32, flags: u32, cb: FdCb }

#[derive(Default)]
struct RunLoop { timers: Vec<Timer>, fds: Vec<Fd> }

thread_local! { static RL: RefCell<RunLoop> = RefCell::new(RunLoop::default()); }

pub fn add_timer(owner: u64, key: usize, ms: u64, cb: TimerCb) {
    let period = Duration::from_millis(ms.clamp(1, 60_000));
    RL.with(|r| {
        let mut r = r.borrow_mut();
        r.timers.retain(|t| !(t.owner == owner && t.key == key));
        r.timers.push(Timer { owner, key, period, next: Instant::now() + period, cb });
    });
}
pub fn remove_timer(owner: u64, key: usize) -> bool {
    RL.with(|r| { let mut r = r.borrow_mut(); let n = r.timers.len(); r.timers.retain(|t| !(t.owner == owner && t.key == key)); n != r.timers.len() })
}
pub fn add_fd(owner: u64, key: usize, fd: i32, flags: u32, cb: FdCb) {
    RL.with(|r| {
        let mut r = r.borrow_mut();
        // one handler may watch several fds (JUCE-built VST3s do): replace only the same (handler, fd) pair
        r.fds.retain(|f| !(f.owner == owner && f.key == key && f.fd == fd));
        r.fds.push(Fd { owner, key, fd, flags, cb });
    });
}
pub fn modify_fd(owner: u64, key: usize, flags: u32) -> bool {
    RL.with(|r| { let mut r = r.borrow_mut(); let mut ok = false; for f in r.fds.iter_mut() { if f.owner == owner && f.key == key { f.flags = flags; ok = true; } } ok })
}
pub fn remove_fd(owner: u64, key: usize) -> bool {
    RL.with(|r| { let mut r = r.borrow_mut(); let n = r.fds.len(); r.fds.retain(|f| !(f.owner == owner && f.key == key)); n != r.fds.len() })
}
pub fn remove_owner(owner: u64) {
    // drop the callbacks outside the borrow (dropping may release COM objects that call back in)
    let (t, f) = RL.with(|r| {
        let mut r = r.borrow_mut();
        let t: Vec<Timer> = { let (a, b): (Vec<_>, Vec<_>) = std::mem::take(&mut r.timers).into_iter().partition(|t| t.owner == owner); r.timers = b; a };
        let f: Vec<Fd> = { let (a, b): (Vec<_>, Vec<_>) = std::mem::take(&mut r.fds).into_iter().partition(|f| f.owner == owner); r.fds = b; a };
        (t, f)
    });
    drop(t); drop(f);
}
pub fn next_deadline() -> Option<Instant> {
    RL.with(|r| r.borrow().timers.iter().map(|t| t.next).min())
}
pub fn run_due_timers() {
    let now = Instant::now();
    let due: Vec<TimerCb> = RL.with(|r| {
        let mut r = r.borrow_mut();
        let mut v = Vec::new();
        for t in r.timers.iter_mut() {
            if t.next <= now {
                v.push(t.cb.clone());
                t.next = now + t.period;
            }
        }
        v
    });
    for cb in due { cb(); }
}
/// (fd, flags) of every watch
pub fn watched_fds() -> Vec<(i32, u32)> { RL.with(|r| r.borrow().fds.iter().map(|f| (f.fd, f.flags)).collect()) }
pub fn dispatch_fd(fd: i32, flags: u32) {
    let cbs: Vec<FdCb> = RL.with(|r| r.borrow().fds.iter().filter(|f| f.fd == fd).map(|f| f.cb.clone()).collect());
    for cb in cbs { cb(fd, flags); }
}

// ---------------------------------------------------------------- waking the main loop
#[cfg(unix)]
mod wake_impl {
    use std::sync::atomic::{AtomicI32, Ordering};
    static FDS: [AtomicI32; 2] = [AtomicI32::new(-1), AtomicI32::new(-1)];
    pub fn init() {
        let mut p = [0i32; 2];
        unsafe {
            if libc::pipe(p.as_mut_ptr()) == 0 {
                for &fd in &p {
                    let fl = libc::fcntl(fd, libc::F_GETFL);
                    libc::fcntl(fd, libc::F_SETFL, fl | libc::O_NONBLOCK);
                    libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                }
                FDS[0].store(p[0], Ordering::SeqCst); FDS[1].store(p[1], Ordering::SeqCst);
            }
        }
    }
    /// async-signal-safe and realtime-safe (a non-blocking write)
    pub fn wake() { let fd = FDS[1].load(Ordering::Relaxed); if fd >= 0 { unsafe { libc::write(fd, b"x".as_ptr() as *const _, 1); } } }
    pub fn read_fd() -> i32 { FDS[0].load(Ordering::Relaxed) }
    pub fn drain() { let fd = read_fd(); let mut b = [0u8; 256]; unsafe { while libc::read(fd, b.as_mut_ptr() as *mut _, b.len()) > 0 {} } }
}
#[cfg(windows)]
mod wake_impl {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};
    static EV: AtomicIsize = AtomicIsize::new(0);
    pub fn init() { unsafe { let h = CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()); EV.store(h as isize, Ordering::SeqCst); } }
    pub fn wake() { let h = EV.load(Ordering::Relaxed); if h != 0 { unsafe { SetEvent(h as _); } } }
    pub fn handle() -> isize { EV.load(Ordering::Relaxed) }
    pub fn drain() {}
}
pub use wake_impl::*;
