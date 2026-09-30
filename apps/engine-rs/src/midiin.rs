//! Hardware MIDI input for the desktop app (webviews on macOS/Linux have no Web MIDI).
//! `midiin.list`, `midiin.open {port}`, `midiin.close {port?}`. Incoming messages become events
//! `{"event":"midiin","port":name,"d":[bytes]}`. Same safety rules as MIDI out: channel voice messages only
//! (no SysEx, clock or other system messages), at most 16 open ports and 2000 messages per second per port
//! (the rest is dropped, so a runaway device cannot flood the app).
//! `AUDUIO_MIDI_TEST_SOURCE=1` adds a virtual port "Auduio Test Source" fed by `midiin.inject {d}` (tests only).

use crate::midiout::channel_len;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Instant;

pub const TEST_SOURCE_NAME: &str = "Auduio Test Source";
const MAX_PORTS: usize = 16;
const MAX_PER_SEC: u32 = 2000;
const MAX_PORT_NAME: usize = 256;

struct Limiter { window: Instant, count: u32 }
impl Limiter {
    fn new() -> Self { Limiter { window: Instant::now(), count: 0 } }
    fn allow(&mut self) -> bool {
        if self.window.elapsed().as_secs_f64() >= 1.0 { self.window = Instant::now(); self.count = 0; }
        self.count += 1; self.count <= MAX_PER_SEC
    }
}

/// Filters one raw message; returns the bytes to forward.
pub fn accept(b: &[u8]) -> Option<Vec<u8>> {
    let st = *b.first()?; let len = channel_len(st)?;
    if b.len() < len || b[1..len].iter().any(|&x| x >= 0x80) { return None; }
    Some(b[..len].to_vec())
}

fn emit_msg(port: &str, d: &[u8]) {
    let mut m = Map::new();
    m.insert("port".into(), Value::String(port.to_string()));
    m.insert("d".into(), Value::Array(d.iter().map(|&x| json!(x)).collect()));
    crate::protocol::emit("midiin", Some(m));
}

enum Conn { Os(midir::MidiInputConnection<()>), Test(Limiter) }

pub struct MidiIn { conns: HashMap<String, Conn> }

fn test_enabled() -> bool { std::env::var_os("AUDUIO_MIDI_TEST_SOURCE").is_some() }

impl MidiIn {
    pub fn new() -> MidiIn { MidiIn { conns: HashMap::new() } }
    pub fn handle(&mut self, cmd: &str, a: &Value) -> Result<Value, String> {
        match cmd {
            "midiin.list" => {
                let mut names = vec![]; let mut err = None;
                match midir::MidiInput::new("Auduio") {
                    Ok(inp) => for p in inp.ports() { if let Ok(n) = inp.port_name(&p) { names.push(n); } },
                    Err(e) => err = Some(e.to_string()),
                }
                if test_enabled() { names.push(TEST_SOURCE_NAME.to_string()); }
                let ports: Vec<Value> = names.iter().map(|n| json!({ "id": n, "name": n, "open": self.conns.contains_key(n) })).collect();
                Ok(json!({ "ports": ports, "error": err }))
            }
            "midiin.open" => {
                let port = a.get("port").and_then(|v| v.as_str()).unwrap_or("");
                if port.is_empty() || port.len() > MAX_PORT_NAME { return Err("bad port".into()); }
                if self.conns.contains_key(port) { return Ok(json!({ "open": true })); }
                if self.conns.len() >= MAX_PORTS { return Err("too many open MIDI inputs".into()); }
                if port == TEST_SOURCE_NAME && test_enabled() { self.conns.insert(port.into(), Conn::Test(Limiter::new())); return Ok(json!({ "open": true })); }
                let mut inp = midir::MidiInput::new("Auduio").map_err(|e| e.to_string())?;
                inp.ignore(midir::Ignore::All);
                let p = inp.ports().into_iter().find(|p| inp.port_name(p).map(|n| n == port).unwrap_or(false)).ok_or_else(|| format!("MIDI input not found: {port}"))?;
                let name = port.to_string();
                let mut lim = Limiter::new();
                let conn = inp.connect(&p, "Auduio In", move |_ts, b, _| { if let Some(d) = accept(b) { if lim.allow() { emit_msg(&name, &d); } } }, ())
                    .map_err(|e| e.to_string())?;
                self.conns.insert(port.into(), Conn::Os(conn));
                Ok(json!({ "open": true }))
            }
            "midiin.close" => {
                match a.get("port").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    Some(p) => { if let Some(Conn::Os(c)) = self.conns.remove(p) { c.close(); } }
                    None => { for (_, c) in self.conns.drain() { if let Conn::Os(c) = c { c.close(); } } }
                }
                Ok(json!(true))
            }
            "midiin.inject" => {
                if !test_enabled() { return Err("unknown command: midiin.inject".into()); }
                let Some(Conn::Test(lim)) = self.conns.get_mut(TEST_SOURCE_NAME) else { return Err("test source not open".into()) };
                let d: Vec<u8> = a.get("d").and_then(|v| v.as_array()).ok_or("d must be an array")?.iter().take(3).map(|x| x.as_u64().unwrap_or(256).min(255) as u8).collect();
                match accept(&d) { Some(d) if lim.allow() => { emit_msg(TEST_SOURCE_NAME, &d); Ok(json!({ "sent": true })) } Some(_) => Ok(json!({ "sent": false, "dropped": "rate" })), None => Ok(json!({ "sent": false, "dropped": "filtered" })) }
            }
            _ => Err(format!("unknown command: {cmd}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_input() {
        assert_eq!(accept(&[0x90, 60, 100]), Some(vec![0x90, 60, 100]));
        assert_eq!(accept(&[0xC0, 5, 99]), Some(vec![0xC0, 5]));
        assert_eq!(accept(&[0xF0, 1, 2, 0xF7]), None);
        assert_eq!(accept(&[0xF8]), None);
        assert_eq!(accept(&[0x90, 60]), None);
        assert_eq!(accept(&[0x90, 200, 1]), None);
        let mut l = Limiter::new(); let n = (0..3000).filter(|_| l.allow()).count(); assert_eq!(n, 2000);
    }
}
