//! Downloads of the background-removal files: an HTTPS client of its own (not WT Live's transport,
//! whose rate limit, breaker and robots rules are WT Live's) that only talks to GitHub's release
//! hosts, streams to `<file>.part` while hashing, and keeps the file only when its size and
//! SHA-256 are the pinned ones. One download at a time ([`Downloader::begin`]); a cancel flag is
//! checked between chunks.

use crate::atelier::sha256::{hex, Sha256};
use crate::error::{AppError, AppResult, ErrorCode};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// `network` (or `io` for the local file): the transfer failed, was refused (a host outside the
/// allowlist, an HTTP error) or brought a different number of bytes than pinned.
pub const MODEL_DOWNLOAD_FAILED: &str = "The download didn't finish";
/// `parse`: the file arrived whole but its SHA-256 isn't the pinned one; it was deleted.
pub const MODEL_DOWNLOAD_CORRUPT: &str = "The downloaded file is damaged";
/// `internal`: the user cancelled; the partial file was deleted. Download and background-removal
/// cancels share the `internal` code with real failures: the message constant
/// (this one, `cutout::CUTOUT_CANCELLED`) is what tells a cancel apart.
pub const MODEL_DOWNLOAD_CANCELLED: &str = "Download cancelled";
/// `conflict`: another download is running.
pub const MODEL_DOWNLOAD_BUSY: &str = "A download is already running";

/// The only hosts a download (and every redirect it follows) may reach.
pub const ALLOWED_HOSTS: [&str; 3] =
    ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Longest wait for the response head or for any read of the body (a stall); there is no limit
/// on the whole transfer.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Most redirects followed.
const MAX_REDIRECTS: usize = 5;
/// Least time between two progress reports (at most 10 a second).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const CHUNK: usize = 256 * 1024;

/// What a download must bring: `size` bytes hashing to `sha256` (lowercase hex).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Expected<'a> {
    pub url: &'a str,
    pub size: u64,
    pub sha256: &'a str,
}

/// The downloader: its client, allowlist, single-flight and cancel flags.
pub struct Downloader {
    client: OnceLock<Result<reqwest::blocking::Client, String>>,
    allowed: Vec<String>,
    https_only: bool,
    busy: AtomicBool,
    cancel: AtomicBool,
}

impl Default for Downloader {
    fn default() -> Self {
        Self::new()
    }
}

/// While held, the downloader is busy (see [`Downloader::begin`]).
pub struct Flight<'a> {
    downloader: &'a Downloader,
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        self.downloader.busy.store(false, Ordering::SeqCst);
    }
}

/// `https` on its default port (or, when `https_only` is off, for tests: `http` too and any
/// port) to one of `allowed` (any case).
fn url_allowed(url: &reqwest::Url, allowed: &[String], https_only: bool) -> bool {
    let scheme_ok = if https_only {
        url.scheme() == "https" && url.port().is_none()
    } else {
        matches!(url.scheme(), "https" | "http")
    };
    scheme_ok && url.host_str().is_some_and(|host| allowed.iter().any(|a| a.eq_ignore_ascii_case(host)))
}

fn failed(code: ErrorCode, detail: impl Into<String>) -> AppError {
    AppError::new(code, MODEL_DOWNLOAD_FAILED).with_detail(detail.into())
}

impl Downloader {
    /// HTTPS only, to [`ALLOWED_HOSTS`] only.
    pub fn new() -> Self {
        Self::with_policy(ALLOWED_HOSTS.iter().map(|h| (*h).to_owned()).collect(), true)
    }

    /// Tests only: plain HTTP allowed, to `allowed_hosts` (e.g. `127.0.0.1`), no proxy.
    #[doc(hidden)]
    pub fn for_tests(allowed_hosts: Vec<String>) -> Self {
        Self::with_policy(allowed_hosts, false)
    }

    fn with_policy(allowed: Vec<String>, https_only: bool) -> Self {
        Self {
            client: OnceLock::new(),
            allowed,
            https_only,
            busy: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        }
    }

    /// Whether `url` may be requested: its scheme (`https`, or `http` too for tests) and host.
    pub fn allows(&self, url: &reqwest::Url) -> bool {
        url_allowed(url, &self.allowed, self.https_only)
    }

    /// The client, built on first use (on the blocking thread that downloads).
    fn client(&self) -> AppResult<&reqwest::blocking::Client> {
        let built = self.client.get_or_init(|| {
            let allowed = self.allowed.clone();
            let https_only = self.https_only;
            let policy = reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    attempt.error("too many redirects")
                } else if url_allowed(attempt.url(), &allowed, https_only) {
                    attempt.follow()
                } else {
                    let host = attempt.url().host_str().unwrap_or("?").to_owned();
                    attempt.error(format!("redirect to {host} refused"))
                }
            });
            let mut builder = reqwest::blocking::Client::builder()
                .user_agent(format!("Livery/{}", env!("CARGO_PKG_VERSION")))
                .https_only(self.https_only)
                .redirect(policy)
                .connect_timeout(CONNECT_TIMEOUT)
                // Blocking clients apply this to the response head and to each body read.
                .timeout(STALL_TIMEOUT);
            if !self.https_only {
                builder = builder.no_proxy();
            }
            builder.build().map_err(|e| e.to_string())
        });
        built.as_ref().map_err(|e| AppError::new(ErrorCode::Internal, MODEL_DOWNLOAD_FAILED).with_detail(e.clone()))
    }

    /// Marks the downloader busy until the returned guard drops, and clears the cancel flag;
    /// `conflict` ([`MODEL_DOWNLOAD_BUSY`]) while another flight runs.
    pub fn begin(&self) -> AppResult<Flight<'_>> {
        if self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(AppError::new(ErrorCode::Conflict, MODEL_DOWNLOAD_BUSY));
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(Flight { downloader: self })
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// Asks the running download to stop at its next chunk (nothing when none runs).
    pub fn cancel(&self) {
        if self.is_busy() {
            self.cancel.store(true, Ordering::SeqCst);
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Downloads `expected` to `dest` through `<dest>.part` (replacing `dest` only when the size
    /// and hash match), calling `progress(received, total)` at most every [`PROGRESS_INTERVAL`]
    /// and once at the end. The partial file goes on every failure.
    pub fn download(
        &self,
        flight: &Flight<'_>,
        expected: Expected<'_>,
        dest: &Path,
        progress: &mut dyn FnMut(u64, u64),
    ) -> AppResult<()> {
        debug_assert!(std::ptr::eq(flight.downloader, self), "a flight of another downloader");
        let part = part_path(dest);
        let result = self.download_to(expected, &part, progress);
        match result {
            Ok(()) => crate::atelier::project::rename_retrying(&part, dest)
                .map_err(|e| failed(ErrorCode::Io, e.to_string()))
                .inspect_err(|_| {
                    let _ = fs::remove_file(&part);
                }),
            Err(e) => {
                let _ = fs::remove_file(&part);
                Err(e)
            }
        }
    }

    fn download_to(&self, expected: Expected<'_>, part: &Path, progress: &mut dyn FnMut(u64, u64)) -> AppResult<()> {
        let url = reqwest::Url::parse(expected.url).map_err(|e| failed(ErrorCode::InvalidInput, e.to_string()))?;
        if !self.allows(&url) {
            return Err(failed(ErrorCode::InvalidInput, format!("{} isn't allowed", url.host_str().unwrap_or("?"))));
        }
        if self.cancelled() {
            return Err(AppError::new(ErrorCode::Internal, MODEL_DOWNLOAD_CANCELLED));
        }
        let mut response = self.client()?.get(url).send().map_err(|e| failed(ErrorCode::Network, e.to_string()))?;
        if !response.status().is_success() {
            return Err(failed(ErrorCode::Network, format!("HTTP {}", response.status().as_u16())));
        }
        if let Some(length) = response.content_length().filter(|&l| l != expected.size) {
            return Err(failed(ErrorCode::Network, format!("{length} bytes announced, {} expected", expected.size)));
        }
        let total = expected.size;
        let mut file = File::create(part).map_err(|e| failed(ErrorCode::Io, e.to_string()))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; CHUNK];
        let mut received = 0u64;
        let mut reported = Instant::now();
        progress(0, total);
        loop {
            if self.cancelled() {
                return Err(AppError::new(ErrorCode::Internal, MODEL_DOWNLOAD_CANCELLED));
            }
            let n = match response.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(failed(ErrorCode::Network, e.to_string())),
            };
            received += n as u64;
            if received > total {
                return Err(failed(ErrorCode::Network, format!("more than {total} bytes")));
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| failed(ErrorCode::Io, e.to_string()))?;
            if reported.elapsed() >= PROGRESS_INTERVAL {
                progress(received, total);
                reported = Instant::now();
            }
        }
        if self.cancelled() {
            return Err(AppError::new(ErrorCode::Internal, MODEL_DOWNLOAD_CANCELLED));
        }
        if received != total {
            return Err(failed(ErrorCode::Network, format!("{received} of {total} bytes")));
        }
        file.sync_all().map_err(|e| failed(ErrorCode::Io, e.to_string()))?;
        drop(file);
        let actual = hex(&hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected.sha256) {
            return Err(AppError::new(ErrorCode::Parse, MODEL_DOWNLOAD_CORRUPT).with_detail(format!("sha256 {actual}")));
        }
        progress(received, total);
        Ok(())
    }
}

/// `<path>.part`.
pub fn part_path(path: &Path) -> PathBuf {
    let mut part = path.as_os_str().to_owned();
    part.push(".part");
    PathBuf::from(part)
}
