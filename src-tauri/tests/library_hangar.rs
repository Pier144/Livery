//! M3 hangar operations on temp folders: activate/deactivate (folders move between `UserSkins`
//! and `.livery/inactive`), delete → restore round trip with collection membership, clashes,
//! export, rescan refresh/prune, the v1 → v2 index migration, and rollback when the index can't
//! be saved.

use livery_lib::backup;
use livery_lib::error::ErrorCode;
use livery_lib::library::index::{LibraryStore, INDEX_VERSION};
use livery_lib::library::layout::{backups_dir, inactive_dir};
use livery_lib::library::scan::{scan_dir, INACTIVE_ID_PREFIX};
use livery_lib::library::{collections, import_folders, ops, scan_game};
use livery_lib::model::HangarSkin;
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
        let dir = std::env::temp_dir().join(format!("livery-hangar-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn index_path(&self) -> PathBuf {
        self.0.join("data").join("library.json")
    }

    fn user_skins(&self) -> PathBuf {
        self.0.join("game").join("UserSkins")
    }

    fn inactive(&self) -> PathBuf {
        inactive_dir(&self.user_skins())
    }

    /// A skin folder under `base` with a blk for `code`, a texture and a nested file.
    fn skin_in(&self, base: &Path, folder: &str, code: &str) {
        let dir = base.join(folder);
        fs::create_dir_all(dir.join("extras")).unwrap();
        fs::write(dir.join(format!("{code}.blk")), "replace_tex{ from:t=\"x*\"; to:t=\"body_c\" }").unwrap();
        fs::write(dir.join("body_c.dds"), format!("texture of {folder}")).unwrap();
        fs::write(dir.join("extras").join("readme.txt"), "notes").unwrap();
    }

    fn skin(&self, folder: &str, code: &str) {
        self.skin_in(&self.user_skins(), folder, code);
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn ids(skins: &[&HangarSkin]) -> Vec<String> {
    skins.iter().map(|s| s.id.clone()).collect()
}

fn by_folder<'a>(skins: &'a [HangarSkin], folder: &str) -> &'a HangarSkin {
    skins.iter().find(|s| s.folder == folder).unwrap_or_else(|| panic!("no skin {folder}"))
}

fn at(secs: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(secs)
}

const T0: u64 = 1_789_832_245; // 2026-09-19T15:37:25Z

/// A store with the given folders (already in UserSkins) imported.
fn imported(tmp: &TempDir, folders: &[&str]) -> (LibraryStore, Vec<HangarSkin>) {
    let store = LibraryStore::load(tmp.index_path());
    let index = import_folders(&tmp.user_skins(), &store, &names(folders)).unwrap();
    (store, index)
}

// ── Activate / deactivate ───────────────────────────────────────────────────

#[test]
fn deactivate_and_activate_round_trip_on_disk() {
    let tmp = TempDir::new("toggle");
    tmp.skin("Winter", "su_27");
    tmp.skin("Desert", "f_4e");
    let (store, index) = imported(&tmp, &["Winter", "Desert"]);
    let winter = by_folder(&index, "Winter").clone();

    let after = ops::set_active(&tmp.user_skins(), &store, &ids(&[&winter]), false).unwrap();
    assert!(!by_folder(&after, "Winter").active);
    assert!(by_folder(&after, "Desert").active, "others untouched");
    assert!(!tmp.user_skins().join("Winter").exists(), "the game no longer sees it");
    assert_eq!(
        fs::read_to_string(tmp.inactive().join("Winter").join("body_c.dds")).unwrap(),
        "texture of Winter",
        "same folder name, same files"
    );
    assert!(tmp.inactive().join("Winter").join("extras").join("readme.txt").is_file());
    let game_view: Vec<String> = scan_dir(&tmp.user_skins()).unwrap().into_iter().map(|s| s.folder).collect();
    assert_eq!(game_view, ["Desert"], "`.livery` is not a skin folder");
    assert_eq!(LibraryStore::load(tmp.index_path()).all(), after, "saved");

    // Re-check keeps the id and sees it as inactive.
    let scanned = scan_game(&tmp.user_skins(), &store).unwrap();
    assert_eq!(by_folder(&scanned, "Winter").id, winter.id);
    assert!(!by_folder(&scanned, "Winter").active);
    assert_eq!(store.all(), after, "nothing else changed");

    let back = ops::set_active(&tmp.user_skins(), &store, &ids(&[&winter]), true).unwrap();
    assert!(by_folder(&back, "Winter").active);
    assert!(tmp.user_skins().join("Winter").join("su_27.blk").is_file());
    assert!(!tmp.inactive().join("Winter").exists());
    assert_eq!(back, index, "the index is as it started");
}

#[test]
fn already_in_place_and_unknown_ids_are_no_ops() {
    let tmp = TempDir::new("noop");
    tmp.skin("Winter", "su_27");
    let (store, index) = imported(&tmp, &["Winter"]);
    fs::remove_file(tmp.index_path()).unwrap();
    let same = ops::set_active(
        &tmp.user_skins(),
        &store,
        &names(&[index[0].id.as_str(), "s-unknown", index[0].id.as_str()]),
        true,
    )
    .unwrap();
    assert_eq!(same, index);
    assert!(!tmp.index_path().exists(), "nothing changed, nothing written");
    assert!(!tmp.inactive().exists(), "no inactive folder created");
}

#[test]
fn stale_flag_is_fixed_without_moving() {
    let tmp = TempDir::new("stale");
    tmp.skin("Winter", "su_27");
    let (store, index) = imported(&tmp, &["Winter"]);
    // Someone moved the folder into the inactive place by hand.
    fs::create_dir_all(tmp.inactive()).unwrap();
    fs::rename(tmp.user_skins().join("Winter"), tmp.inactive().join("Winter")).unwrap();
    let after = ops::set_active(&tmp.user_skins(), &store, &ids(&[&index[0]]), false).unwrap();
    assert!(!after[0].active);
    assert!(tmp.inactive().join("Winter").is_dir());
}

#[test]
fn name_clash_skips_that_skin_and_reports_conflict() {
    let tmp = TempDir::new("clash");
    tmp.skin("Winter", "su_27");
    tmp.skin("Desert", "f_4e");
    let (store, index) = imported(&tmp, &["Winter", "Desert"]);
    let all = ids(&index.iter().collect::<Vec<_>>());
    ops::set_active(&tmp.user_skins(), &store, &all, false).unwrap();
    // A different skin called "Winter" is installed meanwhile.
    tmp.skin("Winter", "ussr_t_34_85");

    let e = ops::set_active(&tmp.user_skins(), &store, &all, true).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.detail.as_deref(), Some("Winter"));
    let now = store.all();
    assert!(!by_folder(&now, "Winter").active, "the clashing skin stays inactive");
    assert!(by_folder(&now, "Desert").active, "the others still move");
    assert!(tmp.user_skins().join("Desert").is_dir());
    assert!(tmp.user_skins().join("Winter").join("ussr_t_34_85.blk").is_file(), "the other skin is untouched");
    assert!(tmp.inactive().join("Winter").join("su_27.blk").is_file());
    assert_eq!(LibraryStore::load(tmp.index_path()).all(), now, "what moved is saved");
}

#[test]
fn missing_folder_is_reported_as_not_found() {
    let tmp = TempDir::new("missing");
    tmp.skin("Winter", "su_27");
    let (store, index) = imported(&tmp, &["Winter"]);
    fs::remove_dir_all(tmp.user_skins().join("Winter")).unwrap();
    let e = ops::set_active(&tmp.user_skins(), &store, &ids(&[&index[0]]), false).unwrap_err();
    assert_eq!((e.code, e.detail.as_deref()), (ErrorCode::NotFound, Some("Winter")));
    assert!(store.all()[0].active, "unchanged");
}

#[test]
fn failed_index_write_moves_the_folders_back() {
    let tmp = TempDir::new("rollback");
    tmp.skin("Winter", "su_27");
    let (store, index) = imported(&tmp, &["Winter"]);
    // The index path becomes a folder, so saving fails.
    fs::remove_file(tmp.index_path()).unwrap();
    fs::create_dir_all(tmp.index_path()).unwrap();

    assert!(ops::set_active(&tmp.user_skins(), &store, &ids(&[&index[0]]), false).is_err());
    assert!(tmp.user_skins().join("Winter").is_dir(), "the rename is undone");
    assert!(!tmp.inactive().exists(), "folders it created are removed");
    assert_eq!(store.all(), index);

    assert!(ops::delete(&tmp.user_skins(), &store, &ids(&[&index[0]]), true, at(T0)).is_err());
    assert!(tmp.user_skins().join("Winter").join("body_c.dds").is_file(), "delete is undone too");
    assert!(!backups_dir(&tmp.user_skins()).exists());
    assert_eq!(store.all(), index);
}

#[cfg(windows)]
#[test]
fn delete_is_all_or_nothing() {
    use std::os::windows::fs::OpenOptionsExt;
    let tmp = TempDir::new("atomic");
    tmp.skin("Winter", "su_27");
    tmp.skin("Desert", "f_4e");
    let (store, index) = imported(&tmp, &["Winter", "Desert"]);
    // An exclusive handle inside Desert (the game holding a texture) blocks moving the folder.
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(tmp.user_skins().join("Desert").join("body_c.dds"))
        .unwrap();
    let order = ids(&[by_folder(&index, "Winter"), by_folder(&index, "Desert")]);
    let e = ops::delete(&tmp.user_skins(), &store, &order, true, at(T0)).unwrap_err();
    drop(lock);
    assert_eq!(e.code, ErrorCode::Io);
    assert!(e.detail.unwrap().starts_with("Desert: "));
    assert!(tmp.user_skins().join("Winter").is_dir(), "Winter's move is undone");
    assert_eq!(store.all(), index);
    assert!(store.snapshot().backups.is_empty());
}

// ── Delete / restore ────────────────────────────────────────────────────────

#[test]
fn delete_then_restore_round_trip_keeps_ids_places_and_collections() {
    let tmp = TempDir::new("undo");
    tmp.skin("Winter", "su_27");
    tmp.skin("Desert", "f_4e");
    tmp.skin("Jungle", "germ_leopard_2a6");
    let (store, index) = imported(&tmp, &["Winter", "Desert", "Jungle"]);
    let (winter, desert, jungle) =
        (by_folder(&index, "Winter").clone(), by_folder(&index, "Desert").clone(), by_folder(&index, "Jungle").clone());
    ops::set_active(&tmp.user_skins(), &store, &ids(&[&desert]), false).unwrap();
    let night = collections::create(&store, "Night ops", None).unwrap();
    collections::set_skins(&store, &night.id, &ids(&[&winter, &desert, &jungle]), &[]).unwrap();
    let before = store.all();

    let deleted = ops::delete(
        &tmp.user_skins(),
        &store,
        &names(&[desert.id.as_str(), "s-unknown", winter.id.as_str(), desert.id.as_str()]),
        true,
        at(T0),
    )
    .unwrap();
    assert_eq!(deleted.backup_ids.len(), 2, "one per deleted skin; unknown and repeated ids ignored");
    let library = store.snapshot();
    assert_eq!(library.skins.iter().map(|s| s.folder.as_str()).collect::<Vec<_>>(), ["Jungle"]);
    assert_eq!(library.backups[0].backup.id, deleted.backup_ids[0], "input order: Desert first");
    assert_eq!(library.backups[0].backup.skin_id, desert.id);
    assert!(!library.backups[0].was_active && library.backups[1].was_active);
    assert_eq!(library.collections[0].skin_ids, ids(&[&winter, &desert, &jungle]), "memberships kept for Undo");
    assert!(!tmp.user_skins().join("Winter").exists());
    assert!(!tmp.inactive().join("Desert").exists());
    let desert_backup = backups_dir(&tmp.user_skins()).join(&deleted.backup_ids[0]).join("Desert");
    assert!(desert_backup.join("f_4e.blk").is_file(), "kept aside under .livery/backups/<id>/<folder>");
    assert_eq!(backup::list(&store).len(), 2);

    let restored = ops::restore(&tmp.user_skins(), &store, &deleted.backup_ids).unwrap();
    assert_eq!(restored.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), [&desert.id, &winter.id]);
    assert!(!by_folder(&restored, "Desert").active, "back where it was: inactive…");
    assert!(by_folder(&restored, "Winter").active, "…and active");
    assert!(tmp.inactive().join("Desert").join("f_4e.blk").is_file());
    assert!(tmp.user_skins().join("Winter").join("su_27.blk").is_file());
    assert!(!backups_dir(&tmp.user_skins()).join(&deleted.backup_ids[0]).exists(), "empty backup folder removed");

    let mut now = store.all();
    now.sort_by(|a, b| a.id.cmp(&b.id));
    let mut expected = before.clone();
    expected.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(now, expected, "the index is as before the delete");
    assert_eq!(collections::list(&store).collections[0].skin_ids, ids(&[&winter, &desert, &jungle]));
    assert!(store.snapshot().backups.is_empty());
    assert_eq!(backup::list(&store), []);
    assert_eq!(LibraryStore::load(tmp.index_path()).snapshot(), store.snapshot(), "saved");
}

#[test]
fn restore_renames_on_clash_and_keeps_a_custom_name() {
    let tmp = TempDir::new("restore-clash");
    tmp.skin("Winter", "su_27");
    let (store, _) = imported(&tmp, &["Winter"]);
    // Give the skin a display name different from its folder (as a WT Live install would).
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(tmp.index_path()).unwrap()).unwrap();
    json["skins"][0]["name"] = "Winter Flanker".into();
    fs::write(tmp.index_path(), json.to_string()).unwrap();
    let store = {
        drop(store);
        LibraryStore::load(tmp.index_path())
    };
    let winter = store.all().remove(0);

    let deleted = ops::delete(&tmp.user_skins(), &store, &ids(&[&winter]), true, at(T0)).unwrap();
    tmp.skin("Winter", "ussr_t_34_85"); // a new skin took the name
    tmp.skin_in(&tmp.inactive(), "Winter (2)", "f_4e"); // and "(2)" is taken in the inactive place

    let restored = ops::restore(&tmp.user_skins(), &store, &deleted.backup_ids).unwrap();
    assert_eq!(restored.len(), 1);
    let back = &restored[0];
    assert_eq!(back.id, winter.id);
    assert_eq!(back.folder, "Winter (3)");
    assert_eq!(back.name, "Winter Flanker (3)");
    assert!(tmp.user_skins().join("Winter (3)").join("su_27.blk").is_file());
    assert!(tmp.user_skins().join("Winter").join("ussr_t_34_85.blk").is_file(), "the newcomer is untouched");
}

#[test]
fn restore_reports_unknown_ids_after_restoring_the_others() {
    let tmp = TempDir::new("restore-unknown");
    tmp.skin("Winter", "su_27");
    tmp.skin("Desert", "f_4e");
    let (store, index) = imported(&tmp, &["Winter", "Desert"]);
    let deleted =
        ops::delete(&tmp.user_skins(), &store, &ids(&index.iter().collect::<Vec<_>>()), true, at(T0)).unwrap();
    // Desert's backup folder vanished behind Livery's back.
    fs::remove_dir_all(backups_dir(&tmp.user_skins()).join(&deleted.backup_ids[1])).unwrap();

    let request = names(&["b-nope", deleted.backup_ids[0].as_str(), deleted.backup_ids[1].as_str()]);
    let e = ops::restore(&tmp.user_skins(), &store, &request).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(e.detail.as_deref(), Some(format!("b-nope\n{}", deleted.backup_ids[1]).as_str()));
    assert_eq!(store.all().iter().map(|s| s.folder.as_str()).collect::<Vec<_>>(), ["Winter"], "the valid one is back");
    assert!(store.snapshot().backups.is_empty(), "the dead record is dropped too");

    let again = ops::restore(&tmp.user_skins(), &store, &deleted.backup_ids[..1]).unwrap_err();
    assert_eq!(again.code, ErrorCode::NotFound, "a backup restores once");
}

#[test]
fn restore_never_leaves_user_skins_whatever_the_index_says() {
    let tmp = TempDir::new("restore-tampered");
    tmp.skin("Winter", "su_27");
    let (store, index) = imported(&tmp, &["Winter"]);
    let deleted = ops::delete(&tmp.user_skins(), &store, &ids(&[&index[0]]), true, at(T0)).unwrap();
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(tmp.index_path()).unwrap()).unwrap();
    json["backups"][0]["skin"]["folder"] = "../../Escaped".into();
    fs::write(tmp.index_path(), json.to_string()).unwrap();
    drop(store);
    let store = LibraryStore::load(tmp.index_path());

    let restored = ops::restore(&tmp.user_skins(), &store, &deleted.backup_ids).unwrap();
    assert_eq!(restored[0].folder, "Winter", "the name comes from the backup folder");
    assert!(tmp.user_skins().join("Winter").join("su_27.blk").is_file());
    assert!(!tmp.path().join("Escaped").exists());
}

#[test]
fn tampered_folder_names_never_move_user_skins_or_livery_dirs() {
    let tmp = TempDir::new("tampered-folders");
    tmp.skin("Winter", "su_27");
    tmp.skin("Desert", "f_4e");
    let (store, index) = imported(&tmp, &["Winter", "Desert"]);
    // Park Desert so `.livery` exists, then point both index entries at dangerous names.
    ops::set_active(&tmp.user_skins(), &store, &ids(&[by_folder(&index, "Desert")]), false).unwrap();
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(tmp.index_path()).unwrap()).unwrap();
    // "..." names UserSkins itself once Windows strips the trailing dots.
    json["skins"][0]["folder"] = "...".into();
    json["skins"][1]["folder"] = ".livery".into();
    fs::write(tmp.index_path(), json.to_string()).unwrap();
    drop(store);
    let store = LibraryStore::load(tmp.index_path());
    let all: Vec<String> = store.all().into_iter().map(|s| s.id).collect();

    let e = ops::set_active(&tmp.user_skins(), &store, &all, false).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = ops::set_active(&tmp.user_skins(), &store, &all, true).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    let deleted = ops::delete(&tmp.user_skins(), &store, &all, true, at(T0)).unwrap();
    assert_eq!(deleted.backup_ids, Vec::<String>::new(), "nothing was backed up");
    assert!(tmp.user_skins().join("Winter").join("su_27.blk").is_file());
    assert!(tmp.inactive().join("Desert").join("f_4e.blk").is_file());
    assert!(!backups_dir(&tmp.user_skins()).exists());
}

#[test]
fn a_failed_copy_never_removes_a_folder_it_did_not_create() {
    let tmp = TempDir::new("copy-existing");
    tmp.skin("Winter", "su_27");
    let dest = tmp.path().join("Taken");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("keep.txt"), "mine").unwrap();
    assert!(livery_lib::library::layout::copy_dir(&tmp.user_skins().join("Winter"), &dest).is_err());
    assert_eq!(fs::read_to_string(dest.join("keep.txt")).unwrap(), "mine");
}

#[test]
fn deleting_a_skin_whose_folder_is_gone_just_drops_it() {
    let tmp = TempDir::new("delete-gone");
    tmp.skin("Winter", "su_27");
    let (store, index) = imported(&tmp, &["Winter"]);
    fs::remove_dir_all(tmp.user_skins().join("Winter")).unwrap();
    let deleted = ops::delete(&tmp.user_skins(), &store, &ids(&[&index[0]]), true, at(T0)).unwrap();
    assert_eq!(deleted.backup_ids, Vec::<String>::new());
    assert_eq!(store.all(), []);
}

// ── Export ──────────────────────────────────────────────────────────────────

#[test]
fn export_copies_folders_and_renames_on_clash() {
    let tmp = TempDir::new("export");
    tmp.skin("Winter", "su_27");
    tmp.skin("Desert", "f_4e");
    let (store, index) = imported(&tmp, &["Winter", "Desert"]);
    let (winter, desert) = (by_folder(&index, "Winter").clone(), by_folder(&index, "Desert").clone());
    ops::set_active(&tmp.user_skins(), &store, &ids(&[&desert]), false).unwrap();
    let dest = tmp.path().join("export");
    fs::create_dir_all(dest.join("Winter")).unwrap();

    let result =
        ops::export(&tmp.user_skins(), &store, &names(&[winter.id.as_str(), "s-nope", desert.id.as_str()]), &dest)
            .unwrap();
    assert_eq!(result.exported, 2);
    assert!(!result.dest.is_empty());
    assert_eq!(fs::read_to_string(dest.join("Winter (2)").join("body_c.dds")).unwrap(), "texture of Winter");
    assert!(dest.join("Winter (2)").join("extras").join("readme.txt").is_file(), "recursive");
    assert!(dest.join("Desert").join("f_4e.blk").is_file(), "inactive skins export too");
    assert_eq!(fs::read_dir(dest.join("Winter")).unwrap().count(), 0, "what was there is untouched");
    assert!(tmp.user_skins().join("Winter").join("body_c.dds").is_file(), "a copy, not a move");

    for bad in [tmp.path().join("nope"), tmp.user_skins().join("Winter").join("body_c.dds"), PathBuf::new()] {
        let e = ops::export(&tmp.user_skins(), &store, &ids(&[&winter]), &bad).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput, "{bad:?}");
    }
}

#[test]
fn export_into_the_skin_folder_itself_terminates() {
    let tmp = TempDir::new("export-self");
    tmp.skin("Winter", "su_27");
    let (store, index) = imported(&tmp, &["Winter"]);
    let inside = tmp.user_skins().join("Winter");
    assert_eq!(ops::export(&tmp.user_skins(), &store, &ids(&[&index[0]]), &inside).unwrap().exported, 1);
    assert!(inside.join("Winter").join("su_27.blk").is_file());
    assert!(!inside.join("Winter").join("Winter").exists());
}

// ── Rescan ──────────────────────────────────────────────────────────────────

#[test]
fn rescan_refreshes_found_skins_and_prunes_vanished_ones() {
    let tmp = TempDir::new("prune");
    tmp.skin("Winter", "su_27");
    tmp.skin("Desert", "f_4e");
    tmp.skin("Jungle", "germ_leopard_2a6");
    let (store, index) = imported(&tmp, &["Winter", "Desert", "Jungle"]);
    let (winter, desert, jungle) =
        (by_folder(&index, "Winter").clone(), by_folder(&index, "Desert").clone(), by_folder(&index, "Jungle").clone());
    let camo = collections::create(&store, "Camo", None).unwrap();
    collections::set_skins(&store, &camo.id, &ids(&[&winter, &desert, &jungle]), &[]).unwrap();

    // Behind Livery's back: Desert is deleted, Winter moved to the inactive place, and an unknown
    // skin lands in the inactive place.
    fs::remove_dir_all(tmp.user_skins().join("Desert")).unwrap();
    fs::create_dir_all(tmp.inactive()).unwrap();
    fs::rename(tmp.user_skins().join("Winter"), tmp.inactive().join("Winter")).unwrap();
    tmp.skin_in(&tmp.inactive(), "Stray", "su_27");

    let scanned = scan_game(&tmp.user_skins(), &store).unwrap();
    assert_eq!(scanned.iter().map(|s| s.folder.as_str()).collect::<Vec<_>>(), ["Jungle", "Stray", "Winter"]);
    let stray = by_folder(&scanned, "Stray");
    assert_eq!(stray.id, format!("{INACTIVE_ID_PREFIX}Stray"));
    assert!(!stray.active);
    assert_eq!(by_folder(&scanned, "Winter").id, winter.id);
    assert!(!by_folder(&scanned, "Winter").active);

    let now = store.all();
    assert_eq!(now.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), [&winter.id, &jungle.id], "Desert pruned");
    assert!(!by_folder(&now, "Winter").active, "refreshed from disk");
    assert_eq!(collections::list(&store).collections[0].skin_ids, ids(&[&winter, &jungle]), "gone for good");
    assert_eq!(LibraryStore::load(tmp.index_path()).all(), now);

    // The stray inactive folder can be imported by name, and stays inactive.
    let imported = import_folders(&tmp.user_skins(), &store, &names(&["Stray"])).unwrap();
    let stray = by_folder(&imported, "Stray");
    assert!(stray.id.starts_with("s-") && !stray.active);
}

#[test]
fn rescan_without_user_skins_prunes_nothing() {
    let tmp = TempDir::new("unplugged");
    tmp.skin("Winter", "su_27");
    let (store, index) = imported(&tmp, &["Winter"]);
    fs::remove_dir_all(tmp.user_skins()).unwrap();
    assert_eq!(scan_game(&tmp.user_skins(), &store).unwrap(), []);
    assert_eq!(store.all(), index);
}

#[test]
fn a_folder_in_both_places_keeps_the_index_identity_where_the_flag_says() {
    let tmp = TempDir::new("both");
    tmp.skin("Winter", "su_27");
    let (store, index) = imported(&tmp, &["Winter"]);
    tmp.skin_in(&tmp.inactive(), "Winter", "f_4e");
    let scanned = scan_game(&tmp.user_skins(), &store).unwrap();
    assert_eq!(scanned.len(), 2);
    assert_eq!((scanned[0].id.as_str(), scanned[0].active), (index[0].id.as_str(), true));
    assert_eq!((scanned[1].id.clone(), scanned[1].active), (format!("{INACTIVE_ID_PREFIX}Winter"), false));
    // Deactivating it now would overwrite the other folder: clash.
    let e = ops::set_active(&tmp.user_skins(), &store, &ids(&[&index[0]]), false).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
}

// ── Index v1 → v2 ───────────────────────────────────────────────────────────

#[test]
fn version_1_index_loads_and_is_saved_as_version_2() {
    let tmp = TempDir::new("migrate");
    tmp.skin("Winter", "su_27");
    let (seed, index) = imported(&tmp, &["Winter"]);
    drop(seed);
    fs::write(tmp.index_path(), serde_json::json!({ "version": 1, "skins": index }).to_string()).unwrap();

    let store = LibraryStore::load(tmp.index_path());
    let library = store.snapshot();
    assert_eq!(library.skins, index);
    assert!(library.collections.is_empty() && library.backups.is_empty() && library.active_collection_id.is_none());
    assert!(!tmp.index_path().with_extension("json.bad").exists(), "nothing was unreadable");

    let camo = collections::create(&store, "Camo", Some("Winter set")).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&fs::read(tmp.index_path()).unwrap()).unwrap();
    assert_eq!(json["version"], INDEX_VERSION);
    assert_eq!(INDEX_VERSION, 2);
    assert_eq!(json["skins"][0]["folder"], "Winter");
    assert_eq!(json["collections"][0]["id"], camo.id.as_str());
    assert_eq!(json["collections"][0]["skinIds"], serde_json::json!([]), "camelCase on disk");
    assert_eq!(json["backups"], serde_json::json!([]));
    assert!(json.get("activeCollectionId").is_none());
    assert_eq!(LibraryStore::load(tmp.index_path()).snapshot(), store.snapshot());
}

#[test]
fn version_2_entries_that_do_not_parse_are_dropped() {
    let tmp = TempDir::new("v2-bad");
    let text = serde_json::json!({
        "version": 2,
        "skins": [],
        "collections": [
            { "id": "c-1", "name": "Good", "skinIds": ["s-1"], "createdAt": "2026-09-19T00:00:00Z" },
            { "id": "c-2" }
        ],
        "activeCollectionId": "c-2",
        "backups": [{ "backup": 3 }]
    })
    .to_string();
    fs::create_dir_all(tmp.index_path().parent().unwrap()).unwrap();
    fs::write(tmp.index_path(), &text).unwrap();
    let library = LibraryStore::load(tmp.index_path()).snapshot();
    assert_eq!(library.collections.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Good"]);
    assert_eq!(library.active_collection_id, None, "points at a dropped collection");
    assert!(library.backups.is_empty());
    assert_eq!(fs::read_to_string(tmp.index_path().with_extension("json.bad")).unwrap(), text);
}
