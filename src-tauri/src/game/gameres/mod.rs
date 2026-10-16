//! Read-only readers of War Thunder's game-resource packs (Atelier): models (`.grp`), their
//! materials (`dynModelDesc.bin`) and textures (`.dxp.bin`). Formats follow the Dagor Engine
//! sources Gaijin published under BSD-3; see docs/superpowers/specs/2026-10-16-atelier-phase0-formats.md.
//! Everything is bounds-checked: a damaged or changed file is a `parse` error, never a panic.

pub mod assemble;
pub mod bytes;
pub mod codec;
pub mod desc;
pub mod dxp;
pub mod dynmodel;
pub mod grp;
pub mod index;
pub mod meshopt;
pub mod skeleton;

use crate::error::{AppError, ErrorCode};

/// A pack or model that can't be read (format changed or file damaged).
pub const MODEL_UNREADABLE: &str = "This vehicle's 3D model can't be read";
/// The vehicle has no model Livery can find in the game's files.
pub const MODEL_NOT_FOUND: &str = "This vehicle's 3D model isn't in the game's files";
/// A texture named by the model's materials isn't in any texture pack.
pub const TEXTURE_NOT_FOUND: &str = "A texture of this vehicle isn't in the game's files";

pub(crate) fn bad(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Parse, MODEL_UNREADABLE).with_detail(detail.into())
}
