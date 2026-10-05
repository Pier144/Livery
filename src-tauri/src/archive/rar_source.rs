//! RAR archives (the `unrar` crate, which bundles RarLab's UnRAR library; RAR 2.9–7).
//!
//! The archive is listed once when it opens and every entry is checked then (see
//! [`super::unpack`]): one volume of a split archive (first or later), encrypted headers or files,
//! a link, or a name that isn't a safe relative path refuses the whole archive. Data is decoded in
//! one forward pass per call, in UnRAR's *test* mode, which hands each file's bytes to Livery
//! instead of writing anything itself: Livery writes every file, so UnRAR never creates a path or
//! a link on disk. Each file is held in memory while it is written (at most
//! [`super::unpack::MAX_FILE_BYTES`]), and only one RAR is decoded at a time.
//!
//! Before UnRAR decodes anything, Livery walks the RAR 5 block headers itself ([`scan_headers`]):
//! a dictionary above [`super::unpack::MAX_DICTIONARY_BYTES`] is refused (UnRAR would allocate it
//! up front, and above 4 GiB it answers a code the `unrar` crate `unwrap()`s, which aborts the
//! app), and so is a link, hard link or file copy record.

use super::source::{ExtractTick, SkinSource, SourceEntry, SOURCE_GONE};
use super::unpack::{self, Limits, Listing, Staged, Wanted, MAX_DICTIONARY_BYTES, REPARSE_POINT};
use crate::error::{AppError, AppResult, ErrorCode};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use unrar::error::{Code, UnrarError, When};
use unrar::{Archive, VolumeInfo};

/// A `.rar` file holding one or more skins.
pub struct RarSource {
    path: PathBuf,
    entries: Vec<SourceEntry>,
    /// Name as the archive spells it → listed file path (first entry of that name only).
    listed: HashMap<String, String>,
    limits: Limits,
}

impl RarSource {
    /// Opens and checks the archive at `path` (see the module docs).
    pub fn open(path: &Path, limits: Limits) -> AppResult<Self> {
        let archive = Archive::new(path).open_for_listing().map_err(rar_error)?;
        if archive.volume_info() != VolumeInfo::None {
            return Err(unpack::split(format!("{:?} volume", archive.volume_info())));
        }
        if archive.has_encrypted_headers() {
            return Err(unpack::encrypted("encrypted headers"));
        }
        let mut listing = Listing::new(limits);
        let mut listed = HashMap::new();
        for header in archive {
            let header = header.map_err(rar_error)?;
            let name = header.filename.to_string_lossy().into_owned();
            if header.is_split() {
                return Err(unpack::split(name));
            }
            if header.is_encrypted() {
                return Err(unpack::encrypted(name));
            }
            if header.file_attr & REPARSE_POINT != 0 || unpack::is_link_mode(header.file_attr) {
                return Err(unpack::link_entry(&name));
            }
            if header.is_directory() {
                listing.dir(&name)?;
                continue;
            }
            if let Some(listed_path) = listing.file(&name, header.unpacked_size)? {
                listed.entry(name).or_insert(listed_path);
            }
        }
        scan_headers(path, limits)?;
        Ok(Self { path: path.to_path_buf(), entries: listing.finish(), listed, limits })
    }

    /// Decodes the archive from the start, handing `each` every listed file with its bytes.
    /// `each` returns whether to go on. Files `want` turns down are skipped, not decoded (in a
    /// solid archive UnRAR still decodes what it must to reach the next one).
    fn for_each_file(
        &self,
        want: &dyn Fn(&str) -> bool,
        each: &mut dyn FnMut(&str, &[u8]) -> AppResult<bool>,
    ) -> AppResult<()> {
        // UnRAR hands each file over as one buffer (up to MAX_FILE_BYTES) next to its dictionary:
        // one RAR at a time keeps that from multiplying with parallel installs and analyses.
        static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let mut archive = Archive::new(&self.path).open_for_processing().map_err(rar_error)?;
        loop {
            let Some(cursor) = archive.read_header().map_err(rar_error)? else { return Ok(()) };
            let name = cursor.entry().filename.to_string_lossy().into_owned();
            let path = (!cursor.entry().is_directory()).then(|| self.listed.get(&name)).flatten();
            match path.filter(|p| want(p)) {
                Some(path) => {
                    let (bytes, next) = cursor.read().map_err(rar_error)?;
                    if !each(path, &bytes)? {
                        return Ok(());
                    }
                    archive = next;
                }
                None => archive = cursor.skip().map_err(rar_error)?,
            }
        }
    }
}

impl SkinSource for RarSource {
    fn entries(&self) -> AppResult<Vec<SourceEntry>> {
        Ok(self.entries.clone())
    }

    fn read(&self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        let mut found = self.read_many(&[(path.to_owned(), limit)])?;
        found.remove(path).ok_or_else(|| AppError::new(ErrorCode::NotFound, SOURCE_GONE).with_detail(path.to_owned()))
    }

    fn read_many(&self, paths: &[(String, u64)]) -> AppResult<HashMap<String, Vec<u8>>> {
        let wanted = std::cell::RefCell::new(Wanted::new(paths));
        if paths.is_empty() {
            return Ok(wanted.into_inner().found);
        }
        self.for_each_file(&|path| wanted.borrow().limit(path).is_some(), &mut |path, bytes| {
            let mut wanted = wanted.borrow_mut();
            if let Some(limit) = wanted.limit(path) {
                let end = usize::try_from(limit).unwrap_or(usize::MAX).min(bytes.len());
                wanted.found.insert(path.to_owned(), bytes[..end].to_vec());
            }
            Ok(!wanted.done())
        })?;
        Ok(wanted.into_inner().found)
    }

    fn extract(
        &self,
        root: &str,
        dest: &Path,
        progress: &mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<ExtractTick> {
        let staged = std::cell::RefCell::new(Staged::new(&self.entries, root, dest, self.limits, progress)?);
        if !staged.borrow().done() {
            self.for_each_file(&|path| staged.borrow().wanted(path).is_some(), &mut |path, mut bytes| {
                let mut staged = staged.borrow_mut();
                staged.write(path, &mut bytes)?;
                Ok(!staged.done())
            })?;
        }
        staged.into_inner().finish()
    }
}

/// RAR 1.5–4 signature (its dictionaries are 4 MB at most).
const RAR4_SIGNATURE: &[u8] = b"Rar!\x1A\x07\x00";
/// RAR 5 (and 7) signature.
const RAR5_SIGNATURE: &[u8] = b"Rar!\x1A\x07\x01\x00";
/// RAR 5 header types.
const HEAD_FILE: u64 = 2;
const HEAD_SERVICE: u64 = 3;
const HEAD_CRYPT: u64 = 4;
const HEAD_ENDARC: u64 = 5;
/// RAR 5 file header extra record holding a link, a hard link or a file copy.
const EXTRA_REDIRECTION: u64 = 5;
/// UnRAR refuses headers longer than this (a 3-byte size field).
const MAX_HEADER_BYTES: u64 = 2 * 1024 * 1024;

/// Checks what UnRAR would only find out while decoding: walks the RAR 5 block headers (the chain
/// UnRAR follows: header size, then the data area) and refuses a file or service header whose
/// dictionary is above [`MAX_DICTIONARY_BYTES`] ([`unpack::ARCHIVE_METHOD`]), or a file header
/// with a redirection record (a link, hard link or file copy: [`unpack::LINK_ENTRY`]). RAR 4
/// archives have nothing to check (4 MB dictionaries at most); a file that doesn't start with a
/// RAR signature (a renamed self-extracting `.exe`, RAR 1.4) is [`unpack::NOT_AN_ARCHIVE`]. The
/// walk stops at encrypted headers (refused before this) and at the end of the archive.
pub fn scan_headers(path: &Path, limits: Limits) -> AppResult<()> {
    let damaged = |e: io::Error| unpack::damaged(e.to_string());
    let file = File::open(path).map_err(damaged)?;
    let len = file.metadata().map_err(damaged)?.len();
    let mut reader = BufReader::new(file);
    let mut signature = Vec::with_capacity(RAR5_SIGNATURE.len());
    (&mut reader).take(RAR5_SIGNATURE.len() as u64).read_to_end(&mut signature).map_err(damaged)?;
    if signature.starts_with(RAR4_SIGNATURE) {
        return Ok(());
    }
    if signature != RAR5_SIGNATURE {
        return Err(unpack::not_an_archive("no RAR signature at the start"));
    }
    let max_blocks = limits.max_entries.saturating_mul(8).max(64);
    let mut at = RAR5_SIGNATURE.len() as u64;
    let mut header = Vec::new();
    for _ in 0..max_blocks {
        // A truncated archive ends the walk: UnRAR reports it when it gets there.
        if at >= len {
            return Ok(());
        }
        reader.seek(SeekFrom::Start(at)).map_err(damaged)?;
        let mut crc = [0u8; 4];
        if reader.read_exact(&mut crc).is_err() {
            return Ok(());
        }
        let Ok((size, size_len)) = read_vint(&mut reader) else { return Ok(()) };
        if size == 0 || size > MAX_HEADER_BYTES {
            return Err(unpack::damaged(format!("a {size}-byte RAR header")));
        }
        header.clear();
        (&mut reader).take(size).read_to_end(&mut header).map_err(damaged)?;
        if header.len() as u64 != size {
            return Ok(());
        }
        let block = Rar5Block::parse(&header).ok_or_else(|| unpack::damaged("unreadable RAR header"))?;
        if block.kind == HEAD_CRYPT || block.kind == HEAD_ENDARC {
            return Ok(());
        }
        if let Some(bytes) = block.dictionary.filter(|&n| n > MAX_DICTIONARY_BYTES) {
            return Err(unpack::method(format!("{}: needs a {bytes}-byte dictionary", block.name)));
        }
        if block.kind == HEAD_FILE && block.redirected {
            return Err(unpack::link_entry(&block.name));
        }
        at = at.saturating_add(4 + size_len + size).saturating_add(block.data_size);
    }
    Err(AppError::new(ErrorCode::InvalidInput, unpack::ARCHIVE_TOO_MANY_FILES)
        .with_detail(format!("more than {max_blocks} RAR blocks")))
}

/// What [`scan_headers`] needs from one RAR 5 block header (the bytes after its size field).
struct Rar5Block {
    kind: u64,
    data_size: u64,
    /// File and service headers: the dictionary UnRAR allocates for them (`None` for folders
    /// and for versions UnRAR doesn't unpack).
    dictionary: Option<u64>,
    /// A redirection (link, hard link, file copy) record in the extra area.
    redirected: bool,
    name: String,
}

impl Rar5Block {
    /// `None` when the header is cut short or inconsistent.
    fn parse(header: &[u8]) -> Option<Self> {
        let mut at = 0;
        let kind = vint_at(header, &mut at)?;
        let flags = vint_at(header, &mut at)?;
        let extra_size = if flags & 0x1 != 0 { vint_at(header, &mut at)? } else { 0 };
        let data_size = if flags & 0x2 != 0 { vint_at(header, &mut at)? } else { 0 };
        let mut block = Self { kind, data_size, dictionary: None, redirected: false, name: String::new() };
        if kind != HEAD_FILE && kind != HEAD_SERVICE {
            return Some(block);
        }
        let file_flags = vint_at(header, &mut at)?;
        let _unpacked_size = vint_at(header, &mut at)?;
        let _attributes = vint_at(header, &mut at)?;
        if file_flags & 0x2 != 0 {
            at += 4; // modification time
        }
        if file_flags & 0x4 != 0 {
            at += 4; // data CRC32
        }
        let compression = vint_at(header, &mut at)?;
        let _host_os = vint_at(header, &mut at)?;
        let name_len = usize::try_from(vint_at(header, &mut at)?).ok()?;
        let name = header.get(at..at.checked_add(name_len)?)?;
        block.name = String::from_utf8_lossy(name).into_owned();
        // As UnRAR computes it (arcread.cpp): folders and versions above RAR 7 have none.
        let version = compression & 0x3f;
        if file_flags & 0x1 == 0 && version <= 1 {
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
            if vint_at(header, &mut at)? == EXTRA_REDIRECTION {
                block.redirected = true;
            }
            at = record_end;
        }
        Some(block)
    }
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

/// A RAR 5 variable-length integer read from `reader`, with the number of bytes it took.
fn read_vint(reader: &mut impl Read) -> io::Result<(u64, u64)> {
    let mut value = 0u64;
    for (i, shift) in (0..70).step_by(7).enumerate() {
        let mut byte = [0u8];
        reader.read_exact(&mut byte)?;
        value |= u64::from(byte[0] & 0x7f).checked_shl(shift).unwrap_or(0);
        if byte[0] & 0x80 == 0 {
            return Ok((value, i as u64 + 1));
        }
    }
    Err(io::Error::new(io::ErrorKind::InvalidData, "RAR number too long"))
}

/// UnRAR's errors in Livery's words.
fn rar_error(e: UnrarError) -> AppError {
    let detail = format!("{e} ({:?})", e.when);
    match (e.code, e.when) {
        (Code::MissingPassword | Code::BadPassword, _) => unpack::encrypted(detail),
        // UnRAR reports a missing next volume when it tries to open it.
        (Code::EOpen, When::Process) => unpack::split(detail),
        (Code::EOpen, _) => AppError::new(ErrorCode::Io, "Could not open the file or folder").with_detail(detail),
        (Code::BadArchive, _) => unpack::not_an_archive(detail),
        (Code::UnknownFormat, _) => unpack::method(detail),
        (Code::NoMemory, _) => unpack::too_big(detail),
        _ => unpack::damaged(detail),
    }
}
