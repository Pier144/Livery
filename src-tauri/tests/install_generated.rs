//! Installing a skin Livery generated (Atelier) on temp game folders: a new skin is active, `mine`
//! and gets a free folder name; a replace keeps the skin's id, folder and active state and backs
//! the old version up; `undo_replace` brings it back under the same id; apply, undo and apply
//! again leaves exactly one skin; nothing is left half done when it fails.

use livery_lib::archive::generated::{install_generated, Target};
use livery_lib::archive::install::undo_replace;
use livery_lib::archive::partial_dir;
use livery_lib::backup::{self, EPHEMERAL_SECS};
use livery_lib::error::{AppError, ErrorCode};
use livery_lib::library::index::LibraryStore;
use livery_lib::library::layout::{backups_dir, inactive_dir};
use livery_lib::library::{collections, import_folders, ops};
use livery_lib::model::{BackupReason, Origin};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-generated-{name}-{}-{n}", std::process::id()));
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

fn err<T>(result: Result<T, AppError>) -> AppError {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

const TIGER: &str = "germ_pzkpfw_VI_ausf_b_tiger_IIH";
const BACKUP_DAYS: u32 = 30;

struct Env {
    _tmp: TempDir,
    user_skins: PathBuf,
    store: LibraryStore,
    staged_count: u32,
}

impl Env {
    fn new(name: &str) -> Self {
        let tmp = TempDir::new(name);
        let user_skins = tmp.path().join("game").join("UserSkins");
        fs::create_dir_all(&user_skins).unwrap();
        let store = LibraryStore::load(tmp.path().join("data").join("library.json"));
        Self { _tmp: tmp, user_skins, store, staged_count: 0 }
    }

    /// A generated skin folder in the staging area, as `apply` leaves it: `partial/<id>/<folder>`.
    fn stage(&mut self, folder: &str, marker: &str) -> PathBuf {
        self.staged_count += 1;
        let dir = partial_dir(&self.user_skins).join(format!("a-{}", self.staged_count)).join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{TIGER}.blk")), "name:t=\"user\"\n").unwrap();
        fs::write(dir.join("generated.txt"), marker).unwrap();
        dir
    }

    /// An existing skin folder in `UserSkins`, imported into the library; returns its id.
    fn old_skin(&self, folder: &str) -> String {
        let dir = self.user_skins.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{TIGER}.blk")), "replace_tex{}").unwrap();
        fs::write(dir.join("old.txt"), "the old version").unwrap();
        import_folders(&self.user_skins, &self.store, &[folder.to_owned()]).unwrap();
        self.store.all().into_iter().find(|s| s.folder == folder).map(|s| s.id).unwrap()
    }

    fn install(&self, staged: &Path, target: Target, keep_backup: bool) -> livery_lib::archive::generated::Generated {
        install_generated(&self.user_skins, &self.store, staged, target, keep_backup, BACKUP_DAYS, SystemTime::now())
            .unwrap()
    }

    fn text(&self, dir: &Path, file: &str) -> Option<String> {
        fs::read_to_string(dir.join(file)).ok()
    }
}

// ── A new skin ──────────────────────────────────────────────────────────────

#[test]
fn a_new_skin_is_active_mine_and_indexed() {
    let mut env = Env::new("new");
    let staged = env.stage("Tiger Mk1", "v1");
    let done = env.install(&staged, Target::New("Tiger Mk1".into()), true);

    assert_eq!(done.backup_id, None);
    assert!(done.skin.active);
    assert_eq!(done.skin.origin, Origin::Mine);
    assert_eq!((done.skin.folder.as_str(), done.skin.name.as_str()), ("Tiger Mk1", "Tiger Mk1"));
    assert_eq!(done.skin.vehicle.code, TIGER);
    assert!(done.skin.id.starts_with("s-"));
    assert_eq!(env.text(&env.user_skins.join("Tiger Mk1"), "generated.txt").as_deref(), Some("v1"));
    assert!(!staged.exists(), "moved out of the staging area");
    assert_eq!(env.store.all(), vec![done.skin.clone()]);
    assert!(env.store.snapshot().backups.is_empty());
}

#[test]
fn an_unsafe_name_is_made_safe_and_stays_inside_user_skins() {
    let mut env = Env::new("unsafe");
    for (asked, want) in [("a:b*c?", "a_b_c_"), ("..", TIGER), ("COM1", "COM1_"), ("x/../../y", "x_.._.._y")] {
        let staged = env.stage("whatever", "v");
        let done = env.install(&staged, Target::New(asked.into()), true);
        assert_eq!(done.skin.folder, want, "{asked:?}");
        assert!(env.user_skins.join(&done.skin.folder).is_dir());
    }
    // Nothing escaped: the game folder holds only UserSkins, the library only the data folder.
    assert_eq!(names_in(env.user_skins.parent().unwrap()), ["UserSkins"]);
}

#[test]
fn a_taken_name_gets_a_number_whatever_the_conflict_setting() {
    let mut env = Env::new("clash");
    env.old_skin("Tiger Mk1");
    // Inactive copies and indexed-but-gone entries count as taken too.
    fs::create_dir_all(inactive_dir(&env.user_skins).join("Tiger Mk1 (2)")).unwrap();

    let first = env.stage("a", "first");
    let done = env.install(&first, Target::New("Tiger Mk1".into()), true);
    assert_eq!(done.skin.folder, "Tiger Mk1 (3)");
    assert_eq!(done.skin.name, "Tiger Mk1 (3)");
    let second = env.stage("b", "second");
    let again = env.install(&second, Target::New("Tiger Mk1".into()), true);
    assert_eq!(again.skin.folder, "Tiger Mk1 (4)");
    assert_ne!(done.skin.id, again.skin.id);
    // The skin that was there is untouched.
    assert_eq!(env.text(&env.user_skins.join("Tiger Mk1"), "old.txt").as_deref(), Some("the old version"));
    assert!(env.store.snapshot().backups.is_empty(), "New never backs anything up");
}

// ── Replace ─────────────────────────────────────────────────────────────────

#[test]
fn replace_keeps_id_folder_name_and_state_and_backs_the_old_version_up() {
    let mut env = Env::new("replace");
    let old_id = env.old_skin("Winter Tiger");
    let collection = collections::create(&env.store, "Winter", None).unwrap();
    collections::set_skins(&env.store, &collection.id, std::slice::from_ref(&old_id), &[]).unwrap();
    let staged = env.stage("Tiger Mk2", "v2");

    let done = env.install(&staged, Target::Replace(old_id.clone()), true);

    assert_eq!(done.skin.id, old_id, "the same skin");
    assert_eq!(done.skin.folder, "Winter Tiger", "the folder it had, not the staged one");
    assert_eq!(done.skin.name, "Winter Tiger");
    assert!(done.skin.active);
    assert_eq!(done.skin.origin, Origin::Mine);
    let dir = env.user_skins.join("Winter Tiger");
    assert_eq!(env.text(&dir, "generated.txt").as_deref(), Some("v2"));
    assert!(env.text(&dir, "old.txt").is_none(), "the old files are gone from the folder");
    assert_eq!(env.store.all(), vec![done.skin.clone()], "one skin, not two");

    let library = env.store.snapshot();
    assert_eq!(library.backups.len(), 1);
    let record = &library.backups[0];
    assert_eq!(Some(record.backup.id.clone()), done.backup_id);
    assert_eq!((record.backup.skin_id.as_str(), record.backup.reason), (old_id.as_str(), BackupReason::Replace));
    assert!(!record.ephemeral, "kept while Settings → Backups is on");
    assert_eq!(backup::list(&env.store).len(), 1);
    let backed_up = backup::backup_path(&env.user_skins, record).unwrap();
    assert_eq!(env.text(&backed_up, "old.txt").as_deref(), Some("the old version"));
    assert_eq!(library.collections[0].skin_ids, [old_id], "still in its collection");
    assert!(names_in(&partial_dir(&env.user_skins)).iter().all(|n| !n.is_empty()));
}

#[test]
fn replacing_an_inactive_skin_leaves_it_inactive() {
    let mut env = Env::new("inactive");
    let id = env.old_skin("Summer Tiger");
    ops::set_active(&env.user_skins, &env.store, std::slice::from_ref(&id), false).unwrap();
    assert!(inactive_dir(&env.user_skins).join("Summer Tiger").is_dir());
    let staged = env.stage("Tiger Mk2", "v2");

    let done = env.install(&staged, Target::Replace(id.clone()), true);

    assert_eq!((done.skin.id.as_str(), done.skin.active), (id.as_str(), false));
    let dir = inactive_dir(&env.user_skins).join("Summer Tiger");
    assert_eq!(env.text(&dir, "generated.txt").as_deref(), Some("v2"));
    assert!(!env.user_skins.join("Summer Tiger").exists(), "not activated");
    assert!(!env.store.all()[0].active);
}

#[test]
fn replacing_a_skin_the_library_forgot_installs_a_new_one() {
    let mut env = Env::new("forgotten");
    let staged = env.stage("Tiger Mk3", "v3");
    let done = env.install(&staged, Target::Replace("s-deleted".into()), true);
    assert_eq!(done.backup_id, None);
    assert_ne!(done.skin.id, "s-deleted");
    assert_eq!(done.skin.folder, "Tiger Mk3", "named like the staged folder");
    assert!(done.skin.active);
    assert_eq!(env.store.all().len(), 1);
}

#[test]
fn replacing_a_skin_whose_folder_is_gone_drops_the_stale_entry_and_keeps_the_id() {
    let mut env = Env::new("stale");
    let id = env.old_skin("Lost Tiger");
    let other = env.old_skin("Other");
    let collection = collections::create(&env.store, "Mine", None).unwrap();
    collections::set_skins(&env.store, &collection.id, std::slice::from_ref(&id), &[]).unwrap();
    fs::remove_dir_all(env.user_skins.join("Lost Tiger")).unwrap();
    let staged = env.stage("Tiger Mk2", "v2");

    let done = env.install(&staged, Target::Replace(id.clone()), true);

    assert_eq!(done.skin.id, id, "the id lives on");
    assert_eq!((done.skin.folder.as_str(), done.skin.name.as_str()), ("Lost Tiger", "Lost Tiger"));
    assert!(done.skin.active);
    assert_eq!(done.backup_id, None, "there was nothing to back up");
    let all = env.store.all();
    assert_eq!(all.iter().filter(|s| s.id == id).count(), 1);
    assert!(all.iter().any(|s| s.id == other));
    assert_eq!(env.store.snapshot().collections[0].skin_ids, [id], "still in its collection");
    assert_eq!(env.text(&env.user_skins.join("Lost Tiger"), "generated.txt").as_deref(), Some("v2"));
}

#[test]
fn backups_off_makes_the_record_ephemeral_and_the_next_install_purges_it() {
    let mut env = Env::new("ephemeral");
    let id = env.old_skin("Winter Tiger");
    let t0 = SystemTime::now();
    let staged = env.stage("Tiger Mk2", "v2");
    let first =
        install_generated(&env.user_skins, &env.store, &staged, Target::Replace(id.clone()), false, BACKUP_DAYS, t0)
            .unwrap();
    let library = env.store.snapshot();
    assert!(library.backups[0].ephemeral);
    assert!(backup::list(&env.store).is_empty(), "not listed in Settings → Backups");
    let old_backup = first.backup_id.unwrap();

    // A minute and a bit later the next install purges what has expired before it starts.
    let later = t0 + Duration::from_secs(EPHEMERAL_SECS as u64 + 5);
    let staged = env.stage("Tiger Mk3", "v3");
    let second =
        install_generated(&env.user_skins, &env.store, &staged, Target::Replace(id.clone()), false, BACKUP_DAYS, later)
            .unwrap();
    let ids: Vec<String> = env.store.snapshot().backups.iter().map(|r| r.backup.id.clone()).collect();
    assert_eq!(ids, [second.backup_id.unwrap()], "only the new backup is left");
    assert!(!ids.contains(&old_backup));
    assert_eq!(names_in(&backups_dir(&env.user_skins)).len(), 1, "and its folder is gone from disk too");
}

// ── Undo ────────────────────────────────────────────────────────────────────

#[test]
fn undo_after_a_replace_restores_the_previous_files_under_the_same_id() {
    let mut env = Env::new("undo");
    let id = env.old_skin("Winter Tiger");
    let staged = env.stage("Tiger Mk2", "v2");
    let done = env.install(&staged, Target::Replace(id.clone()), true);

    let restored = undo_replace(&env.user_skins, &env.store, &id, &done.backup_id.unwrap()).unwrap();

    assert_eq!((restored.id.as_str(), restored.folder.as_str(), restored.active), (id.as_str(), "Winter Tiger", true));
    let dir = env.user_skins.join("Winter Tiger");
    assert_eq!(env.text(&dir, "old.txt").as_deref(), Some("the old version"));
    assert!(env.text(&dir, "generated.txt").is_none());
    assert_eq!(env.store.all().len(), 1);
    assert!(env.store.snapshot().backups.is_empty(), "the backup is used up");
}

#[test]
fn apply_undo_apply_again_leaves_exactly_one_skin_with_that_id() {
    let mut env = Env::new("again");
    let id = env.old_skin("Winter Tiger");

    let staged = env.stage("Tiger Mk2", "v2");
    let first = env.install(&staged, Target::Replace(id.clone()), true);
    undo_replace(&env.user_skins, &env.store, &id, &first.backup_id.unwrap()).unwrap();
    let staged = env.stage("Tiger Mk3", "v3");
    let second = env.install(&staged, Target::Replace(id.clone()), true);

    let all = env.store.all();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, id);
    assert_eq!(second.skin.folder, "Winter Tiger");
    assert_eq!(env.text(&env.user_skins.join("Winter Tiger"), "generated.txt").as_deref(), Some("v3"));
    assert_eq!(names_in(&env.user_skins).iter().filter(|n| !n.starts_with('.')).count(), 1, "one folder in UserSkins");
    assert_eq!(env.store.snapshot().backups.len(), 1, "the second replace's backup, the first was used up");
}

// ── Failures ────────────────────────────────────────────────────────────────

#[test]
fn a_staged_folder_that_isnt_a_skin_changes_nothing() {
    let env = Env::new("broken");
    let id = env.old_skin("Winter Tiger");
    let before = env.store.snapshot();
    for target in [Target::Replace(id.clone()), Target::New("X".into())] {
        let missing = partial_dir(&env.user_skins).join("a-9").join("nothing");
        let e =
            err(install_generated(&env.user_skins, &env.store, &missing, target, true, BACKUP_DAYS, SystemTime::now()));
        assert_eq!(e.code, ErrorCode::Io);
    }
    assert_eq!(env.store.snapshot(), before);
    assert_eq!(env.text(&env.user_skins.join("Winter Tiger"), "old.txt").as_deref(), Some("the old version"));
}

/// The move into place fails after the old version was put aside: a file inside the staged folder
/// is held open without sharing, so Windows refuses to rename the folder. The transaction must
/// give the old version back, leave the index as it was, and keep the staged folder.
#[cfg(windows)]
#[test]
fn a_failed_move_after_the_backup_puts_everything_back() {
    use std::os::windows::fs::OpenOptionsExt;
    for target_is_replace in [true, false] {
        let mut env = Env::new("rollback");
        let id = env.old_skin("Winter Tiger");
        let staged = env.stage("Tiger Mk2", "v2");
        let before = env.store.snapshot();
        let _held = fs::OpenOptions::new().read(true).share_mode(0).open(staged.join("generated.txt")).unwrap();
        let target = if target_is_replace { Target::Replace(id) } else { Target::New("Tiger Mk2".into()) };

        let e =
            err(install_generated(&env.user_skins, &env.store, &staged, target, true, BACKUP_DAYS, SystemTime::now()));

        assert_eq!(e.code, ErrorCode::Io, "{e:?}");
        assert_eq!(env.store.snapshot(), before, "index unchanged");
        assert_eq!(env.text(&env.user_skins.join("Winter Tiger"), "old.txt").as_deref(), Some("the old version"));
        assert!(env.text(&env.user_skins.join("Winter Tiger"), "generated.txt").is_none());
        assert!(staged.is_dir(), "the staged folder is still there");
        assert!(!env.user_skins.join("Tiger Mk2").exists());
        assert!(names_in(&backups_dir(&env.user_skins)).is_empty(), "no backup folder left behind");
    }
}
