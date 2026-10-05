//! Looks inside a source without installing anything: which folders are skins (a folder with a
//! `.blk` directly inside), for which vehicle, under which folder name they would install, and
//! whether that name is taken (in `UserSkins`, in Livery's inactive folder, or by another item
//! waiting in the queue).
//!
//! A *skin root* is the source itself or any sub-folder at most [`MAX_ROOT_DEPTH`] levels down
//! that holds a top-level `*.blk`. Hidden folders (`.`-prefixed) and macOS `__MACOSX` folders are
//! never roots. The vehicle is the `.blk` stem (the alphabetically first one, as the library scan
//! picks it); the folder name is the root's own name, sanitized when it isn't a valid one.

use super::source::{is_archive_name, open_source, SkinSource, SourceEntry};
use super::{Entry, QueueStore};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::root;
use crate::library::index::{folder_key, Library, LibraryStore};
use crate::library::{blk, layout, vehicles};
use crate::model::{FileEntry, HangarSkin, QueueItem, QueueStatus, Vehicle};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// `error` of an item with no skin inside.
pub const NO_BLK_ERROR: &str = "No .blk file inside, so the game can't use it";

/// How many folder levels below the source a skin root may sit.
pub const MAX_ROOT_DEPTH: usize = 4;

/// Folder name used when a root's own name can't be made into a valid one.
pub const FALLBACK_FOLDER: &str = "Skin";

/// Longest folder name Livery creates (well under Windows' 255-character limit per name).
const MAX_FOLDER_CHARS: usize = 120;

/// Skin `.blk` files are a few hundred bytes; never read more than this (as `library::scan`).
const MAX_BLK_BYTES: u64 = 4 * 1024 * 1024;

/// `conflictWith` prefix of a folder on disk that the library doesn't index (as `library::scan`).
pub const DISK_PREFIX: &str = "disk:";

/// `conflictWith` prefix of another queue item that will install under the same folder name.
pub const QUEUE_PREFIX: &str = "queue:";

/// One skin inside a source.
#[derive(Debug, Clone, PartialEq)]
pub struct SkinRoot {
    /// Folder inside the source, `/`-separated; `""` is the source itself.
    pub dir: String,
    /// File name of the skin's `.blk` in that folder.
    pub blk: String,
    pub vehicle: Vehicle,
    /// Folder name it installs as inside `UserSkins`.
    pub target_folder: String,
    /// Every file under the root, relative to it, sorted by path.
    pub files: Vec<FileEntry>,
    /// `.dds` / `.tga` files directly in the root (the ones the texture table lists).
    pub texture_count: u32,
    /// The `.blk` parses as BLK text.
    pub blk_ok: bool,
}

impl SkinRoot {
    /// The `.blk` stem, i.e. the vehicle code as written in the file name.
    pub fn blk_stem(&self) -> &str {
        &self.blk[..self.blk.len().saturating_sub(4)]
    }
}

/// What a source holds.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Analysis {
    /// Total size of every file.
    pub size_bytes: u64,
    /// Skin roots, ordered by path (case-insensitive).
    pub roots: Vec<SkinRoot>,
}

/// Finds the skin roots of `source`; `source_name` names the source itself (its folder name).
pub fn analyze_source(source: &dyn SkinSource, source_name: &str) -> AppResult<Analysis> {
    let entries = source.entries()?;
    let size_bytes = entries.iter().filter(|e| !e.is_dir).map(|e| e.size_bytes).sum();

    // Folder → names of the files directly in it.
    let mut top_files: HashMap<&str, Vec<&str>> = HashMap::new();
    for entry in entries.iter().filter(|e| !e.is_dir) {
        let (parent, name) = split_parent(&entry.path);
        top_files.entry(parent).or_default().push(name);
    }

    let candidates = std::iter::once("").chain(
        entries
            .iter()
            .filter(|e| e.is_dir && depth(&e.path) <= MAX_ROOT_DEPTH && !e.path.split('/').any(is_skipped_folder))
            .map(|e| e.path.as_str()),
    );
    let found: Vec<(&str, &str)> = candidates
        .filter_map(|dir| top_files.get(dir).and_then(|names| skin_blk(names)).map(|blk| (dir, blk)))
        .collect();
    // Every `.blk` in one go: an archive reader reads them in a single pass.
    let wanted: Vec<(String, u64)> = found.iter().map(|(dir, blk)| (join(dir, blk), MAX_BLK_BYTES + 1)).collect();
    let blks = source.read_many(&wanted).unwrap_or_else(|e| {
        tracing::debug!(error = %e, "skin blk files can't be read");
        HashMap::new()
    });
    let mut roots = Vec::new();
    for (dir, blk) in found {
        let own_name = if dir.is_empty() { source_name } else { split_parent(dir).1 };
        roots.push(describe_root(&entries, dir, blk, blks.get(&join(dir, blk)), own_name));
    }
    roots.sort_by(|a, b| a.dir.to_lowercase().cmp(&b.dir.to_lowercase()).then_with(|| a.dir.cmp(&b.dir)));
    Ok(Analysis { size_bytes, roots })
}

/// `dir/name` (`name` alone at the top).
fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// One skin root; `blk_bytes` is the start of its `.blk` (`None` when it couldn't be read).
fn describe_root(
    entries: &[SourceEntry],
    dir: &str,
    blk: &str,
    blk_bytes: Option<&Vec<u8>>,
    own_name: &str,
) -> SkinRoot {
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let mut files: Vec<FileEntry> = entries
        .iter()
        .filter(|e| !e.is_dir)
        .filter_map(|e| e.path.strip_prefix(prefix.as_str()).map(|rel| (rel, e.size_bytes)))
        .map(|(rel, size_bytes)| FileEntry { path: rel.to_owned(), size_bytes })
        .collect();
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()).then_with(|| a.path.cmp(&b.path)));
    let texture_count =
        files.iter().filter(|f| !f.path.contains('/') && is_texture(&f.path)).count().try_into().unwrap_or(u32::MAX);
    let blk_ok = blk_bytes.is_some_and(|bytes| bytes.len() as u64 <= MAX_BLK_BYTES && blk::parse_bytes(bytes).is_ok());
    let stem = &blk[..blk.len() - 4];
    let vehicle = vehicles::resolve(stem);
    let target_folder = sanitize_folder_name(own_name, &vehicle.code);
    SkinRoot { dir: dir.to_owned(), blk: blk.to_owned(), vehicle, target_folder, files, texture_count, blk_ok }
}

/// (parent folder, name) of a `/` path; the parent of a top-level name is `""`.
fn split_parent(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

fn depth(path: &str) -> usize {
    path.split('/').count()
}

/// Folders that are never skins: hidden ones and the resource forks macOS zips carry.
fn is_skipped_folder(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("__MACOSX")
}

/// The skin's `.blk` among a folder's file names: the alphabetically first `*.blk`
/// (case-insensitive), as `library::scan` picks it.
fn skin_blk<'a>(names: &[&'a str]) -> Option<&'a str> {
    names
        .iter()
        .copied()
        // ASCII-only: Unicode lower-casing would turn "x.BL\u{212A}" (Kelvin sign) into "x.blk".
        .filter(|name| name.len() > 4 && name.get(name.len() - 4..).is_some_and(|e| e.eq_ignore_ascii_case(".blk")))
        .min_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)))
}

fn is_texture(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("dds") || ext.eq_ignore_ascii_case("tga"))
}

/// A folder name Livery can create for `name` (see `layout::is_folder_name`): characters Windows
/// refuses (`<>:"/\|?*`, control characters) become `_`, leading dots and trailing dots or spaces
/// go, reserved device names (`CON`, `COM1`…) get a trailing `_`, and very long names are cut.
/// Falls back to the vehicle code, then to [`FALLBACK_FOLDER`].
pub fn sanitize_folder_name(name: &str, vehicle_code: &str) -> String {
    if layout::is_folder_name(name)
        && !is_reserved(name)
        && name.chars().count() <= MAX_FOLDER_CHARS
        && !has_forbidden(name)
    {
        return name.to_owned();
    }
    let replaced: String = name.chars().map(|c| if is_forbidden(c) { '_' } else { c }).collect();
    let cut: String = replaced.trim_start_matches(['.', ' ']).chars().take(MAX_FOLDER_CHARS).collect();
    let mut cleaned = cut.trim_end_matches(['.', ' ']).to_owned();
    if is_reserved(&cleaned) {
        // After the device name itself: Windows reads "COM1.skin_" as COM1 still.
        let at = cleaned.find('.').unwrap_or(cleaned.len());
        let at = cleaned[..at].trim_end().len();
        cleaned.insert(at, '_');
    }
    if layout::is_folder_name(&cleaned) {
        return cleaned;
    }
    if !vehicle_code.is_empty() && vehicle_code != name {
        return sanitize_folder_name(vehicle_code, "");
    }
    FALLBACK_FOLDER.to_owned()
}

fn is_forbidden(c: char) -> bool {
    c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
}

fn has_forbidden(name: &str) -> bool {
    name.chars().any(is_forbidden)
}

/// Windows device names, which can't be folder names even with an extension (`CON.txt`):
/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (the superscript digits ¹²³ too).
fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end().to_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let Some(digit) = stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT")) else { return false };
    let mut chars = digit.chars();
    matches!((chars.next(), chars.next()), (Some('1'..='9' | '¹' | '²' | '³'), None))
}

// ── Name clashes ────────────────────────────────────────────────────────────

/// Something already sits where a skin would install.
#[derive(Debug, Clone, PartialEq)]
pub struct Clash {
    /// The clashing folder (or file), as spelled on disk.
    pub path: PathBuf,
    pub folder: String,
    /// In `UserSkins` (true) or in Livery's inactive folder.
    pub active: bool,
    /// Position of the indexed skin that owns it, if the library knows it.
    pub index: Option<usize>,
}

impl Clash {
    /// `conflictWith`: the owner's id, or `disk:<folder>` for a folder the library doesn't know.
    pub fn with(&self, library: &Library) -> String {
        match self.index {
            Some(i) => library.skins[i].id.clone(),
            None => format!("{DISK_PREFIX}{}", self.folder),
        }
    }

    /// Name to show: the owner's name, else the folder.
    pub fn name(&self, library: &Library) -> String {
        match self.index {
            Some(i) => library.skins[i].name.clone(),
            None => self.folder.clone(),
        }
    }
}

/// What occupies `folder` (case-insensitive where the file system is): `UserSkins/<folder>`
/// first, then `.livery/inactive/<folder>`, with the indexed skin that owns it.
pub fn find_clash(user_skins: &Path, library: &Library, folder: &str) -> Option<Clash> {
    let key = folder_key(folder);
    for active in [true, false] {
        let path = layout::skin_path(user_skins, folder, active)?;
        if !layout::occupied(&path) {
            continue;
        }
        let base = layout::base_dir(user_skins, active);
        let spelled = spelled_on_disk(&base, &key).unwrap_or_else(|| folder.to_owned());
        let same = |s: &HangarSkin| folder_key(&s.folder) == key;
        // The skin indexed in this place, else one whose folder turned out to be here.
        let index = library.skins.iter().position(|s| same(s) && s.active == active).or_else(|| {
            library.skins.iter().position(|s| {
                same(s) && layout::find_skin(user_skins, s).is_some_and(|(_, in_active)| in_active == active)
            })
        });
        return Some(Clash { path: base.join(&spelled), folder: spelled, active, index });
    }
    None
}

/// The spelling on disk of the entry of `dir` whose folder key is `key`.
fn spelled_on_disk(dir: &Path, key: &str) -> Option<String> {
    fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|name| folder_key(name) == key)
}

/// Why an item can't install under its folder name as it is.
#[derive(Debug, Clone, PartialEq)]
pub struct Conflict {
    /// `conflictWith`: a skin id, `disk:<folder>` or `queue:<queueId>`.
    pub with: String,
    /// English fallback for the row.
    pub note: String,
}

impl Conflict {
    pub fn installed(clash: &Clash, library: &Library) -> Self {
        Self {
            with: clash.with(library), note: format!("Same folder name as “{}” (installed)", clash.name(library))
        }
    }

    pub fn queued(queue_id: &str, folder: &str) -> Self {
        Self { with: format!("{QUEUE_PREFIX}{queue_id}"), note: format!("Same folder name as “{folder}” (queued)") }
    }
}

// ── Queue items ─────────────────────────────────────────────────────────────

/// "6 files · 2 textures · su_27.blk ok".
pub fn ready_note(root: &SkinRoot) -> String {
    let files = root.files.len();
    let textures = root.texture_count;
    let blk = if root.blk_ok { format!("{} ok", root.blk) } else { format!("{} can't be read", root.blk) };
    format!("{} · {} · {blk}", plural(files as u64, "file"), plural(u64::from(textures), "texture"))
}

/// "Can't detect the vehicle: 3 folders inside. Pick one to continue."
pub fn needs_look_note(roots: usize) -> String {
    format!("Can't detect the vehicle: {roots} folders inside. Pick one to continue.")
}

fn plural(n: u64, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// An item holding exactly `root`: ready, or a conflict.
pub fn single_item(base: &QueueItem, root: &SkinRoot, conflict: Option<Conflict>) -> QueueItem {
    let (status, conflict_with, note) = match conflict {
        Some(c) => (QueueStatus::Conflict, Some(c.with), c.note),
        None => (QueueStatus::Ready, None, ready_note(root)),
    };
    QueueItem {
        status,
        vehicle: Some(root.vehicle.clone()),
        candidates: Vec::new(),
        conflict_with,
        target_folder: Some(root.target_folder.clone()),
        files: root.files.clone(),
        texture_count: Some(root.texture_count),
        blk_ok: Some(root.blk_ok),
        note: Some(note),
        error: None,
        ..base.clone()
    }
}

/// The item for what the analysis found: one skin (ready; conflicts are worked out by the queue),
/// several (needsLook, one candidate per root) or none (error).
pub fn describe(base: &QueueItem, roots: &[SkinRoot], failure: Option<&AppError>) -> QueueItem {
    let blank = QueueItem {
        status: QueueStatus::Error,
        vehicle: None,
        candidates: Vec::new(),
        conflict_with: None,
        target_folder: None,
        files: Vec::new(),
        texture_count: None,
        blk_ok: None,
        note: None,
        error: None,
        ..base.clone()
    };
    match roots {
        [] => {
            QueueItem { error: Some(failure.map_or_else(|| NO_BLK_ERROR.to_owned(), |e| e.message.clone())), ..blank }
        }
        [root] => single_item(&blank, root, None),
        several => QueueItem {
            status: QueueStatus::NeedsLook,
            candidates: several.iter().map(|r| r.vehicle.clone()).collect(),
            note: Some(needs_look_note(several.len())),
            ..blank
        },
    }
}

/// What `analyze_path` queued.
#[derive(Debug, Clone, PartialEq)]
pub struct Queued {
    pub item: QueueItem,
    /// Other items whose status changed meanwhile (to re-send as `queue://added`).
    pub changed: Vec<QueueItem>,
}

/// Analyses the folder or archive at `path` and stores the result in the queue. A path already
/// waiting in the queue is analysed again in place (same id); one that is installing is left
/// alone; one already installed gets a new item. Name clashes are checked against `user_skins`
/// (when a game folder is set) and older queue items.
///
/// An archive's own name is its file name without the extension (`Winter Tiger.zip` installs
/// as `Winter Tiger` when its skin sits at the top), and its size is the archive file's.
///
/// Errors: `notFound` (the path is gone), `invalidInput` (not a folder or archive, or far too
/// many files), `io`. A ZIP/RAR/7z that can't be unpacked (encrypted, split, damaged, unsafe
/// paths or links, too big) is not an error: it becomes an `error` item carrying the reason, so
/// the row can explain itself.
pub fn analyze_path(
    path: &Path,
    user_skins: Option<&Path>,
    library: &LibraryStore,
    queue: &QueueStore,
) -> AppResult<Queued> {
    let shown = root::display_path(path);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| shown.clone());
    let archive_size = fs::metadata(path).ok().filter(|m| m.is_file() && is_archive_name(&file_name)).map(|m| m.len());
    let source_name = match archive_size {
        Some(_) => file_name.rsplit_once('.').map_or(file_name.as_str(), |(stem, _)| stem),
        None => file_name.as_str(),
    };
    let (analysis, failure) = match (open_source(path), archive_size) {
        (Ok(source), None) => (analyze_source(source.as_ref(), source_name)?, None),
        (Ok(source), Some(size_bytes)) => {
            (Analysis { size_bytes, ..analyze_source(source.as_ref(), source_name)? }, None)
        }
        (Err(e), Some(size_bytes)) if e.code != ErrorCode::NotFound => {
            tracing::info!(error = %e, "archive can't be unpacked");
            (Analysis { size_bytes, roots: Vec::new() }, Some(e))
        }
        (Err(e), _) => return Err(e),
    };
    let base = QueueItem {
        id: String::new(),
        path: shown,
        file_name,
        size_bytes: analysis.size_bytes,
        status: QueueStatus::Ready,
        vehicle: None,
        candidates: Vec::new(),
        conflict_with: None,
        target_folder: None,
        files: Vec::new(),
        texture_count: None,
        blk_ok: None,
        note: None,
        error: None,
    };
    let entry = Entry {
        item: describe(&base, &analysis.roots, failure.as_ref()),
        source: path.to_path_buf(),
        roots: analysis.roots,
        failure,
        installed_skin: None,
    };
    let queued = queue.put(entry, user_skins, &library.snapshot());
    tracing::info!(
        queue_id = %queued.item.id,
        status = ?queued.item.status,
        roots = queued.item.candidates.len().max(usize::from(queued.item.target_folder.is_some())),
        "source analysed"
    );
    Ok(queued)
}
