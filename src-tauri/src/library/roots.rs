//! One library index per game root. Skins, collections and backups belong to the `UserSkins`
//! they live in, so changing the game folder (Settings → Game → Change) must not show the
//! previous folder's skins.
//!
//! Each root's index is `<appData>/library/<key>.json`, where `<key>` is [`root_key`]: 16 hex
//! digits of a stable hash (FNV-1a, 64 bit) of the root's path key (native separators, no
//! trailing separator, lower-cased on Windows, as `game::root::path_key` compares paths). The
//! file also records `gameRoot` for people reading it. [`Libraries`] (managed by the app) loads
//! each index the first time its root is asked for and keeps it for the session; a missing file
//! is an empty index, a corrupt one is set aside as `<key>.json.bad` (see [`LibraryStore::load`]).
//!
//! Commands resolve the settings once and take the `UserSkins` and the index of that same root
//! ([`super::GameLibrary`]), so a command that runs while the game folder changes still works
//! on one root from start to end.
//!
//! **Migration.** Before per-root files, the one index was `<appData>/library.json`. It is moved
//! (renamed) to the first root asked for while the `library` folder holds no index yet: at
//! launch that is the saved game folder; with none saved, the one the user picks next. It is
//! never migrated a second time, so another root never inherits it.

use super::index::LibraryStore;
use crate::game::root;
use crate::model::Settings;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

/// Folder inside the app data dir that holds one index per game root.
pub const LIBRARY_DIR: &str = "library";

/// The single index of builds before per-root indexes, inside the app data dir.
pub const LEGACY_INDEX: &str = "library.json";

/// The library indexes of every game root seen this session.
pub struct Libraries {
    dir: PathBuf,
    legacy: PathBuf,
    loaded: Mutex<HashMap<String, Arc<LibraryStore>>>,
}

impl Libraries {
    /// The app's indexes: `<data_dir>/library/<key>.json`, migrating `<data_dir>/library.json`.
    pub fn new(data_dir: &Path) -> Self {
        Self::with_paths(data_dir.join(LIBRARY_DIR), data_dir.join(LEGACY_INDEX))
    }

    /// Indexes in `dir`, migrating the single index at `legacy`.
    pub fn with_paths(dir: PathBuf, legacy: PathBuf) -> Self {
        Self { dir, legacy, loaded: Mutex::new(HashMap::new()) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where the index of `game_root` lives (whether or not it exists yet).
    pub fn index_path(&self, game_root: &Path) -> PathBuf {
        self.dir.join(format!("{}.json", root_key(game_root)))
    }

    /// The index of `game_root`: the same store for the whole session, loaded (tolerantly, and
    /// migrating the legacy index when due) the first time the root is asked for. Two spellings
    /// of one folder (case on Windows, a trailing separator) share an index.
    pub fn for_root(&self, game_root: &Path) -> Arc<LibraryStore> {
        let key = root::path_key(game_root);
        let mut loaded = self.lock();
        if let Some(store) = loaded.get(&key) {
            return Arc::clone(store);
        }
        let path = self.index_path(game_root);
        self.migrate_legacy(&path);
        let store = Arc::new(LibraryStore::load_for_root(path, root::display_path(game_root)));
        tracing::info!(skins = store.all().len(), "library index loaded for the game folder");
        loaded.insert(key, Arc::clone(&store));
        store
    }

    /// The index of the game folder saved in `settings`; `None` while none is saved. The folder
    /// doesn't have to exist (an unplugged drive still shows its index).
    pub fn for_settings(&self, settings: &Settings) -> Option<Arc<LibraryStore>> {
        saved_root(settings).map(|game_root| self.for_root(&game_root))
    }

    /// Moves the legacy `library.json` to `path` when this is the first index ever made: `path`
    /// doesn't exist and the library folder holds no other index. A rename first (atomic, same
    /// folder tree); if that fails, a copy, and the legacy file is renamed `library.json.migrated`
    /// so it isn't migrated again. Failures are logged: the index then starts empty.
    fn migrate_legacy(&self, path: &Path) {
        if path.exists() || !self.legacy.is_file() || self.holds_an_index() {
            return;
        }
        if let Err(e) = fs::create_dir_all(&self.dir) {
            tracing::warn!(error = %e, "cannot create the library folder; the legacy index stays where it is");
            return;
        }
        match fs::rename(&self.legacy, path) {
            Ok(()) => tracing::info!("library.json migrated to the game folder's index"),
            Err(rename) => match fs::copy(&self.legacy, path) {
                Ok(_) => {
                    tracing::info!(error = %rename, "library.json copied to the game folder's index");
                    if let Err(e) = fs::rename(&self.legacy, self.legacy.with_extension("json.migrated")) {
                        tracing::warn!(error = %e, "migrated library.json can't be renamed; it is left as it is");
                    }
                }
                Err(e) => tracing::warn!(error = %e, "library.json can't be migrated; the index starts empty"),
            },
        }
    }

    /// Whether the library folder already holds a per-root index (`*.json`).
    fn holds_an_index(&self) -> bool {
        let Ok(entries) = fs::read_dir(&self.dir) else { return false };
        entries.filter_map(Result::ok).any(|e| {
            let path = e.path();
            path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("json")) && path.is_file()
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<LibraryStore>>> {
        self.loaded.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The game root saved in `settings` in native form; `None` when none is saved.
pub fn saved_root(settings: &Settings) -> Option<PathBuf> {
    settings.game_path.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(root::native_path)
}

/// The file stem of `game_root`'s index: FNV-1a (64 bit) of its path key, as 16 lower-case hex
/// digits. Stable across Rust versions and machines (std's hasher isn't).
pub fn root_key(game_root: &Path) -> String {
    format!("{:016x}", fnv1a64(root::path_key(game_root).as_bytes()))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes.iter().fold(OFFSET, |hash, &b| (hash ^ u64::from(b)).wrapping_mul(PRIME))
}

#[cfg(test)]
mod tests {
    use super::fnv1a64;

    #[test]
    fn fnv1a_matches_the_reference_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    }
}
