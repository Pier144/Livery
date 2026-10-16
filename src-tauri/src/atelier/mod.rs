//! Atelier, the skin editor: the vehicle's model and template textures read from the game's packs
//! (`game::gameres`), the projects (`project`) and the apply to the game (`apply`).
//!
//! Binary payloads travel as raw bytes: `tauri::ipc::Response` out, raw request bodies in.
//! Reading the packs may wait on the Oodle worker process, so every command works in
//! `crate::blocking`.

pub mod project;

use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::binblk::Blk;
use crate::game::gameres::assemble::{self, VehicleModel};
use crate::game::gameres::index::IndexStore;
use crate::game::gameres::{desc, TEXTURE_NOT_FOUND};
use crate::game::root;
use crate::model::{AtelierProject, AtelierProjectSummary, AtelierSlotChoice, Settings};
use crate::settings::SettingsStore;
use project::{is_slot_name, ProjectStore, PROJECT_NOT_FOUND, PROJECT_THUMB_INVALID};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

/// `invalidInput` while Settings → Game → Read data from the game is off: Atelier opens no pack.
pub const ATELIER_NEEDS_GAME_DATA: &str = "Atelier needs Read data from the game turned on";

/// Sub-folder of the app data folder that holds Atelier's files.
pub const ATELIER_DIR: &str = "atelier";

/// File name of the game-resource index cache inside [`ATELIER_DIR`].
pub const INDEX_CACHE: &str = "gameres-index.json";

/// Models kept in memory (the open project's and the one before).
const MODELS_KEPT: usize = 2;

/// Atelier's state, managed by Tauri.
pub struct AtelierState {
    index: IndexStore,
    /// Most recently used last; key from [`model_key`].
    models: Mutex<Vec<(String, Arc<VehicleModel>)>>,
    /// `dynModelDesc.bin` of one game folder and version (key from [`desc_key`]).
    desc: Mutex<Option<(String, Arc<Blk>)>>,
    /// Held while a model is read, so two calls for the same vehicle read it once.
    loading: Mutex<()>,
    projects: ProjectStore,
}

fn desc_key(game_root: &Path, version: &str) -> String {
    format!("{}\n{version}", root::path_key(game_root))
}

fn model_key(game_root: &Path, version: &str, vehicle: &str) -> String {
    format!("{}\n{vehicle}", desc_key(game_root, version))
}

impl AtelierState {
    /// State keeping its files in `atelier_dir` (`<app data>/atelier`).
    pub fn new(atelier_dir: &Path) -> Self {
        Self {
            index: IndexStore::new(atelier_dir.join(INDEX_CACHE)),
            models: Mutex::new(Vec::new()),
            desc: Mutex::new(None),
            loading: Mutex::new(()),
            projects: ProjectStore::new(atelier_dir),
        }
    }

    pub fn projects(&self) -> &ProjectStore {
        &self.projects
    }

    /// `vehicle`'s paintable model in `game_root`, read once per game version and kept for the
    /// last [`MODELS_KEPT`] vehicles. Blocking (may wait on the Oodle worker).
    pub fn model(&self, game_root: &Path, vehicle: &str) -> AppResult<Arc<VehicleModel>> {
        let index = self.index.get(game_root)?;
        let key = model_key(game_root, &index.version, vehicle);
        if let Some(model) = self.cached(&key) {
            return Ok(model);
        }
        let _loading = self.loading.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(model) = self.cached(&key) {
            return Ok(model);
        }
        let desc = self.desc(game_root, &index.version)?;
        let model = Arc::new(assemble::load(game_root, &index, &desc, vehicle)?);
        let mut models = self.models.lock().unwrap_or_else(|e| e.into_inner());
        models.push((key, Arc::clone(&model)));
        let extra = models.len().saturating_sub(MODELS_KEPT);
        models.drain(..extra);
        Ok(model)
    }

    /// The template (RGBA8) of `vehicle`'s slot `slot` (a `_c` texture name of its model, any
    /// case). Blocking.
    pub fn template(&self, game_root: &Path, vehicle: &str, slot: &str) -> AppResult<Vec<u8>> {
        let model = self.model(game_root, vehicle)?;
        let slot = model
            .slots
            .iter()
            .find(|s| s.texture.eq_ignore_ascii_case(slot))
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, TEXTURE_NOT_FOUND).with_detail(slot.to_owned()))?;
        let index = self.index.get(game_root)?;
        assemble::template_texture(game_root, &index, slot)
    }

    /// The cached model under `key`, marked as the most recently used.
    fn cached(&self, key: &str) -> Option<Arc<VehicleModel>> {
        let mut models = self.models.lock().unwrap_or_else(|e| e.into_inner());
        let pos = models.iter().position(|(k, _)| k == key)?;
        let entry = models.remove(pos);
        let model = Arc::clone(&entry.1);
        models.push(entry);
        Some(model)
    }

    fn desc(&self, game_root: &Path, version: &str) -> AppResult<Arc<Blk>> {
        let key = desc_key(game_root, version);
        let mut desc = self.desc.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, blk)) = desc.as_ref().filter(|(k, _)| *k == key) {
            return Ok(Arc::clone(blk));
        }
        let blk = Arc::new(desc::read(game_root)?);
        *desc = Some((key, Arc::clone(&blk)));
        Ok(blk)
    }
}

/// The game folder Atelier reads: `invalidInput` ([`ATELIER_NEEDS_GAME_DATA`]) while reading the
/// game's data is off, else `library::game_root`'s errors.
pub fn atelier_game_root(settings: &Settings) -> AppResult<PathBuf> {
    if !settings.read_game_data {
        return Err(AppError::new(ErrorCode::InvalidInput, ATELIER_NEEDS_GAME_DATA));
    }
    crate::library::game_root(settings)
}

/// [`atelier_game_root`] with the app's settings.
fn game_root_for_atelier(app: &AppHandle) -> AppResult<PathBuf> {
    atelier_game_root(&app.state::<SettingsStore>().get())
}

/// The vehicle's model as the binary `assemble::encode` documents (header JSON with the slots,
/// then the vertex and index arrays).
#[tauri::command]
pub async fn atelier_model(app: AppHandle, vehicle: String) -> AppResult<Response> {
    blocking(move || {
        let game_root = game_root_for_atelier(&app)?;
        let model = app.state::<AtelierState>().model(&game_root, &vehicle)?;
        Ok(Response::new(assemble::encode(&model)))
    })
    .await
}

/// The original texture of one of the vehicle's slots, RGBA8 (its size is in the model's header).
#[tauri::command]
pub async fn atelier_template_texture(app: AppHandle, vehicle: String, slot: String) -> AppResult<Response> {
    blocking(move || {
        let game_root = game_root_for_atelier(&app)?;
        let rgba = app.state::<AtelierState>().template(&game_root, &vehicle, &slot)?;
        Ok(Response::new(rgba))
    })
    .await
}

// ── Projects ────────────────────────────────────────────────────────────────

/// Empties the project trash left by the last session, off the main thread.
pub fn purge_on_startup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let removed = app.state::<AtelierState>().projects().purge_trash();
        if removed > 0 {
            tracing::info!(removed, "Atelier project trash emptied");
        }
    });
}

/// A header of a raw request as text (`None` when missing or not visible ASCII).
fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

/// The body of a raw request (`None` for a JSON one), copied out of the request.
fn raw_body(request: &Request<'_>) -> Option<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Some(bytes.clone()),
        InvokeBody::Json(_) => None,
    }
}

/// The project choices for `vehicle`'s slots: each one the model lists, on when it is the
/// vehicle's own texture (`paintableByDefault`).
fn slot_choices(model: &VehicleModel) -> Vec<AtelierSlotChoice> {
    model
        .slots
        .iter()
        .filter(|s| {
            let ok = is_slot_name(&s.texture);
            if !ok {
                tracing::warn!(texture = %s.texture, "Atelier slot left out: not a safe texture name");
            }
            ok
        })
        .map(|s| AtelierSlotChoice { texture: s.texture.clone(), enabled: s.paintable_by_default })
        .collect()
}

#[tauri::command]
pub async fn atelier_projects(app: AppHandle) -> AppResult<Vec<AtelierProjectSummary>> {
    blocking(move || app.state::<AtelierState>().projects().list()).await
}

/// A new project for `vehicle`, with its slots read from the vehicle's model.
#[tauri::command]
pub async fn atelier_project_create(app: AppHandle, name: String, vehicle: String) -> AppResult<AtelierProject> {
    blocking(move || {
        let game_root = game_root_for_atelier(&app)?;
        let state = app.state::<AtelierState>();
        let model = state.model(&game_root, &vehicle)?;
        state.projects().create(&name, &vehicle, slot_choices(&model), SystemTime::now())
    })
    .await
}

#[tauri::command]
pub async fn atelier_project_get(app: AppHandle, id: String) -> AppResult<AtelierProject> {
    blocking(move || app.state::<AtelierState>().projects().get(&id)).await
}

#[tauri::command]
pub async fn atelier_project_save(app: AppHandle, project: AtelierProject) -> AppResult<AtelierProject> {
    blocking(move || app.state::<AtelierState>().projects().save(&project, SystemTime::now())).await
}

#[tauri::command]
pub async fn atelier_project_duplicate(app: AppHandle, id: String) -> AppResult<AtelierProject> {
    blocking(move || app.state::<AtelierState>().projects().duplicate(&id, SystemTime::now())).await
}

/// Moves the project to the trash; the toast's Undo calls `atelier_project_undo_delete`, its
/// closing `atelier_project_forget_deleted`.
#[tauri::command]
pub async fn atelier_project_delete(app: AppHandle, id: String) -> AppResult<()> {
    blocking(move || app.state::<AtelierState>().projects().delete(&id)).await
}

#[tauri::command]
pub async fn atelier_project_undo_delete(app: AppHandle, id: String) -> AppResult<()> {
    blocking(move || app.state::<AtelierState>().projects().undo_delete(&id)).await
}

#[tauri::command]
pub async fn atelier_project_forget_deleted(app: AppHandle, id: String) -> AppResult<()> {
    blocking(move || app.state::<AtelierState>().projects().forget_deleted(&id)).await
}

/// Stores a project's thumbnail: the PNG as the raw request body, the project id in the
/// `x-project-id` header.
#[tauri::command]
pub async fn atelier_project_thumb(app: AppHandle, request: Request<'_>) -> AppResult<()> {
    let id = header(&request, "x-project-id")
        .map(str::to_owned)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, PROJECT_NOT_FOUND).with_detail("no x-project-id header"))?;
    let png = raw_body(&request).ok_or_else(|| {
        AppError::new(ErrorCode::InvalidInput, PROJECT_THUMB_INVALID).with_detail("not a raw request body")
    })?;
    blocking(move || app.state::<AtelierState>().projects().set_thumb(&id, &png)).await
}

/// A project's thumbnail (PNG bytes; empty when it has none).
#[tauri::command]
pub async fn atelier_project_thumb_get(app: AppHandle, id: String) -> AppResult<Response> {
    blocking(move || app.state::<AtelierState>().projects().thumb(&id).map(Response::new)).await
}
