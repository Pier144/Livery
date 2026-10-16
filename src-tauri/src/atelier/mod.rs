//! Atelier, the skin editor: the vehicle's model and template textures read from the game's packs
//! (`game::gameres`), the projects (`project`) and their pictures (`assets`), the installed fonts
//! (`fonts`), background removal (`cutout`, with its files from `models`, `download`, `sha256`)
//! and the apply to the game (`apply`).
//!
//! Binary payloads travel as raw bytes: `tauri::ipc::Response` out, raw request bodies in.
//! Reading the packs may wait on the Oodle worker process, so every command works in
//! `crate::blocking`.

pub mod apply;
pub mod assets;
pub mod cutout;
pub mod download;
pub mod fonts;
pub mod models;
pub mod project;
pub mod sha256;

use crate::archive::generated::Target;
use crate::archive::QueueStore;
use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::binblk::Blk;
use crate::game::gameres::assemble::{self, VehicleModel};
use crate::game::gameres::index::IndexStore;
use crate::game::gameres::{desc, TEXTURE_NOT_FOUND};
use crate::game::root;
use crate::library::GameLibrary;
use crate::model::{
    ApplyProgress, ApplyResult, ApplyStarted, ApplyStep, AssetRef, AtelierProject, AtelierProjectSummary,
    AtelierSlotChoice, CutoutProgress, CutoutResult, CutoutStatus, CutoutStep, DownloadProgress, FontInfo, Settings,
};
use crate::settings::SettingsStore;
use crate::textures::bc::APPLY_BAD_TEXTURE;
use apply::{APPLY_BAD_SLOT, APPLY_NOT_FOUND, TEXTURES_PCT};
use assets::ASSET_INVALID;
use cutout::{Cutout, CUTOUT_NOT_READY};
use download::Downloader;
use models::{ModelFiles, CUTOUT_BUSY};
use project::{is_slot_name, ProjectStore, PROJECT_NOT_FOUND, PROJECT_THUMB_INVALID};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager};

/// `invalidInput` while Settings → Game → Read data from the game is off: Atelier opens no pack.
pub const ATELIER_NEEDS_GAME_DATA: &str = "Atelier needs Read data from the game turned on";

/// `invalidInput`: Settings → Experimental → Atelier is off (downloads refuse to start).
pub const ATELIER_DISABLED: &str = "Turn on Atelier in Settings first";

/// Progress of a background removal (payload `CutoutProgress`).
pub const CUTOUT_PROGRESS_EVENT: &str = "atelier://cutout-progress";

/// Progress of a background-removal file download (payload `DownloadProgress`).
pub const DOWNLOAD_PROGRESS_EVENT: &str = "atelier://download-progress";

/// Progress of Rust's steps of an apply (payload `ApplyProgress`).
pub const APPLY_PROGRESS_EVENT: &str = "atelier://apply-progress";

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
    applies: apply::Applies,
    /// Asset ids made in this process: the editor's history may still use them, so the asset GC
    /// keeps them even when no saved layer does.
    created_assets: Mutex<HashSet<String>>,
    /// Imports decoding at once (see `assets::MAX_CONCURRENT_IMPORTS`).
    imports: assets::Slots,
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
            applies: apply::Applies::default(),
            created_assets: Mutex::new(HashSet::new()),
            imports: assets::Slots::new(assets::MAX_CONCURRENT_IMPORTS),
        }
    }

    pub fn projects(&self) -> &ProjectStore {
        &self.projects
    }

    /// Drops the cached models and `dynModelDesc` (Atelier turned off): the memory goes back at
    /// once; the next use reads them again.
    pub fn forget(&self) {
        self.models.lock().unwrap_or_else(|e| e.into_inner()).clear();
        *self.desc.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Stores RGBA8 pixels as a new asset of project `project_id` and remembers its id for
    /// [`Self::collect_assets`]. The PNG is encoded first; only the write holds the project
    /// store's lock.
    pub fn put_asset(&self, project_id: &str, w: u32, h: u32, rgba: &[u8]) -> AppResult<AssetRef> {
        self.projects.project_dir(project_id)?;
        let png = assets::encode_png(w, h, rgba)?;
        self.projects.with_project_dir(project_id, |dir| {
            let asset = assets::store_png(dir, w, h, &png)?;
            self.created_assets.lock().unwrap_or_else(|e| e.into_inner()).insert(asset.id.clone());
            Ok(asset)
        })
    }

    /// Imports a picture into project `project_id`: decoded outside the project store's lock (at
    /// most `assets::MAX_CONCURRENT_IMPORTS` at once), stored with [`Self::put_asset`].
    pub fn import_asset(&self, project_id: &str, source: &Path) -> AppResult<AssetRef> {
        self.projects.project_dir(project_id)?;
        let _slot = self.imports.acquire();
        let picture = assets::load_picture(source)?;
        self.put_asset(project_id, picture.width(), picture.height(), picture.as_raw())
    }

    /// An asset of project `project_id`: its size and RGBA8 pixels.
    pub fn asset(&self, project_id: &str, asset_id: &str) -> AppResult<(u32, u32, Vec<u8>)> {
        assets::read_rgba(&self.projects.project_dir(project_id)?, asset_id)
    }

    /// Removes project `project_id`'s assets that neither its saved `project.json` nor this
    /// process uses (see `assets::gc`); returns how many files went.
    pub fn collect_assets(&self, project_id: &str) -> AppResult<usize> {
        // Read under the lock too, so no save lands between the read and the removal.
        self.projects.with_project_dir(project_id, |dir| {
            let project = self.projects.get(project_id)?;
            let referenced = assets::referenced_ids(&serde_json::to_value(&project)?);
            let created = self.created_assets.lock().unwrap_or_else(|e| e.into_inner()).clone();
            Ok(assets::gc(dir, &referenced, &created))
        })
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

/// `invalidInput` ([`ATELIER_DISABLED`]) while Settings → Experimental → Atelier is off.
pub fn require_enabled(settings: &Settings) -> AppResult<()> {
    if settings.atelier_enabled {
        Ok(())
    } else {
        Err(AppError::new(ErrorCode::InvalidInput, ATELIER_DISABLED))
    }
}

/// [`require_enabled`] with the app's settings: the first line of every command except the ones
/// Settings needs to show and remove the background-removal files, the cancels and the font lists.
fn atelier_on(app: &AppHandle) -> AppResult<()> {
    require_enabled(&app.state::<SettingsStore>().get())
}

/// The game folder Atelier reads: `invalidInput` ([`ATELIER_DISABLED`]) while Atelier is off,
/// then ([`ATELIER_NEEDS_GAME_DATA`]) while reading the game's data is off, else
/// `library::game_root`'s errors.
pub fn atelier_game_root(settings: &Settings) -> AppResult<PathBuf> {
    require_enabled(settings)?;
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
    atelier_on(&app)?;
    blocking(move || app.state::<AtelierState>().projects().list()).await
}

/// A new project for `vehicle`, with its slots read from the vehicle's model.
#[tauri::command]
pub async fn atelier_project_create(app: AppHandle, name: String, vehicle: String) -> AppResult<AtelierProject> {
    atelier_on(&app)?;
    blocking(move || {
        // Name and vehicle code first: reading the model can take a while.
        project::check_new(&name, &vehicle)?;
        let game_root = game_root_for_atelier(&app)?;
        let state = app.state::<AtelierState>();
        let model = state.model(&game_root, &vehicle)?;
        state.projects().create(&name, &vehicle, slot_choices(&model), SystemTime::now())
    })
    .await
}

#[tauri::command]
pub async fn atelier_project_get(app: AppHandle, id: String) -> AppResult<AtelierProject> {
    atelier_on(&app)?;
    blocking(move || app.state::<AtelierState>().projects().get(&id)).await
}

#[tauri::command]
pub async fn atelier_project_save(app: AppHandle, project: AtelierProject) -> AppResult<AtelierProject> {
    atelier_on(&app)?;
    blocking(move || app.state::<AtelierState>().projects().save(&project, SystemTime::now())).await
}

#[tauri::command]
pub async fn atelier_project_duplicate(app: AppHandle, id: String) -> AppResult<AtelierProject> {
    atelier_on(&app)?;
    blocking(move || app.state::<AtelierState>().projects().duplicate(&id, SystemTime::now())).await
}

/// Moves the project to the trash; the toast's Undo calls `atelier_project_undo_delete`, its
/// closing `atelier_project_forget_deleted`.
#[tauri::command]
pub async fn atelier_project_delete(app: AppHandle, id: String) -> AppResult<()> {
    atelier_on(&app)?;
    blocking(move || app.state::<AtelierState>().projects().delete(&id)).await
}

#[tauri::command]
pub async fn atelier_project_undo_delete(app: AppHandle, id: String) -> AppResult<()> {
    atelier_on(&app)?;
    blocking(move || app.state::<AtelierState>().projects().undo_delete(&id)).await
}

#[tauri::command]
pub async fn atelier_project_forget_deleted(app: AppHandle, id: String) -> AppResult<()> {
    atelier_on(&app)?;
    blocking(move || app.state::<AtelierState>().projects().forget_deleted(&id)).await
}

/// Stores a project's thumbnail: the PNG as the raw request body, the project id in the
/// `x-project-id` header.
#[tauri::command]
pub async fn atelier_project_thumb(app: AppHandle, request: Request<'_>) -> AppResult<()> {
    atelier_on(&app)?;
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
    atelier_on(&app)?;
    blocking(move || app.state::<AtelierState>().projects().thumb(&id).map(Response::new)).await
}

// ── Pictures and fonts ──────────────────────────────────────────────────────

/// Called by the editor when it opens a project (its history is empty then): removes the
/// project's pictures no saved layer and nothing made in this process uses.
#[tauri::command]
pub async fn atelier_project_open(app: AppHandle, project_id: String) -> AppResult<()> {
    atelier_on(&app)?;
    blocking(move || {
        let removed = app.state::<AtelierState>().collect_assets(&project_id)?;
        if removed > 0 {
            tracing::info!(removed, "unused Atelier pictures removed");
        }
        Ok(())
    })
    .await
}

/// Imports the picture at `path` (a local absolute path the user picked) into the project.
#[tauri::command]
pub async fn atelier_import_image(app: AppHandle, project_id: String, path: String) -> AppResult<AssetRef> {
    atelier_on(&app)?;
    blocking(move || app.state::<AtelierState>().import_asset(&project_id, Path::new(&path))).await
}

/// A picture of the project: `u32` width and `u32` height (little-endian), then its RGBA8 pixels
/// (straight alpha).
#[tauri::command]
pub async fn atelier_asset(app: AppHandle, project_id: String, asset_id: String) -> AppResult<Response> {
    atelier_on(&app)?;
    blocking(move || {
        let (w, h, rgba) = app.state::<AtelierState>().asset(&project_id, &asset_id)?;
        let mut out = Vec::with_capacity(8 + rgba.len());
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
        out.extend_from_slice(&rgba);
        Ok(Response::new(out))
    })
    .await
}

/// Stores RGBA8 pixels (straight alpha) as a new picture of the project: the pixels as the raw
/// request body; headers `x-project-id`, `x-width`, `x-height` (sides up to 4096).
#[tauri::command]
pub async fn atelier_asset_put(app: AppHandle, request: Request<'_>) -> AppResult<AssetRef> {
    atelier_on(&app)?;
    let project_id = header(&request, "x-project-id")
        .map(str::to_owned)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, PROJECT_NOT_FOUND).with_detail("no x-project-id header"))?;
    let side = |name: &str| {
        header(&request, name).and_then(|v| v.trim().parse::<u32>().ok()).ok_or_else(|| {
            AppError::new(ErrorCode::InvalidInput, ASSET_INVALID).with_detail(format!("no number in {name}"))
        })
    };
    let (w, h) = (side("x-width")?, side("x-height")?);
    // Checked on the request's own bytes, so a wrong size never costs a copy of them.
    let rgba = match request.body() {
        InvokeBody::Raw(bytes) => {
            assets::check_rgba(w, h, bytes)?;
            bytes.clone()
        }
        InvokeBody::Json(_) => {
            return Err(AppError::new(ErrorCode::InvalidInput, ASSET_INVALID).with_detail("not a raw request body"))
        }
    };
    blocking(move || app.state::<AtelierState>().put_asset(&project_id, w, h, &rgba)).await
}

/// The installed fonts text layers can use, read from the registry now (empty off Windows).
#[tauri::command]
pub async fn atelier_fonts() -> AppResult<Vec<FontInfo>> {
    blocking(|| Ok(fonts::system_fonts().into_iter().map(|f| f.info).collect())).await
}

/// The bytes of the installed font with this family and style (looked up in a fresh list; no
/// path is ever taken from the frontend).
#[tauri::command]
pub async fn atelier_font_file(family: String, style: String) -> AppResult<Response> {
    blocking(move || fonts::font_bytes(&fonts::system_fonts(), &family, &style).map(Response::new)).await
}

// ── Background-removal files ─────────────────────────────────────────────────

/// Background removal: its files, their downloader and the remover, managed by Tauri.
pub struct CutoutState {
    pub files: ModelFiles,
    pub downloader: Downloader,
    pub cutout: Cutout,
    /// Read-held by every download and background removal; a remove needs it free
    /// (`try_write`, else [`CUTOUT_BUSY`]).
    in_use: RwLock<()>,
}

impl CutoutState {
    /// The pinned files in `models_dir` (see `models`).
    pub fn new(models_dir: &Path) -> Self {
        Self {
            files: ModelFiles::new(models_dir),
            downloader: Downloader::new(),
            cutout: Cutout::new(),
            in_use: RwLock::new(()),
        }
    }

    fn use_files(&self) -> std::sync::RwLockReadGuard<'_, ()> {
        self.in_use.read().unwrap_or_else(|e| e.into_inner())
    }

    /// Removes the files unless a download or a background removal runs (`conflict`
    /// [`CUTOUT_BUSY`]). The session goes first; a runtime this process loaded marks the folder
    /// for the next launch.
    pub fn remove(&self) -> AppResult<CutoutStatus> {
        let _removing = match self.in_use.try_write() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return Err(AppError::new(ErrorCode::Conflict, CUTOUT_BUSY)),
        };
        self.cutout.unload();
        Ok(self.files.remove(self.cutout.runtime_loaded()))
    }

    /// Cuts the background out of `source` with the downloaded files; `notFound`
    /// ([`CUTOUT_NOT_READY`]) when they aren't all there.
    pub fn cut(
        &self,
        source: &image::RgbaImage,
        progress: &mut dyn FnMut(CutoutStep),
    ) -> AppResult<(image::RgbaImage, crate::model::PixelRect)> {
        let _using = self.use_files();
        let status = self.files.status();
        if !status.runtime || !status.model {
            return Err(AppError::new(ErrorCode::NotFound, CUTOUT_NOT_READY));
        }
        let (dll, model) = (self.files.runtime_dll(), self.files.model_path());
        let pins = self.files.pins();
        let files =
            cutout::RuntimeFiles { dll: &dll, dll_hash: &pins.dll, model: &model, model_hash: &pins.model.hash };
        self.cutout.run(&files, source, progress)
    }
}

/// Every minute, drops a background-removal session idle for five (on its own light thread).
pub fn start_idle_ticker(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("livery-cutout-idle".into()).spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        app.state::<CutoutState>().cutout.drop_idle();
    });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "background-removal idle timer not started");
    }
}

/// The models folder: `<data>/models` with `LIVERY_DATA_DIR`, else under the local (never
/// roaming) app data folder.
pub fn models_dir(app: &AppHandle, data_dir: &Path, data_dir_from_env: bool) -> PathBuf {
    if data_dir_from_env {
        return data_dir.join(models::MODELS_DIR);
    }
    match app.path().app_local_data_dir() {
        Ok(local) => local.join(models::MODELS_DIR),
        Err(e) => {
            tracing::warn!(error = %e, "no local app data folder: background-removal files go to the app data folder");
            data_dir.join(models::MODELS_DIR)
        }
    }
}

#[tauri::command]
pub async fn atelier_cutout_status(app: AppHandle) -> AppResult<CutoutStatus> {
    blocking(move || Ok(app.state::<CutoutState>().files.status())).await
}

/// Downloads what's missing (ONNX Runtime, then the model), with `atelier://download-progress`
/// events; refused while Atelier is off, while another download runs or while a remove waits for a
/// restart. Returns the status after.
#[tauri::command]
pub async fn atelier_cutout_download(app: AppHandle) -> AppResult<CutoutStatus> {
    atelier_on(&app)?;
    blocking(move || {
        let state = app.state::<CutoutState>();
        let _using = state.use_files();
        let flight = state.downloader.begin()?;
        let started = std::time::Instant::now();
        let installed = state.files.install(&state.downloader, &flight, &mut |item, received, total| {
            if let Err(e) = app.emit(DOWNLOAD_PROGRESS_EVENT, DownloadProgress { item, received, total }) {
                tracing::warn!(error = %e, "could not emit {DOWNLOAD_PROGRESS_EVENT}");
            }
        });
        drop(flight);
        match &installed {
            Ok(()) => tracing::info!(secs = started.elapsed().as_secs(), "background-removal files downloaded"),
            Err(e) => tracing::warn!(error = %e, "background-removal download failed"),
        }
        installed.map(|()| state.files.status())
    })
    .await
}

/// Stops whichever runs: the download (at its next chunk) or the background removal.
#[tauri::command]
pub async fn atelier_cutout_cancel(app: AppHandle) -> AppResult<()> {
    let state = app.state::<CutoutState>();
    state.downloader.cancel();
    state.cutout.cancel();
    Ok(())
}

/// Deletes the background-removal files (Settings → Experimental); refused while a download or a
/// background removal runs.
#[tauri::command]
pub async fn atelier_cutout_remove(app: AppHandle) -> AppResult<CutoutStatus> {
    blocking(move || {
        let status = app.state::<CutoutState>().remove()?;
        tracing::info!(pending = status.pending_removal, "background-removal files removed");
        Ok(status)
    })
    .await
}

/// Removes the background of one of the project's pictures into a new picture (the original
/// stays): progress `atelier://cutout-progress` (load, run, write); the crop is where the new
/// picture sits in the source, in source pixels. Never touches the network.
#[tauri::command]
pub async fn atelier_cutout(app: AppHandle, project_id: String, asset_id: String) -> AppResult<CutoutResult> {
    atelier_on(&app)?;
    blocking(move || {
        // Each step is announced as it starts, Load before anything slow (reading the picture).
        let mut last = None;
        let mut emit = |step: CutoutStep| {
            if last == Some(step) {
                return;
            }
            last = Some(step);
            if let Err(e) = app.emit(CUTOUT_PROGRESS_EVENT, CutoutProgress { step }) {
                tracing::warn!(error = %e, "could not emit {CUTOUT_PROGRESS_EVENT}");
            }
        };
        emit(CutoutStep::Load);
        let atelier = app.state::<AtelierState>();
        let (w, h, rgba) = atelier.asset(&project_id, &asset_id)?;
        let source = image::RgbaImage::from_raw(w, h, rgba)
            .ok_or_else(|| AppError::new(ErrorCode::Internal, ASSET_INVALID).with_detail("size"))?;
        let (cut, crop) = app.state::<CutoutState>().cut(&source, &mut emit)?;
        drop(source);
        emit(CutoutStep::Write);
        let asset = atelier.put_asset(&project_id, cut.width(), cut.height(), cut.as_raw())?;
        Ok(CutoutResult { asset, crop })
    })
    .await
}

// ── Apply to game ───────────────────────────────────────────────────────────

fn emit_progress(app: &AppHandle, progress: ApplyProgress) {
    if let Err(e) = app.emit(APPLY_PROGRESS_EVENT, progress) {
        tracing::warn!(error = %e, "could not emit {APPLY_PROGRESS_EVENT}");
    }
}

fn progress(apply_id: &str, step: ApplyStep, pct: u8) -> ApplyProgress {
    ApplyProgress { apply_id: apply_id.to_owned(), step, pct, message: None, skin_id: None, backup_id: None }
}

/// Starts applying a project: `enabled` is the frontend's current slot choice (it may not be
/// saved yet). The textures follow with `atelier_apply_texture`, then `atelier_apply_commit`.
#[tauri::command]
pub async fn atelier_apply_begin(app: AppHandle, project_id: String, enabled: Vec<String>) -> AppResult<ApplyStarted> {
    atelier_on(&app)?;
    blocking(move || {
        let library = GameLibrary::current(&app)?;
        let state = app.state::<AtelierState>();
        let project = state.projects().get(&project_id)?;
        let (apply_id, job) = apply::begin(&library.user_skins, &app.state::<QueueStore>(), &project, enabled)?;
        state.applies.insert(apply_id.clone(), job)?;
        tracing::info!(%apply_id, "Atelier apply started");
        Ok(ApplyStarted { apply_id })
    })
    .await
}

/// One painted slot: the RGBA8 pixels as the raw request body; headers `x-apply-id`, `x-slot`
/// (the `_c` texture), `x-width`, `x-height`. Encoded to DXT5 and written at once; progress as
/// `atelier://apply-progress` (encode, write).
#[tauri::command]
pub async fn atelier_apply_texture(app: AppHandle, request: Request<'_>) -> AppResult<()> {
    atelier_on(&app)?;
    let apply_id = header(&request, "x-apply-id")
        .map(str::to_owned)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, APPLY_NOT_FOUND).with_detail("no x-apply-id header"))?;
    let slot = header(&request, "x-slot")
        .map(str::to_owned)
        .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, APPLY_BAD_SLOT).with_detail("no x-slot header"))?;
    let side = |name: &str| {
        header(&request, name).and_then(|v| v.trim().parse::<u32>().ok()).ok_or_else(|| {
            AppError::new(ErrorCode::InvalidInput, APPLY_BAD_TEXTURE).with_detail(format!("no number in {name}"))
        })
    };
    let (w, h) = (side("x-width")?, side("x-height")?);
    // Checked on the request's own bytes, so a wrong size never costs a copy of them.
    let rgba = match request.body() {
        InvokeBody::Raw(bytes) => {
            apply::check_size(bytes, w, h)?;
            bytes.clone()
        }
        InvokeBody::Json(_) => {
            return Err(AppError::new(ErrorCode::InvalidInput, APPLY_BAD_TEXTURE).with_detail("not a raw request body"))
        }
    };
    blocking(move || {
        let state = app.state::<AtelierState>();
        // Given back below; dropped while unwinding instead, it ends the apply and removes the staging.
        let mut job = state.applies.checkout(&apply_id)?;
        let written = apply::texture(&mut job, &slot, w, h, &rgba, &mut |step, pct| {
            emit_progress(&app, progress(&apply_id, step, pct));
        });
        drop(rgba);
        job.checkin()?;
        written
    })
    .await
}

/// Writes the `.blk` and installs the skin: over the project's skin (keeping its id) when it has
/// one, else as a new skin. The project then records the installed skin. Progress: install, then
/// done (with the skin and backup ids) or error; the staging goes either way.
#[tauri::command]
pub async fn atelier_apply_commit(app: AppHandle, apply_id: String) -> AppResult<ApplyResult> {
    atelier_on(&app)?;
    blocking(move || {
        let state = app.state::<AtelierState>();
        let job = state.applies.remove(&apply_id)?;
        // From here every failure ends the apply the same way: an error event at the last pct,
        // and the staging removed (by `apply::commit` itself once it has the job).
        let fail = |e: AppError, pct: u8| {
            emit_progress(
                &app,
                ApplyProgress { message: Some(e.message.clone()), ..progress(&apply_id, ApplyStep::Error, pct) },
            );
            tracing::warn!(%apply_id, error = %e, "Atelier apply failed");
            e
        };
        let library = match GameLibrary::current(&app) {
            Ok(library) => library,
            Err(e) => {
                let pct = job.last_pct;
                apply::cancel(job);
                return Err(fail(e, pct));
            }
        };
        let project_id = job.project_id.clone();
        // The project's skin as saved now; when the project can't be read, the one it had at begin
        // (falling back to a new skin would install a second copy).
        let installed = match state.projects().get(&project_id) {
            Ok(project) => project.installed_skin_id.or_else(|| job.installed_skin_id.clone()),
            Err(e) => {
                tracing::warn!(error = %e, "the project can't be read again: replacing the skin it had at begin");
                job.installed_skin_id.clone()
            }
        };
        let target = match installed {
            Some(skin_id) => Target::Replace(skin_id),
            // The staged folder's name is the one wanted (see `apply::begin`).
            None => Target::New(job.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        };
        emit_progress(&app, progress(&apply_id, ApplyStep::Install, TEXTURES_PCT));
        let GameLibrary { settings, user_skins, store } = library;
        let now = SystemTime::now();
        // The project's picture becomes the skin's, for the Hangar card.
        let preview = state.projects().thumb(&project_id).ok().filter(|png| !png.is_empty());
        let generated = apply::commit(
            job,
            preview.as_deref(),
            &user_skins,
            &store,
            target,
            settings.backups,
            settings.backup_days,
            now,
        )
        .map_err(|e| fail(e, TEXTURES_PCT))?;
        if let Err(e) = state.projects().set_installed_skin(&project_id, &generated.skin.id, now) {
            tracing::warn!(error = %e, "the project doesn't record its installed skin");
        }
        crate::archive::recheck_queue(&app);
        emit_progress(
            &app,
            ApplyProgress {
                skin_id: Some(generated.skin.id.clone()),
                backup_id: generated.backup_id.clone(),
                ..progress(&apply_id, ApplyStep::Done, 100)
            },
        );
        tracing::info!(%apply_id, skin = %generated.skin.id, "Atelier apply installed");
        Ok(ApplyResult { skin: generated.skin, backup_id: generated.backup_id })
    })
    .await
}

/// Cancels an apply (user cancel, leaving the editor, an error): its staging goes; the installed
/// skin stays as it was. Unknown ids are fine.
#[tauri::command]
pub async fn atelier_apply_cancel(app: AppHandle, apply_id: String) -> AppResult<()> {
    blocking(move || {
        app.state::<AtelierState>().applies.cancel(&apply_id);
        Ok(())
    })
    .await
}
