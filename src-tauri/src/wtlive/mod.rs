//! WT Live (M5): Explore search, posts, Following, For you, installs from WT Live and Try in game.
//!
//! # Layout
//! - [`client`]: the [`WtLiveClient`] trait the commands use, and the [`DisabledClient`].
//! - [`live`]: the real client, [`LiveClient`]: WT Live's JSON endpoints ([`api`]) through a
//!   polite HTTPS transport ([`net`]: one request a second, backoff, robots.txt, WT Live hosts
//!   only), a disk cache of at most a day ([`cache`]) and the posts the user hid ([`hidden`]).
//!   The README's Privacy section is the posture it follows.
//! - [`install`]: installs from WT Live, Try in game (Keep / Discard), textures before installing.
//! - [`following`] keeps `<appData>/following.json`, [`for_you`] `<appData>/for_you.json`.
//! - this file: the managed state [`WtLive`], the commands, and the plain functions behind them
//!   (tested without Tauri in `tests/wtlive_*.rs` and `tests/following_*.rs`).
//!
//! # Network status
//! Every call that reaches WT Live emits `net://status` from its outcome: a success → online;
//! `network` or `unsupported` (turned off in Settings, robots.txt says no, the disabled client)
//! → offline; other errors (a blank id, a post that's gone) say nothing. Local work (Keep /
//! Discard, the storage commands) never emits it. Nothing reaches WT Live unless a command asks:
//! no prefetch, no polling, nothing at startup but clearing the cache of what is over a day old.

pub mod api;
pub mod cache;
pub mod client;
pub mod following;
pub mod for_you;
pub mod hidden;
pub mod install;
pub mod live;
pub mod net;
pub mod text;

pub use client::{
    is_offline_error, turned_off, unsupported, DisabledClient, DownloadProgress, WtLiveClient, TURNED_OFF_MESSAGE,
    UNSUPPORTED_MESSAGE,
};
pub use following::{FollowingStore, FOLLOWING_FILE};
pub use for_you::{ForYouStore, FOR_YOU_FILE};
pub use live::LiveClient;

use crate::archive::{QueueStore, PROGRESS_EVENT};
use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::{self, GameLibrary};
use crate::model::{
    ConflictPolicy, FollowEntry, FollowKind, ForYouNew, HangarSkin, InstallMode, InstallStarted, SearchParams,
    SearchResult, TextureInfo, WtLiveSkin, WtLiveStorage,
};
use cache::DiskCache;
use hidden::HiddenStore;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// Emitted after WT Live calls: whether WT Live can be reached.
pub const NET_STATUS_EVENT: &str = "net://status";

/// `invalidInput` message for a blank WT Live skin id.
pub const MISSING_SKIN_ID: &str = "Pass the id of a WT Live skin";

/// Payload of [`NET_STATUS_EVENT`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatus {
    pub online: bool,
}

/// Whether Settings → WT Live → Browse WT Live is on (read on every call).
pub type EnabledFn = Arc<dyn Fn() -> bool + Send + Sync>;

/// Managed state: the WT Live client, the Following list, For you's seen state, the hidden posts
/// and the cache.
pub struct WtLive {
    client: Arc<dyn WtLiveClient>,
    following: FollowingStore,
    for_you: ForYouStore,
    hidden: Arc<HiddenStore>,
    cache: Arc<DiskCache>,
    installing: install::Installing,
}

impl WtLive {
    /// The app's state: the [`LiveClient`] over HTTPS, browsing while `enabled()` says so, with
    /// its files in `data_dir`.
    pub fn load(data_dir: &Path, enabled: EnabledFn) -> Self {
        let cache = Arc::new(DiskCache::new(data_dir.join(cache::CACHE_DIR)));
        let hidden = Arc::new(HiddenStore::load(data_dir.join(hidden::HIDDEN_FILE)));
        let transport = Arc::new(net::HttpTransport::new());
        let client = Arc::new(LiveClient::new(transport, Arc::clone(&cache), Arc::clone(&hidden), enabled));
        Self::with_parts(client, data_dir.join(FOLLOWING_FILE), hidden, cache)
    }

    /// Another client (tests), with the Following list at `following_path` and For you's seen
    /// state, the hidden posts and the cache next to it.
    pub fn with_client(client: Arc<dyn WtLiveClient>, following_path: PathBuf) -> Self {
        let dir = following_path.parent().map(Path::to_path_buf).unwrap_or_default();
        let cache = Arc::new(DiskCache::new(dir.join(cache::CACHE_DIR)));
        let hidden = Arc::new(HiddenStore::load(dir.join(hidden::HIDDEN_FILE)));
        Self::with_parts(client, following_path, hidden, cache)
    }

    /// The state from its parts; For you's seen state sits next to the Following list.
    pub fn with_parts(
        client: Arc<dyn WtLiveClient>,
        following_path: PathBuf,
        hidden: Arc<HiddenStore>,
        cache: Arc<DiskCache>,
    ) -> Self {
        let dir = following_path.parent().map(Path::to_path_buf).unwrap_or_default();
        Self {
            client,
            for_you: ForYouStore::load(dir.join(FOR_YOU_FILE)),
            following: FollowingStore::load(following_path),
            hidden,
            cache,
            installing: install::Installing::default(),
        }
    }

    pub fn client(&self) -> Arc<dyn WtLiveClient> {
        Arc::clone(&self.client)
    }

    pub fn following(&self) -> &FollowingStore {
        &self.following
    }

    pub fn for_you(&self) -> &ForYouStore {
        &self.for_you
    }

    pub fn hidden(&self) -> &HiddenStore {
        &self.hidden
    }

    pub fn cache(&self) -> &DiskCache {
        &self.cache
    }

    pub fn installing(&self) -> &install::Installing {
        &self.installing
    }

    /// Settings → WT Live: cache size and hidden posts.
    pub fn storage(&self) -> WtLiveStorage {
        WtLiveStorage { cache_bytes: self.cache.size(), hidden_count: self.hidden.count() }
    }
}

// ── Plain functions behind the commands ─────────────────────────────────────

/// The commands of this module whose outcome may say something about reaching WT Live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WtLiveCall {
    Search,
    Post,
    FollowingNew,
    VehicleTop,
    ForYouNew,
    Install,
    /// `read_textures { wtliveId }`.
    Textures,
    /// Keep or discard a Try in game install: local work on a skin already on disk.
    FinalizeTry,
}

impl WtLiveCall {
    /// Whether the call talks to WT Live, so that its outcome drives `net://status`.
    /// `finalize_try` doesn't: a failure there says nothing about the network.
    pub fn reaches_wtlive(self) -> bool {
        !matches!(self, Self::FinalizeTry)
    }
}

/// What a WT Live call's outcome says about reaching WT Live: a success → online; `network` or
/// `unsupported` → offline; anything else (a blank id, an unknown post) says nothing.
pub fn net_status_of<T>(result: &AppResult<T>) -> Option<NetStatus> {
    match result {
        Ok(_) => Some(NetStatus { online: true }),
        Err(e) if is_offline_error(e) => Some(NetStatus { online: false }),
        Err(_) => None,
    }
}

/// The `net://status` a command emits after `result`: [`net_status_of`] for a call that reaches
/// WT Live, nothing for a local one ([`WtLiveCall::reaches_wtlive`]).
pub fn net_status_after<T>(call: WtLiveCall, result: &AppResult<T>) -> Option<NetStatus> {
    if call.reaches_wtlive() {
        net_status_of(result)
    } else {
        None
    }
}

/// `wtlive_post`: the full post.
pub fn post(client: &dyn WtLiveClient, id: &str) -> AppResult<WtLiveSkin> {
    client.post(required_id(id)?)
}

/// `wtlive_following_new`: new skins for the requested vehicles and authors, each counted from
/// its own `lastSeenAt` in `followed` (ids that aren't followed are left out).
pub fn following_new(
    client: &dyn WtLiveClient,
    followed: &[FollowEntry],
    vehicles: &[String],
    authors: &[String],
) -> AppResult<Vec<WtLiveSkin>> {
    client.following_new(&following::select(followed, vehicles, authors))
}

/// `wtlive_for_you_new`: new skins for the lineup vehicles since For you was last seen.
pub fn for_you_new(client: &dyn WtLiveClient, store: &ForYouStore, vehicles: &[String]) -> AppResult<ForYouNew> {
    // Unparseable can't happen (the store validates); if it did, nothing would count as new.
    let since = crate::library::time::parse_rfc3339(&store.last_seen_at()).unwrap_or(i64::MAX);
    // Blanks stay in place (they get no tags): `checked` counts positions in the UI's own list.
    let vehicles: Vec<String> = vehicles.iter().map(|v| v.trim().to_owned()).collect();
    client.for_you_new(&vehicles, since)
}

/// `read_textures { wtliveId }`: the texture headers of a post that isn't installed.
pub fn post_textures(client: &dyn WtLiveClient, id: &str) -> AppResult<Vec<TextureInfo>> {
    install::post_textures(client, required_id(id)?)
}

/// `finalize_try`: Keep or Discard the post's Try in game install (see [`install::finalize`]).
pub fn keep_or_discard(
    user_skins: &Path,
    store: &library::LibraryStore,
    skin_id: &str,
    keep: bool,
    keep_backups: bool,
) -> AppResult<Option<HangarSkin>> {
    install::finalize(user_skins, store, required_id(skin_id)?, keep, keep_backups)
}

pub fn required_id(id: &str) -> AppResult<&str> {
    match id.trim() {
        "" => Err(AppError::new(ErrorCode::InvalidInput, MISSING_SKIN_ID)),
        id => Ok(id),
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn wtlive_search(app: AppHandle, params: SearchParams) -> AppResult<SearchResult> {
    let client = client_of(&app);
    let handle = app.clone();
    let result = blocking(move || {
        crate::game::current_vehicles(&handle);
        client.search(&params)
    })
    .await;
    reported(&app, WtLiveCall::Search, result)
}

#[tauri::command]
pub async fn wtlive_post(app: AppHandle, id: String) -> AppResult<WtLiveSkin> {
    let client = client_of(&app);
    let handle = app.clone();
    let result = blocking(move || {
        crate::game::current_vehicles(&handle);
        let post = post(client.as_ref(), &id)?;
        crate::library::remember_preview(&handle, &post.id, post.images.first());
        Ok(post)
    })
    .await;
    reported(&app, WtLiveCall::Post, result)
}

#[tauri::command]
pub async fn wtlive_following_new(
    app: AppHandle,
    vehicles: Vec<String>,
    authors: Vec<String>,
) -> AppResult<Vec<WtLiveSkin>> {
    let handle = app.clone();
    let result = blocking(move || {
        crate::game::current_vehicles(&handle);
        let state = handle.state::<WtLive>();
        following_new(state.client().as_ref(), &state.following().list(), &vehicles, &authors)
    })
    .await;
    reported(&app, WtLiveCall::FollowingNew, result)
}

/// For you: the 3 most downloaded skins of one lineup vehicle.
#[tauri::command]
pub async fn wtlive_vehicle_top(app: AppHandle, code: String) -> AppResult<Vec<WtLiveSkin>> {
    let handle = app.clone();
    let result = blocking(move || {
        crate::game::current_vehicles(&handle);
        handle.state::<WtLive>().client().vehicle_top(&code)
    })
    .await;
    reported(&app, WtLiveCall::VehicleTop, result)
}

/// For you: new skins for the lineup vehicles (`vehicles` in display order) since For you was
/// last seen.
#[tauri::command]
pub async fn wtlive_for_you_new(app: AppHandle, vehicles: Vec<String>) -> AppResult<ForYouNew> {
    let handle = app.clone();
    let result = blocking(move || {
        crate::game::current_vehicles(&handle);
        let state = handle.state::<WtLive>();
        for_you_new(state.client().as_ref(), state.for_you(), &vehicles)
    })
    .await;
    reported(&app, WtLiveCall::ForYouNew, result)
}

#[tauri::command]
pub async fn install_from_wtlive(
    app: AppHandle,
    skin_id: String,
    mode: InstallMode,
    conflict: Option<ConflictPolicy>,
) -> AppResult<InstallStarted> {
    let handle = app.clone();
    let result = blocking(move || start_install(&handle, &skin_id, mode, conflict)).await;
    reported(&app, WtLiveCall::Install, result)
}

/// Checks and starts an install, then runs it on a background thread that reports through
/// `install://progress` (and `net://status` once the download ran). Blocking.
fn start_install(
    app: &AppHandle,
    skin_id: &str,
    mode: InstallMode,
    conflict: Option<ConflictPolicy>,
) -> AppResult<InstallStarted> {
    let post_id = required_id(skin_id)?.to_owned();
    let library = GameLibrary::current(app)?;
    library::purge_in(&library, &[]);
    let GameLibrary { settings, user_skins, store } = library;
    // Stale staging from a past session goes before anything is staged in this one.
    app.state::<QueueStore>().ensure_partials_purged(&user_skins);
    let state = app.state::<WtLive>();
    let client = state.client();
    let job = {
        let ctx =
            install::Ctx { user_skins: &user_skins, library: &store, settings: &settings, client: client.as_ref() };
        install::prepare(&ctx, state.installing(), &post_id, mode, conflict)?
    };
    let started = InstallStarted { install_id: job.install_id.clone() };
    let thread_app = app.clone();
    let thread_job = job.clone();
    let spawned = std::thread::Builder::new().name("livery-wtlive-install".into()).spawn(move || {
        let app = thread_app;
        let job = thread_job;
        // Released however the install ends (a panic included); a skip claimed nothing.
        let _claim = (!job.is_skip()).then(|| Release { app: app.clone(), post_id: job.post_id.clone() });
        let ctx =
            install::Ctx { user_skins: &user_skins, library: &store, settings: &settings, client: client.as_ref() };
        let result = install::run(&ctx, &job, &mut |progress| emit(&app, PROGRESS_EVENT, progress));
        if let Some(status) = net_status_of(&result) {
            emit(&app, NET_STATUS_EVENT, status);
        }
    });
    if let Err(e) = spawned {
        if !job.is_skip() {
            state.installing().release(&job.post_id);
        }
        return Err(AppError::new(ErrorCode::Internal, "Could not start the install").with_detail(e.to_string()));
    }
    Ok(started)
}

/// Gives a post's install claim back when dropped.
struct Release {
    app: AppHandle,
    post_id: String,
}

impl Drop for Release {
    fn drop(&mut self) {
        self.app.state::<WtLive>().installing().release(&self.post_id);
    }
}

/// Try in game: keep → the temporary install becomes a normal hangar skin; discard → removed,
/// and a version it replaced comes back. `skin_id` is the **WT Live** skin id (the hangar skin's
/// `source_id`), not a hangar id. Local: it never emits `net://status`.
#[tauri::command]
pub async fn finalize_try(app: AppHandle, skin_id: String, keep: bool) -> AppResult<Option<HangarSkin>> {
    let handle = app.clone();
    let result = blocking(move || {
        required_id(&skin_id)?;
        let library = GameLibrary::current(&handle)?;
        keep_or_discard(&library.user_skins, &library.store, &skin_id, keep, library.settings.backups)
    })
    .await;
    reported(&app, WtLiveCall::FinalizeTry, result)
}

/// `read_textures { wtliveId }` (called by `textures::read_textures`).
pub async fn read_post_textures(app: AppHandle, id: String) -> AppResult<Vec<TextureInfo>> {
    let client = client_of(&app);
    reported(&app, WtLiveCall::Textures, blocking(move || post_textures(client.as_ref(), &id)).await)
}

#[tauri::command]
pub async fn following_list(app: AppHandle) -> AppResult<Vec<FollowEntry>> {
    Ok(app.state::<WtLive>().following().list())
}

/// Follows (`follow: true`) or unfollows a vehicle or an author; returns the whole list. With
/// `lastSeenAt` (RFC 3339), a follow stores that `lastSeenAt` (the Undo of an unfollow), see
/// [`FollowingStore::set`].
#[tauri::command]
pub async fn following_set(
    app: AppHandle,
    kind: FollowKind,
    id: String,
    name: String,
    follow: bool,
    last_seen_at: Option<String>,
) -> AppResult<Vec<FollowEntry>> {
    blocking(move || app.state::<WtLive>().following().set(kind, &id, &name, follow, last_seen_at.as_deref())).await
}

/// Marks every followed entry as seen now (the Following tab's "N new" resets).
#[tauri::command]
pub async fn following_mark_seen(app: AppHandle) -> AppResult<Vec<FollowEntry>> {
    blocking(move || app.state::<WtLive>().following().mark_seen()).await
}

/// When For you was last seen (RFC 3339). Local. The UI doesn't need it (`wtlive_for_you_new`
/// reads it itself); it is there for diagnostics and tests.
#[tauri::command]
pub async fn for_you_seen(app: AppHandle) -> AppResult<String> {
    Ok(app.state::<WtLive>().for_you().last_seen_at())
}

/// Marks For you as seen now (its "N new" resets); returns the stored time. Local.
#[tauri::command]
pub async fn for_you_mark_seen(app: AppHandle) -> AppResult<String> {
    blocking(move || app.state::<WtLive>().for_you().mark_seen()).await
}

/// Settings → WT Live: cache size and hidden posts. Local.
#[tauri::command]
pub async fn wtlive_storage(app: AppHandle) -> AppResult<WtLiveStorage> {
    blocking(move || Ok(app.state::<WtLive>().storage())).await
}

/// Empties the WT Live cache. Local.
#[tauri::command]
pub async fn wtlive_clear_cache(app: AppHandle) -> AppResult<WtLiveStorage> {
    blocking(move || {
        let state = app.state::<WtLive>();
        state.cache().clear();
        Ok(state.storage())
    })
    .await
}

/// Hides a post from Explore and Following (`hidden: true`) or shows it again. Local.
#[tauri::command]
pub async fn wtlive_set_hidden(app: AppHandle, id: String, hidden: bool) -> AppResult<WtLiveStorage> {
    blocking(move || {
        let state = app.state::<WtLive>();
        state.hidden().set(required_id(&id)?, hidden)?;
        Ok(state.storage())
    })
    .await
}

/// Shows every hidden post again. Local.
#[tauri::command]
pub async fn wtlive_unhide_all(app: AppHandle) -> AppResult<WtLiveStorage> {
    blocking(move || {
        let state = app.state::<WtLive>();
        state.hidden().clear()?;
        Ok(state.storage())
    })
    .await
}

/// At launch, off the main thread: what the cache holds for more than a day goes, and so do the
/// Try in game installs a closed or crashed session left behind. Nothing is fetched.
pub fn purge_on_startup(app: &AppHandle) {
    let app = app.clone();
    let launched = std::time::SystemTime::now();
    tauri::async_runtime::spawn_blocking(move || {
        let removed = app.state::<WtLive>().cache().purge_expired();
        if removed > 0 {
            tracing::info!(removed, "expired WT Live cache files removed");
        }
        if let Ok(library) = GameLibrary::current(&app) {
            let discarded = install::purge_tries(&library.user_skins, &library.store, launched);
            if discarded > 0 {
                tracing::info!(discarded, "Try in game installs from the last session discarded");
            }
        }
    });
}

// ── App glue ────────────────────────────────────────────────────────────────

fn client_of(app: &AppHandle) -> Arc<dyn WtLiveClient> {
    app.state::<WtLive>().client()
}

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(error = %e, "could not emit {event}");
    }
}

/// Emits `net://status` when the outcome of `call` says something about reaching WT Live (see
/// [`net_status_after`]), then hands the outcome back.
fn reported<T>(app: &AppHandle, call: WtLiveCall, result: AppResult<T>) -> AppResult<T> {
    if let Some(status) = net_status_after(call, &result) {
        emit(app, NET_STATUS_EVENT, status);
    }
    if let Err(e) = &result {
        tracing::debug!(?call, code = ?e.code, "WT Live call failed: {}", e.message);
    }
    result
}
