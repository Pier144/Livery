//! When the user last looked at For you, persisted as `<appData>/for_you.json`:
//! `{ "version": 1, "lastSeenAt": "<RFC 3339>" }`. Local data: it works offline. Skins posted
//! after it count as new on For you.
//!
//! Like the Following list: writes are atomic (temp file, flush, rename) and memory changes only
//! once the file is written. A missing file reads as [`NEW_FOR_A_FIRST_VISIT`] before launch (not
//! written), so the first visit already shows the past week as new. A corrupt file, or one
//! without a usable time, is set aside as `for_you.json.bad` and reads as now. A file that exists
//! but can't be read (a sharing violation, permissions) reads as now too, and the store turns
//! read-only for the session: every mark is refused, so the real value is never overwritten.

use super::following::NOT_A_TIME;
use crate::error::{AppError, AppResult, ErrorCode, UnreadableFile};
use crate::library::time::{format_unix_secs, now_rfc3339, parse_rfc3339, unix_secs};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

/// File name inside the app data dir.
pub const FOR_YOU_FILE: &str = "for_you.json";

/// Format version written to `for_you.json`.
pub const FOR_YOU_VERSION: u32 = 1;

/// `io` message when `for_you.json` can't be written.
pub const FOR_YOU_NOT_SAVED: &str = "For you couldn't save what you've already seen";

/// How far back "new" reaches before For you was ever marked seen.
pub const NEW_FOR_A_FIRST_VISIT: Duration = Duration::from_secs(7 * 24 * 3600);

pub struct ForYouStore {
    path: PathBuf,
    last_seen_at: Mutex<String>,
    /// Set when the file existed but couldn't be read at launch: every mark is refused.
    unreadable: Option<UnreadableFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOut<'a> {
    version: u32,
    last_seen_at: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIn {
    #[serde(default)]
    version: u32,
    last_seen_at: String,
}

impl ForYouStore {
    /// Loads the value (see the module doc for what a missing or bad file does). Never writes
    /// the file.
    pub fn load(path: PathBuf) -> Self {
        let (last_seen_at, unreadable) = match read_file(&path) {
            Ok(Some(at)) => (at, None),
            Ok(None) => {
                let ago = i64::try_from(NEW_FOR_A_FIRST_VISIT.as_secs()).unwrap_or(0);
                (format_unix_secs(unix_secs(SystemTime::now()).saturating_sub(ago)), None)
            }
            Err(unreadable) => (now_rfc3339(), Some(unreadable)),
        };
        Self { path, last_seen_at: Mutex::new(last_seen_at), unreadable }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the file couldn't be read at launch, so nothing will be saved this session.
    pub fn is_read_only(&self) -> bool {
        self.unreadable.is_some()
    }

    /// When For you was last seen (RFC 3339).
    pub fn last_seen_at(&self) -> String {
        self.lock().clone()
    }

    /// For you was seen now: its "N new" resets. Returns the stored value.
    pub fn mark_seen(&self) -> AppResult<String> {
        self.mark_seen_at(&now_rfc3339())
    }

    /// [`Self::mark_seen`] with an explicit RFC 3339 time (`invalidInput` when it isn't one):
    /// written first, then kept. A read-only store (see [`Self::load`]) refuses with `io`.
    pub fn mark_seen_at(&self, at: &str) -> AppResult<String> {
        let at = at.trim();
        if parse_rfc3339(at).is_none() {
            return Err(AppError::new(ErrorCode::InvalidInput, NOT_A_TIME).with_detail(at.to_owned()));
        }
        if let Some(unreadable) = &self.unreadable {
            return Err(unreadable.error());
        }
        let mut guard = self.lock();
        write_atomic(&self.path, at)?;
        at.clone_into(&mut guard);
        Ok(guard.clone())
    }

    fn lock(&self) -> MutexGuard<'_, String> {
        self.last_seen_at.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The stored time (`None`: no file, or one set aside as corrupt), or why the file that is there
/// can't be read.
fn read_file(path: &Path) -> Result<Option<String>, UnreadableFile> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            tracing::warn!(error = %e, "cannot read For you's seen state; read-only this session");
            tracing::debug!(path = %path.display(), "For you's seen state");
            return Err(UnreadableFile::new(path, &e));
        }
    };
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let file = serde_json::from_slice::<FileIn>(text).ok().filter(|f| parse_rfc3339(f.last_seen_at.trim()).is_some());
    match file {
        Some(file) => {
            if file.version > FOR_YOU_VERSION {
                tracing::warn!(version = file.version, "For you's seen state was written by a newer Livery");
            }
            Ok(Some(file.last_seen_at.trim().to_owned()))
        }
        None => {
            tracing::warn!("For you's seen state is corrupt; set aside as for_you.json.bad");
            let _ = fs::rename(path, path.with_extension("json.bad"));
            // Read as now: nothing older than the session counts as new after a bad file.
            Ok(Some(now_rfc3339()))
        }
    }
}

/// Write to a sibling temp file, flush it to disk, then rename over the target (replaces on
/// Windows too), so a crash can't leave an empty or torn file behind.
fn write_atomic(path: &Path, last_seen_at: &str) -> AppResult<()> {
    let tmp = path.with_extension("json.tmp");
    let written = (|| -> AppResult<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(&FileOut { version: FOR_YOU_VERSION, last_seen_at })?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    // `AppError::new` with the constant, so `src/lib/errors.test.ts` finds the message.
    written.map_err(|e| {
        let code = e.code;
        AppError::new(code, FOR_YOU_NOT_SAVED).with_detail(e.detail.unwrap_or(e.message))
    })
}
