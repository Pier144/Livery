//! What the watcher reads from disk (temp folders and the committed `fixtures/sources`): the
//! watched folder's listing, candidate sizes, whether a new folder holds a skin, the `UserSkins`
//! fingerprint (Livery's staging and backups aside), and the folder `watch_folder` saves.

use livery_lib::error::{AppError, ErrorCode};
use livery_lib::model::Settings;
use livery_lib::watch::poll::{Kind, Listed, Probe, Size};
use livery_lib::watch::snapshot::{hangar_signature, holds_skin, list_folder, measure};
use livery_lib::watch::{
    choose_folder, is_within, watched_folder, NO_DOWNLOADS_FOLDER, WATCH_FOLDER_GONE, WATCH_INSIDE_USER_SKINS,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-watch-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    fn mkdir(&self, rel: &str) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("sources").join(name)
}

/// The `UserSkins` fingerprint once it held still for 50 ms: Windows can report a folder's new
/// time in its parent's listing a moment after files are written inside it.
fn quiet(us: &Path) -> u64 {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut last = hangar_signature(us).unwrap();
    loop {
        thread::sleep(Duration::from_millis(50));
        let next = hangar_signature(us).unwrap();
        if next == last || Instant::now() > deadline {
            return next;
        }
        last = next;
    }
}

fn err<T>(result: Result<T, AppError>) -> AppError {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

// ── Watched folder ──────────────────────────────────────────────────────────

#[test]
fn listing_is_sorted_with_kinds_and_a_missing_folder_is_an_error() {
    let tmp = TempDir::new("list");
    tmp.write("b.zip", b"zip");
    tmp.write("A.txt", b"x");
    tmp.mkdir("Winter Tiger");
    let listing = list_folder(tmp.path()).unwrap();
    assert_eq!(listing, [Listed::file("A.txt"), Listed::dir("Winter Tiger"), Listed::file("b.zip")]);
    assert_eq!(listing[1].kind, Kind::Dir);
    assert_eq!(list_folder(&tmp.path().join("nope")).unwrap_err().kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn a_file_measures_its_length_and_a_folder_its_files_and_bytes() {
    let tmp = TempDir::new("measure");
    tmp.write("Tiger.zip", &[7u8; 1234]);
    tmp.write("Skin/a.blk", b"12345");
    tmp.write("Skin/sub/b.dds", &[0u8; 10]);
    tmp.mkdir("Skin/empty");
    tmp.mkdir("Empty");
    assert_eq!(measure(tmp.path(), &Listed::file("Tiger.zip")), Probe::Size(Size { files: 1, bytes: 1234 }));
    assert_eq!(measure(tmp.path(), &Listed::dir("Skin")), Probe::Size(Size { files: 2, bytes: 15 }));
    assert_eq!(measure(tmp.path(), &Listed::dir("Empty")), Probe::Size(Size { files: 0, bytes: 0 }));
    // Gone between the listing and the measure: try again (it leaves the listing next time).
    assert_eq!(measure(tmp.path(), &Listed::file("gone.zip")), Probe::Retry);
    assert_eq!(measure(tmp.path(), &Listed::dir("gone")), Probe::Retry);
}

#[test]
fn a_new_folder_counts_only_when_it_holds_a_skin() {
    assert!(holds_skin(&fixture("Winter Tiger")), "a skin folder");
    assert!(holds_skin(&fixture("Desert Pack")), "a pack of skins");
    assert!(holds_skin(&fixture("Nested Download")), "a skin two levels down");
    assert!(!holds_skin(&fixture("Loose Textures")), "textures without a blk");
    assert!(!holds_skin(&fixture("missing")), "gone");
    let tmp = TempDir::new("holds");
    tmp.write("Photos/holiday.jpg", b"jpg");
    assert!(!holds_skin(&tmp.path().join("Photos")));
}

// ── UserSkins fingerprint ───────────────────────────────────────────────────

#[test]
fn the_fingerprint_follows_skins_and_inactive_skins_but_not_livery_staging_or_backups() {
    let tmp = TempDir::new("signature");
    let us = tmp.mkdir("UserSkins");
    tmp.write("UserSkins/Tiger/tiger.blk", b"x");
    let base = quiet(&us);
    assert_eq!(hangar_signature(&us).unwrap(), base, "nothing changed");

    // Livery's own churn: staging, backups, the .livery folder itself.
    tmp.write("UserSkins/.livery/partial/i-1/Tiger 2/tiger.blk", b"x");
    tmp.write("UserSkins/.livery/partial/i-1/.livery-partial", b"");
    tmp.write("UserSkins/.livery/backups/b-1/Old/old.blk", b"x");
    assert_eq!(quiet(&us), base, "staging and backups are not part of it");

    tmp.write("UserSkins/Panther/panther.blk", b"x");
    let added = hangar_signature(&us).unwrap();
    assert_ne!(added, base, "a new skin folder");

    tmp.write("UserSkins/.livery/inactive/Sherman/sherman.blk", b"x");
    let deactivated = hangar_signature(&us).unwrap();
    assert_ne!(deactivated, added, "a skin in the inactive folder");

    fs::rename(us.join("Panther"), us.join("Panther (2)")).unwrap();
    let renamed = hangar_signature(&us).unwrap();
    assert_ne!(renamed, deactivated, "a renamed folder");

    fs::remove_dir_all(us.join("Panther (2)")).unwrap();
    assert_ne!(hangar_signature(&us).unwrap(), renamed, "a removed folder");
}

// A file added *inside* a skin folder moves that folder's time, but Windows may report the new
// time in the parent's listing late, so no test depends on it (see `hangar_signature`).
#[test]
fn the_fingerprint_sees_top_level_files_and_folders_coming_and_going() {
    let tmp = TempDir::new("signature-files");
    let us = tmp.mkdir("UserSkins");
    tmp.write("UserSkins/Tiger/tiger.blk", b"x");
    let before = hangar_signature(&us).unwrap();
    let stray = tmp.write("UserSkins/readme.txt", b"a file the game ignores");
    let with_file = hangar_signature(&us).unwrap();
    assert_ne!(with_file, before, "a new top-level file");
    fs::remove_file(stray).unwrap();
    assert_ne!(hangar_signature(&us).unwrap(), with_file, "removed again");
    fs::remove_dir_all(us.join("Tiger")).unwrap();
    assert_ne!(hangar_signature(&us).unwrap(), before, "a skin folder deleted outside Livery");
}

#[test]
fn a_missing_user_skins_has_a_fingerprint_of_its_own() {
    let tmp = TempDir::new("signature-missing");
    let us = tmp.path().join("UserSkins");
    let missing = hangar_signature(&us).unwrap();
    assert_eq!(hangar_signature(&us).unwrap(), missing);
    fs::create_dir(&us).unwrap();
    let empty = hangar_signature(&us).unwrap();
    assert_ne!(empty, missing, "created");
}

// ── Folder choice ───────────────────────────────────────────────────────────

fn settings_with(watch: Option<&Path>) -> Settings {
    Settings { watch_folder: watch.map(|p| p.display().to_string()), ..Settings::default() }
}

#[test]
fn the_watched_folder_is_the_saved_one_else_the_default() {
    let saved = Settings { watch_folder: Some("  D:/Skins  ".into()), ..Settings::default() };
    let default = || Some(PathBuf::from("C:\\Users\\me\\Downloads"));
    let chosen = watched_folder(&saved, default).unwrap();
    assert!(chosen.to_string_lossy().ends_with("Skins"), "trimmed and native");
    assert_eq!(watched_folder(&Settings::default(), default), default());
    let blank = Settings { watch_folder: Some("  ".into()), ..Settings::default() };
    assert_eq!(watched_folder(&blank, default), default());
    assert_eq!(watched_folder(&Settings::default(), || None), None);
}

#[test]
fn a_named_folder_must_exist() {
    let tmp = TempDir::new("choose");
    let downloads = tmp.mkdir("Downloads");
    let picked = tmp.mkdir("Picked");
    let s = settings_with(None);
    let shown = picked.display().to_string();
    let chosen = choose_folder(&s, Some(&format!("\"{shown}\"")), true, Some(downloads.clone()), None).unwrap();
    assert_eq!(chosen.as_deref(), Some(picked.as_path()), "quotes and spaces trimmed");

    let gone = tmp.path().join("Gone");
    for enabled in [true, false] {
        let e = err(choose_folder(&s, Some(&gone.display().to_string()), enabled, Some(downloads.clone()), None));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, WATCH_FOLDER_GONE), "{enabled}");
        let e = err(choose_folder(&s, Some("  "), enabled, Some(downloads.clone()), None));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, WATCH_FOLDER_GONE));
    }
    let file = tmp.write("file.txt", b"x");
    let e = err(choose_folder(&s, Some(&file.display().to_string()), true, None, None));
    assert_eq!(e.message, WATCH_FOLDER_GONE, "a file is not a folder");
}

#[test]
fn without_a_path_the_saved_folder_then_downloads_is_used() {
    let tmp = TempDir::new("choose-default");
    let downloads = tmp.mkdir("Downloads");
    let saved = tmp.mkdir("Saved");
    let chosen = choose_folder(&settings_with(Some(&saved)), None, true, Some(downloads.clone()), None).unwrap();
    assert_eq!(chosen.as_deref(), Some(saved.as_path()));
    let chosen = choose_folder(&settings_with(None), None, true, Some(downloads.clone()), None).unwrap();
    assert_eq!(chosen.as_deref(), Some(downloads.as_path()));

    let e = err(choose_folder(&settings_with(None), None, true, None, None));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, NO_DOWNLOADS_FOLDER));
    assert_eq!(choose_folder(&settings_with(None), None, false, None, None).unwrap(), None, "turning off");
}

#[test]
fn turning_on_needs_the_saved_folder_but_turning_off_accepts_it_gone() {
    let tmp = TempDir::new("choose-gone");
    let gone = tmp.path().join("Gone");
    let s = settings_with(Some(&gone));
    let e = err(choose_folder(&s, None, true, None, None));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, WATCH_FOLDER_GONE));
    assert!(e.detail.is_some_and(|d| d.ends_with("Gone")));
    assert_eq!(choose_folder(&s, None, false, None, None).unwrap().as_deref(), Some(gone.as_path()));
}

#[test]
fn the_watched_folder_cannot_be_user_skins_or_inside_it() {
    let tmp = TempDir::new("choose-us");
    let game = tmp.mkdir("War Thunder");
    let us = tmp.mkdir("War Thunder/UserSkins");
    let inside = tmp.mkdir("War Thunder/UserSkins/Tiger");
    let sibling = tmp.mkdir("War Thunder/UserSkins2");
    let s = settings_with(None);
    for folder in [&us, &inside] {
        let e = err(choose_folder(&s, Some(&folder.display().to_string()), true, None, Some(&us)));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, WATCH_INSIDE_USER_SKINS));
    }
    for folder in [&game, &sibling] {
        let chosen = choose_folder(&s, Some(&folder.display().to_string()), true, None, Some(&us)).unwrap();
        assert_eq!(chosen.as_deref(), Some(folder.as_path()));
    }
}

#[test]
fn within_compares_whole_path_components() {
    let base = Path::new("C:\\Games\\War Thunder\\UserSkins");
    assert!(is_within(base, base));
    assert!(is_within(&base.join("Tiger"), base));
    assert!(is_within(&base.join(".livery").join("partial"), base));
    assert!(!is_within(Path::new("C:\\Games\\War Thunder\\UserSkins2"), base));
    assert!(!is_within(Path::new("C:\\Games\\War Thunder"), base));
    if cfg!(windows) {
        assert!(is_within(Path::new("c:/games/war thunder/userskins/Tiger/"), base), "case and separators");
        assert!(is_within(Path::new("C:\\Downloads"), Path::new("C:\\")), "a drive root");
    }
}
