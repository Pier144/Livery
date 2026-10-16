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
///
/// Only Kraken-family streams get to the decoder ([`check_kraken_family`]), and the decoder runs
/// inside `catch_unwind`: `oozextract` `assert!`s on damaged data (its tANS and Huffman tables,
/// its bit reader) instead of returning an error, and about one damaged block in eight trips one.
/// A panic is reported as a `parse` error ("oodle stream damaged"). That is sound here because
/// the decoder only writes into the buffer this function owns and drops with the panic, and the
/// crate's only `unsafe` is SIMD on fixed-size buffers, so unwinding can't leave memory corrupt.
/// It relies on the release profile unwinding (`panic = "unwind"` in `Cargo.toml`); no global
/// panic hook is installed, so the default message may reach stderr, and one `warn` is logged.
pub fn oodle(src: &[u8], raw_len: usize, max: usize) -> AppResult<Vec<u8>> {
    if raw_len > max {
        return Err(bad(format!("Oodle stream unpacks to {raw_len} bytes, over the {max} limit")));
    }
    check_kraken_family(src, raw_len)?;
    let mut out = vec![0u8; raw_len];
    let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        oozextract::Extractor::new().read_from_slice(src, &mut out)
    }));
    let written = match decoded {
        Ok(result) => result.map_err(|e| bad(format!("oodle: {e}")))?,
        Err(_) => {
            tracing::warn!("oozextract panicked on a damaged Oodle stream ({} bytes in, {raw_len} out)", src.len());
            return Err(bad("oodle stream damaged"));
        }
    };
    if written != raw_len {
        return Err(bad(format!("Oodle stream unpacked {written} of {raw_len} bytes")));
    }
    Ok(out)
}

/// Output bytes per Oodle block (each starts with its own header).
const OODLE_BLOCK: usize = 0x40000;

/// Walks the block and quantum headers of an Oodle stream that unpacks to `raw_len` bytes and
/// rejects anything but the Kraken family (Kraken, Mermaid, Leviathan), which is all the game
/// uses. `oozextract` also decodes BitKnit and LZNA, and those decoders panic on damaged input;
/// with `panic = "abort"` that would take the app down, so they never get to run.
///
/// The layout is the one `oozextract` parses, so the walk and the decoder agree on where every
/// block ends. Per block of 256 KiB of output:
///
/// ```text
/// byte 0   low nibble 0xC (magic), bits 4-5 zero, bit 6 uncompressed, bit 7 restart decoder
/// byte 1   low 7 bits decoder type (6 Kraken, 0xA Mermaid, 0xC Leviathan), bit 7 checksums
/// then     uncompressed: the block's bytes; else a 3-byte big-endian quantum header:
///          size = v & 0x3FFFF; size != 0x3FFFF: `size + 1` compressed bytes follow;
///          else v >> 18 == 1: one byte (memset); anything else is invalid
/// ```
///
/// Checksummed streams are refused too: `oozextract` doesn't read their checksum bytes.
pub fn check_kraken_family(src: &[u8], raw_len: usize) -> AppResult<()> {
    let mut cur = Reader::new(src);
    let mut written = 0;
    while written < raw_len {
        let (b1, b2) = (cur.u8()?, cur.u8()?);
        if b1 & 0xF != 0xC || (b1 >> 4) & 3 != 0 {
            return Err(bad(format!("oodle block header {b1:02X} {b2:02X}")));
        }
        match b2 & 0x7F {
            0x6 | 0xA | 0xC => {}
            other => return Err(bad(format!("oodle decoder {other:#X} isn't Kraken, Mermaid or Leviathan"))),
        }
        if b2 & 0x80 != 0 {
            return Err(bad("oodle stream with checksums"));
        }
        let block = (raw_len - written).min(OODLE_BLOCK);
        if b1 & 0x40 != 0 {
            cur.skip(block)?;
        } else {
            let quantum = u32::from_be_bytes([0, cur.u8()?, cur.u8()?, cur.u8()?]);
            match quantum & 0x3FFFF {
                0x3FFFF if quantum >> 18 == 1 => cur.skip(1)?,
                0x3FFFF => return Err(bad(format!("oodle quantum header {quantum:#X}"))),
                size => cur.skip(size as usize + 1)?,
            }
        }
        written += block;
    }
    Ok(())
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
