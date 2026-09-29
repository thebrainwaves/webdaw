//! Optional realtime-safety instrumentation (cargo feature `rt-alloc-check`, off in release builds):
//! counts Rust heap allocations/frees made inside the live audio callback. Plugins allocate through the C
//! runtime, not through this allocator, so the counters measure exactly the engine's own audio-thread code.
#[cfg(feature = "rt-alloc-check")]
mod imp {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};
    thread_local! { pub static LIVE: Cell<bool> = const { Cell::new(false) }; }
    pub static ALLOCS: AtomicU64 = AtomicU64::new(0);
    pub static FREES: AtomicU64 = AtomicU64::new(0);
    pub static CALLBACKS: AtomicU64 = AtomicU64::new(0);
    fn live() -> bool { LIVE.try_with(|c| c.get()).unwrap_or(false) }
    struct Counting;
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 { if live() { ALLOCS.fetch_add(1, Ordering::Relaxed); } System.alloc(l) }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) { if live() { FREES.fetch_add(1, Ordering::Relaxed); } System.dealloc(p, l) }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 { if live() { ALLOCS.fetch_add(1, Ordering::Relaxed); } System.realloc(p, l, n) }
    }
    #[global_allocator]
    static G: Counting = Counting;
}
pub struct LiveScope;
impl LiveScope {
    #[inline] pub fn enter() -> LiveScope {
        #[cfg(feature = "rt-alloc-check")] { imp::LIVE.with(|c| c.set(true)); imp::CALLBACKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
        LiveScope
    }
}
impl Drop for LiveScope {
    #[inline] fn drop(&mut self) { #[cfg(feature = "rt-alloc-check")] imp::LIVE.with(|c| c.set(false)); }
}
/// (callbacks, allocations, frees) in the live audio callback so far; None when the feature is off
pub fn report() -> Option<(u64, u64, u64)> {
    #[cfg(feature = "rt-alloc-check")] { use std::sync::atomic::Ordering::Relaxed; return Some((imp::CALLBACKS.load(Relaxed), imp::ALLOCS.load(Relaxed), imp::FREES.load(Relaxed))); }
    #[allow(unreachable_code)] None
}
