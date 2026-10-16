//! Game detection (M2): Steam `libraryfolders.vdf` (appid 236390), standalone launcher paths,
//! custom folder; validates the root (`UserSkins/`, `launcher.exe`, `aces.exe` or `win64/aces.exe`),
//! reads the version from `content/pkg_main.ver` and counts existing skins.
//! Emits `game://detect` per source.
//!
//! The logic lives in plain functions (`detect`, `apply_game_path`) so it is testable without a
//! running app; the commands only gather the real inputs and hop onto a blocking thread.
//!
//! [`catalog`] reads the game's vehicle list from the install's data archives ([`vromfs`],
//! [`binblk`]), read-only; `game_vehicles` hands it to the UI.
//!
//! [`gameres`] reads the game's model and texture packs for Atelier, read-only.
//!
//! [`profile`] reads the player's lineups from their War Thunder profile (`global.blk`),
//! read-only and only those two blocks; `game_lineups` hands them to the For you tab.

pub mod binblk;
pub mod catalog;
pub mod gameres;
pub mod profile;
pub mod root;
pub mod steam;
pub mod vromfs;
mod zstd_frame;

use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{DetectEvent, DetectState, GameDetection, GameSource, SettingsPatch};
use crate::settings::SettingsStore;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Event name for per-source detection progress (payload: `DetectEvent`).
pub const DETECT_EVENT: &str = "game://detect";

/// Message of the `invalidInput` error `set_game_path` returns for a folder that is not a game root.
pub const NOT_A_GAME_FOLDER: &str = "That folder doesn't look like a War Thunder install";

/// Everything detection looks at, gathered up front so `detect` stays pure and testable.
#[derive(Debug, Clone, Default)]
pub struct DetectInputs {
    /// Steam install folders (each holds `steamapps/libraryfolders.vdf`).
    pub steam_roots: Vec<PathBuf>,
    /// Standalone launcher locations, checked in order.
    pub standalone: Vec<PathBuf>,
    /// Folder saved in settings; `None` when the user never set one.
    pub custom: Option<PathBuf>,
}

impl DetectInputs {
    /// Real inputs: registry / default Steam folders, standalone paths from the environment,
    /// and the game path saved in settings.
    pub fn from_system(saved_path: Option<&str>) -> Self {
        Self {
            steam_roots: steam::system_steam_roots(),
            standalone: root::standalone_candidates(|name| std::env::var_os(name)),
            custom: saved_path.map(str::trim).filter(|p| !p.is_empty()).map(root::native_path),
        }
    }
}

/// Checks Steam, the standalone launcher and the custom folder, in that order. For each source
/// `emit` receives `checking` then `found`/`notFound`; a missing custom folder emits only
/// `skipped`. Every source is checked (the First run screen shows each row's outcome) and the
/// result prefers Steam, then standalone, then custom.
pub fn detect(inputs: &DetectInputs, mut emit: impl FnMut(DetectEvent)) -> GameDetection {
    let steam = check(GameSource::Steam, &mut emit, || {
        steam::war_thunder_candidates(&inputs.steam_roots).into_iter().find(|p| root::is_game_root(p))
    });
    let standalone =
        check(GameSource::Standalone, &mut emit, || inputs.standalone.iter().find(|p| root::is_game_root(p)).cloned());
    let custom = match &inputs.custom {
        Some(saved) => check(GameSource::Custom, &mut emit, || root::normalize_root(saved)),
        None => {
            emit(DetectEvent { source: GameSource::Custom, state: DetectState::Skipped });
            None
        }
    };

    let found = [(GameSource::Steam, steam), (GameSource::Standalone, standalone), (GameSource::Custom, custom)]
        .into_iter()
        .find_map(|(source, path)| path.map(|p| (source, p)));
    match found {
        Some((source, path)) => {
            let detection = describe(source, &path);
            tracing::info!(?source, version = ?detection.version, skins = detection.existing_skins, "War Thunder found");
            tracing::debug!(path = %path.display(), "game root");
            detection
        }
        None => {
            tracing::info!("War Thunder not found");
            GameDetection::not_found()
        }
    }
}

fn check(
    source: GameSource,
    emit: &mut impl FnMut(DetectEvent),
    find: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    emit(DetectEvent { source, state: DetectState::Checking });
    let found = find();
    let state = if found.is_some() { DetectState::Found } else { DetectState::NotFound };
    emit(DetectEvent { source, state });
    found
}

/// The detection result for a validated root.
pub fn describe(source: GameSource, root: &Path) -> GameDetection {
    GameDetection {
        found: true,
        source: Some(source),
        path: Some(root::display_path(root)),
        version: root::read_version(root),
        existing_skins: root::count_skins(root),
    }
}

/// Normalises and validates a folder the user chose, then creates `UserSkins/` if missing.
/// Called only once the user confirms the folder, so this is the one write detection makes.
pub fn prepare_game_root(path: &str) -> AppResult<PathBuf> {
    let cleaned = path.trim().trim_matches('"').trim();
    let invalid = || AppError::new(ErrorCode::InvalidInput, NOT_A_GAME_FOLDER).with_detail(path);
    if cleaned.is_empty() {
        return Err(invalid());
    }
    let root = root::normalize_root(Path::new(cleaned)).ok_or_else(invalid)?;
    let skins = root::user_skins_dir(&root);
    if !skins.is_dir() {
        fs::create_dir(&skins).map_err(|e| {
            AppError::new(ErrorCode::Io, "Could not create the UserSkins folder")
                .with_detail(format!("{}: {e}", skins.display()))
        })?;
        tracing::info!("created UserSkins");
    }
    Ok(root)
}

/// `set_game_path` without the app: validate + prepare the folder, persist it with its source
/// (default `custom`) and version, and return what was found there.
pub fn apply_game_path(store: &SettingsStore, path: &str, source: Option<GameSource>) -> AppResult<GameDetection> {
    let root = prepare_game_root(path)?;
    let source = source.unwrap_or(GameSource::Custom);
    let detection = describe(source, &root);
    store.update(SettingsPatch {
        game_path: detection.path.clone(),
        game_source: Some(source),
        // Always overwrite: a root without a readable version clears the old one.
        game_version: Some(detection.version.clone()),
        ..Default::default()
    })?;
    tracing::info!(?source, version = ?detection.version, skins = detection.existing_skins, "game folder set");
    tracing::debug!(path = ?detection.path, "game root");
    Ok(detection)
}

#[tauri::command]
pub async fn detect_game(app: AppHandle) -> AppResult<GameDetection> {
    blocking(move || {
        let saved = app.state::<SettingsStore>().get().game_path;
        let inputs = DetectInputs::from_system(saved.as_deref());
        Ok(detect(&inputs, |event| {
            if let Err(e) = app.emit(DETECT_EVENT, event) {
                tracing::warn!(error = %e, "could not emit {DETECT_EVENT}");
            }
        }))
    })
    .await
}

/// Saves the game folder. From then on the library works on that folder's own index (loaded
/// now; skins, collections and backups of the previous folder stay in its index), the install
/// queue checks clashes against it, and the watcher looks at its `UserSkins` from the next poll.
#[tauri::command]
pub async fn set_game_path(app: AppHandle, path: String, source: Option<GameSource>) -> AppResult<GameDetection> {
    blocking(move || {
        let detection = apply_game_path(&app.state::<SettingsStore>(), &path, source)?;
        crate::archive::follow_game_root(&app);
        crate::library::purge_expired(&app, &[]);
        load_vehicles_in_background(&app);
        Ok(detection)
    })
    .await
}

/// The vehicle list of the saved game folder ([`catalog`]): every vehicle of the game, read
/// from its data files (or the cached copy). Empty when no game folder is saved or the files
/// can't be read; the UI then keeps its built-in list.
#[tauri::command]
pub async fn game_vehicles(app: AppHandle) -> AppResult<Vec<crate::model::Vehicle>> {
    blocking(move || Ok(current_vehicles(&app).map(|list| list.as_ref().clone()).unwrap_or_default())).await
}

/// The names of [`game_vehicles`]' vehicles in `language`, code → name, only where they differ
/// from the English `Vehicle.name` (the UI falls back to it). Empty for English, without a game
/// folder, when reading the game's files is off, or when they can't be read.
#[tauri::command]
pub async fn game_vehicle_names(
    app: AppHandle,
    language: crate::model::Language,
) -> AppResult<std::collections::HashMap<String, String>> {
    blocking(move || {
        let settings = app.state::<SettingsStore>().get();
        if !settings.read_game_data {
            return Ok(Default::default());
        }
        let Ok(root) = crate::library::game_root(&settings) else { return Ok(Default::default()) };
        Ok(app.state::<catalog::CatalogStore>().names_for(&root, language).unwrap_or_default())
    })
    .await
}

/// For you: the lineups in the player's War Thunder profile (see [`profile`]). Local; `off`
/// without touching the disk when reading the game's data is off in Settings.
#[tauri::command]
pub async fn game_lineups(app: AppHandle) -> AppResult<crate::model::Lineups> {
    blocking(move || {
        let on = app.state::<SettingsStore>().get().read_game_data;
        app.state::<profile::ProfileStore>()
            .lineups(on, || profile::system_documents_dir().and_then(|d| profile::profile_file(&d)))
    })
    .await
}

/// The saved game folder's vehicle list (see [`catalog::CatalogStore::load`]); waits for a read
/// in progress. WT Live calls go through it first, so posts are matched against the game's list
/// even right after launch. Blocking.
pub fn current_vehicles(app: &AppHandle) -> Option<std::sync::Arc<Vec<crate::model::Vehicle>>> {
    let settings = app.state::<SettingsStore>().get();
    // Off in Settings → Game: the game's archives are never opened; the built-in list stays.
    if !settings.read_game_data {
        return None;
    }
    let root = crate::library::game_root(&settings).ok()?;
    app.state::<catalog::CatalogStore>().load(&root)
}

/// Settings → Game → Read the vehicle list changed: off goes back to the built-in list at once,
/// on reads the game's list again in the background.
pub fn read_game_data_changed(app: &AppHandle, on: bool) {
    app.state::<catalog::CatalogStore>().forget();
    if on {
        load_vehicles_in_background(app);
    } else {
        crate::library::vehicles::reset_to_seed();
        tracing::info!("vehicle list: built-in (reading the game's data is off)");
    }
}

/// Reads (or loads the cached) vehicle list off the main thread, so lookups use it as soon as
/// possible: at launch and after the game folder changes.
pub fn load_vehicles_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        current_vehicles(&app);
    });
}
