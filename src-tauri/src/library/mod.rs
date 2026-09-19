//! Library (M2 import, M3 hangar): scans `UserSkins` with attention rules, keeps the index of
//! installed skins, and (M3) active/inactive, delete with backup, restore, export, collections.
//! Each game root has its own index (`roots`): changing the game folder shows that folder's
//! skins, collections and backups.
//!
//! The work lives in plain functions (`scan_game`, `import_folders`, `ops::*`,
//! `collections::*`, `crate::backup::*`) so it is testable without a running app; the commands
//! only gather their inputs ([`GameLibrary`]) and hop onto a blocking thread. Where folders live
//! on disk (active, inactive, backups) is described in `layout`.

pub mod blk;
pub mod collections;
pub mod index;
pub mod layout;
pub mod ops;
pub mod roots;
pub mod scan;
pub mod time;
pub mod vehicles;

pub use index::LibraryStore;
pub use roots::{saved_root, Libraries};

use crate::backup;
use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::root;
use crate::model::{DeleteResult, ExportResult, HangarSkin, Settings};
use crate::settings::SettingsStore;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

/// Message of the `invalidInput` error returned while no game folder is saved.
pub const NO_GAME_FOLDER: &str = "No game folder set";

/// The saved game root, which must exist: `invalidInput` while none is saved, `notFound` when
/// it can't be found (an unplugged drive).
pub fn game_root(settings: &Settings) -> AppResult<PathBuf> {
    let Some(game_root) = saved_root(settings) else {
        return Err(AppError::new(ErrorCode::InvalidInput, NO_GAME_FOLDER));
    };
    if !game_root.is_dir() {
        return Err(AppError::new(ErrorCode::NotFound, "The game folder can't be found")
            .with_detail(root::display_path(&game_root)));
    }
    Ok(game_root)
}

/// `<gameRoot>/UserSkins` from the saved settings (see [`game_root`] for the errors).
pub fn user_skins_dir(settings: &Settings) -> AppResult<PathBuf> {
    game_root(settings).map(|game_root| root::user_skins_dir(&game_root))
}

/// What a command that works on skin folders needs, from one read of the settings: the
/// settings, the game folder's `UserSkins` and that same folder's library index.
pub struct GameLibrary {
    pub settings: Settings,
    pub user_skins: PathBuf,
    pub store: Arc<LibraryStore>,
}

impl GameLibrary {
    /// The saved game folder's `UserSkins` and index (errors of [`game_root`]).
    pub fn resolve(settings: Settings, libraries: &Libraries) -> AppResult<Self> {
        let game_root = game_root(&settings)?;
        let store = libraries.for_root(&game_root);
        Ok(Self { user_skins: root::user_skins_dir(&game_root), store, settings })
    }

    /// [`Self::resolve`] with the app's settings and indexes.
    pub fn current(app: &AppHandle) -> AppResult<Self> {
        Self::resolve(app.state::<SettingsStore>().get(), &app.state::<Libraries>())
    }
}

/// The index of the saved game folder (it doesn't have to exist); `None` while none is saved.
pub fn current_store(app: &AppHandle) -> Option<Arc<LibraryStore>> {
    app.state::<Libraries>().for_settings(&app.state::<SettingsStore>().get())
}

/// [`current_store`], required: `invalidInput` ([`NO_GAME_FOLDER`]) while no game folder is
/// saved, since collections and backups belong to a game folder's index.
pub fn required_store(app: &AppHandle) -> AppResult<Arc<LibraryStore>> {
    current_store(app).ok_or_else(|| AppError::new(ErrorCode::InvalidInput, NO_GAME_FOLDER))
}

/// Every skin folder on disk (active and inactive), checked, as the hangar knows it, with the
/// index refreshed and pruned along the way (see `ops::rescan`). Drives "Re-check".
pub fn scan_game(user_skins: &Path, store: &LibraryStore) -> AppResult<Vec<HangarSkin>> {
    ops::rescan(user_skins, store)
}

/// Scans the named skin folders and adds them to the index (idempotent: a folder already
/// indexed is refreshed, not duplicated). A name is looked up in `UserSkins` first, then in the
/// inactive folder; it matches the way the file system does (case-insensitively on Windows) and
/// the on-disk spelling is stored. Folders that no longer exist are skipped. Returns the whole
/// index.
pub fn import_folders(user_skins: &Path, store: &LibraryStore, folders: &[String]) -> AppResult<Vec<HangarSkin>> {
    if let Some(bad) = folders.iter().find(|f| !layout::is_folder_name(f)) {
        return Err(AppError::new(ErrorCode::InvalidInput, "Not a skin folder name").with_detail(bad.clone()));
    }
    let inactive = layout::inactive_dir(user_skins);
    let active_on_disk = folders_on_disk(user_skins)?;
    let inactive_on_disk = folders_on_disk(&inactive)?;
    let scanned: Vec<HangarSkin> = folders
        .iter()
        .filter_map(|f| {
            let key = index::folder_key(f);
            match active_on_disk.get(&key) {
                Some(actual) => scan::scan_skin(&user_skins.join(actual)),
                None => inactive_on_disk
                    .get(&key)
                    .and_then(|actual| scan::scan_skin(&inactive.join(actual)))
                    .map(scan::mark_inactive),
            }
        })
        .collect();
    if scanned.len() < folders.len() {
        tracing::warn!(requested = folders.len(), found = scanned.len(), "some skin folders to import are gone");
    }
    let found = scanned.len();
    let index = store.import(scanned)?;
    tracing::info!(imported = found, total = index.len(), "skins imported into the library");
    Ok(index)
}

/// Folder key → folder name as spelled on disk, for every entry of `dir` (none if it's missing).
fn folders_on_disk(dir: &Path) -> AppResult<HashMap<String, String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => {
            return Err(AppError::new(ErrorCode::Io, "Could not read the UserSkins folder").with_detail(e.to_string()))
        }
    };
    Ok(entries
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .map(|name| (index::folder_key(&name), name))
        .collect())
}

/// Purges expired backups of `library`'s game folder (see `crate::backup::purge`), sparing the
/// ids in `keep`. Best effort: failures are logged, never returned.
pub fn purge_in(library: &GameLibrary, keep: &[String]) {
    let GameLibrary { settings, user_skins, store } = library;
    if let Err(e) = backup::purge(user_skins, store, SystemTime::now(), settings.backup_days, keep) {
        tracing::warn!(error = %e, "expired backups could not be purged");
    }
}

/// [`purge_in`] the saved game folder, when one is set and can be found. Every library command
/// purges first.
pub fn purge_expired(app: &AppHandle, keep: &[String]) {
    if let Ok(library) = GameLibrary::current(app) {
        purge_in(&library, keep);
    }
}

/// The game folder a command that works on skin folders works on, after the purge.
fn prepare(app: &AppHandle, keep: &[String]) -> AppResult<GameLibrary> {
    let library = GameLibrary::current(app)?;
    purge_in(&library, keep);
    Ok(library)
}

/// Full rescan of `UserSkins` with attention checks; refreshes and prunes the index ("Re-check").
#[tauri::command]
pub async fn scan_user_skins(app: AppHandle) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        let library = prepare(&app, &[])?;
        scan_game(&library.user_skins, &library.store)
    })
    .await
}

/// Adds `UserSkins` folders (by name) to the library index; returns the whole index.
#[tauri::command]
pub async fn import_skins(app: AppHandle, folders: Vec<String>) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        let library = prepare(&app, &[])?;
        import_folders(&library.user_skins, &library.store, &folders)
    })
    .await
}

/// The saved game folder's library index (after purging expired backups; the skin folders are
/// not re-read). Empty while no game folder is saved.
#[tauri::command]
pub async fn get_hangar(app: AppHandle) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        purge_expired(&app, &[]);
        Ok(current_store(&app).map(|store| store.all()).unwrap_or_default())
    })
    .await
}

/// Moves skins in or out of the game's view; returns the whole index. A name clash at the
/// destination skips that skin and ends in a `conflict` error listing the folders.
#[tauri::command]
pub async fn set_skin_active(app: AppHandle, ids: Vec<String>, active: bool) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        let library = prepare(&app, &[])?;
        ops::set_active(&library.user_skins, &library.store, &ids, active)
    })
    .await
}

/// Deletes skins, keeping a backup of each so the delete can be undone (ephemeral when backups
/// are off in Settings).
#[tauri::command]
pub async fn delete_skins(app: AppHandle, ids: Vec<String>) -> AppResult<DeleteResult> {
    blocking(move || {
        let library = prepare(&app, &[])?;
        ops::delete(&library.user_skins, &library.store, &ids, library.settings.backups, SystemTime::now())
    })
    .await
}

/// Puts backed-up skins back where they were (Undo); returns the restored skins.
#[tauri::command]
pub async fn restore_backups(app: AppHandle, backup_ids: Vec<String>) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        // An Undo in progress must not lose its backups to the purge that runs first.
        let library = prepare(&app, &backup_ids)?;
        ops::restore(&library.user_skins, &library.store, &backup_ids)
    })
    .await
}

/// Copies skin folders into `dest` (a folder the user picked).
#[tauri::command]
pub async fn export_skins(app: AppHandle, ids: Vec<String>, dest: String) -> AppResult<ExportResult> {
    blocking(move || {
        let library = prepare(&app, &[])?;
        ops::export(&library.user_skins, &library.store, &ids, &root::native_path(&dest))
    })
    .await
}
