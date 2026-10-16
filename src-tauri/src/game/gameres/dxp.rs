//! DxP2 texture packs (`*.dxp.bin`, formats doc section 3): the directory (names, DDSx headers,
//! data records, parallel arrays by index) and the top mip level of a DXT1/DXT5 texture.
//!
//! ```text
//! 0x00 "DxP2" | u32 version (2|3) | u32 texCount | u32 dumpSize
//! 0x10 dump: names tab (8-byte name pointers), headers tab (32-byte DDSx), records tab
//!      (v2: 24 bytes {u64, i32 texId, i32 ofs, i32 packedDataSize, i32}; v3: 12 bytes
//!      {i32 texId, i32 ofs, i32 packedDataSize}); offsets relative to the dump, `ofs` absolute
//! DDSx: "DDSx" | u32 fourcc | u32 flags | u16 w, h | u8 levels, hqPartLevels | u16 depth |
//!       u16 bitsPerPixel | u8 lQmip:4 mQmip:4 | u8 dxtShift:4 uQmip:4 | u32 memSz | u32 packedSz
//! ```

use super::bad;
use super::bytes::Reader;
use super::codec::{oodle, zstd, MAX_TEXTURE_LEVEL};
use crate::error::{AppError, AppResult, ErrorCode};
use std::io::{Read, Seek, SeekFrom};

const DUMP_AT: usize = 0x10;
const HEADER: usize = 32;

const COMPRESSION: u32 = 0xE000_0000;
const COMPRESSION_NONE: u32 = 0;
const COMPRESSION_ZSTD: u32 = 0x2000_0000;
const COMPRESSION_OODLE: u32 = 0x6000_0000;
const GENMIP: u32 = 0x2000 | 0x4000;
const REV_MIP_ORDER: u32 = 0x40000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DdsxHeader {
    pub fourcc: [u8; 4],
    pub flags: u32,
    pub w: u16,
    pub h: u16,
    pub levels: u8,
    pub dxt_shift: u8,
    pub mem_sz: u32,
    pub packed_sz: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DxpEntry {
    pub name: String,
    pub header: DdsxHeader,
    /// Absolute offset of the texture's data in the pack.
    pub ofs: u64,
    pub data_size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DxpDir {
    pub entries: Vec<DxpEntry>,
}

impl DxpDir {
    /// Reads the directory from the pack's head: its first `16 + dumpSize` bytes (or more, or
    /// the `.dxp.bincache.bin` copy the game keeps in `grp_hdr.vromfs.bin`).
    pub fn parse(head: &[u8]) -> AppResult<Self> {
        let h = Reader::new(head);
        if h.slice(0, 4).ok() != Some(b"DxP2".as_slice()) {
            return Err(bad("not a DxP2 texture pack"));
        }
        let version = h.u32_at(4)?;
        let record = match version {
            2 => 24,
            3 => 12,
            other => return Err(bad(format!("DxP2 version {other}"))),
        };
        let tex_count = h.u32_at(8)?;
        let dump_size = h.u32_at(12)? as usize;
        let r = Reader::new(h.slice(DUMP_AT, dump_size)?);
        let (names_ofs, count) = r.tab(0)?;
        let (headers_ofs, headers) = r.tab(0x10)?;
        let (records_ofs, records) = r.tab(0x20)?;
        if headers != count || records != count || tex_count != count {
            return Err(bad(format!("{tex_count} textures: {count} names, {headers} headers, {records} records")));
        }
        let (names_ofs, headers_ofs, records_ofs, count) =
            (names_ofs as usize, headers_ofs as usize, records_ofs as usize, count as usize);
        // Bounds first, so the count can't make us allocate more than the dump holds.
        r.slice(names_ofs, count * 8)?;
        r.slice(headers_ofs, count * HEADER)?;
        r.slice(records_ofs, count * record)?;

        let mut entries = Vec::with_capacity(count);
        for i in 0..count {
            let name = r.cstr(r.u32_at(names_ofs + 8 * i)? as usize)?;
            let o = headers_ofs + HEADER * i;
            if r.slice(o, 4)? != b"DDSx" {
                return Err(bad(format!("texture {name}: header {:02X?}", r.slice(o, 4)?)));
            }
            let header = DdsxHeader {
                fourcc: r.u32_at(o + 4)?.to_le_bytes(),
                flags: r.u32_at(o + 8)?,
                w: r.u16_at(o + 12)?,
                h: r.u16_at(o + 14)?,
                levels: r.u8_at(o + 16)?,
                dxt_shift: r.u8_at(o + 23)? & 0xF,
                mem_sz: r.u32_at(o + 24)?,
                packed_sz: r.u32_at(o + 28)?,
            };
            let rec = records_ofs + record * i + if version == 2 { 8 } else { 0 };
            let ofs = r.i32_at(rec + 4)?;
            let size = r.i32_at(rec + 8)?;
            let (Ok(ofs), Ok(data_size)) = (u64::try_from(ofs), u32::try_from(size)) else {
                return Err(bad(format!("texture {name}: data at {ofs}, {size} bytes")));
            };
            entries.push(DxpEntry { name, header, ofs, data_size });
        }
        Ok(Self { entries })
    }
}

/// Base name of an entry: the part before `*` or `$` (e.g. `m4a3e2_sherman_jumbo_body_c`).
pub fn base_name(entry: &str) -> &str {
    entry.find(['*', '$']).map_or(entry, |end| &entry[..end])
}

/// `true` for the `$hq` part.
pub fn is_hq(entry: &str) -> bool {
    entry[base_name(entry).len()..].starts_with("$hq")
}

/// Bytes of the top mip level of a `w` x `h` texture with 4x4 blocks of `1 << dxt_shift` bytes.
/// Rounds down like the engine (`ddsx::Header::calcSurfaceSz`: `max(w >> 2, 1)`), where
/// `bc::decode` rounds up (`w.div_ceil(4)`): the two agree on every size the game uses (powers of
/// two, and anything under 4), and a texture they'd disagree on (say 6 wide) is refused by
/// `bc::decode` for having too few blocks, never misread.
pub fn top_level_size(header: &DdsxHeader) -> usize {
    (usize::from(header.w >> 2).max(1) * usize::from(header.h >> 2).max(1)) << header.dxt_shift
}

/// Reads and unpacks the entry's data, returns the top mip level's BC blocks (w x h). Only DXT1
/// and DXT5 are accepted. Compression (`flags & 0xE0000000`): none, zstd or Oodle (a bare stream
/// unpacking to `mem_sz`). With a GENMIP flag only the top level is stored (Kaiser adds 12 bytes
/// after it); else with REV_MIP_ORDER the levels run smallest first (the top is the last
/// `top` bytes); else the top comes first.
pub fn top_level(file: &mut (impl Read + Seek), e: &DxpEntry) -> AppResult<Vec<u8>> {
    let h = &e.header;
    let shift = match &h.fourcc {
        b"DXT1" => 3,
        b"DXT5" => 4,
        other => return Err(bad(format!("texture format {:?} of {}", String::from_utf8_lossy(other), e.name))),
    };
    if h.dxt_shift != shift || h.w == 0 || h.h == 0 {
        return Err(bad(format!("texture {}: {}x{} with block shift {}", e.name, h.w, h.h, h.dxt_shift)));
    }
    let size = e.data_size as usize;
    if size > MAX_TEXTURE_LEVEL || h.mem_sz as usize > MAX_TEXTURE_LEVEL {
        return Err(bad(format!("texture {} of {size} bytes ({} unpacked)", e.name, h.mem_sz)));
    }
    let io = |err: std::io::Error| {
        AppError::new(ErrorCode::Io, super::MODEL_UNREADABLE).with_detail(format!("texture {}: {err}", e.name))
    };
    file.seek(SeekFrom::Start(e.ofs)).map_err(io)?;
    // Grows with what the file really holds: a size past the end allocates nothing up front.
    let mut blob = Vec::new();
    file.take(size as u64).read_to_end(&mut blob).map_err(io)?;
    if blob.len() != size {
        return Err(bad(format!("texture {}: {} of {size} bytes", e.name, blob.len())));
    }

    let mut data = match h.flags & COMPRESSION {
        COMPRESSION_NONE => blob,
        compression => {
            let len = if h.packed_sz == 0 { size } else { h.packed_sz as usize };
            let src =
                blob.get(..len).ok_or_else(|| bad(format!("texture {}: {len} packed bytes in {size}", e.name)))?;
            let mem_sz = h.mem_sz as usize;
            let data = match compression {
                COMPRESSION_ZSTD => zstd(src, mem_sz)?,
                COMPRESSION_OODLE => oodle(src, mem_sz, MAX_TEXTURE_LEVEL)?,
                other => return Err(bad(format!("texture {}: compression {other:#010X}", e.name))),
            };
            if data.len() != mem_sz {
                return Err(bad(format!("texture {}: unpacked {} of {mem_sz} bytes", e.name, data.len())));
            }
            data
        }
    };

    let top = top_level_size(h);
    let Some(rest) = data.len().checked_sub(top) else {
        return Err(bad(format!("texture {}: {} bytes, the top level needs {top}", e.name, data.len())));
    };
    if h.flags & GENMIP == 0 && h.flags & REV_MIP_ORDER != 0 {
        data.drain(..rest);
    } else {
        data.truncate(top);
    }
    Ok(data)
}
