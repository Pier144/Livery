//! What the watcher reads from disk at each poll: the top-level listing of the watched folder,
//! the size of a new candidate, whether a new folder holds a skin, and a fingerprint of
//! `UserSkins`. Cheap by design: one directory listing per folder and poll, plus a walk of new
//! candidate folders only.

use super::poll::{Kind, Listed, Probe, Size};
use crate::archive::{analyze_source, FolderSource, SkinSource};
use crate::error::ErrorCode;
use crate::library::layout::{self, LIVERY_DIR};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Top-level files and folders of `dir`, sorted by name. Links, anything that is neither a file
/// nor a folder, and names that aren't valid Unicode are left out.
pub fn list_folder(dir: &Path) -> io::Result<Vec<Listed>> {
    let mut listed: Vec<Listed> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            let kind = if kind.is_dir() {
                Kind::Dir
            } else if kind.is_file() {
                Kind::File
            } else {
                return None;
            };
            let name = entry.file_name().into_string().ok()?;
            Some(Listed { name, kind })
        })
        .collect();
    listed.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(listed)
}

/// How big the entry `entry` of `dir` is right now. A file is opened (a file another program
/// holds exclusively is [`Probe::Retry`]) and its length read from the open handle, which is
/// current even while it grows (a directory listing may lag on Windows). A folder is walked like
/// a skin source: a folder with far too many files to be a skin is [`Probe::Ignore`].
pub fn measure(dir: &Path, entry: &Listed) -> Probe {
    let path = dir.join(&entry.name);
    match entry.kind {
        Kind::File => match fs::File::open(&path).and_then(|f| f.metadata()) {
            Ok(meta) if meta.is_file() => Probe::Size(Size { files: 1, bytes: meta.len() }),
            Ok(_) => Probe::Retry,
            Err(e) => {
                tracing::debug!(error = %e, "new download can't be opened yet");
                Probe::Retry
            }
        },
        Kind::Dir => match FolderSource::new(&path).entries() {
            Ok(entries) => {
                let files = entries.iter().filter(|e| !e.is_dir);
                Probe::Size(Size {
                    files: files.clone().count() as u64,
                    bytes: files.map(|e| e.size_bytes).fold(0, u64::saturating_add),
                })
            }
            // Far too many files to be a skin (a whole game or project folder).
            Err(e) if e.code == ErrorCode::InvalidInput => Probe::Ignore,
            Err(e) => {
                tracing::debug!(error = %e, "new folder can't be read yet");
                Probe::Retry
            }
        },
    }
}

/// Whether the folder at `path` holds at least one skin (a folder with a `.blk`, as the queue's
/// analysis finds them). A folder that can't be read holds none.
pub fn holds_skin(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match analyze_source(&FolderSource::new(path), &name) {
        Ok(analysis) => !analysis.roots.is_empty(),
        Err(e) => {
            tracing::debug!(error = %e, "new folder can't be analysed");
            false
        }
    }
}

/// A fingerprint of what the game and the hangar see in `UserSkins`: the names, kinds, sizes and
/// modification times of its entries (Livery's own `.livery` folder aside) and of the entries of
/// `.livery/inactive`, as one directory listing each reports them. Staging (`.livery/partial`)
/// and backups are not part of it, so an install in progress changes nothing until its final
/// rename. A missing `UserSkins` (or inactive folder) has a fingerprint of its own; any other
/// read error is returned (the poll is skipped).
///
/// Skin folders added, removed or renamed always count. A file added inside a skin folder moves
/// the folder's time, but Windows may update that time in the parent's listing late, so such a
/// change can be noticed late or not at all (opening every skin folder at each poll would not be
/// cheap).
pub fn hangar_signature(user_skins: &Path) -> io::Result<u64> {
    let mut hasher = DefaultHasher::new();
    hash_listing(user_skins, true, &mut hasher)?;
    hash_listing(&layout::inactive_dir(user_skins), false, &mut hasher)?;
    Ok(hasher.finish())
}

fn hash_listing(dir: &Path, skip_livery: bool, hasher: &mut DefaultHasher) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            "missing".hash(hasher);
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    let mut rows: Vec<(String, bool, u64, u128)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if skip_livery && name.eq_ignore_ascii_case(LIVERY_DIR) {
                return None;
            }
            // An entry gone since the listing simply isn't there.
            let meta = entry.metadata().ok()?;
            let modified =
                meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
            let len = if meta.is_dir() { 0 } else { meta.len() };
            Some((name, meta.is_dir(), len, modified))
        })
        .collect();
    rows.sort();
    "listing".hash(hasher);
    rows.hash(hasher);
    Ok(())
}
