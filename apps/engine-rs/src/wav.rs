//! Minimal 24-bit PCM WAV writer (offline renders).
use std::io::Write;
pub fn write_wav24(path: &str, sr: u32, l: &[f32], r: &[f32]) -> std::io::Result<()> {
    let n = l.len().min(r.len());
    let data_len = (n * 2 * 3) as u32;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"RIFF")?; f.write_all(&(36 + data_len).to_le_bytes())?; f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?; f.write_all(&16u32.to_le_bytes())?; f.write_all(&1u16.to_le_bytes())?; f.write_all(&2u16.to_le_bytes())?;
    f.write_all(&sr.to_le_bytes())?; f.write_all(&(sr * 6).to_le_bytes())?; f.write_all(&6u16.to_le_bytes())?; f.write_all(&24u16.to_le_bytes())?;
    f.write_all(b"data")?; f.write_all(&data_len.to_le_bytes())?;
    for i in 0..n {
        for s in [l[i], r[i]] {
            let v = (s.clamp(-1.0, 1.0) as f64 * 8388607.0).round() as i32;
            f.write_all(&v.to_le_bytes()[..3])?;
        }
    }
    f.flush()
}
