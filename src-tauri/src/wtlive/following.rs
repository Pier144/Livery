//! Followed vehicles and authors, persisted as `<appData>/following.json`:
//! `{ "version": 1, "entries": [FollowEntry…] }`. Local data: it works offline.
//!
//! An entry is identified by its kind and id (vehicle code or author id). `lastSeenAt` is when
//! the user last looked at the Following tab (or followed it, or the value the Undo of an
//! unfollow hands back): skins posted after it count as new. Writes are atomic (temp file, flush, rename); memory changes only once the file is
//! written. Loading is tolerant, like the settings and the library index: a missing file is an
//! empty list, a corrupt file is set aside as `following.json.bad`, and entries that don't
//! parse are dropped (a copy of the original is kept as `following.json.bad`).

use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::time::{now_rfc3339, parse_rfc3339};
use crate::model::{FollowEntry, FollowKind};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// File name inside the app data dir.
pub const FOLLOWING_FILE: &str = "following.json";

/// Format version written to `following.json`.
pub const FOLLOWING_VERSION: u32 = 1;

/// `invalidInput` messages of [`FollowingStore::set`].
pub const MISSING_ID: &str = "Pass the id of the vehicle or author to follow";
pub const MISSING_NAME: &str = "Pass the name of the vehicle or author to follow";
/// `invalidInput` message for a `lastSeenAt` (or a "now") that isn't an RFC 3339 time.
pub const NOT_A_TIME: &str = "Not an RFC 3339 time";

pub struct FollowingStore {
    path: PathBuf,
    entries: Mutex<Vec<FollowEntry>>,
}

#[derive(Serialize)]
struct FileOut<'a> {
    version: u32,
    entries: &'a [FollowEntry],
}

/// Read loosely so one bad entry doesn't cost the whole list.
#[derive(Deserialize)]
struct FileIn {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: Vec<serde_json::Value>,
}

impl FollowingStore {
    /// Loads the list (see the module doc for what a bad file does). Never writes the file.
    pub fn load(path: PathBuf) -> Self {
        let entries = read_file(&path);
        Self { path, entries: Mutex::new(entries) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Every followed vehicle and author, in the order they were followed.
    pub fn list(&self) -> Vec<FollowEntry> {
        self.lock().clone()
    }

    /// `following_set`: follows (`follow: true`) or unfollows a vehicle or an author and returns
    /// the whole list. Following adds the entry with `lastSeenAt` = now; following it again only
    /// refreshes its name. With `last_seen_at` (RFC 3339), a follow stores that `lastSeenAt`
    /// instead, whether the entry is new or already followed: the Undo of an unfollow passes the
    /// entry's old value so its "N new" comes back exactly. Unfollowing something not followed
    /// changes nothing. `id` and `name` must not be blank, and a `last_seen_at` that isn't
    /// RFC 3339 is refused even with an unfollow (`invalidInput`).
    pub fn set(
        &self,
        kind: FollowKind,
        id: &str,
        name: &str,
        follow: bool,
        last_seen_at: Option<&str>,
    ) -> AppResult<Vec<FollowEntry>> {
        self.set_seen_at(kind, id, name, follow, last_seen_at, &now_rfc3339())
    }

    /// [`Self::set`] without `last_seen_at`, with an explicit RFC 3339 "now".
    pub fn set_at(
        &self,
        kind: FollowKind,
        id: &str,
        name: &str,
        follow: bool,
        now: &str,
    ) -> AppResult<Vec<FollowEntry>> {
        self.set_seen_at(kind, id, name, follow, None, now)
    }

    /// [`Self::set`] with an explicit RFC 3339 "now" (the `lastSeenAt` of a new entry when
    /// `last_seen_at` is `None`).
    pub fn set_seen_at(
        &self,
        kind: FollowKind,
        id: &str,
        name: &str,
        follow: bool,
        last_seen_at: Option<&str>,
        now: &str,
    ) -> AppResult<Vec<FollowEntry>> {
        let (id, name) = (id.trim(), name.trim());
        if id.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, MISSING_ID));
        }
        if name.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, MISSING_NAME));
        }
        let seen = last_seen_at.map(|t| checked_time(t.trim())).transpose()?;
        let now = checked_time(now)?;
        self.change(|entries| {
            let position = entries.iter().position(|e| e.kind == kind && e.id == id);
            match (follow, position) {
                (true, Some(i)) => {
                    entries[i].name = name.to_owned();
                    if let Some(seen) = seen {
                        entries[i].last_seen_at = seen.to_owned();
                    }
                }
                (true, None) => entries.push(FollowEntry {
                    kind,
                    id: id.to_owned(),
                    name: name.to_owned(),
                    last_seen_at: seen.unwrap_or(now).to_owned(),
                }),
                (false, Some(i)) => {
                    entries.remove(i);
                }
                (false, None) => {}
            }
        })
    }

    /// Every entry's `lastSeenAt` becomes now (the Following tab's "N new" resets).
    pub fn mark_seen(&self) -> AppResult<Vec<FollowEntry>> {
        self.mark_seen_at(&now_rfc3339())
    }

    /// [`Self::mark_seen`] with an explicit RFC 3339 "now".
    pub fn mark_seen_at(&self, now: &str) -> AppResult<Vec<FollowEntry>> {
        let now = checked_time(now)?;
        self.change(|entries| {
            for entry in entries.iter_mut() {
                entry.last_seen_at = now.to_owned();
            }
        })
    }

    /// Runs `edit` on a copy of the list; when the copy differs it is written, then kept.
    fn change(&self, edit: impl FnOnce(&mut Vec<FollowEntry>)) -> AppResult<Vec<FollowEntry>> {
        let mut guard = self.lock();
        let mut next = guard.clone();
        edit(&mut next);
        if next != *guard {
            write_atomic(&self.path, &next)?;
            *guard = next;
        }
        Ok(guard.clone())
    }

    fn lock(&self) -> MutexGuard<'_, Vec<FollowEntry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The stored entries the frontend asked about (`wtlive_following_new`'s vehicle codes and
/// author ids), each with its own `lastSeenAt`. Ids that aren't followed are left out.
pub fn select(entries: &[FollowEntry], vehicles: &[String], authors: &[String]) -> Vec<FollowEntry> {
    entries
        .iter()
        .filter(|e| {
            let asked = match e.kind {
                FollowKind::Vehicle => vehicles,
                FollowKind::Author => authors,
            };
            asked.iter().any(|id| id.trim() == e.id)
        })
        .cloned()
        .collect()
}

fn checked_time(now: &str) -> AppResult<&str> {
    match parse_rfc3339(now) {
        Some(_) => Ok(now),
        None => Err(AppError::new(ErrorCode::InvalidInput, NOT_A_TIME).with_detail(now.to_owned())),
    }
}

fn read_file(path: &Path) -> Vec<FollowEntry> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            tracing::warn!(error = %e, "cannot read the Following list; starting empty");
            return Vec::new();
        }
    };
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let file: FileIn = match serde_json::from_slice(text) {
        Ok(file) => file,
        Err(e) => {
            tracing::warn!(error = %e, "Following list is corrupt; set aside as following.json.bad");
            let _ = fs::rename(path, bad_path(path));
            return Vec::new();
        }
    };
    if file.version > FOLLOWING_VERSION {
        tracing::warn!(version = file.version, "Following list was written by a newer Livery");
    }
    let total = file.entries.len();
    let mut repaired = 0;
    let mut entries: Vec<FollowEntry> = Vec::with_capacity(total);
    for value in file.entries {
        let Ok(mut entry) = serde_json::from_value::<FollowEntry>(value) else { continue };
        entry.id = entry.id.trim().to_owned();
        entry.name = entry.name.trim().to_owned();
        if entry.id.is_empty() || entry.name.is_empty() {
            continue;
        }
        if entries.iter().any(|e| e.kind == entry.kind && e.id == entry.id) {
            continue;
        }
        // A follow outlives a bad timestamp: it counts as seen now rather than being dropped.
        if parse_rfc3339(&entry.last_seen_at).is_none() {
            entry.last_seen_at = now_rfc3339();
            repaired += 1;
        }
        entries.push(entry);
    }
    let dropped = total - entries.len();
    if dropped > 0 || repaired > 0 {
        tracing::warn!(dropped, repaired, "Following list has unreadable entries; copy kept as following.json.bad");
        let _ = fs::copy(path, bad_path(path));
    }
    entries
}

fn bad_path(path: &Path) -> PathBuf {
    path.with_extension("json.bad")
}

/// Write to a sibling temp file, flush it to disk, then rename over the target (replaces on
/// Windows too), so a crash can't leave an empty or torn list behind.
fn write_atomic(path: &Path, entries: &[FollowEntry]) -> AppResult<()> {
    let tmp = path.with_extension("json.tmp");
    let written = (|| -> AppResult<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(&FileOut { version: FOLLOWING_VERSION, entries })?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written.map_err(|e| AppError { message: "The Following list couldn't be saved".into(), ..e })
}
