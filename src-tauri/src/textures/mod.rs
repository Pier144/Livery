//! Texture headers (M4): DDS/TGA parsing from the first bytes (resolution, format, size) and
//! warnings (unreadable header, not a square power of two, heavier than 4096², referenced in the
//! blk but missing).
//!
//! - `header`: pure parser over the first [`header::HEADER_BYTES`] bytes of a file;
//! - `inspect`: a file or a whole skin folder → `TextureInfo`s (also used by the install queue
//!   on a staged folder);
//! - `read_textures`: the list for an installed skin, wherever its folder is (active or
//!   inactive).

pub mod header;
pub mod inspect;

pub use inspect::{blk_texture_refs, inspect_file, inspect_skin, inspect_skin_dir, read_blk_refs};

use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::{self, layout, LibraryStore};
use crate::model::TextureInfo;
use crate::settings::SettingsStore;
use std::path::Path;
use tauri::{AppHandle, Manager};

/// The texture list of an indexed skin, read from its folder in `UserSkins` or in Livery's
/// inactive folder. `notFound` when the id isn't in the index or its folder is in neither place.
pub fn textures_for_skin(user_skins: &Path, store: &LibraryStore, skin_id: &str) -> AppResult<Vec<TextureInfo>> {
    let skin =
        store.all().into_iter().find(|s| s.id == skin_id).ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "This skin is not in the library").with_detail(skin_id)
        })?;
    let (dir, _active) = layout::find_skin(user_skins, &skin).ok_or_else(|| {
        AppError::new(ErrorCode::NotFound, "The skin folder can't be found").with_detail(skin.folder.clone())
    })?;
    inspect_skin(&dir)
}

/// Texture list for an installed skin (`skinId`) or a queued item (`queueId`); pass exactly one.
#[tauri::command]
pub async fn read_textures(
    app: AppHandle,
    skin_id: Option<String>,
    queue_id: Option<String>,
) -> AppResult<Vec<TextureInfo>> {
    match (skin_id, queue_id) {
        (Some(skin_id), None) => {
            blocking(move || {
                let settings = app.state::<SettingsStore>().get();
                let user_skins = library::user_skins_dir(&settings)?;
                textures_for_skin(&user_skins, &app.state::<LibraryStore>(), &skin_id)
            })
            .await
        }
        // Read from the queued source itself (see `archive::textures_for_queue`).
        (None, Some(queue_id)) => {
            blocking(move || crate::archive::textures_for_queue(&app.state::<crate::archive::QueueStore>(), &queue_id))
                .await
        }
        _ => Err(AppError::new(ErrorCode::InvalidInput, "Pass either a skin id or a queue id")),
    }
}
