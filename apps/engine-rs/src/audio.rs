//! The realtime side: an immutable snapshot of tracks/plugin chains ("graph") handed to the audio
//! callback through a lock-free ring, per-track lock-free event queues, and the cpal output stream.
//! The audio thread never locks, allocates or frees: old graphs go back to the main thread for
//! deallocation, and plugin instances are only destroyed on the main thread after the audio thread
//! has acknowledged a graph that no longer contains them.
use crate::plugin::*;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Value};
use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

pub struct AtomicF64(AtomicU64);
impl AtomicF64 {
    pub fn new(v: f64) -> Self { AtomicF64(AtomicU64::new(v.to_bits())) }
    pub fn get(&self) -> f64 { f64::from_bits(self.0.load(Ordering::Relaxed)) }
    pub fn set(&self, v: f64) { self.0.store(v.to_bits(), Ordering::Relaxed) }
}
pub struct AtomicF32(AtomicU32);
impl AtomicF32 {
    pub fn new(v: f32) -> Self { AtomicF32(AtomicU32::new(v.to_bits())) }
    pub fn get(&self) -> f32 { f32::from_bits(self.0.load(Ordering::Relaxed)) }
    pub fn set(&self, v: f32) { self.0.store(v.to_bits(), Ordering::Relaxed) }
    /// lock-free max for non-negative values (their bit patterns order like the values)
    pub fn max(&self, v: f32) { self.0.fetch_max(v.max(0.0).to_bits(), Ordering::Relaxed); }
    pub fn take(&self) -> f32 { f32::from_bits(self.0.swap(0, Ordering::Relaxed)) }
}

/// engine-wide state shared with the audio thread
pub struct Shared {
    pub sample_clock: AtomicI64,
    pub sample_rate: AtomicF64,
    pub block_size: AtomicI32,
    pub playing: AtomicBool,
    pub bpm: AtomicF64,
    pub ppq_at_start: AtomicF64,
    pub start_sample: AtomicI64,
    pub sig_num: AtomicI32,
    pub sig_den: AtomicI32,
    pub epoch: AtomicU64,   // incremented after every device callback
    pub rt_gen: AtomicU64,  // graph generation the audio thread is using
}
impl Shared {
    pub fn new() -> Shared {
        Shared { sample_clock: AtomicI64::new(0), sample_rate: AtomicF64::new(48000.0), block_size: AtomicI32::new(512), playing: AtomicBool::new(false),
                 bpm: AtomicF64::new(120.0), ppq_at_start: AtomicF64::new(0.0), start_sample: AtomicI64::new(0), sig_num: AtomicI32::new(4), sig_den: AtomicI32::new(4),
                 epoch: AtomicU64::new(0), rt_gen: AtomicU64::new(0) }
    }
    pub fn transport(&self, now: i64) -> Transport {
        let sr = self.sample_rate.get(); let bpm = self.bpm.get(); let playing = self.playing.load(Ordering::Relaxed);
        let (num, den) = (self.sig_num.load(Ordering::Relaxed), self.sig_den.load(Ordering::Relaxed));
        let ppq = self.ppq_at_start.get() + if playing { (now - self.start_sample.load(Ordering::Relaxed)) as f64 / sr * bpm / 60.0 } else { 0.0 };
        let bar = num as f64 * 4.0 / den.max(1) as f64;
        Transport { sample_rate: sr, playing, bpm, ppq, bar_start_ppq: (ppq / bar).floor() * bar, num, den, time_samples: now }
    }
}

#[derive(Clone, Copy)]
pub enum TrackMsg { Midi { sample: i64, data: [u8; 3] }, Param { sample: i64, inst: i32, index: u32, value: f32 }, Clear }

pub struct TrackRt {
    rx: rtrb::Consumer<TrackMsg>,
    pending: Vec<TrackMsg>,
    block: Vec<Ev>,
    pevs: Vec<Ev>,
    held: [u128; 16],
}
pub struct TrackShared {
    pub id: String,
    pub gain: AtomicF32,
    pub pan: AtomicF32,
    pub mute: AtomicBool,
    pub offline: AtomicBool,
    pub peak_l: AtomicF32,
    pub peak_r: AtomicF32,
    rt: UnsafeCell<TrackRt>,
}
unsafe impl Sync for TrackShared {}
unsafe impl Send for TrackShared {}
impl TrackShared {
    pub fn new(id: &str) -> (Arc<TrackShared>, rtrb::Producer<TrackMsg>) {
        let (tx, rx) = rtrb::RingBuffer::new(16384);
        let rt = TrackRt { rx, pending: Vec::with_capacity(16384), block: Vec::with_capacity(4096), pevs: Vec::with_capacity(4096), held: [0; 16] };
        (Arc::new(TrackShared { id: id.into(), gain: AtomicF32::new(1.0), pan: AtomicF32::new(0.0), mute: AtomicBool::new(false), offline: AtomicBool::new(false),
                                peak_l: AtomicF32::new(0.0), peak_r: AtomicF32::new(0.0), rt: UnsafeCell::new(rt) }), tx)
    }
}

pub struct RtTrack { pub shared: Arc<TrackShared>, pub chain: Vec<*const dyn Plugin>, pub scratch: Vec<Vec<f32>>, pub ptrs: Vec<*mut f32> }
pub struct RtGraph { pub gen: u64, pub tracks: Vec<RtTrack> }
unsafe impl Send for RtGraph {}

struct RtContext {
    graph: Box<RtGraph>,
    rx: rtrb::Consumer<Box<RtGraph>>,
    ret: rtrb::Producer<Box<RtGraph>>,
    shared: Arc<Shared>,
    l: Vec<f32>,
    r: Vec<f32>,
}

fn insertion_sort(v: &mut [Ev]) {
    for i in 1..v.len() { let mut j = i; while j > 0 && v[j - 1].offset() > v[j].offset() { v.swap(j - 1, j); j -= 1; } }
}

impl RtContext {
    fn swap_graph(&mut self) {
        while let Ok(g) = self.rx.pop() {
            let old = std::mem::replace(&mut self.graph, g);
            if let Err(rtrb::PushError::Full(old)) = self.ret.push(old) { std::mem::forget(old); }
        }
        self.shared.rt_gen.store(self.graph.gen, Ordering::Release);
    }
    fn render(&mut self, n: usize) {
        let clock = self.shared.sample_clock.load(Ordering::Relaxed);
        let tr = self.shared.transport(clock);
        self.l[..n].fill(0.0); self.r[..n].fill(0.0);
        for t in self.graph.tracks.iter_mut() {
            let sh = t.shared.clone(); // atomic refcount bump only; no allocation
            if sh.offline.load(Ordering::Acquire) || t.chain.is_empty() { continue; }
            unsafe { render_track(t, n, clock, &tr); }
            let g = if sh.mute.load(Ordering::Relaxed) { 0.0 } else { sh.gain.get() }; let pan = sh.pan.get();
            let (gl, gr) = (g * (1.0 - pan).min(1.0), g * (1.0 + pan).min(1.0));
            let (lc, rc) = (&t.scratch[0], &t.scratch[if t.scratch.len() > 1 { 1 } else { 0 }]);
            let (mut pl, mut pr) = (0f32, 0f32);
            for s in 0..n { let a = lc[s] * gl; let b = rc[s] * gr; self.l[s] += a; self.r[s] += b; pl = pl.max(a.abs()); pr = pr.max(b.abs()); }
            sh.peak_l.max(pl); sh.peak_r.max(pr);
        }
        self.shared.sample_clock.fetch_add(n as i64, Ordering::Relaxed);
    }
}

/// renders one track's chain into its scratch buffers. Called by the audio thread (live).
unsafe fn render_track(t: &mut RtTrack, n: usize, clock: i64, tr: &Transport) {
    let rt = &mut *t.shared.rt.get();
    rt.block.clear();
    while let Ok(m) = rt.rx.pop() {
        match m {
            TrackMsg::Clear => {
                rt.pending.clear();
                for ch in 0..16 { let mut h = rt.held[ch]; while h != 0 { let k = h.trailing_zeros(); h &= h - 1; if rt.block.len() < rt.block.capacity() { rt.block.push(Ev::Midi { offset: 0, data: [0x80 | ch as u8, k as u8, 0] }); } } rt.held[ch] = 0; }
            }
            m => { if rt.pending.len() < rt.pending.capacity() { rt.pending.push(m); } }
        }
    }
    let end = clock + n as i64;
    let mut w = 0;
    for r in 0..rt.pending.len() {
        let m = rt.pending[r];
        let (s, ev) = match m {
            TrackMsg::Midi { sample, data } => (sample, Ev::Midi { offset: 0, data }),
            TrackMsg::Param { sample, inst, index, value } => (sample, Ev::Param { offset: 0, inst, index, value }),
            TrackMsg::Clear => continue,
        };
        if s < end {
            let off = (s - clock).clamp(0, n as i64 - 1) as u32;
            let ev = match ev { Ev::Midi { data, .. } => Ev::Midi { offset: off, data }, Ev::Param { inst, index, value, .. } => Ev::Param { offset: off, inst, index, value } };
            if rt.block.len() < rt.block.capacity() { rt.block.push(ev); }
        } else { rt.pending[w] = m; w += 1; }
    }
    rt.pending.truncate(w);
    insertion_sort(&mut rt.block);
    for e in rt.block.iter() {
        if let Ev::Midi { data, .. } = e {
            let (st, ch) = (data[0] & 0xF0, (data[0] & 0x0F) as usize); let bit = 1u128 << (data[1] & 0x7F);
            if st == 0x90 && data[2] > 0 { rt.held[ch] |= bit; } else if st == 0x80 || st == 0x90 { rt.held[ch] &= !bit; }
        }
    }
    for c in t.scratch.iter_mut() { c[..n].fill(0.0); }
    for &p in t.chain.iter() {
        let p = &*p;
        rt.pevs.clear();
        let id = p.id();
        for e in rt.block.iter() { match e { Ev::Param { inst, .. } if *inst != id => {}, e => rt.pevs.push(*e) } }
        p.process(&t.ptrs, n, &rt.pevs, tr);
    }
}

// ================================================================ devices (cpal; no ASIO)
pub struct Device {
    _stream: cpal::Stream,
    pub tx: rtrb::Producer<Box<RtGraph>>,
    pub ret: rtrb::Consumer<Box<RtGraph>>,
    pub info: Value,
}

fn host_display_name(id: cpal::HostId) -> String {
    match id.name() { "WASAPI" => "Windows Audio".into(), n => n.to_string() }
}
fn pick_host(want: &str) -> cpal::Host {
    if !want.is_empty() {
        for id in cpal::available_hosts() {
            if host_display_name(id).eq_ignore_ascii_case(want) || id.name().eq_ignore_ascii_case(want) { if let Ok(h) = cpal::host_from_id(id) { return h; } }
        }
    }
    cpal::default_host()
}
fn dev_name(d: &cpal::Device) -> String { d.description().map(|x| x.name().to_string()).unwrap_or_else(|_| d.to_string()) }

pub fn list_devices() -> Value {
    let mut types = vec![];
    for id in cpal::available_hosts() {
        let Ok(h) = cpal::host_from_id(id) else { continue };
        let outs: Vec<String> = h.output_devices().map(|it| it.map(|d| dev_name(&d)).collect()).unwrap_or_default();
        types.push(json!({ "type": host_display_name(id), "outputs": outs }));
    }
    json!(types)
}

pub fn open(args: &Value, shared: Arc<Shared>, graph: Box<RtGraph>, prepare: &mut dyn FnMut(f64)) -> Result<Device, String> {
    let host = pick_host(args["type"].as_str().unwrap_or(""));
    let want = args["device"].as_str().unwrap_or("");
    let device = if want.is_empty() { host.default_output_device() } else {
        host.output_devices().ok().and_then(|mut it| it.find(|d| dev_name(d) == want)).or_else(|| host.default_output_device())
    }.ok_or("no audio output device available")?;
    let def = device.default_output_config().map_err(|e| { let s = e.to_string(); if s.contains("not available") { "no audio output device available".to_string() } else { format!("audio device: {s}") } })?;
    let mut cfg = def.config();
    if let Some(sr) = args["sampleRate"].as_f64() {
        let ok = device.supported_output_configs().map(|mut it| it.any(|c| c.min_sample_rate() <= sr as u32 && c.max_sample_rate() >= sr as u32 && c.sample_format() == def.sample_format())).unwrap_or(false);
        if ok { cfg.sample_rate = sr as u32; }
    }
    if let Some(bs) = args["bufferSize"].as_f64() { cfg.buffer_size = cpal::BufferSize::Fixed((bs as u32).clamp(16, MAX_BLOCK as u32)); }
    let sr = cfg.sample_rate as f64;
    shared.sample_rate.set(sr);
    if let cpal::BufferSize::Fixed(b) = cfg.buffer_size { shared.block_size.store(b as i32, Ordering::SeqCst); }
    prepare(sr);
    let (tx, rx) = rtrb::RingBuffer::new(64);
    let (rtx, ret) = rtrb::RingBuffer::new(128);
    shared.rt_gen.store(graph.gen, Ordering::SeqCst);
    let ctx = RtContext { graph, rx, ret: rtx, shared: shared.clone(), l: vec![0.0; MAX_BLOCK], r: vec![0.0; MAX_BLOCK] };
    let channels = cfg.channels as usize;
    let err = |e: cpal::Error| crate::protocol::log(&format!("audio stream error: {e}"));
    macro_rules! build {
        ($t:ty) => {{
            let mut ctx = ctx;
            device.build_output_stream::<$t, _, _>(cfg.clone(), move |data: &mut [$t], _: &cpal::OutputCallbackInfo| {
                let _live = crate::rtcheck::LiveScope::enter();
                let _a = AudioScope::enter();
                ctx.swap_graph();
                let frames = data.len() / channels.max(1);
                let mut done = 0;
                while done < frames {
                    let n = (frames - done).min(MAX_BLOCK);
                    ctx.render(n);
                    for i in 0..n {
                        let fr = &mut data[(done + i) * channels..(done + i + 1) * channels];
                        if channels == 1 { fr[0] = <$t as cpal::FromSample<f32>>::from_sample_(0.5 * (ctx.l[i] + ctx.r[i])); }
                        else { for (c, s) in fr.iter_mut().enumerate() { let v = match c { 0 => ctx.l[i], 1 => ctx.r[i], _ => 0.0 }; *s = <$t as cpal::FromSample<f32>>::from_sample_(v); } }
                    }
                    done += n;
                }
                ctx.shared.epoch.fetch_add(1, Ordering::Release);
            }, err, None)
        }};
    }
    let stream = match def.sample_format() {
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::I32 => build!(i32),
        cpal::SampleFormat::U16 => build!(u16),
        cpal::SampleFormat::F64 => build!(f64),
        f => return Err(format!("audio device: unsupported sample format {f:?}")),
    }.map_err(|e| format!("audio device: {e}"))?;
    stream.play().map_err(|e| format!("audio device: {e}"))?;
    let bs = match cfg.buffer_size { cpal::BufferSize::Fixed(b) => b as f64, _ => shared.block_size.load(Ordering::SeqCst) as f64 };
    let info = json!({ "open": true, "type": host_display_name(host.id()), "name": dev_name(&device), "sampleRate": sr, "bufferSize": bs, "outputLatency": bs / sr, "channels": channels });
    Ok(Device { _stream: stream, tx, ret, info })
}

/// Offline rendering of one track (main thread, while the audio thread skips the track).
pub fn render_offline(chain: &[Arc<dyn Plugin>], scratch_ch: usize, notes: &[(i64, [u8; 3])], total: usize, bs: usize, tr0: &Transport) -> (Vec<f32>, Vec<f32>) {
    let _a = AudioScope::enter();
    let mut scratch: Vec<Vec<f32>> = (0..scratch_ch.max(2)).map(|_| vec![0.0; MAX_BLOCK]).collect();
    let ptrs: Vec<*mut f32> = scratch.iter_mut().map(|c| c.as_mut_ptr()).collect();
    let (mut l, mut r) = (vec![0.0f32; total], vec![0.0f32; total]);
    let bs = bs.clamp(16, MAX_BLOCK);
    let mut e = 0usize;
    let mut evs: Vec<Ev> = Vec::with_capacity(4096);
    let mut pos = 0usize;
    while pos < total {
        let n = bs.min(total - pos);
        evs.clear();
        while e < notes.len() && notes[e].0 < (pos + n) as i64 { evs.push(Ev::Midi { offset: (notes[e].0 - pos as i64).max(0) as u32, data: notes[e].1 }); e += 1; }
        for c in scratch.iter_mut() { c[..n].fill(0.0); }
        let tr = Transport { time_samples: pos as i64, ..*tr0 };
        for p in chain { unsafe { p.process(&ptrs, n, &evs, &tr); } }
        l[pos..pos + n].copy_from_slice(&scratch[0][..n]);
        r[pos..pos + n].copy_from_slice(&scratch[if scratch.len() > 1 { 1 } else { 0 }][..n]);
        pos += n;
    }
    (l, r)
}
