//! Installing a WT Live post, Try in game, and reading a post's textures before installing.
//!
//! `install_from_wtlive` is checked synchronously ([`prepare`]), then runs on a background
//! thread ([`run`]) and reports `install://progress` (no `queueId`):
//!
//! 1. **download** 0–[`DOWNLOAD_END`] %: the post's archive, through the client
//!    ([`WtLiveClient::archive`], kept in the WT Live cache for a day so the Textures tab and
//!    the install share one download);
//! 2. **extract** and **verify** [`DOWNLOAD_END`]–96 %: the archive's skin is staged and checked
//!    by the queue's own code (`archive::install::stage`);
//! 3. **done** 100 %: one library transaction moves it into place and indexes it with
//!    `origin: wtlive`, the post's name and author, `sourceId` = the post id, and `temporary`
//!    for Try in game.
//!
//! Folder names follow the prototype: `<vehicle code>_<author>`; when that name is taken by
//! anything else, `<name> (2)`… (a different post never replaces another one). A post already
//! installed (not temporary) is a conflict settled by `conflict`, else Settings → Conflicts:
//! Ask fails with `conflict`, Skip reports `done` / "skipped", Replace backs the installed
//! version up and installs in its place, Copy installs another copy named "<name> (2)". A post
//! being tried is taken over by a new install of the same post (unless Copy).
//!
//! Try in game (`mode: temporary`) installs the same way with `temporary: true`; when it replaced
//! an installed version, the backup is always kept (whatever Settings → Backups says) and noted
//! in the index's `triedBackups`, so Discard can put it back. [`finalize`]: Keep clears
//! `temporary`; Discard removes the skin (no backup kept) and restores what it replaced.
//! [`purge_tries`] discards what a closed or crashed session left being tried.

use super::client::{DownloadProgress, WtLiveClient};
use crate::archive::analyze::{self, find_clash, NO_BLK_ERROR};
use crate::archive::install::{
    free_name, install_error, rename_retrying, replace, stage, undo_replace, Reporter, Staged, ALREADY_INSTALLED,
    NAME_TAKEN, SKIPPED, USER_SKINS_GONE,
};
use crate::archive::{archive_textures, open_source, SkinRoot, SkinSource};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::index::{folder_key, new_id, new_id_with, LibraryStore};
use crate::library::{layout, ops, time};
use crate::model::{
    ConflictPolicy, HangarSkin, InstallMode, InstallProgress, InstallStep, Origin, Settings, TextureInfo, WtLiveSkin,
};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

/// `pct` where the download ends.
pub const DOWNLOAD_END: u8 = 40;

/// `invalidInput` message when the same post is already installing.
pub const ALREADY_INSTALLING: &str = "This skin is already installing";
/// `notFound` message of `finalize_try` when the post isn't being tried.
pub const NOT_TRIED: &str = "This skin isn't being tried in game";

/// Posts installing right now (a post installs once at a time).
#[derive(Default)]
pub struct Installing(Mutex<HashSet<String>>);

impl Installing {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Claims `post_id`; `false` when it is installing already.
    pub fn claim(&self, post_id: &str) -> bool {
        self.lock().insert(post_id.to_owned())
    }

    pub fn release(&self, post_id: &str) {
        self.lock().remove(post_id);
    }

    pub fn contains(&self, post_id: &str) -> bool {
        self.lock().contains(post_id)
    }
}

/// What an install needs from the app, as plain references (tests run it without Tauri).
pub struct Ctx<'a> {
    pub user_skins: &'a Path,
    pub library: &'a LibraryStore,
    /// `conflictPolicy` (when the request doesn't choose) and `backups`.
    pub settings: &'a Settings,
    pub client: &'a dyn WtLiveClient,
}

/// A checked install, ready to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub install_id: String,
    pub post_id: String,
    pub mode: InstallMode,
    /// What happens to the installed version of this post (`None`: it isn't installed).
    pub policy: Option<ConflictPolicy>,
}

impl Job {
    /// Only reports `done` / "skipped" (installed, and the policy is Skip).
    pub fn is_skip(&self) -> bool {
        self.policy == Some(ConflictPolicy::Skip)
    }
}

/// Checks a request: the client is ready, `UserSkins` exists, the post isn't installing, and an
/// installed version is settled by `conflict` or Settings → Conflicts (Ask → `conflict`). Claims
/// the post in `installing` unless the job is a skip (the caller releases it after [`run`]).
pub fn prepare(
    ctx: &Ctx,
    installing: &Installing,
    post_id: &str,
    mode: InstallMode,
    conflict: Option<ConflictPolicy>,
) -> AppResult<Job> {
    ctx.client.ready()?;
    if !ctx.user_skins.is_dir() {
        return Err(AppError::new(ErrorCode::NotFound, USER_SKINS_GONE));
    }
    if installing.contains(post_id) {
        return Err(AppError::new(ErrorCode::InvalidInput, ALREADY_INSTALLING).with_detail(post_id.to_owned()));
    }
    let library = ctx.library.snapshot();
    let installed = library.skins.iter().find(|s| s.source_id.as_deref() == Some(post_id) && !s.temporary);
    let policy = installed.map(|_| conflict.unwrap_or(ctx.settings.conflict_policy));
    if policy == Some(ConflictPolicy::Ask) {
        let folder = installed.map(|s| s.folder.clone()).unwrap_or_default();
        return Err(AppError::new(ErrorCode::Conflict, ALREADY_INSTALLED).with_detail(folder));
    }
    let job = Job { install_id: new_id_with("i"), post_id: post_id.to_owned(), mode, policy };
    if !job.is_skip() && !installing.claim(post_id) {
        return Err(AppError::new(ErrorCode::InvalidInput, ALREADY_INSTALLING).with_detail(post_id.to_owned()));
    }
    tracing::info!(post = post_id, install_id = %job.install_id, ?mode, ?policy, "WT Live install started");
    Ok(job)
}

/// Runs a checked install to the end, reporting through `emit`. Returns the installed skin
/// (`None` for a skip).
pub fn run(ctx: &Ctx, job: &Job, emit: &mut dyn FnMut(&InstallProgress)) -> AppResult<Option<HangarSkin>> {
    let mut reporter = Reporter::for_install(emit, job.install_id.clone(), None);
    if job.is_skip() {
        reporter.finish(InstallStep::Done, Some(SKIPPED.to_owned()), None, None);
        return Ok(None);
    }
    match execute(ctx, job, &mut reporter) {
        Ok((skin, backup_id)) => {
            tracing::info!(post = %job.post_id, skin = %skin.id, "WT Live skin installed");
            reporter.finish(InstallStep::Done, None, Some(skin.id.clone()), backup_id);
            Ok(Some(skin))
        }
        Err(e) => {
            tracing::warn!(post = %job.post_id, error = %e, "WT Live install failed");
            reporter.finish(InstallStep::Error, Some(e.message.clone()), None, None);
            Err(e)
        }
    }
}

fn download_pct(p: DownloadProgress) -> u8 {
    match p.total {
        Some(total) if total > 0 => {
            u8::try_from(u128::from(p.received.min(total)) * 100 / u128::from(total)).unwrap_or(100)
        }
        _ => 0,
    }
}

fn execute(ctx: &Ctx, job: &Job, reporter: &mut Reporter) -> AppResult<(HangarSkin, Option<String>)> {
    reporter.rebase(0);
    reporter.tick(InstallStep::Download, 0);
    // Download pct 0–100 of the file maps onto 0–DOWNLOAD_END of the install.
    let archive = ctx.client.archive(&job.post_id, &mut |p| {
        let pct = u16::from(download_pct(p)) * u16::from(DOWNLOAD_END) / 100;
        reporter.tick(InstallStep::Download, u8::try_from(pct).unwrap_or(DOWNLOAD_END));
    })?;
    reporter.mark(InstallStep::Download, DOWNLOAD_END);
    let post = ctx.client.post(&job.post_id)?;
    let source = open_source(&archive)?;
    let root = pick_root(source.as_ref(), &post)?;
    let folder = folder_for(&root, &post);
    reporter.rebase(DOWNLOAD_END);
    let staged = stage(ctx.user_skins, &job.install_id, &root, &folder, source.as_ref(), reporter)?;
    commit(ctx, job, &post, &folder, staged)
}

/// The skin inside the archive: the only one, or the one for the post's vehicle, else the first.
fn pick_root(source: &dyn SkinSource, post: &WtLiveSkin) -> AppResult<SkinRoot> {
    let analysis = analyze::analyze_source(source, &post.name)?;
    let mut roots = analysis.roots;
    if roots.len() > 1 {
        tracing::info!(roots = roots.len(), post = %post.id, "WT Live archive holds several skins; installing one");
    }
    let code = post.vehicle.code.as_str();
    let pos = roots
        .iter()
        .position(|r| {
            !code.is_empty() && (r.vehicle.code.eq_ignore_ascii_case(code) || r.blk_stem().eq_ignore_ascii_case(code))
        })
        .unwrap_or(0);
    if roots.is_empty() {
        return Err(AppError::new(ErrorCode::InvalidInput, NO_BLK_ERROR).with_detail(post.id.clone()));
    }
    Ok(roots.swap_remove(pos))
}

/// `<vehicle code>_<author>` (the `.blk` stem when the code is unknown), as a valid folder name.
pub fn folder_for(root: &SkinRoot, post: &WtLiveSkin) -> String {
    let code = if root.vehicle.code.is_empty() { root.blk_stem() } else { root.vehicle.code.as_str() };
    analyze::sanitize_folder_name(&format!("{code}_{}", post.author.name), code)
}

/// Step 3: moves the staged skin into place and indexes it, in one library transaction.
fn commit(
    ctx: &Ctx,
    job: &Job,
    post: &WtLiveSkin,
    base_folder: &str,
    staged: Staged,
) -> AppResult<(HangarSkin, Option<String>)> {
    let user_skins = ctx.user_skins;
    let temporary = job.mode == InstallMode::Temporary;
    let now = SystemTime::now();
    ctx.library.transact(|library, journal| {
        let installed =
            library.skins.iter().position(|s| s.source_id.as_deref() == Some(post.id.as_str()) && !s.temporary);
        let tried = library.skins.iter().position(|s| s.source_id.as_deref() == Some(post.id.as_str()) && s.temporary);
        let mut name = post.name.clone();
        let mut id = new_id();
        let mut backup_id = None;
        let (folder, active) = match (job.policy, installed, tried) {
            // Replace the installed version (backed up first). A try of the same post goes too.
            (Some(ConflictPolicy::Replace), Some(i), _) => {
                let old = library.skins[i].clone();
                if let Some(t) = tried {
                    let old_try = library.skins[t].clone();
                    library.tried_backups.remove(&old_try.id);
                    drop_tried(user_skins, library, journal, &old_try.folder, now)?;
                }
                let clash = find_clash(user_skins, library, &old.folder)
                    .ok_or_else(|| AppError::new(ErrorCode::NotFound, "The installed version's folder is gone"))?;
                // A try keeps the backup whatever Settings say: Discard puts it back.
                let keep = ctx.settings.backups || temporary;
                let backup = replace(user_skins, library, journal, &clash, keep, now)?;
                if temporary {
                    library.tried_backups.insert(id.clone(), backup.clone());
                }
                backup_id = Some(backup);
                (old.folder, old.active)
            }
            // A new install of a post being tried takes over the try (its folder and id).
            (policy, _, Some(t)) if policy != Some(ConflictPolicy::Copy) => {
                let old = library.skins[t].clone();
                id = old.id.clone();
                let replaced = library.tried_backups.remove(&old.id);
                drop_tried(user_skins, library, journal, &old.folder, now)?;
                if temporary {
                    if let Some(b) = replaced {
                        library.tried_backups.insert(id.clone(), b);
                    }
                }
                (old.folder, old.active)
            }
            (policy, _, _) => {
                if policy == Some(ConflictPolicy::Copy) {
                    let same_post: Vec<String> = library
                        .skins
                        .iter()
                        .filter(|s| s.source_id.as_deref() == Some(post.id.as_str()))
                        .map(|s| s.name.to_lowercase())
                        .collect();
                    name = layout::unique_name(&post.name, |n| same_post.contains(&n.to_lowercase()));
                }
                let folder = match find_clash(user_skins, library, base_folder) {
                    None => base_folder.to_owned(),
                    Some(_) => free_name(user_skins, library, base_folder),
                };
                (folder, true)
            }
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
        rename_retrying(journal, &staged.dir, &dest).map_err(install_error)?;
        let skin = HangarSkin {
            id,
            name,
            folder,
            origin: Origin::Wtlive,
            author: Some(post.author.clone()),
            active,
            installed_at: time::rfc3339_utc(now),
            source_id: Some(post.id.clone()),
            temporary,
            ..staged.scanned.clone()
        };
        library.skins.push(skin.clone());
        Ok((skin, backup_id))
    })
}

/// Removes a try's folder and index entry inside a transaction (an ephemeral backup, purged
/// within a minute, so a failed transaction can still put it back).
fn drop_tried(
    user_skins: &Path,
    library: &mut crate::library::index::Library,
    journal: &mut layout::Journal,
    folder: &str,
    now: SystemTime,
) -> AppResult<()> {
    if let Some(clash) = find_clash(user_skins, library, folder) {
        replace(user_skins, library, journal, &clash, false, now)?;
    }
    Ok(())
}

/// Try in game → Keep (`temporary` cleared; the skin is returned) or Discard (removed, and a
/// version it replaced comes back from its backup; `None`). `post_id` is the WT Live id. On Keep,
/// the backup of a replaced version follows Settings → Backups (`keep_backups`): kept like any
/// backup, or Undo-only (gone within a minute) when backups are off.
pub fn finalize(
    user_skins: &Path,
    store: &LibraryStore,
    post_id: &str,
    keep: bool,
    keep_backups: bool,
) -> AppResult<Option<HangarSkin>> {
    let library = store.snapshot();
    let tried = library
        .skins
        .iter()
        .find(|s| s.source_id.as_deref() == Some(post_id) && s.temporary)
        .cloned()
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, NOT_TRIED).with_detail(post_id.to_owned()))?;
    if keep {
        return store
            .transact(|library, _| {
                if let Some(backup_id) = library.tried_backups.remove(&tried.id) {
                    if !keep_backups {
                        if let Some(record) = library.backups.iter_mut().find(|r| r.backup.id == backup_id) {
                            record.ephemeral = true;
                            record.backup.created_at = time::rfc3339_utc(SystemTime::now());
                        }
                    }
                }
                let skin = library
                    .skins
                    .iter_mut()
                    .find(|s| s.id == tried.id)
                    .ok_or_else(|| AppError::new(ErrorCode::NotFound, NOT_TRIED).with_detail(post_id.to_owned()))?;
                skin.temporary = false;
                Ok(Some(skin.clone()))
            })
            .inspect(|_| tracing::info!(post = post_id, "tried skin kept"));
    }
    discard(user_skins, store, &tried)?;
    tracing::info!(post = post_id, "tried skin discarded");
    Ok(None)
}

fn discard(user_skins: &Path, store: &LibraryStore, tried: &HangarSkin) -> AppResult<()> {
    let replaced = store.snapshot().tried_backups.get(&tried.id).cloned();
    if let Some(backup_id) = replaced {
        match undo_replace(user_skins, store, &tried.id, &backup_id) {
            Ok(_) => {
                store.transact(|library, _| {
                    library.tried_backups.remove(&tried.id);
                    Ok(())
                })?;
                return Ok(());
            }
            Err(e) => tracing::warn!(error = %e, "the version a try replaced can't come back; removing the try only"),
        }
    }
    ops::delete(user_skins, store, std::slice::from_ref(&tried.id), false, SystemTime::now())?;
    store.transact(|library, _| {
        library.tried_backups.remove(&tried.id);
        Ok(())
    })
}

/// Discards every try left by a session that ended: those installed before `launched` (a try
/// started in the first seconds of this session stays). Returns how many went.
pub fn purge_tries(user_skins: &Path, store: &LibraryStore, launched: SystemTime) -> usize {
    let launched = time::unix_secs(launched);
    let tries: Vec<HangarSkin> = store
        .snapshot()
        .skins
        .into_iter()
        .filter(|s| s.temporary && time::parse_rfc3339(&s.installed_at).map_or(true, |at| at < launched))
        .collect();
    let mut removed = 0;
    for tried in &tries {
        match discard(user_skins, store, tried) {
            Ok(()) => removed += 1,
            Err(e) => tracing::warn!(error = %e, skin = %tried.id, "a try left by the last session can't be removed"),
        }
    }
    removed
}

/// The texture list of a post that isn't installed: its archive (downloaded into the cache if
/// needed) read without unpacking. With several skins, each file is prefixed with `<folder>/`.
pub fn post_textures(client: &dyn WtLiveClient, post_id: &str) -> AppResult<Vec<TextureInfo>> {
    client.ready()?;
    let archive = client.archive(post_id, &mut |_| {})?;
    let post = client.post(post_id)?;
    let source = open_source(&archive)?;
    let analysis = analyze::analyze_source(source.as_ref(), &post.name)?;
    if analysis.roots.is_empty() {
        return Err(AppError::new(ErrorCode::InvalidInput, NO_BLK_ERROR).with_detail(post_id.to_owned()));
    }
    let several = analysis.roots.len() > 1;
    let mut list = Vec::new();
    for root in &analysis.roots {
        let textures = archive_textures(source.as_ref(), root)?;
        if several {
            list.extend(
                textures.into_iter().map(|t| TextureInfo { file: format!("{}/{}", root.target_folder, t.file), ..t }),
            );
        } else {
            list = textures;
        }
    }
    Ok(list)
}
