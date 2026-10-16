//! Atelier, the skin editor: the vehicle's model and template textures read from the game's packs
//! (`game::gameres`), the projects (`project`) and the apply to the game (`apply`).
//!
//! Binary payloads travel as raw bytes: `tauri::ipc::Response` out, raw request bodies in.
//! Reading the packs may wait on the Oodle worker process, so every command works in
//! `crate::blocking`.

use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::binblk::Blk;
use crate::game::gameres::assemble::{self, VehicleModel};
use crate::game::gameres::index::IndexStore;
use crate::game::gameres::{desc, TEXTURE_NOT_FOUND};
use crate::game::root;
use crate::model::Settings;
use crate::settings::SettingsStore;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
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
        }
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
