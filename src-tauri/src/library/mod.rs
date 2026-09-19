//! Library (M2 import, M3 hangar): scans `UserSkins` with attention rules, keeps the index of
//! installed skins, and (M3) active/inactive, delete with backup, restore, export, collections.
//!
//! The work lives in plain functions (`scan_game`, `import_folders`) so it is testable without a
//! running app; the commands only gather their inputs and hop onto a blocking thread.

pub mod blk;
pub mod index;
pub mod scan;
pub mod time;
pub mod vehicles;

pub use index::LibraryStore;

use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::root;
use crate::model::{HangarSkin, Settings};
use crate::settings::SettingsStore;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
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

/// Every skin folder in `user_skins`, checked, as the hangar knows it: indexed skins keep their
/// id, origin, author and install date with fresh size, vehicle and attention; the others get a
/// `disk:<folder>` id. Doesn't change the index.
pub fn scan_game(user_skins: &Path, store: &LibraryStore) -> AppResult<Vec<HangarSkin>> {
    let scanned = scan::scan_dir(user_skins)?;
    let skins = store.merge_scan(scanned);
    let attention = skins.iter().filter(|s| !s.attention.is_empty()).count();
    tracing::info!(skins = skins.len(), attention, "UserSkins scanned");
    Ok(skins)
}

/// Scans the named folders of `user_skins` and adds them to the index (idempotent: a folder
/// already indexed is refreshed, not duplicated). Names match the folders on disk the way the
/// file system does (case-insensitively on Windows) and the on-disk spelling is stored.
/// Folders that no longer exist are skipped. Returns the whole index.
pub fn import_folders(user_skins: &Path, store: &LibraryStore, folders: &[String]) -> AppResult<Vec<HangarSkin>> {
    if let Some(bad) = folders.iter().find(|f| !is_folder_name(f)) {
        return Err(AppError::new(ErrorCode::InvalidInput, "Not a skin folder name").with_detail(bad.clone()));
    }
    let on_disk = folders_on_disk(user_skins)?;
    let scanned: Vec<HangarSkin> = folders
        .iter()
        .filter_map(|f| on_disk.get(&index::folder_key(f)))
        .filter_map(|actual| scan::scan_skin(&user_skins.join(actual)))
        .collect();
    if scanned.len() < folders.len() {
        tracing::warn!(requested = folders.len(), found = scanned.len(), "some skin folders to import are gone");
    }
    let found = scanned.len();
    let index = store.import(scanned)?;
    tracing::info!(imported = found, total = index.len(), "skins imported into the library");
    Ok(index)
}

/// Folder key → folder name as spelled on disk, for every entry of `user_skins`.
fn folders_on_disk(user_skins: &Path) -> AppResult<HashMap<String, String>> {
    let entries = match fs::read_dir(user_skins) {
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

/// A single folder name inside `UserSkins`: no separators, drive colon or `.`/`..`.
fn is_folder_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':', '\0'])
}

/// Full rescan of `UserSkins` with attention checks; also drives "Re-check".
#[tauri::command]
pub async fn scan_user_skins(app: AppHandle) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        let user_skins = user_skins_dir(&app.state::<SettingsStore>().get())?;
        scan_game(&user_skins, &app.state::<LibraryStore>())
    })
    .await
}

/// Adds `UserSkins` folders (by name) to the library index; returns the whole index.
#[tauri::command]
pub async fn import_skins(app: AppHandle, folders: Vec<String>) -> AppResult<Vec<HangarSkin>> {
    blocking(move || {
        let user_skins = user_skins_dir(&app.state::<SettingsStore>().get())?;
        import_folders(&user_skins, &app.state::<LibraryStore>(), &folders)
    })
    .await
}

/// The library index (no disk access).
#[tauri::command]
pub async fn get_hangar(app: AppHandle) -> AppResult<Vec<HangarSkin>> {
    Ok(app.state::<LibraryStore>().all())
}
