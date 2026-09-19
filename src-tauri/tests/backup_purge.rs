//! Backups on temp folders, with an injected clock: ephemeral backups (backups off) purged after
//! a minute, kept ones after `backupDays`, the Undo exemption, list order, and Clear.

use livery_lib::backup::{self, EPHEMERAL_SECS};
use livery_lib::error::ErrorCode;
use livery_lib::library::index::LibraryStore;
use livery_lib::library::layout::backups_dir;
use livery_lib::library::{collections, import_folders, ops};
use livery_lib::model::{BackupReason, HangarSkin};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-backup-{name}-{}-{n}", std::process::id()));
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

    fn backups(&self) -> PathBuf {
        backups_dir(&self.user_skins())
    }

    fn skin(&self, folder: &str, code: &str) {
        let dir = self.user_skins().join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{code}.blk")), "").unwrap();
        fs::write(dir.join("body_c.dds"), folder).unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const T0: u64 = 1_789_832_245; // 2026-09-19T15:37:25Z
const DAY: u64 = 86_400;

fn at(secs: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(secs)
}

fn setup(tmp: &TempDir, folders: &[&str]) -> (LibraryStore, Vec<HangarSkin>) {
    for (i, folder) in folders.iter().enumerate() {
        tmp.skin(folder, if i % 2 == 0 { "su_27" } else { "f_4e" });
    }
    let store = LibraryStore::load(tmp.index_path());
    let list: Vec<String> = folders.iter().map(|s| (*s).to_owned()).collect();
    let index = import_folders(&tmp.user_skins(), &store, &list).unwrap();
    (store, index)
}

fn delete_one(tmp: &TempDir, store: &LibraryStore, skin: &HangarSkin, keep: bool, when: u64) -> String {
    ops::delete(&tmp.user_skins(), store, std::slice::from_ref(&skin.id), keep, at(when)).unwrap().backup_ids.remove(0)
}

fn backup_count(store: &LibraryStore) -> usize {
    store.snapshot().backups.len()
}

#[test]
fn ephemeral_backups_last_a_minute_and_are_never_listed() {
    let tmp = TempDir::new("ephemeral");
    let (store, index) = setup(&tmp, &["Winter"]);
    let id = delete_one(&tmp, &store, &index[0], false, T0);
    assert!(store.snapshot().backups[0].ephemeral);
    assert_eq!(backup::list(&store), [], "Undo-only backups are not in Settings → Backups");
    assert!(tmp.backups().join(&id).join("Winter").is_dir(), "but the folder is there for Undo");

    let limit = T0 + EPHEMERAL_SECS as u64;
    assert_eq!(backup::purge(&tmp.user_skins(), &store, at(limit), 30, &[]).unwrap(), 0, "60 s is not older than 60 s");
    assert_eq!(
        backup::purge(&tmp.user_skins(), &store, at(limit + 1), 30, std::slice::from_ref(&id)).unwrap(),
        0,
        "an Undo in progress is spared"
    );
    assert_eq!(backup::purge(&tmp.user_skins(), &store, at(limit + 1), 30, &[]).unwrap(), 1);
    assert!(!tmp.backups().join(&id).exists(), "the folder is gone for good");
    assert_eq!(backup_count(&store), 0);
    assert_eq!(LibraryStore::load(tmp.index_path()).snapshot().backups, [], "saved");

    let e = ops::restore(&tmp.user_skins(), &store, &[id]).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[test]
fn undo_within_the_minute_works_with_backups_off() {
    let tmp = TempDir::new("ephemeral-undo");
    let (store, index) = setup(&tmp, &["Winter"]);
    let id = delete_one(&tmp, &store, &index[0], false, T0);
    backup::purge(&tmp.user_skins(), &store, at(T0 + 6), 30, &[]).unwrap();
    let restored = ops::restore(&tmp.user_skins(), &store, &[id]).unwrap();
    assert_eq!(restored, index);
    assert!(tmp.user_skins().join("Winter").join("body_c.dds").is_file());
}

#[test]
fn kept_backups_expire_after_backup_days() {
    let tmp = TempDir::new("expiry");
    let (store, index) = setup(&tmp, &["Winter", "Desert"]);
    let old = delete_one(&tmp, &store, &index[0], true, T0);
    let newer = delete_one(&tmp, &store, &index[1], true, T0 + 5 * DAY);
    assert!(!store.snapshot().backups[0].ephemeral);

    assert_eq!(backup::purge(&tmp.user_skins(), &store, at(T0 + 30 * DAY), 30, &[]).unwrap(), 0);
    assert_eq!(backup::purge(&tmp.user_skins(), &store, at(T0 + 30 * DAY + 1), 30, &[]).unwrap(), 1);
    assert!(!tmp.backups().join(&old).exists());
    assert!(tmp.backups().join(&newer).join("Desert").is_dir());
    assert_eq!(backup::list(&store).iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), [newer.as_str()]);

    // A shorter setting applies to what is already there.
    assert_eq!(backup::purge(&tmp.user_skins(), &store, at(T0 + 30 * DAY + 1), 7, &[]).unwrap(), 1);
    assert_eq!(backup_count(&store), 0);
}

#[test]
fn purged_skins_leave_their_collections() {
    let tmp = TempDir::new("members");
    let (store, index) = setup(&tmp, &["Winter", "Desert"]);
    let set = collections::create(&store, "Set", None).unwrap();
    let both: Vec<String> = index.iter().map(|s| s.id.clone()).collect();
    collections::set_skins(&store, &set.id, &both, &[]).unwrap();
    delete_one(&tmp, &store, &index[0], false, T0);
    assert_eq!(collections::list(&store).collections[0].skin_ids, both, "kept while Undo is possible");
    backup::purge(&tmp.user_skins(), &store, at(T0 + 61), 30, &[]).unwrap();
    assert_eq!(collections::list(&store).collections[0].skin_ids, [index[1].id.clone()]);
}

#[test]
fn nothing_expired_means_no_write() {
    let tmp = TempDir::new("quiet");
    let (store, index) = setup(&tmp, &["Winter"]);
    delete_one(&tmp, &store, &index[0], true, T0);
    fs::remove_file(tmp.index_path()).unwrap();
    assert_eq!(backup::purge(&tmp.user_skins(), &store, at(T0 + 10), 30, &[]).unwrap(), 0);
    assert!(!tmp.index_path().exists());
}

#[test]
fn list_is_newest_first_with_what_settings_shows() {
    let tmp = TempDir::new("list");
    let (store, index) = setup(&tmp, &["Winter", "Desert", "Jungle"]);
    let first = delete_one(&tmp, &store, &index[0], true, T0 + 10);
    let second = delete_one(&tmp, &store, &index[1], true, T0 + 20);
    let same_time = delete_one(&tmp, &store, &index[2], true, T0 + 20);
    let listed = backup::list(&store);
    assert_eq!(
        listed.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(),
        [same_time.as_str(), second.as_str(), first.as_str()],
        "newest first; the later of two in the same second first"
    );
    let winter = &listed[2];
    assert_eq!(winter.skin_id, index[0].id);
    assert_eq!(winter.name, "Winter");
    assert_eq!(winter.size_bytes, index[0].size_bytes);
    assert_eq!(winter.created_at, "2026-09-19T15:37:35Z");
    assert_eq!(winter.reason, BackupReason::Delete);
    let json = serde_json::to_value(winter).unwrap();
    assert_eq!(json["reason"], "delete");
    assert!(json.get("skinId").is_some() && json.get("createdAt").is_some(), "camelCase for the UI");
}

#[test]
fn clear_removes_every_backup_leftovers_and_dangling_members() {
    let tmp = TempDir::new("clear");
    let (store, index) = setup(&tmp, &["Winter", "Desert", "Jungle"]);
    let set = collections::create(&store, "Set", None).unwrap();
    let all: Vec<String> = index.iter().map(|s| s.id.clone()).collect();
    collections::set_skins(&store, &set.id, &all, &[]).unwrap();
    delete_one(&tmp, &store, &index[0], true, T0);
    delete_one(&tmp, &store, &index[1], false, T0);
    fs::create_dir_all(tmp.backups().join("b-orphan").join("Old")).unwrap();
    fs::write(tmp.backups().join("stray.txt"), "x").unwrap();

    backup::clear(&tmp.user_skins(), &store, None).unwrap();
    assert_eq!(backup_count(&store), 0);
    assert_eq!(fs::read_dir(tmp.backups()).unwrap().count(), 0, "nothing left on disk");
    assert_eq!(collections::list(&store).collections[0].skin_ids, [index[2].id.clone()]);
    assert!(tmp.user_skins().join("Jungle").is_dir(), "installed skins are untouched");
    assert_eq!(LibraryStore::load(tmp.index_path()).snapshot(), store.snapshot());

    // Clearing with no backups folder at all is fine.
    fs::remove_dir_all(tmp.backups()).unwrap();
    backup::clear(&tmp.user_skins(), &store, None).unwrap();
}

#[test]
fn records_with_unreadable_dates_or_dirs_are_handled() {
    let tmp = TempDir::new("tampered");
    let (store, index) = setup(&tmp, &["Winter", "Desert"]);
    delete_one(&tmp, &store, &index[0], false, T0);
    delete_one(&tmp, &store, &index[1], false, T0);
    // Tamper with the file: an unreadable date and a dir that escapes the backups folder.
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(tmp.index_path()).unwrap()).unwrap();
    json["backups"][0]["backup"]["createdAt"] = "yesterday".into();
    json["backups"][1]["dir"] = "../../Desert".into();
    fs::write(tmp.index_path(), json.to_string()).unwrap();
    let store = LibraryStore::load(tmp.index_path());

    assert_eq!(backup::purge(&tmp.user_skins(), &store, at(T0 + 3600), 30, &[]).unwrap(), 1);
    let left = store.snapshot().backups;
    assert_eq!(left.len(), 1, "the record without a date never expires by itself");
    assert_eq!(left[0].backup.created_at, "yesterday");
    assert!(tmp.user_skins().parent().unwrap().is_dir(), "nothing outside the backups folder was removed");
    // Desert's real backup folder stays (the tampered record pointed elsewhere); Clear removes
    // it as a leftover.
    assert_eq!(fs::read_dir(tmp.backups()).unwrap().count(), 2);
    backup::clear(&tmp.user_skins(), &store, None).unwrap();
    assert_eq!(fs::read_dir(tmp.backups()).unwrap().count(), 0);
}

#[test]
fn clear_with_ids_removes_only_those_backups() {
    let tmp = TempDir::new("clear-ids");
    let (store, index) = setup(&tmp, &["Winter", "Desert", "Jungle"]);
    let set = collections::create(&store, "Set", None).unwrap();
    let all: Vec<String> = index.iter().map(|s| s.id.clone()).collect();
    collections::set_skins(&store, &set.id, &all, &[]).unwrap();
    let winter = delete_one(&tmp, &store, &index[0], true, T0);
    let desert = delete_one(&tmp, &store, &index[1], true, T0 + 1);
    let jungle = delete_one(&tmp, &store, &index[2], false, T0 + 2);
    fs::create_dir_all(tmp.backups().join("b-orphan").join("Old")).unwrap();

    // The list the user saw held Winter; Desert was made afterwards, "b-nope" doesn't exist.
    backup::clear(&tmp.user_skins(), &store, Some(&[winter.clone(), "b-nope".into()][..])).unwrap();
    let left: Vec<String> = store.snapshot().backups.iter().map(|r| r.backup.id.clone()).collect();
    assert_eq!(left, [desert.clone(), jungle.clone()], "only the named backup is gone");
    assert!(!tmp.backups().join(&winter).exists());
    assert!(tmp.backups().join(&desert).join("Desert").is_dir());
    assert!(tmp.backups().join(&jungle).join("Jungle").is_dir());
    assert!(tmp.backups().join("b-orphan").is_dir(), "leftovers are only swept by a full Clear");
    assert_eq!(collections::list(&store).collections[0].skin_ids, [index[1].id.clone(), index[2].id.clone()]);
    assert_eq!(LibraryStore::load(tmp.index_path()).snapshot(), store.snapshot(), "saved");

    // An ephemeral (Undo-only) backup can be named too; unknown ids alone change nothing.
    backup::clear(&tmp.user_skins(), &store, Some(&[jungle][..])).unwrap();
    assert_eq!(backup_count(&store), 1);
    backup::clear(&tmp.user_skins(), &store, Some(&["b-nope".into()][..])).unwrap();
    backup::clear(&tmp.user_skins(), &store, Some(&[][..])).unwrap();
    assert_eq!(backup_count(&store), 1);
    assert!(tmp.backups().join(&desert).is_dir());

    // No ids: every backup and every leftover.
    backup::clear(&tmp.user_skins(), &store, None).unwrap();
    assert_eq!(backup_count(&store), 0);
    assert_eq!(fs::read_dir(tmp.backups()).unwrap().count(), 0);
}
