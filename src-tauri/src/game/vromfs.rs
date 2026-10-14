//! War Thunder's `.vromfs.bin` archives, read-only (`char.vromfs.bin`, `lang.vromfs.bin`…).
//!
//! The format isn't published; this follows what the community tools document and what the
//! files in a 2.59 install show:
//!
//! ```text
//! "VRFs" | "VRFx"  magic
//! platform         4 bytes ("\0\0PC")
//! original size    u32: size of the unpacked payload
//! packed           u32: low 26 bits = packed size (0: stored as is), high 6 bits = pack type
//! [VRFx]           u16 extension size, u16 flags, u32 version (bytes reversed: 2.59.0.65)
//! payload          `packed size` bytes, then a digest and a signature (ignored)
//! ```
//!
//! A packed payload is one zstd frame; its first 16 bytes, and the 16 bytes that end at its
//! length rounded down to 4, are XOR-ed with a fixed key ([`deobfuscate`]). The unpacked payload
//! is a file table: `u32` offset and `u32` count of the name offsets (`u64` each, pointing at
//! NUL-terminated paths), then `u32` offset of the data table (`u32` offset, `u32` size,
//! 8 bytes padding per file). The shared name map of binary BLK files is the file `\xff?nm`.
//!
//! Everything is bounds-checked: a damaged or changed file is a `parse` error, never a panic.

use crate::error::{AppError, AppResult, ErrorCode};
use std::collections::HashMap;
use std::path::Path;

/// Largest unpacked payload accepted (the language archive is ~56 MB in 2.59).
pub const MAX_UNPACKED: usize = 512 * 1024 * 1024;

/// Name of the shared name map of binary BLK files inside an archive.
pub const NAME_MAP_FILE: &str = "\u{ff}?nm";

/// `parse` message for an archive that can't be read.
pub const UNREADABLE_VROMFS: &str = "A War Thunder data file can't be read";

const KEY: [u32; 4] = [0xAA55_AA55, 0xF00F_F00F, 0xAA55_AA55, 0x1248_1248];
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

fn bad(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Parse, UNREADABLE_VROMFS).with_detail(detail.into())
}

/// What the header says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    /// `a.b.c.d` from a `VRFx` header.
    pub version: Option<String>,
    pub unpacked_size: usize,
    pub packed_size: usize,
    pub pack_type: u8,
}

/// An unpacked archive: file path → bytes.
#[derive(Debug, Default)]
pub struct Vromfs {
    pub header: Option<Header>,
    files: HashMap<String, (usize, usize)>,
    payload: Vec<u8>,
}

impl Vromfs {
    /// Reads and unpacks the archive at `path`.
    pub fn open(path: &Path) -> AppResult<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            let code = if e.kind() == std::io::ErrorKind::NotFound { ErrorCode::NotFound } else { ErrorCode::Io };
            AppError::new(code, UNREADABLE_VROMFS).with_detail(format!("{}: {e}", path.display()))
        })?;
        Self::from_bytes(&bytes)
    }

    /// Unpacks an archive held in memory.
    pub fn from_bytes(bytes: &[u8]) -> AppResult<Self> {
        let (header, body_start) = read_header(bytes)?;
        let payload = if header.packed_size == 0 {
            slice(bytes, body_start, header.unpacked_size)?.to_vec()
        } else {
            let mut body = slice(bytes, body_start, header.packed_size)?.to_vec();
            if !body.starts_with(&ZSTD_MAGIC) {
                deobfuscate(&mut body);
            }
            if !body.starts_with(&ZSTD_MAGIC) {
                return Err(bad(format!("pack type {:#x}: not a zstd payload", header.pack_type)));
            }
            let out = zstd::bulk::decompress(&body, header.unpacked_size).map_err(|e| bad(e.to_string()))?;
            if out.len() != header.unpacked_size {
                return Err(bad(format!("{} bytes unpacked, {} expected", out.len(), header.unpacked_size)));
            }
            out
        };
        let files = read_table(&payload)?;
        Ok(Self { header: Some(header), files, payload })
    }

    /// The file at `path` (`/`-separated, as stored), if any.
    pub fn file(&self, path: &str) -> Option<&[u8]> {
        self.files.get(path).map(|&(start, len)| &self.payload[start..start + len])
    }

    /// Every file path, sorted.
    pub fn paths(&self) -> Vec<&str> {
        let mut paths: Vec<&str> = self.files.keys().map(String::as_str).collect();
        paths.sort_unstable();
        paths
    }

    /// The archive's version (`VRFx` only), e.g. `2.59.0.65`.
    pub fn version(&self) -> Option<&str> {
        self.header.as_ref().and_then(|h| h.version.as_deref())
    }
}

fn slice(bytes: &[u8], start: usize, len: usize) -> AppResult<&[u8]> {
    start
        .checked_add(len)
        .and_then(|end| bytes.get(start..end))
        .ok_or_else(|| bad(format!("{len} bytes at {start} run past the end ({} bytes)", bytes.len())))
}

fn u16_at(bytes: &[u8], at: usize) -> AppResult<u16> {
    Ok(u16::from_le_bytes(slice(bytes, at, 2)?.try_into().expect("2 bytes")))
}

fn u32_at(bytes: &[u8], at: usize) -> AppResult<u32> {
    Ok(u32::from_le_bytes(slice(bytes, at, 4)?.try_into().expect("4 bytes")))
}

fn u64_at(bytes: &[u8], at: usize) -> AppResult<u64> {
    Ok(u64::from_le_bytes(slice(bytes, at, 8)?.try_into().expect("8 bytes")))
}

fn read_header(bytes: &[u8]) -> AppResult<(Header, usize)> {
    let magic = slice(bytes, 0, 4)?;
    let extended = match magic {
        b"VRFs" => false,
        b"VRFx" => true,
        _ => return Err(bad("not a vromfs archive")),
    };
    let unpacked_size = u32_at(bytes, 8)? as usize;
    let packed = u32_at(bytes, 12)?;
    if unpacked_size > MAX_UNPACKED {
        return Err(bad(format!("{unpacked_size} bytes unpacked is more than Livery reads")));
    }
    let packed_size = (packed & 0x03FF_FFFF) as usize;
    let pack_type = (packed >> 26) as u8;
    let mut start = 16;
    let mut version = None;
    if extended {
        let ext_size = usize::from(u16_at(bytes, 16)?);
        if ext_size >= 8 {
            let raw = u32_at(bytes, 20)?.to_le_bytes();
            version = Some(format!("{}.{}.{}.{}", raw[3], raw[2], raw[1], raw[0]));
        }
        start = 16 + ext_size;
    }
    Ok((Header { version, unpacked_size, packed_size, pack_type }, start))
}

/// XORs the first 16 bytes with the key, and the 16 bytes ending at the length rounded down to
/// 4 with the key reversed (the same operation hides and reveals).
pub fn deobfuscate(body: &mut [u8]) {
    let key: Vec<u8> = KEY.iter().flat_map(|k| k.to_le_bytes()).collect();
    let reversed: Vec<u8> = KEY.iter().rev().flat_map(|k| k.to_le_bytes()).collect();
    if body.len() >= 16 {
        body[..16].iter_mut().zip(&key).for_each(|(b, k)| *b ^= k);
    }
    if body.len() >= 32 {
        let end = body.len() & !3;
        body[end - 16..end].iter_mut().zip(&reversed).for_each(|(b, k)| *b ^= k);
    }
}

fn read_table(payload: &[u8]) -> AppResult<HashMap<String, (usize, usize)>> {
    let names_at = u32_at(payload, 0)? as usize;
    let count = u32_at(payload, 4)? as usize;
    let data_at = u32_at(payload, 16)? as usize;
    if count > 1_000_000 {
        return Err(bad(format!("{count} files")));
    }
    let mut files = HashMap::with_capacity(count);
    for i in 0..count {
        let name_at = usize::try_from(u64_at(payload, names_at + 8 * i)?).map_err(|_| bad("name offset"))?;
        let tail = payload.get(name_at..).ok_or_else(|| bad("name offset past the end"))?;
        let len = tail.iter().position(|&b| b == 0).ok_or_else(|| bad("unterminated name"))?;
        // Names are UTF-8 paths, except the name map's `\xff?nm`, read as Latin-1.
        let name = match std::str::from_utf8(&tail[..len]) {
            Ok(s) => s.to_owned(),
            Err(_) => tail[..len].iter().map(|&b| char::from(b)).collect(),
        };
        let start = u32_at(payload, data_at + 16 * i)? as usize;
        let size = u32_at(payload, data_at + 16 * i + 4)? as usize;
        slice(payload, start, size)?;
        files.insert(name, (start, size));
    }
    Ok(files)
}
