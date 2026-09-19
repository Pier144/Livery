//! What the ZIP, 7z and RAR readers share: entry names that can never leave the destination, the
//! caps that stop a hostile archive from filling the disk, and the staged writer that turns a
//! stream of entries into files under a folder, reporting the same progress a folder copy does.
//!
//! Nothing here trusts the archive. Entry names are rebuilt part by part (absolute paths, drive
//! letters, `..` and control characters are refused), links are refused, the declared sizes are
//! capped *and* checked against what actually comes out of the decoder, and the running total is
//! capped again while writing.

use super::source::{join_rel, ExtractTick, SourceEntry, MAX_DEPTH, MAX_ENTRIES};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::layout::LIVERY_DIR;
use crate::library::scan::PARTIAL_MARKER;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

/// `unsupported` message for an entry whose name could step outside the destination.
pub const UNSAFE_ENTRY: &str = "This archive would write outside the skin folder";

/// `unsupported` message for a symbolic link, junction or hard link inside an archive.
pub const LINK_ENTRY: &str = "This archive holds a link instead of a file";

/// `unsupported` message for an archive that needs a password.
pub const ENCRYPTED_ARCHIVE: &str = "This archive is password-protected, so Livery can't unpack it";

/// `unsupported` message for an archive whose files don't come out as the archive says they will.
pub const ARCHIVE_DAMAGED: &str = "This archive is damaged and can't be unpacked";

/// `invalidInput` message for an archive that unpacks to more than [`MAX_TOTAL_BYTES`].
pub const ARCHIVE_TOO_BIG: &str = "This archive unpacks to too much data to be a skin";

/// `invalidInput` message for an archive holding more than [`MAX_ENTRIES`] files and folders.
pub const ARCHIVE_TOO_MANY_FILES: &str = "This archive holds too many files to be a skin";

/// Most an archive may unpack to, all files together. A skin is a few MB and the biggest packs are
/// tens of MB; this only stops an archive that lies about (or hides) its size from filling the
/// disk. Checked against the declared sizes first, then again on every chunk written.
pub const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Most one file inside an archive may unpack to (a 4096² texture with mipmaps is ~22 MB).
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// Write buffer; progress is reported after each chunk and after each file (as the folder copy).
const CHUNK_BYTES: usize = 1 << 20;

pub fn unsafe_entry(name: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, UNSAFE_ENTRY).with_detail(name.to_owned())
}

pub fn link_entry(name: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, LINK_ENTRY).with_detail(name.to_owned())
}

pub fn encrypted(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Unsupported, ENCRYPTED_ARCHIVE).with_detail(detail)
}

pub fn damaged(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Unsupported, ARCHIVE_DAMAGED).with_detail(detail)
}

fn too_big(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, ARCHIVE_TOO_BIG).with_detail(detail)
}

fn too_many() -> AppError {
    AppError::new(ErrorCode::InvalidInput, ARCHIVE_TOO_MANY_FILES)
        .with_detail(format!("more than {MAX_ENTRIES} files and folders"))
}

/// The path an entry name becomes inside the source: relative, `/`-separated, each part checked.
/// `None` for an entry Livery never takes (Livery's own files, an entry deeper than the folder
/// walk follows, a name that is only separators).
///
/// Refused (`unsupported`): a leading `/` or `\` (absolute paths and UNC shares), a `..` part, a
/// part holding `:` (drive letters, alternate data streams) or a control character. Both
/// separators split: a `\` inside a name is treated as a folder separator, because Windows would,
/// and every part is checked either way.
pub fn entry_path(raw: &str) -> AppResult<Option<String>> {
    let trimmed = raw.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err(unsafe_entry(raw));
    }
    let mut parts = Vec::new();
    for part in trimmed.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') || part.contains(char::is_control) {
            return Err(unsafe_entry(raw));
        }
        // As the folder walk: Livery's own files are never part of a skin.
        if part.eq_ignore_ascii_case(LIVERY_DIR) || part.eq_ignore_ascii_case(PARTIAL_MARKER) {
            return Ok(None);
        }
        parts.push(part);
    }
    // The folder walk follows MAX_DEPTH levels of folders, so a file sits at most one part deeper.
    if parts.is_empty() || parts.len() > MAX_DEPTH + 1 {
        return Ok(None);
    }
    Ok(Some(parts.join("/")))
}

/// Every folder above `path` (`a/b/c.dds` → `a`, `a/b`).
fn ancestors(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(next) = path[at..].find('/') {
        at += next;
        out.push(path[..at].to_owned());
        at += 1;
    }
    out
}

/// Builds the entry list of an archive from its headers, applying the caps as it goes. Folders
/// the archive doesn't list are added from the file paths, so the list reads like a folder's.
#[derive(Debug, Default)]
pub struct Listing {
    files: BTreeMap<String, u64>,
    dirs: BTreeSet<String>,
    declared_bytes: u64,
}

impl Listing {
    /// A folder entry (archives may or may not list them).
    pub fn dir(&mut self, raw: &str) -> AppResult<()> {
        if let Some(path) = entry_path(raw)? {
            self.dirs.insert(path);
        }
        self.check_count()
    }

    /// A file entry with the size the archive declares.
    pub fn file(&mut self, raw: &str, size: u64) -> AppResult<()> {
        let Some(path) = entry_path(raw)? else { return Ok(()) };
        if size > MAX_FILE_BYTES {
            return Err(too_big(format!("{raw}: {size} bytes")));
        }
        self.declared_bytes = self.declared_bytes.saturating_add(size);
        if self.declared_bytes > MAX_TOTAL_BYTES {
            return Err(too_big(format!("more than {MAX_TOTAL_BYTES} bytes")));
        }
        for parent in ancestors(&path) {
            self.dirs.insert(parent);
        }
        self.files.insert(path, size);
        self.check_count()
    }

    fn check_count(&self) -> AppResult<()> {
        if self.files.len() + self.dirs.len() > MAX_ENTRIES {
            return Err(too_many());
        }
        Ok(())
    }

    /// The entries, parents before their children (a parent path is a prefix of its children's,
    /// so plain path order is enough), case-insensitive.
    pub fn finish(self) -> AppResult<Vec<SourceEntry>> {
        let mut out: Vec<SourceEntry> = Vec::with_capacity(self.files.len() + self.dirs.len());
        for path in &self.dirs {
            if self.files.contains_key(path) {
                return Err(damaged(format!("{path}: both a file and a folder")));
            }
            out.push(SourceEntry { path: path.clone(), size_bytes: 0, is_dir: true });
        }
        for (path, size_bytes) in self.files {
            out.push(SourceEntry { path, size_bytes, is_dir: false });
        }
        out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()).then_with(|| a.path.cmp(&b.path)));
        Ok(out)
    }
}

/// Writes the files of one skin root into a destination folder while an archive is being read.
///
/// The caller opens it with the source's entry list, then hands it every entry the archive gives,
/// in whatever order it gives them: [`Staged::wanted`] says whether the entry belongs to the root
/// and [`Staged::write`] stores it. Folders are created up front, so entries can arrive in any
/// order. [`Staged::finish`] checks every file the list promised was written.
pub struct Staged<'a> {
    dest: &'a Path,
    /// `""` for the whole source, else `root/`.
    prefix: String,
    /// Files under the root that haven't been written yet, with their declared sizes.
    pending: BTreeMap<String, u64>,
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
        progress: &'a mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<Self> {
        if !root.is_empty() && !entries.iter().any(|e| e.is_dir && e.path == root) {
            return Err(AppError::new(ErrorCode::NotFound, super::source::SOURCE_GONE).with_detail(root.to_owned()));
        }
        let prefix = if root.is_empty() { String::new() } else { format!("{root}/") };
        let under = |path: &str| path.strip_prefix(prefix.as_str()).filter(|rel| !rel.is_empty());
        let pending: BTreeMap<String, u64> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .filter_map(|e| under(&e.path).map(|rel| (rel.to_owned(), e.size_bytes)))
            .collect();
        let tick = ExtractTick {
            files_total: pending.len() as u64,
            bytes_total: pending.values().sum(),
            ..ExtractTick::default()
        };
        for entry in entries.iter().filter(|e| e.is_dir) {
            let Some(rel) = under(&entry.path) else { continue };
            let dir = join_rel(dest, rel)?;
            fs::create_dir_all(&dir).map_err(|e| write_error(rel, &e))?;
        }
        let mut staged = Self { dest, prefix, pending, tick, progress };
        (staged.progress)(staged.tick)?;
        Ok(staged)
    }

    /// The path `entry` takes inside the destination, when it is a file of this root that is still
    /// waiting to be written (an entry the archive repeats is written once).
    pub fn wanted(&self, entry: &str) -> Option<String> {
        let rel = entry.strip_prefix(self.prefix.as_str())?;
        self.pending.contains_key(rel).then(|| rel.to_owned())
    }

    /// Writes one file of the root, in chunks, reporting progress. It must be exactly as long as
    /// the archive declared: shorter or longer and the archive is refused (a declared size is
    /// never trusted on its own). Entries that aren't part of this root are skipped; the return
    /// says whether anything was written.
    pub fn write(&mut self, entry: &str, reader: &mut dyn Read) -> AppResult<bool> {
        let Some(rel) = self.wanted(entry) else { return Ok(false) };
        let declared = self.pending.remove(&rel).unwrap_or(0);
        let path = join_rel(self.dest, &rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| write_error(&rel, &e))?;
        }
        let mut file = fs::File::create(&path).map_err(|e| write_error(&rel, &e))?;
        let mut buf = vec![0u8; CHUNK_BYTES];
        let mut written = 0u64;
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(damaged(format!("{rel}: {e}"))),
            };
            written += n as u64;
            if written > declared {
                return Err(damaged(format!("{rel}: longer than the {declared} bytes it declares")));
            }
            if self.tick.bytes_done + written > MAX_TOTAL_BYTES {
                return Err(too_big(format!("more than {MAX_TOTAL_BYTES} bytes")));
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

    /// Whether every file of the root has been written.
    pub fn done(&self) -> bool {
        self.pending.is_empty()
    }

    /// The totals, once every file of the root has been written (`unsupported` otherwise: the
    /// archive promised files its data doesn't hold).
    pub fn finish(self) -> AppResult<ExtractTick> {
        if let Some((missing, _)) = self.pending.iter().next() {
            return Err(damaged(format!("{missing}: not in the archive's data")));
        }
        Ok(self.tick)
    }
}

fn write_error(rel: &str, e: &io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not copy the skin files").with_detail(format!("{rel}: {e}"))
}

/// Reads the first `limit` bytes of `reader` (all of it when shorter).
pub fn read_limited(reader: &mut dyn Read, limit: u64) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit).read_to_end(&mut bytes).map_err(|e| damaged(e.to_string()))?;
    Ok(bytes)
}
