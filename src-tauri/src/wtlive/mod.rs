//! WT Live (M5): Explore search, posts, Following, installs from WT Live and Try in game.
//!
//! # Today
//! No HTTP client (nor HTML parser) is approved yet, so the app runs on [`DisabledClient`]:
//! `wtlive_search`, `wtlive_post`, `wtlive_following_new`, `install_from_wtlive` and
//! `read_textures { wtliveId }` answer `unsupported` ([`UNSUPPORTED_MESSAGE`]) and emit
//! `net://status { online: false }`, and the UI shows its designed offline state. `finalize_try`
//! answers `unsupported` too, but it is local work (keep or remove a skin already on disk), so it
//! never emits `net://status` ([`WtLiveCall::reaches_wtlive`]). None of them panics. Following is
//! local data ([`following`]) and works offline.
//!
//! # Layout
//! - [`client`] holds the [`WtLiveClient`] trait (search, post, following_new, download) and
//!   the [`DisabledClient`] used today. The real client implements the same trait and takes
//!   the Disabled one's place in [`WtLive::load`]; the commands don't change.
//! - [`following`] keeps `<appData>/following.json`.
//! - this file: the managed state [`WtLive`], the commands, and the plain functions behind them
//!   (tested without Tauri in `tests/wtlive_*.rs` and `tests/following_*.rs`).
//!
//! # Plan for the real client (when an HTTP client and an HTML parser are approved)
//! WT Live (`live.warthunder.com`) has no public API (DATA_MODEL.md).
//! 1. **Fetch** listing pages and post pages over HTTPS with a Livery user agent
//!    (`Livery/<version>`), at most one request per second through one shared limiter (the
//!    client waits on its blocking thread). A failure (DNS, timeout, HTTP error, a page that
//!    doesn't parse) is `network`; the commands turn it into `net://status { online: false }`,
//!    and the next success turns it back to `online: true`.
//! 2. **Parse** behind a `Parser` trait (`listing(html)` → skins + page count, `post(html)` →
//!    [`WtLiveSkin`] with images, download URL, files and stats), so a change on the site swaps
//!    one implementation. Its tests run against saved-HTML fixtures in
//!    `src-tauri/tests/fixtures/wtlive/`. Capturing those pages needs network access, so they
//!    will be saved when HTTP is approved; none exist yet.
//! 3. **Cache** responses for 24 h in the app data dir (`<appData>/wtlive-cache/`, JSON keyed by
//!    URL: DATA_MODEL's SQLite table isn't approved either). When WT Live can't be reached, a
//!    stale cache is still served.
//! 4. **Explore paging** (BUILD_PLAN open decision 2, DESIGN_NOTES "M5 · Explore paging"): the
//!    first search fetches the first 5 listing pages and a background task prefetches the rest
//!    into the cache. `search` filters and sorts the cached catalogue locally and answers pages
//!    of results (`params.page`, from 0) with the total and the time it took; the frontend's
//!    `useWtLiveSearchPages` asks for the next page as the grid scrolls.
//! 5. **Following new**: [`WtLiveClient::following_new`] gets each followed entry with its own
//!    `lastSeenAt` and answers the skins posted after it.
//!
//! # Installs from WT Live and Try in game (same approval, plus the archive crates)
//! - `install_from_wtlive { skinId, mode, conflict? }` checks [`WtLiveClient::ready`], then
//!   returns an `installId` at once and runs in the background, emitting `install://progress`:
//!   download ([`WtLiveClient::download`] into `UserSkins/.livery/partial/<installId>`) →
//!   extract and analyze (the archive module's `SkinSource` and `analyze_source`) → verify and
//!   a staged install (`archive::install`). The index entry gets `origin: wtlive`, `sourceId` =
//!   the WT Live id and the author; a folder clash follows `conflict` or the settings policy,
//!   as in the queue. Posts download as ZIP archives, so until the archive crates are approved
//!   a ready client still gets `unsupported` (`archive::UNSUPPORTED_ARCHIVES`).
//! - `mode: temporary` (Try in game) installs the same way and marks the index entry
//!   `temporary: true`. My Hangar leaves it out (DESIGN_NOTES "M5 · Temporary installs").
//! - `finalize_try { skinId, keep }`: `skinId` is the **WT Live** id (the entry's `sourceId`).
//!   Keep → `temporary = false` and the skin is returned. Discard → its folder and its index
//!   entry are removed, a folder it replaced comes back from its backup, and `null` is returned.
//! - At launch, any temporary install left by a crashed or closed session is removed the same
//!   way (a `purge_on_startup` called next to `archive::purge_on_startup` in `lib.rs` setup).
//! - `read_textures { wtliveId }` downloads the post's archive into the cache and reads its
//!   texture headers, for the Skin detail's Textures tab before installing.

pub mod client;
pub mod following;

pub use client::{is_offline_error, unsupported, DisabledClient, DownloadProgress, WtLiveClient, UNSUPPORTED_MESSAGE};
pub use following::{FollowingStore, FOLLOWING_FILE};

use crate::archive::UNSUPPORTED_ARCHIVES;
use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{
    ConflictPolicy, FollowEntry, FollowKind, HangarSkin, InstallMode, InstallStarted, SearchParams, SearchResult,
    TextureInfo, WtLiveSkin,
};
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

/// Managed state: the WT Live client and the Following list.
pub struct WtLive {
    client: Arc<dyn WtLiveClient>,
    following: FollowingStore,
}

impl WtLive {
    /// This build's state: the [`DisabledClient`] and `<data_dir>/following.json`.
    pub fn load(data_dir: &Path) -> Self {
        Self::with_client(Arc::new(DisabledClient), data_dir.join(FOLLOWING_FILE))
    }

    pub fn with_client(client: Arc<dyn WtLiveClient>, following_path: PathBuf) -> Self {
        Self { client, following: FollowingStore::load(following_path) }
    }

    pub fn client(&self) -> Arc<dyn WtLiveClient> {
        Arc::clone(&self.client)
    }

    pub fn following(&self) -> &FollowingStore {
        &self.following
    }
}

// ── Plain functions behind the commands ─────────────────────────────────────

/// The commands of this module whose outcome may say something about reaching WT Live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WtLiveCall {
    Search,
    Post,
    FollowingNew,
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

/// `install_from_wtlive`: what can be checked before an install starts. See the module doc
/// for the pipeline that follows once it exists.
pub fn start_install(
    client: &dyn WtLiveClient,
    skin_id: &str,
    mode: InstallMode,
    conflict: Option<ConflictPolicy>,
) -> AppResult<InstallStarted> {
    required_id(skin_id)?;
    // Used by the pipeline: `temporary` on the index entry, and the folder clash policy.
    let _ = (mode, conflict);
    download_and_unpack(client)
}

/// `finalize_try`. A Try in game install can't exist in a build that can't download from WT
/// Live, so there is nothing to keep or discard yet (see the module doc for the plan).
pub fn keep_or_discard(skin_id: &str, keep: bool) -> AppResult<Option<HangarSkin>> {
    required_id(skin_id)?;
    let _ = keep;
    Err(unsupported().with_detail("finalize_try: no Try in game install can exist in this build"))
}

/// `read_textures { wtliveId }`: the texture headers of a post that isn't installed.
pub fn post_textures(client: &dyn WtLiveClient, id: &str) -> AppResult<Vec<TextureInfo>> {
    required_id(id)?;
    download_and_unpack(client)
}

/// Installing a post, or reading its textures before installing, means downloading its archive
/// and unpacking it: the client must be ready, and ZIP unpacking isn't approved yet either.
fn download_and_unpack<T>(client: &dyn WtLiveClient) -> AppResult<T> {
    client.ready()?;
    Err(AppError::new(ErrorCode::Unsupported, UNSUPPORTED_ARCHIVES).with_detail("WT Live posts download as archives"))
}

fn required_id(id: &str) -> AppResult<&str> {
    match id.trim() {
        "" => Err(AppError::new(ErrorCode::InvalidInput, MISSING_SKIN_ID)),
        id => Ok(id),
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn wtlive_search(app: AppHandle, params: SearchParams) -> AppResult<SearchResult> {
    let client = client_of(&app);
    reported(&app, WtLiveCall::Search, blocking(move || client.search(&params)).await)
}

#[tauri::command]
pub async fn wtlive_post(app: AppHandle, id: String) -> AppResult<WtLiveSkin> {
    let client = client_of(&app);
    reported(&app, WtLiveCall::Post, blocking(move || post(client.as_ref(), &id)).await)
}

#[tauri::command]
pub async fn wtlive_following_new(
    app: AppHandle,
    vehicles: Vec<String>,
    authors: Vec<String>,
) -> AppResult<Vec<WtLiveSkin>> {
    let handle = app.clone();
    let result = blocking(move || {
        let state = handle.state::<WtLive>();
        following_new(state.client().as_ref(), &state.following().list(), &vehicles, &authors)
    })
    .await;
    reported(&app, WtLiveCall::FollowingNew, result)
}

#[tauri::command]
pub async fn install_from_wtlive(
    app: AppHandle,
    skin_id: String,
    mode: InstallMode,
    conflict: Option<ConflictPolicy>,
) -> AppResult<InstallStarted> {
    let client = client_of(&app);
    let result = blocking(move || start_install(client.as_ref(), &skin_id, mode, conflict)).await;
    reported(&app, WtLiveCall::Install, result)
}

/// Try in game: keep → the temporary install becomes a normal hangar skin; discard → removed.
/// `skin_id` is the **WT Live** skin id (the hangar skin's `source_id`), not a hangar id. Local:
/// it never emits `net://status`.
#[tauri::command]
pub async fn finalize_try(app: AppHandle, skin_id: String, keep: bool) -> AppResult<Option<HangarSkin>> {
    reported(&app, WtLiveCall::FinalizeTry, keep_or_discard(&skin_id, keep))
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

// ── App glue ────────────────────────────────────────────────────────────────

fn client_of(app: &AppHandle) -> Arc<dyn WtLiveClient> {
    app.state::<WtLive>().client()
}

/// Emits `net://status` when the outcome of `call` says something about reaching WT Live (see
/// [`net_status_after`]), then hands the outcome back.
fn reported<T>(app: &AppHandle, call: WtLiveCall, result: AppResult<T>) -> AppResult<T> {
    if let Some(status) = net_status_after(call, &result) {
        if let Err(e) = app.emit(NET_STATUS_EVENT, status) {
            tracing::warn!(error = %e, "could not emit {NET_STATUS_EVENT}");
        }
    }
    if let Err(e) = &result {
        tracing::debug!(?call, code = ?e.code, "WT Live call failed: {}", e.message);
    }
    result
}
