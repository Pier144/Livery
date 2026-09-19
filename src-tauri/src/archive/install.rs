//! Installing a queued skin, and undoing a Replace.
//!
//! An install is checked and claimed synchronously ([`prepare`]: picks the skin root, applies the
//! conflict policy when the folder name is taken, marks the item installing), then runs on a
//! background thread ([`run`]), reporting `install://progress`:
//!
//! 1. **extract** 0–80 %: the root is copied into
//!    `UserSkins/.livery/partial/<installId>/<folder>`, next to a `.livery-partial` marker;
//! 2. **verify** 80–95 %: the marker goes, the copy is compared with the source (files and bytes)
//!    and scanned like any skin in the library (vehicle, attention);
//! 3. **done** 100 %: inside one library transaction the folder name is checked again, the
//!    policy applied (Replace backs the old version up first; Copy picks `<folder> (2)`…), and the
//!    staged folder is renamed into place (same volume: atomic) and indexed.
//!
//! Staging is always removed at the end, and stale staging from an interrupted session goes before
//! the first install ([`purge_partials`]). Any failure ends with an `error` event; nothing
//! reaches `UserSkins` unless the index says so too.

use super::analyze::{self, find_clash, Conflict, SkinRoot};
use super::source::{open_source, ExtractTick, FolderSource, SkinSource};
use super::{partial_dir, QueueStore, NOT_IN_QUEUE};
use crate::backup;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::index::{folder_key, new_id, new_id_with, Library, LibraryStore};
use crate::library::layout::{self, Journal};
use crate::library::scan::{self, PARTIAL_MARKER};
use crate::library::time;
use crate::model::{
    BackupReason, ConflictPolicy, HangarSkin, InstallProgress, InstallStep, Origin, QueueItem, QueueStatus, Settings,
};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// `pct` where extraction ends and verification starts.
pub const EXTRACT_END: u8 = 80;
/// `pct` where verification ends.
pub const VERIFY_END: u8 = 95;

/// `message` of the `done` event when the install was skipped (Conflicts → Skip).
pub const SKIPPED: &str = "skipped";

/// `conflict` message when the folder name is taken and the policy is Ask.
pub const ALREADY_INSTALLED: &str = "This skin is already installed";

/// `conflict` message when the name got taken while the install ran (or can't be replaced).
pub const NAME_TAKEN: &str = "Another skin folder already has this name";

/// `notFound` message when `UserSkins` is missing.
pub const USER_SKINS_GONE: &str = "The UserSkins folder can't be found";

/// Intermediate progress events are at least this far apart (≤ 30 per second); step boundaries
/// (extract 0, verify 80, verify 95) and the final event are never held back.
const MIN_TICK_INTERVAL: Duration = Duration::from_millis(34);

/// Attempts at the final rename: right after a copy, antivirus scanners may briefly hold the new
/// files open on Windows (access denied).
const RENAME_ATTEMPTS: u32 = 5;

/// What an install needs from the app, as plain references so tests run installs without Tauri.
pub struct Ctx<'a> {
    pub user_skins: &'a Path,
    pub library: &'a LibraryStore,
    pub queue: &'a QueueStore,
    /// `conflictPolicy` (when the install doesn't choose) and `backups` (kept or Undo-only).
    pub settings: &'a Settings,
}

/// A claimed install, ready to run.
#[derive(Debug, Clone)]
pub struct InstallJob {
    pub install_id: String,
    pub queue_id: String,
    source: PathBuf,
    root: SkinRoot,
    policy: ConflictPolicy,
    /// The folder name is taken and the policy is Skip: nothing to do but report.
    skip: bool,
}

impl InstallJob {
    /// Folder name the skin installs as (before Copy picks a free one).
    pub fn target_folder(&self) -> &str {
        &self.root.target_folder
    }

    /// Whether the job only reports a skip.
    pub fn is_skip(&self) -> bool {
        self.skip
    }
}

/// Checks an install request and claims the item (status installing). `vehicle_code` picks the
/// skin of a needsLook item (matched against each root's vehicle code or `.blk` stem); the pick is
/// final, the item becomes that one skin. When the folder name is taken, the policy is
/// `conflict`, else Settings → Conflicts: Ask fails with `conflict` (the item turns into a
/// conflict row and the UI asks), Skip removes the item and returns a job that only reports
/// `done` / "skipped", Replace and Copy go ahead.
///
/// Errors: `notFound` (unknown id, `UserSkins` missing), `invalidInput` (already installing or
/// installed, no pick for several skins, a vehicle that isn't there, nothing to install),
/// `unsupported` (archives), `conflict`.
pub fn prepare(
    ctx: &Ctx,
    queue_id: &str,
    vehicle_code: Option<&str>,
    conflict: Option<ConflictPolicy>,
) -> AppResult<InstallJob> {
    if !ctx.user_skins.is_dir() {
        return Err(AppError::new(ErrorCode::NotFound, USER_SKINS_GONE));
    }
    ctx.queue.ensure_partials_purged(ctx.user_skins);
    let library = ctx.library.snapshot();
    let policy = conflict.unwrap_or(ctx.settings.conflict_policy);
    let mut entries = ctx.queue.lock();
    let pos = entries
        .iter()
        .position(|e| e.item.id == queue_id)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, NOT_IN_QUEUE).with_detail(queue_id))?;
    let entry = &mut entries[pos];
    match entry.item.status {
        QueueStatus::Installing => {
            return Err(AppError::new(ErrorCode::InvalidInput, "This item is already installing").with_detail(queue_id))
        }
        QueueStatus::Done => {
            return Err(AppError::new(ErrorCode::InvalidInput, "This item is already installed").with_detail(queue_id))
        }
        _ => {}
    }
    if entry.roots.is_empty() {
        return Err(entry
            .failure
            .clone()
            .unwrap_or_else(|| AppError::new(ErrorCode::InvalidInput, analyze::NO_BLK_ERROR).with_detail(queue_id)));
    }
    let root = pick_root(&entry.roots, vehicle_code)?.clone();
    if entry.roots.len() > 1 {
        entry.roots = vec![root.clone()];
        entry.item = analyze::single_item(&entry.item, &root, None);
    }
    let mut job = InstallJob {
        install_id: new_id_with("i"),
        queue_id: queue_id.to_owned(),
        source: entry.source.clone(),
        root: root.clone(),
        policy,
        skip: false,
    };
    // Only the disk counts now: another queued item with the same folder name isn't installed yet.
    if let Some(clash) = find_clash(ctx.user_skins, &library, &root.target_folder) {
        match policy {
            ConflictPolicy::Ask => {
                entry.item = analyze::single_item(&entry.item, &root, Some(Conflict::installed(&clash, &library)));
                return Err(AppError::new(ErrorCode::Conflict, ALREADY_INSTALLED).with_detail(clash.folder));
            }
            ConflictPolicy::Skip => {
                job.skip = true;
                entries.remove(pos);
                tracing::info!(queue_id, "install skipped: the folder name is taken");
                return Ok(job);
            }
            ConflictPolicy::Replace | ConflictPolicy::Copy => {}
        }
    }
    entry.item.status = QueueStatus::Installing;
    entry.item.error = None;
    tracing::info!(queue_id, install_id = %job.install_id, ?policy, "install started");
    Ok(job)
}

/// The skin to install: the only one, or the one for `vehicle_code`.
fn pick_root<'a>(roots: &'a [SkinRoot], vehicle_code: Option<&str>) -> AppResult<&'a SkinRoot> {
    match vehicle_code.map(str::trim).filter(|c| !c.is_empty()) {
        None if roots.len() > 1 => Err(AppError::new(ErrorCode::InvalidInput, "Pick a vehicle first")),
        None => Ok(&roots[0]),
        Some(code) => roots
            .iter()
            .find(|r| r.vehicle.code.eq_ignore_ascii_case(code) || r.blk_stem().eq_ignore_ascii_case(code))
            .ok_or_else(|| {
                AppError::new(ErrorCode::InvalidInput, "That vehicle isn't in this folder").with_detail(code.to_owned())
            }),
    }
}

/// Runs a claimed install to the end, reporting through `emit` (throttled; see the module
/// docs). Opens the source again (it may have changed or gone since the analysis). Returns the
/// queue items whose status changed, the installed one included (to re-send as
/// `queue://added`).
pub fn run(ctx: &Ctx, job: InstallJob, emit: &mut dyn FnMut(&InstallProgress)) -> Vec<QueueItem> {
    if job.skip {
        return execute(ctx, &job, None, emit);
    }
    match open_source(&job.source) {
        Ok(source) => execute(ctx, &job, Some(source.as_ref()), emit),
        Err(e) => {
            let mut reporter = Reporter::new(emit, &job);
            reporter.tick(InstallStep::Extract, 0);
            settle(ctx, &job, Err(e), &mut reporter)
        }
    }
}

/// [`run`] with the source given (tests inject failing sources).
pub fn run_with_source(
    ctx: &Ctx,
    job: InstallJob,
    source: &dyn SkinSource,
    emit: &mut dyn FnMut(&InstallProgress),
) -> Vec<QueueItem> {
    execute(ctx, &job, (!job.skip).then_some(source), emit)
}

enum Outcome {
    Installed { skin: Box<HangarSkin>, backup_id: Option<String> },
    Skipped,
}

fn execute(
    ctx: &Ctx,
    job: &InstallJob,
    source: Option<&dyn SkinSource>,
    emit: &mut dyn FnMut(&InstallProgress),
) -> Vec<QueueItem> {
    let mut reporter = Reporter::new(emit, job);
    let result = match source {
        None => Ok(Outcome::Skipped),
        Some(source) => {
            reporter.tick(InstallStep::Extract, 0);
            install(ctx, job, source, &mut reporter)
        }
    };
    settle(ctx, job, result, &mut reporter)
}

/// Records the outcome in the queue, then sends the final event.
fn settle(ctx: &Ctx, job: &InstallJob, result: AppResult<Outcome>, reporter: &mut Reporter) -> Vec<QueueItem> {
    let library = ctx.library.snapshot();
    let ((), changed) = ctx.queue.update(Some(ctx.user_skins), &library, |entries| {
        let Some(pos) = entries.iter().position(|e| e.item.id == job.queue_id) else { return };
        let entry = &mut entries[pos];
        match &result {
            Ok(Outcome::Installed { skin, .. }) => {
                entry.item.status = QueueStatus::Done;
                entry.item.target_folder = Some(skin.folder.clone());
                entry.item.conflict_with = None;
                entry.item.error = None;
                entry.installed_skin = Some(skin.id.clone());
            }
            Ok(Outcome::Skipped) => {
                entries.remove(pos);
            }
            // The name got taken while copying and the policy is Ask: waiting again (the refresh
            // turns it into a conflict row).
            Err(e) if e.code == ErrorCode::Conflict && job.policy == ConflictPolicy::Ask => {
                entry.item = analyze::single_item(&entry.item, &job.root, None);
            }
            Err(e) => {
                entry.item.status = QueueStatus::Error;
                entry.item.error = Some(e.message.clone());
            }
        }
    });
    match result {
        Ok(Outcome::Installed { skin, backup_id }) => {
            tracing::info!(install_id = %job.install_id, skin = %skin.id, replaced = backup_id.is_some(), "skin installed");
            reporter.finish(InstallStep::Done, None, Some(skin.id), backup_id);
        }
        Ok(Outcome::Skipped) => reporter.finish(InstallStep::Done, Some(SKIPPED.to_owned()), None, None),
        Err(e) => {
            tracing::warn!(install_id = %job.install_id, error = %e, "install failed");
            reporter.finish(InstallStep::Error, Some(e.message), None, None);
        }
    }
    changed
}

/// Removes a folder when dropped (staging: removed on success, failure and panic alike).
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if let Err(e) = layout::remove_tree(&self.0) {
            tracing::warn!(error = %e, "install staging could not be removed; it goes at next launch");
        }
    }
}

fn install(ctx: &Ctx, job: &InstallJob, source: &dyn SkinSource, reporter: &mut Reporter) -> AppResult<Outcome> {
    if !ctx.user_skins.is_dir() {
        return Err(AppError::new(ErrorCode::NotFound, USER_SKINS_GONE));
    }
    let holder = partial_dir(ctx.user_skins).join(&job.install_id);
    let _cleanup = RemoveOnDrop(holder.clone());
    let stage = holder.join(&job.root.target_folder);
    let staging_error =
        |e: io::Error| AppError::new(ErrorCode::Io, "Could not prepare the install").with_detail(e.to_string());
    fs::create_dir_all(&stage).map_err(staging_error)?;
    fs::write(stage.join(PARTIAL_MARKER), b"").map_err(staging_error)?;

    let copied = source.extract(&job.root.dir, &stage, &mut |tick| {
        reporter.tick(InstallStep::Extract, extract_pct(&tick));
        Ok(())
    })?;
    reporter.tick(InstallStep::Extract, EXTRACT_END);

    match fs::remove_file(stage.join(PARTIAL_MARKER)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(staging_error(e)),
        _ => {}
    }
    reporter.mark(InstallStep::Verify, EXTRACT_END);
    verify_copy(&stage, &copied)?;
    let scanned = scan::scan_skin(&stage).ok_or_else(|| {
        AppError::new(ErrorCode::Io, "The copied skin can't be read").with_detail(job.root.target_folder.clone())
    })?;
    reporter.mark(InstallStep::Verify, VERIFY_END);
    commit(ctx, job, &stage, scanned)
}

/// 0–[`EXTRACT_END`] by bytes (by files when every file is empty).
fn extract_pct(tick: &ExtractTick) -> u8 {
    let (done, total) =
        if tick.bytes_total > 0 { (tick.bytes_done, tick.bytes_total) } else { (tick.files_done, tick.files_total) };
    if total == 0 {
        return 0;
    }
    let pct = u128::from(done.min(total)) * u128::from(EXTRACT_END) / u128::from(total);
    u8::try_from(pct).unwrap_or(EXTRACT_END)
}

/// The staged folder holds exactly what the copy reported: every file, every byte.
fn verify_copy(stage: &Path, copied: &ExtractTick) -> AppResult<()> {
    let staged = FolderSource::new(stage).entries()?;
    let files = staged.iter().filter(|e| !e.is_dir).count() as u64;
    let bytes: u64 = staged.iter().filter(|e| !e.is_dir).map(|e| e.size_bytes).sum();
    if copied.files_done != copied.files_total || files != copied.files_total || bytes != copied.bytes_total {
        return Err(AppError::new(ErrorCode::Io, "The copy is incomplete").with_detail(format!(
            "expected {} files / {} bytes, found {files} files / {bytes} bytes",
            copied.files_total, copied.bytes_total
        )));
    }
    Ok(())
}

/// Moves the staged folder into place and indexes it, in one library transaction.
fn commit(ctx: &Ctx, job: &InstallJob, stage: &Path, scanned: HangarSkin) -> AppResult<Outcome> {
    let user_skins = ctx.user_skins;
    let target = &job.root.target_folder;
    let now = SystemTime::now();
    ctx.library.transact(|library, journal| {
        let (folder, active, backup_id) = match find_clash(user_skins, library, target) {
            None => (target.clone(), true, None),
            Some(clash) => match job.policy {
                ConflictPolicy::Ask => {
                    return Err(AppError::new(ErrorCode::Conflict, NAME_TAKEN).with_detail(clash.folder));
                }
                ConflictPolicy::Skip => return Ok(Outcome::Skipped),
                ConflictPolicy::Copy => (free_name(user_skins, library, target), true, None),
                ConflictPolicy::Replace => {
                    let backup_id = replace(user_skins, library, journal, &clash, ctx.settings.backups, now)?;
                    (target.clone(), clash.active, Some(backup_id))
                }
            },
        };
        let dest = layout::skin_path(user_skins, &folder, active).ok_or_else(|| {
            AppError::new(ErrorCode::InvalidInput, "Not a skin folder name").with_detail(folder.clone())
        })?;
        if layout::occupied(&dest) {
            return Err(AppError::new(ErrorCode::Conflict, NAME_TAKEN).with_detail(folder));
        }
        // Index entries for this name whose folder is gone would otherwise describe the new one.
        let key = folder_key(&folder);
        let before = library.skins.len();
        library.skins.retain(|s| folder_key(&s.folder) != key || layout::find_skin(user_skins, s).is_some());
        if library.skins.len() != before {
            library.drop_dangling_members();
        }
        if !active {
            journal.create_dir_all(&layout::inactive_dir(user_skins)).map_err(install_error)?;
        }
        rename_retrying(journal, stage, &dest).map_err(install_error)?;
        let skin = HangarSkin {
            id: new_id(),
            name: folder.clone(),
            folder,
            origin: Origin::Imported,
            author: None,
            active,
            installed_at: time::rfc3339_utc(now),
            source_id: None,
            temporary: false,
            ..scanned
        };
        library.skins.push(skin.clone());
        Ok(Outcome::Installed { skin: Box::new(skin), backup_id })
    })
}

/// Replace: the skin in the way (indexed, or a folder the library didn't know yet, adopted with a
/// new id) goes to a backup and leaves the index. Returns the backup id.
fn replace(
    user_skins: &Path,
    library: &mut Library,
    journal: &mut Journal,
    clash: &analyze::Clash,
    keep_backup: bool,
    now: SystemTime,
) -> AppResult<String> {
    let old = match clash.index {
        Some(i) => library.skins.remove(i),
        None => {
            let scanned = scan::scan_skin(&clash.path).ok_or_else(|| {
                AppError::new(ErrorCode::Conflict, "A file with this name is in the way")
                    .with_detail(clash.folder.clone())
            })?;
            HangarSkin { id: new_id(), active: clash.active, ..scanned }
        }
    };
    backup::back_up(
        user_skins,
        library,
        journal,
        &old,
        &clash.path,
        clash.active,
        BackupReason::Replace,
        keep_backup,
        now,
    )
    .map_err(|e| {
        AppError::new(ErrorCode::Io, "Could not back up the installed version")
            .with_detail(format!("{}: {e}", clash.folder))
    })
}

/// `name (2)`, `name (3)`… free in both places and in the index.
fn free_name(user_skins: &Path, library: &Library, name: &str) -> String {
    let inactive = layout::inactive_dir(user_skins);
    layout::unique_name(name, |candidate| {
        layout::occupied(&user_skins.join(candidate))
            || layout::occupied(&inactive.join(candidate))
            || library.skins.iter().any(|s| folder_key(&s.folder) == folder_key(candidate))
    })
}

fn rename_retrying(journal: &mut Journal, from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match journal.rename(from, to) {
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied && attempt < RENAME_ATTEMPTS => {
                std::thread::sleep(Duration::from_millis(100 * u64::from(attempt)));
                attempt += 1;
            }
            other => return other,
        }
    }
}

fn install_error(e: io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not install the skin").with_detail(e.to_string())
}

/// Sends progress for one install: steps in order, `pct` never going back, intermediate ticks at
/// most every [`MIN_TICK_INTERVAL`].
struct Reporter<'a> {
    emit: &'a mut dyn FnMut(&InstallProgress),
    install_id: String,
    queue_id: String,
    last: Option<(InstallStep, u8)>,
    last_at: Option<Instant>,
}

impl<'a> Reporter<'a> {
    fn new(emit: &'a mut dyn FnMut(&InstallProgress), job: &InstallJob) -> Self {
        Self { emit, install_id: job.install_id.clone(), queue_id: job.queue_id.clone(), last: None, last_at: None }
    }

    fn tick(&mut self, step: InstallStep, pct: u8) {
        let pct = pct.max(self.last.map_or(0, |(_, p)| p));
        if self.last == Some((step, pct)) {
            return;
        }
        let same_step = self.last.is_some_and(|(s, _)| s == step);
        if same_step && self.last_at.is_some_and(|at| at.elapsed() < MIN_TICK_INTERVAL) {
            return;
        }
        self.send(step, pct, None, None, None);
    }

    /// A step boundary (verify starts, verify ends): sent even right after another event.
    fn mark(&mut self, step: InstallStep, pct: u8) {
        let pct = pct.max(self.last.map_or(0, |(_, p)| p));
        if self.last != Some((step, pct)) {
            self.send(step, pct, None, None, None);
        }
    }

    fn finish(
        &mut self,
        step: InstallStep,
        message: Option<String>,
        skin_id: Option<String>,
        backup_id: Option<String>,
    ) {
        let pct = if step == InstallStep::Done { 100 } else { self.last.map_or(0, |(_, p)| p) };
        self.send(step, pct, message, skin_id, backup_id);
    }

    fn send(
        &mut self,
        step: InstallStep,
        pct: u8,
        message: Option<String>,
        skin_id: Option<String>,
        backup_id: Option<String>,
    ) {
        (self.emit)(&InstallProgress {
            install_id: self.install_id.clone(),
            queue_id: Some(self.queue_id.clone()),
            step,
            pct,
            message,
            skin_id,
            backup_id,
        });
        self.last = Some((step, pct));
        self.last_at = Some(Instant::now());
    }
}

/// Undo of "Replace, keep a backup": the version installed by the replace (`skin_id`) is removed
/// for good (its source still has it) and the backed-up one (`backup_id`) comes back under its
/// original folder name, id and state (active or inactive); the backup is used up. All in one
/// library transaction. Errors: `notFound` (unknown skin or backup, backup folder gone),
/// `invalidInput` (the backup isn't the older version of that skin), `conflict` (something else
/// took the original folder name).
pub fn undo_replace(user_skins: &Path, store: &LibraryStore, skin_id: &str, backup_id: &str) -> AppResult<HangarSkin> {
    let (restored, parked) = store.transact(|library, journal| {
        let newer_pos = library.skin_position(skin_id).ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "This skin is not in the library").with_detail(skin_id.to_owned())
        })?;
        let gone = || {
            AppError::new(ErrorCode::NotFound, "This backup is no longer available").with_detail(backup_id.to_owned())
        };
        let record_pos = library.backups.iter().position(|r| r.backup.id == backup_id).ok_or_else(gone)?;
        let newer = library.skins[newer_pos].clone();
        let record = library.backups[record_pos].clone();
        if record.backup.reason != BackupReason::Replace || folder_key(&record.skin.folder) != folder_key(&newer.folder)
        {
            return Err(AppError::new(ErrorCode::InvalidInput, "This backup isn't an older version of that skin")
                .with_detail(backup_id.to_owned()));
        }
        let src = backup::backup_path(user_skins, &record).filter(|p| p.is_dir()).ok_or_else(gone)?;
        // The name comes from the (validated) backup path, never straight from the record.
        let original = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();

        // The newer version is parked in the staging area now and deleted once this is saved.
        let mut parked = None;
        if let Some((dir, _)) = layout::find_skin(user_skins, &newer) {
            let holder = partial_dir(user_skins).join(new_id_with("u"));
            journal.create_dir_all(&holder).map_err(undo_error)?;
            journal.rename(&dir, &holder.join(&newer.folder)).map_err(undo_error)?;
            parked = Some(holder);
        }
        let base = layout::base_dir(user_skins, record.was_active);
        let dest = base.join(&original);
        if layout::occupied(&dest) {
            return Err(AppError::new(ErrorCode::Conflict, NAME_TAKEN).with_detail(original));
        }
        if !record.was_active {
            journal.create_dir_all(&base).map_err(undo_error)?;
        }
        rename_retrying(journal, &src, &dest).map_err(undo_error)?;
        if let Some(holder) = src.parent() {
            journal.after_commit_remove_empty_dir(holder.to_path_buf());
        }
        library.skins.remove(newer_pos);
        let skin = HangarSkin { active: record.was_active, folder: original, ..record.skin.clone() };
        match library.skin_position(&skin.id) {
            Some(i) => library.skins[i] = skin.clone(),
            None => library.skins.push(skin.clone()),
        }
        library.backups.remove(record_pos);
        library.drop_dangling_members();
        Ok((skin, parked))
    })?;
    if let Some(holder) = parked {
        if let Err(e) = layout::remove_tree(&holder) {
            tracing::warn!(error = %e, "replaced version could not be removed yet; it goes at next launch");
        }
    }
    tracing::info!(skin = %restored.id, "replace undone");
    Ok(restored)
}

fn undo_error(e: io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not put the previous version back").with_detail(e.to_string())
}

/// Removes everything in `UserSkins/.livery/partial` (staging of installs that never finished,
/// versions an Undo parked). Best effort; returns how many entries went. Call only while nothing
/// is being installed there (see `QueueStore::ensure_partials_purged`).
pub fn purge_partials(user_skins: &Path) -> usize {
    let Ok(entries) = fs::read_dir(partial_dir(user_skins)) else { return 0 };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let result = if entry.file_type().is_ok_and(|t| t.is_dir()) {
            layout::remove_tree(&path)
        } else {
            fs::remove_file(&path)
        };
        match result {
            Ok(()) => removed += 1,
            Err(e) => tracing::warn!(error = %e, "stale install staging can't be removed yet"),
        }
    }
    removed
}
