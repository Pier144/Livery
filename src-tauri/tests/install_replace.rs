//! "Replace, keep a backup" and its Undo, on temp game folders: the old version (active,
//! inactive, or a folder the library didn't know) goes to a backup and the new one takes its place
//! and state; `undo_replace` removes the new version for good and puts the old one back under its
//! folder name and id, all or nothing; the queue item waits again as a conflict.

use livery_lib::archive::install::undo_replace;
use livery_lib::archive::{analyze_path, partial_dir, prepare, run, Ctx, QueueStore};
use livery_lib::backup;
use livery_lib::error::{AppError, ErrorCode};
use livery_lib::library::index::LibraryStore;
use livery_lib::library::layout::{backups_dir, inactive_dir};
use livery_lib::library::{collections, import_folders, ops};
use livery_lib::model::{
    BackupReason, ConflictPolicy, InstallProgress, InstallStep, Origin, QueueItem, QueueStatus, Settings,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::SystemTime;

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-replace-{name}-{}-{n}", std::process::id()));
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

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("sources").join(name)
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

struct Env {
    _tmp: TempDir,
    user_skins: PathBuf,
    store: LibraryStore,
    queue: QueueStore,
    settings: Settings,
}

impl Env {
    fn new(name: &str) -> Self {
        let tmp = TempDir::new(name);
        let user_skins = tmp.path().join("game").join("UserSkins");
        fs::create_dir_all(&user_skins).unwrap();
        let store = LibraryStore::load(tmp.path().join("data").join("library.json"));
        Self { _tmp: tmp, user_skins, store, queue: QueueStore::default(), settings: Settings::default() }
    }

    fn ctx(&self) -> Ctx<'_> {
        Ctx { user_skins: &self.user_skins, library: &self.store, queue: &self.queue, settings: &self.settings }
    }

    /// The old version: a skin folder with its own marker file, in `UserSkins`.
    fn old_skin(&self, import: bool) -> Option<String> {
        let dir = self.user_skins.join("Winter Tiger");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{TIGER}.blk")), "replace_tex{}").unwrap();
        fs::write(dir.join("old.txt"), "the old version").unwrap();
        import.then(|| {
            import_folders(&self.user_skins, &self.store, &["Winter Tiger".to_owned()]).unwrap();
            self.store.all()[0].id.clone()
        })
    }

    fn queue_tiger(&self) -> QueueItem {
        analyze_path(&fixture("Winter Tiger"), Some(&self.user_skins), &self.store, &self.queue).unwrap().item
    }

    /// Installs the queued tiger with Replace; returns the `done` event.
    fn replace(&self, item: &QueueItem) -> InstallProgress {
        let job = prepare(&self.ctx(), &item.id, None, Some(ConflictPolicy::Replace)).unwrap();
        let mut events = Vec::new();
        run(&self.ctx(), job, &mut |p| events.push(p.clone()));
        let done = events.pop().unwrap();
        assert_eq!(done.step, InstallStep::Done, "{done:?}");
        done
    }

    fn is_new_version(&self, dir: &Path) -> bool {
        dir.join("tiger_body_c.dds").is_file() && !dir.join("old.txt").exists()
    }

    fn is_old_version(&self, dir: &Path) -> bool {
        fs::read_to_string(dir.join("old.txt")).is_ok_and(|t| t == "the old version")
            && !dir.join("tiger_body_c.dds").exists()
    }
}

// ── Replace ─────────────────────────────────────────────────────────────────

#[test]
fn replace_backs_up_the_old_version_and_undo_brings_it_back() {
    let env = Env::new("roundtrip");
    let old_id = env.old_skin(true).unwrap();
    let collection = collections::create(&env.store, "Winter", None).unwrap();
    collections::set_skins(&env.store, &collection.id, std::slice::from_ref(&old_id), &[]).unwrap();
    let item = env.queue_tiger();
    assert_eq!(item.status, QueueStatus::Conflict);
    assert_eq!(item.conflict_with.as_deref(), Some(old_id.as_str()));

    let done = env.replace(&item);
    let new_id = done.skin_id.clone().unwrap();
    let backup_id = done.backup_id.clone().unwrap();
    assert_ne!(new_id, old_id, "the new version is a new skin");

    // Disk: the new version in place, the old one in its backup.
    assert!(env.is_new_version(&env.user_skins.join("Winter Tiger")));
    assert!(env.is_old_version(&backups_dir(&env.user_skins).join(&backup_id).join("Winter Tiger")));
    // Index: old out (kept by the backup record), new in.
    let library = env.store.snapshot();
    assert_eq!(library.skins.len(), 1);
    let new = &library.skins[0];
    assert_eq!(
        (new.id.as_str(), new.folder.as_str(), new.name.as_str()),
        (new_id.as_str(), "Winter Tiger", "Winter Tiger")
    );
    assert_eq!(new.origin, Origin::Imported);
    assert!(new.active);
    assert_eq!(library.backups.len(), 1);
    let record = &library.backups[0];
    assert_eq!((record.backup.reason, record.backup.skin_id.as_str()), (BackupReason::Replace, old_id.as_str()));
    assert!(!record.ephemeral, "kept while Settings → Backups is on");
    assert_eq!(backup::list(&env.store).len(), 1, "listed in Settings → Backups");
    assert_eq!(
        library.collections[0].skin_ids,
        std::slice::from_ref(&old_id),
        "membership kept while the backup exists"
    );

    let restored = undo_replace(&env.user_skins, &env.store, &new_id, &backup_id).unwrap();
    assert_eq!((restored.id.as_str(), restored.folder.as_str()), (old_id.as_str(), "Winter Tiger"));
    assert!(restored.active);
    assert!(env.is_old_version(&env.user_skins.join("Winter Tiger")), "the old files are back");
    assert!(names_in(&backups_dir(&env.user_skins)).is_empty(), "the backup is used up");
    assert!(names_in(&partial_dir(&env.user_skins)).is_empty(), "the new version is gone for good");
    let library = env.store.snapshot();
    assert_eq!(library.skins.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), std::slice::from_ref(&old_id));
    assert!(library.backups.is_empty());
    assert_eq!(library.collections[0].skin_ids, std::slice::from_ref(&old_id));
    assert_eq!(LibraryStore::load(env.store.path().to_path_buf()).snapshot(), library, "saved");
    assert!(fixture("Winter Tiger").join("tiger_body_c.dds").is_file(), "the source still has it");

    // The queue item waits again, clashing with the restored skin.
    let changed = env.queue.reopen_installed(&new_id, Some(&env.user_skins), &library);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].status, QueueStatus::Conflict);
    assert_eq!(changed[0].conflict_with.as_deref(), Some(old_id.as_str()));
    assert_eq!(env.queue.get(&item.id).unwrap(), changed[0]);
}

#[test]
fn replacing_an_inactive_skin_keeps_the_new_one_inactive() {
    let env = Env::new("inactive");
    let old_id = env.old_skin(true).unwrap();
    ops::set_active(&env.user_skins, &env.store, std::slice::from_ref(&old_id), false).unwrap();
    let item = env.queue_tiger();
    assert_eq!(item.status, QueueStatus::Conflict);

    let done = env.replace(&item);
    let new_id = done.skin_id.unwrap();
    let inactive = inactive_dir(&env.user_skins).join("Winter Tiger");
    assert!(env.is_new_version(&inactive), "same place, same state");
    assert!(!env.user_skins.join("Winter Tiger").exists(), "the game still doesn't see it");
    assert!(!env.store.all().iter().find(|s| s.id == new_id).unwrap().active);

    let restored = undo_replace(&env.user_skins, &env.store, &new_id, &done.backup_id.unwrap()).unwrap();
    assert!(!restored.active);
    assert!(env.is_old_version(&inactive));
}

#[test]
fn a_folder_the_library_didnt_know_is_adopted_before_the_backup() {
    let env = Env::new("unindexed");
    env.old_skin(false);
    let item = env.queue_tiger();
    assert_eq!(item.conflict_with.as_deref(), Some("disk:Winter Tiger"));

    let done = env.replace(&item);
    let library = env.store.snapshot();
    let adopted = library.backups[0].skin.id.clone();
    assert!(adopted.starts_with("s-"), "a real id, not disk:…: {adopted}");
    assert_eq!(library.skins.len(), 1, "only the new version is indexed");

    let restored = undo_replace(&env.user_skins, &env.store, &done.skin_id.unwrap(), &done.backup_id.unwrap()).unwrap();
    assert_eq!(restored.id, adopted);
    assert!(env.is_old_version(&env.user_skins.join("Winter Tiger")));
    assert_eq!(env.store.all()[0].id, adopted, "now in My Hangar");
}

#[test]
fn with_backups_off_the_backup_only_serves_the_undo() {
    let mut env = Env::new("ephemeral");
    env.settings.backups = false;
    env.old_skin(true);
    let done = env.replace(&env.queue_tiger());
    assert!(env.store.snapshot().backups[0].ephemeral);
    assert!(backup::list(&env.store).is_empty(), "not listed");
    // Purged like any Undo-only backup a minute later.
    let later = SystemTime::now() + std::time::Duration::from_secs(120);
    assert_eq!(backup::purge(&env.user_skins, &env.store, later, 30, &[]).unwrap(), 1);
    let e = err(undo_replace(&env.user_skins, &env.store, &done.skin_id.unwrap(), &done.backup_id.unwrap()));
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(env.is_new_version(&env.user_skins.join("Winter Tiger")), "a failed undo changes nothing");
}

// ── Undo errors ─────────────────────────────────────────────────────────────

#[test]
fn undo_refuses_unknown_or_unrelated_ids() {
    let env = Env::new("undo-errors");
    env.old_skin(true);
    let done = env.replace(&env.queue_tiger());
    let (new_id, backup_id) = (done.skin_id.unwrap(), done.backup_id.unwrap());

    assert_eq!(err(undo_replace(&env.user_skins, &env.store, "s-nope", &backup_id)).code, ErrorCode::NotFound);
    assert_eq!(err(undo_replace(&env.user_skins, &env.store, &new_id, "b-nope")).code, ErrorCode::NotFound);

    // A delete backup of another skin isn't an older version of this one.
    let other = env.user_skins.join("Desert");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("su_27.blk"), "replace_tex{}").unwrap();
    import_folders(&env.user_skins, &env.store, &["Desert".to_owned()]).unwrap();
    let desert = env.store.all().into_iter().find(|s| s.folder == "Desert").unwrap().id;
    let deleted = ops::delete(&env.user_skins, &env.store, &[desert], true, SystemTime::now()).unwrap();
    let e = err(undo_replace(&env.user_skins, &env.store, &new_id, &deleted.backup_ids[0]));
    assert_eq!(e.code, ErrorCode::InvalidInput);

    // Nothing moved.
    assert!(env.is_new_version(&env.user_skins.join("Winter Tiger")));
    assert!(env.is_old_version(&backups_dir(&env.user_skins).join(&backup_id).join("Winter Tiger")));
}

#[test]
fn undo_is_all_or_nothing_when_the_old_name_is_taken() {
    let env = Env::new("undo-rollback");
    let old_id = env.old_skin(true).unwrap();
    ops::set_active(&env.user_skins, &env.store, &[old_id], false).unwrap();
    let done = env.replace(&env.queue_tiger());
    let (new_id, backup_id) = (done.skin_id.unwrap(), done.backup_id.unwrap());
    // The new version is turned on, and something else lands where the old one would go back.
    ops::set_active(&env.user_skins, &env.store, std::slice::from_ref(&new_id), true).unwrap();
    let squatter = inactive_dir(&env.user_skins).join("Winter Tiger");
    fs::create_dir_all(&squatter).unwrap();
    fs::write(squatter.join("mine.txt"), "someone else's").unwrap();
    let before = env.store.snapshot();

    let e = err(undo_replace(&env.user_skins, &env.store, &new_id, &backup_id));
    assert_eq!(e.code, ErrorCode::Conflict);
    assert!(env.is_new_version(&env.user_skins.join("Winter Tiger")), "the new version is back in place");
    assert!(env.is_old_version(&backups_dir(&env.user_skins).join(&backup_id).join("Winter Tiger")));
    assert!(squatter.join("mine.txt").is_file());
    assert_eq!(env.store.snapshot(), before, "index unchanged");
    assert!(names_in(&partial_dir(&env.user_skins)).is_empty(), "nothing left parked");
}

#[test]
fn undo_still_restores_when_the_new_version_was_removed_by_hand() {
    let env = Env::new("undo-gone");
    let old_id = env.old_skin(true).unwrap();
    let done = env.replace(&env.queue_tiger());
    fs::remove_dir_all(env.user_skins.join("Winter Tiger")).unwrap();
    let restored = undo_replace(&env.user_skins, &env.store, &done.skin_id.unwrap(), &done.backup_id.unwrap()).unwrap();
    assert_eq!(restored.id, old_id);
    assert!(env.is_old_version(&env.user_skins.join("Winter Tiger")));
}
