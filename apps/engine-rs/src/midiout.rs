//! Hardware MIDI output (for the desktop app, whose webview has no Web MIDI).
//!
//! The frontend sends channel messages with a delay relative to "now"; a
//! dedicated sender thread keeps a deadline-sorted queue and writes each
//! message to the OS MIDI port (ALSA seq / CoreMIDI / WinMM via `midir`) when
//! it is due. Only channel voice messages are accepted: no SysEx, no system
//! realtime, so a web page can never push arbitrary bytes to a device.
//!
//! `AUDUIO_MIDI_TEST_SINK=<file>` adds a virtual port "Auduio Test Sink" that
//! appends `<micros since first send> <hex bytes>` lines to the file; it is
//! what the automated tests use on machines without MIDI hardware.

use serde_json::{json, Value};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::io::Write;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

pub const TEST_SINK_NAME: &str = "Auduio Test Sink";
const MAX_EVENTS_PER_SEND: usize = 4096;
const MAX_QUEUE: usize = 65536;
const MAX_DELAY_S: f64 = 10.0;
const MAX_PORT_NAME: usize = 256;

enum Cmd {
    Send(String, Vec<(Instant, [u8; 3], u8)>),
    AllOff(Option<String>),
    CloseAll,
}

pub struct MidiOut {
    tx: Option<Sender<Cmd>>,
}

/// Expected length of a channel message given its status byte, None if not allowed.
pub fn channel_len(status: u8) -> Option<usize> {
    match status & 0xF0 {
        0x80 | 0x90 | 0xA0 | 0xB0 | 0xE0 => Some(3),
        0xC0 | 0xD0 => Some(2),
        _ => None,
    }
}

/// Validate one message: channel status + data bytes < 0x80.
pub fn parse_msg(v: &Value) -> Result<([u8; 3], u8), String> {
    let arr = v.as_array().ok_or("d must be an array")?;
    if arr.is_empty() || arr.len() > 3 { return Err("bad message length".into()); }
    let mut b = [0u8; 3];
    for (i, x) in arr.iter().enumerate() {
        let n = x.as_u64().ok_or("bytes must be integers")?;
        if n > 255 { return Err("byte out of range".into()); }
        b[i] = n as u8;
    }
    let len = channel_len(b[0]).ok_or("only channel messages are allowed")?;
    if arr.len() != len { return Err("bad message length".into()); }
    if b[1..len].iter().any(|&x| x >= 0x80) { return Err("data byte out of range".into()); }
    Ok((b, len as u8))
}

fn list_ports() -> (Vec<String>, Option<String>) {
    let mut names = vec![];
    let mut err = None;
    match midir::MidiOutput::new("Auduio") {
        Ok(out) => {
            for p in out.ports() {
                if let Ok(n) = out.port_name(&p) { names.push(n); }
            }
        }
        Err(e) => err = Some(e.to_string()),
    }
    if std::env::var_os("AUDUIO_MIDI_TEST_SINK").is_some() { names.push(TEST_SINK_NAME.to_string()); }
    (names, err)
}

enum Conn {
    Os(midir::MidiOutputConnection),
    Sink(std::fs::File, Instant),
}

impl Conn {
    fn open(name: &str) -> Result<Conn, String> {
        if name == TEST_SINK_NAME {
            if let Some(path) = std::env::var_os("AUDUIO_MIDI_TEST_SINK") {
                let f = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
                return Ok(Conn::Sink(f, Instant::now()));
            }
        }
        let out = midir::MidiOutput::new("Auduio").map_err(|e| e.to_string())?;
        let port = out.ports().into_iter().find(|p| out.port_name(p).map(|n| n == name).unwrap_or(false))
            .ok_or_else(|| format!("MIDI port not found: {name}"))?;
        out.connect(&port, "Auduio Out").map(Conn::Os).map_err(|e| e.to_string())
    }
    fn send(&mut self, b: &[u8]) {
        match self {
            Conn::Os(c) => { let _ = c.send(b); }
            Conn::Sink(f, t0) => {
                let hex: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
                let _ = writeln!(f, "{} {}", t0.elapsed().as_micros(), hex.join(" "));
                let _ = f.flush();
            }
        }
    }
}

fn worker(rx: Receiver<Cmd>) {
    // heap of (deadline, seq) -> (port, bytes, len)
    let mut heap: BinaryHeap<Reverse<(Instant, u64)>> = BinaryHeap::new();
    let mut pending: HashMap<u64, (String, [u8; 3], u8)> = HashMap::new();
    let mut conns: HashMap<String, Conn> = HashMap::new();
    let mut seq = 0u64;
    let get = |conns: &mut HashMap<String, Conn>, port: &str| -> bool {
        if !conns.contains_key(port) {
            match Conn::open(port) { Ok(c) => { conns.insert(port.to_string(), c); } Err(e) => { eprintln!("[midiout] {e}"); return false; } }
        }
        true
    };
    loop {
        // send everything due
        let now = Instant::now();
        while let Some(Reverse((t, id))) = heap.peek().copied() {
            if t > now + Duration::from_micros(300) { break; }
            heap.pop();
            if let Some((port, b, len)) = pending.remove(&id) {
                if get(&mut conns, &port) { if let Some(c) = conns.get_mut(&port) { c.send(&b[..len as usize]); } }
            }
        }
        let cmd = match heap.peek() {
            Some(Reverse((t, _))) => match rx.recv_timeout(t.saturating_duration_since(Instant::now())) {
                Ok(c) => c, Err(RecvTimeoutError::Timeout) => continue, Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() { Ok(c) => c, Err(_) => break },
        };
        match cmd {
            Cmd::Send(port, evs) => {
                if !get(&mut conns, &port) { continue; }
                for (t, b, len) in evs {
                    if pending.len() >= MAX_QUEUE { break; }
                    seq += 1;
                    pending.insert(seq, (port.clone(), b, len));
                    heap.push(Reverse((t, seq)));
                }
            }
            Cmd::AllOff(only) => {
                // drop queued events for the port(s), then silence every channel now
                pending.retain(|_, (p, _, _)| only.as_ref().map(|o| o != p).unwrap_or(false));
                heap.retain(|Reverse((_, id))| pending.contains_key(id));
                for (name, c) in conns.iter_mut() {
                    if only.as_ref().map(|o| o != name).unwrap_or(false) { continue; }
                    for ch in 0..16u8 { c.send(&[0xB0 | ch, 64, 0]); c.send(&[0xB0 | ch, 123, 0]); c.send(&[0xB0 | ch, 120, 0]); }
                }
            }
            Cmd::CloseAll => { pending.clear(); heap.clear(); conns.clear(); }
        }
    }
}

impl MidiOut {
    pub fn new() -> MidiOut { MidiOut { tx: None } }

    fn tx(&mut self) -> &Sender<Cmd> {
        if self.tx.is_none() {
            let (tx, rx) = mpsc::channel();
            std::thread::Builder::new().name("auduio-midiout".into()).spawn(move || worker(rx)).expect("spawn midiout");
            self.tx = Some(tx);
        }
        self.tx.as_ref().unwrap()
    }

    pub fn handle(&mut self, cmd: &str, a: &Value) -> Result<Value, String> {
        match cmd {
            "midiout.list" => {
                let (names, err) = list_ports();
                let ports: Vec<Value> = names.iter().map(|n| json!({ "id": n, "name": n })).collect();
                Ok(json!({ "ports": ports, "error": err }))
            }
            "midiout.send" => {
                let port = a.get("port").and_then(|v| v.as_str()).unwrap_or("");
                if port.is_empty() || port.len() > MAX_PORT_NAME { return Err("bad port".into()); }
                let evs = a.get("events").and_then(|v| v.as_array()).ok_or("events must be an array")?;
                if evs.len() > MAX_EVENTS_PER_SEND { return Err("too many events".into()); }
                let now = Instant::now();
                let mut out = Vec::with_capacity(evs.len());
                for e in evs {
                    let (b, len) = parse_msg(e.get("d").ok_or("missing d")?)?;
                    let dt = e.get("dt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    if !dt.is_finite() { return Err("bad dt".into()); }
                    let dt = dt.clamp(0.0, MAX_DELAY_S);
                    out.push((now + Duration::from_secs_f64(dt), b, len));
                }
                let n = out.len();
                let _ = self.tx().send(Cmd::Send(port.to_string(), out));
                Ok(json!({ "queued": n }))
            }
            "midiout.allOff" => {
                let port = a.get("port").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
                let _ = self.tx().send(Cmd::AllOff(port));
                Ok(json!(true))
            }
            "midiout.close" => {
                if let Some(tx) = &self.tx { let _ = tx.send(Cmd::CloseAll); }
                Ok(json!(true))
            }
            _ => Err(format!("unknown command: {cmd}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_messages() {
        assert!(parse_msg(&json!([0x90, 60, 100])).is_ok());
        assert!(parse_msg(&json!([0xC0, 5])).is_ok());
        assert!(parse_msg(&json!([0xF0, 1, 2])).is_err()); // sysex
        assert!(parse_msg(&json!([0xF8])).is_err()); // realtime
        assert!(parse_msg(&json!([0x90, 60])).is_err()); // short
        assert!(parse_msg(&json!([0x90, 200, 1])).is_err()); // data >= 0x80
        assert!(parse_msg(&json!([0x90, 60, 1, 2])).is_err());
        assert!(parse_msg(&json!([300, 1, 1])).is_err());
    }
}
