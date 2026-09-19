//! Backups (M3): skin folders kept aside by a delete or a replace to drive Undo, listed
//! and cleared from Settings → Backups.
//!
//! A backup is the skin folder itself, moved (a rename, so instant) to
//! `UserSkins/.livery/backups/<backupId>/<folder>`, plus a `BackupRecord` in the library index
//! with the index entry as it was. With `settings.backups` off the backup is *ephemeral*: it only
//! serves the Undo toast and is purged after a minute. Kept backups expire after
//! `settings.backupDays`. Expired backups are purged at startup and at the start of every library
//! command.

use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::index::{new_id_with, BackupRecord, Library, LibraryStore};
use crate::library::layout::{self, Journal};
use crate::library::{time, user_skins_dir};
use crate::model::{Backup, BackupReason, HangarSkin};
use crate::settings::SettingsStore;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

/// Seconds an ephemeral backup (backups turned off) lives: long enough for the Undo toast.
pub const EPHEMERAL_SECS: i64 = 60;

/// Seconds in a day, for `backupDays`.
const DAY_SECS: i64 = 86_400;

/// Moves the skin folder `from` into a new backup and records it in `library` (the skin itself
/// stays in the index: the caller decides). `was_active` says which place `from` is.
/// Returns the backup id.
#[allow(clippy::too_many_arguments)]
pub fn back_up(
    user_skins: &Path,
    library: &mut Library,
    journal: &mut Journal,
    skin: &HangarSkin,
    from: &Path,
    was_active: bool,
    reason: BackupReason,
    keep: bool,
    now: SystemTime,
) -> io::Result<String> {
    if !layout::is_folder_name(&skin.folder) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a skin folder name"));
    }
    let id = new_id_with("b");
    let holder = layout::backups_dir(user_skins).join(&id);
    journal.create_dir_all(&holder)?;
    journal.rename(from, &holder.join(&skin.folder))?;
    library.backups.push(BackupRecord {
        backup: Backup {
            id: id.clone(),
            skin_id: skin.id.clone(),
            name: skin.name.clone(),
            size_bytes: skin.size_bytes,
            created_at: time::rfc3339_utc(now),
            reason,
        },
        skin: HangarSkin { active: was_active, ..skin.clone() },
        was_active,
        ephemeral: !keep,
        dir: format!("{id}/{}", skin.folder),
    });
    Ok(id)
}

/// The backed-up skin folder of a record; `None` when its `dir` isn't `<id>/<folder>`.
pub fn backup_path(user_skins: &Path, record: &BackupRecord) -> Option<PathBuf> {
    let (holder, folder) = record.dir.split_once('/')?;
    (layout::is_folder_name(holder) && layout::is_folder_name(folder))
        .then(|| layout::backups_dir(user_skins).join(holder).join(folder))
}

/// The per-backup folder (`backups/<id>`) that holds the skin folder.
pub fn holder_path(user_skins: &Path, record: &BackupRecord) -> Option<PathBuf> {
    backup_path(user_skins, record).and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Whether a backup is past its lifetime at `now` (Unix seconds): ephemeral ones after
/// [`EPHEMERAL_SECS`], kept ones after `backup_days`. A record whose date can't be read never
/// expires by itself (Clear removes it).
pub fn is_expired(record: &BackupRecord, now: i64, backup_days: u32) -> bool {
    let Some(created) = time::parse_rfc3339(&record.backup.created_at) else {
        tracing::warn!(backup = %record.backup.id, "backup has an unreadable date");
        return false;
    };
    let lifetime = if record.ephemeral { EPHEMERAL_SECS } else { i64::from(backup_days) * DAY_SECS };
    now.saturating_sub(created) > lifetime
}

/// Permanently removes expired backups (folder and record), except the ids in `keep` (an Undo
/// in progress). A folder that can't be removed keeps its record, so the next purge retries.
/// Returns how many were purged; writes the index only when something changed.
pub fn purge(
    user_skins: &Path,
    store: &LibraryStore,
    now: SystemTime,
    backup_days: u32,
    keep: &[String],
) -> AppResult<usize> {
    let now = time::unix_secs(now);
    let due = |record: &BackupRecord| !keep.contains(&record.backup.id) && is_expired(record, now, backup_days);
    let purged = store.transact(|library, _| {
        if !library.backups.iter().any(due) {
            return Ok(0);
        }
        let mut purged = 0;
        let mut kept = Vec::with_capacity(library.backups.len());
        for record in std::mem::take(&mut library.backups) {
            if !due(&record) {
                kept.push(record);
                continue;
            }
            match holder_path(user_skins, &record).map_or(Ok(()), |dir| layout::remove_tree(&dir)) {
                Ok(()) => purged += 1,
                Err(e) => {
                    tracing::warn!(backup = %record.backup.id, error = %e, "expired backup can't be removed yet");
                    kept.push(record);
                }
            }
        }
        library.backups = kept;
        if purged > 0 {
            library.drop_dangling_members();
        }
        Ok(purged)
    })?;
    if purged > 0 {
        tracing::info!(purged, "expired backups removed");
    }
    Ok(purged)
}

/// Kept backups (not the ephemeral Undo-only ones), newest first.
pub fn list(store: &LibraryStore) -> Vec<Backup> {
    let library = store.snapshot();
    // Records are appended as they are made: reversed, then a stable sort by date.
    let mut backups: Vec<Backup> =
        library.backups.iter().rev().filter(|r| !r.ephemeral).map(|r| r.backup.clone()).collect();
    backups.sort_by(|a, b| {
        let key = |b: &Backup| time::parse_rfc3339(&b.created_at).unwrap_or(i64::MIN);
        key(b).cmp(&key(a))
    });
    backups
}

/// Permanently removes every backup: folders (including leftovers no record points to) and
/// records; collection members that are gone for good are dropped. Folders that can't be
/// removed keep their record and are reported as an `io` error.
pub fn clear(user_skins: &Path, store: &LibraryStore) -> AppResult<()> {
    let root = layout::backups_dir(user_skins);
    let failed = store.transact(|library, _| {
        let mut failed = Vec::new();
        let mut kept = Vec::new();
        for record in std::mem::take(&mut library.backups) {
            match holder_path(user_skins, &record).map_or(Ok(()), |dir| layout::remove_tree(&dir)) {
                Ok(()) => {}
                Err(e) => {
                    failed.push(format!("{}: {e}", record.backup.name));
                    kept.push(record);
                }
            }
        }
        let held: HashSet<PathBuf> = kept.iter().filter_map(|r| holder_path(user_skins, r)).collect();
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if held.contains(&path) {
                    continue;
                }
                let removed = if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    layout::remove_tree(&path)
                } else {
                    fs::remove_file(&path)
                };
                if let Err(e) = removed {
                    failed.push(format!("{}: {e}", entry.file_name().to_string_lossy()));
                }
            }
        }
        library.backups = kept;
        library.drop_dangling_members();
        Ok(failed)
    })?;
    if failed.is_empty() {
        tracing::info!("backups cleared");
        Ok(())
    } else {
        Err(AppError::new(ErrorCode::Io, "Some backups could not be removed")
            .with_detail(layout::names_detail(&failed)))
    }
}

/// Purges expired backups off the main thread; call once at startup, after the settings and
/// library stores are managed. Does nothing while no game folder is set.
pub fn purge_on_startup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::library::purge_expired(&app, &[]));
}

/// Kept backups, newest first (Settings → Backups).
#[tauri::command]
pub async fn list_backups(app: AppHandle) -> AppResult<Vec<Backup>> {
    blocking(move || {
        crate::library::purge_expired(&app, &[]);
        Ok(list(&app.state::<LibraryStore>()))
    })
    .await
}

/// Permanently removes every backup (Settings → Backups → Clear).
#[tauri::command]
pub async fn clear_backups(app: AppHandle) -> AppResult<()> {
    blocking(move || {
        let user_skins = user_skins_dir(&app.state::<SettingsStore>().get())?;
        clear(&user_skins, &app.state::<LibraryStore>())
    })
    .await
}
