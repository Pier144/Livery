//! A library index, persisted as JSON:
//! `{ "version": 2, "gameRoot"?: "…", "skins": [HangarSkin…], "collections": [Collection…],
//!    "activeCollectionId"?: "…", "backups": [BackupRecord…] }`.
//! Each game root has its own index file (`<appData>/library/<key>.json`, see `super::roots`);
//! `gameRoot` names the root it belongs to, for people reading the file (loading ignores it).
//! Version 1 files (M2: `{ "version": 1, "skins": […] }`) load as they are; the next write
//! stores version 2.
//!
//! The index remembers what the disk can't tell: the stable id, name, origin, author, install
//! date, WT Live source, collections and backups. What the disk can tell (folder spelling,
//! vehicle, size, attention, active = which place the folder is in) is refreshed on every scan.
//! Skins are matched by folder name (case-insensitive on Windows, like the file system).
//!
//! An index file that exists but can't be read at launch (a sharing violation, permissions)
//! loads as an empty index and the store turns read-only for the session: every
//! [`LibraryStore::transact`] is refused before it touches the disk, so neither the real index
//! nor the folders it describes are changed on the strength of an empty one.

use super::layout::Journal;
use crate::error::{AppError, AppResult, ErrorCode, UnreadableFile};
use crate::model::{Backup, Collection, CollectionsState, HangarSkin};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Format version written to `library.json`.
pub const INDEX_VERSION: u32 = 2;

/// A skin folder kept aside by a delete or a replace, with what Undo needs to put it
/// back exactly as it was.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub backup: Backup,
    /// The index entry as it was (original id included), re-inserted on restore.
    pub skin: HangarSkin,
    /// Whether the folder was active (in `UserSkins`) or inactive when it was backed up.
    pub was_active: bool,
    /// Kept only for Undo (backups turned off in Settings): purged after a minute and never
    /// listed.
    #[serde(default)]
    pub ephemeral: bool,
    /// `<backupId>/<folder>`, relative to `UserSkins/.livery/backups`.
    pub dir: String,
}

/// Everything the index holds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Library {
    pub skins: Vec<HangarSkin>,
    pub collections: Vec<Collection>,
    /// The collection activated last.
    pub active_collection_id: Option<String>,
    pub backups: Vec<BackupRecord>,
}

impl Library {
    pub fn skin_position(&self, id: &str) -> Option<usize> {
        self.skins.iter().position(|s| s.id == id)
    }

    pub fn collection_position(&self, id: &str) -> Option<usize> {
        self.collections.iter().position(|c| c.id == id)
    }

    pub fn collections_state(&self) -> CollectionsState {
        CollectionsState {
            collections: self.collections.clone(),
            active_collection_id: self.active_collection_id.clone(),
        }
    }

    /// Drops collection members that are gone for good: neither in the index nor in a backup
    /// (a deleted skin keeps its memberships while Undo can still bring it back).
    pub fn drop_dangling_members(&mut self) {
        let known: HashSet<&str> =
            self.skins.iter().map(|s| s.id.as_str()).chain(self.backups.iter().map(|b| b.skin.id.as_str())).collect();
        for collection in &mut self.collections {
            collection.skin_ids.retain(|id| known.contains(id.as_str()));
        }
    }
}

pub struct LibraryStore {
    path: PathBuf,
    /// The game root this index belongs to (display form), written into the file.
    game_root: Option<String>,
    library: Mutex<Library>,
    /// Set when the file existed but couldn't be read at launch: every transaction is refused.
    unreadable: Option<UnreadableFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexOut<'a> {
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    game_root: Option<&'a str>,
    skins: &'a [HangarSkin],
    collections: &'a [Collection],
    #[serde(skip_serializing_if = "Option::is_none")]
    active_collection_id: Option<&'a str>,
    backups: &'a [BackupRecord],
}

/// Read loosely so one bad entry doesn't cost the whole index.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexIn {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    skins: Vec<serde_json::Value>,
    #[serde(default)]
    collections: Vec<serde_json::Value>,
    #[serde(default)]
    active_collection_id: Option<serde_json::Value>,
    #[serde(default)]
    backups: Vec<serde_json::Value>,
}

impl LibraryStore {
    /// Loads the index; a missing file is an empty index. A corrupt file is renamed to
    /// `library.json.bad` and the index starts empty; entries that don't parse are dropped and
    /// the original file is copied to `library.json.bad` first. A file that exists but can't be
    /// read starts empty too, and the store is read-only for the session (see the module doc).
    /// Never writes.
    pub fn load(path: PathBuf) -> Self {
        let (library, unreadable) = match read_index(&path) {
            Ok(library) => (library, None),
            Err(unreadable) => (Library::default(), Some(unreadable)),
        };
        Self { path, game_root: None, library: Mutex::new(library), unreadable }
    }

    /// [`Self::load`] for the index of the game root `game_root` (display form), which every
    /// write records in the file as `gameRoot`.
    pub fn load_for_root(path: PathBuf, game_root: String) -> Self {
        Self { game_root: Some(game_root), ..Self::load(path) }
    }

    /// An empty index that belongs to no file: what the install queue checks clashes against
    /// while no game folder is set. Never saved: a change to it fails to save and is undone.
    pub fn detached() -> Self {
        Self { path: PathBuf::new(), game_root: None, library: Mutex::new(Library::default()), unreadable: None }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The game root this index belongs to (display form), when it was loaded for one.
    pub fn game_root(&self) -> Option<&str> {
        self.game_root.as_deref()
    }

    /// Whether the file couldn't be read at launch, so nothing will be changed this session.
    pub fn is_read_only(&self) -> bool {
        self.unreadable.is_some()
    }

    /// The skins in My Hangar.
    pub fn all(&self) -> Vec<HangarSkin> {
        self.lock().skins.clone()
    }

    /// A copy of the whole index.
    pub fn snapshot(&self) -> Library {
        self.lock().clone()
    }

    /// Runs `change` on a copy of the index. When it succeeds and the copy differs, the copy is
    /// written (atomically) and becomes the index; when it fails or the write fails, the file
    /// changes it recorded in the journal are undone and the index stays as it was. Changes are
    /// serialized: one at a time. A read-only store (see the module doc) refuses every change
    /// with `io` before running it: a change may touch the disk (move folders, delete backups)
    /// and only the real index, which couldn't be read, knows what those folders are.
    pub fn transact<T>(&self, change: impl FnOnce(&mut Library, &mut Journal) -> AppResult<T>) -> AppResult<T> {
        if let Some(unreadable) = &self.unreadable {
            return Err(unreadable.error());
        }
        let mut guard = self.lock();
        let mut next = guard.clone();
        let mut journal = Journal::default();
        let value = match change(&mut next, &mut journal) {
            Ok(value) => value,
            Err(e) => {
                journal.rollback();
                return Err(e);
            }
        };
        if next != *guard {
            if let Err(e) = write_atomic(&self.path, self.game_root.as_deref(), &next) {
                tracing::error!(error = %e, "library index could not be saved; changes undone");
                journal.rollback();
                return Err(e);
            }
            *guard = next;
        }
        journal.commit();
        Ok(value)
    }

    /// Adds scanned skins to the index, or refreshes them when their folder is already indexed
    /// (so importing twice changes nothing but the disk facts). Persists, then returns the whole
    /// index.
    pub fn import(&self, scanned: Vec<HangarSkin>) -> AppResult<Vec<HangarSkin>> {
        self.transact(|library, _| {
            let mut by_folder = folder_positions(&library.skins);
            for skin in scanned {
                let key = folder_key(&skin.folder);
                match by_folder.get(&key) {
                    Some(&i) => library.skins[i] = refresh(&library.skins[i], skin),
                    None => {
                        by_folder.insert(key, library.skins.len());
                        library.skins.push(HangarSkin { id: new_id(), ..skin });
                    }
                }
            }
            Ok(library.skins.clone())
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Library> {
        self.library.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A skin already in the index, updated with what is on disk now: the index keeps id, name,
/// origin, author, install date, source and temporary; the disk wins for the folder's spelling,
/// the vehicle, the size, the attention list and whether it is active (which place it is in).
pub fn refresh(indexed: &HangarSkin, scanned: HangarSkin) -> HangarSkin {
    HangarSkin {
        id: indexed.id.clone(),
        name: indexed.name.clone(),
        origin: indexed.origin,
        author: indexed.author.clone(),
        installed_at: indexed.installed_at.clone(),
        source_id: indexed.source_id.clone(),
        temporary: indexed.temporary,
        ..scanned
    }
}

/// A new stable skin id: `s-<hex nanoseconds since 1970>-<process counter>`.
pub fn new_id() -> String {
    new_id_with("s")
}

/// A new id `<prefix>-<hex nanoseconds since 1970>-<process counter>` (`b` backups,
/// `c` collections, `s` skins).
pub fn new_id_with(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{prefix}-{nanos:x}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// How folder names compare: case-insensitive on Windows, where the file system is.
pub fn folder_key(folder: &str) -> String {
    if cfg!(windows) {
        folder.to_lowercase()
    } else {
        folder.to_owned()
    }
}

/// Folder key → position; the first entry wins if the file repeats a folder.
fn folder_positions(skins: &[HangarSkin]) -> HashMap<String, usize> {
    let mut map = HashMap::with_capacity(skins.len());
    for (i, skin) in skins.iter().enumerate() {
        map.entry(folder_key(&skin.folder)).or_insert(i);
    }
    map
}

/// The stored index, or why the file that is there can't be read (see the module doc).
fn read_index(path: &Path) -> Result<Library, UnreadableFile> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Library::default()),
        Err(e) => {
            tracing::warn!(error = %e, "cannot read the library index; starting empty, read-only this session");
            tracing::debug!(path = %path.display(), "library index");
            return Err(UnreadableFile::new(path, &e));
        }
    };
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let index: IndexIn = match serde_json::from_slice(text) {
        Ok(index) => index,
        Err(e) => {
            tracing::warn!(error = %e, "library index is corrupt; set aside as library.json.bad");
            let _ = fs::rename(path, bad_path(path));
            return Ok(Library::default());
        }
    };
    if index.version > INDEX_VERSION {
        tracing::warn!(version = index.version, "library index was written by a newer Livery");
    }
    let mut dropped = 0;
    let skins: Vec<HangarSkin> = entries(index.skins, &mut dropped);
    let collections: Vec<Collection> = entries(index.collections, &mut dropped);
    let backups: Vec<BackupRecord> = entries(index.backups, &mut dropped);
    if dropped > 0 {
        tracing::warn!(dropped, "library index has unreadable entries; copy kept as library.json.bad");
        let _ = fs::copy(path, bad_path(path));
    }
    let active_collection_id = index
        .active_collection_id
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|id| collections.iter().any(|c| &c.id == id));
    Ok(Library { skins, collections, active_collection_id, backups })
}

/// The entries of one list that parse; the others are counted in `dropped`.
fn entries<T: DeserializeOwned>(values: Vec<serde_json::Value>, dropped: &mut usize) -> Vec<T> {
    let total = values.len();
    let parsed: Vec<T> = values.into_iter().filter_map(|value| serde_json::from_value(value).ok()).collect();
    *dropped += total - parsed.len();
    parsed
}

fn bad_path(path: &Path) -> PathBuf {
    path.with_extension("json.bad")
}

/// Write to a sibling temp file, then rename over the target (replaces on Windows too).
fn write_atomic(path: &Path, game_root: Option<&str>, library: &Library) -> AppResult<()> {
    if path.as_os_str().is_empty() {
        return Err(AppError::new(ErrorCode::Internal, "This library index can't be saved"));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let out = IndexOut {
        version: INDEX_VERSION,
        game_root,
        skins: &library.skins,
        collections: &library.collections,
        active_collection_id: library.active_collection_id.as_deref(),
        backups: &library.backups,
    };
    let tmp = path.with_extension("json.tmp");
    let written = (|| -> AppResult<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(&out)?)?;
        // On disk before the rename, so a crash can't leave an empty or torn index behind.
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}
