//! The seam between the WT Live commands and the network: [`WtLiveClient`].
//!
//! The app runs on [`super::live::LiveClient`]; [`DisabledClient`] answers `unsupported` to
//! everything (tests, and a build without network). The client is handed to
//! [`super::WtLive::with_client`]; the commands don't change.
//!
//! The methods are blocking: the commands call them through `crate::blocking`, so a client may
//! sleep for its rate limit, read its disk cache or wait on a socket without holding up the UI.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{FollowEntry, ForYouNew, SearchParams, SearchResult, WtLiveSkin};
use std::path::PathBuf;

/// `unsupported` message for every WT Live call of the [`DisabledClient`].
pub const UNSUPPORTED_MESSAGE: &str = "WT Live can't be reached from this build.";

/// `unsupported` message while Settings → WT Live → Browse WT Live is off.
pub const TURNED_OFF_MESSAGE: &str = "WT Live browsing is turned off in Settings";

/// The error every WT Live call of the [`DisabledClient`] answers.
pub fn unsupported() -> AppError {
    AppError::new(ErrorCode::Unsupported, UNSUPPORTED_MESSAGE)
}

/// The error every WT Live call answers while browsing is turned off: nothing is sent.
pub fn turned_off() -> AppError {
    AppError::new(ErrorCode::Unsupported, TURNED_OFF_MESSAGE)
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

    /// The 3 most downloaded skins for vehicle `code` (first feed page only, hidden posts left out).
    fn vehicle_top(&self, code: &str) -> AppResult<Vec<WtLiveSkin>>;

    /// Skins posted after `since` (unix seconds) for `vehicles`, each matched to one of them.
    /// `vehicles` is in display order; see `live::LiveClient` for chunking and the request cap.
    /// A working client answers an empty result to an empty list without a request.
    fn for_you_new(&self, vehicles: &[String], since: i64) -> AppResult<ForYouNew>;

    /// The post's archive on disk (downloaded now, or kept from a download less than a day
    /// old), as a `.zip`, `.7z` or `.rar` file. `progress` is called as bytes arrive. The file
    /// belongs to the client's cache: read it, don't move or delete it.
    fn archive(&self, id: &str, progress: &mut dyn FnMut(DownloadProgress)) -> AppResult<PathBuf>;
}

/// A client that never reaches WT Live: every call is `unsupported` ([`UNSUPPORTED_MESSAGE`]);
/// nothing is sent, nothing is written.
#[derive(Debug, Clone, Copy, Default)]
pub struct DisabledClient;

impl DisabledClient {
    fn refuse<T>(operation: &str) -> AppResult<T> {
        Err(unsupported().with_detail(format!("{operation}: this client never reaches WT Live")))
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

    fn vehicle_top(&self, _code: &str) -> AppResult<Vec<WtLiveSkin>> {
        Self::refuse("vehicle_top")
    }

    fn for_you_new(&self, _vehicles: &[String], _since: i64) -> AppResult<ForYouNew> {
        Self::refuse("for_you_new")
    }

    fn archive(&self, _id: &str, _progress: &mut dyn FnMut(DownloadProgress)) -> AppResult<PathBuf> {
        Self::refuse("archive")
    }
}
