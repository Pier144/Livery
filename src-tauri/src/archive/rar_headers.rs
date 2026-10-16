//! Livery's own reader of RAR block headers (RAR 1.5–4 and RAR 5–7): the list of what an archive
//! holds, in the order its data comes, and every check that has to happen before anything is
//! decoded. Decoding itself is left to 7-Zip or WinRAR ([`super::rar_tool`]); nothing here reads
//! compressed data.
//!
//! Refused: one volume of a split archive (first or later), encrypted headers or files, a link
//! (Unix symbolic link mode, a Windows reparse point, a RAR 5 redirection record: link, hard link,
//! file copy), a RAR 5 dictionary above [`super::unpack::MAX_DICTIONARY_BYTES`], a file of
//! unknown size, a header whose CRC doesn't match, and a header or data area that runs past the
//! end of the file. A file that doesn't start with a RAR signature (a renamed self-extracting
//! `.exe`, RAR 1.4) is [`super::unpack::NOT_AN_ARCHIVE`].
//!
//! Formats: RarLab's technote for RAR 5 (`rarlab.com/technote.htm`) and the RAR 2.9 `technote.txt`
//! that ships with UnRAR 3–6 for RAR 1.5–4.

use super::unpack::{self, Limits, MAX_DICTIONARY_BYTES, REPARSE_POINT};
use crate::error::{AppError, AppResult, ErrorCode};
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// RAR 1.5–4 signature (its dictionaries are 4 MB at most).
pub const RAR4_SIGNATURE: &[u8] = b"Rar!\x1A\x07\x00";
/// RAR 5 (and 7) signature.
pub const RAR5_SIGNATURE: &[u8] = b"Rar!\x1A\x07\x01\x00";

/// The two header formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RarFormat {
    /// RAR 1.5–4.
    Rar4,
    /// RAR 5 and 7.
    Rar5,
}

/// One file or folder header, as the archive spells it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RarItem {
    pub name: String,
    /// Unpacked size (0 for folders).
    pub size: u64,
    pub is_dir: bool,
}

/// What [`read_headers`] found: the file and folder headers in archive order, which is the order a
/// decoder hands out their data.
#[derive(Debug, Clone)]
pub struct RarHeaders {
    pub format: RarFormat,
    pub items: Vec<RarItem>,
}

/// Reads and checks every block header of the RAR at `path` (see the module docs).
pub fn read_headers(path: &Path, limits: Limits) -> AppResult<RarHeaders> {
    let file = File::open(path).map_err(io_error)?;
    let len = file.metadata().map_err(io_error)?.len();
    let mut reader = Blocks { reader: BufReader::new(file), len };
    let mut signature = Vec::with_capacity(RAR5_SIGNATURE.len());
    (&mut reader.reader).take(RAR5_SIGNATURE.len() as u64).read_to_end(&mut signature).map_err(io_error)?;
    let max_blocks = limits.max_entries.saturating_mul(8).max(64);
    if signature == RAR5_SIGNATURE {
        let items = reader.rar5(max_blocks)?;
        Ok(RarHeaders { format: RarFormat::Rar5, items })
    } else if signature.starts_with(RAR4_SIGNATURE) {
        let items = reader.rar4(max_blocks)?;
        Ok(RarHeaders { format: RarFormat::Rar4, items })
    } else {
        Err(unpack::not_an_archive("no RAR signature at the start"))
    }
}

fn io_error(e: io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not open the file or folder").with_detail(e.to_string())
}

fn too_many_blocks(max_blocks: usize) -> AppError {
    AppError::new(ErrorCode::InvalidInput, unpack::ARCHIVE_TOO_MANY_FILES)
        .with_detail(format!("more than {max_blocks} RAR blocks"))
}

fn cut_short() -> AppError {
    unpack::damaged("the archive ends inside a header or its data")
}

/// The archive file, read one block header at a time.
struct Blocks {
    reader: BufReader<File>,
    len: u64,
}

impl Blocks {
    /// Exactly `n` bytes at `at`, or [`cut_short`] when the file ends first.
    fn bytes_at(&mut self, at: u64, n: u64) -> AppResult<Vec<u8>> {
        if !matches!(at.checked_add(n), Some(end) if end <= self.len) {
            return Err(cut_short());
        }
        self.reader.seek(SeekFrom::Start(at)).map_err(|e| unpack::damaged(e.to_string()))?;
        let mut out = Vec::with_capacity(usize::try_from(n).unwrap_or(0));
        (&mut self.reader).take(n).read_to_end(&mut out).map_err(|e| unpack::damaged(e.to_string()))?;
        if out.len() as u64 != n {
            return Err(cut_short());
        }
        Ok(out)
    }

    /// RAR 5: `CRC32 · header size (vint) · header`, each header followed by its data area.
    fn rar5(&mut self, max_blocks: usize) -> AppResult<Vec<RarItem>> {
        let mut items = Vec::new();
        let mut at = RAR5_SIGNATURE.len() as u64;
        let mut seen_main = false;
        for _ in 0..max_blocks {
            if at == self.len {
                // RAR 5 always ends with an end-of-archive header.
                return Err(cut_short());
            }
            // The CRC and a size field of at most 3 bytes (UnRAR's limit, MAX_RAR5_HEADER).
            let lead = self.bytes_at(at, 7.min(self.len - at))?;
            let mut pos = 4;
            let size = vint_at(&lead, &mut pos).ok_or_else(cut_short)?;
            if size == 0 || size > MAX_RAR5_HEADER {
                return Err(unpack::damaged(format!("a {size}-byte RAR header")));
            }
            let sized = self.bytes_at(at + 4, pos as u64 - 4 + size)?;
            let crc = u32::from_le_bytes([lead[0], lead[1], lead[2], lead[3]]);
            if crc32(&sized) != crc {
                return Err(unpack::damaged("a RAR header's CRC doesn't match"));
            }
            let header = &sized[pos - 4..];
            let block = Rar5Block::parse(header).ok_or_else(|| unpack::damaged("unreadable RAR header"))?;
            if !seen_main && !matches!(block.kind, HEAD5_MAIN | HEAD5_CRYPT) {
                return Err(unpack::damaged("no main archive header"));
            }
            match block.kind {
                HEAD5_CRYPT => return Err(unpack::encrypted("encrypted headers")),
                HEAD5_MAIN => {
                    seen_main = true;
                    if block.flags & MHD5_VOLUME != 0 {
                        return Err(unpack::split("a volume of a multi-volume archive"));
                    }
                }
                HEAD5_FILE => items.push(block.item()?),
                HEAD5_ENDARC => {
                    if block.flags & EHD5_NEXT_VOLUME != 0 {
                        return Err(unpack::split("the archive goes on in another volume"));
                    }
                    return Ok(items);
                }
                // Service headers (comment, NTFS streams, ACLs, quick open, recovery) and headers
                // of later versions: not files. A decoder doesn't hand out their data either.
                _ => {}
            }
            if let HEAD5_FILE | HEAD5_SERVICE = block.kind {
                // Checked on service headers too: UnRAR allocates their dictionary as well.
                if let Some(bytes) = block.dictionary.filter(|&n| n > MAX_DICTIONARY_BYTES) {
                    return Err(unpack::method(format!("{}: needs a {bytes}-byte dictionary", block.name)));
                }
            }
            at = at
                .checked_add(4 + sized.len() as u64)
                .and_then(|end| end.checked_add(block.data_size))
                .filter(|&end| end <= self.len)
                .ok_or_else(cut_short)?;
        }
        Err(too_many_blocks(max_blocks))
    }

    /// RAR 1.5–4: `HEAD_CRC u16 · HEAD_TYPE u8 · HEAD_FLAGS u16 · HEAD_SIZE u16`, then the rest of
    /// the header and, for long blocks, `ADD_SIZE` bytes of data. The marker block is the
    /// signature itself.
    fn rar4(&mut self, max_blocks: usize) -> AppResult<Vec<RarItem>> {
        let mut items = Vec::new();
        let mut at = RAR4_SIGNATURE.len() as u64;
        let mut seen_main = false;
        for _ in 0..max_blocks {
            if at == self.len {
                // Archives from RAR 2.x may have no end-of-archive block.
                return if seen_main { Ok(items) } else { Err(cut_short()) };
            }
            let base = self.bytes_at(at, 7)?;
            let kind = base[2];
            let flags = u16::from_le_bytes([base[3], base[4]]);
            let size = u64::from(u16::from_le_bytes([base[5], base[6]]));
            if size < 7 {
                return Err(unpack::damaged(format!("a {size}-byte RAR header")));
            }
            let header = self.bytes_at(at, size)?;
            let long_block = flags & LONG_BLOCK != 0 || matches!(kind, HEAD4_FILE | HEAD4_NEWSUB);
            let mut data_size = if long_block { u64::from(le_u32(&header, 7).ok_or_else(cut_short)?) } else { 0 };
            if matches!(kind, HEAD4_MAIN | HEAD4_FILE | HEAD4_NEWSUB) {
                let crc = u16::from_le_bytes([header[0], header[1]]);
                if crc32(&header[2..]) as u16 != crc {
                    return Err(unpack::damaged("a RAR header's CRC doesn't match"));
                }
            }
            if !seen_main && kind != HEAD4_MAIN {
                return Err(unpack::damaged("no main archive header"));
            }
            match kind {
                HEAD4_MAIN => {
                    seen_main = true;
                    if flags & MHD4_PASSWORD != 0 {
                        return Err(unpack::encrypted("encrypted headers"));
                    }
                    if flags & MHD4_VOLUME != 0 {
                        return Err(unpack::split("a volume of a multi-volume archive"));
                    }
                }
                HEAD4_FILE => {
                    let file =
                        Rar4File::parse(&header, flags).ok_or_else(|| unpack::damaged("unreadable RAR header"))?;
                    data_size = file.packed_size;
                    items.push(file.item()?);
                }
                HEAD4_ENDARC => {
                    if flags & EARC4_NEXT_VOLUME != 0 {
                        return Err(unpack::split("the archive goes on in another volume"));
                    }
                    return Ok(items);
                }
                // Comments, authenticity, recovery, NTFS streams and other service blocks.
                _ => {}
            }
            at = at
                .checked_add(size)
                .and_then(|end| end.checked_add(data_size))
                .filter(|&end| end <= self.len)
                .ok_or_else(cut_short)?;
        }
        Err(too_many_blocks(max_blocks))
    }
}

/// UnRAR refuses RAR 5 headers longer than this (a 3-byte size field).
const MAX_RAR5_HEADER: u64 = 2 * 1024 * 1024;

/// RAR 5 header types.
const HEAD5_MAIN: u64 = 1;
const HEAD5_FILE: u64 = 2;
const HEAD5_SERVICE: u64 = 3;
const HEAD5_CRYPT: u64 = 4;
const HEAD5_ENDARC: u64 = 5;
/// RAR 5 header flags common to every type.
const HFL5_EXTRA: u64 = 0x0001;
const HFL5_DATA: u64 = 0x0002;
const HFL5_SPLIT_BEFORE: u64 = 0x0008;
const HFL5_SPLIT_AFTER: u64 = 0x0010;
/// Main archive header: this file is a volume.
const MHD5_VOLUME: u64 = 0x0001;
/// End of archive header: another volume follows.
const EHD5_NEXT_VOLUME: u64 = 0x0001;
/// File header flags.
const FHFL5_DIRECTORY: u64 = 0x0001;
const FHFL5_MTIME: u64 = 0x0002;
const FHFL5_CRC: u64 = 0x0004;
const FHFL5_UNKNOWN_SIZE: u64 = 0x0008;
/// File header host systems.
const HOST5_UNIX: u64 = 1;
/// File header extra record types.
const EXTRA5_CRYPT: u64 = 1;
const EXTRA5_REDIRECTION: u64 = 5;

/// What Livery needs from one RAR 5 header (the bytes after its size field).
struct Rar5Block {
    kind: u64,
    /// Type-specific flags for the main and end-of-archive headers, the common header flags
    /// otherwise.
    flags: u64,
    data_size: u64,
    /// File and service headers.
    name: String,
    file_flags: u64,
    unpacked_size: u64,
    attributes: u64,
    host_os: u64,
    /// File and service headers: the dictionary UnRAR allocates for them (`None` for folders
    /// and for versions UnRAR doesn't unpack).
    dictionary: Option<u64>,
    encrypted: bool,
    /// A redirection (link, hard link, file copy) record in the extra area.
    redirected: bool,
}

impl Rar5Block {
    /// `None` when the header is cut short or inconsistent.
    fn parse(header: &[u8]) -> Option<Self> {
        let mut at = 0;
        let kind = vint_at(header, &mut at)?;
        let flags = vint_at(header, &mut at)?;
        let extra_size = if flags & HFL5_EXTRA != 0 { vint_at(header, &mut at)? } else { 0 };
        let data_size = if flags & HFL5_DATA != 0 { vint_at(header, &mut at)? } else { 0 };
        let mut block = Self {
            kind,
            flags,
            data_size,
            name: String::new(),
            file_flags: 0,
            unpacked_size: 0,
            attributes: 0,
            host_os: 0,
            dictionary: None,
            encrypted: false,
            redirected: false,
        };
        match kind {
            HEAD5_MAIN | HEAD5_ENDARC => {
                block.flags = vint_at(header, &mut at)?;
                return Some(block);
            }
            HEAD5_FILE | HEAD5_SERVICE => {}
            _ => return Some(block),
        }
        block.file_flags = vint_at(header, &mut at)?;
        block.unpacked_size = vint_at(header, &mut at)?;
        block.attributes = vint_at(header, &mut at)?;
        if block.file_flags & FHFL5_MTIME != 0 {
            at += 4;
        }
        if block.file_flags & FHFL5_CRC != 0 {
            at += 4;
        }
        let compression = vint_at(header, &mut at)?;
        block.host_os = vint_at(header, &mut at)?;
        let name_len = usize::try_from(vint_at(header, &mut at)?).ok()?;
        let name = header.get(at..at.checked_add(name_len)?)?;
        block.name = String::from_utf8_lossy(name).into_owned();
        // As UnRAR computes it (arcread.cpp): folders and versions above RAR 7 have none.
        let version = compression & 0x3f;
        if block.file_flags & FHFL5_DIRECTORY == 0 && version <= 1 {
            let bits = (compression >> 10) & if version == 0 { 0x0f } else { 0x1f };
            let mut size = 0x20000u64 << bits;
            if version == 1 {
                size += size / 32 * ((compression >> 15) & 0x1f);
            }
            block.dictionary = Some(size);
        }
        // The extra area ends the header: records of `size` (counted from the type), `type`, data.
        let mut at = header.len().checked_sub(usize::try_from(extra_size).ok()?)?;
        while at < header.len() {
            let record_size = usize::try_from(vint_at(header, &mut at)?).ok()?;
            let record_end = at.checked_add(record_size).filter(|&end| end <= header.len())?;
            match vint_at(header, &mut at)? {
                EXTRA5_CRYPT => block.encrypted = true,
                EXTRA5_REDIRECTION => block.redirected = true,
                _ => {}
            }
            at = record_end;
        }
        Some(block)
    }

    /// A file header as an item, or why the archive is refused.
    fn item(&self) -> AppResult<RarItem> {
        if self.flags & (HFL5_SPLIT_BEFORE | HFL5_SPLIT_AFTER) != 0 {
            return Err(unpack::split(self.name.clone()));
        }
        if self.encrypted {
            return Err(unpack::encrypted(self.name.clone()));
        }
        let link = if self.host_os == HOST5_UNIX {
            unpack::is_link_mode(self.attributes as u32)
        } else {
            self.attributes & u64::from(REPARSE_POINT) != 0
        };
        if self.redirected || link {
            return Err(unpack::link_entry(&self.name));
        }
        let is_dir = self.file_flags & FHFL5_DIRECTORY != 0;
        if !is_dir && self.file_flags & FHFL5_UNKNOWN_SIZE != 0 {
            return Err(unpack::method(format!("{}: unknown size", self.name)));
        }
        Ok(RarItem { name: self.name.clone(), size: if is_dir { 0 } else { self.unpacked_size }, is_dir })
    }
}

/// RAR 4 block types.
const HEAD4_MAIN: u8 = 0x73;
const HEAD4_FILE: u8 = 0x74;
const HEAD4_NEWSUB: u8 = 0x7a;
const HEAD4_ENDARC: u8 = 0x7b;
/// RAR 4 flag: `ADD_SIZE` follows the header's base fields.
const LONG_BLOCK: u16 = 0x8000;
/// Main header flags.
const MHD4_VOLUME: u16 = 0x0001;
const MHD4_PASSWORD: u16 = 0x0080;
/// End of archive flag: another volume follows.
const EARC4_NEXT_VOLUME: u16 = 0x0001;
/// File header flags.
const LHD4_SPLIT_BEFORE: u16 = 0x0001;
const LHD4_SPLIT_AFTER: u16 = 0x0002;
const LHD4_PASSWORD: u16 = 0x0004;
const LHD4_WINDOW_MASK: u16 = 0x00e0;
const LHD4_DIRECTORY: u16 = 0x00e0;
const LHD4_LARGE: u16 = 0x0100;
const LHD4_UNICODE: u16 = 0x0200;
/// File header host systems.
const HOST4_UNIX: u8 = 3;
/// Windows' `FILE_ATTRIBUTE_DIRECTORY` (MS-DOS and Win32 hosts).
const ATTR_DIRECTORY: u32 = 0x10;

/// What Livery needs from one RAR 4 file header.
struct Rar4File {
    flags: u16,
    packed_size: u64,
    unpacked_size: u64,
    host_os: u8,
    attributes: u32,
    name: String,
}

impl Rar4File {
    /// `header` is the whole block header, from `HEAD_CRC`. `None` when it is cut short.
    fn parse(header: &[u8], flags: u16) -> Option<Self> {
        let mut packed_size = u64::from(le_u32(header, 7)?);
        let mut unpacked_size = u64::from(le_u32(header, 11)?);
        let host_os = *header.get(15)?;
        let name_size = usize::from(u16::from_le_bytes([*header.get(26)?, *header.get(27)?]));
        let attributes = le_u32(header, 28)?;
        let mut at: usize = 32;
        if flags & LHD4_LARGE != 0 {
            packed_size |= u64::from(le_u32(header, 32)?) << 32;
            unpacked_size |= u64::from(le_u32(header, 36)?) << 32;
            at = 40;
        }
        let raw = header.get(at..at.checked_add(name_size)?)?;
        let name =
            if flags & LHD4_UNICODE != 0 { unicode_name(raw) } else { String::from_utf8_lossy(raw).into_owned() };
        Some(Self { flags, packed_size, unpacked_size, host_os, attributes, name })
    }

    fn item(&self) -> AppResult<RarItem> {
        if self.flags & (LHD4_SPLIT_BEFORE | LHD4_SPLIT_AFTER) != 0 {
            return Err(unpack::split(self.name.clone()));
        }
        if self.flags & LHD4_PASSWORD != 0 {
            return Err(unpack::encrypted(self.name.clone()));
        }
        let (is_dir, link) = if self.host_os == HOST4_UNIX {
            (false, unpack::is_link_mode(self.attributes))
        } else {
            (self.attributes & ATTR_DIRECTORY != 0, self.attributes & REPARSE_POINT != 0)
        };
        if link {
            return Err(unpack::link_entry(&self.name));
        }
        let is_dir = is_dir || self.flags & LHD4_WINDOW_MASK == LHD4_DIRECTORY;
        if !is_dir && self.unpacked_size == u64::MAX {
            return Err(unpack::method(format!("{}: unknown size", self.name)));
        }
        Ok(RarItem { name: self.name.clone(), size: if is_dir { 0 } else { self.unpacked_size }, is_dir })
    }
}

/// A RAR 3–4 Unicode file name: UTF-8 when there is no zero byte, else an 8-bit name, a zero and
/// the UTF-16 name packed against it (UnRAR's `EncodeFileName::Decode`).
fn unicode_name(raw: &[u8]) -> String {
    let Some(zero) = raw.iter().position(|&b| b == 0) else { return String::from_utf8_lossy(raw).into_owned() };
    let (name, enc) = (&raw[..zero], &raw[zero + 1..]);
    let ascii = |i: usize| u16::from(name.get(i).copied().unwrap_or(0));
    let mut out: Vec<u16> = Vec::with_capacity(name.len());
    let mut pos = 0;
    let next = |pos: &mut usize| -> Option<u16> {
        let b = enc.get(*pos).copied()?;
        *pos += 1;
        Some(u16::from(b))
    };
    let Some(high) = next(&mut pos) else { return String::from_utf8_lossy(name).into_owned() };
    let (mut flags, mut flag_bits) = (0u16, 0u32);
    // Each decoded unit takes at least one encoded byte, so the name can't outgrow the input.
    let max = raw.len();
    while pos < enc.len() && out.len() < max {
        if flag_bits == 0 {
            let Some(f) = next(&mut pos) else { break };
            flags = f;
            flag_bits = 8;
        }
        match (flags >> 6) & 3 {
            0 => match next(&mut pos) {
                Some(b) => out.push(b),
                None => break,
            },
            1 => match next(&mut pos) {
                Some(b) => out.push(b | (high << 8)),
                None => break,
            },
            2 => match (next(&mut pos), next(&mut pos)) {
                (Some(lo), Some(hi)) => out.push(lo | (hi << 8)),
                _ => break,
            },
            _ => {
                let Some(length) = next(&mut pos) else { break };
                if length & 0x80 != 0 {
                    let Some(correction) = next(&mut pos) else { break };
                    for _ in 0..(length & 0x7f) + 2 {
                        if out.len() >= max {
                            break;
                        }
                        let i = out.len();
                        out.push(((ascii(i) + correction) & 0xff) | (high << 8));
                    }
                } else {
                    for _ in 0..length + 2 {
                        if out.len() >= max {
                            break;
                        }
                        out.push(ascii(out.len()));
                    }
                }
            }
        }
        flags = (flags << 2) & 0xff;
        flag_bits -= 2;
    }
    String::from_utf16_lossy(&out)
}

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// A RAR 5 variable-length integer at `*at` (7 bits per byte, low bits first; 10 bytes at most),
/// moving `at` past it.
fn vint_at(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes.get(*at)?;
        *at += 1;
        value |= u64::from(byte & 0x7f).checked_shl(shift).unwrap_or(0);
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

/// CRC-32 (IEEE), as RAR headers carry it.
fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
            }
            *slot = c;
        }
        table
    });
    !bytes.iter().fold(!0u32, |crc, &b| table[((crc ^ u32::from(b)) & 0xff) as usize] ^ (crc >> 8))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_reference_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn unicode_names_decode_as_unrar_does() {
        // No zero byte: the name is UTF-8.
        assert_eq!(unicode_name("Pz.IV/Tarn ä.dds".as_bytes()), "Pz.IV/Tarn ä.dds");
        // "ab", then: high byte 0x04, flags 0b11_01_00_00 → copy 2 from the 8-bit name, one unit
        // with the high byte (0x04_10 = 'А'), one plain byte ('c').
        let mut raw = b"ab".to_vec();
        raw.extend([0, 0x04, 0b1101_0000, 0x00, 0x10, b'c']);
        assert_eq!(unicode_name(&raw), "abАc");
        // A cut-short name stops where its data does.
        assert_eq!(unicode_name(&[b'a', 0, 0x04, 0b0100_0000]), "");
    }

    #[test]
    fn vints_read_seven_bits_per_byte() {
        let mut at = 0;
        assert_eq!(vint_at(&[0x81, 0x80, 0x01], &mut at), Some(0x4001));
        assert_eq!(at, 3);
        assert_eq!(vint_at(&[0x80], &mut 0), None);
    }
}
