//! The engine: plugin instances grouped into tracks, rendered in the audio callback and mixed to the
//! output device. Same command set and semantics as the JUCE engine (protocol 1).
use crate::audio::{self, RtGraph, RtTrack, Shared, TrackMsg, TrackShared};
use crate::plugin::*;
use crate::protocol::*;
use crate::scanner::Scanner;
use crate::{claphost, vst3host, window};
use base64::Engine as _;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

struct Track { shared: Arc<TrackShared>, tx: rtrb::Producer<TrackMsg>, chain: Vec<i32> }
struct Inst { plugin: Arc<dyn Plugin>, track: String, name: String }

pub struct Engine {
    midi_out: crate::midiout::MidiOut,
    shared: Arc<Shared>,
    scanner: Scanner,
    instances: BTreeMap<i32, Inst>,
    tracks: BTreeMap<String, Track>,
    next_id: i32,
    device: Option<audio::Device>,
    gen: u64,
    graveyard: Vec<(u64, Arc<dyn Plugin>)>,
    pub quit: bool,
}

type R = Result<Value, String>;
fn b64() -> base64::engine::GeneralPurpose { base64::engine::general_purpose::STANDARD }

impl Engine {
    pub fn new() -> Engine {
        Engine { shared: Arc::new(Shared::new()), scanner: Scanner::new(), instances: BTreeMap::new(), tracks: BTreeMap::new(), next_id: 1, device: None, gen: 0, graveyard: vec![], quit: false, midi_out: crate::midiout::MidiOut::new() }
    }

    fn track(&mut self, id: &str) -> Result<&mut Track, String> {
        if id.is_empty() || id.chars().count() > 64 { return Err("bad trackId".into()); }
        if !self.tracks.contains_key(id) {
            let (shared, tx) = TrackShared::new(id);
            self.tracks.insert(id.to_string(), Track { shared, tx, chain: vec![] });
        }
        Ok(self.tracks.get_mut(id).unwrap())
    }
    fn inst(&self, a: &Value) -> Result<&Inst, String> {
        let id = num(a, "instanceId", -1.0) as i32;
        self.instances.get(&id).ok_or_else(|| format!("unknown instanceId {id}"))
    }

    // ------------------------------------------------------------ graph publishing
    fn build_graph(&mut self) -> Box<RtGraph> {
        self.gen += 1;
        let mut tracks = vec![];
        for t in self.tracks.values() {
            let chain: Vec<*const dyn Plugin> = t.chain.iter().filter_map(|id| self.instances.get(id)).map(|i| Arc::as_ptr(&i.plugin)).collect();
            let ch = t.chain.iter().filter_map(|id| self.instances.get(id)).map(|i| { let li = i.plugin.load_info(); li.inputs.max(li.outputs) as usize }).max().unwrap_or(2).clamp(2, MAX_CHANNELS);
            let mut scratch: Vec<Vec<f32>> = (0..ch).map(|_| vec![0.0; MAX_BLOCK]).collect();
            let ptrs = scratch.iter_mut().map(|c| c.as_mut_ptr()).collect();
            tracks.push(RtTrack { shared: t.shared.clone(), chain, scratch, ptrs });
        }
        Box::new(RtGraph { gen: self.gen, tracks })
    }
    fn publish(&mut self) {
        let g = self.build_graph();
        if let Some(d) = self.device.as_mut() {
            let mut g = Some(g);
            let t0 = Instant::now();
            while let Some(x) = g.take() {
                match d.tx.push(x) {
                    Ok(()) => {}
                    Err(rtrb::PushError::Full(x)) => { if t0.elapsed() > Duration::from_millis(500) { log("audio thread is not taking graph updates"); break; } g = Some(x); std::thread::sleep(Duration::from_millis(1)); while let Ok(old) = d.ret.pop() { drop(old); } }
                }
            }
        }
        self.collect();
    }
    /// free old graphs and plugins the audio thread no longer references
    fn collect(&mut self) {
        if let Some(d) = self.device.as_mut() { while let Ok(old) = d.ret.pop() { drop(old); } }
        let running = self.device.is_some();
        let seen = self.shared.rt_gen.load(Ordering::Acquire);
        let (dead, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.graveyard).into_iter().partition(|(g, _)| !running || seen >= *g);
        self.graveyard = keep;
        drop(dead);
    }
    fn wait_rt_leaves(&self) {
        // after flagging a track offline / publishing, make sure an in-flight callback has finished
        if self.device.is_none() { return; }
        let e = self.shared.epoch.load(Ordering::Acquire);
        let t0 = Instant::now();
        while self.shared.epoch.load(Ordering::Acquire) < e + 2 && t0.elapsed() < Duration::from_millis(500) { std::thread::sleep(Duration::from_micros(500)); }
    }

    fn unload(&mut self, id: i32) {
        let Some(i) = self.instances.remove(&id) else { return };
        i.plugin.close_editor();
        for t in self.tracks.values_mut() { t.chain.retain(|x| *x != id); }
        self.publish();
        self.graveyard.push((self.gen, i.plugin));
        self.collect();
    }

    fn device_info(&self) -> Value { self.device.as_ref().map(|d| d.info.clone()).unwrap_or_else(|| json!({ "open": false })) }

    fn hello(&self) -> Value {
        json!({ "engine": "auduio-engine", "version": VERSION, "protocol": PROTOCOL_VERSION, "host": format!("auduio-rs {VERSION} (JUCE-free)"),
                "os": match std::env::consts::OS { "linux" => "Linux", "windows" => "Windows", "macos" => "macOS", o => o }, "formats": crate::scanner::FORMATS, "sampleRate": self.shared.sample_rate.get(),
                "blockSize": self.shared.block_size.load(Ordering::SeqCst), "device": self.device_info(), "dataDir": crate::util::data_dir().to_string_lossy(), "midiOut": true })
    }

    fn param_list(&self, p: &Arc<dyn Plugin>) -> Value {
        let ps = p.params();
        Value::Array(ps.iter().enumerate().map(|(i, d)| { let v = p.param_value(i); param_json(i, d, v, p.param_text(i, v)) }).collect())
    }

    fn open_device(&mut self, a: &Value) -> R {
        self.close_device();
        let g = self.build_graph();
        let shared = self.shared.clone();
        let insts: Vec<Arc<dyn Plugin>> = self.instances.values().map(|i| i.plugin.clone()).collect();
        let mut prep = |sr: f64| { for p in &insts { p.prepare(sr); } };
        let d = audio::open(a, shared, g, &mut prep)?;
        DEVICE_RUNNING.store(true, Ordering::SeqCst);
        self.device = Some(d);
        Ok(self.device_info())
    }
    fn close_device(&mut self) {
        if let Some(d) = self.device.take() { drop(d); }
        DEVICE_RUNNING.store(false, Ordering::SeqCst);
        self.collect();
    }

    fn load_plugin(&mut self, a: &Value) -> R {
        let uid = str_(a, "uid");
        let desc = match self.scanner.find(&uid) {
            Some(d) => d,
            None => {
                let file = str_(a, "file");
                if file.is_empty() { return Err(format!("plugin not found (scan first): {uid}")); }
                let p = std::path::Path::new(&file);
                let found = match crate::scanner::format_for_file(p) { "CLAP" => claphost::scan_file(p), _ => vst3host::scan_file(p) }.map_err(|e| format!("no plugin in {file}: {e}"))?;
                if found.is_empty() { return Err(format!("no plugin in {file}")); }
                let name = str_(a, "name");
                found.iter().find(|d| d["uid"].as_str() == Some(uid.as_str())).or_else(|| found.iter().find(|d| d["name"].as_str() == Some(name.as_str()))).unwrap_or(&found[0]).clone()
            }
        };
        let id = self.next_id;
        let sr = self.shared.sample_rate.get();
        let name = desc["name"].as_str().unwrap_or("plugin").to_string();
        let plugin: Arc<dyn Plugin> = match desc["format"].as_str() {
            Some("CLAP") => Arc::new(claphost::ClapInstance::create(id, &desc, sr).map_err(|e| format!("could not load {name}: {e}"))?),
            Some("VST3") | None => Arc::new(vst3host::Vst3Instance::create(id, &desc, sr).map_err(|e| format!("could not load {name}: {e}"))?),
            Some(f) => return Err(format!("could not load {name}: format {f} is not supported by this engine")),
        };
        self.next_id += 1;
        if has(a, "state") {
            if let Ok(bytes) = b64().decode(str_(a, "state").trim()) { let _ = plugin.set_state(&bytes); }
        }
        let track_id = str_(a, "trackId");
        let slot = num(a, "slot", -1.0) as i64;
        let t = self.track(&track_id)?;
        if slot < 0 || slot as usize >= t.chain.len() { t.chain.push(id); } else { t.chain.insert(slot as usize, id); }
        self.instances.insert(id, Inst { plugin: plugin.clone(), track: track_id, name });
        self.publish();
        let li = plugin.load_info();
        Ok(json!({ "instanceId": id, "plugin": desc, "hasEditor": li.has_editor, "latency": li.latency, "inputs": li.inputs, "outputs": li.outputs,
                   "acceptsMidi": li.accepts_midi, "params": self.param_list(&plugin) }))
    }

    fn render(&mut self, a: &Value) -> R {
        let tid = str_(a, "trackId");
        let (chain_ids, shared_t) = { let t = self.track(&tid)?; (t.chain.clone(), t.shared.clone()) };
        if chain_ids.is_empty() { return Err("track has no plugins".into()); }
        let chain: Vec<Arc<dyn Plugin>> = chain_ids.iter().filter_map(|i| self.instances.get(i)).map(|i| i.plugin.clone()).collect();
        let sr = self.shared.sample_rate.get();
        let seconds = num(a, "seconds", 2.0).clamp(0.05, 600.0);
        let total = (seconds * sr) as usize;
        let mut notes: Vec<(i64, [u8; 3])> = vec![];
        if let Some(arr) = a["notes"].as_array() {
            for nt in arr {
                let ch = (num(nt, "ch", 1.0) as i64).clamp(1, 16) as u8 - 1; let n = (num(nt, "n", 60.0) as i64).clamp(0, 127) as u8;
                let v = (num(nt, "v", 100.0) as i64).clamp(1, 127) as u8; let t0 = num(nt, "t", 0.0); let d = num(nt, "d", 0.5);
                notes.push(((t0 * sr) as i64, [0x90 | ch, n, v])); notes.push((((t0 + d) * sr) as i64, [0x80 | ch, n, 0]));
            }
        }
        notes.sort_by_key(|x| x.0);
        let wav = str_(a, "wav");
        if !wav.is_empty() && (!std::path::Path::new(&wav).is_absolute() || !wav.to_lowercase().ends_with(".wav")) { return Err("wav must be an absolute .wav path".into()); }
        shared_t.offline.store(true, Ordering::SeqCst);
        self.wait_rt_leaves();
        for p in &chain { p.set_offline(true); p.reset(); }
        let ch = chain.iter().map(|p| { let li = p.load_info(); li.inputs.max(li.outputs) as usize }).max().unwrap_or(2).clamp(2, MAX_CHANNELS);
        let tr = self.shared.transport(0);
        let (l, r) = audio::render_offline(&chain, ch, &notes, total, self.shared.block_size.load(Ordering::SeqCst) as usize, &Transport { playing: false, ..tr });
        for p in &chain { p.reset(); p.set_offline(false); }
        shared_t.offline.store(false, Ordering::SeqCst);
        let peak = l.iter().chain(r.iter()).fold(0f32, |m, x| m.max(x.abs()));
        let rms = |v: &[f32]| if v.is_empty() { 0.0 } else { (v.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>() / v.len() as f64).sqrt() };
        let mut o = json!({ "peak": peak, "rms": 0.5 * (rms(&l) + rms(&r)), "samples": total, "sampleRate": sr });
        if !wav.is_empty() {
            let _ = std::fs::remove_file(&wav);
            crate::wav::write_wav24(&wav, sr as u32, &l, &r).map_err(|e| format!("cannot write {wav}: {e}"))?;
            o["wav"] = json!(wav);
        }
        Ok(o)
    }

    pub fn handle(&mut self, cmd: &str, a: &Value) -> R {
        match cmd {
            "hello" | "ping" => Ok(self.hello()),
            "clock" => { let s = self.shared.sample_clock.load(Ordering::Relaxed); let sr = self.shared.sample_rate.get(); Ok(json!({ "samples": s, "sampleRate": sr, "seconds": s as f64 / sr, "running": self.device.is_some() })) }
            "audio.devices" => Ok(json!({ "types": audio::list_devices(), "current": self.device_info() })),
            "audio.open" => self.open_device(a),
            "audio.close" => {
                self.close_device();
                let mut o = self.device_info();
                if let Some((cb, al, fr)) = crate::rtcheck::report() { o["rtCheck"] = json!({ "callbacks": cb, "allocs": al, "frees": fr }); }
                Ok(o)
            }
            "scan" => {
                let extra: Vec<String> = a["paths"].as_array().map(|v| v.iter().filter_map(|x| x.as_str()).filter(|s| std::path::Path::new(s).is_absolute()).map(String::from).collect()).unwrap_or_default();
                let started = self.scanner.start(extra, truthy(a, "rescan"), num(a, "timeoutMs", 30000.0) as u64);
                Ok(json!({ "started": started, "scanning": self.scanner.is_scanning() }))
            }
            "scan.cancel" => { self.scanner.cancel(); Ok(json!(true)) }
            "plugins.list" => Ok(self.scanner.as_json()),
            "track.set" => {
                let t = self.track(&str_(a, "trackId"))?;
                if has(a, "gainDb") { let db = num(a, "gainDb", 0.0); t.shared.gain.set(if db <= -100.0 { 0.0 } else { 10f64.powf(db.min(12.0) / 20.0) as f32 }); }
                if has(a, "pan") { t.shared.pan.set(num(a, "pan", 0.0).clamp(-1.0, 1.0) as f32); }
                if has(a, "mute") { t.shared.mute.store(truthy(a, "mute"), Ordering::Relaxed); }
                Ok(json!(true))
            }
            "track.remove" => {
                let id = str_(a, "trackId");
                if let Some(t) = self.tracks.get(&id) { for i in t.chain.clone() { self.unload(i); } self.tracks.remove(&id); self.publish(); }
                Ok(json!(true))
            }
            "plugin.load" => self.load_plugin(a),
            "plugin.unload" => { self.unload(num(a, "instanceId", -1.0) as i32); Ok(json!(true)) }
            "plugin.params" => { let p = self.inst(a)?.plugin.clone(); Ok(self.param_list(&p)) }
            "param.set" | "param.setMany" => {
                let (p, track) = { let i = self.inst(a)?; (i.plugin.clone(), i.track.clone()) };
                let vals: Vec<(i64, f32)> = if cmd == "param.set" { vec![(num(a, "index", -1.0) as i64, num(a, "value", 0.0).clamp(0.0, 1.0) as f32)] }
                    else { a["values"].as_array().map(|v| v.iter().map(|e| (num_v(&e[0], -1.0) as i64, num_v(&e[1], 0.0).clamp(0.0, 1.0) as f32)).collect()).unwrap_or_default() };
                let timed = has(a, "t"); let notify = truthy(a, "notify");
                let when = (num(a, "t", 0.0) * self.shared.sample_rate.get()) as i64;
                let n = p.param_count();
                let mut texts = vec![];
                for &(idx, v) in &vals {
                    if idx < 0 || idx as usize >= n { continue; }
                    if timed { if let Some(t) = self.tracks.get_mut(&track) { let _ = t.tx.push(TrackMsg::Param { sample: when, inst: p.id(), index: idx as u32, value: v }); } }
                    else { p.set_param(idx as usize, v, notify); }
                }
                if !timed { for &(idx, _) in &vals { if idx >= 0 && (idx as usize) < n { texts.push(json!(p.param_text(idx as usize, p.param_value(idx as usize)))); } } }
                Ok(json!({ "texts": texts }))
            }
            "editor.open" => {
                let (p, name) = { let i = self.inst(a)?; (i.plugin.clone(), i.name.clone()) };
                if p.editor_is_open() { p.raise_editor(); return Ok(json!(true)); }
                if !p.load_info().has_editor { return Err(format!("{name} has no editor window")); }
                let (w, h) = p.open_editor(&format!("{name} - Auduio"))?;
                Ok(json!({ "width": w, "height": h }))
            }
            "editor.close" => { let p = self.inst(a)?.plugin.clone(); p.close_editor(); Ok(json!(true)) }
            "state.get" => { let p = self.inst(a)?.plugin.clone(); let d = p.get_state()?; Ok(json!({ "data": b64().encode(&d), "bytes": d.len() })) }
            "state.set" => {
                let p = self.inst(a)?.plugin.clone();
                let d = b64().decode(str_(a, "data").trim()).map_err(|_| "bad state data".to_string())?;
                p.set_state(&d)?;
                Ok(json!({ "params": self.param_list(&p) }))
            }
            "midi" => {
                let sr = self.shared.sample_rate.get(); let now = self.shared.sample_clock.load(Ordering::Relaxed);
                let t = self.track(&str_(a, "trackId"))?;
                if let Some(evs) = a["events"].as_array() {
                    for e in evs {
                        let Some(d) = e["d"].as_array() else { continue };
                        if d.is_empty() || d.len() > 3 { continue; }
                        let mut b = [0u8; 3]; for (k, x) in d.iter().enumerate() { b[k] = (num_v(x, 0.0) as i64).clamp(0, 255) as u8; }
                        if b[0] < 0x80 || b[0] >= 0xF0 { continue; } // channel messages only
                        let s = if has(e, "t") { (num(e, "t", 0.0) * sr) as i64 } else { now };
                        let _ = t.tx.push(TrackMsg::Midi { sample: s.max(now), data: b });
                    }
                }
                Ok(json!(true))
            }
            "notesOff" => {
                let only = str_(a, "trackId"); let now = self.shared.sample_clock.load(Ordering::Relaxed);
                for (id, t) in self.tracks.iter_mut() {
                    if !only.is_empty() && *id != only { continue; }
                    let _ = t.tx.push(TrackMsg::Clear);
                    for ch in 0..16u8 { let _ = t.tx.push(TrackMsg::Midi { sample: now, data: [0xB0 | ch, 123, 0] }); let _ = t.tx.push(TrackMsg::Midi { sample: now, data: [0xB0 | ch, 120, 0] }); }
                }
                Ok(json!(true))
            }
            "transport" => {
                let s = &self.shared;
                if has(a, "bpm") { s.bpm.set(num(a, "bpm", 120.0).clamp(20.0, 999.0)); }
                if has(a, "num") { s.sig_num.store((num(a, "num", 4.0) as i32).clamp(1, 32), Ordering::Relaxed); }
                if has(a, "den") { s.sig_den.store((num(a, "den", 4.0) as i32).clamp(1, 32), Ordering::Relaxed); }
                if has(a, "playing") {
                    s.ppq_at_start.set(num(a, "ppq", 0.0));
                    s.start_sample.store(if has(a, "t") { (num(a, "t", 0.0) * s.sample_rate.get()) as i64 } else { s.sample_clock.load(Ordering::Relaxed) }, Ordering::Relaxed);
                    s.playing.store(truthy(a, "playing"), Ordering::Relaxed);
                }
                Ok(json!(true))
            }
            "render" => self.render(a),
            c if c.starts_with("midiout.") => self.midi_out.handle(c, a),
            "quit" => { self.quit = true; Ok(json!(true)) }
            _ => Err(format!("unknown command: {cmd}")),
        }
    }

    pub fn dispatch(&mut self, line: &str) {
        let msg: Value = match serde_json::from_str(line) { Ok(v @ Value::Object(_)) => v, _ => { reply_error(&Value::Null, "bad JSON"); return; } };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let cmd = msg["cmd"].as_str().unwrap_or("").to_string();
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.handle(&cmd, &msg)));
        match res {
            Ok(Ok(v)) => reply(&id, v),
            Ok(Err(e)) => reply_error(&id, &e),
            Err(_) => reply_error(&id, "internal error"),
        }
    }

    /// ~20 Hz: plugin -> UI parameter changes (coalesced), meters, housekeeping
    pub fn timer(&mut self) {
        self.collect();
        for (id, i) in self.instances.iter() {
            let (mut ch, mut ge) = (vec![], vec![]);
            i.plugin.drain_ui(&mut ch, &mut ge);
            if ch.is_empty() && ge.is_empty() { continue; }
            let mut last: BTreeMap<usize, f32> = BTreeMap::new();
            for (k, v) in ch { last.insert(k, v); }
            let changes: Vec<Value> = last.iter().map(|(k, v)| json!([k, v, i.plugin.param_text(*k, *v)])).collect();
            let mut o = Map::new();
            o.insert("instanceId".into(), json!(id));
            o.insert("changes".into(), json!(changes));
            if !ge.is_empty() { o.insert("gestures".into(), json!(ge.iter().map(|(k, g)| json!([k, g])).collect::<Vec<_>>())); }
            emit("params", Some(o));
        }
        if self.device.is_some() && !self.tracks.is_empty() {
            let mut m = Map::new();
            for (id, t) in &self.tracks { if t.chain.is_empty() { continue; } m.insert(id.clone(), json!([t.shared.peak_l.take(), t.shared.peak_r.take()])); }
            if !m.is_empty() { emit("meters", Some(obj!("tracks" => Value::Object(m)))); }
        }
    }
    pub fn idle(&mut self) { for i in self.instances.values() { i.plugin.idle(); } }
    pub fn window_events(&mut self) {
        for ev in window::poll_events() {
            match ev {
                window::WinEvent::Close(w) => {
                    let hit: Vec<i32> = self.instances.iter().filter(|(_, i)| i.plugin.editor_window() == Some(w)).map(|(k, _)| *k).collect();
                    for id in hit { if let Some(i) = self.instances.get(&id) { i.plugin.close_editor(); } emit("editor.closed", Some(obj!("instanceId" => id))); }
                }
                window::WinEvent::Resized(w, x, y) => { for i in self.instances.values() { if i.plugin.editor_window() == Some(w) { i.plugin.window_resized(x, y); } } }
            }
        }
    }
    pub fn shutdown(&mut self) {
        self.scanner.cancel();
        self.close_device();
        let ids: Vec<i32> = self.instances.keys().cloned().collect();
        for id in ids { self.unload(id); }
        self.tracks.clear();
        self.graveyard.clear();
    }
}
