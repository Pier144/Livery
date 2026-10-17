//! Livery's folder moves out of `UserSkins` (the game listed the backups and inactive skins that
//! 0.5.1 and earlier parked in `UserSkins/.livery`): where the folders are now, and the migration
//! of an old folder, alone or merged into a new one that already exists.

use livery_lib::library::layout::{backups_dir, inactive_dir, legacy_livery_dir, livery_dir, migrate_legacy_dir};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-layout-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("game").join("UserSkins")).unwrap();
        Self(dir)
    }

    fn game(&self) -> PathBuf {
        self.0.join("game")
    }

    fn user_skins(&self) -> PathBuf {
        self.game().join("UserSkins")
    }

    fn write(&self, rel: &str) {
        let path = self.game().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| entries.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

#[test]
fn livery_folder_is_next_to_user_skins_not_inside() {
    let tmp = TempDir::new("place");
    let us = tmp.user_skins();
    assert_eq!(livery_dir(&us), tmp.game().join(".livery"));
    assert_eq!(inactive_dir(&us), tmp.game().join(".livery").join("inactive"));
    assert_eq!(backups_dir(&us), tmp.game().join(".livery").join("backups"));
    assert!(!inactive_dir(&us).starts_with(&us), "the game lists every sub-folder of UserSkins");
    assert!(!backups_dir(&us).starts_with(&us));
}

#[test]
fn an_old_folder_moves_out_whole() {
    let tmp = TempDir::new("whole");
    tmp.write("UserSkins/Tiger/tiger.blk");
    tmp.write("UserSkins/.livery/backups/b-1/Old/old.blk");
    tmp.write("UserSkins/.livery/inactive/Sherman/sherman.blk");
    let us = tmp.user_skins();

    assert_eq!(migrate_legacy_dir(&us), 1);
    assert!(!legacy_livery_dir(&us).exists());
    assert!(backups_dir(&us).join("b-1").join("Old").join("old.blk").is_file());
    assert!(inactive_dir(&us).join("Sherman").join("sherman.blk").is_file());
    assert_eq!(names_in(&us), ["Tiger"], "only the real skin is left in UserSkins");

    assert_eq!(migrate_legacy_dir(&us), 0, "nothing left to move");
}

#[test]
fn an_old_folder_merges_into_an_existing_one_and_a_taken_name_stays() {
    let tmp = TempDir::new("merge");
    tmp.write(".livery/backups/b-new/New/new.blk");
    tmp.write(".livery/inactive/Panther/new.blk");
    tmp.write("UserSkins/.livery/backups/b-old/Old/old.blk");
    tmp.write("UserSkins/.livery/inactive/Panther/old.blk");
    tmp.write("UserSkins/.livery/partial/i-1/Stale/stale.blk");
    let us = tmp.user_skins();

    assert_eq!(migrate_legacy_dir(&us), 2, "b-old and i-1 move; Panther is taken");
    assert_eq!(names_in(&backups_dir(&us)), ["b-new", "b-old"]);
    assert!(livery_dir(&us).join("partial").join("i-1").join("Stale").is_dir());
    assert!(inactive_dir(&us).join("Panther").join("new.blk").is_file(), "the newer one is kept");
    assert!(
        legacy_livery_dir(&us).join("inactive").join("Panther").join("old.blk").is_file(),
        "the clashing one is left where it was, never overwritten"
    );
}

#[test]
fn nothing_to_move_without_an_old_folder() {
    let tmp = TempDir::new("none");
    tmp.write("UserSkins/Tiger/tiger.blk");
    assert_eq!(migrate_legacy_dir(&tmp.user_skins()), 0);
    assert!(!livery_dir(&tmp.user_skins()).exists(), "no folder is created for nothing");
}
