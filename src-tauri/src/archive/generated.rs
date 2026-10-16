//! Installing a skin Livery made itself (Atelier): a finished skin folder staged in
//! `UserSkins/.livery/partial` goes into the library as one atomic step, either as a new skin or
//! over an existing one.
//!
//! - **New**: installs active, `Origin::Mine`, under the folder name made safe by
//!   [`sanitize_folder_name`]; a name already taken (on disk, inactive, or indexed) gets
//!   ` (2)`, ` (3)`… and the user is never asked: Settings → Conflicts does not apply, an
//!   editor's Apply has no queue item to ask about.
//! - **Replace**: the skin keeps its id (so collections, Following and the Atelier project's link
//!   to it stay valid), folder name, display name and active state; the previous version goes to a
//!   backup like an install's Replace (kept while Settings → Backups is on, else ephemeral), so
//!   `undo_replace` brings it back under the same id. A skin whose id is not indexed any more
//!   installs as a new one; one that is indexed but whose folder is gone drops the stale entry
//!   and installs as a new skin that keeps the id.
//!
//! Everything runs inside one library transaction: any failure puts the files and the index back.

use super::analyze::{sanitize_folder_name, Clash};
use super::install::{free_name, install_error, rename_retrying, replace};
use super::partial_dir;
use crate::backup;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::index::{folder_key, new_id, Library, LibraryStore};
use crate::library::layout::{self, Journal};
use crate::library::{scan, time};
use crate::model::{HangarSkin, Origin};
use std::path::Path;
use std::time::SystemTime;

/// Where a generated skin goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// Over the skin with this id (it keeps id, folder and active state). An id that is no longer
    /// in the library installs as a new skin named like the staged folder: the staged folder's
    /// own name is the folder name wanted for it.
    Replace(String),
    /// As a new skin with this folder name (unsanitised: [`sanitize_folder_name`] runs on it).
    /// Callers stage the skin in a folder of this name too, so both targets agree.
    New(String),
}

/// What an install produced.
#[derive(Debug, Clone, PartialEq)]
pub struct Generated {
    pub skin: HangarSkin,
    /// The backup of the version a Replace put aside (for `undo_replace`).
    pub backup_id: Option<String>,
}

/// The folder the new skin's name and id come from when it is installed as a new one.
struct Fresh {
    id: String,
    /// Display name; the folder name when `None`.
    name: Option<String>,
    /// The folder name asked for, before sanitising and `(2)`.
    folder: String,
}

/// Installs the skin folder at `staged` (inside `partial_dir`, on the same volume as `UserSkins`;
/// anything else is refused) into the library; see the module doc. The staged folder's name is
/// the folder name wanted when the skin installs as a new one after a `Replace` whose id is gone
/// (Atelier stages at `partial/<applyId>/<sanitised folder>`). Expired backups are purged first,
/// as every library command does (`backup_days` is Settings → Backups). `keep_backup` is
/// Settings → Backups too.
///
/// This is `library::purge_in`'s purge without a `GameLibrary`: the caller has no more than the
/// `UserSkins` folder, the store and the two settings.
pub fn install_generated(
    user_skins: &Path,
    store: &LibraryStore,
    staged: &Path,
    target: Target,
    keep_backup: bool,
    backup_days: u32,
    now: SystemTime,
) -> AppResult<Generated> {
    if let Err(e) = backup::purge(user_skins, store, now, backup_days, &[]) {
        tracing::warn!(error = %e, "expired backups could not be purged");
    }
    let staged_name = staged.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // Only Livery's own staging may be moved into the library (a stray path would be moved away
    // from where it was). A missing folder fails the scan below.
    let inside = match (staged.canonicalize(), partial_dir(user_skins).canonicalize()) {
        (Ok(staged), Ok(partial)) => staged.starts_with(&partial) && staged != partial,
        (Err(e), _) if e.kind() == std::io::ErrorKind::NotFound => true,
        _ => false,
    };
    if !inside {
        return Err(AppError::new(ErrorCode::InvalidInput, "Could not install the skin")
            .with_detail(format!("{staged_name} is not in the install staging folder")));
    }
    // Scanned once, here: moving the folder changes none of what the scan reads but its name,
    // which the install sets anyway.
    let scanned = scan::scan_skin(staged).ok_or_else(|| {
        AppError::new(ErrorCode::Io, "The copied skin can't be read").with_detail(staged_name.clone())
    })?;
    store.transact(|library, journal| {
        let fresh = match target {
            Target::New(folder) => Fresh { id: new_id(), name: None, folder },
            Target::Replace(id) => match library.skin_position(&id) {
                // Not in the library any more (deleted since): a new skin, named like the staged folder.
                None => Fresh { id: new_id(), name: None, folder: staged_name.clone() },
                Some(pos) => {
                    let skin = library.skins[pos].clone();
                    match layout::find_skin(user_skins, &skin) {
                        Some((dir, active)) => {
                            let clash =
                                Clash { path: dir.clone(), folder: skin.folder.clone(), active, index: Some(pos) };
                            let backup_id = replace(user_skins, library, journal, &clash, keep_backup, now)?;
                            rename_retrying(journal, staged, &dir).map_err(install_error)?;
                            let installed = HangarSkin {
                                id: skin.id,
                                name: skin.name,
                                folder: skin.folder,
                                active,
                                ..finished(scanned, now)
                            };
                            library.skins.push(installed.clone());
                            return Ok(Generated { skin: installed, backup_id: Some(backup_id) });
                        }
                        // Indexed, but its folder is gone: the stale entry goes, the id lives on.
                        None => {
                            library.skins.remove(pos);
                            Fresh { id: skin.id, name: Some(skin.name), folder: skin.folder }
                        }
                    }
                }
            },
        };
        let installed = install_new(user_skins, library, journal, staged, scanned, fresh, now)?;
        library.skins.push(installed.clone());
        Ok(Generated { skin: installed, backup_id: None })
    })
}

/// Moves `staged` into `UserSkins` under a free, safe folder name and describes it as installed.
fn install_new(
    user_skins: &Path,
    library: &mut Library,
    journal: &mut Journal,
    staged: &Path,
    scanned: HangarSkin,
    fresh: Fresh,
    now: SystemTime,
) -> AppResult<HangarSkin> {
    let wanted = sanitize_folder_name(&fresh.folder, &scanned.vehicle.code);
    // Index entries for this name whose folder is gone would otherwise take it (install does the same).
    let key = folder_key(&wanted);
    let before = library.skins.len();
    library.skins.retain(|s| folder_key(&s.folder) != key || layout::find_skin(user_skins, s).is_some());
    if library.skins.len() != before {
        library.drop_dangling_members();
    }
    let folder = free_name(user_skins, library, &wanted);
    let dest = layout::skin_path(user_skins, &folder, true)
        .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "Not a skin folder name").with_detail(folder.clone()))?;
    rename_retrying(journal, staged, &dest).map_err(install_error)?;
    Ok(HangarSkin {
        id: fresh.id,
        name: fresh.name.unwrap_or_else(|| folder.clone()),
        folder,
        active: true,
        ..finished(scanned, now)
    })
}

/// The staged skin as scanned, marked as made by the user and installed `now`.
fn finished(scanned: HangarSkin, now: SystemTime) -> HangarSkin {
    HangarSkin {
        origin: Origin::Mine,
        author: None,
        installed_at: time::rfc3339_utc(now),
        source_id: None,
        temporary: false,
        ..scanned
    }
}
