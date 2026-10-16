//! Block codec of the game packs: the IGenLoad block (`u32 L`, tag in the top two bits, size in
//! the low 30) and the compressions it names, plus the bare Oodle streams of texture packs.
//!
//! Oodle is read with the pure-Rust `oozextract` crate; Livery never loads game code. Every
//! output size is checked against a limit before anything is allocated.

use super::bad;
use super::bytes::Reader;
use crate::error::AppResult;
use std::io::Read;

/// Largest unpacked block of vertex data accepted.
pub const MAX_VERTEX_DATA: usize = 256 * 1024 * 1024;
/// Largest unpacked texture level accepted.
pub const MAX_TEXTURE_LEVEL: usize = 128 * 1024 * 1024;

/// Compression of an IGenLoad block (`u32 L`: tag = L >> 30, size = L & 0x3FFF_FFFF).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tag {
    None,
    Zstd,
    Oodle,
}

impl Tag {
    fn from_bits(bits: u32) -> AppResult<Self> {
        match bits {
            0 => Ok(Tag::None),
            1 => Ok(Tag::Zstd),
            2 => Ok(Tag::Oodle),
            other => Err(bad(format!("block compression {other}"))),
        }
    }
}

/// Reads one block at `cur`'s position and returns the unpacked bytes. OODLE: `u32 rawSize` then
/// `size - 4` bytes of stream; ZSTD: one frame of `size` bytes; NONE: `size` raw bytes. `max`
/// bounds the unpacked size.
pub fn read_block(cur: &mut Reader, max: usize) -> AppResult<Vec<u8>> {
    let head = cur.u32()?;
    let tag = Tag::from_bits(head >> 30)?;
    let size = (head & 0x3FFF_FFFF) as usize;
    let payload = cur.take(size)?;
    match tag {
        Tag::None => {
            if size > max {
                return Err(bad(format!("block of {size} bytes over the {max} limit")));
            }
            Ok(payload.to_vec())
        }
        Tag::Zstd => zstd(payload, max),
        Tag::Oodle => {
            let (raw, stream) = payload.split_first_chunk::<4>().ok_or_else(|| bad("Oodle block without a size"))?;
            oodle(stream, u32::from_le_bytes(*raw) as usize, max)
        }
    }
}

/// A bare Oodle stream of known unpacked length (DxP2 textures). Fails unless the stream
/// unpacks to exactly `raw_len` bytes; `raw_len > max` is rejected before allocating.
pub fn oodle(src: &[u8], raw_len: usize, max: usize) -> AppResult<Vec<u8>> {
    if raw_len > max {
        return Err(bad(format!("Oodle stream unpacks to {raw_len} bytes, over the {max} limit")));
    }
    let mut out = vec![0u8; raw_len];
    let written =
        oozextract::Extractor::new().read_from_slice(src, &mut out).map_err(|e| bad(format!("oodle: {e}")))?;
    if written != raw_len {
        return Err(bad(format!("Oodle stream unpacked {written} of {raw_len} bytes")));
    }
    Ok(out)
}

/// One zstd frame, at most `max` bytes.
pub fn zstd(src: &[u8], max: usize) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    zstd::stream::read::Decoder::new(src)
        .and_then(|d| d.take((max as u64).saturating_add(1)).read_to_end(&mut out))
        .map_err(|e| bad(format!("zstd: {e}")))?;
    if out.len() > max {
        return Err(bad(format!("zstd frame unpacks to more than {max} bytes")));
    }
    Ok(out)
}
