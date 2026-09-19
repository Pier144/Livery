//! Following (`<appData>/following.json`) on temp folders: follow/unfollow, mark seen,
//! persistence, validation and tolerant loading of bad files.

use livery_lib::error::ErrorCode;
use livery_lib::library::time::parse_rfc3339;
use livery_lib::model::{FollowEntry, FollowKind};
use livery_lib::wtlive::following::{self, FollowingStore, FOLLOWING_VERSION, MISSING_ID, MISSING_NAME};
use livery_lib::wtlive::FOLLOWING_FILE;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

const T1: &str = "2026-09-01T10:00:00Z";
const T2: &str = "2026-09-19T08:30:00Z";

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-follow-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    /// Nested, so the first write must create the folder.
    fn path(&self) -> PathBuf {
        self.0.join("data").join(FOLLOWING_FILE)
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

fn entry(kind: FollowKind, id: &str, name: &str, seen: &str) -> FollowEntry {
    FollowEntry { kind, id: id.into(), name: name.into(), last_seen_at: seen.into() }
}

#[test]
fn missing_file_is_an_empty_list_and_is_not_created() {
    let tmp = TempDir::new("missing");
    let store = FollowingStore::load(tmp.path());
    assert!(store.list().is_empty());
    assert!(!tmp.path().exists(), "loading never writes");
}

#[test]
fn follow_adds_entries_in_order_with_last_seen_now() {
    let tmp = TempDir::new("add");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Vehicle, "germ_pzkpfw_VI_ausf_e_tiger", "Tiger H1", true, T1).unwrap();
    let list = store.set_at(FollowKind::Author, "ostwind", "Ostwind", true, T2).unwrap();
    assert_eq!(
        list,
        vec![
            entry(FollowKind::Vehicle, "germ_pzkpfw_VI_ausf_e_tiger", "Tiger H1", T1),
            entry(FollowKind::Author, "ostwind", "Ostwind", T2),
        ]
    );
    assert_eq!(store.list(), list);
}

#[test]
fn set_uses_the_current_time() {
    let tmp = TempDir::new("now");
    let store = FollowingStore::load(tmp.path());
    let list = store.set(FollowKind::Author, "a1", "Author", true, None).unwrap();
    let seen = parse_rfc3339(&list[0].last_seen_at).expect("RFC 3339");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    assert!((now - seen).abs() < 60, "lastSeenAt is now");
}

#[test]
fn same_id_under_another_kind_is_another_entry() {
    let tmp = TempDir::new("kinds");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Vehicle, "tiger", "Tiger", true, T1).unwrap();
    let list = store.set_at(FollowKind::Author, "tiger", "tiger (author)", true, T1).unwrap();
    assert_eq!(list.len(), 2);
    let list = store.set_at(FollowKind::Author, "tiger", "tiger (author)", false, T2).unwrap();
    assert_eq!(list, vec![entry(FollowKind::Vehicle, "tiger", "Tiger", T1)], "only the author is unfollowed");
}

#[test]
fn following_again_keeps_last_seen_and_refreshes_the_name() {
    let tmp = TempDir::new("again");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Author, "a1", "Old name", true, T1).unwrap();
    let list = store.set_at(FollowKind::Author, "a1", "New name", true, T2).unwrap();
    assert_eq!(list, vec![entry(FollowKind::Author, "a1", "New name", T1)]);
    let again = store.set_at(FollowKind::Author, "a1", "New name", true, T2).unwrap();
    assert_eq!(again, list, "idempotent");
}

#[test]
fn unfollow_removes_and_is_idempotent() {
    let tmp = TempDir::new("remove");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Vehicle, "v1", "Vehicle one", true, T1).unwrap();
    store.set_at(FollowKind::Vehicle, "v2", "Vehicle two", true, T1).unwrap();
    let list = store.set_at(FollowKind::Vehicle, "v1", "Vehicle one", false, T2).unwrap();
    assert_eq!(list, vec![entry(FollowKind::Vehicle, "v2", "Vehicle two", T1)]);
    let again = store.set_at(FollowKind::Vehicle, "v1", "Vehicle one", false, T2).unwrap();
    assert_eq!(again, list);
    assert_eq!(FollowingStore::load(tmp.path()).list(), list, "persisted");
}

#[test]
fn unfollowing_nothing_writes_nothing() {
    let tmp = TempDir::new("noop");
    let store = FollowingStore::load(tmp.path());
    let list = store.set_at(FollowKind::Author, "nobody", "Nobody", false, T1).unwrap();
    assert!(list.is_empty());
    assert!(!tmp.path().exists());
    assert!(store.mark_seen_at(T2).unwrap().is_empty());
    assert!(!tmp.path().exists(), "marking an empty list seen writes nothing either");
}

#[test]
fn ids_and_names_are_trimmed() {
    let tmp = TempDir::new("trim");
    let store = FollowingStore::load(tmp.path());
    let list = store.set_at(FollowKind::Author, "  a1 ", " Ostwind\t", true, T1).unwrap();
    assert_eq!(list, vec![entry(FollowKind::Author, "a1", "Ostwind", T1)]);
    let list = store.set_at(FollowKind::Author, "a1 ", "Ostwind", false, T2).unwrap();
    assert!(list.is_empty(), "the trimmed id matches");
}

#[test]
fn blank_id_or_name_is_invalid_input_and_changes_nothing() {
    let tmp = TempDir::new("invalid");
    let store = FollowingStore::load(tmp.path());
    let e = store.set_at(FollowKind::Vehicle, "  ", "Tiger", true, T1).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert_eq!(e.message, MISSING_ID);
    let e = store.set_at(FollowKind::Vehicle, "tiger", "", true, T1).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert_eq!(e.message, MISSING_NAME);
    let e = store.set_at(FollowKind::Vehicle, "", "", false, T1).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput, "unfollow validates too");
    assert!(store.list().is_empty());
    assert!(!tmp.path().exists());
}

#[test]
fn a_bad_now_is_rejected() {
    let tmp = TempDir::new("badnow");
    let store = FollowingStore::load(tmp.path());
    let e = store.set_at(FollowKind::Author, "a1", "A", true, "yesterday").unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert_eq!(store.mark_seen_at("2026-13-01T00:00:00Z").unwrap_err().code, ErrorCode::InvalidInput);
    assert!(store.list().is_empty());
}

#[test]
fn mark_seen_moves_every_entry_to_now() {
    let tmp = TempDir::new("seen");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Vehicle, "v1", "Vehicle", true, T1).unwrap();
    store.set_at(FollowKind::Author, "a1", "Author", true, "2026-08-01T00:00:00Z").unwrap();
    let list = store.mark_seen_at(T2).unwrap();
    assert_eq!(
        list,
        vec![entry(FollowKind::Vehicle, "v1", "Vehicle", T2), entry(FollowKind::Author, "a1", "Author", T2)]
    );
    assert_eq!(FollowingStore::load(tmp.path()).list(), list, "persisted");
}

#[test]
fn mark_seen_with_the_current_time() {
    let tmp = TempDir::new("seennow");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Vehicle, "v1", "Vehicle", true, T1).unwrap();
    let list = store.mark_seen().unwrap();
    assert_ne!(list[0].last_seen_at, T1);
    assert!(parse_rfc3339(&list[0].last_seen_at).is_some());
}

#[test]
fn file_format_is_versioned_camel_case_and_the_temp_file_is_gone() {
    let tmp = TempDir::new("format");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Author, "a1", "Ostwind", true, T1).unwrap();
    assert_eq!(
        tmp.json(),
        serde_json::json!({
            "version": FOLLOWING_VERSION,
            "entries": [{ "kind": "author", "id": "a1", "name": "Ostwind", "lastSeenAt": T1 }]
        })
    );
    assert!(!tmp.path().with_extension("json.tmp").exists(), "temp file is renamed away");
}

#[test]
fn reload_gives_back_the_same_list() {
    let tmp = TempDir::new("reload");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Vehicle, "ussr_t_34_85", "T-34-85", true, T1).unwrap();
    let saved = store.set_at(FollowKind::Author, "a1", "Ostwind", true, T2).unwrap();
    drop(store);
    let reloaded = FollowingStore::load(tmp.path());
    assert_eq!(reloaded.list(), saved);
    assert!(!tmp.bad().exists());
}

#[test]
fn corrupt_file_is_set_aside_and_the_list_starts_empty() {
    let tmp = TempDir::new("corrupt");
    tmp.write("{ not json");
    let store = FollowingStore::load(tmp.path());
    assert!(store.list().is_empty());
    assert!(!tmp.path().exists(), "moved away");
    assert_eq!(fs::read_to_string(tmp.bad()).unwrap(), "{ not json");
    // The next change writes a fresh file.
    store.set_at(FollowKind::Author, "a1", "A", true, T1).unwrap();
    assert_eq!(FollowingStore::load(tmp.path()).list().len(), 1);
}

#[test]
fn wrong_shape_is_corrupt_too() {
    let tmp = TempDir::new("shape");
    tmp.write(r#"{ "version": 1, "entries": "all of them" }"#);
    assert!(FollowingStore::load(tmp.path()).list().is_empty());
    assert!(tmp.bad().exists());
}

#[test]
fn bad_entries_are_dropped_and_the_original_is_copied_aside() {
    let tmp = TempDir::new("entries");
    let original = format!(
        r#"{{ "version": 1, "entries": [
            {{ "kind": "vehicle", "id": "v1", "name": "Vehicle", "lastSeenAt": "{T1}" }},
            {{ "kind": "tank", "id": "v2", "name": "Unknown kind", "lastSeenAt": "{T1}" }},
            {{ "kind": "author", "id": "a1" }},
            {{ "kind": "author", "id": " ", "name": "Blank id", "lastSeenAt": "{T1}" }},
            {{ "kind": "author", "id": "a2", "name": "", "lastSeenAt": "{T1}" }},
            {{ "kind": "vehicle", "id": "v1", "name": "Duplicate", "lastSeenAt": "{T2}" }},
            42,
            {{ "kind": "author", "id": "a3", "name": "Kept", "lastSeenAt": "{T2}", "extra": true }}
        ] }}"#
    );
    tmp.write(&original);
    let store = FollowingStore::load(tmp.path());
    assert_eq!(
        store.list(),
        vec![entry(FollowKind::Vehicle, "v1", "Vehicle", T1), entry(FollowKind::Author, "a3", "Kept", T2)]
    );
    assert_eq!(fs::read_to_string(tmp.bad()).unwrap(), original, "original kept for inspection");
    assert_eq!(fs::read_to_string(tmp.path()).unwrap(), original, "loading never writes");
}

#[test]
fn a_bad_timestamp_keeps_the_follow_as_seen_now() {
    let tmp = TempDir::new("badtime");
    tmp.write(
        r#"{ "version": 1, "entries": [ { "kind": "author", "id": "a1", "name": "A", "lastSeenAt": "soon" } ] }"#,
    );
    let list = FollowingStore::load(tmp.path()).list();
    assert_eq!(list.len(), 1);
    assert!(parse_rfc3339(&list[0].last_seen_at).is_some());
    assert!(tmp.bad().exists());
}

#[test]
fn bom_missing_fields_and_newer_versions_load() {
    let tmp = TempDir::new("loose");
    let body = format!(
        r#"{{ "version": 7, "future": {{}}, "entries": [ {{ "kind": "vehicle", "id": "v1", "name": "V", "lastSeenAt": "{T1}" }} ] }}"#
    );
    tmp.write(&format!("\u{feff}{body}"));
    assert_eq!(FollowingStore::load(tmp.path()).list(), vec![entry(FollowKind::Vehicle, "v1", "V", T1)]);
    assert!(!tmp.bad().exists(), "nothing was dropped");

    let empty = TempDir::new("loose-empty");
    empty.write("{}");
    assert!(FollowingStore::load(empty.path()).list().is_empty());
    assert!(!empty.bad().exists());
}

#[test]
fn a_failed_write_leaves_memory_and_disk_as_they_were() {
    let tmp = TempDir::new("failwrite");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Author, "a1", "A", true, T1).unwrap();
    // A folder where the temp file goes makes the write fail.
    fs::create_dir_all(tmp.path().with_extension("json.tmp")).unwrap();
    let e = store.set_at(FollowKind::Author, "a2", "B", true, T2).unwrap_err();
    assert_eq!(e.code, ErrorCode::Io);
    assert_eq!(e.message, "The Following list couldn't be saved");
    assert_eq!(store.list(), vec![entry(FollowKind::Author, "a1", "A", T1)], "memory unchanged");
    assert_eq!(FollowingStore::load(tmp.path()).list(), store.list(), "file unchanged");
}

#[test]
fn select_keeps_the_requested_followed_entries_by_kind() {
    let entries = vec![
        entry(FollowKind::Vehicle, "v1", "Vehicle one", T1),
        entry(FollowKind::Vehicle, "v2", "Vehicle two", T2),
        entry(FollowKind::Author, "a1", "Author one", T2),
        entry(FollowKind::Author, "v1", "An author called v1", T1),
    ];
    let picked = following::select(&entries, &["v1".into(), "unknown".into()], &["a1".into()]);
    assert_eq!(picked, vec![entries[0].clone(), entries[2].clone()]);
    assert!(following::select(&entries, &[], &[]).is_empty());
    assert_eq!(following::select(&entries, &[" v2 ".into()], &[]), vec![entries[1].clone()], "ids are trimmed");
}

// ── lastSeenAt (the Undo of an unfollow) ────────────────────────────────────

const T0: &str = "2026-08-15T12:00:00Z";

#[test]
fn a_given_last_seen_is_stored_for_a_new_follow() {
    let tmp = TempDir::new("seen-new");
    let store = FollowingStore::load(tmp.path());
    store.set_seen_at(FollowKind::Vehicle, "v1", "Vehicle", true, None, T1).unwrap();
    let list = store.set_seen_at(FollowKind::Author, " a1 ", " Author ", true, Some(T0), T2).unwrap();
    assert_eq!(
        list,
        vec![entry(FollowKind::Vehicle, "v1", "Vehicle", T1), entry(FollowKind::Author, "a1", "Author", T0)],
        "not now: the value given"
    );
    assert_eq!(FollowingStore::load(tmp.path()).list(), list, "persisted");
}

#[test]
fn a_given_last_seen_replaces_the_one_of_an_entry_already_followed() {
    let tmp = TempDir::new("seen-again");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Author, "a1", "Old", true, T2).unwrap();
    let list = store.set_seen_at(FollowKind::Author, "a1", "New", true, Some(T0), T2).unwrap();
    assert_eq!(list, vec![entry(FollowKind::Author, "a1", "New", T0)]);
    // Without one, following again still keeps it.
    let list = store.set_seen_at(FollowKind::Author, "a1", "New", true, None, T2).unwrap();
    assert_eq!(list, vec![entry(FollowKind::Author, "a1", "New", T0)]);
}

#[test]
fn undo_of_an_unfollow_brings_the_entry_back_exactly() {
    let tmp = TempDir::new("seen-undo");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Vehicle, "germ_leopard_2a6", "Leopard 2A6", true, T0).unwrap();
    let before = store.list();
    store.set(FollowKind::Vehicle, "germ_leopard_2a6", "Leopard 2A6", false, None).unwrap();
    let seen = before[0].last_seen_at.clone();
    let after = store.set(FollowKind::Vehicle, "germ_leopard_2a6", "Leopard 2A6", true, Some(&seen)).unwrap();
    assert_eq!(after, before);
}

#[test]
fn a_bad_last_seen_is_invalid_input_and_changes_nothing() {
    let tmp = TempDir::new("seen-bad");
    let store = FollowingStore::load(tmp.path());
    store.set_at(FollowKind::Author, "a1", "A", true, T1).unwrap();
    for bad in ["", "yesterday", "2026-02-30T00:00:00Z", "2026-09-19"] {
        let e = store.set_seen_at(FollowKind::Author, "a1", "A", true, Some(bad), T2).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, following::NOT_A_TIME), "{bad:?}");
        let e = store.set_seen_at(FollowKind::Author, "a2", "B", true, Some(bad), T2).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput, "{bad:?}");
    }
    let e = store.set_seen_at(FollowKind::Author, "a1", "A", false, Some("soon"), T2).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput, "checked with an unfollow too");
    assert_eq!(store.list(), vec![entry(FollowKind::Author, "a1", "A", T1)]);
    // Offsets and fractions are RFC 3339 as well; the value is kept as given (trimmed).
    let list = store.set_seen_at(FollowKind::Author, "a1", "A", true, Some(" 2026-08-15T14:00:00.250+02:00 "), T2);
    assert_eq!(list.unwrap()[0].last_seen_at, "2026-08-15T14:00:00.250+02:00");
}
