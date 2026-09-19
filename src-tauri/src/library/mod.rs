//! Library (M2 import, M3 hangar): scans `UserSkins` with attention rules, keeps the index of
//! installed skins, and (M3) active/inactive, delete with backup, restore, export, collections.
//!
//! The work lives in plain functions (`scan_game`, `import_folders`, `ops::*`,
//! `collections::*`, `crate::backup::*`) so it is testable without a running app; the commands
//! only gather their inputs and hop onto a blocking thread. Where folders live on disk (active,
//! inactive, backups) is described in `layout`.

pub mod blk;
pub mod collections;
pub mod index;
pub mod layout;
pub mod ops;
pub mod scan;
pub mod time;
pub mod vehicles;

pub use index::LibraryStore;

use crate::backup;
use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::root;
use crate::model::{DeleteResult, ExportResult, HangarSkin, Settings};
use crate::settings::SettingsStore;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

/// Message of the `invalidInput` error returned while no game folder is saved.
pub const NO_GAME_FOLDER: &str = "No game folder set";

/// `<gameRoot>/UserSkins` from the saved settings.
pub fn user_skins_dir(settings: &Settings) -> AppResult<PathBuf> {
    let saved = settings.game_path.as_deref().map(str::trim).filter(|p| !p.is_empty());
    let Some(saved) = saved else {
        return Err(AppError::new(ErrorCode::InvalidInput, NO_GAME_FOLDER));
    };
    let game_root = root::native_path(saved);
    if !game_root.is_dir() {
        return Err(AppError::new(ErrorCode::NotFound, "The game folder can't be found").with_detail(saved));
    }
    Ok(root::user_skins_dir(&game_root))
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

/// Purges expired backups (see `crate::backup::purge`) when a game folder is set, sparing the
/// ids in `keep`. Best effort: failures are logged, never returned. Every library command calls
/// this first.
pub fn purge_expired(app: &AppHandle, keep: &[String]) {
    let settings = app.state::<SettingsStore>().get();
    let Ok(user_skins) = user_skins_dir(&settings) else { return };
    if let Err(e) =
        backup::purge(&user_skins, &app.state::<LibraryStore>(), SystemTime::now(), settings.backup_days, keep)
    {
        tracing::warn!(error = %e, "expired backups could not be purged");
    }
}

/// Settings and `UserSkins` for a command that works on skin folders, after the purge.
fn prepare(app: &AppHandle, keep: &[String]) -> AppResult<(Settings, PathBuf)> {
    purge_expired(app, keep);
    let settings = app.state::<SettingsStore>().get();
    let user_skins = user_skins_dir(&settings)?;
    Ok((settings, user_skins))
}

/// Full rescan of `UserSkins` with attention checks; refreshes and prunes the index ("Re-check").
#[tauri::command]
pub async fn scan_user_skins(app: AppHandle) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        let (_, user_skins) = prepare(&app, &[])?;
        scan_game(&user_skins, &app.state::<LibraryStore>())
    })
    .await
}

/// Adds `UserSkins` folders (by name) to the library index; returns the whole index.
#[tauri::command]
pub async fn import_skins(app: AppHandle, folders: Vec<String>) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        let (_, user_skins) = prepare(&app, &[])?;
        import_folders(&user_skins, &app.state::<LibraryStore>(), &folders)
    })
    .await
}

/// The library index (after purging expired backups; the skin folders are not re-read).
#[tauri::command]
pub async fn get_hangar(app: AppHandle) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        purge_expired(&app, &[]);
        Ok(app.state::<LibraryStore>().all())
    })
    .await
}

/// Moves skins in or out of the game's view; returns the whole index. A name clash at the
/// destination skips that skin and ends in a `conflict` error listing the folders.
#[tauri::command]
pub async fn set_skin_active(app: AppHandle, ids: Vec<String>, active: bool) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        let (_, user_skins) = prepare(&app, &[])?;
        ops::set_active(&user_skins, &app.state::<LibraryStore>(), &ids, active)
    })
    .await
}

/// Deletes skins, keeping a backup of each so the delete can be undone (ephemeral when backups
/// are off in Settings).
#[tauri::command]
pub async fn delete_skins(app: AppHandle, ids: Vec<String>) -> AppResult<DeleteResult> {
    blocking(move || {
        let (settings, user_skins) = prepare(&app, &[])?;
        ops::delete(&user_skins, &app.state::<LibraryStore>(), &ids, settings.backups, SystemTime::now())
    })
    .await
}

/// Puts backed-up skins back where they were (Undo); returns the restored skins.
#[tauri::command]
pub async fn restore_backups(app: AppHandle, backup_ids: Vec<String>) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        // An Undo in progress must not lose its backups to the purge that runs first.
        let (_, user_skins) = prepare(&app, &backup_ids)?;
        ops::restore(&user_skins, &app.state::<LibraryStore>(), &backup_ids)
    })
    .await
}

/// Copies skin folders into `dest` (a folder the user picked).
#[tauri::command]
pub async fn export_skins(app: AppHandle, ids: Vec<String>, dest: String) -> AppResult<ExportResult> {
    blocking(move || {
        let (_, user_skins) = prepare(&app, &[])?;
        ops::export(&user_skins, &app.state::<LibraryStore>(), &ids, &root::native_path(&dest))
    })
    .await
}
