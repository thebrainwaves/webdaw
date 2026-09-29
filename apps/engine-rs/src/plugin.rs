//! Format-independent view of a hosted plugin instance (VST3 or CLAP).
//!
//! Threading contract (mirrors both plugin APIs):
//! - everything except `process` is called on the main (message) thread only;
//! - `process` is called by exactly one thread at a time: the audio device thread, or the main thread
//!   while it renders offline (the engine guarantees the device thread skips the track meanwhile).
use serde_json::{json, Value};

pub const MAX_BLOCK: usize = 4096;
pub const MAX_CHANNELS: usize = 32;

#[derive(Clone, Debug, Default)]
pub struct ParamDesc {
    pub id: String,
    pub name: String,
    pub label: String,
    pub def: f32,
    pub steps: i64,        // JUCE semantics: stepped -> number of values, continuous -> 0x7fffffff
    pub discrete: bool,
    pub boolean: bool,
    pub automatable: bool,
    pub hidden: bool,
    pub readonly: bool,
    pub options: Option<Vec<String>>,
}
pub const CONTINUOUS_STEPS: i64 = 0x7fffffff;

/// A timed event for one processing block (offset in samples from the block start)
#[derive(Clone, Copy, Debug)]
pub enum Ev {
    Midi { offset: u32, data: [u8; 3] },
    Param { offset: u32, inst: i32, index: u32, value: f32 },
}
impl Ev {
    pub fn offset(&self) -> u32 { match self { Ev::Midi { offset, .. } | Ev::Param { offset, .. } => *offset } }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Transport {
    pub sample_rate: f64,
    pub playing: bool,
    pub bpm: f64,
    pub ppq: f64,
    pub bar_start_ppq: f64,
    pub num: i32,
    pub den: i32,
    pub time_samples: i64,
}

pub struct LoadInfo {
    pub has_editor: bool,
    pub latency: u32,
    pub inputs: u32,
    pub outputs: u32,
    pub accepts_midi: bool,
}

pub trait Plugin: Send + Sync {
    fn id(&self) -> i32;
    fn load_info(&self) -> LoadInfo;
    fn params(&self) -> Vec<ParamDesc>;
    fn param_count(&self) -> usize;
    fn param_value(&self, index: usize) -> f32;
    fn param_text(&self, index: usize, value: f32) -> String;
    /// host sets a value right now (JUCE setValue); `notify` = report it in `params` events like an editor move
    fn set_param(&self, index: usize, value: f32, notify: bool);
    fn get_state(&self) -> Result<Vec<u8>, String>;
    fn set_state(&self, data: &[u8]) -> Result<(), String>;
    /// (re)configure for a sample rate; no processing may run concurrently
    fn prepare(&self, sample_rate: f64);
    /// clear voices/tails (before and after an offline render); no processing may run concurrently
    fn reset(&self);
    fn open_editor(&self, title: &str) -> Result<(u32, u32), String>;
    fn close_editor(&self);
    fn editor_is_open(&self) -> bool;
    fn raise_editor(&self) {}
    fn editor_window(&self) -> Option<u64> { None }
    /// main-thread housekeeping, ~50 times a second
    fn idle(&self) {}
    /// parameter changes / gestures made inside the plugin since the last call
    fn drain_ui(&self, changes: &mut Vec<(usize, f32)>, gestures: &mut Vec<(usize, i32)>);
    /// channels: per-channel pointers (len >= the plugin's channel count is not required; missing
    /// channels are handled by the implementation). Buffers hold `n` <= MAX_BLOCK samples; in-place.
    /// # Safety
    /// See the threading contract above; pointers must be valid for `n` samples.
    unsafe fn process(&self, channels: &[*mut f32], n: usize, events: &[Ev], transport: &Transport);
    fn describe(&self) -> Value;
    /// offline render flag (VST3 kOffline process mode / CLAP render mode hint)
    fn set_offline(&self, _on: bool) {}
    /// the user resized the editor window
    fn window_resized(&self, _w: u32, _h: u32) {}
}

pub fn param_json(i: usize, p: &ParamDesc, value: f32, text: String) -> Value {
    let mut o = json!({
        "i": i, "id": p.id, "name": p.name, "label": p.label, "def": p.def, "value": value, "text": text,
        "steps": p.steps, "discrete": p.discrete, "bool": p.boolean, "automatable": p.automatable,
        "meta": false, "category": 0
    });
    if p.hidden || hidden_param_name(&p.name) { o["hidden"] = json!(true); }
    if let Some(opts) = &p.options { o["options"] = json!(opts); }
    o
}
/// VST3 MIDI-CC emulation params ("MIDI CC 0|7" etc, exposed by JUCE-built plugins)
pub fn hidden_param_name(n: &str) -> bool { n.starts_with("MIDI CC ") && n.contains('|') }

/// true while the audio device is running (the device thread may call `process` at any time)
pub static DEVICE_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub static MAIN_THREAD: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();
thread_local! { pub static IN_AUDIO: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
pub fn is_main_thread() -> bool { MAIN_THREAD.get().map(|t| *t == std::thread::current().id()).unwrap_or(false) }
pub fn is_audio_thread() -> bool { IN_AUDIO.with(|c| c.get()) }
/// marks the current thread as "the audio thread" for the duration of the guard
pub struct AudioScope(bool);
impl AudioScope { pub fn enter() -> AudioScope { AudioScope(IN_AUDIO.with(|c| c.replace(true))) } }
impl Drop for AudioScope { fn drop(&mut self) { let p = self.0; IN_AUDIO.with(|c| c.set(p)); } }
