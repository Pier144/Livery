//! WT Live's answers and archives, kept on disk for a while (docs/wtlive-terms.md §7.5):
//! `<appData>/wtlive-cache/pages/<hash>.bin` (the request key on the first line, the answer
//! after it) and `<appData>/wtlive-cache/archives/<postId>.<zip|7z|rar>`.
//!
//! Nothing is kept longer than [`MAX_AGE`] (a day): it must not become an archive of WT Live.
//! Each read asks for its own, shorter freshness (a listing goes stale faster than a post). The
//! file's modification time is its age. Settings → WT Live → Clear cache empties it. Every
//! failure here is logged and treated as a miss: the cache never fails a call.

use crate::library::layout;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// Folder under the app data dir.
pub const CACHE_DIR: &str = "wtlive-cache";
/// Longest anything stays.
pub const MAX_AGE: Duration = Duration::from_secs(24 * 3600);

const PAGES_DIR: &str = "pages";
const ARCHIVES_DIR: &str = "archives";
/// Name part of a download in progress (`<postId>.part-<n>`).
pub const PART_MARK: &str = ".part-";

pub struct DiskCache {
    dir: PathBuf,
    /// One writer at a time, so a clear never races a write into a half-removed folder.
    lock: Mutex<()>,
}

impl DiskCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, lock: Mutex::new(()) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn page_path(&self, key: &str) -> PathBuf {
        self.dir.join(PAGES_DIR).join(format!("{:016x}.bin", fnv1a(key)))
    }

    /// The answer stored for `key`, if it is younger than `max_age` (and than [`MAX_AGE`]).
    pub fn get(&self, key: &str, max_age: Duration) -> Option<Vec<u8>> {
        let path = self.page_path(key);
        if !is_fresh(&path, max_age.min(MAX_AGE)) {
            return None;
        }
        let bytes = fs::read(&path).ok()?;
        let newline = bytes.iter().position(|&b| b == b'\n')?;
        // Another key with the same hash: a miss.
        (&bytes[..newline] == key.as_bytes()).then(|| bytes[newline + 1..].to_vec())
    }

    /// Stores the answer for `key` (atomically; failures are logged).
    pub fn put(&self, key: &str, body: &[u8]) {
        let _guard = self.guard();
        let path = self.page_path(key);
        let result = (|| -> std::io::Result<()> {
            fs::create_dir_all(path.parent().expect("pages dir"))?;
            let tmp = path.with_extension("tmp");
            let mut file = fs::File::create(&tmp)?;
            file.write_all(key.as_bytes())?;
            file.write_all(b"\n")?;
            file.write_all(body)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&tmp, &path)
        })();
        if let Err(e) = result {
            tracing::warn!(error = %e, "WT Live answer not cached");
        }
    }

    /// `archives/`, created.
    pub fn archives_dir(&self) -> std::io::Result<PathBuf> {
        let dir = self.dir.join(ARCHIVES_DIR);
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// The post's archive, if one was downloaded less than a day ago.
    pub fn fresh_archive(&self, post_id: &str) -> Option<PathBuf> {
        let dir = self.dir.join(ARCHIVES_DIR);
        ["zip", "7z", "rar"].iter().map(|ext| dir.join(format!("{post_id}.{ext}"))).find(|p| is_fresh(p, MAX_AGE))
    }

    /// Bytes used by the cache.
    pub fn size(&self) -> u64 {
        dir_size(&self.dir)
    }

    /// Empties the cache. Files in use (an archive being installed right now) stay; they go with
    /// the next clear or after a day.
    pub fn clear(&self) {
        let _guard = self.guard();
        for sub in [PAGES_DIR, ARCHIVES_DIR] {
            let dir = self.dir.join(sub);
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.filter_map(Result::ok) {
                if let Err(e) = remove(&entry.path()) {
                    tracing::info!(error = %e, "a WT Live cache file stays (in use?)");
                }
            }
        }
        tracing::info!("WT Live cache cleared");
    }

    /// Removes what is older than [`MAX_AGE`], and downloads left half-done by a session that
    /// ended (call before any download starts). Returns how many files went.
    pub fn purge_expired(&self) -> usize {
        let _guard = self.guard();
        let mut removed = 0;
        for sub in [PAGES_DIR, ARCHIVES_DIR] {
            let Ok(entries) = fs::read_dir(self.dir.join(sub)) else { continue };
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                let partial = entry.file_name().to_string_lossy().contains(PART_MARK);
                if (partial || !is_fresh(&path, MAX_AGE)) && remove(&path).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    }
}

fn remove(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        layout::remove_tree(path)
    } else {
        fs::remove_file(path)
    }
}

/// Modified less than `max_age` ago (a time in the future, beyond a minute of clock skew, is
/// not fresh).
fn is_fresh(path: &Path, max_age: Duration) -> bool {
    let Ok(modified) = fs::metadata(path).and_then(|m| m.modified()) else { return false };
    match SystemTime::now().duration_since(modified) {
        Ok(age) => age < max_age,
        Err(ahead) => ahead.duration() < Duration::from_secs(60),
    }
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .filter_map(Result::ok)
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// FNV-1a, 64 bits: a stable file name for a request key (collisions are checked on read).
fn fnv1a(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}
