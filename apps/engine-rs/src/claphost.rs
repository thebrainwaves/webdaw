//! CLAP hosting through `clap-sys` (MIT OR Apache-2.0) bindings of the MIT-licensed CLAP headers.
use crate::plugin::*;
use crate::util::*;
use crate::{protocol, runloop, window};
use clap_sys::audio_buffer::clap_audio_buffer;
use clap_sys::entry::clap_plugin_entry;
use clap_sys::events::*;
use clap_sys::ext::audio_ports::*;
use clap_sys::ext::gui::*;
use clap_sys::ext::latency::*;
use clap_sys::ext::log::*;
use clap_sys::ext::note_ports::*;
use clap_sys::ext::params::*;
use clap_sys::ext::posix_fd_support::*;
use clap_sys::ext::state::*;
use clap_sys::ext::thread_check::*;
use clap_sys::ext::timer_support::*;
use clap_sys::factory::plugin_factory::*;
use clap_sys::fixedpoint::*;
use clap_sys::host::clap_host;
use clap_sys::id::clap_id;
use clap_sys::plugin::*;
use clap_sys::process::clap_process;
use clap_sys::stream::{clap_istream, clap_ostream};
use clap_sys::version::CLAP_VERSION;
use serde_json::{json, Value};
use std::cell::UnsafeCell;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

// ================================================================ library cache
pub struct ClapLib { entry: *const clap_plugin_entry, lib: std::mem::ManuallyDrop<libloading::Library>, pub path: PathBuf }
unsafe impl Send for ClapLib {}
unsafe impl Sync for ClapLib {}
impl Drop for ClapLib {
    fn drop(&mut self) { unsafe { if let Some(d) = (*self.entry).deinit { d(); } std::mem::ManuallyDrop::drop(&mut self.lib); } }
}
impl ClapLib {
    unsafe fn factory(&self) -> Option<&clap_plugin_factory> {
        let f = (*self.entry).get_factory?(CLAP_PLUGIN_FACTORY_ID.as_ptr());
        (f as *const clap_plugin_factory).as_ref()
    }
}
static LIBS: OnceLock<Mutex<HashMap<PathBuf, Weak<ClapLib>>>> = OnceLock::new();
fn binary_path(p: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    if p.is_dir() {
        let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let b = p.join("Contents").join("MacOS").join(&stem);
        if b.exists() { return b; }
        if let Some(e) = std::fs::read_dir(p.join("Contents").join("MacOS")).ok().and_then(|mut d| d.next()).and_then(|e| e.ok()) { return e.path(); }
    }
    p.to_path_buf()
}
pub fn load_lib(path: &Path) -> Result<Arc<ClapLib>, String> {
    let map = LIBS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut m = map.lock().unwrap();
    if let Some(a) = m.get(path).and_then(|w| w.upgrade()) { return Ok(a); }
    unsafe {
        let bin = binary_path(path);
        let lib = libloading::Library::new(&bin).map_err(|e| format!("cannot load {}: {e}", bin.display()))?;
        let sym = lib.get::<*const clap_plugin_entry>(b"clap_entry\0").map_err(|_| "not a CLAP plugin (no clap_entry)".to_string())?;
        let entry: *const clap_plugin_entry = *sym;
        if entry.is_null() { return Err("clap_entry is null".into()); }
        let p = CString::new(path.to_string_lossy().as_bytes()).unwrap_or_default();
        if let Some(init) = (*entry).init { if !init(p.as_ptr()) { return Err("the CLAP entry refused to initialise".into()); } }
        let l = Arc::new(ClapLib { entry, lib: std::mem::ManuallyDrop::new(lib), path: path.to_path_buf() });
        m.insert(path.to_path_buf(), Arc::downgrade(&l));
        Ok(l)
    }
}

// ================================================================ host side
pub struct HostData {
    owner: u64,
    plugin: AtomicPtr<clap_plugin>,
    callback: AtomicBool,
    restart: AtomicBool,
    flush: AtomicBool,
    rescan: AtomicU32,
    resize: Mutex<Option<(u32, u32)>>,
    timer_ext: AtomicPtr<clap_plugin_timer_support>,
    fd_ext: AtomicPtr<clap_plugin_posix_fd_support>,
    next_timer: AtomicU32,
}
unsafe fn hd<'a>(h: *const clap_host) -> Option<&'a HostData> { if h.is_null() { None } else { ((*h).host_data as *const HostData).as_ref() } }

unsafe extern "C" fn h_get_extension(_h: *const clap_host, id: *const c_char) -> *const c_void {
    if id.is_null() { return std::ptr::null(); }
    let id = CStr::from_ptr(id);
    if id == CLAP_EXT_THREAD_CHECK { return &THREAD_CHECK as *const _ as *const c_void; }
    if id == CLAP_EXT_LOG { return &LOG as *const _ as *const c_void; }
    if id == CLAP_EXT_PARAMS { return &PARAMS as *const _ as *const c_void; }
    if id == CLAP_EXT_STATE { return &STATE as *const _ as *const c_void; }
    if id == CLAP_EXT_GUI { return &GUI as *const _ as *const c_void; }
    if id == CLAP_EXT_TIMER_SUPPORT { return &TIMER as *const _ as *const c_void; }
    if id == CLAP_EXT_POSIX_FD_SUPPORT && cfg!(unix) { return &POSIX_FD as *const _ as *const c_void; }
    if id == CLAP_EXT_LATENCY { return &LATENCY as *const _ as *const c_void; }
    if id == CLAP_EXT_AUDIO_PORTS { return &AUDIO_PORTS as *const _ as *const c_void; }
    if id == CLAP_EXT_NOTE_PORTS { return &NOTE_PORTS as *const _ as *const c_void; }
    std::ptr::null()
}
unsafe extern "C" fn h_request_restart(h: *const clap_host) { if let Some(d) = hd(h) { d.restart.store(true, Ordering::SeqCst); runloop::wake(); } }
unsafe extern "C" fn h_request_process(_h: *const clap_host) {}
unsafe extern "C" fn h_request_callback(h: *const clap_host) { if let Some(d) = hd(h) { d.callback.store(true, Ordering::SeqCst); runloop::wake(); } }

unsafe extern "C" fn tc_main(_h: *const clap_host) -> bool { is_main_thread() }
unsafe extern "C" fn tc_audio(_h: *const clap_host) -> bool { is_audio_thread() }
static THREAD_CHECK: clap_host_thread_check = clap_host_thread_check { is_main_thread: Some(tc_main), is_audio_thread: Some(tc_audio) };
unsafe extern "C" fn log_log(_h: *const clap_host, sev: clap_log_severity, msg: *const c_char) {
    if sev >= CLAP_LOG_WARNING { protocol::log(&format!("clap plugin: {}", ptr_to_string(msg))); }
}
static LOG: clap_host_log = clap_host_log { log: Some(log_log) };
unsafe extern "C" fn p_rescan(h: *const clap_host, flags: clap_param_rescan_flags) { if let Some(d) = hd(h) { d.rescan.fetch_or(flags | 1 << 31, Ordering::SeqCst); runloop::wake(); } }
unsafe extern "C" fn p_clear(_h: *const clap_host, _id: clap_id, _f: clap_param_clear_flags) {}
unsafe extern "C" fn p_request_flush(h: *const clap_host) { if let Some(d) = hd(h) { d.flush.store(true, Ordering::SeqCst); runloop::wake(); } }
static PARAMS: clap_host_params = clap_host_params { rescan: Some(p_rescan), clear: Some(p_clear), request_flush: Some(p_request_flush) };
unsafe extern "C" fn s_dirty(_h: *const clap_host) {}
static STATE: clap_host_state = clap_host_state { mark_dirty: Some(s_dirty) };
unsafe extern "C" fn g_hints(_h: *const clap_host) {}
unsafe extern "C" fn g_resize(h: *const clap_host, w: u32, hh: u32) -> bool { if let Some(d) = hd(h) { *d.resize.lock().unwrap() = Some((w, hh)); runloop::wake(); true } else { false } }
unsafe extern "C" fn g_false(_h: *const clap_host) -> bool { false }
unsafe extern "C" fn g_closed(_h: *const clap_host, _destroyed: bool) {}
static GUI: clap_host_gui = clap_host_gui { resize_hints_changed: Some(g_hints), request_resize: Some(g_resize), request_show: Some(g_false), request_hide: Some(g_false), closed: Some(g_closed) };
unsafe extern "C" fn t_register(h: *const clap_host, period: u32, id: *mut clap_id) -> bool {
    let Some(d) = hd(h) else { return false };
    let tid = d.next_timer.fetch_add(1, Ordering::SeqCst);
    if !id.is_null() { *id = tid; }
    let dp = d as *const HostData;
    runloop::add_timer(d.owner, tid as usize, period as u64, Rc::new(move || {
        let d = &*dp; let p = d.plugin.load(Ordering::SeqCst); let t = d.timer_ext.load(Ordering::SeqCst);
        if !p.is_null() && !t.is_null() { if let Some(f) = (*t).on_timer { f(p, tid); } }
    }));
    true
}
unsafe extern "C" fn t_unregister(h: *const clap_host, id: clap_id) -> bool { hd(h).map(|d| runloop::remove_timer(d.owner, id as usize)).unwrap_or(false) }
static TIMER: clap_host_timer_support = clap_host_timer_support { register_timer: Some(t_register), unregister_timer: Some(t_unregister) };
unsafe extern "C" fn fd_register(h: *const clap_host, fd: i32, flags: clap_posix_fd_flags) -> bool {
    let Some(d) = hd(h) else { return false };
    let dp = d as *const HostData;
    runloop::add_fd(d.owner, fd as usize, fd, flags, Rc::new(move |fd, fl| {
        let d = &*dp; let p = d.plugin.load(Ordering::SeqCst); let e = d.fd_ext.load(Ordering::SeqCst);
        if !p.is_null() && !e.is_null() { if let Some(f) = (*e).on_fd { f(p, fd, fl); } }
    }));
    true
}
unsafe extern "C" fn fd_modify(h: *const clap_host, fd: i32, flags: clap_posix_fd_flags) -> bool { hd(h).map(|d| runloop::modify_fd(d.owner, fd as usize, flags)).unwrap_or(false) }
unsafe extern "C" fn fd_unregister(h: *const clap_host, fd: i32) -> bool { hd(h).map(|d| runloop::remove_fd(d.owner, fd as usize)).unwrap_or(false) }
static POSIX_FD: clap_host_posix_fd_support = clap_host_posix_fd_support { register_fd: Some(fd_register), modify_fd: Some(fd_modify), unregister_fd: Some(fd_unregister) };
unsafe extern "C" fn l_changed(_h: *const clap_host) {}
static LATENCY: clap_host_latency = clap_host_latency { changed: Some(l_changed) };
unsafe extern "C" fn ap_flag(_h: *const clap_host, _f: u32) -> bool { false }
unsafe extern "C" fn ap_rescan(_h: *const clap_host, _f: u32) {}
static AUDIO_PORTS: clap_host_audio_ports = clap_host_audio_ports { is_rescan_flag_supported: Some(ap_flag), rescan: Some(ap_rescan) };
unsafe extern "C" fn np_dialects(_h: *const clap_host) -> clap_note_dialect { CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI }
unsafe extern "C" fn np_rescan(_h: *const clap_host, _f: u32) {}
static NOTE_PORTS: clap_host_note_ports = clap_host_note_ports { supported_dialects: Some(np_dialects), rescan: Some(np_rescan) };

static HOST_NAME: &CStr = c"Auduio";
static HOST_VENDOR: &CStr = c"Auduio";
static HOST_URL: &CStr = c"https://github.com/thebrainwaves/webdaw";
static HOST_VERSION: &CStr = c"0.5.0";

fn make_host(hd: *const HostData) -> Box<clap_host> {
    Box::new(clap_host {
        clap_version: CLAP_VERSION, host_data: hd as *mut c_void, name: HOST_NAME.as_ptr(), vendor: HOST_VENDOR.as_ptr(),
        url: HOST_URL.as_ptr(), version: HOST_VERSION.as_ptr(), get_extension: Some(h_get_extension),
        request_restart: Some(h_request_restart), request_process: Some(h_request_process), request_callback: Some(h_request_callback),
    })
}
fn new_hd(owner: u64) -> Box<HostData> {
    Box::new(HostData { owner, plugin: AtomicPtr::new(std::ptr::null_mut()), callback: AtomicBool::new(false), restart: AtomicBool::new(false), flush: AtomicBool::new(false),
        rescan: AtomicU32::new(0), resize: Mutex::new(None), timer_ext: AtomicPtr::new(std::ptr::null_mut()), fd_ext: AtomicPtr::new(std::ptr::null_mut()), next_timer: AtomicU32::new(1) })
}
unsafe fn ext<T>(p: *const clap_plugin, id: &CStr) -> *const T {
    match (*p).get_extension { Some(g) => g(p, id.as_ptr()) as *const T, None => std::ptr::null() }
}
unsafe fn port_channels(p: *const clap_plugin, input: bool) -> Vec<u32> {
    let ap: *const clap_plugin_audio_ports = ext(p, CLAP_EXT_AUDIO_PORTS);
    if ap.is_null() { return vec![]; }
    let (Some(count), Some(get)) = ((*ap).count, (*ap).get) else { return vec![] };
    (0..count(p, input)).map(|i| { let mut info: clap_audio_port_info = std::mem::zeroed(); if get(p, i, input, &mut info) { info.channel_count } else { 0 } }).collect()
}

// ================================================================ scanning
struct Desc { id: String, name: String, vendor: String, version: String, features: Vec<String> }
unsafe fn descriptors(lib: &ClapLib) -> Vec<Desc> {
    let Some(f) = lib.factory() else { return vec![] };
    let (Some(count), Some(get)) = (f.get_plugin_count, f.get_plugin_descriptor) else { return vec![] };
    let mut out = vec![];
    for i in 0..count(f) {
        let d = get(f, i); if d.is_null() { continue; }
        let d = &*d;
        let mut feats = vec![];
        if !d.features.is_null() { let mut k = 0; while !(*d.features.add(k)).is_null() { feats.push(ptr_to_string(*d.features.add(k))); k += 1; } }
        out.push(Desc { id: ptr_to_string(d.id), name: ptr_to_string(d.name), vendor: ptr_to_string(d.vendor), version: ptr_to_string(d.version), features: feats });
    }
    out
}
pub fn scan_file(path: &Path) -> Result<Vec<Value>, String> {
    let lib = load_lib(path)?;
    let file = path.to_string_lossy().into_owned();
    let modified = mtime_ms(path);
    let mut out = vec![];
    unsafe {
        let f = lib.factory().ok_or("no plugin factory")?;
        for d in descriptors(&lib) {
            let (mut ins, mut outs) = (0u32, 0u32);
            let hdata = new_hd(0);
            let host = make_host(&*hdata);
            let cid = CString::new(d.id.clone()).unwrap_or_default();
            if let Some(create) = f.create_plugin {
                let p = create(f, &*host, cid.as_ptr());
                if !p.is_null() {
                    hdata.plugin.store(p as *mut _, Ordering::SeqCst);
                    if (*p).init.map(|i| i(p)).unwrap_or(false) {
                        ins = port_channels(p, true).iter().sum(); outs = port_channels(p, false).iter().sum();
                    }
                    if let Some(destroy) = (*p).destroy { destroy(p); }
                    runloop::remove_owner(0);
                }
            }
            let hash = juce_hash(&d.id);
            let inst = d.features.iter().any(|x| x == "instrument");
            out.push(json!({
                "uid": juce_identifier("CLAP", &d.name, &file, hash, hash), "name": d.name, "descriptiveName": d.name, "format": "CLAP",
                "category": d.features.join("|"), "vendor": d.vendor, "version": d.version, "file": file, "uniqueId": hash, "deprecatedUid": hash,
                "clapId": d.id, "isInstrument": inst, "inputs": ins, "outputs": outs, "modified": modified
            }));
        }
    }
    Ok(out)
}

// ================================================================ instance
#[repr(C)]
#[derive(Clone, Copy)]
union ClapEv { header: clap_event_header, note: clap_event_note, midi: clap_event_midi, param: clap_event_param_value }

enum UiMsg { Change(usize, f64), Gesture(usize, i32) }

struct Rt {
    rx: rtrb::Consumer<(usize, f64)>,
    ui_tx: rtrb::Producer<UiMsg>,
    processing: bool,
    evs: Vec<ClapEv>,
    nev: usize,
    index_of: Vec<(u32, usize)>,  // sorted by id
    inbufs: Vec<Vec<f32>>,
    dummy: Vec<Vec<f32>>,
    in_ptrs: Vec<*mut f32>,
    out_ptrs: Vec<*mut f32>,
    in_ab: Vec<clap_audio_buffer>,
    out_ab: Vec<clap_audio_buffer>,
    transport: clap_event_transport,
    steady: i64,
}
impl Rt {
    fn lookup(&self, id: u32) -> Option<usize> { self.index_of.binary_search_by_key(&id, |x| x.0).ok().map(|k| self.index_of[k].1) }
    fn push(&mut self, e: ClapEv) { if self.nev < self.evs.len() { self.evs[self.nev] = e; self.nev += 1; } }
}
unsafe extern "C" fn in_size(l: *const clap_input_events) -> u32 { (*((*l).ctx as *const Rt)).nev as u32 }
unsafe extern "C" fn in_get(l: *const clap_input_events, i: u32) -> *const clap_event_header {
    let rt = &*((*l).ctx as *const Rt);
    if (i as usize) < rt.nev { &rt.evs[i as usize].header } else { std::ptr::null() }
}
unsafe extern "C" fn out_push(l: *const clap_output_events, ev: *const clap_event_header) -> bool {
    if ev.is_null() || (*l).ctx.is_null() { return false; }
    let rt = &mut *((*l).ctx as *mut Rt);
    if (*ev).space_id != CLAP_CORE_EVENT_SPACE_ID { return true; }
    match (*ev).type_ {
        CLAP_EVENT_PARAM_VALUE => { let p = &*(ev as *const clap_event_param_value); if let Some(i) = rt.lookup(p.param_id) { let _ = rt.ui_tx.push(UiMsg::Change(i, p.value)); } }
        CLAP_EVENT_PARAM_GESTURE_BEGIN | CLAP_EVENT_PARAM_GESTURE_END => {
            let p = &*(ev as *const clap_event_param_gesture);
            if let Some(i) = rt.lookup(p.param_id) { let _ = rt.ui_tx.push(UiMsg::Gesture(i, if (*ev).type_ == CLAP_EVENT_PARAM_GESTURE_BEGIN { 1 } else { 2 })); }
        }
        _ => {}
    }
    true
}

struct PInfo { id: clap_id, cookie: *mut c_void, min: f64, max: f64, stepped: bool }

pub struct ClapInstance {
    id: i32,
    desc: Value,
    plugin: *const clap_plugin,
    params_ext: *const clap_plugin_params,
    state_ext: *const clap_plugin_state,
    gui_ext: *const clap_plugin_gui,
    latency_ext: *const clap_plugin_latency,
    params: Vec<ParamDesc>,
    pinfo: Vec<PInfo>,
    values: Vec<AtomicU64>,   // plain values (host cache)
    in_ch: Vec<u32>,
    out_ch: Vec<u32>,
    dialects: u32,
    has_notes: bool,
    to_rt: Mutex<rtrb::Producer<(usize, f64)>>,
    ui_rx: Mutex<rtrb::Consumer<UiMsg>>,
    main_ui: Mutex<Vec<(usize, f32)>>,
    active: AtomicBool,
    editor: Mutex<Option<(u64, bool)>>,
    rt: UnsafeCell<Rt>,
    _host: Box<clap_host>,
    hd: Box<HostData>,
    _lib: Arc<ClapLib>,
}
unsafe impl Send for ClapInstance {}
unsafe impl Sync for ClapInstance {}

impl ClapInstance {
    pub fn create(id: i32, desc: &Value, sample_rate: f64) -> Result<ClapInstance, String> {
        let file = desc["file"].as_str().unwrap_or("").to_string();
        let lib = load_lib(Path::new(&file))?;
        unsafe {
            let descs = descriptors(&lib);
            let want = desc["clapId"].as_str().map(|s| s.to_string());
            let d = descs.iter().find(|d| Some(&d.id) == want.as_ref()).or_else(|| descs.iter().find(|d| Some(d.name.as_str()) == desc["name"].as_str()))
                .ok_or_else(|| format!("plugin not found in {file}"))?;
            let f = lib.factory().ok_or("no plugin factory")?;
            let owner = 0x434c_0000_0000_0000u64 | id as u64;
            let hdata = new_hd(owner);
            let host = make_host(&*hdata);
            let cid = CString::new(d.id.clone()).unwrap_or_default();
            let p = f.create_plugin.ok_or("factory cannot create plugins")?(f, &*host, cid.as_ptr());
            if p.is_null() { return Err("the plugin refused to create an instance".into()); }
            hdata.plugin.store(p as *mut _, Ordering::SeqCst);
            if !(*p).init.map(|i| i(p)).unwrap_or(false) { if let Some(ds) = (*p).destroy { ds(p); } return Err("plugin init failed".into()); }
            hdata.timer_ext.store(ext::<clap_plugin_timer_support>(p, CLAP_EXT_TIMER_SUPPORT) as *mut _, Ordering::SeqCst);
            hdata.fd_ext.store(ext::<clap_plugin_posix_fd_support>(p, CLAP_EXT_POSIX_FD_SUPPORT) as *mut _, Ordering::SeqCst);
            let params_ext: *const clap_plugin_params = ext(p, CLAP_EXT_PARAMS);
            let (params, pinfo, values) = read_params(p, params_ext);
            let mut index_of: Vec<(u32, usize)> = pinfo.iter().enumerate().map(|(i, x)| (x.id, i)).collect();
            index_of.sort();
            let in_ch = port_channels(p, true); let out_ch = port_channels(p, false);
            let np: *const clap_plugin_note_ports = ext(p, CLAP_EXT_NOTE_PORTS);
            let (mut dialects, mut has_notes) = (0u32, false);
            if !np.is_null() { if let (Some(c), Some(g)) = ((*np).count, (*np).get) { if c(p, true) > 0 { let mut ni: clap_note_port_info = std::mem::zeroed(); if g(p, 0, true, &mut ni) { dialects = ni.supported_dialects; has_notes = true; } } } }
            let (tx, rx) = rtrb::RingBuffer::new(32768);
            let (utx, urx) = rtrb::RingBuffer::new(8192);
            let tot_in: usize = in_ch.iter().map(|&c| c as usize).sum(); let tot_out: usize = out_ch.iter().map(|&c| c as usize).sum();
            let rt = Rt {
                rx, ui_tx: utx, processing: false, evs: vec![std::mem::zeroed(); 4096], nev: 0, index_of,
                inbufs: (0..tot_in).map(|_| vec![0.0; MAX_BLOCK]).collect(), dummy: (0..tot_out + tot_in).map(|_| vec![0.0; MAX_BLOCK]).collect(),
                in_ptrs: vec![std::ptr::null_mut(); tot_in], out_ptrs: vec![std::ptr::null_mut(); tot_out],
                in_ab: vec![std::mem::zeroed(); in_ch.len()], out_ab: vec![std::mem::zeroed(); out_ch.len()], transport: std::mem::zeroed(), steady: 0,
            };
            let inst = ClapInstance {
                id, desc: desc.clone(), plugin: p, params_ext, state_ext: ext(p, CLAP_EXT_STATE), gui_ext: ext(p, CLAP_EXT_GUI), latency_ext: ext(p, CLAP_EXT_LATENCY),
                params, pinfo, values, in_ch, out_ch, dialects, has_notes, to_rt: Mutex::new(tx), ui_rx: Mutex::new(urx), main_ui: Mutex::new(vec![]),
                active: AtomicBool::new(false), editor: Mutex::new(None), rt: UnsafeCell::new(rt), _host: host, hd: hdata, _lib: lib,
            };
            inst.prepare(sample_rate);
            Ok(inst)
        }
    }
    fn norm(&self, i: usize, plain: f64) -> f32 { let p = &self.pinfo[i]; if p.max > p.min { ((plain - p.min) / (p.max - p.min)).clamp(0.0, 1.0) as f32 } else { 0.0 } }
    fn plain(&self, i: usize, v: f32) -> f64 { let p = &self.pinfo[i]; let x = p.min + (v as f64).clamp(0.0, 1.0) * (p.max - p.min); if p.stepped { x.round() } else { x } }
    fn cached(&self, i: usize) -> f64 { f64::from_bits(self.values[i].load(Ordering::Relaxed)) }
    fn refresh(&self, report: bool) -> Vec<(usize, f32)> {
        let mut ch = vec![];
        if self.params_ext.is_null() { return ch; }
        unsafe {
            let Some(get) = (*self.params_ext).get_value else { return ch };
            for (i, p) in self.pinfo.iter().enumerate() {
                let mut v = 0.0; if get(self.plugin, p.id, &mut v) && (v - self.cached(i)).abs() > 1e-9 { self.values[i].store(v.to_bits(), Ordering::Relaxed); if report { ch.push((i, self.norm(i, v))); } }
            }
        }
        ch
    }
    fn stop(&self) {
        unsafe {
            let rt = &mut *self.rt.get();
            let _a = AudioScope::enter();
            if rt.processing { if let Some(s) = (*self.plugin).stop_processing { s(self.plugin); } rt.processing = false; }
        }
        if self.active.swap(false, Ordering::SeqCst) { unsafe { if let Some(d) = (*self.plugin).deactivate { d(self.plugin); } } }
    }
    /// params.flush from the main thread, allowed while nobody processes (no device, no render)
    fn flush_now(&self) {
        if self.params_ext.is_null() || DEVICE_RUNNING.load(Ordering::SeqCst) { return; }
        unsafe {
            let Some(flush) = (*self.params_ext).flush else { return };
            let _a = AudioScope::enter();
            let rt = &mut *self.rt.get();
            rt.nev = 0;
            while let Ok((i, v)) = rt.rx.pop() { let e = self.param_ev(i, v, 0); rt.push(e); }
            let ctx = rt as *mut Rt as *mut c_void;
            let inl = clap_input_events { ctx, size: Some(in_size), get: Some(in_get) };
            let outl = clap_output_events { ctx, try_push: Some(out_push) };
            flush(self.plugin, &inl, &outl);
            rt.nev = 0;
        }
    }
    fn param_ev(&self, i: usize, plain: f64, time: u32) -> ClapEv {
        let p = &self.pinfo[i];
        ClapEv { param: clap_event_param_value {
            header: clap_event_header { size: std::mem::size_of::<clap_event_param_value>() as u32, time, space_id: CLAP_CORE_EVENT_SPACE_ID, type_: CLAP_EVENT_PARAM_VALUE, flags: 0 },
            param_id: p.id, cookie: p.cookie, note_id: -1, port_index: -1, channel: -1, key: -1, value: plain } }
    }
}
unsafe fn read_params(p: *const clap_plugin, pe: *const clap_plugin_params) -> (Vec<ParamDesc>, Vec<PInfo>, Vec<AtomicU64>) {
    let (mut params, mut pinfo, mut values) = (vec![], vec![], vec![]);
    if pe.is_null() { return (params, pinfo, values); }
    let (Some(count), Some(get_info), Some(get_value)) = ((*pe).count, (*pe).get_info, (*pe).get_value) else { return (params, pinfo, values) };
    for i in 0..count(p).min(65536) {
        let mut info: clap_param_info = std::mem::zeroed();
        if !get_info(p, i, &mut info) { continue; }
        let stepped = info.flags & CLAP_PARAM_IS_STEPPED != 0;
        let range = info.max_value - info.min_value;
        let nsteps = if stepped { (range.round() as i64 + 1).max(1) } else { CONTINUOUS_STEPS };
        let def = if range > 0.0 { ((info.default_value - info.min_value) / range) as f32 } else { 0.0 };
        let mut v = info.default_value; get_value(p, info.id, &mut v);
        let mut options = None;
        if stepped && nsteps > 1 && nsteps <= 64 {
            if let Some(tt) = (*pe).value_to_text {
                let mut o = vec![];
                for k in 0..nsteps { let mut buf = [0 as c_char; 256]; let val = info.min_value + k as f64; o.push(if tt(p, info.id, val, buf.as_mut_ptr(), 256) { cstr_to_string(&buf) } else { format!("{val}") }); }
                options = Some(o);
            }
        }
        params.push(ParamDesc {
            id: info.id.to_string(), name: cstr_to_string(&info.name), label: String::new(), def, steps: nsteps, discrete: stepped,
            boolean: stepped && (range - 1.0).abs() < 1e-9, automatable: info.flags & CLAP_PARAM_IS_AUTOMATABLE != 0,
            hidden: info.flags & CLAP_PARAM_IS_HIDDEN != 0, readonly: info.flags & CLAP_PARAM_IS_READONLY != 0, options,
        });
        pinfo.push(PInfo { id: info.id, cookie: info.cookie, min: info.min_value, max: info.max_value, stepped });
        values.push(AtomicU64::new(v.to_bits()));
    }
    (params, pinfo, values)
}

impl Drop for ClapInstance {
    fn drop(&mut self) {
        self.close_editor();
        self.stop();
        runloop::remove_owner(self.hd.owner);
        unsafe { if let Some(d) = (*self.plugin).destroy { d(self.plugin); } }
        self.hd.plugin.store(std::ptr::null_mut(), Ordering::SeqCst);
    }
}

// state streams
unsafe extern "C" fn os_write(s: *const clap_ostream, buf: *const c_void, n: u64) -> i64 {
    let v = &mut *((*s).ctx as *mut Vec<u8>); v.extend_from_slice(std::slice::from_raw_parts(buf as *const u8, n as usize)); n as i64
}
unsafe extern "C" fn is_read(s: *const clap_istream, buf: *mut c_void, n: u64) -> i64 {
    let (d, pos) = &mut *((*s).ctx as *mut (&[u8], usize));
    let k = (n as usize).min(d.len() - *pos);
    std::ptr::copy_nonoverlapping(d.as_ptr().add(*pos), buf as *mut u8, k); *pos += k; k as i64
}

impl Plugin for ClapInstance {
    fn id(&self) -> i32 { self.id }
    fn load_info(&self) -> LoadInfo {
        let lat = unsafe { if self.latency_ext.is_null() { 0 } else { (*self.latency_ext).get.map(|g| g(self.plugin)).unwrap_or(0) } };
        LoadInfo { has_editor: !self.gui_ext.is_null(), latency: lat, inputs: self.in_ch.iter().sum(), outputs: self.out_ch.iter().sum(), accepts_midi: self.has_notes }
    }
    fn params(&self) -> Vec<ParamDesc> { self.params.clone() }
    fn param_count(&self) -> usize { self.params.len() }
    fn param_value(&self, i: usize) -> f32 { if i < self.pinfo.len() { self.norm(i, self.cached(i)) } else { 0.0 } }
    fn param_text(&self, i: usize, v: f32) -> String {
        if i >= self.pinfo.len() || self.params_ext.is_null() { return String::new(); }
        let plain = self.plain(i, v);
        unsafe {
            let mut buf = [0 as c_char; 256];
            if let Some(tt) = (*self.params_ext).value_to_text { if tt(self.plugin, self.pinfo[i].id, plain, buf.as_mut_ptr(), 256) { return cstr_to_string(&buf); } }
        }
        format!("{plain:.4}")
    }
    fn set_param(&self, i: usize, v: f32, notify: bool) {
        if i >= self.pinfo.len() { return; }
        let plain = self.plain(i, v);
        self.values[i].store(plain.to_bits(), Ordering::Relaxed);
        let _ = self.to_rt.lock().unwrap().push((i, plain));
        if notify { self.main_ui.lock().unwrap().push((i, v)); }
    }
    fn get_state(&self) -> Result<Vec<u8>, String> {
        if self.state_ext.is_null() { return Err("this plugin cannot save its state".into()); }
        let mut v: Vec<u8> = vec![];
        let s = clap_ostream { ctx: &mut v as *mut Vec<u8> as *mut c_void, write: Some(os_write) };
        let ok = unsafe { (*self.state_ext).save.map(|f| f(self.plugin, &s)).unwrap_or(false) };
        if ok { Ok(v) } else { Err("the plugin failed to save its state".into()) }
    }
    fn set_state(&self, data: &[u8]) -> Result<(), String> {
        if self.state_ext.is_null() { return Err("this plugin cannot load a state".into()); }
        let mut ctx: (&[u8], usize) = (data, 0);
        let s = clap_istream { ctx: &mut ctx as *mut _ as *mut c_void, read: Some(is_read) };
        let ok = unsafe { (*self.state_ext).load.map(|f| f(self.plugin, &s)).unwrap_or(false) };
        self.refresh(false);
        if ok { Ok(()) } else { Err("the plugin rejected the state".into()) }
    }
    fn prepare(&self, sample_rate: f64) {
        self.stop();
        let ok = unsafe { (*self.plugin).activate.map(|a| a(self.plugin, sample_rate, 1, MAX_BLOCK as u32)).unwrap_or(false) };
        self.active.store(ok, Ordering::SeqCst);
        unsafe { (*self.rt.get()).transport.tempo = 120.0; }
    }
    fn reset(&self) {
        unsafe {
            let rt = &mut *self.rt.get();
            if rt.processing { let _a = AudioScope::enter(); if let Some(r) = (*self.plugin).reset { r(self.plugin); } }
        }
    }
    fn open_editor(&self, title: &str) -> Result<(u32, u32), String> {
        let mut ed = self.editor.lock().unwrap();
        if let Some((w, _)) = *ed { window::raise(w); return Ok((0, 0)); }
        if self.gui_ext.is_null() { return Err("this plugin has no editor window".into()); }
        #[cfg(all(unix, not(target_os = "macos")))]
        let api = CLAP_WINDOW_API_X11;
        #[cfg(windows)]
        let api = CLAP_WINDOW_API_WIN32;
        #[cfg(target_os = "macos")]
        let api = CLAP_WINDOW_API_COCOA;
        unsafe {
            let g = &*self.gui_ext;
            if !g.is_api_supported.map(|f| f(self.plugin, api.as_ptr(), false)).unwrap_or(false) { return Err("the plugin editor does not support this window system".into()); }
            if !window::available() { return Err("no display available for plugin windows".into()); }
            if !g.create.map(|f| f(self.plugin, api.as_ptr(), false)).unwrap_or(false) { return Err("the plugin could not create its editor".into()); }
            let (mut w, mut h) = (0u32, 0u32);
            g.get_size.map(|f| f(self.plugin, &mut w, &mut h));
            if w < 10 || h < 10 { w = 640; h = 400; }
            let resizable = g.can_resize.map(|f| f(self.plugin)).unwrap_or(false);
            let win = match window::create(title, w, h, resizable) { Ok(x) => x, Err(e) => { g.destroy.map(|f| f(self.plugin)); return Err(e); } };
            #[cfg(all(unix, not(target_os = "macos")))]
            let cw = clap_window { api: api.as_ptr(), specific: clap_window_handle { x11: win as std::ffi::c_ulong } };
            #[cfg(not(all(unix, not(target_os = "macos"))))]
            let cw = clap_window { api: api.as_ptr(), specific: clap_window_handle { ptr: win as usize as *mut c_void } };
            if !g.set_parent.map(|f| f(self.plugin, &cw)).unwrap_or(false) { g.destroy.map(|f| f(self.plugin)); window::destroy(win); return Err("the plugin editor could not attach to the window".into()); }
            g.show.map(|f| f(self.plugin));
            window::flush();
            *ed = Some((win, resizable));
            Ok((w, h))
        }
    }
    fn close_editor(&self) {
        let e = self.editor.lock().unwrap().take();
        if let Some((win, _)) = e {
            unsafe { let g = &*self.gui_ext; g.hide.map(|f| f(self.plugin)); g.destroy.map(|f| f(self.plugin)); }
            window::destroy(win);
        }
    }
    fn editor_is_open(&self) -> bool { self.editor.lock().unwrap().is_some() }
    fn raise_editor(&self) { if let Some((w, _)) = *self.editor.lock().unwrap() { window::raise(w); } }
    fn editor_window(&self) -> Option<u64> { self.editor.lock().unwrap().map(|x| x.0) }
    fn window_resized(&self, w: u32, h: u32) {
        let ed = *self.editor.lock().unwrap();
        if let Some((_, true)) = ed { unsafe { let g = &*self.gui_ext; let (mut a, mut b) = (w, h); g.adjust_size.map(|f| f(self.plugin, &mut a, &mut b)); g.set_size.map(|f| f(self.plugin, a, b)); } }
    }
    fn idle(&self) {
        unsafe {
            if self.hd.callback.swap(false, Ordering::SeqCst) { if let Some(f) = (*self.plugin).on_main_thread { f(self.plugin); } }
            if let Some((w, h)) = self.hd.resize.lock().unwrap().take() {
                if let Some((win, r)) = *self.editor.lock().unwrap() { window::resize(win, w, h, r); window::flush(); let g = &*self.gui_ext; g.set_size.map(|f| f(self.plugin, w, h)); }
            }
        }
        let rs = self.hd.rescan.swap(0, Ordering::SeqCst);
        if rs != 0 {
            let ch = self.refresh(true);
            self.main_ui.lock().unwrap().extend(ch);
        }
        let pending = self.to_rt.lock().map(|p| p.slots() < 32768).unwrap_or(false);
        if self.hd.flush.swap(false, Ordering::SeqCst) || (pending && !DEVICE_RUNNING.load(Ordering::SeqCst)) { self.flush_now(); }
        if self.hd.restart.swap(false, Ordering::SeqCst) { protocol::log("a CLAP plugin asked for a restart (not supported yet: reload it)"); }
    }
    fn drain_ui(&self, changes: &mut Vec<(usize, f32)>, gestures: &mut Vec<(usize, i32)>) {
        changes.extend(self.main_ui.lock().unwrap().drain(..));
        let mut rx = self.ui_rx.lock().unwrap();
        while let Ok(m) = rx.pop() {
            match m {
                UiMsg::Change(i, v) => { if i < self.values.len() { self.values[i].store(v.to_bits(), Ordering::Relaxed); changes.push((i, self.norm(i, v))); } }
                UiMsg::Gesture(i, g) => gestures.push((i, g)),
            }
        }
    }
    unsafe fn process(&self, chans: &[*mut f32], n: usize, events: &[Ev], tr: &Transport) {
        if !self.active.load(Ordering::Relaxed) || n == 0 { return; }
        let n = n.min(MAX_BLOCK);
        let rt = &mut *self.rt.get();
        if !rt.processing {
            if (*self.plugin).start_processing.map(|s| s(self.plugin)).unwrap_or(true) { rt.processing = true; } else { return; }
        }
        rt.nev = 0;
        while let Ok((i, v)) = rt.rx.pop() { let e = self.param_ev(i, v, 0); rt.push(e); }
        let clap_notes = self.dialects & CLAP_NOTE_DIALECT_CLAP != 0;
        for ev in events {
            match *ev {
                Ev::Param { offset, inst, index, value } if inst == self.id && (index as usize) < self.pinfo.len() => {
                    let plain = self.plain(index as usize, value);
                    self.values[index as usize].store(plain.to_bits(), Ordering::Relaxed);
                    let e = self.param_ev(index as usize, plain, offset); rt.push(e);
                }
                Ev::Param { .. } => {}
                Ev::Midi { offset, data } => {
                    if !self.has_notes { continue; }
                    let st = data[0] & 0xF0;
                    let hdr = |ty: u16, size: usize| clap_event_header { size: size as u32, time: offset, space_id: CLAP_CORE_EVENT_SPACE_ID, type_: ty, flags: CLAP_EVENT_IS_LIVE };
                    if clap_notes && (st == 0x90 || st == 0x80) {
                        let on = st == 0x90 && data[2] > 0;
                        let e = ClapEv { note: clap_event_note { header: hdr(if on { CLAP_EVENT_NOTE_ON } else { CLAP_EVENT_NOTE_OFF }, std::mem::size_of::<clap_event_note>()), note_id: -1, port_index: 0, channel: (data[0] & 0x0F) as i16, key: data[1] as i16, velocity: data[2] as f64 / 127.0 } };
                        rt.push(e);
                    } else if self.dialects & CLAP_NOTE_DIALECT_MIDI != 0 {
                        let e = ClapEv { midi: clap_event_midi { header: hdr(CLAP_EVENT_MIDI, std::mem::size_of::<clap_event_midi>()), port_index: 0, data } };
                        rt.push(e);
                    }
                }
            }
        }
        // audio ports: main input gets a copy of the track signal, main output renders in place
        let mut k = 0usize; let mut dk = 0usize;
        for (b, &c) in self.in_ch.iter().enumerate() {
            let start = k;
            for ci in 0..c as usize {
                let buf = &mut rt.inbufs[k];
                if b == 0 && ci < chans.len() { std::ptr::copy_nonoverlapping(chans[ci], buf.as_mut_ptr(), n); } else { buf[..n].fill(0.0); }
                rt.in_ptrs[k] = buf.as_mut_ptr(); k += 1;
            }
            rt.in_ab[b] = clap_audio_buffer { data32: rt.in_ptrs.as_mut_ptr().add(start), data64: std::ptr::null_mut(), channel_count: c, latency: 0, constant_mask: 0 };
        }
        let mut k = 0usize;
        for (b, &c) in self.out_ch.iter().enumerate() {
            let start = k;
            for ci in 0..c as usize { rt.out_ptrs[k] = if b == 0 && ci < chans.len() { chans[ci] } else { let p = rt.dummy[dk].as_mut_ptr(); dk += 1; p }; k += 1; }
            rt.out_ab[b] = clap_audio_buffer { data32: rt.out_ptrs.as_mut_ptr().add(start), data64: std::ptr::null_mut(), channel_count: c, latency: 0, constant_mask: 0 };
        }
        let t = &mut rt.transport;
        t.header = clap_event_header { size: std::mem::size_of::<clap_event_transport>() as u32, time: 0, space_id: CLAP_CORE_EVENT_SPACE_ID, type_: CLAP_EVENT_TRANSPORT, flags: 0 };
        t.flags = CLAP_TRANSPORT_HAS_TEMPO | CLAP_TRANSPORT_HAS_BEATS_TIMELINE | CLAP_TRANSPORT_HAS_SECONDS_TIMELINE | CLAP_TRANSPORT_HAS_TIME_SIGNATURE | if tr.playing { CLAP_TRANSPORT_IS_PLAYING } else { 0 };
        t.song_pos_beats = (tr.ppq * CLAP_BEATTIME_FACTOR as f64) as i64;
        t.song_pos_seconds = ((tr.time_samples as f64 / tr.sample_rate.max(1.0)) * CLAP_SECTIME_FACTOR as f64) as i64;
        t.tempo = tr.bpm; t.bar_start = (tr.bar_start_ppq * CLAP_BEATTIME_FACTOR as f64) as i64;
        t.bar_number = if tr.num > 0 { (tr.bar_start_ppq / (tr.num as f64 * 4.0 / tr.den.max(1) as f64)) as i32 } else { 0 };
        t.tsig_num = tr.num as u16; t.tsig_denom = tr.den as u16;
        let ctx = rt as *mut Rt as *mut c_void;
        let inl = clap_input_events { ctx, size: Some(in_size), get: Some(in_get) };
        let outl = clap_output_events { ctx, try_push: Some(out_push) };
        let proc_ = clap_process {
            steady_time: rt.steady, frames_count: n as u32, transport: &rt.transport,
            audio_inputs: if self.in_ch.is_empty() { std::ptr::null() } else { rt.in_ab.as_ptr() },
            audio_outputs: if self.out_ch.is_empty() { std::ptr::null_mut() } else { rt.out_ab.as_mut_ptr() },
            audio_inputs_count: self.in_ch.len() as u32, audio_outputs_count: self.out_ch.len() as u32,
            in_events: &inl, out_events: &outl,
        };
        if let Some(pf) = (*self.plugin).process { pf(self.plugin, &proc_); }
        rt.steady += n as i64;
        rt.nev = 0;
    }
    fn describe(&self) -> Value { self.desc.clone() }
}
