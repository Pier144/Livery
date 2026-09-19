//! The seam between the WT Live commands and the network: [`WtLiveClient`].
//!
//! Today the app runs on [`DisabledClient`], which answers `unsupported` to everything (no HTTP
//! client is approved yet). The real client implements the same trait and is handed to
//! [`super::WtLive::with_client`] at startup; the commands don't change.
//!
//! The methods are blocking: the commands call them through `crate::blocking`, so a client may
//! sleep for its rate limit, read its disk cache or wait on a socket without holding up the UI.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{FollowEntry, SearchParams, SearchResult, WtLiveSkin};
use std::path::{Path, PathBuf};

/// `unsupported` message for every WT Live call in a build without an HTTP client.
pub const UNSUPPORTED_MESSAGE: &str =
    "WT Live can't be reached from this build yet: it needs a network library the author hasn't approved.";

/// The error every WT Live call answers in a build without an HTTP client.
pub fn unsupported() -> AppError {
    AppError::new(ErrorCode::Unsupported, UNSUPPORTED_MESSAGE)
}

/// Errors that mean "WT Live can't be reached from here": they turn the UI's WT Live state
/// offline (`net://status { online: false }`). Mirrors `isOfflineError` in `src/queries/wtlive.ts`.
pub fn is_offline_error(e: &AppError) -> bool {
    matches!(e.code, ErrorCode::Network | ErrorCode::Unsupported)
}

/// How far a download got. `total` is `None` when the server doesn't say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

/// Everything Livery asks of WT Live. Implementations own fetching, parsing, caching and rate
/// limiting; they report a site that can't be reached as `network`, never with a panic.
pub trait WtLiveClient: Send + Sync {
    /// Whether this client can talk to WT Live at all, without sending a request. Commands that
    /// start background work (install) call it first so they fail at once instead of handing
    /// back an install id that can only fail.
    fn ready(&self) -> AppResult<()>;

    /// One page of Explore results: filters combine (AND), `params.page` counts from 0.
    fn search(&self, params: &SearchParams) -> AppResult<SearchResult>;

    /// The full post (images, files, stats). Unknown id → `notFound`.
    fn post(&self, id: &str) -> AppResult<WtLiveSkin>;

    /// Skins posted after each entry's `last_seen_at` by the followed authors or for the
    /// followed vehicles, newest first. A working client answers `[]` to an empty list without a
    /// request ([`DisabledClient`] still answers `unsupported`, so the UI stays offline).
    fn following_new(&self, follows: &[FollowEntry]) -> AppResult<Vec<WtLiveSkin>>;

    /// Downloads the post's archive into `dest_dir` and returns the file's path. `progress` is
    /// called as bytes arrive.
    fn download(&self, id: &str, dest_dir: &Path, progress: &mut dyn FnMut(DownloadProgress)) -> AppResult<PathBuf>;
}

/// The client of a build without an HTTP client: every call is `unsupported`
/// ([`UNSUPPORTED_MESSAGE`]); nothing is sent, nothing is written.
#[derive(Debug, Clone, Copy, Default)]
pub struct DisabledClient;

impl DisabledClient {
    fn refuse<T>(operation: &str) -> AppResult<T> {
        Err(unsupported().with_detail(format!("{operation}: no HTTP client in this build")))
    }
}

impl WtLiveClient for DisabledClient {
    fn ready(&self) -> AppResult<()> {
        Self::refuse("ready")
    }

    fn search(&self, _params: &SearchParams) -> AppResult<SearchResult> {
        Self::refuse("search")
    }

    fn post(&self, _id: &str) -> AppResult<WtLiveSkin> {
        Self::refuse("post")
    }

    fn following_new(&self, _follows: &[FollowEntry]) -> AppResult<Vec<WtLiveSkin>> {
        Self::refuse("following_new")
    }

    fn download(&self, _id: &str, _dest_dir: &Path, _progress: &mut dyn FnMut(DownloadProgress)) -> AppResult<PathBuf> {
        Self::refuse("download")
    }
}
