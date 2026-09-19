//! Texture headers (M4): DDS/TGA parsing from the first bytes (resolution, format, size) and
//! warnings (unreadable header, not a square power of two, heavier than 4096², referenced in the
//! blk but missing).
//!
//! - `header`: pure parser over the first [`header::HEADER_BYTES`] bytes of a file;
//! - `inspect`: a file or a whole skin folder → `TextureInfo`s (also used by the install queue
//!   on a staged folder);
//! - `read_textures`: the list for an installed skin, wherever its folder is (active or
//!   inactive), for a queue item, or for a WT Live post that isn't installed (`wtliveId`, see
//!   `crate::wtlive::post_textures`; `unsupported` until WT Live downloads are possible).

pub mod header;
pub mod inspect;

pub use inspect::{blk_texture_refs, inspect_file, inspect_skin, inspect_skin_dir, read_blk_refs};

use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::{layout, GameLibrary, LibraryStore};
use crate::model::TextureInfo;
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

/// Which texture list `read_textures` was asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextureTarget {
    /// An installed skin (`HangarSkin.id`).
    Skin(String),
    /// An install queue item.
    Queue(String),
    /// A WT Live post that isn't installed (`WtLiveSkin.id`).
    WtLive(String),
}

/// `invalidInput` message when `read_textures` gets none or several ids.
pub const ONE_TEXTURE_TARGET: &str = "Pass exactly one of a skin id, a queue id or a WT Live id";

/// Exactly one of the three ids → its target; none or several → `invalidInput`.
pub fn texture_target(
    skin_id: Option<String>,
    queue_id: Option<String>,
    wtlive_id: Option<String>,
) -> AppResult<TextureTarget> {
    match (skin_id, queue_id, wtlive_id) {
        (Some(id), None, None) => Ok(TextureTarget::Skin(id)),
        (None, Some(id), None) => Ok(TextureTarget::Queue(id)),
        (None, None, Some(id)) => Ok(TextureTarget::WtLive(id)),
        _ => Err(AppError::new(ErrorCode::InvalidInput, ONE_TEXTURE_TARGET)),
    }
}

/// Texture list for an installed skin (`skinId`), a queued item (`queueId`) or a WT Live post
/// (`wtliveId`); pass exactly one.
#[tauri::command]
pub async fn read_textures(
    app: AppHandle,
    skin_id: Option<String>,
    queue_id: Option<String>,
    wtlive_id: Option<String>,
) -> AppResult<Vec<TextureInfo>> {
    match texture_target(skin_id, queue_id, wtlive_id)? {
        TextureTarget::Skin(skin_id) => {
            blocking(move || {
                let library = GameLibrary::current(&app)?;
                textures_for_skin(&library.user_skins, &library.store, &skin_id)
            })
            .await
        }
        // Read from the queued source itself (see `archive::textures_for_queue`).
        TextureTarget::Queue(queue_id) => {
            blocking(move || crate::archive::textures_for_queue(&app.state::<crate::archive::QueueStore>(), &queue_id))
                .await
        }
        TextureTarget::WtLive(id) => crate::wtlive::read_post_textures(app, id).await,
    }
}
