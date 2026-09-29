//! Small helpers: JUCE-compatible identifiers and state blobs (so projects saved with the JUCE engine
//! keep finding and restoring their plugins), file times, UTF-16 strings.
use std::path::Path;

/// juce::String::hashCode(): 31-multiplier hash over UTF-32 code points, as a 32-bit int
pub fn juce_hash(s: &str) -> i32 {
    let mut h: u32 = 0;
    for c in s.chars() { h = h.wrapping_mul(31).wrapping_add(c as u32); }
    h as i32
}
/// juce::String::toHexString(int): lowercase hex of the unsigned 32-bit value, no padding
pub fn juce_hex(v: i32) -> String { format!("{:x}", v as u32) }

/// JUCE's PluginDescription::createIdentifierString()
pub fn juce_identifier(format: &str, name: &str, file: &str, unique_id: i32, deprecated_uid: i32) -> String {
    let id = if unique_id != 0 { unique_id } else { deprecated_uid };
    format!("{format}-{name}-{}-{}", juce_hex(juce_hash(file)), juce_hex(id))
}

/// VST3 class id (16 bytes as laid out in memory by the plugin) -> JUCE uniqueId / deprecatedUid
pub fn vst3_juce_ids(cid: &[std::ffi::c_char; 16]) -> (i32, i32) {
    // deprecatedUid: hash over the raw chars (char is signed on x86/arm Linux+Windows: sign-extended)
    let mut dep: u32 = 0;
    for &c in cid.iter() { dep = dep.wrapping_mul(31).wrapping_add(c as i32 as u32); }
    // uniqueId: hash over FUID::getLong1..4 (platform-normalised)
    let b: Vec<u32> = cid.iter().map(|&c| c as u8 as u32).collect();
    let mk = |a: u32, b1: u32, c: u32, d: u32| (a << 24) | (b1 << 16) | (c << 8) | d;
    let (l1, l2) = if cfg!(windows) {
        (mk(b[3], b[2], b[1], b[0]), mk(b[5], b[4], b[7], b[6]))
    } else {
        (mk(b[0], b[1], b[2], b[3]), mk(b[4], b[5], b[6], b[7]))
    };
    let l3 = mk(b[8], b[9], b[10], b[11]);
    let l4 = mk(b[12], b[13], b[14], b[15]);
    let mut uid: u32 = 0;
    for l in [l1, l2, l3, l4] { uid = uid.wrapping_mul(31).wrapping_add(l); }
    (uid as i32, dep as i32)
}

// ---- JUCE MemoryBlock::toBase64Encoding (its own "size.chars" format, used inside VST3 state XML)
const JB64: &[u8] = b".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+";
pub fn juce_b64_encode(data: &[u8]) -> String {
    let nchars = (data.len() * 8 + 5) / 6;
    let mut s = String::with_capacity(nchars + 12);
    s.push_str(&data.len().to_string());
    s.push('.');
    for i in 0..nchars {
        let bit = i * 6;
        let mut res = 0u32; let mut bits_so_far = 0; let mut nbits = 6usize;
        let mut byte = bit >> 3; let mut off = bit & 7;
        while nbits > 0 && byte < data.len() {
            let t = nbits.min(8 - off);
            let mask = ((0xffu32 >> (8 - t)) << off) as u32;
            res |= ((data[byte] as u32 & mask) >> off) << bits_so_far;
            bits_so_far += t; nbits -= t; byte += 1; off = 0;
        }
        s.push(JB64[res as usize] as char);
    }
    s
}
pub fn juce_b64_decode(s: &str) -> Option<Vec<u8>> {
    let dot = s.find('.')?;
    let n: usize = s[..dot].trim().parse().ok()?;
    if n > 512 * 1024 * 1024 { return None; }
    let mut out = vec![0u8; n];
    let mut pos = 0usize;
    for c in s[dot + 1..].bytes() {
        let v = match JB64.iter().position(|&x| x == c) { Some(v) => v as u32, None => continue };
        // setBitRange(pos, 6, v)
        let mut nbits = 6usize; let mut bits = v; let mut byte = pos >> 3; let mut off = pos & 7;
        while nbits > 0 && byte < n {
            let t = nbits.min(8 - off);
            let m = ((1u32 << t) - 1) << off;
            out[byte] = ((out[byte] as u32 & !m) | ((bits << off) & m)) as u8;
            byte += 1; nbits -= t; bits >>= t; off = 0;
        }
        pos += 6;
    }
    Some(out)
}

// ---- JUCE AudioProcessor::copyXmlToBinary / getXmlFromBinary with <VST3PluginState>
const MAGIC_XML: u32 = 0x21324356;
pub fn vst3_state_to_juce_blob(component: Option<&[u8]>, controller: Option<&[u8]>) -> Vec<u8> {
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?> <VST3PluginState>");
    if let Some(c) = component { xml.push_str("<IComponent>"); xml.push_str(&juce_b64_encode(c)); xml.push_str("</IComponent>"); }
    if let Some(c) = controller { xml.push_str("<IEditController>"); xml.push_str(&juce_b64_encode(c)); xml.push_str("</IEditController>"); }
    xml.push_str("</VST3PluginState>");
    let mut out = Vec::with_capacity(xml.len() + 9);
    out.extend_from_slice(&MAGIC_XML.to_le_bytes());
    out.extend_from_slice(&(xml.len() as u32).to_le_bytes()); // like JUCE copyXmlToBinary: length excludes the NUL
    out.extend_from_slice(xml.as_bytes());
    out.push(0);
    out
}
/// Returns (IComponent state, IEditController state). Accepts the JUCE blob only.
pub fn vst3_state_from_juce_blob(data: &[u8]) -> Option<(Option<Vec<u8>>, Option<Vec<u8>>)> {
    if data.len() <= 8 || u32::from_le_bytes([data[0], data[1], data[2], data[3]]) != MAGIC_XML { return None; }
    let len = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let end = (8 + len).min(data.len());
    let text = String::from_utf8_lossy(&data[8..end]);
    let text = text.trim_end_matches('\0');
    let grab = |tag: &str| -> Option<Vec<u8>> {
        let open = format!("<{tag}>"); let close = format!("</{tag}>");
        let a = text.find(&open)? + open.len();
        let b = text[a..].find(&close)? + a;
        juce_b64_decode(xml_unescape(text[a..b].trim()).as_str())
    };
    Some((grab("IComponent"), grab("IEditController")))
}
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

pub fn mtime_ms(p: &Path) -> i64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn utf16_to_string(buf: &[u16]) -> String {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n])
}
pub fn cstr_to_string(buf: &[std::ffi::c_char]) -> String {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let b: Vec<u8> = buf[..n].iter().map(|&c| c as u8).collect();
    String::from_utf8_lossy(&b).into_owned()
}
pub unsafe fn ptr_to_string(p: *const std::ffi::c_char) -> String {
    if p.is_null() { return String::new(); }
    std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned()
}

pub fn data_dir() -> std::path::PathBuf {
    let dir = match std::env::var("AUDUIO_ENGINE_DATA") {
        Ok(s) if !s.is_empty() => std::path::PathBuf::from(s),
        _ => {
            // same place as JUCE's userApplicationDataDirectory/Auduio
            #[cfg(target_os = "windows")]
            { std::path::PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into())).join("Auduio") }
            #[cfg(target_os = "macos")]
            { std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join("Library").join("Auduio") }
            #[cfg(all(unix, not(target_os = "macos")))]
            { std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".config").join("Auduio") }
        }
    };
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn b64_roundtrip() {
        for n in 0..70 {
            let d: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(juce_b64_decode(&juce_b64_encode(&d)).unwrap(), d);
        }
    }
    #[test]
    fn state_roundtrip() {
        let b = vst3_state_to_juce_blob(Some(b"abc\x00\xff"), Some(b"xyz"));
        let (c, e) = vst3_state_from_juce_blob(&b).unwrap();
        assert_eq!(c.unwrap(), b"abc\x00\xff"); assert_eq!(e.unwrap(), b"xyz");
    }
}
