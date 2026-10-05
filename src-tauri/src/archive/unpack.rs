//! What the ZIP, 7z and RAR readers share: entry names that can never leave the destination, the
//! caps that stop a hostile archive from filling the disk, and the staged writer that turns a
//! stream of entries into files under a folder, reporting the same progress a folder copy does.
//!
//! Nothing here trusts the archive. Entry names are rebuilt part by part (absolute paths, drive
//! letters, `..`, names Windows would rewrite and device names are refused), links are refused by
//! each reader, the declared sizes are capped *and* checked against what actually comes out of
//! the decoder, and the running total is capped again while writing.

use super::source::{join_rel, ExtractTick, SourceEntry, MAX_DEPTH, MAX_ENTRIES, SOURCE_GONE};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::layout::LIVERY_DIR;
use crate::library::scan::PARTIAL_MARKER;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

/// `invalidInput` message for an entry whose name isn't a safe relative path (absolute, a drive,
/// `..`, a Windows device name, characters Windows refuses or rewrites).
pub const UNSAFE_ENTRY: &str = "This archive holds a file path that isn't safe to unpack";

/// `invalidInput` message for a symbolic link or junction inside an archive.
pub const LINK_ENTRY: &str = "This archive holds a link instead of a file";

/// `unsupported` message for an archive that needs a password.
pub const ARCHIVE_ENCRYPTED: &str = "This archive is password-protected, so Livery can't unpack it";

/// `unsupported` message for one volume of a multi-volume (split) archive.
pub const ARCHIVE_SPLIT: &str = "This is one part of a split archive. Livery unpacks single-file archives only";

/// `unsupported` message for a compression method (or setting) the readers don't handle.
pub const ARCHIVE_METHOD: &str = "This archive uses a compression method Livery can't unpack";

/// `parse` message for an archive whose headers or data can't be read as the archive says.
pub const ARCHIVE_DAMAGED: &str = "This archive is damaged and can't be unpacked";

/// `parse` message for a `.zip` / `.rar` / `.7z` file that isn't any of the three.
pub const NOT_AN_ARCHIVE: &str = "This file isn't a ZIP, RAR or 7z archive";

/// `invalidInput` message for an archive that unpacks to more than the limits allow.
pub const ARCHIVE_TOO_BIG: &str = "This archive unpacks to too much data to be a skin";

/// `invalidInput` message for an archive holding more than [`MAX_ENTRIES`] files and folders.
pub const ARCHIVE_TOO_MANY_FILES: &str = "This archive holds too many files to be a skin";

/// Most an archive may unpack to, all files together. A skin is a few MB and the biggest packs are
/// a few hundred; this only stops an archive that lies about (or hides) its size from filling the
/// disk. Checked against the declared sizes first, then again on every chunk written.
pub const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Most one file inside an archive may unpack to: an uncompressed 8192² RGBA texture with mipmaps
/// is ~358 MB, so this leaves room. RAR files are read into memory one at a time, so this is also
/// the most memory one RAR file can take.
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// Largest LZMA / LZMA2 dictionary or PPMd model a 7z may ask for (the 7z reader allocates it up
/// front; 7-Zip's Ultra preset uses 64 MB).
pub const MAX_DICTIONARY_BYTES: u64 = 256 * 1024 * 1024;

/// Write buffer; progress is reported after each chunk and after each file (as the folder copy).
const CHUNK_BYTES: usize = 1 << 20;

/// The caps an archive is opened with. [`Limits::DEFAULT`] in the app; tests use small ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Files and folders together.
    pub max_entries: usize,
    /// All files together, declared and actually written.
    pub max_total_bytes: u64,
    /// One file, declared and actually written.
    pub max_file_bytes: u64,
}

impl Limits {
    pub const DEFAULT: Limits =
        Limits { max_entries: MAX_ENTRIES, max_total_bytes: MAX_TOTAL_BYTES, max_file_bytes: MAX_FILE_BYTES };
}

impl Default for Limits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

pub fn unsafe_entry(name: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, UNSAFE_ENTRY).with_detail(name.to_owned())
}

pub fn link_entry(name: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, LINK_ENTRY).with_detail(name.to_owned())
}

pub fn encrypted(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Unsupported, ARCHIVE_ENCRYPTED).with_detail(detail)
}

pub fn split(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Unsupported, ARCHIVE_SPLIT).with_detail(detail)
}

pub fn method(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Unsupported, ARCHIVE_METHOD).with_detail(detail)
}

pub fn damaged(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Parse, ARCHIVE_DAMAGED).with_detail(detail)
}

pub fn not_an_archive(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Parse, NOT_AN_ARCHIVE).with_detail(detail)
}

pub fn too_big(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, ARCHIVE_TOO_BIG).with_detail(detail)
}

fn too_many(limit: usize) -> AppError {
    AppError::new(ErrorCode::InvalidInput, ARCHIVE_TOO_MANY_FILES)
        .with_detail(format!("more than {limit} files and folders"))
}

/// Whether a Unix mode is a symbolic link (`S_IFLNK`).
pub fn is_link_mode(unix_mode: u32) -> bool {
    unix_mode & 0o170_000 == 0o120_000
}

/// Windows' `FILE_ATTRIBUTE_REPARSE_POINT` (symbolic links and junctions).
pub const REPARSE_POINT: u32 = 0x400;

/// The path an entry name becomes inside the source: relative, `/`-separated, each part checked.
/// `None` for an entry Livery never takes (Livery's own files, a name that is only separators).
///
/// Refused ([`UNSAFE_ENTRY`]): a leading `/` or `\` (absolute paths and UNC shares), a `..` part,
/// a part holding `:` (drive letters, alternate data streams), a control character or one of
/// `<>"|?*`, a part ending in `.` or space (Windows drops those, so `.. ` would become `..`), and
/// Windows device names (`CON`, `nul.txt`, `COM1`…). Both separators split: a `\` inside a name is
/// a folder separator, because Windows would read it so.
pub fn entry_path(raw: &str) -> AppResult<Option<String>> {
    let trimmed = raw.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with(['/', '\\']) {
        return Err(unsafe_entry(raw));
    }
    let mut parts = Vec::new();
    for part in trimmed.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".."
            || part.ends_with(['.', ' '])
            || part.contains(|c: char| c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
            || is_device_name(part)
        {
            return Err(unsafe_entry(raw));
        }
        // As the folder walk: Livery's own files are never part of a skin.
        if part.eq_ignore_ascii_case(LIVERY_DIR) || part.eq_ignore_ascii_case(PARTIAL_MARKER) {
            return Ok(None);
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Ok(None);
    }
    Ok(Some(parts.join("/")))
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (also ¹²³), with or without an
/// extension: Windows opens the device instead of a file.
fn is_device_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part).trim_end().to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
        return true;
    }
    let Some(digit) = stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT")) else { return false };
    let mut chars = digit.chars();
    matches!((chars.next(), chars.next()), (Some('1'..='9' | '¹' | '²' | '³'), None))
}

/// Number of `/`-separated parts.
fn depth(path: &str) -> usize {
    path.split('/').count()
}

/// Builds the entry list of an archive from its headers, applying the caps as it goes. Folders
/// the archive doesn't list are added from the file paths, so the list reads like a folder's.
///
/// Names are compared case-insensitively, as Windows does: the first spelling of a folder is kept
/// for everything under it, and a file repeated (in any case) keeps its first entry; the later
/// ones are left out ([`Listing::file`] answers `None`).
#[derive(Debug)]
pub struct Listing {
    limits: Limits,
    /// Lower-cased path → (path as listed, declared size).
    files: BTreeMap<String, (String, u64)>,
    /// Lower-cased path → path as listed.
    dirs: BTreeMap<String, String>,
    declared_bytes: u64,
    /// Entries seen, kept or not (Livery's own files, repeats): capped too, so an archive of
    /// millions of skipped entries is refused rather than walked.
    seen: usize,
}

impl Listing {
    pub fn new(limits: Limits) -> Self {
        Self { limits, files: BTreeMap::new(), dirs: BTreeMap::new(), declared_bytes: 0, seen: 0 }
    }

    /// A folder entry (archives may or may not list them). Folders deeper than the folder walk
    /// follows are left out.
    pub fn dir(&mut self, raw: &str) -> AppResult<()> {
        self.see()?;
        let Some(path) = entry_path(raw)? else { return Ok(()) };
        if depth(&path) > MAX_DEPTH {
            return Ok(());
        }
        let path = self.canonical(&path);
        self.add_dirs(&path, true)?;
        self.check_count()
    }

    /// A file entry with the size the archive declares. Returns the path it takes in the listing,
    /// or `None` when it is left out (Livery's own files, deeper than the folder walk follows, a
    /// repeat). The caller maps the archive's raw name to this path to find the file again.
    pub fn file(&mut self, raw: &str, size: u64) -> AppResult<Option<String>> {
        self.see()?;
        let Some(path) = entry_path(raw)? else { return Ok(None) };
        // The folder walk follows MAX_DEPTH levels of folders, so a file sits at most one deeper.
        if depth(&path) > MAX_DEPTH + 1 {
            return Ok(None);
        }
        let path = self.canonical(&path);
        let key = path.to_lowercase();
        if self.files.contains_key(&key) {
            return Ok(None);
        }
        if self.dirs.contains_key(&key) {
            return Err(damaged(format!("{raw}: both a file and a folder")));
        }
        if size > self.limits.max_file_bytes {
            return Err(too_big(format!("{raw}: {size} bytes")));
        }
        self.declared_bytes = self.declared_bytes.saturating_add(size);
        if self.declared_bytes > self.limits.max_total_bytes {
            return Err(too_big(format!("more than {} bytes", self.limits.max_total_bytes)));
        }
        self.add_dirs(&path, false)?;
        self.files.insert(key, (path.clone(), size));
        self.check_count()?;
        Ok(Some(path))
    }

    /// `path` with each folder above it spelled as first listed.
    fn canonical(&self, path: &str) -> String {
        let mut out = String::with_capacity(path.len());
        for (i, part) in path.split('/').enumerate() {
            if i > 0 {
                out.push('/');
            }
            out.push_str(part);
            if let Some(spelled) = self.dirs.get(&out.to_lowercase()) {
                out.replace_range(.., spelled);
            }
        }
        out
    }

    /// Records every folder above `path` (and `path` itself when `inclusive`).
    fn add_dirs(&mut self, path: &str, inclusive: bool) -> AppResult<()> {
        let mut at = 0;
        loop {
            let end = path[at..].find('/').map(|i| at + i);
            let prefix = match end {
                Some(end) => &path[..end],
                None if inclusive => path,
                None => break,
            };
            let key = prefix.to_lowercase();
            if self.files.contains_key(&key) {
                return Err(damaged(format!("{prefix}: both a file and a folder")));
            }
            self.dirs.entry(key).or_insert_with(|| prefix.to_owned());
            match end {
                Some(end) => at = end + 1,
                None => break,
            }
        }
        Ok(())
    }

    fn see(&mut self) -> AppResult<()> {
        self.seen += 1;
        if self.seen > self.limits.max_entries.saturating_mul(4) {
            return Err(too_many(self.limits.max_entries));
        }
        Ok(())
    }

    fn check_count(&self) -> AppResult<()> {
        if self.files.len() + self.dirs.len() > self.limits.max_entries {
            return Err(too_many(self.limits.max_entries));
        }
        Ok(())
    }

    /// The entries, parents before their children, sorted as the folder walk sorts them (by name,
    /// case-insensitively, within each folder).
    pub fn finish(self) -> Vec<SourceEntry> {
        let mut out: Vec<SourceEntry> = Vec::with_capacity(self.files.len() + self.dirs.len());
        out.extend(self.dirs.into_values().map(|path| SourceEntry { path, size_bytes: 0, is_dir: true }));
        out.extend(self.files.into_values().map(|(path, size_bytes)| SourceEntry { path, size_bytes, is_dir: false }));
        out.sort_by(|a, b| sort_key(&a.path).cmp(&sort_key(&b.path)).then_with(|| a.path.cmp(&b.path)));
        out
    }
}

/// Folder-walk order: part by part, case-insensitively.
fn sort_key(path: &str) -> Vec<String> {
    path.split('/').map(str::to_lowercase).collect()
}

/// Writes the files of one skin root into a destination folder while an archive is being read.
///
/// The caller opens it with the source's entry list, then hands it every file the archive gives,
/// in whatever order it gives them, by its listed path: [`Staged::wanted`] says whether the file
/// belongs to the root and [`Staged::write`] stores it. Folders are created up front, so files can
/// arrive in any order. [`Staged::finish`] checks every file the list promised was written.
pub struct Staged<'a> {
    dest: &'a Path,
    limits: Limits,
    /// `""` for the whole source, else `root/`.
    prefix: String,
    /// Files under the root that haven't been written yet (path relative to the root → declared
    /// size).
    pending: HashMap<String, u64>,
    tick: ExtractTick,
    progress: &'a mut dyn FnMut(ExtractTick) -> AppResult<()>,
}

impl<'a> Staged<'a> {
    /// Prepares `dest` for the files of `root` (`""` = the whole source): creates every folder and
    /// sends the first tick with the totals. `notFound` when `root` isn't a folder in `entries`.
    pub fn new(
        entries: &[SourceEntry],
        root: &str,
        dest: &'a Path,
        limits: Limits,
        progress: &'a mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<Self> {
        if !root.is_empty() && !entries.iter().any(|e| e.is_dir && e.path == root) {
            return Err(AppError::new(ErrorCode::NotFound, SOURCE_GONE).with_detail(root.to_owned()));
        }
        let prefix = if root.is_empty() { String::new() } else { format!("{root}/") };
        let under = |path: &'_ str| path.strip_prefix(prefix.as_str()).filter(|rel| !rel.is_empty()).map(str::to_owned);
        let pending: HashMap<String, u64> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .filter_map(|e| under(&e.path).map(|rel| (rel, e.size_bytes)))
            .collect();
        let tick = ExtractTick {
            files_total: pending.len() as u64,
            bytes_total: pending.values().sum(),
            ..ExtractTick::default()
        };
        for entry in entries.iter().filter(|e| e.is_dir) {
            let Some(rel) = under(&entry.path) else { continue };
            let dir = join_rel(dest, &rel)?;
            fs::create_dir_all(&dir).map_err(|e| write_error(&rel, &e))?;
        }
        let staged = Self { dest, limits, prefix, pending, tick, progress };
        (staged.progress)(staged.tick)?;
        Ok(staged)
    }

    /// The path the file listed as `path` takes inside the destination, when it belongs to this
    /// root and is still waiting to be written (a file the archive repeats is written once).
    pub fn wanted(&self, path: &str) -> Option<String> {
        let rel = path.strip_prefix(self.prefix.as_str())?;
        self.pending.contains_key(rel).then(|| rel.to_owned())
    }

    /// Writes one file of the root, in chunks, reporting progress. It must be exactly as long as
    /// the archive declared: shorter or longer and the archive is refused (a declared size is
    /// never trusted on its own). Files that aren't part of this root are skipped; the return
    /// says whether anything was written.
    pub fn write(&mut self, path: &str, reader: &mut dyn Read) -> AppResult<bool> {
        let Some(rel) = self.wanted(path) else { return Ok(false) };
        let declared = self.pending.remove(&rel).unwrap_or(0);
        let target = join_rel(self.dest, &rel)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| write_error(&rel, &e))?;
        }
        let mut file = fs::File::create(&target).map_err(|e| write_error(&rel, &e))?;
        let mut buf = vec![0u8; CHUNK_BYTES];
        let mut written = 0u64;
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(read_error(&rel, e)),
            };
            written += n as u64;
            if written > declared {
                return Err(damaged(format!("{rel}: longer than the {declared} bytes it declares")));
            }
            if written > self.limits.max_file_bytes || self.tick.bytes_done + n as u64 > self.limits.max_total_bytes {
                return Err(too_big(format!("{rel}: more than the limit")));
            }
            file.write_all(&buf[..n]).map_err(|e| write_error(&rel, &e))?;
            self.tick.bytes_done += n as u64;
            (self.progress)(self.tick)?;
        }
        file.flush().map_err(|e| write_error(&rel, &e))?;
        if written != declared {
            return Err(damaged(format!("{rel}: {written} bytes, not the {declared} it declares")));
        }
        self.tick.files_done += 1;
        (self.progress)(self.tick)?;
        Ok(true)
    }

    /// Whether every file of the root has been written (readers stop early then).
    pub fn done(&self) -> bool {
        self.pending.is_empty()
    }

    /// The totals, once every file of the root has been written ([`ARCHIVE_DAMAGED`] otherwise:
    /// the archive promised files its data doesn't hold).
    pub fn finish(self) -> AppResult<ExtractTick> {
        if let Some(missing) = self.pending.keys().min() {
            return Err(damaged(format!("{missing}: not in the archive's data")));
        }
        Ok(self.tick)
    }
}

fn write_error(rel: &str, e: &io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not copy the skin files").with_detail(format!("{rel}: {e}"))
}

/// A decoder failure while reading an entry (bad data, a CRC that doesn't match).
fn read_error(rel: &str, e: io::Error) -> AppError {
    damaged(format!("{rel}: {e}"))
}

/// Reads the first `limit` bytes of `reader` (all of it when shorter).
pub fn read_limited(reader: &mut dyn Read, limit: u64) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit).read_to_end(&mut bytes).map_err(|e| damaged(e.to_string()))?;
    Ok(bytes)
}

/// What a reader collects for [`super::SkinSource::read_many`]: the wanted listed paths with
/// their byte limits, and what was read so far.
pub struct Wanted {
    limits: HashMap<String, u64>,
    pub found: HashMap<String, Vec<u8>>,
}

impl Wanted {
    pub fn new(paths: &[(String, u64)]) -> Self {
        Self { limits: paths.iter().cloned().collect(), found: HashMap::new() }
    }

    /// The byte limit for `path` when it is wanted and not read yet.
    pub fn limit(&self, path: &str) -> Option<u64> {
        self.limits.get(path).copied().filter(|_| !self.found.contains_key(path))
    }

    pub fn done(&self) -> bool {
        self.found.len() == self.limits.len()
    }
}
