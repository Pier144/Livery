//! Store files that exist but can't be read at launch (settings.json, following.json, a library
//! index) are never overwritten: the store keeps defaults (or an empty list) in memory and
//! refuses every write for the session. A missing file and a corrupt but readable one still
//! start fresh (the corrupt one set aside as `.bad`).
//!
//! "Unreadable" is simulated with a folder in place of the file (fails on every OS with an error
//! other than NotFound) and, on Windows, with a real sharing violation (a handle opened with no
//! sharing, as another program would).

use livery_lib::backup;
use livery_lib::error::{unreadable_at_launch_message, ErrorCode};
use livery_lib::library::layout;
use livery_lib::library::{Libraries, LibraryStore};
use livery_lib::model::{FollowKind, Language, Settings, SettingsPatch};
use livery_lib::settings::SettingsStore;
use livery_lib::wtlive::FollowingStore;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

const NOW: &str = "2026-09-19T08:30:00Z";

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-unreadable-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    /// `<tmp>/<name>` as a folder with a file inside, where a store expects a file.
    fn folder_in_place_of(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("inside.txt"), "x").unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn italian() -> SettingsPatch {
    SettingsPatch { language: Some(Language::It), ..Default::default() }
}

fn assert_refused(result: Result<impl std::fmt::Debug, livery_lib::AppError>, file: &str) {
    let err = result.expect_err("a read-only store refuses to write");
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(err.message, unreadable_at_launch_message(file));
    assert!(err.message.contains(file));
    assert!(err.detail.is_some(), "the OS error is kept as the detail");
}

fn untouched_folder(path: &Path) {
    assert!(path.is_dir(), "still the folder it was");
    assert_eq!(fs::read_to_string(path.join("inside.txt")).unwrap(), "x");
}

// ── settings.json ───────────────────────────────────────────────────────────

#[test]
fn unreadable_settings_load_defaults_and_refuse_every_update() {
    let tmp = TempDir::new("settings");
    let path = tmp.folder_in_place_of("settings.json");
    let store = SettingsStore::load(path.clone());
    assert!(store.is_read_only());
    assert_eq!(store.get(), Settings::default());
    assert_refused(store.update(italian()), "settings.json");
    assert_refused(store.update(SettingsPatch::default()), "settings.json");
    assert_eq!(store.get(), Settings::default(), "memory unchanged");
    untouched_folder(&path);
    assert!(!path.with_extension("json.tmp").exists(), "not even a temp file");
    assert!(!path.with_extension("json.bad").exists(), "unreadable is not corrupt");
}

#[test]
fn missing_settings_are_writable() {
    let tmp = TempDir::new("settings-missing");
    let store = SettingsStore::load(tmp.0.join("settings.json"));
    assert!(!store.is_read_only());
    assert_eq!(store.update(italian()).unwrap().language, Language::It);
}

#[test]
fn settings_that_arent_utf8_are_corrupt_not_unreadable() {
    let tmp = TempDir::new("settings-binary");
    let path = tmp.0.join("settings.json");
    fs::write(&path, [0xFF, 0xFE, 0x00, 0x7B]).unwrap();
    let store = SettingsStore::load(path.clone());
    assert!(!store.is_read_only());
    assert_eq!(store.get(), Settings::default());
    assert!(path.with_extension("json.bad").exists(), "set aside as settings.json.bad");
    store.update(italian()).unwrap();
    assert_eq!(SettingsStore::load(path).get().language, Language::It);
}

#[test]
fn settings_with_a_utf8_bom_load() {
    let tmp = TempDir::new("settings-bom");
    let path = tmp.0.join("settings.json");
    fs::write(&path, b"\xEF\xBB\xBF{ \"language\": \"it\", \"onboarded\": true }").unwrap();
    let store = SettingsStore::load(path.clone());
    assert!(!store.is_read_only());
    assert_eq!(store.get().language, Language::It);
    assert!(!path.with_extension("json.bad").exists());
}

// ── following.json ──────────────────────────────────────────────────────────

#[test]
fn unreadable_following_list_is_empty_and_refuses_changes() {
    let tmp = TempDir::new("following");
    let path = tmp.folder_in_place_of("following.json");
    let store = FollowingStore::load(path.clone());
    assert!(store.is_read_only());
    assert!(store.list().is_empty());
    assert_refused(store.set_at(FollowKind::Vehicle, "germ_tiger", "Tiger H1", true, NOW), "following.json");
    assert!(store.list().is_empty(), "memory unchanged");
    // Nothing to change, nothing to write: these still answer.
    assert_eq!(store.set_at(FollowKind::Author, "ostwind", "Ostwind", false, NOW).unwrap(), vec![]);
    assert_eq!(store.mark_seen_at(NOW).unwrap(), vec![]);
    untouched_folder(&path);
    assert!(!path.with_extension("json.bad").exists());
}

#[test]
fn missing_following_list_is_writable() {
    let tmp = TempDir::new("following-missing");
    let store = FollowingStore::load(tmp.0.join("following.json"));
    assert!(!store.is_read_only());
    assert_eq!(store.set_at(FollowKind::Vehicle, "germ_tiger", "Tiger H1", true, NOW).unwrap().len(), 1);
}

// ── library index ───────────────────────────────────────────────────────────

#[test]
fn unreadable_library_index_is_empty_and_refuses_every_transaction() {
    let tmp = TempDir::new("index");
    let path = tmp.folder_in_place_of("0123456789abcdef.json");
    let store = LibraryStore::load(path.clone());
    assert!(store.is_read_only());
    assert!(store.all().is_empty());
    let mut ran = false;
    let result = store.transact(|_, _| {
        ran = true;
        Ok(())
    });
    assert_refused(result, "0123456789abcdef.json");
    assert!(!ran, "refused before the change can touch the disk");
    assert_refused(store.import(vec![]), "0123456789abcdef.json");
    untouched_folder(&path);
    assert!(!path.with_extension("json.bad").exists());
}

#[test]
fn clear_backups_on_an_unreadable_index_deletes_nothing() {
    let tmp = TempDir::new("index-backups");
    let path = tmp.folder_in_place_of("index.json");
    let store = LibraryStore::load(path);
    let user_skins = tmp.0.join("game").join("UserSkins");
    // A backup folder the real (unreadable) index knows about; the empty one in memory doesn't.
    let held = layout::backups_dir(&user_skins).join("b-1").join("my_skin");
    fs::create_dir_all(&held).unwrap();
    fs::write(held.join("tank.blk"), "x").unwrap();
    assert_refused(backup::clear(&user_skins, &store, None), "index.json");
    assert!(held.join("tank.blk").is_file(), "the backup is still there");
}

#[test]
fn a_game_folders_unreadable_index_stays_read_only_for_the_session() {
    let tmp = TempDir::new("roots");
    let libraries = Libraries::with_paths(tmp.0.join("library"), tmp.0.join("library.json"));
    let game_root = tmp.0.join("War Thunder");
    let index = libraries.index_path(&game_root);
    fs::create_dir_all(&index).unwrap();
    let store = libraries.for_root(&game_root);
    assert!(store.is_read_only());
    let name = index.file_name().unwrap().to_str().unwrap().to_owned();
    assert_refused(store.import(vec![]), &name);
    // The index becomes a readable file meanwhile: this session keeps the read-only store.
    fs::remove_dir_all(&index).unwrap();
    fs::write(&index, r#"{ "version": 2, "skins": [] }"#).unwrap();
    assert!(libraries.for_root(&game_root).is_read_only());
    // A new session reads it.
    let next = Libraries::with_paths(tmp.0.join("library"), tmp.0.join("library.json"));
    assert!(!next.for_root(&game_root).is_read_only());
}

#[test]
fn missing_library_index_is_writable() {
    let tmp = TempDir::new("index-missing");
    let store = LibraryStore::load(tmp.0.join("library").join("index.json"));
    assert!(!store.is_read_only());
    assert!(store.transact(|_, _| Ok(())).is_ok());
}

// ── a real sharing violation (Windows) ──────────────────────────────────────

#[cfg(windows)]
mod sharing_violation {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    /// Opens `path` with no sharing, as a program holding it exclusively would.
    fn lock(path: &Path) -> fs::File {
        fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap()
    }

    #[test]
    fn locked_settings_are_not_overwritten_after_the_lock_goes() {
        let tmp = TempDir::new("lock-settings");
        let path = tmp.0.join("settings.json");
        let original = r#"{ "language": "it", "onboarded": true, "gamePath": "D:\\Games\\War Thunder" }"#;
        fs::write(&path, original).unwrap();
        let held = lock(&path);
        let store = SettingsStore::load(path.clone());
        drop(held);
        assert!(store.is_read_only());
        assert_eq!(store.get(), Settings::default());
        assert_refused(store.update(italian()), "settings.json");
        assert_eq!(fs::read_to_string(&path).unwrap(), original, "the real file is intact");
        assert!(!path.with_extension("json.bad").exists());
    }

    #[test]
    fn a_locked_following_list_is_not_overwritten_after_the_lock_goes() {
        let tmp = TempDir::new("lock-following");
        let path = tmp.0.join("following.json");
        let original = format!(
            r#"{{ "version": 1, "entries": [{{ "kind": "author", "id": "ostwind", "name": "Ostwind", "lastSeenAt": "{NOW}" }}] }}"#
        );
        fs::write(&path, &original).unwrap();
        let held = lock(&path);
        let store = FollowingStore::load(path.clone());
        drop(held);
        assert!(store.is_read_only());
        assert_refused(store.set_at(FollowKind::Vehicle, "germ_tiger", "Tiger H1", true, NOW), "following.json");
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn a_locked_library_index_is_not_overwritten_after_the_lock_goes() {
        let tmp = TempDir::new("lock-index");
        let path = tmp.0.join("index.json");
        let original = r#"{ "version": 2, "skins": [], "collections": [], "backups": [] }"#;
        fs::write(&path, original).unwrap();
        let held = lock(&path);
        let store = LibraryStore::load(path.clone());
        drop(held);
        assert!(store.is_read_only());
        assert_refused(store.import(vec![]), "index.json");
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }
}
