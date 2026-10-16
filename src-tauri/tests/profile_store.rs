//! `ProfileStore`: the `readGameData` switch (no disk access when off), no profile, the cache
//! keyed by path, size and modification time, and the one retry on lineups cut mid-write.

use livery_lib::error::ErrorCode;
use livery_lib::game::profile::{ProfileStore, LINEUPS_UNPARSABLE};
use livery_lib::model::LineupsStatus;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-profile-store-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    /// A copy of the fixture `name` in this folder, as `file`.
    fn copy(&self, name: &str, file: &str) -> PathBuf {
        let path = self.0.join(file);
        fs::copy(fixture(name), &path).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("profile").join(name)
}

fn located(path: &Path) -> impl FnOnce() -> Option<PathBuf> + '_ {
    move || Some(path.to_path_buf())
}

#[test]
fn off_never_looks_for_the_profile() {
    let store = ProfileStore::new();
    let lineups = store.lineups(false, || panic!("no disk access when reading the game's data is off")).unwrap();
    assert_eq!(lineups.status, LineupsStatus::Off);
    assert!(lineups.nations.is_empty());
    assert_eq!(store.reads(), 0);
}

#[test]
fn no_profile_file_is_no_profile() {
    let store = ProfileStore::new();
    assert_eq!(store.lineups(true, || None).unwrap().status, LineupsStatus::NoProfile);
    assert_eq!(store.reads(), 0);
}

#[test]
fn an_unchanged_file_is_read_once() {
    let dir = TempDir::new("same");
    let path = dir.copy("global.blk", "global.blk");
    let store = ProfileStore::new();
    let first = store.lineups(true, located(&path)).unwrap();
    let second = store.lineups(true, located(&path)).unwrap();
    assert_eq!(first.status, LineupsStatus::Ok);
    assert_eq!(first, second);
    assert_eq!(store.reads(), 1);
}

#[test]
fn a_changed_file_is_read_again() {
    let dir = TempDir::new("changed");
    let path = dir.copy("global.blk", "global.blk");
    let store = ProfileStore::new();
    store.lineups(true, located(&path)).unwrap();

    // The game rewrote it with more in it.
    let mut text = fs::read(&path).unwrap();
    text.extend_from_slice(b"\r\nextra:i=1\r\n");
    fs::write(&path, &text).unwrap();
    store.lineups(true, located(&path)).unwrap();
    assert_eq!(store.reads(), 2, "the size changed");

    // Same size, newer modification time.
    let later = fs::metadata(&path).unwrap().modified().unwrap() + Duration::from_secs(5);
    fs::File::options().write(true).open(&path).unwrap().set_modified(later).unwrap();
    store.lineups(true, located(&path)).unwrap();
    assert_eq!(store.reads(), 3, "the modification time changed");

    store.lineups(true, located(&path)).unwrap();
    assert_eq!(store.reads(), 3);
}

#[test]
fn another_path_is_read_again() {
    let dir = TempDir::new("path");
    let first = dir.copy("global.blk", "a.blk");
    let second = dir.copy("global.blk", "b.blk");
    // Same size; give both the same time too, so only the path differs.
    let when = SystemTime::now() - Duration::from_secs(60);
    for path in [&first, &second] {
        fs::File::options().write(true).open(path).unwrap().set_modified(when).unwrap();
    }
    let store = ProfileStore::new();
    store.lineups(true, located(&first)).unwrap();
    store.lineups(true, located(&second)).unwrap();
    assert_eq!(store.reads(), 2, "an account switch changes the path");
}

#[test]
fn lineups_cut_mid_write_are_retried_once_then_unparsable() {
    let dir = TempDir::new("torn");
    let path = dir.copy("global_torn.blk", "global.blk");
    let store = ProfileStore::new();
    let e = store.lineups(true, located(&path)).unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse);
    assert_eq!(e.message, LINEUPS_UNPARSABLE);
    assert_eq!(store.reads(), 2, "one retry");

    // Errors aren't cached: once the game finishes writing, the next call reads it.
    fs::copy(fixture("global.blk"), &path).unwrap();
    assert_eq!(store.lineups(true, located(&path)).unwrap().status, LineupsStatus::Ok);
    assert_eq!(store.reads(), 3);
}

#[test]
fn an_unreadable_file_is_not_retried() {
    let dir = TempDir::new("missing");
    let path = dir.0.join("global.blk");
    let store = ProfileStore::new();
    assert_eq!(store.lineups(true, located(&path)).unwrap_err().code, ErrorCode::Io);
    assert_eq!(store.reads(), 1);
}

#[test]
fn a_file_cut_before_the_lineups_is_retried_not_cached_as_empty() {
    let dir = TempDir::new("cut-before");
    let path = dir.copy("global_cut_before_presets.blk", "global.blk");
    let store = ProfileStore::new();
    assert_eq!(store.lineups(true, located(&path)).unwrap_err().code, ErrorCode::Parse);
    assert_eq!(store.reads(), 2, "one retry");

    // A complete profile without lineups is a fresh one: `noLineups`, cached.
    let fresh = dir.copy("global_no_presets.blk", "fresh.blk");
    assert_eq!(store.lineups(true, located(&fresh)).unwrap().status, LineupsStatus::NoLineups);
    assert_eq!(store.lineups(true, located(&fresh)).unwrap().status, LineupsStatus::NoLineups);
    assert_eq!(store.reads(), 3);
}
