//! WT Live (M5): listing/post parsing behind a swappable trait, 24 h cache, 1 req/s rate limit with a
//! Livery user-agent; failures surface as `net://status` offline, never a crash.
//!
//! Stubs until an HTTP client (and an HTML parser) are approved: every network command answers
//! `unsupported` and reports WT Live as offline. Following is local data and works.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{
    ConflictPolicy, FollowEntry, FollowKind, HangarSkin, InstallMode, InstallStarted, SearchParams, SearchResult,
    WtLiveSkin,
};
use tauri::AppHandle;

pub const NET_STATUS_EVENT: &str = "net://status";

fn not_yet<T>(what: &str) -> AppResult<T> {
    Err(AppError::new(ErrorCode::Internal, format!("{what} is not implemented yet")))
}

#[tauri::command]
pub async fn wtlive_search(app: AppHandle, params: SearchParams) -> AppResult<SearchResult> {
    let _ = (app, params);
    not_yet("wtlive_search")
}

#[tauri::command]
pub async fn wtlive_post(app: AppHandle, id: String) -> AppResult<WtLiveSkin> {
    let _ = (app, id);
    not_yet("wtlive_post")
}

#[tauri::command]
pub async fn wtlive_following_new(
    app: AppHandle,
    vehicles: Vec<String>,
    authors: Vec<String>,
) -> AppResult<Vec<WtLiveSkin>> {
    let _ = (app, vehicles, authors);
    not_yet("wtlive_following_new")
}

#[tauri::command]
pub async fn install_from_wtlive(
    app: AppHandle,
    skin_id: String,
    mode: InstallMode,
    conflict: Option<ConflictPolicy>,
) -> AppResult<InstallStarted> {
    let _ = (app, skin_id, mode, conflict);
    not_yet("install_from_wtlive")
}

/// Try in game: keep → the temporary install becomes a normal hangar skin; discard → removed.
#[tauri::command]
pub async fn finalize_try(app: AppHandle, skin_id: String, keep: bool) -> AppResult<Option<HangarSkin>> {
    let _ = (app, skin_id, keep);
    not_yet("finalize_try")
}

#[tauri::command]
pub async fn following_list(app: AppHandle) -> AppResult<Vec<FollowEntry>> {
    let _ = app;
    not_yet("following_list")
}

/// Follows (`follow: true`) or unfollows a vehicle or an author; returns the whole list.
#[tauri::command]
pub async fn following_set(
    app: AppHandle,
    kind: FollowKind,
    id: String,
    name: String,
    follow: bool,
) -> AppResult<Vec<FollowEntry>> {
    let _ = (app, kind, id, name, follow);
    not_yet("following_set")
}

/// Marks every followed entry as seen now (the Following tab's "N new" resets).
#[tauri::command]
pub async fn following_mark_seen(app: AppHandle) -> AppResult<Vec<FollowEntry>> {
    let _ = app;
    not_yet("following_mark_seen")
}
