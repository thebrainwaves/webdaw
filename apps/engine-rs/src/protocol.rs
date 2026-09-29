//! Newline-delimited JSON over stdin/stdout, identical to the JUCE engine (protocol 1):
//!   request : {"id": 7, "cmd": "plugin.load", ...args}
//!   response: {"id": 7, "ok": true, "result": {...}}  or  {"id": 7, "ok": false, "error": "..."}
//!   event   : {"event": "scan.progress", ...}
//! stdout carries protocol lines only; logs go to stderr.
use serde_json::{Map, Value};
use std::io::Write;
use std::sync::Mutex;

pub const PROTOCOL_VERSION: i64 = 1;
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024; // plugin state chunks travel base64-encoded

static OUT: Mutex<()> = Mutex::new(());

pub fn write_line(v: &Value) {
    let s = serde_json::to_string(v).unwrap_or_else(|_| "{}".into());
    let _g = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(s.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

pub fn reply(id: &Value, result: Value) {
    let mut o = Map::new();
    o.insert("id".into(), id.clone());
    o.insert("ok".into(), Value::Bool(true));
    o.insert("result".into(), result);
    write_line(&Value::Object(o));
}

pub fn reply_error(id: &Value, msg: &str) {
    let mut o = Map::new();
    o.insert("id".into(), id.clone());
    o.insert("ok".into(), Value::Bool(false));
    o.insert("error".into(), Value::String(msg.into()));
    write_line(&Value::Object(o));
}

pub fn emit(event: &str, payload: Option<Map<String, Value>>) {
    let mut o = payload.unwrap_or_default();
    o.insert("event".into(), Value::String(event.into()));
    write_line(&Value::Object(o));
}

pub fn log(msg: &str) {
    let _g = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut e = std::io::stderr().lock();
    let _ = writeln!(e, "[auduio-engine] {msg}");
    let _ = e.flush();
}

/// JUCE's `num`: numbers and bools are accepted, anything else (or non-finite) gives the default
pub fn num(o: &Value, key: &str, def: f64) -> f64 {
    match o.get(key) {
        Some(Value::Number(n)) => n.as_f64().filter(|d| d.is_finite()).unwrap_or(def),
        Some(Value::Bool(b)) => if *b { 1.0 } else { 0.0 },
        _ => def,
    }
}
pub fn num_v(x: &Value, def: f64) -> f64 {
    match x {
        Value::Number(n) => n.as_f64().filter(|d| d.is_finite()).unwrap_or(def),
        Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        _ => def,
    }
}
pub fn str_(o: &Value, key: &str) -> String {
    match o.get(key) { Some(Value::String(s)) => s.clone(), _ => String::new() }
}
pub fn truthy(o: &Value, key: &str) -> bool {
    match o.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|d| d != 0.0).unwrap_or(false),
        Some(Value::String(s)) => s == "true" || s == "1",
        _ => false,
    }
}
pub fn has(o: &Value, key: &str) -> bool { o.get(key).map(|v| !v.is_null()).unwrap_or(false) }

pub type Obj = Map<String, Value>;
#[macro_export]
macro_rules! obj {
    ($($k:expr => $v:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut m = serde_json::Map::new();
        $( m.insert(($k).to_string(), serde_json::json!($v)); )*
        m
    }};
}
