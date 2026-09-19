//! Collections on temp folders: CRUD, restore (Undo of a delete), membership changes, and
//! activation moving folders between `UserSkins` and `.livery/inactive`.

use livery_lib::error::ErrorCode;
use livery_lib::library::collections::{activate, create, delete, list, restore, set_skins, update};
use livery_lib::library::index::LibraryStore;
use livery_lib::library::layout::inactive_dir;
use livery_lib::library::time::parse_rfc3339;
use livery_lib::library::{import_folders, ops};
use livery_lib::model::{Collection, HangarSkin};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-coll-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn index_path(&self) -> PathBuf {
        self.0.join("data").join("library.json")
    }

    fn user_skins(&self) -> PathBuf {
        self.0.join("game").join("UserSkins")
    }

    fn skin(&self, folder: &str, code: &str) {
        let dir = self.user_skins().join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{code}.blk")), "").unwrap();
    }

    fn is_active(&self, folder: &str) -> bool {
        let active = self.user_skins().join(folder).is_dir();
        let inactive = inactive_dir(&self.user_skins()).join(folder).is_dir();
        assert!(active != inactive, "{folder} must be in exactly one place");
        active
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn store(tmp: &TempDir) -> LibraryStore {
    LibraryStore::load(tmp.index_path())
}

fn hangar(tmp: &TempDir, folders: &[&str]) -> (LibraryStore, Vec<HangarSkin>) {
    for folder in folders {
        tmp.skin(folder, "su_27");
    }
    let store = store(tmp);
    let list: Vec<String> = folders.iter().map(|s| (*s).to_owned()).collect();
    let index = import_folders(&tmp.user_skins(), &store, &list).unwrap();
    (store, index)
}

fn ids(skins: &[&HangarSkin]) -> Vec<String> {
    skins.iter().map(|s| s.id.clone()).collect()
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

// ── CRUD ────────────────────────────────────────────────────────────────────

#[test]
fn create_trims_validates_and_persists() {
    let tmp = TempDir::new("create");
    let store = store(&tmp);
    let before = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    let night = create(&store, "  Night ops ", Some("  Dark schemes  ")).unwrap();
    assert_eq!(night.name, "Night ops");
    assert_eq!(night.description.as_deref(), Some("Dark schemes"));
    assert_eq!(night.skin_ids, Vec::<String>::new());
    assert!(night.id.starts_with("c-") && night.id.matches('-').count() == 2, "{}", night.id);
    let created = parse_rfc3339(&night.created_at).expect("RFC 3339");
    assert!(created >= before - 1 && created <= before + 60);

    let plain = create(&store, "Desert", Some("   ")).unwrap();
    assert_eq!(plain.description, None, "a blank description is none");
    assert_ne!(plain.id, night.id);

    for blank in ["", "   ", "\t\n"] {
        assert_eq!(create(&store, blank, None).unwrap_err().code, ErrorCode::InvalidInput, "{blank:?}");
    }

    let state = list(&store);
    assert_eq!(state.collections, [night.clone(), plain]);
    assert_eq!(state.active_collection_id, None);
    assert_eq!(list(&LibraryStore::load(tmp.index_path())), state, "saved");

    let json = serde_json::to_value(&state).unwrap();
    assert!(json.get("activeCollectionId").is_none(), "absent, not null");
    assert_eq!(json["collections"][0]["skinIds"], serde_json::json!([]));
}

#[test]
fn update_renames_describes_and_clears() {
    let tmp = TempDir::new("update");
    let store = store(&tmp);
    let c = create(&store, "Night", Some("Dark")).unwrap();

    let renamed = update(&store, &c.id, Some(" Night ops "), None).unwrap();
    assert_eq!((renamed.name.as_str(), renamed.description.as_deref()), ("Night ops", Some("Dark")));
    let described = update(&store, &c.id, None, Some("Very dark")).unwrap();
    assert_eq!((described.name.as_str(), described.description.as_deref()), ("Night ops", Some("Very dark")));
    let cleared = update(&store, &c.id, None, Some("")).unwrap();
    assert_eq!(cleared.description, None);
    assert_eq!(cleared.created_at, c.created_at);
    assert_eq!(update(&store, &c.id, None, None).unwrap(), cleared, "nothing asked, nothing changed");

    assert_eq!(update(&store, &c.id, Some("  "), Some("x")).unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(list(&store).collections, std::slice::from_ref(&cleared), "a rejected update changes nothing");
    let e = update(&store, "c-nope", Some("x"), None).unwrap_err();
    assert_eq!((e.code, e.detail.as_deref()), (ErrorCode::NotFound, Some("c-nope")));
}

#[test]
fn delete_and_restore_round_trip() {
    let tmp = TempDir::new("delete");
    let (store, index) = hangar(&tmp, &["Winter", "Desert"]);
    let a = create(&store, "A", None).unwrap();
    let b = create(&store, "B", Some("second")).unwrap();
    let b = set_skins(&store, &b.id, &ids(&[&index[1], &index[0]]), &[]).unwrap();
    activate(&tmp.user_skins(), &store, &b.id).unwrap();
    assert_eq!(list(&store).active_collection_id.as_deref(), Some(b.id.as_str()));

    let state = delete(&store, &b.id).unwrap();
    assert_eq!(state.collections, std::slice::from_ref(&a));
    assert_eq!(state.active_collection_id, None, "deleting the active collection clears it");
    assert!(tmp.is_active("Winter") && tmp.is_active("Desert"), "skins stay installed as they are");
    assert_eq!(delete(&store, &b.id).unwrap_err().code, ErrorCode::NotFound);

    let state = restore(&store, b.clone()).unwrap();
    assert_eq!(state.collections, [a.clone(), b.clone()], "appended, same id, same members");
    let e = restore(&store, b.clone()).unwrap_err();
    assert_eq!((e.code, e.detail.as_deref()), (ErrorCode::Conflict, Some(b.id.as_str())));
    let nameless = Collection { id: "c-x".into(), name: " ".into(), ..b.clone() };
    assert_eq!(restore(&store, nameless).unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(list(&LibraryStore::load(tmp.index_path())).collections, [a, b]);
}

#[test]
fn deleting_another_collection_keeps_the_active_one() {
    let tmp = TempDir::new("keep-active");
    let (store, _) = hangar(&tmp, &["Winter"]);
    let a = create(&store, "A", None).unwrap();
    let b = create(&store, "B", None).unwrap();
    activate(&tmp.user_skins(), &store, &a.id).unwrap();
    assert_eq!(delete(&store, &b.id).unwrap().active_collection_id.as_deref(), Some(a.id.as_str()));
}

// ── Members ─────────────────────────────────────────────────────────────────

#[test]
fn set_skins_keeps_order_and_uniqueness_and_ignores_unknown_ids() {
    let tmp = TempDir::new("members");
    let (store, index) = hangar(&tmp, &["Winter", "Desert", "Jungle"]);
    let (w, d, j) = (&index[0], &index[1], &index[2]);
    let c = create(&store, "Mix", None).unwrap();

    let first =
        set_skins(&store, &c.id, &strings(&[d.id.as_str(), "s-nope", w.id.as_str(), d.id.as_str()]), &[]).unwrap();
    assert_eq!(first.skin_ids, ids(&[d, w]), "in order, once each, known ids only");
    let second = set_skins(&store, &c.id, &ids(&[j, w]), &ids(&[d])).unwrap();
    assert_eq!(second.skin_ids, ids(&[w, j]), "remove and add in one call");
    let third = set_skins(&store, &c.id, &ids(&[d]), &ids(&[d])).unwrap();
    assert_eq!(third.skin_ids, ids(&[w, j]), "remove wins over add");
    let fourth = set_skins(&store, &c.id, &[], &strings(&["s-nope", j.id.as_str()])).unwrap();
    assert_eq!(fourth.skin_ids, ids(&[w]));
    assert_eq!(list(&store).collections[0], fourth);
    assert_eq!(set_skins(&store, "c-nope", &ids(&[w]), &[]).unwrap_err().code, ErrorCode::NotFound);
}

// ── Activation ──────────────────────────────────────────────────────────────

#[test]
fn activating_moves_folders_so_only_members_are_in_the_game() {
    let tmp = TempDir::new("activate");
    let (store, index) = hangar(&tmp, &["Winter", "Desert", "Jungle"]);
    let (w, d, j) = (&index[0], &index[1], &index[2]);
    let cold = create(&store, "Cold", None).unwrap();
    set_skins(&store, &cold.id, &ids(&[w, j]), &[]).unwrap();
    let hot = create(&store, "Hot", None).unwrap();
    set_skins(&store, &hot.id, &ids(&[d]), &[]).unwrap();

    let after = activate(&tmp.user_skins(), &store, &cold.id).unwrap();
    assert_eq!(after.iter().map(|s| s.active).collect::<Vec<_>>(), [true, false, true]);
    assert!(tmp.is_active("Winter") && !tmp.is_active("Desert") && tmp.is_active("Jungle"));
    assert_eq!(list(&store).active_collection_id.as_deref(), Some(cold.id.as_str()));

    let after = activate(&tmp.user_skins(), &store, &hot.id).unwrap();
    assert_eq!(after.iter().map(|s| s.active).collect::<Vec<_>>(), [false, true, false]);
    assert!(!tmp.is_active("Winter") && tmp.is_active("Desert") && !tmp.is_active("Jungle"));
    assert_eq!(list(&store).active_collection_id.as_deref(), Some(hot.id.as_str()));
    let saved = LibraryStore::load(tmp.index_path());
    assert_eq!(saved.all(), after);
    assert_eq!(list(&saved).active_collection_id.as_deref(), Some(hot.id.as_str()));

    // Toggling a skin by hand doesn't change which collection was activated last.
    ops::set_active(&tmp.user_skins(), &store, &ids(&[w]), true).unwrap();
    assert_eq!(list(&store).active_collection_id.as_deref(), Some(hot.id.as_str()));

    let e = activate(&tmp.user_skins(), &store, "c-nope").unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(tmp.is_active("Winter") && tmp.is_active("Desert"), "nothing moved");
}

#[test]
fn activation_clash_skips_the_skin_but_activates_the_rest() {
    let tmp = TempDir::new("activate-clash");
    let (store, index) = hangar(&tmp, &["Winter", "Desert"]);
    let (w, d) = (&index[0], &index[1]);
    let only_desert = create(&store, "Desert only", None).unwrap();
    set_skins(&store, &only_desert.id, &ids(&[d]), &[]).unwrap();
    let only_winter = create(&store, "Winter only", None).unwrap();
    set_skins(&store, &only_winter.id, &ids(&[w]), &[]).unwrap();
    activate(&tmp.user_skins(), &store, &only_desert.id).unwrap();
    // Another skin named "Winter" is installed while ours is inactive.
    tmp.skin("Winter", "f_4e");

    let e = activate(&tmp.user_skins(), &store, &only_winter.id).unwrap_err();
    assert_eq!((e.code, e.detail.as_deref()), (ErrorCode::Conflict, Some("Winter")));
    let now = store.all();
    assert!(!now[0].active, "ours stays inactive");
    assert!(!now[1].active && !tmp.is_active("Desert"), "the rest follows the collection");
    assert!(tmp.user_skins().join("Winter").join("f_4e.blk").is_file());
    assert_eq!(list(&store).active_collection_id.as_deref(), Some(only_winter.id.as_str()));
}

#[test]
fn deleted_members_are_skipped_and_come_back_with_undo() {
    let tmp = TempDir::new("activate-deleted");
    let (store, index) = hangar(&tmp, &["Winter", "Desert"]);
    let (w, d) = (&index[0], &index[1]);
    let c = create(&store, "Both", None).unwrap();
    set_skins(&store, &c.id, &ids(&[w, d]), &[]).unwrap();
    let deleted = ops::delete(&tmp.user_skins(), &store, &ids(&[w]), true, SystemTime::now()).unwrap();

    let after = activate(&tmp.user_skins(), &store, &c.id).unwrap();
    assert_eq!(after.iter().map(|s| s.folder.as_str()).collect::<Vec<_>>(), ["Desert"]);
    ops::restore(&tmp.user_skins(), &store, &deleted.backup_ids).unwrap();
    assert_eq!(list(&store).collections[0].skin_ids, ids(&[w, d]));
    assert!(tmp.is_active("Winter"));
}

#[test]
fn skins_being_tried_in_game_stay_where_they_are() {
    let tmp = TempDir::new("activate-temporary");
    let (store, index) = hangar(&tmp, &["Winter", "Desert", "Tried", "Tried Off"]);
    let (w, tried, tried_off) = (&index[0], &index[2], &index[3]);
    ops::set_active(&tmp.user_skins(), &store, &ids(&[tried_off]), false).unwrap();
    // Two Try in game installs: one active (being tried), one inactive; one of them a member.
    let temporary = ids(&[tried, tried_off]);
    store
        .transact(|library, _| {
            library.skins.iter_mut().filter(|s| temporary.contains(&s.id)).for_each(|s| s.temporary = true);
            Ok(())
        })
        .unwrap();
    let c = create(&store, "Winter and the tried one", None).unwrap();
    set_skins(&store, &c.id, &ids(&[w, tried_off]), &[]).unwrap();

    let after = activate(&tmp.user_skins(), &store, &c.id).unwrap();
    let state: Vec<(&str, bool, bool)> = after.iter().map(|s| (s.folder.as_str(), s.active, s.temporary)).collect();
    assert_eq!(
        state,
        [("Winter", true, false), ("Desert", false, false), ("Tried", true, true), ("Tried Off", false, true)],
        "neither activated nor deactivated"
    );
    assert!(tmp.is_active("Winter") && !tmp.is_active("Desert"));
    assert!(tmp.is_active("Tried") && !tmp.is_active("Tried Off"), "their folders didn't move");
    assert_eq!(list(&store).active_collection_id.as_deref(), Some(c.id.as_str()));
}
