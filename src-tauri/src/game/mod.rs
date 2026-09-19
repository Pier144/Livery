//! Game detection (M2): Steam `libraryfolders.vdf` (appid 236390), standalone launcher paths,
//! custom folder; validates the root (`UserSkins/`, `launcher.exe`, `aces.exe` or `win64/aces.exe`),
//! reads the version from `content/pkg_main.ver` and counts existing skins.
//! Emits `game://detect` per source.
//!
//! The logic lives in plain functions (`detect`, `apply_game_path`) so it is testable without a
//! running app; the commands only gather the real inputs and hop onto a blocking thread.

pub mod root;
pub mod steam;

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

#[tauri::command]
pub async fn set_game_path(app: AppHandle, path: String, source: Option<GameSource>) -> AppResult<GameDetection> {
    blocking(move || apply_game_path(&app.state::<SettingsStore>(), &path, source)).await
}
