//! The library index: skins added to My Hangar, persisted as `<appData>/library.json`
//! (`{ "version": 1, "skins": [HangarSkin…] }`). M3 moves it to SQLite.
//!
//! The index remembers what the disk can't tell: the stable id, origin, author, install date,
//! WT Live source, active flag. What the disk can tell (vehicle, size, attention) is refreshed
//! on every scan. Skins are matched by folder name (case-insensitive on Windows, like the file
//! system).

use crate::error::AppResult;
use crate::model::HangarSkin;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Format version written to `library.json`.
pub const INDEX_VERSION: u32 = 1;

pub struct LibraryStore {
    path: PathBuf,
    skins: Mutex<Vec<HangarSkin>>,
}

#[derive(Serialize)]
struct IndexOut<'a> {
    version: u32,
    skins: &'a [HangarSkin],
}

/// Read loosely so one bad entry doesn't cost the whole index.
#[derive(Deserialize)]
struct IndexIn {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    skins: Vec<serde_json::Value>,
}

impl LibraryStore {
    /// Loads the index; a missing file is an empty index. A corrupt file is renamed to
    /// `library.json.bad` and the index starts empty; entries that don't parse are dropped and
    /// the original file is copied to `library.json.bad` first.
    pub fn load(path: PathBuf) -> Self {
        let skins = read_index(&path);
        Self { path, skins: Mutex::new(skins) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn all(&self) -> Vec<HangarSkin> {
        self.lock().clone()
    }

    /// Scan results as the hangar knows them: skins already indexed keep their index identity
    /// (see `refresh`), new ones keep their `disk:` id. Nothing is written.
    pub fn merge_scan(&self, scanned: Vec<HangarSkin>) -> Vec<HangarSkin> {
        let skins = self.lock();
        let by_folder = folder_positions(&skins);
        scanned
            .into_iter()
            .map(|skin| match by_folder.get(&folder_key(&skin.folder)) {
                Some(&i) => refresh(&skins[i], skin),
                None => skin,
            })
            .collect()
    }

    /// Adds scanned skins to the index, or refreshes them when their folder is already indexed
    /// (so importing twice changes nothing but the disk facts). Persists, then returns the whole
    /// index. Memory changes only once the file is written.
    pub fn import(&self, scanned: Vec<HangarSkin>) -> AppResult<Vec<HangarSkin>> {
        let mut guard = self.lock();
        if scanned.is_empty() {
            return Ok(guard.clone());
        }
        let mut next = guard.clone();
        let mut by_folder = folder_positions(&next);
        for skin in scanned {
            let key = folder_key(&skin.folder);
            match by_folder.get(&key) {
                Some(&i) => next[i] = refresh(&next[i], skin),
                None => {
                    by_folder.insert(key, next.len());
                    next.push(HangarSkin { id: new_id(), ..skin });
                }
            }
        }
        write_atomic(&self.path, &next)?;
        *guard = next.clone();
        Ok(next)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<HangarSkin>> {
        self.skins.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A skin already in the index, updated with what is on disk now: the index keeps id, name,
/// origin, author, install date, source, active and temporary; the disk wins for the folder's
/// spelling, the vehicle, the size and the attention list.
pub fn refresh(indexed: &HangarSkin, scanned: HangarSkin) -> HangarSkin {
    HangarSkin {
        id: indexed.id.clone(),
        name: indexed.name.clone(),
        origin: indexed.origin,
        author: indexed.author.clone(),
        active: indexed.active,
        installed_at: indexed.installed_at.clone(),
        source_id: indexed.source_id.clone(),
        temporary: indexed.temporary,
        ..scanned
    }
}

/// A new stable id: `s-<hex nanoseconds since 1970>-<process counter>`.
pub fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("s-{nanos:x}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
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

fn read_index(path: &Path) -> Vec<HangarSkin> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            tracing::warn!(error = %e, "cannot read the library index; starting empty");
            tracing::debug!(path = %path.display(), "library index");
            return Vec::new();
        }
    };
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let index: IndexIn = match serde_json::from_slice(text) {
        Ok(index) => index,
        Err(e) => {
            tracing::warn!(error = %e, "library index is corrupt; set aside as library.json.bad");
            let _ = fs::rename(path, bad_path(path));
            return Vec::new();
        }
    };
    if index.version > INDEX_VERSION {
        tracing::warn!(version = index.version, "library index was written by a newer Livery");
    }
    let total = index.skins.len();
    let skins: Vec<HangarSkin> =
        index.skins.into_iter().filter_map(|value| serde_json::from_value::<HangarSkin>(value).ok()).collect();
    if skins.len() < total {
        tracing::warn!(
            dropped = total - skins.len(),
            "library index has unreadable entries; copy kept as library.json.bad"
        );
        let _ = fs::copy(path, bad_path(path));
    }
    skins
}

fn bad_path(path: &Path) -> PathBuf {
    path.with_extension("json.bad")
}

/// Write to a sibling temp file, then rename over the target (replaces on Windows too).
fn write_atomic(path: &Path, skins: &[HangarSkin]) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&IndexOut { version: INDEX_VERSION, skins })?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}
