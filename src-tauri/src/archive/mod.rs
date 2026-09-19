//! Install queue (M4): skin sources, analysis, staged install into `UserSkins` with
//! `install://progress` events, conflict policies and Undo of a Replace.
//!
//! - `source`: what a dropped or watched path holds ([`SkinSource`]); folders today, ZIP/RAR/7z
//!   once their unpacking crates are approved (until then they become `error` items);
//! - `analyze`: skin roots, vehicle, target folder, name clashes → a [`QueueItem`];
//! - `install`: copy into `UserSkins/.livery/partial/<installId>/<folder>` (with the
//!   `.livery-partial` marker), verify, then one atomic rename into place inside a library
//!   transaction (Replace backs the old version up first); Undo of a Replace.
//!
//! The queue lives in memory for the session ([`QueueStore`], newest first). The work is in plain
//! functions taking paths and stores, so tests run it without Tauri; the commands only gather
//! their inputs, hop onto a blocking thread, and run installs on a background thread of their
//! own.

pub mod analyze;
pub mod install;
pub mod source;

pub use analyze::{analyze_path, analyze_source, sanitize_folder_name, Analysis, Queued, SkinRoot};
// `install::undo_replace` is the plain function behind the `undo_replace` command below.
pub use install::{prepare, purge_partials, run, run_with_source, Ctx, InstallJob};
pub use source::{open_source, ExtractTick, FolderSource, SkinSource, SourceEntry, UNSUPPORTED_ARCHIVES};

use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::root;
use crate::library::index::{folder_key, Library};
use crate::library::{self, layout, LibraryStore};
use crate::model::{ConflictPolicy, HangarSkin, InstallStarted, QueueItem, QueueStatus, TextureInfo};
use crate::settings::SettingsStore;
use crate::textures;
use analyze::Conflict;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager};

/// Event names emitted by this module.
pub const PROGRESS_EVENT: &str = "install://progress";
pub const QUEUE_ADDED_EVENT: &str = "queue://added";

/// Sub-folder of `UserSkins/.livery` where installs are staged (and Undo parks what it removes).
pub const PARTIAL_DIR: &str = "partial";

/// `notFound` message for a queue id the store doesn't know (removed, or from another session).
pub const NOT_IN_QUEUE: &str = "This item is no longer in the queue";

/// `UserSkins/.livery/partial`.
pub fn partial_dir(user_skins: &Path) -> PathBuf {
    layout::livery_dir(user_skins).join(PARTIAL_DIR)
}

/// One queued source with what the analysis learned about it.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub item: QueueItem,
    /// The dropped or watched path.
    pub source: PathBuf,
    /// Skin roots inside; one once a vehicle was picked.
    pub roots: Vec<SkinRoot>,
    /// Why the source can't be opened (unsupported archive); returned by install / textures.
    pub failure: Option<AppError>,
    /// The skin this item installed (drives the queue side of Undo).
    pub installed_skin: Option<String>,
}

impl Entry {
    fn single_root(&self) -> Option<&SkinRoot> {
        match self.roots.as_slice() {
            [root] => Some(root),
            _ => None,
        }
    }
}

/// Queue items analysed this session, newest first. Not persisted.
#[derive(Default)]
pub struct QueueStore {
    entries: Mutex<Vec<Entry>>,
    /// `UserSkins` folders (path keys) whose stale staging was already purged this session.
    purged: Mutex<HashSet<String>>,
}

impl QueueStore {
    /// Every item, newest first.
    pub fn list(&self) -> Vec<QueueItem> {
        self.lock().iter().map(|e| e.item.clone()).collect()
    }

    pub fn get(&self, queue_id: &str) -> Option<QueueItem> {
        self.lock().iter().find(|e| e.item.id == queue_id).map(|e| e.item.clone())
    }

    /// Forgets an item (nothing on disk changes). Unknown ids are fine; an item that is
    /// installing can't be removed (`invalidInput`). Returns the other items whose status
    /// changed because of it (e.g. no longer queued under the same folder name).
    pub fn remove(&self, queue_id: &str, user_skins: Option<&Path>, library: &Library) -> AppResult<Vec<QueueItem>> {
        let mut entries = self.lock();
        let Some(pos) = entries.iter().position(|e| e.item.id == queue_id) else { return Ok(Vec::new()) };
        if entries[pos].item.status == QueueStatus::Installing {
            return Err(AppError::new(ErrorCode::InvalidInput, "Wait for the install to finish").with_detail(queue_id));
        }
        let before = items_of(&entries);
        entries.remove(pos);
        refresh(&mut entries, user_skins, library);
        Ok(changed_since(&before, &entries))
    }

    /// After an Undo of a Replace: the items that installed `skin_id` are waiting again (and now
    /// clash with the restored version). Returns every item whose status changed.
    pub fn reopen_installed(&self, skin_id: &str, user_skins: Option<&Path>, library: &Library) -> Vec<QueueItem> {
        let mut entries = self.lock();
        let before = items_of(&entries);
        for entry in entries.iter_mut().filter(|e| e.installed_skin.as_deref() == Some(skin_id)) {
            entry.installed_skin = None;
            if let Some(root) = entry.single_root() {
                entry.item = analyze::single_item(&entry.item, root, None);
            }
        }
        refresh(&mut entries, user_skins, library);
        changed_since(&before, &entries)
    }

    /// Stores a fresh analysis (see `analyze_path` for how a path already queued is handled),
    /// then brings every waiting item's clash status up to date.
    pub(crate) fn put(&self, mut entry: Entry, user_skins: Option<&Path>, library: &Library) -> Queued {
        let key = root::path_key(&entry.source);
        let mut entries = self.lock();
        let before = items_of(&entries);
        let same = entries.iter().position(|e| e.item.status != QueueStatus::Done && root::path_key(&e.source) == key);
        let id = match same {
            Some(pos) if entries[pos].item.status == QueueStatus::Installing => {
                return Queued { item: entries[pos].item.clone(), changed: Vec::new() };
            }
            Some(pos) => {
                entry.item.id = entries[pos].item.id.clone();
                entries[pos] = entry;
                entries[pos].item.id.clone()
            }
            None => {
                entry.item.id = library::index::new_id_with("q");
                let id = entry.item.id.clone();
                entries.insert(0, entry);
                id
            }
        };
        refresh(&mut entries, user_skins, library);
        let item = entries.iter().find(|e| e.item.id == id).map(|e| e.item.clone()).expect("the item was just stored");
        let changed = changed_since(&before, &entries).into_iter().filter(|i| i.id != id).collect();
        Queued { item, changed }
    }

    /// Runs `change` on the entries, then refreshes clash statuses; returns what `change`
    /// returned and every item whose status changed.
    pub(crate) fn update<T>(
        &self,
        user_skins: Option<&Path>,
        library: &Library,
        change: impl FnOnce(&mut Vec<Entry>) -> T,
    ) -> (T, Vec<QueueItem>) {
        let mut entries = self.lock();
        let before = items_of(&entries);
        let value = change(&mut entries);
        refresh(&mut entries, user_skins, library);
        let changed = changed_since(&before, &entries);
        (value, changed)
    }

    /// Removes what interrupted installs left in `UserSkins/.livery/partial`, once per
    /// `UserSkins` folder and session, before this session stages anything there.
    pub fn ensure_partials_purged(&self, user_skins: &Path) {
        let mut purged = self.purged.lock().unwrap_or_else(|e| e.into_inner());
        if purged.insert(root::path_key(user_skins)) {
            let removed = purge_partials(user_skins);
            if removed > 0 {
                tracing::info!(removed, "stale install staging removed");
            }
        }
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Vec<Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn items_of(entries: &[Entry]) -> Vec<QueueItem> {
    entries.iter().map(|e| e.item.clone()).collect()
}

/// Items that are new or differ from `before` (matched by id).
fn changed_since(before: &[QueueItem], entries: &[Entry]) -> Vec<QueueItem> {
    let old: HashMap<&str, &QueueItem> = before.iter().map(|i| (i.id.as_str(), i)).collect();
    entries.iter().filter(|e| old.get(e.item.id.as_str()) != Some(&&e.item)).map(|e| e.item.clone()).collect()
}

/// Recomputes ready/conflict for every waiting single-skin item, oldest first: a folder name
/// taken on disk (or in the inactive folder) is a conflict with that skin; otherwise one an
/// older waiting or installing item will use is a conflict with that item (`queue:<id>`).
/// Items that are installing, installed, failed or still need a pick are left alone.
fn refresh(entries: &mut [Entry], user_skins: Option<&Path>, library: &Library) {
    let mut claims: HashMap<String, String> = HashMap::new();
    for entry in entries.iter_mut().rev() {
        let Some(root) = entry.single_root() else { continue };
        let key = folder_key(&root.target_folder);
        match entry.item.status {
            QueueStatus::Installing => {}
            QueueStatus::Ready | QueueStatus::Conflict => {
                let conflict = user_skins
                    .and_then(|us| analyze::find_clash(us, library, &root.target_folder))
                    .map(|clash| Conflict::installed(&clash, library))
                    .or_else(|| claims.get(&key).map(|owner| Conflict::queued(owner, &root.target_folder)));
                let next = analyze::single_item(&entry.item, root, conflict);
                if next != entry.item {
                    entry.item = next;
                }
            }
            _ => continue,
        }
        claims.entry(key).or_insert_with(|| entry.item.id.clone());
    }
}

/// The texture list of a queued item, read from its source: the skin's folder as it is (plain
/// folders). An item with several skins lists them all, each file prefixed with `<folder>/`.
/// `notFound` for an unknown id; the item's own error (`unsupported` for archives,
/// `invalidInput` when there's no skin) when it holds nothing to read.
pub fn textures_for_queue(queue: &QueueStore, queue_id: &str) -> AppResult<Vec<TextureInfo>> {
    let entry = queue
        .lock()
        .iter()
        .find(|e| e.item.id == queue_id)
        .cloned()
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, NOT_IN_QUEUE).with_detail(queue_id))?;
    if entry.roots.is_empty() {
        return Err(entry.failure.unwrap_or_else(|| AppError::new(ErrorCode::InvalidInput, analyze::NO_BLK_ERROR)));
    }
    let source = open_source(&entry.source)?;
    let several = entry.roots.len() > 1;
    let mut list = Vec::new();
    for root in &entry.roots {
        let dir = source.local_dir(&root.dir).ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, source::SOURCE_GONE).with_detail(root::display_path(&entry.source))
        })?;
        let textures = textures::inspect_skin(&dir)?;
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

// ── App glue ────────────────────────────────────────────────────────────────

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(error = %e, "could not emit {event}");
    }
}

/// Re-sends items whose status changed (the UI upserts `queue://added` payloads by id).
fn emit_changed(app: &AppHandle, items: &[QueueItem]) {
    for item in items {
        emit(app, QUEUE_ADDED_EVENT, item);
    }
}

/// `UserSkins`, when a game folder is set.
fn user_skins(app: &AppHandle) -> Option<PathBuf> {
    library::user_skins_dir(&app.state::<SettingsStore>().get()).ok()
}

/// Analyses `path` and queues it (drop, browse, or the folder watcher). Blocking. The caller
/// shows or emits `item`; `changed` are other items to re-send.
pub fn queue_path(app: &AppHandle, path: &str) -> AppResult<Queued> {
    let path = root::native_path(path.trim().trim_matches('"'));
    let user_skins = user_skins(app);
    analyze_path(&path, user_skins.as_deref(), &app.state::<LibraryStore>(), &app.state::<QueueStore>())
}

/// Checks and starts an install (see `install::prepare`), then runs it on a background thread
/// that reports through `install://progress`. Blocking; answers at once with the install id.
pub fn start_install(
    app: &AppHandle,
    queue_id: &str,
    vehicle_code: Option<&str>,
    conflict: Option<ConflictPolicy>,
) -> AppResult<InstallStarted> {
    library::purge_expired(app, &[]);
    let settings = app.state::<SettingsStore>().get();
    let user_skins = library::user_skins_dir(&settings)?;
    let job = {
        let library = app.state::<LibraryStore>();
        let queue = app.state::<QueueStore>();
        let ctx = Ctx { user_skins: &user_skins, library: &library, queue: &queue, settings: &settings };
        install::prepare(&ctx, queue_id, vehicle_code, conflict)?
    };
    let started = InstallStarted { install_id: job.install_id.clone() };
    let refresh_in = user_skins.clone();
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new().name("livery-install".into()).spawn(move || {
        let app = thread_app;
        let library = app.state::<LibraryStore>();
        let queue = app.state::<QueueStore>();
        let ctx = Ctx { user_skins: &user_skins, library: &library, queue: &queue, settings: &settings };
        let changed = install::run(&ctx, job, &mut |progress| emit(&app, PROGRESS_EVENT, progress));
        emit_changed(&app, &changed);
    });
    if let Err(e) = spawned {
        // The job went down with the closure: the item must not stay "installing".
        let library = app.state::<LibraryStore>().snapshot();
        let message = "Could not start the install";
        // With `UserSkins` given, so the refresh keeps the other items' clashes on disk.
        let (_, changed) = app.state::<QueueStore>().update(Some(&refresh_in), &library, |entries| {
            if let Some(entry) = entries.iter_mut().find(|e| e.item.id == queue_id) {
                entry.item.status = QueueStatus::Error;
                entry.item.error = Some(message.to_owned());
            }
        });
        emit_changed(app, &changed);
        return Err(AppError::new(ErrorCode::Internal, message).with_detail(e.to_string()));
    }
    Ok(started)
}

/// Removes staging left by interrupted installs, off the main thread; call once at startup,
/// after the settings and queue stores are managed. Does nothing while no game folder is set.
pub fn purge_on_startup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(user_skins) = user_skins(&app) {
            app.state::<QueueStore>().ensure_partials_purged(&user_skins);
        }
    });
}

/// Looks inside a dropped/watched skin folder or archive without installing anything, and
/// queues it. ZIP/RAR/7z come back as `error` items (unpacking isn't available yet).
#[tauri::command]
pub async fn analyze_archive(app: AppHandle, path: String) -> AppResult<QueueItem> {
    blocking(move || {
        let queued = queue_path(&app, &path)?;
        emit_changed(&app, &queued.changed);
        Ok(queued.item)
    })
    .await
}

/// Installs a queued item; progress arrives as `install://progress` events. `conflict` overrides
/// Settings → Conflicts; with `ask` and a taken folder name it fails with `conflict` so the UI
/// can ask.
#[tauri::command]
pub async fn install_from_archive(
    app: AppHandle,
    queue_id: String,
    vehicle_code: Option<String>,
    conflict: Option<ConflictPolicy>,
) -> AppResult<InstallStarted> {
    blocking(move || start_install(&app, &queue_id, vehicle_code.as_deref(), conflict)).await
}

/// Items analysed this session, newest first.
#[tauri::command]
pub async fn list_queue(app: AppHandle) -> AppResult<Vec<QueueItem>> {
    blocking(move || {
        let queue = app.state::<QueueStore>();
        if let Some(user_skins) = user_skins(&app) {
            queue.ensure_partials_purged(&user_skins);
        }
        Ok(queue.list())
    })
    .await
}

/// Forgets a queue item (nothing on disk changes). Unknown ids are ignored.
#[tauri::command]
pub async fn remove_queue_item(app: AppHandle, queue_id: String) -> AppResult<()> {
    blocking(move || {
        let library = app.state::<LibraryStore>().snapshot();
        let changed = app.state::<QueueStore>().remove(&queue_id, user_skins(&app).as_deref(), &library)?;
        emit_changed(&app, &changed);
        Ok(())
    })
    .await
}

/// Undo for "Replace, keep a backup": removes the new version and puts the old one back.
#[tauri::command]
pub async fn undo_replace(app: AppHandle, skin_id: String, backup_id: String) -> AppResult<HangarSkin> {
    blocking(move || {
        // The Undo in progress must not lose its backup to the purge that runs first.
        library::purge_expired(&app, std::slice::from_ref(&backup_id));
        let settings = app.state::<SettingsStore>().get();
        let user_skins = library::user_skins_dir(&settings)?;
        let queue = app.state::<QueueStore>();
        queue.ensure_partials_purged(&user_skins);
        let store = app.state::<LibraryStore>();
        let restored = install::undo_replace(&user_skins, &store, &skin_id, &backup_id)?;
        let changed = queue.reopen_installed(&skin_id, Some(&user_skins), &store.snapshot());
        emit_changed(&app, &changed);
        Ok(restored)
    })
    .await
}
