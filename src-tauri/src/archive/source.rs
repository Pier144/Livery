//! Where a skin comes from. A [`SkinSource`] lists what it holds, reads the start of a file and
//! copies a sub-folder into a destination with progress. [`FolderSource`] (a folder on disk) is
//! the only kind today; ZIP, RAR and 7z readers plug in behind the same trait once their
//! unpacking crates are approved, and until then [`open_source`] answers `unsupported` for them.
//!
//! Paths inside a source are relative and `/`-separated (`""` is the source itself). Livery's own
//! files are never part of a skin: a `.livery` folder (Livery's data inside `UserSkins`, e.g. when
//! the whole `UserSkins` folder is dropped) and the `.livery-partial` marker are left out.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::root;
use crate::library::layout::LIVERY_DIR;
use crate::library::scan::PARTIAL_MARKER;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// `unsupported` message for ZIP / RAR / 7z until their unpacking crates are approved.
pub const UNSUPPORTED_ARCHIVES: &str = "ZIP, RAR and 7z archives can't be unpacked yet â€” this needs the unpacking library the author hasn't approved. Skin folders work today.";

/// `invalidInput` message for a path that is neither a folder nor a known archive.
pub const NOT_A_SOURCE: &str = "Not a skin folder or archive";

/// `notFound` message for a path that doesn't exist (any more).
pub const SOURCE_GONE: &str = "The file or folder can't be found";

/// `invalidInput` message for a folder far too big to be a skin (e.g. a whole Downloads folder).
pub const TOO_MANY_FILES: &str = "This folder holds too many files to be a skin";

/// Archive extensions (compared case-insensitively).
pub const ARCHIVE_EXTENSIONS: [&str; 3] = ["zip", "rar", "7z"];

/// How deep sub-folders are followed (as `library::scan`); deeper ones are left out.
pub const MAX_DEPTH: usize = 16;

/// Entries (files and folders) a source may hold before it is refused as "not a skin".
pub const MAX_ENTRIES: usize = 20_000;

/// Copy buffer; progress is reported after each chunk and after each file.
const CHUNK_BYTES: usize = 1 << 20;

/// One file or folder inside a source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceEntry {
    /// Relative, `/`-separated.
    pub path: String,
    /// File length (0 for folders).
    pub size_bytes: u64,
    pub is_dir: bool,
}

/// Where a copy stands: files and bytes done out of the totals of the sub-folder being copied.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExtractTick {
    pub files_done: u64,
    pub files_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

/// A skin folder, or an archive holding one or more skins.
pub trait SkinSource: Send + Sync {
    /// Every file and folder inside, parents before their children, sorted by name within a
    /// folder. Fails (`invalidInput`) when there are more than [`MAX_ENTRIES`].
    fn entries(&self) -> AppResult<Vec<SourceEntry>>;

    /// The first `limit` bytes of the file at `path` (all of it when shorter).
    fn read(&self, path: &str, limit: u64) -> AppResult<Vec<u8>>;

    /// Copies (or unpacks) the folder `root` (`""` = everything) into `dest`, an existing
    /// folder: `root/a/b.dds` lands at `dest/a/b.dds`. `progress` runs after each chunk and each
    /// file with running totals; an error from it stops the copy and is returned. What was
    /// written before a failure stays in `dest` (the caller owns clean-up). Returns the totals.
    fn extract(
        &self,
        root: &str,
        dest: &Path,
        progress: &mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<ExtractTick>;

    /// A folder on disk holding `root` exactly as the source has it, when there is one (plain
    /// folders), so readers that need real paths (texture headers) can look in place.
    fn local_dir(&self, _root: &str) -> Option<PathBuf> {
        None
    }
}

/// Whether a file name ends in `.zip`, `.rar` or `.7z` (any case).
pub fn is_archive_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty() && ARCHIVE_EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(ext))
    })
}

/// The source at `path`: a folder â†’ [`FolderSource`]; a `.zip` / `.rar` / `.7z` file â†’
/// `unsupported` ([`UNSUPPORTED_ARCHIVES`]) for now; a path that doesn't exist â†’ `notFound`;
/// anything else â†’ `invalidInput` ([`NOT_A_SOURCE`]).
pub fn open_source(path: &Path) -> AppResult<Box<dyn SkinSource>> {
    let shown = root::display_path(path);
    if path.as_os_str().is_empty() {
        return Err(AppError::new(ErrorCode::InvalidInput, NOT_A_SOURCE));
    }
    let meta = fs::metadata(path).map_err(|e| {
        let code = if e.kind() == io::ErrorKind::NotFound { ErrorCode::NotFound } else { ErrorCode::Io };
        let message = if code == ErrorCode::NotFound { SOURCE_GONE } else { "Could not open the file or folder" };
        AppError::new(code, message).with_detail(format!("{shown}: {e}"))
    })?;
    if meta.is_dir() {
        return Ok(Box::new(FolderSource::new(path)));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if meta.is_file() && is_archive_name(&name) {
        return Err(AppError::new(ErrorCode::Unsupported, UNSUPPORTED_ARCHIVES).with_detail(shown));
    }
    Err(AppError::new(ErrorCode::InvalidInput, NOT_A_SOURCE).with_detail(shown))
}

/// A skin folder (or a folder of skins) on disk. Links and junctions are not followed.
#[derive(Debug, Clone)]
pub struct FolderSource {
    dir: PathBuf,
}

impl FolderSource {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// `rel` under the folder (see [`join_rel`]).
    fn resolve(&self, rel: &str) -> AppResult<PathBuf> {
        join_rel(&self.dir, rel)
    }
}

/// `rel` (relative, `/`-separated; `""` = `base` itself) under `base`. Anything that could step
/// outside `base` is refused (`invalidInput`): `..`, `.`, empty parts (so no leading `/`), `\`,
/// `:` (drives, alternate data streams) and control characters. Every source joins entry paths
/// with this, reading and writing alike, so a hostile archive entry (`..\x`, `C:\x`) can never
/// land outside the staging folder.
pub fn join_rel(base: &Path, rel: &str) -> AppResult<PathBuf> {
    let mut path = base.to_path_buf();
    if rel.is_empty() {
        return Ok(path);
    }
    for part in rel.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.contains(['\\', ':'])
            || part.contains(char::is_control)
        {
            return Err(AppError::new(ErrorCode::InvalidInput, "Not a path inside the skin folder").with_detail(rel));
        }
        path.push(part);
    }
    Ok(path)
}

impl SkinSource for FolderSource {
    fn entries(&self) -> AppResult<Vec<SourceEntry>> {
        list(&self.dir)
    }

    fn read(&self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        let full = self.resolve(path)?;
        let mut bytes = Vec::new();
        fs::File::open(&full)
            .and_then(|f| f.take(limit).read_to_end(&mut bytes))
            .map_err(|e| AppError::from(e).with_detail(format!("{path}: could not be read")))?;
        Ok(bytes)
    }

    fn extract(
        &self,
        root: &str,
        dest: &Path,
        progress: &mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<ExtractTick> {
        let base = self.resolve(root)?;
        if !base.is_dir() {
            return Err(AppError::new(ErrorCode::NotFound, SOURCE_GONE).with_detail(root.to_owned()));
        }
        // The list is read before anything is written, so copying into a folder inside the
        // source (e.g. when `UserSkins` itself was dropped) can't loop.
        let entries = list(&base)?;
        let mut tick = ExtractTick {
            files_total: entries.iter().filter(|e| !e.is_dir).count() as u64,
            bytes_total: entries.iter().filter(|e| !e.is_dir).map(|e| e.size_bytes).sum(),
            ..ExtractTick::default()
        };
        progress(tick)?;
        for entry in &entries {
            let to = join_rel(dest, &entry.path)?;
            if entry.is_dir {
                fs::create_dir_all(&to).map_err(|e| copy_error(&entry.path, &e))?;
                continue;
            }
            copy_file(&join_rel(&base, &entry.path)?, &to, &mut |n| {
                tick.bytes_done += n;
                progress(tick)
            })
            .map_err(|e| match e {
                Copy::Io(e) => copy_error(&entry.path, &e),
                Copy::Stopped(e) => e,
            })?;
            tick.files_done += 1;
            progress(tick)?;
        }
        Ok(tick)
    }

    fn local_dir(&self, root: &str) -> Option<PathBuf> {
        self.resolve(root).ok().filter(|p| p.is_dir())
    }
}

fn copy_error(rel: &str, e: &io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not copy the skin files").with_detail(format!("{rel}: {e}"))
}

/// Why a file copy stopped.
enum Copy {
    Io(io::Error),
    /// The progress callback said stop.
    Stopped(AppError),
}

/// Copies one file in chunks, reporting the bytes of each chunk. Never overwrites a folder.
fn copy_file(from: &Path, to: &Path, progress: &mut dyn FnMut(u64) -> AppResult<()>) -> Result<(), Copy> {
    let mut input = fs::File::open(from).map_err(Copy::Io)?;
    let mut output = fs::File::create(to).map_err(Copy::Io)?;
    let mut buf = vec![0u8; CHUNK_BYTES];
    loop {
        let n = match input.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(Copy::Io(e)),
        };
        output.write_all(&buf[..n]).map_err(Copy::Io)?;
        progress(n as u64).map_err(Copy::Stopped)?;
    }
    output.flush().map_err(Copy::Io)
}

/// Every file and folder under `dir` (see [`SkinSource::entries`]).
fn list(dir: &Path) -> AppResult<Vec<SourceEntry>> {
    let mut out = Vec::new();
    walk(dir, "", 0, &mut out)?;
    Ok(out)
}

fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<SourceEntry>) -> AppResult<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // The folder itself must be readable; a sub-folder that isn't is left out, as in the scan.
        Err(e) if depth == 0 => {
            let code = if e.kind() == io::ErrorKind::NotFound { ErrorCode::NotFound } else { ErrorCode::Io };
            return Err(AppError::new(code, "Could not read the skin folder").with_detail(e.to_string()));
        }
        Err(e) => {
            tracing::debug!(error = %e, folder = prefix, "sub-folder can't be read; left out");
            return Ok(());
        }
    };
    let mut children: Vec<(String, fs::DirEntry)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| match entry.file_name().into_string() {
            Ok(name) => Some((name, entry)),
            Err(raw) => {
                tracing::warn!(name = ?raw, "file name is not valid Unicode; left out");
                None
            }
        })
        .collect();
    children.sort_by(|(a, _), (b, _)| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
    for (name, entry) in children {
        // `file_type` does not follow links, so a junction loop can't trap the walk.
        let Ok(kind) = entry.file_type() else { continue };
        let rel = format!("{prefix}{name}");
        if kind.is_dir() {
            if name.eq_ignore_ascii_case(LIVERY_DIR) || depth >= MAX_DEPTH {
                continue;
            }
            out.push(SourceEntry { path: rel.clone(), size_bytes: 0, is_dir: true });
            check_count(out)?;
            walk(&entry.path(), &format!("{rel}/"), depth + 1, out)?;
        } else if kind.is_file() {
            if name.eq_ignore_ascii_case(PARTIAL_MARKER) {
                continue;
            }
            let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(SourceEntry { path: rel, size_bytes, is_dir: false });
            check_count(out)?;
        }
    }
    Ok(())
}

fn check_count(out: &[SourceEntry]) -> AppResult<()> {
    if out.len() > MAX_ENTRIES {
        return Err(AppError::new(ErrorCode::InvalidInput, TOO_MANY_FILES)
            .with_detail(format!("more than {MAX_ENTRIES} files and folders")));
    }
    Ok(())
}
