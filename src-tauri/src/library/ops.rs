//! My Hangar operations on disk + index: rescan, activate/deactivate, delete with backup,
//! restore (Undo), export. Plain functions (paths and store in, results out); the commands in
//! `library/mod.rs` only gather their inputs. See `layout` for where folders live.

use super::index::{folder_key, refresh, Library, LibraryStore};
use super::layout::{self, Journal, MoveReport};
use super::scan;
use crate::archive::source::join_rel;
use crate::archive::{FolderSource, SkinSource};
use crate::backup;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::root;
use crate::model::{BackupReason, DeleteResult, ExportResult, HangarSkin};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::time::SystemTime;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// `ids` without repeats, first occurrence first.
pub fn dedupe(ids: &[String]) -> Vec<&str> {
    let mut seen = HashSet::new();
    ids.iter().map(String::as_str).filter(|id| seen.insert(*id)).collect()
}

/// Every skin folder on disk, active (`UserSkins`) and inactive (`.livery/inactive`), checked,
/// and the index brought up to date with it: each indexed skin found on disk gets fresh folder
/// spelling, vehicle, size, attention and active flag; indexed skins whose folder is in neither
/// place are dropped (only when `UserSkins` exists, so an unplugged drive empties nothing).
/// Returns every folder on disk sorted by name: indexed ones as the index knows them, the others
/// with `disk:<folder>` (active) or `disk:inactive/<folder>` ids.
pub fn rescan(user_skins: &Path, store: &LibraryStore) -> AppResult<Vec<HangarSkin>> {
    let active = scan::scan_dir(user_skins)?;
    let inactive = scan::scan_inactive_dir(&layout::inactive_dir(user_skins))?;
    let can_prune = user_skins.is_dir();
    let (mut found, pruned) = store.transact(|library, _| {
        let active_keys = key_positions(&active);
        let inactive_keys = key_positions(&inactive);
        // Scanned skin (place, position) → the index entry that claimed it.
        let mut claimed: HashMap<(bool, usize), HangarSkin> = HashMap::new();
        let mut kept = Vec::with_capacity(library.skins.len());
        let mut pruned = 0usize;
        // Indexed skins whose folder appeared or moved after the scan read the disk.
        let mut late = Vec::new();
        for skin in std::mem::take(&mut library.skins) {
            let key = folder_key(&skin.folder);
            let lookup = |in_active: bool| {
                let keys = if in_active { &active_keys } else { &inactive_keys };
                keys.get(&key).copied().filter(|&n| !claimed.contains_key(&(in_active, n))).map(|n| (in_active, n))
            };
            // The folders were read before taking the index lock: a toggle, restore or import
            // that committed meanwhile may have moved or added this skin's folder. Trust the
            // scan only where the folder still is, and prune only what is really gone now.
            let place = lookup(skin.active).or_else(|| lookup(!skin.active)).filter(|&(in_active, _)| {
                layout::skin_path(user_skins, &skin.folder, in_active).is_some_and(|p| p.is_dir())
            });
            match place {
                Some(place) => {
                    let scanned = if place.0 { &active[place.1] } else { &inactive[place.1] };
                    let fresh = refresh(&skin, scanned.clone());
                    claimed.insert(place, fresh.clone());
                    kept.push(fresh);
                }
                None => match layout::find_skin(user_skins, &skin) {
                    // Moved or put back after the scan: keep it where it is now.
                    Some((_, in_active)) => {
                        let now = HangarSkin { active: in_active, ..skin };
                        late.push(now.clone());
                        kept.push(now);
                    }
                    None if can_prune => pruned += 1,
                    None => kept.push(skin),
                },
            }
        }
        library.skins = kept;
        if pruned > 0 {
            library.drop_dangling_members();
        }
        let found: Vec<HangarSkin> = [(true, &active), (false, &inactive)]
            .into_iter()
            .flat_map(|(place, list)| list.iter().enumerate().map(move |(n, skin)| (place, n, skin)))
            .filter_map(|(place, n, skin)| match claimed.remove(&(place, n)) {
                Some(indexed) => Some(indexed),
                // An unindexed folder, unless it moved away after the scan.
                None => match layout::skin_path(user_skins, &skin.folder, place) {
                    Some(path) => path.is_dir().then(|| skin.clone()),
                    // A name Livery can't manage (e.g. a trailing space): shown as scanned.
                    None => Some(skin.clone()),
                },
            })
            .chain(late)
            .collect();
        Ok((found, pruned))
    })?;
    found.sort_by(|a, b| {
        a.folder
            .to_lowercase()
            .cmp(&b.folder.to_lowercase())
            .then_with(|| a.folder.cmp(&b.folder))
            .then_with(|| b.active.cmp(&a.active))
    });
    let attention = found.iter().filter(|s| !s.attention.is_empty()).count();
    tracing::info!(skins = found.len(), attention, pruned, "UserSkins scanned");
    Ok(found)
}

/// Folder key → position; the first wins.
fn key_positions(skins: &[HangarSkin]) -> HashMap<String, usize> {
    let mut map = HashMap::with_capacity(skins.len());
    for (i, skin) in skins.iter().enumerate() {
        map.entry(folder_key(&skin.folder)).or_insert(i);
    }
    map
}

/// Moves the folders of the skins `want` picks to the place it says (`true` = active). A skin
/// already in place only gets its flag fixed. A skin whose destination name is taken, whose
/// folder is in neither place, or that the file system refuses to move is left as it is and
/// reported; the others move.
pub fn move_skins(
    user_skins: &Path,
    library: &mut Library,
    journal: &mut Journal,
    want: impl Fn(&HangarSkin) -> Option<bool>,
) -> MoveReport {
    let mut report = MoveReport::default();
    for skin in &mut library.skins {
        let Some(active) = want(skin) else { continue };
        let folder = skin.folder.clone();
        let (Some(dst), Some(src)) =
            (layout::skin_path(user_skins, &folder, active), layout::skin_path(user_skins, &folder, !active))
        else {
            report.missing.push(folder);
            continue;
        };
        if dst.is_dir() && (skin.active == active || !src.is_dir()) {
            skin.active = active;
            continue;
        }
        if layout::occupied(&dst) {
            report.clashes.push(folder);
            continue;
        }
        if !src.is_dir() {
            report.missing.push(folder);
            continue;
        }
        let moved = match dst.parent() {
            Some(parent) if !active => journal.create_dir_all(parent),
            _ => Ok(()),
        }
        .and_then(|()| journal.rename(&src, &dst));
        match moved {
            Ok(()) => skin.active = active,
            Err(e) => report.failed.push((folder, e.to_string())),
        }
    }
    report
}

/// Activates or deactivates skins (unknown ids are ignored) by moving their folders between
/// `UserSkins` and `.livery/inactive`. Returns the whole index; when some skins couldn't move
/// (name clash → `conflict`, file-system failure → `io`, folder gone → `notFound`, folders in
/// `detail`), the others are still moved and saved and the error is returned instead.
pub fn set_active(user_skins: &Path, store: &LibraryStore, ids: &[String], active: bool) -> AppResult<Vec<HangarSkin>> {
    let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let (index, report) = store.transact(|library, journal| {
        let report = move_skins(user_skins, library, journal, |s| wanted.contains(s.id.as_str()).then_some(active));
        Ok((library.skins.clone(), report))
    })?;
    tracing::info!(requested = wanted.len(), active, "skins toggled");
    report.into_result(index)
}

/// Deletes skins (unknown ids are ignored): each folder moves to a backup and the skin leaves
/// the index; collection memberships stay so `restore` brings them back. With `keep_backup`
/// false (backups off in Settings) the backups are ephemeral (purged after a minute). All or
/// nothing: if a folder can't be moved, every move is undone and an `io` error is returned.
/// Returns one backup id per deleted skin, in input order (a skin whose folder is already gone
/// just leaves the index, without a backup).
pub fn delete(
    user_skins: &Path,
    store: &LibraryStore,
    ids: &[String],
    keep_backup: bool,
    now: SystemTime,
) -> AppResult<DeleteResult> {
    let result = store.transact(|library, journal| {
        let mut backup_ids = Vec::new();
        for id in dedupe(ids) {
            let Some(pos) = library.skin_position(id) else { continue };
            let skin = library.skins[pos].clone();
            match layout::find_skin(user_skins, &skin) {
                Some((dir, was_active)) => {
                    let backup_id = backup::back_up(
                        user_skins,
                        library,
                        journal,
                        &skin,
                        &dir,
                        was_active,
                        BackupReason::Delete,
                        keep_backup,
                        now,
                    )
                    .map_err(|e| {
                        AppError::new(ErrorCode::Io, "Could not delete the skin")
                            .with_detail(format!("{}: {e}", skin.folder))
                    })?;
                    backup_ids.push(backup_id);
                }
                None => tracing::warn!(skin = %skin.id, "deleted skin's folder was already gone"),
            }
            library.skins.remove(pos);
        }
        library.drop_dangling_members();
        Ok(DeleteResult { backup_ids })
    })?;
    tracing::info!(deleted = result.backup_ids.len(), keep_backup, "skins deleted");
    Ok(result)
}

/// Puts backed-up skins back where they were (active or inactive) with their original id, name
/// and collection memberships, and drops the backups. If the folder name is taken meanwhile, the
/// skin comes back as `<folder> (2)`, `(3)`… (folder and name). Returns the restored skins in
/// input order; ids that are unknown or expired (or whose folder is gone) give a `notFound`
/// error, and folders the file system refuses to move an `io` error, after the others are
/// restored and saved.
pub fn restore(user_skins: &Path, store: &LibraryStore, backup_ids: &[String]) -> AppResult<Vec<HangarSkin>> {
    let (restored, missing, failed) = store.transact(|library, journal| {
        let mut restored = Vec::new();
        let mut missing = Vec::new();
        let mut failed = Vec::new();
        for id in dedupe(backup_ids) {
            let Some(pos) = library.backups.iter().position(|r| r.backup.id == id) else {
                missing.push(id.to_owned());
                continue;
            };
            let record = library.backups[pos].clone();
            let Some(src) = backup::backup_path(user_skins, &record).filter(|p| p.is_dir()) else {
                tracing::warn!(backup = id, "backup folder is gone; record dropped");
                library.backups.remove(pos);
                missing.push(id.to_owned());
                continue;
            };
            // The name comes from the (validated) backup path, never straight from the record.
            let original = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let folder = restored_folder_name(user_skins, library, &record.skin.id, &original);
            let base = layout::base_dir(user_skins, record.was_active);
            let moved = if record.was_active { Ok(()) } else { journal.create_dir_all(&base) }
                .and_then(|()| journal.rename(&src, &base.join(&folder)));
            if let Err(e) = moved {
                failed.push(format!("{original}: {e}"));
                continue;
            }
            if let Some(holder) = src.parent() {
                journal.after_commit_remove_empty_dir(holder.to_path_buf());
            }
            let mut skin = HangarSkin { active: record.was_active, ..record.skin.clone() };
            if folder != original {
                // `unique_name` only ever appends " (n)".
                let suffix = &folder[original.len()..];
                skin.name = format!("{}{suffix}", skin.name);
            }
            skin.folder = folder;
            match library.skin_position(&skin.id) {
                Some(existing) => library.skins[existing] = skin.clone(),
                None => library.skins.push(skin.clone()),
            }
            library.backups.remove(pos);
            restored.push(skin);
        }
        Ok((restored, missing, failed))
    })?;
    tracing::info!(restored = restored.len(), missing = missing.len(), failed = failed.len(), "backups restored");
    if !failed.is_empty() {
        return Err(
            AppError::new(ErrorCode::Io, "Some skins could not be restored").with_detail(layout::names_detail(&failed))
        );
    }
    if !missing.is_empty() {
        return Err(AppError::new(ErrorCode::NotFound, "Some backups are no longer available")
            .with_detail(layout::names_detail(&missing)));
    }
    Ok(restored)
}

/// The folder name a restored skin gets: `folder`, or `<folder> (n)` when that name is taken in
/// either place or by another indexed skin.
fn restored_folder_name(user_skins: &Path, library: &Library, skin_id: &str, folder: &str) -> String {
    let inactive = layout::inactive_dir(user_skins);
    let indexed: HashSet<String> =
        library.skins.iter().filter(|s| s.id != skin_id).map(|s| folder_key(&s.folder)).collect();
    layout::unique_name(folder, |name| {
        layout::occupied(&user_skins.join(name))
            || layout::occupied(&inactive.join(name))
            || indexed.contains(&folder_key(name))
    })
}

/// How `export_skins` writes each skin into the chosen folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    /// One `<folder>.zip` per skin, holding `<folder>/…` (the spec's "zip per skin").
    #[default]
    Zip,
    /// A copy of each skin folder.
    Folder,
}

/// [`export`] or [`export_zip`], as `format` says.
pub fn export_as(
    user_skins: &Path,
    store: &LibraryStore,
    ids: &[String],
    dest: &Path,
    format: ExportFormat,
) -> AppResult<ExportResult> {
    match format {
        ExportFormat::Zip => export_zip(user_skins, store, ids, dest),
        ExportFormat::Folder => export(user_skins, store, ids, dest),
    }
}

fn check_export_dest(dest: &Path) -> AppResult<String> {
    let shown = root::display_path(dest);
    if dest.as_os_str().is_empty() || !dest.is_dir() {
        return Err(AppError::new(ErrorCode::InvalidInput, "The export folder can't be found").with_detail(shown));
    }
    Ok(shown)
}

/// Copies each skin's folder (unknown ids and folders that are gone are skipped) into
/// `dest/<folder>`, as `<folder> (2)`… when the name is taken there. `dest` must be an existing
/// folder (`invalidInput` otherwise). Stops at the first copy that fails (`io`), removing that
/// partial copy; earlier copies stay.
pub fn export(user_skins: &Path, store: &LibraryStore, ids: &[String], dest: &Path) -> AppResult<ExportResult> {
    let shown = check_export_dest(dest)?;
    let library = store.snapshot();
    let mut exported = 0u32;
    for id in dedupe(ids) {
        let Some(skin) = library.skins.iter().find(|s| s.id == id) else { continue };
        let Some((src, _)) = layout::find_skin(user_skins, skin) else {
            tracing::warn!(skin = %skin.id, "skin folder is gone; not exported");
            continue;
        };
        let name = layout::unique_name(&skin.folder, |n| layout::occupied(&dest.join(n)));
        layout::copy_dir(&src, &dest.join(&name)).map_err(|e| {
            AppError::new(ErrorCode::Io, "Could not export the skin").with_detail(format!("{}: {e}", skin.folder))
        })?;
        exported += 1;
    }
    tracing::info!(exported, "skins exported");
    Ok(ExportResult { exported, dest: shown })
}

/// Writes one ZIP per skin (unknown ids and folders that are gone are skipped) into
/// `dest/<folder>.zip`, as `<folder> (2).zip`… when the name is taken there. Each archive holds
/// the skin's folder (`<folder>/…`, so it unpacks into `UserSkins` as it is and Livery installs
/// it under the same name); files already compressed (PNG, JPEG, archives…) are stored, the rest
/// deflated. Livery's own files never go in. Each archive is written under a temporary name and
/// moved to its name when complete, never over a file that appeared there meanwhile, so a failure
/// never leaves a half-written `.zip` and nothing is overwritten. `dest` must be an existing
/// folder (`invalidInput` otherwise). Stops at the first archive that fails (`io`); earlier ones
/// stay.
pub fn export_zip(user_skins: &Path, store: &LibraryStore, ids: &[String], dest: &Path) -> AppResult<ExportResult> {
    let shown = check_export_dest(dest)?;
    let library = store.snapshot();
    let mut exported = 0u32;
    for id in dedupe(ids) {
        let Some(skin) = library.skins.iter().find(|s| s.id == id) else { continue };
        let Some((src, _)) = layout::find_skin(user_skins, skin) else {
            tracing::warn!(skin = %skin.id, "skin folder is gone; not exported");
            continue;
        };
        let part = dest.join(format!("{}.zip.{}.part", skin.folder, super::index::new_id_with("x")));
        let written = write_skin_zip(&src, &skin.folder, &part).and_then(|()| {
            // Another program may take the free name while the zip is written: pick again.
            for _ in 0..16 {
                let name = layout::unique_name(&skin.folder, |n| layout::occupied(&dest.join(format!("{n}.zip"))));
                match move_no_replace(&part, &dest.join(format!("{name}.zip"))) {
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    done => return done.map_err(|e| export_error(&skin.folder, &e)),
                }
            }
            Err(export_error(&skin.folder, &"no free name"))
        });
        if let Err(e) = written {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
        exported += 1;
    }
    tracing::info!(exported, "skins exported as zip");
    Ok(ExportResult { exported, dest: shown })
}

/// Moves the file `from` to `to` unless something is already at `to` (`AlreadyExists`). A hard
/// link plus a removal does it atomically; where hard links don't work (FAT/exFAT drives, some
/// network shares) it falls back to a rename after checking `to` is free.
fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    match fs::hard_link(from, to) {
        Ok(()) => {
            if let Err(e) = fs::remove_file(from) {
                tracing::debug!(error = %e, "export temp file could not be removed");
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists || layout::occupied(to) => {
            Err(io::Error::new(io::ErrorKind::AlreadyExists, e))
        }
        Err(_) => fs::rename(from, to),
    }
}

fn export_error(folder: &str, e: &dyn std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, "Could not export the skin").with_detail(format!("{folder}: {e}"))
}

/// Extensions whose data is already compressed: stored as they are.
const STORED_EXTENSIONS: [&str; 16] =
    ["png", "jpg", "jpeg", "webp", "gif", "zip", "rar", "7z", "gz", "bz2", "xz", "zst", "mp3", "ogg", "mp4", "webm"];

fn already_compressed(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| STORED_EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(ext)))
}

/// The ZIP of one skin folder `src`, its entries under `folder/`, written to `out`.
fn write_skin_zip(src: &Path, folder: &str, out: &Path) -> AppResult<()> {
    let entries = FolderSource::new(src).entries()?;
    let fail = |e: &dyn std::fmt::Display| export_error(folder, e);
    let file = fs::File::create(out).map_err(|e| fail(&e))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let dir_options = SimpleFileOptions::default().unix_permissions(0o755);
    zip.add_directory(format!("{folder}/"), dir_options).map_err(|e| fail(&e))?;
    for entry in &entries {
        let name = format!("{folder}/{}", entry.path);
        if entry.is_dir {
            zip.add_directory(format!("{name}/"), dir_options).map_err(|e| fail(&e))?;
            continue;
        }
        let method = if entry.size_bytes == 0 || already_compressed(&entry.path) {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        let options = SimpleFileOptions::default()
            .compression_method(method)
            .unix_permissions(0o644)
            .large_file(entry.size_bytes >= u64::from(u32::MAX));
        zip.start_file(name, options).map_err(|e| fail(&e))?;
        let mut input = fs::File::open(join_rel(src, &entry.path)?).map_err(|e| fail(&e))?;
        io::copy(&mut input, &mut zip).map_err(|e| fail(&e))?;
    }
    let mut writer = zip.finish().map_err(|e| fail(&e))?;
    writer.flush().map_err(|e| fail(&e))?;
    writer.into_inner().map_err(|e| fail(e.error()))?.sync_all().map_err(|e| fail(&e))
}

#[cfg(test)]
mod tests {
    use super::move_no_replace;
    use std::fs;
    use std::io;

    #[test]
    fn a_finished_export_never_replaces_a_file_that_appeared_meanwhile() {
        let dir = std::env::temp_dir().join(format!("livery-move-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (part, taken, free) = (dir.join("a.zip.x.part"), dir.join("a.zip"), dir.join("a (2).zip"));
        fs::write(&part, b"new").unwrap();
        fs::write(&taken, b"someone else's").unwrap();
        let e = move_no_replace(&part, &taken).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&taken).unwrap(), b"someone else's");
        assert_eq!(fs::read(&part).unwrap(), b"new", "the finished zip is still there to move");
        move_no_replace(&part, &free).unwrap();
        assert_eq!(fs::read(&free).unwrap(), b"new");
        assert!(!part.exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
