//! For you's seen state (`<appData>/for_you.json`) on temp folders: the week-ago default, mark
//! seen, persistence, validation and tolerant loading of bad files.

use livery_lib::error::{unreadable_at_launch_message, ErrorCode};
use livery_lib::library::time::{parse_rfc3339, unix_secs};
use livery_lib::wtlive::following::NOT_A_TIME;
use livery_lib::wtlive::for_you::{ForYouStore, FOR_YOU_NOT_SAVED, FOR_YOU_VERSION, NEW_FOR_A_FIRST_VISIT};
use livery_lib::wtlive::FOR_YOU_FILE;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::SystemTime;

const T1: &str = "2026-09-01T10:00:00Z";
const T2: &str = "2026-09-19T08:30:00Z";

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-for-you-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    /// Nested, so the first write must create the folder.
    fn path(&self) -> PathBuf {
        self.0.join("data").join(FOR_YOU_FILE)
    }

    fn bad(&self) -> PathBuf {
        self.path().with_extension("json.bad")
    }

    fn write(&self, text: &str) {
        fs::create_dir_all(self.path().parent().unwrap()).unwrap();
        fs::write(self.path(), text).unwrap();
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.path()).unwrap()).unwrap()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Seconds between `at` (RFC 3339) and now, minus `ago`: close to 0 when `at` is `ago` before now.
fn off_by(at: &str, ago: i64) -> i64 {
    let at = parse_rfc3339(at).unwrap_or_else(|| panic!("not RFC 3339: {at}"));
    (unix_secs(SystemTime::now()) - ago - at).abs()
}

#[test]
fn missing_file_reads_as_a_week_ago_and_is_not_created() {
    let tmp = TempDir::new("missing");
    let store = ForYouStore::load(tmp.path());
    assert_eq!(NEW_FOR_A_FIRST_VISIT.as_secs(), 7 * 24 * 3600);
    assert!(off_by(&store.last_seen_at(), 7 * 24 * 3600) < 60, "{}", store.last_seen_at());
    assert!(!store.is_read_only());
    assert!(!tmp.path().exists(), "loading never writes");
    assert!(!tmp.path().parent().unwrap().exists());
}

#[test]
fn mark_seen_at_writes_the_file_and_a_new_load_reads_it() {
    let tmp = TempDir::new("mark");
    let store = ForYouStore::load(tmp.path());
    assert_eq!(store.mark_seen_at(T1).unwrap(), T1);
    assert_eq!(store.last_seen_at(), T1);
    assert_eq!(tmp.json(), serde_json::json!({ "version": FOR_YOU_VERSION, "lastSeenAt": T1 }));
    assert!(!tmp.path().with_extension("json.tmp").exists(), "temp file is renamed away");
    assert_eq!(ForYouStore::load(tmp.path()).last_seen_at(), T1, "persisted");
    assert_eq!(store.mark_seen_at(&format!(" {T2} ")).unwrap(), T2, "trimmed");
    assert_eq!(ForYouStore::load(tmp.path()).last_seen_at(), T2);
    assert!(!tmp.bad().exists());
}

#[test]
fn mark_seen_uses_the_current_time() {
    let tmp = TempDir::new("now");
    let store = ForYouStore::load(tmp.path());
    let seen = store.mark_seen().unwrap();
    assert!(off_by(&seen, 0) < 60, "{seen}");
    assert_eq!(store.last_seen_at(), seen);
    assert_eq!(ForYouStore::load(tmp.path()).last_seen_at(), seen);
}

#[test]
fn a_bad_time_is_invalid_input_and_changes_nothing() {
    let tmp = TempDir::new("badtime");
    let store = ForYouStore::load(tmp.path());
    let before = store.last_seen_at();
    for bad in ["yesterday", "2026-13-01T00:00:00Z", ""] {
        let e = store.mark_seen_at(bad).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, NOT_A_TIME), "{bad}");
    }
    assert_eq!(store.last_seen_at(), before);
    assert!(!tmp.path().exists());
}

#[test]
fn corrupt_file_is_set_aside_and_reads_as_now() {
    let tmp = TempDir::new("corrupt");
    tmp.write("{ not json");
    let store = ForYouStore::load(tmp.path());
    assert!(off_by(&store.last_seen_at(), 0) < 60, "{}", store.last_seen_at());
    assert!(!store.is_read_only());
    assert!(!tmp.path().exists(), "moved away");
    assert_eq!(fs::read_to_string(tmp.bad()).unwrap(), "{ not json");
    // The next mark writes a fresh file.
    store.mark_seen_at(T1).unwrap();
    assert_eq!(ForYouStore::load(tmp.path()).last_seen_at(), T1);
}

#[test]
fn a_file_without_a_usable_time_is_corrupt_too() {
    for (name, body) in [
        ("shape", r#"{ "version": 1, "lastSeenAt": 42 }"#),
        ("soon", r#"{ "version": 1, "lastSeenAt": "soon" }"#),
        ("empty", "{}"),
        ("array", "[]"),
    ] {
        let tmp = TempDir::new(name);
        tmp.write(body);
        let store = ForYouStore::load(tmp.path());
        assert!(off_by(&store.last_seen_at(), 0) < 60, "{name}: {}", store.last_seen_at());
        assert_eq!(fs::read_to_string(tmp.bad()).unwrap(), body, "{name}");
        assert!(!tmp.path().exists(), "{name}");
    }
}

#[test]
fn bom_extra_fields_and_newer_versions_load() {
    let tmp = TempDir::new("loose");
    tmp.write(&format!("\u{feff}{{ \"version\": 7, \"future\": {{}}, \"lastSeenAt\": \"{T1}\" }}"));
    assert_eq!(ForYouStore::load(tmp.path()).last_seen_at(), T1);
    assert!(!tmp.bad().exists());
}

#[test]
fn unreadable_file_reads_as_now_and_refuses_to_write() {
    let tmp = TempDir::new("unreadable");
    let path = tmp.0.join(FOR_YOU_FILE);
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("inside.txt"), "x").unwrap();
    let store = ForYouStore::load(path.clone());
    assert!(store.is_read_only());
    assert!(off_by(&store.last_seen_at(), 0) < 60, "{}", store.last_seen_at());
    let before = store.last_seen_at();
    for result in [store.mark_seen_at(T1), store.mark_seen()] {
        let e = result.unwrap_err();
        assert_eq!(e.code, ErrorCode::Io);
        assert_eq!(e.message, unreadable_at_launch_message(FOR_YOU_FILE));
        assert!(e.detail.is_some(), "the OS error is kept as the detail");
    }
    assert_eq!(store.last_seen_at(), before, "memory unchanged");
    assert_eq!(fs::read_to_string(path.join("inside.txt")).unwrap(), "x", "untouched");
    assert!(!path.with_extension("json.bad").exists());
}

#[test]
fn a_failed_write_leaves_memory_and_disk_as_they_were() {
    let tmp = TempDir::new("failwrite");
    let store = ForYouStore::load(tmp.path());
    store.mark_seen_at(T1).unwrap();
    // A folder where the temp file goes makes the write fail.
    fs::create_dir_all(tmp.path().with_extension("json.tmp")).unwrap();
    let e = store.mark_seen_at(T2).unwrap_err();
    assert_eq!(e.code, ErrorCode::Io);
    assert_eq!(e.message, FOR_YOU_NOT_SAVED);
    assert!(e.detail.is_some(), "the OS error is kept as the detail");
    assert_eq!(store.last_seen_at(), T1, "memory unchanged");
    assert_eq!(ForYouStore::load(tmp.path()).last_seen_at(), T1, "file unchanged");
}
