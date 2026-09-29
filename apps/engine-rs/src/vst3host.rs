//! VST3 hosting on the Steinberg VST 3 API (MIT licensed since VST SDK 3.8) through the `vst3` crate's
//! generated bindings (MIT OR Apache-2.0). No SDK sources are compiled in: the host side COM classes
//! (host context, streams, messages, parameter queues, event lists, plug frame and Linux run loop)
//! are implemented here.
use crate::plugin::*;
use crate::util::*;
use crate::{runloop, window};
use serde_json::{json, Value};
use std::cell::UnsafeCell;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
#[cfg(all(unix, not(target_os = "macos")))]
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{Class, ComPtr, ComRef, ComWrapper, Interface};

const AUDIO_MODULE_CLASS: &str = "Audio Module Class";

fn guid_eq(t: *const TUID, g: &[u8; 16]) -> bool {
    if t.is_null() { return false; }
    unsafe { std::slice::from_raw_parts(t as *const u8, 16) == g }
}
fn copy_to_string128(s: &str, dst: &mut String128) {
    let mut n = 0;
    for (d, c) in dst.iter_mut().zip(s.encode_utf16()) { *d = c as TChar; n += 1; if n >= 127 { break; } }
    dst[n.min(127)] = 0;
}
fn s128(s: &String128) -> String { let v: Vec<u16> = s.iter().map(|&c| c as u16).collect(); utf16_to_string(&v) }

// ================================================================ module (shared library) cache
pub struct Module {
    factory: std::mem::ManuallyDrop<ComPtr<IPluginFactory>>,
    lib: std::mem::ManuallyDrop<libloading::Library>,
    #[cfg(target_os = "macos")]
    bundle: *const c_void,
    pub path: PathBuf,
}
unsafe impl Send for Module {}
unsafe impl Sync for Module {}
impl Drop for Module {
    fn drop(&mut self) {
        unsafe {
            std::mem::ManuallyDrop::drop(&mut self.factory);
            #[cfg(all(unix, not(target_os = "macos")))]
            if let Ok(f) = self.lib.get::<unsafe extern "C" fn() -> bool>(b"ModuleExit\0") { f(); }
            #[cfg(windows)]
            if let Ok(f) = self.lib.get::<unsafe extern "system" fn() -> bool>(b"ExitDll\0") { f(); }
            #[cfg(target_os = "macos")]
            {
                if let Ok(f) = self.lib.get::<unsafe extern "C" fn() -> bool>(b"bundleExit\0") { f(); }
                if !self.bundle.is_null() { mac::CFRelease(self.bundle); }
            }
            std::mem::ManuallyDrop::drop(&mut self.lib);
        }
    }
}
#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFURLCreateFromFileSystemRepresentation(a: *const c_void, buf: *const u8, len: isize, dir: u8) -> *const c_void;
        pub fn CFBundleCreate(a: *const c_void, url: *const c_void) -> *const c_void;
        pub fn CFRelease(p: *const c_void);
    }
}

fn binary_in_bundle(bundle: &Path) -> PathBuf {
    if bundle.is_file() { return bundle.to_path_buf(); }
    let stem = bundle.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    #[cfg(all(unix, not(target_os = "macos")))]
    { bundle.join("Contents").join(format!("{}-linux", std::env::consts::ARCH)).join(format!("{stem}.so")) }
    #[cfg(windows)]
    {
        let arch = if cfg!(target_arch = "aarch64") { "arm64-win" } else { "x86_64-win" };
        let p = bundle.join("Contents").join(arch).join(format!("{stem}.vst3"));
        if !p.exists() && cfg!(target_arch = "aarch64") { return bundle.join("Contents").join("arm64x-win").join(format!("{stem}.vst3")); }
        p
    }
    #[cfg(target_os = "macos")]
    {
        let p = bundle.join("Contents").join("MacOS").join(&stem);
        if p.exists() { return p; }
        std::fs::read_dir(bundle.join("Contents").join("MacOS")).ok().and_then(|mut d| d.next()).and_then(|e| e.ok()).map(|e| e.path()).unwrap_or(p)
    }
}

static MODULES: OnceLock<Mutex<HashMap<PathBuf, Weak<Module>>>> = OnceLock::new();

pub fn load_module(bundle: &Path) -> Result<Arc<Module>, String> {
    let map = MODULES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut m = map.lock().unwrap();
    if let Some(w) = m.get(bundle) { if let Some(a) = w.upgrade() { return Ok(a); } }
    let bin = binary_in_bundle(bundle);
    if !bin.exists() { return Err(format!("no plugin binary for this platform in {}", bundle.display())); }
    unsafe {
        #[cfg(all(unix, not(target_os = "macos")))]
        let lib: libloading::Library = {
            let l = libloading::os::unix::Library::open(Some(&bin), libc::RTLD_LAZY | libc::RTLD_LOCAL).map_err(|e| format!("cannot load {}: {e}", bin.display()))?;
            let handle = l.into_raw();
            let l = libloading::os::unix::Library::from_raw(handle);
            if let Ok(f) = l.get::<unsafe extern "C" fn(*mut c_void) -> bool>(b"ModuleEntry\0") {
                if !f(handle) { return Err("ModuleEntry failed".into()); }
            }
            l.into()
        };
        #[cfg(windows)]
        let lib: libloading::Library = {
            let l = libloading::Library::new(&bin).map_err(|e| format!("cannot load {}: {e}", bin.display()))?;
            if let Ok(f) = l.get::<unsafe extern "system" fn() -> bool>(b"InitDll\0") { if !f() { return Err("InitDll failed".into()); } }
            l
        };
        #[cfg(target_os = "macos")]
        let (lib, bundle_ref): (libloading::Library, *const c_void) = {
            let l = libloading::Library::new(&bin).map_err(|e| format!("cannot load {}: {e}", bin.display()))?;
            let p = bundle.as_os_str().as_encoded_bytes();
            let url = mac::CFURLCreateFromFileSystemRepresentation(std::ptr::null(), p.as_ptr(), p.len() as isize, 1);
            let b = if url.is_null() { std::ptr::null() } else { let b = mac::CFBundleCreate(std::ptr::null(), url); mac::CFRelease(url); b };
            if let Ok(f) = l.get::<unsafe extern "C" fn(*const c_void) -> bool>(b"bundleEntry\0") { if !f(b) { return Err("bundleEntry failed".into()); } }
            (l, b)
        };
        let get = lib.get::<unsafe extern "system" fn() -> *mut IPluginFactory>(b"GetPluginFactory\0").map_err(|_| "not a VST3 module (no GetPluginFactory)".to_string())?;
        let f = get();
        let factory = ComPtr::from_raw(f).ok_or("GetPluginFactory returned null")?;
        if let Some(f3) = factory.cast::<IPluginFactory3>() { f3.setHostContext(host_context().as_ptr() as *mut FUnknown); }
        let module = Arc::new(Module {
            factory: std::mem::ManuallyDrop::new(factory), lib: std::mem::ManuallyDrop::new(lib),
            #[cfg(target_os = "macos")] bundle: bundle_ref,
            path: bundle.to_path_buf(),
        });
        m.insert(bundle.to_path_buf(), Arc::downgrade(&module));
        Ok(module)
    }
}

// ================================================================ host context
struct HostApp;
impl Class for HostApp { type Interfaces = (IHostApplication, IPlugInterfaceSupport); }
impl IHostApplicationTrait for HostApp {
    unsafe fn getName(&self, name: *mut String128) -> tresult { if name.is_null() { return kInvalidArgument; } copy_to_string128("Auduio", &mut *name); kResultOk }
    unsafe fn createInstance(&self, cid: *mut TUID, iid: *mut TUID, obj: *mut *mut c_void) -> tresult {
        if obj.is_null() { return kInvalidArgument; }
        *obj = std::ptr::null_mut();
        if guid_eq(cid, &IMessage::IID) && guid_eq(iid, &IMessage::IID) {
            *obj = ComWrapper::new(HostMessage::new()).to_com_ptr::<IMessage>().unwrap().into_raw() as *mut c_void;
            return kResultOk;
        }
        if guid_eq(cid, &IAttributeList::IID) && guid_eq(iid, &IAttributeList::IID) {
            *obj = ComWrapper::new(AttrList::default()).to_com_ptr::<IAttributeList>().unwrap().into_raw() as *mut c_void;
            return kResultOk;
        }
        kNoInterface
    }
}
impl IPlugInterfaceSupportTrait for HostApp {
    unsafe fn isPlugInterfaceSupported(&self, iid: *const TUID) -> tresult {
        let ok = [IComponentHandler::IID, IComponentHandler2::IID, IPlugFrame::IID, IHostApplication::IID, IMessage::IID, IAttributeList::IID,
                  IParameterChanges::IID, IParamValueQueue::IID, IEventList::IID, IBStream::IID];
        if ok.iter().any(|g| guid_eq(iid, g)) { kResultTrue } else { kResultFalse }
    }
}
static HOST: OnceLock<ComWrapper<HostApp>> = OnceLock::new();
fn host_context() -> ComPtr<IHostApplication> { HOST.get_or_init(|| ComWrapper::new(HostApp)).to_com_ptr::<IHostApplication>().unwrap() }

// ---------------------------------------------------------------- messages / attributes
enum Attr { Int(i64), Float(f64), Str(Vec<u16>), Bin(Vec<u8>) }
#[derive(Default)]
struct AttrList { map: Mutex<HashMap<String, Attr>> }
impl Class for AttrList { type Interfaces = (IAttributeList,); }
unsafe fn attr_key(id: IAttrID) -> Option<String> { if id.is_null() { None } else { Some(CStr::from_ptr(id).to_string_lossy().into_owned()) } }
impl IAttributeListTrait for AttrList {
    unsafe fn setInt(&self, id: IAttrID, v: int64) -> tresult { match attr_key(id) { Some(k) => { self.map.lock().unwrap().insert(k, Attr::Int(v)); kResultOk } None => kInvalidArgument } }
    unsafe fn getInt(&self, id: IAttrID, v: *mut int64) -> tresult { match attr_key(id).and_then(|k| match self.map.lock().unwrap().get(&k) { Some(Attr::Int(x)) => Some(*x), _ => None }) { Some(x) if !v.is_null() => { *v = x; kResultOk } _ => kResultFalse } }
    unsafe fn setFloat(&self, id: IAttrID, v: f64) -> tresult { match attr_key(id) { Some(k) => { self.map.lock().unwrap().insert(k, Attr::Float(v)); kResultOk } None => kInvalidArgument } }
    unsafe fn getFloat(&self, id: IAttrID, v: *mut f64) -> tresult { match attr_key(id).and_then(|k| match self.map.lock().unwrap().get(&k) { Some(Attr::Float(x)) => Some(*x), _ => None }) { Some(x) if !v.is_null() => { *v = x; kResultOk } _ => kResultFalse } }
    unsafe fn setString(&self, id: IAttrID, s: *const TChar) -> tresult {
        let Some(k) = attr_key(id) else { return kInvalidArgument };
        let mut v = Vec::new(); if !s.is_null() { let mut i = 0; while *s.add(i) != 0 { v.push(*s.add(i) as u16); i += 1; } }
        self.map.lock().unwrap().insert(k, Attr::Str(v)); kResultOk
    }
    unsafe fn getString(&self, id: IAttrID, s: *mut TChar, size_bytes: uint32) -> tresult {
        let Some(k) = attr_key(id) else { return kInvalidArgument };
        let m = self.map.lock().unwrap();
        let Some(Attr::Str(v)) = m.get(&k) else { return kResultFalse };
        let cap = (size_bytes as usize) / 2; if cap == 0 || s.is_null() { return kResultFalse; }
        let n = v.len().min(cap - 1);
        for i in 0..n { *s.add(i) = v[i] as TChar; } *s.add(n) = 0; kResultOk
    }
    unsafe fn setBinary(&self, id: IAttrID, d: *const c_void, n: uint32) -> tresult {
        let Some(k) = attr_key(id) else { return kInvalidArgument };
        let v = if d.is_null() { vec![] } else { std::slice::from_raw_parts(d as *const u8, n as usize).to_vec() };
        self.map.lock().unwrap().insert(k, Attr::Bin(v)); kResultOk
    }
    unsafe fn getBinary(&self, id: IAttrID, d: *mut *const c_void, n: *mut uint32) -> tresult {
        let Some(k) = attr_key(id) else { return kInvalidArgument };
        let m = self.map.lock().unwrap();
        let Some(Attr::Bin(v)) = m.get(&k) else { return kResultFalse };
        if !d.is_null() { *d = v.as_ptr() as *const c_void; } if !n.is_null() { *n = v.len() as u32; } kResultOk
    }
}
struct HostMessage { id: Mutex<Option<CString>>, attrs: ComWrapper<AttrList> }
impl HostMessage { fn new() -> Self { HostMessage { id: Mutex::new(None), attrs: ComWrapper::new(AttrList::default()) } } }
impl Class for HostMessage { type Interfaces = (IMessage,); }
impl IMessageTrait for HostMessage {
    unsafe fn getMessageID(&self) -> FIDString { self.id.lock().unwrap().as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null()) }
    unsafe fn setMessageID(&self, id: FIDString) { *self.id.lock().unwrap() = if id.is_null() { None } else { Some(CStr::from_ptr(id).to_owned()) }; }
    unsafe fn getAttributes(&self) -> *mut IAttributeList { self.attrs.as_com_ref::<IAttributeList>().unwrap().as_ptr() }
}

// ---------------------------------------------------------------- memory stream (plugin state)
struct MemStream { s: Mutex<(Vec<u8>, usize)> }
impl MemStream { fn new(d: Vec<u8>) -> ComWrapper<MemStream> { ComWrapper::new(MemStream { s: Mutex::new((d, 0)) }) } }
impl Class for MemStream { type Interfaces = (IBStream,); }
impl IBStreamTrait for MemStream {
    unsafe fn read(&self, buf: *mut c_void, n: int32, nread: *mut int32) -> tresult {
        let mut g = self.s.lock().unwrap(); let (d, pos) = &mut *g;
        let n = (n.max(0) as usize).min(d.len().saturating_sub(*pos));
        if n > 0 && !buf.is_null() { std::ptr::copy_nonoverlapping(d.as_ptr().add(*pos), buf as *mut u8, n); }
        *pos += n; if !nread.is_null() { *nread = n as i32; } kResultOk
    }
    unsafe fn write(&self, buf: *mut c_void, n: int32, nw: *mut int32) -> tresult {
        let mut g = self.s.lock().unwrap(); let (d, pos) = &mut *g;
        let n = n.max(0) as usize;
        if *pos + n > d.len() { d.resize(*pos + n, 0); }
        if n > 0 && !buf.is_null() { std::ptr::copy_nonoverlapping(buf as *const u8, d.as_mut_ptr().add(*pos), n); }
        *pos += n; if !nw.is_null() { *nw = n as i32; } kResultOk
    }
    unsafe fn seek(&self, p: int64, mode: int32, result: *mut int64) -> tresult {
        let mut g = self.s.lock().unwrap(); let (d, pos) = &mut *g;
        let base = match mode as u32 { 0 => 0i64, 1 => *pos as i64, _ => d.len() as i64 };
        let np = base + p; if np < 0 { return kInvalidArgument; }
        *pos = np as usize; if !result.is_null() { *result = np; } kResultOk
    }
    unsafe fn tell(&self, p: *mut int64) -> tresult { if !p.is_null() { *p = self.s.lock().unwrap().1 as i64; } kResultOk }
}

// ---------------------------------------------------------------- realtime parameter queues / event lists
const MAX_POINTS: usize = 64;
struct ParamQueue { q: UnsafeCell<(u32, usize, [(i32, f64); MAX_POINTS])> }
unsafe impl Send for ParamQueue {}
unsafe impl Sync for ParamQueue {}
impl Class for ParamQueue { type Interfaces = (IParamValueQueue,); }
impl IParamValueQueueTrait for ParamQueue {
    unsafe fn getParameterId(&self) -> ParamID { (*self.q.get()).0 }
    unsafe fn getPointCount(&self) -> int32 { (*self.q.get()).1 as i32 }
    unsafe fn getPoint(&self, i: int32, off: *mut int32, v: *mut ParamValue) -> tresult {
        let q = &*self.q.get(); if i < 0 || i as usize >= q.1 { return kResultFalse; }
        if !off.is_null() { *off = q.2[i as usize].0; } if !v.is_null() { *v = q.2[i as usize].1; } kResultOk
    }
    unsafe fn addPoint(&self, off: int32, v: ParamValue, idx: *mut int32) -> tresult {
        let q = &mut *self.q.get();
        // same offset replaces; keep points sorted by offset
        if q.1 > 0 && q.2[q.1 - 1].0 == off { q.2[q.1 - 1].1 = v; if !idx.is_null() { *idx = (q.1 - 1) as i32; } return kResultOk; }
        if q.1 >= MAX_POINTS { q.2[MAX_POINTS - 1] = (off, v); if !idx.is_null() { *idx = (MAX_POINTS - 1) as i32; } return kResultOk; }
        q.2[q.1] = (off, v); if !idx.is_null() { *idx = q.1 as i32; } q.1 += 1; kResultOk
    }
}
struct ParamChanges { c: UnsafeCell<(Vec<ComWrapper<ParamQueue>>, usize)> }
unsafe impl Send for ParamChanges {}
unsafe impl Sync for ParamChanges {}
impl ParamChanges {
    fn new(n: usize) -> ComWrapper<ParamChanges> {
        let v = (0..n).map(|_| ComWrapper::new(ParamQueue { q: UnsafeCell::new((0, 0, [(0, 0.0); MAX_POINTS])) })).collect();
        ComWrapper::new(ParamChanges { c: UnsafeCell::new((v, 0)) })
    }
    unsafe fn clear(&self) { let c = &mut *self.c.get(); for q in &c.0[..c.1] { (*q.q.get()).1 = 0; } c.1 = 0; }
    unsafe fn find_or_add(&self, id: u32) -> Option<&ParamQueue> {
        let c = &mut *self.c.get();
        for q in &c.0[..c.1] { if (*q.q.get()).0 == id { return Some(&**q); } }
        if c.1 >= c.0.len() { return None; }
        let q = &c.0[c.1]; (*q.q.get()).0 = id; (*q.q.get()).1 = 0; c.1 += 1; Some(&**q)
    }
    unsafe fn add(&self, id: u32, off: i32, v: f64) { if let Some(q) = self.find_or_add(id) { q.addPoint(off, v, std::ptr::null_mut()); } }
    unsafe fn last_values(&self, mut f: impl FnMut(u32, f64)) {
        let c = &*self.c.get();
        for q in &c.0[..c.1] { let q = &*q.q.get(); if q.1 > 0 { f(q.0, q.2[q.1 - 1].1); } }
    }
}
impl Class for ParamChanges { type Interfaces = (IParameterChanges,); }
impl IParameterChangesTrait for ParamChanges {
    unsafe fn getParameterCount(&self) -> int32 { (*self.c.get()).1 as i32 }
    unsafe fn getParameterData(&self, i: int32) -> *mut IParamValueQueue {
        let c = &*self.c.get(); if i < 0 || i as usize >= c.1 { return std::ptr::null_mut(); }
        c.0[i as usize].as_com_ref::<IParamValueQueue>().unwrap().as_ptr()
    }
    unsafe fn addParameterData(&self, id: *const ParamID, idx: *mut int32) -> *mut IParamValueQueue {
        if id.is_null() { return std::ptr::null_mut(); }
        let c = &mut *self.c.get();
        for (k, q) in c.0[..c.1].iter().enumerate() { if (*q.q.get()).0 == *id { if !idx.is_null() { *idx = k as i32; } return q.as_com_ref::<IParamValueQueue>().unwrap().as_ptr(); } }
        if c.1 >= c.0.len() { return std::ptr::null_mut(); }
        let k = c.1; let q = &c.0[k]; (*q.q.get()).0 = *id; (*q.q.get()).1 = 0; c.1 += 1;
        if !idx.is_null() { *idx = k as i32; }
        q.as_com_ref::<IParamValueQueue>().unwrap().as_ptr()
    }
}
struct EventList { e: UnsafeCell<(Vec<Event>, usize)> }
unsafe impl Send for EventList {}
unsafe impl Sync for EventList {}
impl EventList {
    fn new(n: usize) -> ComWrapper<EventList> { ComWrapper::new(EventList { e: UnsafeCell::new((vec![unsafe { std::mem::zeroed() }; n], 0)) }) }
    unsafe fn clear(&self) { (*self.e.get()).1 = 0; }
    unsafe fn push(&self, ev: Event) { let e = &mut *self.e.get(); if e.1 < e.0.len() { e.0[e.1] = ev; e.1 += 1; } }
}
impl Class for EventList { type Interfaces = (IEventList,); }
impl IEventListTrait for EventList {
    unsafe fn getEventCount(&self) -> int32 { (*self.e.get()).1 as i32 }
    unsafe fn getEvent(&self, i: int32, out: *mut Event) -> tresult { let e = &*self.e.get(); if i < 0 || i as usize >= e.1 || out.is_null() { return kResultFalse; } *out = e.0[i as usize]; kResultOk }
    unsafe fn addEvent(&self, ev: *mut Event) -> tresult { if ev.is_null() { return kInvalidArgument; } self.push(*ev); kResultOk }
}

// ---------------------------------------------------------------- component handler (editor -> host)
pub struct Shared {
    index_of: HashMap<u32, usize>,
    values: Vec<AtomicU32>,                      // host-side cache of normalized values (JUCE semantics)
    ui: Mutex<(Vec<(usize, f32)>, Vec<(usize, i32)>)>,
    to_rt: Mutex<rtrb::Producer<(u32, f32)>>,
    restart: AtomicI32,
}
impl Shared {
    fn val(&self, i: usize) -> f32 { self.values.get(i).map(|v| f32::from_bits(v.load(Ordering::Relaxed))).unwrap_or(0.0) }
    fn set_val(&self, i: usize, v: f32) { if let Some(x) = self.values.get(i) { x.store(v.to_bits(), Ordering::Relaxed); } }
    fn send_rt(&self, id: u32, v: f32) { let _ = self.to_rt.lock().unwrap().push((id, v)); }
}
struct Handler { shared: Arc<Shared> }
impl Class for Handler { type Interfaces = (IComponentHandler, IComponentHandler2); }
impl IComponentHandlerTrait for Handler {
    unsafe fn beginEdit(&self, id: ParamID) -> tresult { if let Some(&i) = self.shared.index_of.get(&id) { self.shared.ui.lock().unwrap().1.push((i, 1)); } kResultOk }
    unsafe fn performEdit(&self, id: ParamID, v: ParamValue) -> tresult {
        if let Some(&i) = self.shared.index_of.get(&id) {
            self.shared.set_val(i, v as f32);
            self.shared.ui.lock().unwrap().0.push((i, v as f32));
            self.shared.send_rt(id, v as f32); // the processor learns about editor moves through the host
        }
        kResultOk
    }
    unsafe fn endEdit(&self, id: ParamID) -> tresult { if let Some(&i) = self.shared.index_of.get(&id) { self.shared.ui.lock().unwrap().1.push((i, 2)); } kResultOk }
    unsafe fn restartComponent(&self, flags: int32) -> tresult { self.shared.restart.fetch_or(flags, Ordering::SeqCst); kResultOk }
}
impl IComponentHandler2Trait for Handler {
    unsafe fn setDirty(&self, _s: TBool) -> tresult { kResultOk }
    unsafe fn requestOpenEditor(&self, _n: FIDString) -> tresult { kResultFalse }
    unsafe fn startGroupEdit(&self) -> tresult { kResultOk }
    unsafe fn finishGroupEdit(&self) -> tresult { kResultOk }
}

// ---------------------------------------------------------------- plug frame (+ Linux run loop)
struct Frame { owner: u64, win: Mutex<Option<(u64, bool)>> }
#[cfg(all(unix, not(target_os = "macos")))]
impl Class for Frame { type Interfaces = (IPlugFrame, Linux::IRunLoop); }
#[cfg(not(all(unix, not(target_os = "macos"))))]
impl Class for Frame { type Interfaces = (IPlugFrame,); }
impl IPlugFrameTrait for Frame {
    unsafe fn resizeView(&self, view: *mut IPlugView, r: *mut ViewRect) -> tresult {
        if r.is_null() { return kInvalidArgument; }
        let (w, h) = (((*r).right - (*r).left).max(1) as u32, ((*r).bottom - (*r).top).max(1) as u32);
        if let Some((win, resizable)) = *self.win.lock().unwrap() { window::resize(win, w, h, resizable); window::flush(); }
        if let Some(v) = ComRef::from_raw(view) { v.onSize(r); }
        kResultTrue
    }
}
#[cfg(all(unix, not(target_os = "macos")))]
impl Linux::IRunLoopTrait for Frame {
    unsafe fn registerEventHandler(&self, h: *mut Linux::IEventHandler, fd: Linux::FileDescriptor) -> tresult {
        let Some(hp) = ComRef::from_raw(h).map(|r| r.to_com_ptr()) else { return kInvalidArgument };
        runloop::add_fd(self.owner, h as usize, fd, 1, Rc::new(move |fd, _| { use vst3::Steinberg::Linux::IEventHandlerTrait; hp.onFDIsSet(fd) }));
        kResultTrue
    }
    unsafe fn unregisterEventHandler(&self, h: *mut Linux::IEventHandler) -> tresult { runloop::remove_fd(self.owner, h as usize); kResultTrue }
    unsafe fn registerTimer(&self, h: *mut Linux::ITimerHandler, ms: Linux::TimerInterval) -> tresult {
        let Some(hp) = ComRef::from_raw(h).map(|r| r.to_com_ptr()) else { return kInvalidArgument };
        runloop::add_timer(self.owner, h as usize, ms, Rc::new(move || { use vst3::Steinberg::Linux::ITimerHandlerTrait; hp.onTimer() }));
        kResultTrue
    }
    unsafe fn unregisterTimer(&self, h: *mut Linux::ITimerHandler) -> tresult { runloop::remove_timer(self.owner, h as usize); kResultTrue }
}

// ================================================================ scanning
pub struct ClassInfo { pub index: i32, pub cid: TUID, pub name: String, pub vendor: String, pub version: String, pub category: String, pub unique_id: i32, pub deprecated_uid: i32 }

pub fn classes(m: &Module) -> Vec<ClassInfo> {
    let mut out = vec![];
    unsafe {
        let f = &*m.factory;
        let mut fi: PFactoryInfo = std::mem::zeroed();
        f.getFactoryInfo(&mut fi);
        let fvendor = cstr_to_string(&fi.vendor).trim().to_string();
        let f2 = f.cast::<IPluginFactory2>();
        let f3 = f.cast::<IPluginFactory3>();
        for i in 0..f.countClasses() {
            let mut ci: PClassInfo = std::mem::zeroed();
            if f.getClassInfo(i, &mut ci) != kResultOk { continue; }
            if cstr_to_string(&ci.category) != AUDIO_MODULE_CLASS { continue; }
            let name = cstr_to_string(&ci.name).trim().to_string();
            let (mut vendor, mut version, mut category) = (fvendor.clone(), String::new(), String::new());
            let mut filled = false;
            if let Some(f3) = &f3 {
                let mut w: PClassInfoW = std::mem::zeroed();
                if f3.getClassInfoUnicode(i, &mut w) == kResultOk {
                    version = utf16_to_string(&w.version.map(|c| c as u16)).trim().into();
                    category = cstr_to_string(&w.subCategories).trim().into();
                    if vendor.is_empty() { vendor = utf16_to_string(&w.vendor.map(|c| c as u16)).trim().into(); }
                    filled = true;
                }
            }
            if !filled { if let Some(f2) = &f2 {
                let mut c2: PClassInfo2 = std::mem::zeroed();
                if f2.getClassInfo2(i, &mut c2) == kResultOk {
                    version = cstr_to_string(&c2.version).trim().into();
                    category = cstr_to_string(&c2.subCategories).trim().into();
                    if vendor.is_empty() { vendor = cstr_to_string(&c2.vendor).trim().into(); }
                }
            } }
            if category.is_empty() { category = AUDIO_MODULE_CLASS.into(); }
            let (u, d) = vst3_juce_ids(&ci.cid);
            out.push(ClassInfo { index: i, cid: ci.cid, name, vendor, version, category, unique_id: u, deprecated_uid: d });
        }
    }
    out
}

unsafe fn count_channels(comp: &ComPtr<IComponent>, dir: i32) -> i32 {
    let mut total = 0;
    for b in 0..comp.getBusCount(MediaTypes_::kAudio as i32, dir) {
        let mut bi: BusInfo = std::mem::zeroed();
        // like JUCE's getNumSingleDirectionChannelsFor: only buses that are active by default
        if comp.getBusInfo(MediaTypes_::kAudio as i32, dir, b, &mut bi) == kResultOk && bi.flags & 1 != 0 { total += bi.channelCount; }
    }
    total
}

/// probe one .vst3 (runs inside the isolated `--scan-one` child process)
pub fn scan_file(path: &Path) -> Result<Vec<Value>, String> {
    let m = load_module(path)?;
    let file = path.to_string_lossy().into_owned();
    let modified = mtime_ms(path);
    let mut out = vec![];
    for c in classes(&m) {
        let (mut ins, mut outs) = (0, 0);
        unsafe {
            let mut obj: *mut c_void = std::ptr::null_mut();
            if m.factory.createInstance(c.cid.as_ptr(), IComponent::IID.as_ptr() as *const c_char, &mut obj) == kResultOk {
                if let Some(comp) = ComPtr::from_raw(obj as *mut IComponent) {
                    if comp.initialize(host_context().as_ptr() as *mut FUnknown) == kResultOk {
                        ins = count_channels(&comp, BusDirections_::kInput as i32);
                        outs = count_channels(&comp, BusDirections_::kOutput as i32);
                        comp.terminate();
                    }
                }
            }
        }
        out.push(json!({
            "uid": juce_identifier("VST3", &c.name, &file, c.unique_id, c.deprecated_uid),
            "name": c.name, "descriptiveName": c.name, "format": "VST3", "category": c.category, "vendor": c.vendor,
            "version": c.version, "file": file, "uniqueId": c.unique_id, "deprecatedUid": c.deprecated_uid,
            "isInstrument": c.category.to_lowercase().contains("instrument"), "inputs": ins, "outputs": outs, "modified": modified
        }));
    }
    Ok(out)
}

// ================================================================ instance
struct Rt {
    rx: rtrb::Consumer<(u32, f32)>,
    ui_tx: rtrb::Producer<(usize, f32)>,
    inq: ComWrapper<ParamChanges>,
    outq: ComWrapper<ParamChanges>,
    inev: ComWrapper<EventList>,
    outev: ComWrapper<EventList>,
    inbufs: Vec<Vec<f32>>,
    dummy: Vec<Vec<f32>>,
    in_ptrs: Vec<*mut f32>,
    out_ptrs: Vec<*mut f32>,
    in_bb: Vec<AudioBusBuffers>,
    out_bb: Vec<AudioBusBuffers>,
    ctx: ProcessContext,
}

struct Editor { view: ComPtr<IPlugView>, frame: ComWrapper<Frame>, win: u64, resizable: bool }

pub struct Vst3Instance {
    id: i32,
    desc: Value,
    component: ComPtr<IComponent>,
    processor: ComPtr<IAudioProcessor>,
    controller: Option<ComPtr<IEditController>>,
    separate: bool,
    points: Option<(ComPtr<IConnectionPoint>, ComPtr<IConnectionPoint>)>,
    _handler: ComWrapper<Handler>,
    shared: Arc<Shared>,
    params: Vec<ParamDesc>,
    ids: Vec<u32>,
    in_ch: Vec<i32>,
    out_ch: Vec<i32>,
    event_in: bool,
    has_editor: bool,
    midi_map: Vec<[u32; 131]>,
    editor: Mutex<Option<Editor>>,
    ui_rx: Mutex<rtrb::Consumer<(usize, f32)>>,
    active: AtomicBool,
    offline: AtomicBool,
    rt: UnsafeCell<Rt>,
    _module: Arc<Module>,
}
unsafe impl Send for Vst3Instance {}
unsafe impl Sync for Vst3Instance {}

fn arr_channels(a: SpeakerArrangement) -> i32 { a.count_ones() as i32 }

impl Vst3Instance {
    pub fn create(id: i32, desc: &Value, sample_rate: f64) -> Result<Vst3Instance, String> {
        let file = desc["file"].as_str().unwrap_or("").to_string();
        let name = desc["name"].as_str().unwrap_or("").to_string();
        let uid = desc["uniqueId"].as_i64().unwrap_or(0) as i32;
        let dep = desc["deprecatedUid"].as_i64().unwrap_or(0) as i32;
        let module = load_module(Path::new(&file))?;
        let cls = classes(&module);
        let c = cls.iter().find(|c| c.name == name && (c.unique_id == uid || c.deprecated_uid == dep))
            .or_else(|| cls.iter().find(|c| c.name == name)).ok_or_else(|| format!("{name} not found in {file}"))?;
        unsafe {
            let host = host_context();
            let mut obj: *mut c_void = std::ptr::null_mut();
            if module.factory.createInstance(c.cid.as_ptr(), IComponent::IID.as_ptr() as *const c_char, &mut obj) != kResultOk { return Err("the plugin refused to create its component".into()); }
            let component = ComPtr::from_raw(obj as *mut IComponent).ok_or("null component")?;
            if component.initialize(host.as_ptr() as *mut FUnknown) != kResultOk { return Err("component initialize failed".into()); }
            let processor = component.cast::<IAudioProcessor>().ok_or("the component is not an audio processor")?;
            // edit controller: the component itself, or a separate class
            let mut separate = false;
            let mut controller = component.cast::<IEditController>();
            if controller.is_none() {
                let mut ccid: TUID = [0; 16];
                if component.getControllerClassId(&mut ccid) == kResultOk && ccid.iter().any(|&b| b != 0) {
                    let mut o: *mut c_void = std::ptr::null_mut();
                    if module.factory.createInstance(ccid.as_ptr(), IEditController::IID.as_ptr() as *const c_char, &mut o) == kResultOk {
                        if let Some(ctl) = ComPtr::from_raw(o as *mut IEditController) {
                            if ctl.initialize(host.as_ptr() as *mut FUnknown) == kResultOk { controller = Some(ctl); separate = true; }
                        }
                    }
                }
            }
            let mut points = None;
            if separate {
                if let (Some(a), Some(b)) = (component.cast::<IConnectionPoint>(), controller.as_ref().and_then(|c| c.cast::<IConnectionPoint>())) {
                    a.connect(b.as_ptr()); b.connect(a.as_ptr());
                    points = Some((a, b));
                }
            }
            // controller learns the processor's state
            if let Some(ctl) = &controller {
                let st = MemStream::new(vec![]);
                let sp = st.to_com_ptr::<IBStream>().unwrap();
                if component.getState(sp.as_ptr()) == kResultOk { sp.seek(0, 0, std::ptr::null_mut()); ctl.setComponentState(sp.as_ptr()); }
            }
            // parameters
            let mut params = vec![]; let mut ids = vec![]; let mut index_of = HashMap::new(); let mut values = vec![];
            if let Some(ctl) = &controller {
                for i in 0..ctl.getParameterCount().min(65536) {
                    let mut pi: ParameterInfo = std::mem::zeroed();
                    if ctl.getParameterInfo(i, &mut pi) != kResultOk { continue; }
                    let stepped = pi.stepCount > 0;
                    params.push(ParamDesc {
                        id: pi.id.to_string(), name: s128(&pi.title), label: s128(&pi.units), def: pi.defaultNormalizedValue as f32,
                        steps: if stepped { pi.stepCount as i64 + 1 } else { CONTINUOUS_STEPS }, discrete: stepped, boolean: false,
                        automatable: pi.flags & (ParameterInfo_::ParameterFlags_::kCanAutomate as i32) != 0,
                        hidden: false, readonly: pi.flags & (ParameterInfo_::ParameterFlags_::kIsReadOnly as i32) != 0, options: None,
                    });
                    index_of.insert(pi.id, ids.len()); ids.push(pi.id);
                    values.push(AtomicU32::new((ctl.getParamNormalized(pi.id) as f32).to_bits()));
                }
            }
            let (tx, rx) = rtrb::RingBuffer::<(u32, f32)>::new(32768);
            let (utx, urx) = rtrb::RingBuffer::<(usize, f32)>::new(8192);
            let shared = Arc::new(Shared { index_of, values, ui: Mutex::new((vec![], vec![])), to_rt: Mutex::new(tx), restart: AtomicI32::new(0) });
            let handler = ComWrapper::new(Handler { shared: shared.clone() });
            if let Some(ctl) = &controller { ctl.setComponentHandler(handler.to_com_ptr::<IComponentHandler>().unwrap().as_ptr()); }
            // buses: stereo main buses if the plugin agrees, main buses + first event input active
            let n_in = component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kInput as i32);
            let n_out = component.getBusCount(MediaTypes_::kAudio as i32, BusDirections_::kOutput as i32);
            let get_arr = |dir: i32, n: i32| -> Vec<SpeakerArrangement> { (0..n).map(|b| { let mut a: SpeakerArrangement = 0; processor.getBusArrangement(dir, b, &mut a); a }).collect() };
            let mut ins = get_arr(BusDirections_::kInput as i32, n_in);
            let mut outs = get_arr(BusDirections_::kOutput as i32, n_out);
            if let Some(a) = ins.first_mut() { if arr_channels(*a) >= 1 { *a = SpeakerArr::kStereo; } }
            if let Some(a) = outs.first_mut() { if arr_channels(*a) >= 1 { *a = SpeakerArr::kStereo; } }
            if processor.setBusArrangements(ins.as_mut_ptr(), n_in, outs.as_mut_ptr(), n_out) != kResultTrue {
                ins = get_arr(BusDirections_::kInput as i32, n_in); outs = get_arr(BusDirections_::kOutput as i32, n_out);
            } else {
                ins = get_arr(BusDirections_::kInput as i32, n_in); outs = get_arr(BusDirections_::kOutput as i32, n_out);
            }
            let in_ch: Vec<i32> = ins.iter().map(|&a| arr_channels(a)).collect();
            let out_ch: Vec<i32> = outs.iter().map(|&a| arr_channels(a)).collect();
            for b in 0..n_in { component.activateBus(MediaTypes_::kAudio as i32, BusDirections_::kInput as i32, b, (b == 0) as u8); }
            for b in 0..n_out { component.activateBus(MediaTypes_::kAudio as i32, BusDirections_::kOutput as i32, b, (b == 0) as u8); }
            let n_ev = component.getBusCount(MediaTypes_::kEvent as i32, BusDirections_::kInput as i32);
            if n_ev > 0 { component.activateBus(MediaTypes_::kEvent as i32, BusDirections_::kInput as i32, 0, 1); }
            // MIDI controllers -> parameters
            let mut midi_map = vec![];
            if let Some(mm) = controller.as_ref().and_then(|c| c.cast::<IMidiMapping>()) {
                for ch in 0..16i16 {
                    let mut row = [u32::MAX; 131];
                    for cc in 0..131i16 { let mut pid: ParamID = 0; if mm.getMidiControllerAssignment(0, ch, cc, &mut pid) == kResultTrue { row[cc as usize] = pid; } }
                    midi_map.push(row);
                }
            }
            let has_editor = controller.as_ref().map(|c| { let v = c.createView(b"editor\0".as_ptr() as *const c_char); if let Some(v) = ComPtr::from_raw(v) { drop(v); true } else { false } }).unwrap_or(false);
            let tot_in: usize = in_ch.iter().map(|&c| c.max(0) as usize).sum();
            let tot_out: usize = out_ch.iter().map(|&c| c.max(0) as usize).sum();
            let rt = Rt {
                rx, ui_tx: utx, inq: ParamChanges::new(1024), outq: ParamChanges::new(1024), inev: EventList::new(2048), outev: EventList::new(512),
                inbufs: (0..tot_in).map(|_| vec![0.0; MAX_BLOCK]).collect(), dummy: (0..tot_out + tot_in).map(|_| vec![0.0; MAX_BLOCK]).collect(),
                in_ptrs: vec![std::ptr::null_mut(); tot_in], out_ptrs: vec![std::ptr::null_mut(); tot_out],
                in_bb: vec![std::mem::zeroed(); in_ch.len()], out_bb: vec![std::mem::zeroed(); out_ch.len()], ctx: std::mem::zeroed(),
            };
            let inst = Vst3Instance {
                id, desc: desc.clone(), component, processor, controller, separate, points, _handler: handler, shared, params, ids,
                in_ch, out_ch, event_in: n_ev > 0, has_editor, midi_map, editor: Mutex::new(None), ui_rx: Mutex::new(urx),
                active: AtomicBool::new(false), offline: AtomicBool::new(false), rt: UnsafeCell::new(rt), _module: module,
            };
            inst.prepare(sample_rate);
            Ok(inst)
        }
    }

    fn deactivate(&self) {
        if self.active.swap(false, Ordering::SeqCst) { unsafe { self.processor.setProcessing(0); self.component.setActive(0); } }
    }
    fn refresh_values(&self, report: bool) {
        let Some(ctl) = &self.controller else { return };
        let mut ui = self.shared.ui.lock().unwrap();
        for (i, &id) in self.ids.iter().enumerate() {
            let v = unsafe { ctl.getParamNormalized(id) } as f32;
            if (self.shared.val(i) - v).abs() > 1e-7 { self.shared.set_val(i, v); if report { ui.0.push((i, v)); } }
        }
    }
}

impl Drop for Vst3Instance {
    fn drop(&mut self) {
        self.close_editor();
        self.deactivate();
        unsafe {
            if let Some((a, b)) = self.points.take() { a.disconnect(b.as_ptr()); b.disconnect(a.as_ptr()); }
            if let Some(ctl) = &self.controller { ctl.setComponentHandler(std::ptr::null_mut()); if self.separate { ctl.terminate(); } }
            self.controller = None;
            self.component.terminate();
        }
    }
}

impl Plugin for Vst3Instance {
    fn id(&self) -> i32 { self.id }
    fn load_info(&self) -> LoadInfo {
        LoadInfo { has_editor: self.has_editor, latency: unsafe { self.processor.getLatencySamples() },
                   inputs: self.in_ch.iter().map(|&c| c.max(0) as u32).sum(), outputs: self.out_ch.iter().map(|&c| c.max(0) as u32).sum(), accepts_midi: self.event_in }
    }
    fn params(&self) -> Vec<ParamDesc> { self.params.clone() }
    fn param_count(&self) -> usize { self.params.len() }
    fn param_value(&self, i: usize) -> f32 { self.shared.val(i) }
    fn param_text(&self, i: usize, v: f32) -> String {
        let (Some(ctl), Some(&id)) = (&self.controller, self.ids.get(i)) else { return String::new() };
        let mut s: String128 = [0; 128];
        if unsafe { ctl.getParamStringByValue(id, v as f64, &mut s) } == kResultOk { s128(&s) } else { format!("{v:.6}") }
    }
    fn set_param(&self, i: usize, v: f32, notify: bool) {
        let Some(&id) = self.ids.get(i) else { return };
        self.shared.set_val(i, v);
        if let Some(ctl) = &self.controller { unsafe { ctl.setParamNormalized(id, v as f64); } }
        self.shared.send_rt(id, v);
        if notify { self.shared.ui.lock().unwrap().0.push((i, v)); }
    }
    fn get_state(&self) -> Result<Vec<u8>, String> {
        unsafe {
            let grab = |f: &dyn Fn(*mut IBStream) -> tresult| -> Option<Vec<u8>> {
                let st = MemStream::new(vec![]); let sp = st.to_com_ptr::<IBStream>().unwrap();
                if f(sp.as_ptr()) == kResultOk { Some(st.s.lock().unwrap().0.clone()) } else { None }
            };
            let comp = grab(&|s| self.component.getState(s));
            let ctl = self.controller.as_ref().and_then(|c| grab(&|s| c.getState(s)));
            Ok(vst3_state_to_juce_blob(comp.as_deref(), ctl.as_deref()))
        }
    }
    fn set_state(&self, data: &[u8]) -> Result<(), String> {
        let (comp, ctl) = vst3_state_from_juce_blob(data).ok_or("not a VST3 plugin state")?;
        unsafe {
            if let Some(c) = comp {
                let st = MemStream::new(c.clone()); let sp = st.to_com_ptr::<IBStream>().unwrap();
                self.component.setState(sp.as_ptr());
                if let Some(ctlr) = &self.controller {
                    let st2 = MemStream::new(c); let sp2 = st2.to_com_ptr::<IBStream>().unwrap();
                    ctlr.setComponentState(sp2.as_ptr());
                }
            }
            if let (Some(c), Some(ctlr)) = (ctl, &self.controller) {
                let st = MemStream::new(c); let sp = st.to_com_ptr::<IBStream>().unwrap();
                ctlr.setState(sp.as_ptr());
            }
        }
        self.refresh_values(false);
        Ok(())
    }
    fn prepare(&self, sample_rate: f64) {
        self.deactivate();
        unsafe {
            let mut setup = ProcessSetup { processMode: ProcessModes_::kRealtime as i32, symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32, maxSamplesPerBlock: MAX_BLOCK as i32, sampleRate: sample_rate };
            self.processor.setupProcessing(&mut setup);
            self.component.setActive(1);
            self.processor.setProcessing(1);
            (*self.rt.get()).ctx.sampleRate = sample_rate;
        }
        self.active.store(true, Ordering::SeqCst);
    }
    fn reset(&self) {
        // what JUCE's VST3 reset() does: toggle processing/activation so voices and tails are cleared
        if self.active.load(Ordering::SeqCst) {
            unsafe { self.processor.setProcessing(0); self.component.setActive(0); self.component.setActive(1); self.processor.setProcessing(1); }
        }
    }
    fn open_editor(&self, title: &str) -> Result<(u32, u32), String> {
        let mut ed = self.editor.lock().unwrap();
        if let Some(e) = ed.as_ref() { window::raise(e.win); return Ok((0, 0)); }
        let ctl = self.controller.as_ref().ok_or("this plugin has no editor window")?;
        #[cfg(all(unix, not(target_os = "macos")))]
        let pt = kPlatformTypeX11EmbedWindowID;
        #[cfg(windows)]
        let pt = kPlatformTypeHWND;
        #[cfg(target_os = "macos")]
        let pt = kPlatformTypeNSView;
        unsafe {
            let view = ComPtr::from_raw(ctl.createView(b"editor\0".as_ptr() as *const c_char)).ok_or("the plugin did not create an editor")?;
            if view.isPlatformTypeSupported(pt) != kResultTrue { return Err("the plugin editor does not support this window system".into()); }
            let mut r: ViewRect = std::mem::zeroed();
            view.getSize(&mut r);
            let (mut w, mut h) = ((r.right - r.left).max(0) as u32, (r.bottom - r.top).max(0) as u32);
            if w < 10 || h < 10 { w = 640; h = 400; }
            let resizable = view.canResize() == kResultTrue;
            let frame = ComWrapper::new(Frame { owner: 0x5653_0000_0000_0000 | self.id as u64, win: Mutex::new(None) });
            view.setFrame(frame.to_com_ptr::<IPlugFrame>().unwrap().as_ptr());
            let win = match window::create(title, w, h, resizable) { Ok(w) => w, Err(e) => { view.setFrame(std::ptr::null_mut()); return Err(e); } };
            *frame.win.lock().unwrap() = Some((win, resizable));
            if view.attached(win as usize as *mut c_void, pt) != kResultOk {
                view.setFrame(std::ptr::null_mut()); runloop::remove_owner(frame.owner); window::destroy(win);
                return Err("the plugin editor could not attach to the window".into());
            }
            let mut r2: ViewRect = std::mem::zeroed();
            if view.getSize(&mut r2) == kResultOk {
                let (w2, h2) = ((r2.right - r2.left).max(1) as u32, (r2.bottom - r2.top).max(1) as u32);
                if (w2, h2) != (w, h) && w2 > 10 && h2 > 10 { window::resize(win, w2, h2, resizable); w = w2; h = h2; }
            }
            window::flush();
            *ed = Some(Editor { view, frame, win, resizable });
            Ok((w, h))
        }
    }
    fn close_editor(&self) {
        let e = self.editor.lock().unwrap().take();
        if let Some(e) = e {
            unsafe { e.view.removed(); e.view.setFrame(std::ptr::null_mut()); }
            let owner = e.frame.owner; let win = e.win;
            drop(e);
            runloop::remove_owner(owner);
            window::destroy(win);
        }
    }
    fn editor_is_open(&self) -> bool { self.editor.lock().unwrap().is_some() }
    fn raise_editor(&self) { if let Some(e) = self.editor.lock().unwrap().as_ref() { window::raise(e.win); } }
    fn editor_window(&self) -> Option<u64> { self.editor.lock().unwrap().as_ref().map(|e| e.win) }
    fn idle(&self) {
        let flags = self.shared.restart.swap(0, Ordering::SeqCst);
        if flags & (RestartFlags_::kParamValuesChanged as i32 | RestartFlags_::kReloadComponent as i32) != 0 { self.refresh_values(true); }
        if flags & (RestartFlags_::kLatencyChanged as i32 | RestartFlags_::kIoChanged as i32) != 0 && self.active.load(Ordering::SeqCst) {
            // needs a restart of processing; only safe while the engine does not process this plugin
        }
    }
    fn drain_ui(&self, changes: &mut Vec<(usize, f32)>, gestures: &mut Vec<(usize, i32)>) {
        { let mut u = self.shared.ui.lock().unwrap(); changes.extend(u.0.drain(..)); gestures.extend(u.1.drain(..)); }
        let mut rx = self.ui_rx.lock().unwrap();
        while let Ok((i, v)) = rx.pop() { changes.push((i, v)); }
    }
    unsafe fn process(&self, chans: &[*mut f32], n: usize, events: &[Ev], tr: &Transport) {
        if !self.active.load(Ordering::Relaxed) || n == 0 { return; }
        let n = n.min(MAX_BLOCK);
        let rt = &mut *self.rt.get();
        rt.inq.clear(); rt.inev.clear(); rt.outq.clear(); rt.outev.clear();
        while let Ok((id, v)) = rt.rx.pop() { rt.inq.add(id, 0, v as f64); }
        for ev in events {
            match *ev {
                Ev::Param { offset, inst, index, value } if inst == self.id => {
                    if let Some(&id) = self.ids.get(index as usize) { self.shared.set_val(index as usize, value); rt.inq.add(id, offset as i32, value as f64); }
                }
                Ev::Param { .. } => {}
                Ev::Midi { offset, data } => {
                    let st = data[0] & 0xF0; let ch = (data[0] & 0x0F) as i16;
                    let mut e: Event = std::mem::zeroed();
                    e.busIndex = 0; e.sampleOffset = offset as i32; e.flags = Event_::EventFlags_::kIsLive as u16;
                    match st {
                        0x90 if data[2] > 0 => { e.r#type = Event_::EventTypes_::kNoteOnEvent as u16; e.__field0.noteOn = NoteOnEvent { channel: ch, pitch: data[1] as i16, tuning: 0.0, velocity: data[2] as f32 / 127.0, length: 0, noteId: -1 }; rt.inev.push(e); }
                        0x80 | 0x90 => { e.r#type = Event_::EventTypes_::kNoteOffEvent as u16; e.__field0.noteOff = NoteOffEvent { channel: ch, pitch: data[1] as i16, velocity: data[2] as f32 / 127.0, noteId: -1, tuning: 0.0 }; rt.inev.push(e); }
                        0xA0 => { e.r#type = Event_::EventTypes_::kPolyPressureEvent as u16; e.__field0.polyPressure = PolyPressureEvent { channel: ch, pitch: data[1] as i16, pressure: data[2] as f32 / 127.0, noteId: -1 }; rt.inev.push(e); }
                        0xB0 | 0xD0 | 0xE0 | 0xC0 => {
                            let (cc, val) = match st { 0xB0 => (data[1] as usize, data[2] as f64 / 127.0), 0xD0 => (128, data[1] as f64 / 127.0), 0xC0 => (130, data[1] as f64 / 127.0), _ => (129, (((data[2] as u32) << 7) | data[1] as u32) as f64 / 16383.0) };
                            if let Some(row) = self.midi_map.get(ch as usize) { if cc < 131 && row[cc] != u32::MAX { rt.inq.add(row[cc], offset as i32, val); } }
                        }
                        _ => {}
                    }
                }
            }
        }
        // buses: main input gets a copy of the track signal; main output renders in place
        let mut k = 0usize; let mut dk = 0usize;
        for (b, &c) in self.in_ch.iter().enumerate() {
            let start = k;
            for ci in 0..c.max(0) as usize {
                let buf = &mut rt.inbufs[k];
                if b == 0 && ci < chans.len() { std::ptr::copy_nonoverlapping(chans[ci], buf.as_mut_ptr(), n); } else { buf[..n].fill(0.0); }
                rt.in_ptrs[k] = buf.as_mut_ptr(); k += 1;
            }
            rt.in_bb[b].numChannels = c.max(0); rt.in_bb[b].silenceFlags = 0;
            rt.in_bb[b].__field0.channelBuffers32 = if c > 0 { rt.in_ptrs.as_mut_ptr().add(start) } else { std::ptr::null_mut() };
        }
        let mut k = 0usize;
        for (b, &c) in self.out_ch.iter().enumerate() {
            let start = k;
            for ci in 0..c.max(0) as usize {
                rt.out_ptrs[k] = if b == 0 && ci < chans.len() { chans[ci] } else { let p = rt.dummy[dk].as_mut_ptr(); dk += 1; p };
                k += 1;
            }
            rt.out_bb[b].numChannels = c.max(0); rt.out_bb[b].silenceFlags = 0;
            rt.out_bb[b].__field0.channelBuffers32 = if c > 0 { rt.out_ptrs.as_mut_ptr().add(start) } else { std::ptr::null_mut() };
        }
        use ProcessContext_::StatesAndFlags_::*;
        let c = &mut rt.ctx;
        c.state = (kTempoValid | kTimeSigValid | kProjectTimeMusicValid | kBarPositionValid) as u32 | if tr.playing { kPlaying as u32 } else { 0 };
        c.sampleRate = tr.sample_rate; c.projectTimeSamples = tr.time_samples; c.continousTimeSamples = tr.time_samples;
        c.projectTimeMusic = tr.ppq; c.barPositionMusic = tr.bar_start_ppq; c.tempo = tr.bpm; c.timeSigNumerator = tr.num; c.timeSigDenominator = tr.den;
        let mut data = ProcessData {
            processMode: if self.offline.load(Ordering::Relaxed) { ProcessModes_::kOffline as i32 } else { ProcessModes_::kRealtime as i32 },
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32, numSamples: n as i32,
            numInputs: self.in_ch.len() as i32, numOutputs: self.out_ch.len() as i32,
            inputs: if self.in_ch.is_empty() { std::ptr::null_mut() } else { rt.in_bb.as_mut_ptr() },
            outputs: if self.out_ch.is_empty() { std::ptr::null_mut() } else { rt.out_bb.as_mut_ptr() },
            inputParameterChanges: rt.inq.as_com_ref::<IParameterChanges>().unwrap().as_ptr(),
            outputParameterChanges: rt.outq.as_com_ref::<IParameterChanges>().unwrap().as_ptr(),
            inputEvents: rt.inev.as_com_ref::<IEventList>().unwrap().as_ptr(),
            outputEvents: rt.outev.as_com_ref::<IEventList>().unwrap().as_ptr(),
            processContext: &mut rt.ctx,
        };
        self.processor.process(&mut data);
        // parameter values the processor reports back (e.g. meters, internal modulation)
        let shared = &self.shared; let tx = &mut rt.ui_tx;
        rt.outq.last_values(|id, v| { if let Some(&i) = shared.index_of.get(&id) { if (shared.val(i) - v as f32).abs() > 1e-6 { shared.set_val(i, v as f32); let _ = tx.push((i, v as f32)); } } });
    }
    fn describe(&self) -> Value { self.desc.clone() }
    fn set_offline(&self, on: bool) { self.offline.store(on, Ordering::Relaxed); }
    fn window_resized(&self, w: u32, h: u32) {
        let ed = self.editor.lock().unwrap();
        if let Some(e) = ed.as_ref() {
            if !e.resizable { return; }
            let mut r = ViewRect { left: 0, top: 0, right: w as i32, bottom: h as i32 };
            unsafe {
                let mut cur: ViewRect = std::mem::zeroed();
                if e.view.getSize(&mut cur) == kResultOk && cur.right - cur.left == w as i32 && cur.bottom - cur.top == h as i32 { return; }
                if e.view.checkSizeConstraint(&mut r) == kResultTrue { e.view.onSize(&mut r); }
            }
        }
    }
}
