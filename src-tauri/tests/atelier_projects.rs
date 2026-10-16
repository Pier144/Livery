//! Atelier's project store on temp folders: create, list, get and save keep the frontend's layers
//! as they are; envelopes that don't check out are refused (on save) or skipped (on list); delete
//! goes through a trash that Undo empties back and launch purges; duplicates get a free name;
//! thumbnails must be PNGs.

use livery_lib::atelier::project::{
    is_slot_name, ProjectStore, MAX_LAYERS, MAX_NAME_CHARS, MAX_THUMB_BYTES, PROJECT_FILE, PROJECT_INVALID,
    PROJECT_NAME_INVALID, PROJECT_NOT_FOUND, PROJECT_THUMB_INVALID, THUMB_FILE,
};
use livery_lib::error::{AppError, ErrorCode};
use livery_lib::model::{AtelierProject, AtelierSlotChoice};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-projects-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn at(secs: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_790_000_000 + secs)
}

fn err<T: std::fmt::Debug>(result: Result<T, AppError>) -> AppError {
    result.expect_err("expected an error")
}

fn slots() -> Vec<AtelierSlotChoice> {
    vec![
        AtelierSlotChoice { texture: "m4a3e2_sherman_jumbo_body_c".into(), enabled: true },
        AtelierSlotChoice { texture: "mg_browning_m2hb_mount_c".into(), enabled: false },
    ]
}

const JUMBO: &str = "us_m4a3e2_sherman_jumbo";

fn store(dir: &TempDir) -> ProjectStore {
    ProjectStore::new(&dir.path().join("atelier"))
}

/// A PNG signature followed by `extra` bytes (the store only checks the signature and the size).
fn png(extra: usize) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    bytes.resize(8 + extra, 7);
    bytes
}

#[test]
fn create_list_get_and_save_keep_the_layers_as_they_are() {
    let dir = TempDir::new("roundtrip");
    let store = store(&dir);
    assert!(store.list().unwrap().is_empty(), "no folder yet: nothing");

    let created = store.create("  Desert Jumbo ", JUMBO, slots(), at(0)).unwrap();
    assert!(created.id.starts_with("p-"), "{}", created.id);
    assert_eq!((created.version, created.name.as_str(), created.vehicle.as_str()), (1, "Desert Jumbo", JUMBO));
    assert_eq!(created.created_at, created.updated_at);
    assert_eq!(created.slots, slots());
    assert!(!created.output.high_quality);
    assert_eq!(created.installed_skin_id, None);
    assert_eq!(created.layers, json!([]));
    assert!(dir.path().join("atelier").join("projects").join(&created.id).join(PROJECT_FILE).is_file());

    let layers = json!([
        { "id": "l1", "kind": "base", "mode": "camo", "colors": ["#56603f", "#c2b280"], "scale": 1.5, "seed": 42,
          "future": { "nested": [1, 2.25, null, true] } },
        { "id": "l2", "kind": "sticker", "unknownToRust": "kept" },
        { "id": "m", "kind": "mask", "strokes": [{ "erase": false, "radius": 0.05, "points": [[0.1, -0.2, 3.0]] }] }
    ]);
    let edited = AtelierProject { name: "Desert Jumbo v2".into(), layers: layers.clone(), ..created.clone() };
    let saved = store.save(&edited, at(90)).unwrap();
    assert_eq!(saved.layers, layers);
    assert_ne!(saved.updated_at, created.updated_at, "updated_at moves");
    assert_eq!(saved.created_at, created.created_at);
    assert_eq!(store.get(&created.id).unwrap(), saved);

    // A second project, newer: listed first.
    let other = store.create("Winter", JUMBO, slots(), at(200)).unwrap();
    let list = store.list().unwrap();
    let ids: Vec<&str> = list.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, [other.id.as_str(), created.id.as_str()]);
    assert_eq!((list[1].name.as_str(), list[1].vehicle.as_str(), list[1].has_thumb), ("Desert Jumbo v2", JUMBO, false));
    assert_eq!(list[1].updated_at, saved.updated_at);
}

#[test]
fn save_keeps_the_installed_skin_and_the_creation_time() {
    let dir = TempDir::new("installed");
    let store = store(&dir);
    let created = store.create("Jumbo", JUMBO, slots(), at(0)).unwrap();
    let installed = store.set_installed_skin(&created.id, "s-1", at(10)).unwrap();
    assert_eq!(installed.installed_skin_id.as_deref(), Some("s-1"));

    // An autosave that started before the apply finished carries no skin id: it is kept.
    let stale = AtelierProject { name: "Renamed".into(), created_at: "2000-01-01T00:00:00Z".into(), ..created.clone() };
    let saved = store.save(&stale, at(20)).unwrap();
    assert_eq!(saved.installed_skin_id.as_deref(), Some("s-1"));
    assert_eq!(saved.created_at, created.created_at, "the creation time is the store's");
    assert_eq!(saved.name, "Renamed");
    // A newer id replaces it.
    let newer = AtelierProject { installed_skin_id: Some("s-2".into()), ..saved };
    assert_eq!(store.save(&newer, at(30)).unwrap().installed_skin_id.as_deref(), Some("s-2"));
}

#[test]
fn invalid_envelopes_are_refused() {
    let dir = TempDir::new("invalid");
    let store = store(&dir);
    let p = store.create("Jumbo", JUMBO, slots(), at(0)).unwrap();
    let invalid = |project: AtelierProject| err(store.save(&project, at(1)));

    let bad_input = |e: AppError| assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, PROJECT_INVALID));
    bad_input(invalid(AtelierProject { version: 2, ..p.clone() }));
    bad_input(invalid(AtelierProject { vehicle: String::new(), ..p.clone() }));
    bad_input(invalid(AtelierProject { vehicle: "us tank/../x".into(), ..p.clone() }));
    bad_input(invalid(AtelierProject { layers: json!({ "not": "an array" }), ..p.clone() }));
    bad_input(invalid(AtelierProject { layers: json!(vec![json!({}); MAX_LAYERS + 1]), ..p.clone() }));
    let huge = "x".repeat(9 * 1024 * 1024);
    bad_input(invalid(AtelierProject { layers: json!([{ "data": huge }]), ..p.clone() }));
    let slot = |texture: &str| vec![AtelierSlotChoice { texture: texture.into(), enabled: true }];
    bad_input(invalid(AtelierProject { slots: slot("../evil_c"), ..p.clone() }));
    bad_input(invalid(AtelierProject { slots: slot("body_d"), ..p.clone() }));
    let twice = [slot("a_body_c"), slot("A_BODY_C")].concat();
    bad_input(invalid(AtelierProject { slots: twice, ..p.clone() }));
    bad_input(invalid(AtelierProject { installed_skin_id: Some(String::new()), ..p.clone() }));

    for name in ["", "   ", &"n".repeat(MAX_NAME_CHARS + 1)] {
        let e = invalid(AtelierProject { name: name.to_owned(), ..p.clone() });
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, PROJECT_NAME_INVALID), "{name:?}");
    }
    let e = err(store.create("", JUMBO, slots(), at(0)));
    assert_eq!(e.message, PROJECT_NAME_INVALID);

    // Ids that aren't a project folder of this store.
    for id in ["", "..", "../p-1", "p-missing", "a\\b"] {
        let e = invalid(AtelierProject { id: id.to_owned(), ..p.clone() });
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, PROJECT_NOT_FOUND), "{id:?}");
        assert_eq!(err(store.get(id)).message, PROJECT_NOT_FOUND);
    }
    assert_eq!(store.get(&p.id).unwrap(), p, "nothing was written");
    // The limit counts characters, not bytes.
    assert!(store.save(&AtelierProject { name: "é".repeat(MAX_NAME_CHARS), ..p.clone() }, at(1)).is_ok());
}

#[test]
fn unreadable_projects_are_skipped_by_list_and_refused_by_get() {
    let dir = TempDir::new("unreadable");
    let store = store(&dir);
    let good = store.create("Good", JUMBO, slots(), at(0)).unwrap();
    let projects = dir.path().join("atelier").join("projects");
    let write = |folder: &str, text: String| {
        fs::create_dir_all(projects.join(folder)).unwrap();
        fs::write(projects.join(folder).join(PROJECT_FILE), text).unwrap();
    };
    write("p-garbage", "{ not json".into());
    // Copied by hand under another folder: its id doesn't match.
    write("p-moved", fs::read_to_string(projects.join(&good.id).join(PROJECT_FILE)).unwrap());
    let mut v = serde_json::to_value(&good).unwrap();
    v["id"] = json!("p-newer");
    v["version"] = json!(7);
    write("p-newer", v.to_string());
    fs::create_dir_all(projects.join("p-empty")).unwrap();
    fs::write(projects.join("stray.txt"), "x").unwrap();

    let ids: Vec<String> = store.list().unwrap().into_iter().map(|p| p.id).collect();
    assert_eq!(ids, [good.id]);
    for id in ["p-garbage", "p-moved", "p-newer"] {
        let e = err(store.get(id));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Parse, PROJECT_INVALID), "{id}");
    }
    assert_eq!(err(store.get("p-empty")).message, PROJECT_NOT_FOUND);
}

#[test]
fn delete_goes_to_the_trash_until_undone_or_forgotten() {
    let dir = TempDir::new("trash");
    let store = store(&dir);
    let a = store.create("A", JUMBO, slots(), at(0)).unwrap();
    let b = store.create("B", JUMBO, slots(), at(1)).unwrap();
    store.set_thumb(&a.id, &png(10)).unwrap();

    store.delete(&a.id).unwrap();
    assert_eq!(store.list().unwrap().len(), 1);
    assert_eq!(err(store.get(&a.id)).message, PROJECT_NOT_FOUND);
    assert_eq!(err(store.save(&a, at(5))).message, PROJECT_NOT_FOUND, "an autosave can't bring it back");
    assert!(dir.path().join("atelier").join(".trash").join(&a.id).is_dir());

    store.undo_delete(&a.id).unwrap();
    assert_eq!(store.get(&a.id).unwrap(), a);
    assert_eq!(store.thumb(&a.id).unwrap(), png(10), "the whole folder came back");
    assert_eq!(store.list().unwrap().len(), 2);

    store.delete(&b.id).unwrap();
    store.forget_deleted(&b.id).unwrap();
    assert_eq!(err(store.undo_delete(&b.id)).message, PROJECT_NOT_FOUND);
    assert!(!dir.path().join("atelier").join(".trash").join(&b.id).exists());
    store.forget_deleted(&b.id).unwrap();
    assert_eq!(err(store.delete(&b.id)).message, PROJECT_NOT_FOUND);
    assert_eq!(err(store.delete("..")).message, PROJECT_NOT_FOUND);
}

#[test]
fn leftover_trash_is_purged_at_launch() {
    let dir = TempDir::new("purge");
    let store = store(&dir);
    assert_eq!(store.purge_trash(), 0, "no trash folder");
    let a = store.create("A", JUMBO, slots(), at(0)).unwrap();
    let b = store.create("B", JUMBO, slots(), at(1)).unwrap();
    let c = store.create("C", JUMBO, slots(), at(2)).unwrap();
    store.delete(&a.id).unwrap();
    store.delete(&b.id).unwrap();

    // The next launch.
    let again = ProjectStore::new(&dir.path().join("atelier"));
    assert_eq!(again.purge_trash(), 2);
    assert_eq!(err(again.undo_delete(&a.id)).message, PROJECT_NOT_FOUND);
    let ids: Vec<String> = again.list().unwrap().into_iter().map(|p| p.id).collect();
    assert_eq!(ids, [c.id]);
}

#[test]
fn duplicates_get_a_free_name_and_no_installed_skin() {
    let dir = TempDir::new("duplicate");
    let store = store(&dir);
    let original = store.create("Jumbo", JUMBO, slots(), at(0)).unwrap();
    let original = store.set_installed_skin(&original.id, "s-1", at(1)).unwrap();
    let original = store.save(&AtelierProject { layers: json!([{ "id": "l1" }]), ..original }, at(2)).unwrap();
    store.set_thumb(&original.id, &png(3)).unwrap();

    let copy = store.duplicate(&original.id, at(50)).unwrap();
    assert_ne!(copy.id, original.id);
    assert_eq!(copy.name, "Jumbo (2)");
    assert_eq!(copy.installed_skin_id, None, "the copy installs its own skin");
    assert_eq!(
        (copy.layers.clone(), copy.slots.clone(), copy.vehicle.clone()),
        (original.layers.clone(), slots(), JUMBO.into())
    );
    assert_eq!(copy.created_at, copy.updated_at);
    assert_ne!(copy.created_at, original.created_at);
    assert_eq!(store.get(&copy.id).unwrap(), copy);
    assert_eq!(store.thumb(&copy.id).unwrap(), png(3));

    assert_eq!(store.duplicate(&original.id, at(51)).unwrap().name, "Jumbo (3)");
    assert_eq!(store.duplicate(&copy.id, at(52)).unwrap().name, "Jumbo (2) (2)");

    // At the length limit the name is shortened to make room.
    let long = store.create(&"L".repeat(MAX_NAME_CHARS), JUMBO, slots(), at(60)).unwrap();
    let copy = store.duplicate(&long.id, at(61)).unwrap();
    assert_eq!(copy.name, format!("{} (2)", "L".repeat(MAX_NAME_CHARS - 4)));
    assert_eq!(err(store.duplicate("p-missing", at(62))).message, PROJECT_NOT_FOUND);
}

#[test]
fn thumbnails_must_be_small_pngs() {
    let dir = TempDir::new("thumb");
    let store = store(&dir);
    let p = store.create("Jumbo", JUMBO, slots(), at(0)).unwrap();
    assert!(store.thumb(&p.id).unwrap().is_empty(), "none yet");
    assert!(!store.list().unwrap()[0].has_thumb);

    store.set_thumb(&p.id, &png(100)).unwrap();
    assert_eq!(store.thumb(&p.id).unwrap(), png(100));
    assert!(store.list().unwrap()[0].has_thumb);
    store.set_thumb(&p.id, &png(MAX_THUMB_BYTES - 8)).unwrap();

    for bad in [b"GIF89a....".to_vec(), Vec::new(), png(MAX_THUMB_BYTES - 7)] {
        let e = err(store.set_thumb(&p.id, &bad));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, PROJECT_THUMB_INVALID));
    }
    assert_eq!(store.thumb(&p.id).unwrap().len(), MAX_THUMB_BYTES, "the last good one stays");
    assert_eq!(err(store.set_thumb("p-missing", &png(1))).message, PROJECT_NOT_FOUND);
    assert_eq!(err(store.thumb("p-missing")).message, PROJECT_NOT_FOUND);
    let folder = dir.path().join("atelier").join("projects").join(&p.id);
    assert!(folder.join(THUMB_FILE).is_file());
    let mut names: Vec<String> =
        fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, [PROJECT_FILE, THUMB_FILE], "no temp files left");
}

#[test]
fn slot_names_are_safe_texture_names() {
    for good in ["m4a3e2_sherman_jumbo_body_c", "TANK_A_Turret_C", "t-34_85_c", "a.b_c"] {
        assert!(is_slot_name(good), "{good}");
    }
    for bad in ["", "_c", "body", "body_d", "../x_c", "a/b_c", "a\\b_c", ".hidden_c", "a b_c", "a\"b_c", "é_c"] {
        assert!(!is_slot_name(bad), "{bad}");
    }
    assert!(!is_slot_name(&format!("{}_c", "x".repeat(200))));
}
