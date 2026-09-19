//! Installing queued skin folders on temp game folders: the happy path on disk (files, index,
//! attention, staging gone), progress events (order, throttling), Copy naming, Skip, Ask →
//! `conflict`, the Settings policy, needsLook picks, staging clean-up when a copy fails or comes
//! out incomplete, a source that vanished, a name taken while copying, stale staging from an
//! earlier session, and the queue items around an install.

use livery_lib::archive::analyze::QUEUE_PREFIX;
use livery_lib::archive::install::{ALREADY_INSTALLED, EXTRACT_END, SKIPPED, USER_SKINS_GONE, VERIFY_END};
use livery_lib::archive::{
    analyze_path, partial_dir, prepare, purge_partials, run, run_with_source, Ctx, ExtractTick, FolderSource,
    InstallJob, QueueStore, SkinSource, SourceEntry, UNSUPPORTED_ARCHIVES,
};
use livery_lib::error::{AppError, AppResult, ErrorCode};
use livery_lib::library::import_folders;
use livery_lib::library::index::LibraryStore;
use livery_lib::library::scan::PARTIAL_MARKER;
use livery_lib::model::{
    AttentionKind, ConflictPolicy, InstallProgress, InstallStep, Origin, QueueItem, QueueStatus, Settings,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-install-{name}-{}-{n}", std::process::id()));
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

/// Names in a folder (none when it's missing), sorted.
fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// Every file under `dir`, relative, `/`-separated, with its bytes.
fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let source = FolderSource::new(dir);
    let mut files: Vec<(String, Vec<u8>)> = source
        .entries()
        .unwrap()
        .into_iter()
        .filter(|e| !e.is_dir)
        .map(|e| {
            let bytes = fs::read(dir.join(&e.path)).unwrap();
            (e.path, bytes)
        })
        .collect();
    files.sort();
    files
}

/// A game folder in a temp dir with its library, queue and settings.
struct Env {
    tmp: TempDir,
    user_skins: PathBuf,
    store: LibraryStore,
    queue: QueueStore,
    settings: Settings,
}

/// What an install reported.
struct Installed {
    events: Vec<InstallProgress>,
    changed: Vec<QueueItem>,
}

impl Installed {
    fn last(&self) -> &InstallProgress {
        self.events.last().expect("at least one event")
    }
}

impl Env {
    fn new(name: &str) -> Self {
        let tmp = TempDir::new(name);
        let user_skins = tmp.path().join("game").join("UserSkins");
        fs::create_dir_all(&user_skins).unwrap();
        let store = LibraryStore::load(tmp.path().join("data").join("library.json"));
        Self { tmp, user_skins, store, queue: QueueStore::default(), settings: Settings::default() }
    }

    fn ctx(&self) -> Ctx<'_> {
        Ctx { user_skins: &self.user_skins, library: &self.store, queue: &self.queue, settings: &self.settings }
    }

    fn analyze(&self, path: &Path) -> QueueItem {
        analyze_path(path, Some(&self.user_skins), &self.store, &self.queue).unwrap().item
    }

    fn prepare(&self, id: &str, vehicle: Option<&str>, conflict: Option<ConflictPolicy>) -> AppResult<InstallJob> {
        prepare(&self.ctx(), id, vehicle, conflict)
    }

    fn run(&self, job: InstallJob) -> Installed {
        let mut events = Vec::new();
        let changed = run(&self.ctx(), job, &mut |p| events.push(p.clone()));
        Installed { events, changed }
    }

    fn install(&self, id: &str, vehicle: Option<&str>, conflict: Option<ConflictPolicy>) -> Installed {
        let job = self.prepare(id, vehicle, conflict).unwrap();
        self.run(job)
    }

    /// A skin folder already in `UserSkins`, imported into the index.
    fn installed(&self, folder: &str, code: &str) -> String {
        let dir = self.user_skins.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{code}.blk")), "replace_tex{}").unwrap();
        fs::write(dir.join("old.txt"), format!("old {folder}")).unwrap();
        import_folders(&self.user_skins, &self.store, &[folder.to_owned()]).unwrap();
        self.store.all().into_iter().find(|s| s.folder == folder).unwrap().id
    }

    fn partial(&self) -> PathBuf {
        partial_dir(&self.user_skins)
    }
}

// ── Happy path ──────────────────────────────────────────────────────────────

#[test]
fn a_skin_folder_installs_into_user_skins_and_the_index() {
    let env = Env::new("happy");
    let item = env.analyze(&fixture("Nested Download"));
    let job = env.prepare(&item.id, None, None).unwrap();
    assert_eq!(job.target_folder(), "Inner Skin");
    assert_eq!(env.queue.get(&item.id).unwrap().status, QueueStatus::Installing, "claimed at once");
    let installed = env.run(job);

    let dest = env.user_skins.join("Inner Skin");
    assert_eq!(
        tree(&dest),
        tree(&fixture("Nested Download").join("outer").join("Inner Skin")),
        "same files, same bytes"
    );
    assert!(!dest.join(PARTIAL_MARKER).exists(), "the marker is gone");
    assert!(names_in(&env.partial()).is_empty(), "staging is gone");

    let done = installed.last();
    assert_eq!(done.step, InstallStep::Done);
    assert_eq!(done.pct, 100);
    assert!(done.backup_id.is_none() && done.message.is_none());
    let skin_id = done.skin_id.clone().unwrap();
    let skins = env.store.all();
    assert_eq!(skins.len(), 1);
    let skin = &skins[0];
    assert_eq!(skin.id, skin_id);
    assert_eq!((skin.folder.as_str(), skin.name.as_str()), ("Inner Skin", "Inner Skin"));
    assert_eq!(skin.origin, Origin::Imported);
    assert!(skin.active);
    assert_eq!(skin.vehicle.code, "su_27");
    let attention: Vec<(AttentionKind, Option<&str>)> =
        skin.attention.iter().map(|a| (a.kind, a.file.as_deref())).collect();
    assert_eq!(attention, [(AttentionKind::MissingTexture, Some("su27_n.dds"))], "verified like any library skin");
    assert_eq!(LibraryStore::load(env.store.path().to_path_buf()).all(), skins, "saved");

    let after = env.queue.get(&item.id).unwrap();
    assert_eq!(after.status, QueueStatus::Done);
    assert_eq!(after.target_folder.as_deref(), Some("Inner Skin"));
    assert!(installed.changed.iter().any(|i| i.id == item.id && i.status == QueueStatus::Done));
    assert!(
        fixture("Nested Download").join("outer").join("Inner Skin").join("su_27.blk").is_file(),
        "source untouched"
    );
}

#[test]
fn progress_goes_extract_verify_done_in_order() {
    let env = Env::new("events");
    let src = env.tmp.path().join("downloads").join("Big Skin");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("su_27.blk"), "replace_tex{ to:t=\"body_c\" }").unwrap();
    fs::write(src.join("body_c.dds"), vec![1u8; 5 * 1024 * 1024]).unwrap();
    let item = env.analyze(&src);
    let installed = env.install(&item.id, None, None);
    let events = &installed.events;

    assert_eq!((events[0].step, events[0].pct), (InstallStep::Extract, 0), "starts at once");
    let rank = |s: InstallStep| match s {
        InstallStep::Download => 0,
        InstallStep::Extract => 1,
        InstallStep::Verify => 2,
        InstallStep::Done | InstallStep::Error => 3,
    };
    assert!(events.windows(2).all(|w| rank(w[0].step) <= rank(w[1].step)), "steps never go back");
    assert!(events.windows(2).all(|w| w[0].pct <= w[1].pct), "pct never goes back");
    assert!(events
        .iter()
        .all(|e| e.install_id == events[0].install_id && e.queue_id.as_deref() == Some(item.id.as_str())));
    assert!(events.iter().filter(|e| e.step == InstallStep::Extract).all(|e| e.pct <= EXTRACT_END));
    let verify: Vec<u8> = events.iter().filter(|e| e.step == InstallStep::Verify).map(|e| e.pct).collect();
    assert_eq!(verify.first(), Some(&EXTRACT_END));
    assert_eq!(verify.last(), Some(&VERIFY_END));
    assert_eq!((installed.last().step, installed.last().pct), (InstallStep::Done, 100));
    assert_eq!(events.iter().filter(|e| e.step == InstallStep::Done).count(), 1);
}

/// A folder source that takes its time on every progress tick.
struct SlowSource {
    inner: FolderSource,
    pause: Duration,
}

impl SkinSource for SlowSource {
    fn entries(&self) -> AppResult<Vec<SourceEntry>> {
        self.inner.entries()
    }

    fn read(&self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        self.inner.read(path, limit)
    }

    fn extract(
        &self,
        root: &str,
        dest: &Path,
        progress: &mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<ExtractTick> {
        self.inner.extract(root, dest, &mut |tick| {
            std::thread::sleep(self.pause);
            progress(tick)
        })
    }
}

#[test]
fn intermediate_progress_is_throttled_to_30_per_second() {
    let env = Env::new("throttle");
    let src = env.tmp.path().join("downloads").join("Many Files");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("su_27.blk"), "replace_tex{}").unwrap();
    for n in 0..40 {
        fs::write(src.join(format!("t{n:02}.dds")), vec![n as u8; 4096]).unwrap();
    }
    let item = env.analyze(&src);
    let job = env.prepare(&item.id, None, None).unwrap();
    let slow = SlowSource { inner: FolderSource::new(&src), pause: Duration::from_millis(5) };
    let mut stamped: Vec<(Instant, InstallProgress)> = Vec::new();
    run_with_source(&env.ctx(), job, &slow, &mut |p| stamped.push((Instant::now(), p.clone())));

    let extract: Vec<&(Instant, InstallProgress)> =
        stamped.iter().filter(|(_, p)| p.step == InstallStep::Extract).collect();
    assert!(extract.len() >= 3, "a slow copy shows progress: {}", extract.len());
    assert!(extract.len() < 83, "not one event per tick (82 ticks): {}", extract.len());
    for pair in extract.windows(2) {
        let gap = pair[1].0 - pair[0].0;
        assert!(gap >= Duration::from_millis(33), "ticks at most ~30 per second, got {gap:?}");
    }
    assert_eq!(stamped.last().unwrap().1.step, InstallStep::Done);
}

// ── Conflicts ───────────────────────────────────────────────────────────────

#[test]
fn copy_installs_under_the_first_free_name() {
    let env = Env::new("copy");
    env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    env.installed("Winter Tiger (2)", "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    let item = env.analyze(&fixture("Winter Tiger"));
    assert_eq!(item.status, QueueStatus::Conflict);
    let installed = env.install(&item.id, None, Some(ConflictPolicy::Copy));

    let done = installed.last();
    assert_eq!(done.step, InstallStep::Done);
    assert!(done.backup_id.is_none());
    let copy = env.user_skins.join("Winter Tiger (3)");
    assert_eq!(tree(&copy), tree(&fixture("Winter Tiger")));
    assert_eq!(fs::read_to_string(env.user_skins.join("Winter Tiger").join("old.txt")).unwrap(), "old Winter Tiger");
    let skin = env.store.all().into_iter().find(|s| Some(&s.id) == done.skin_id.as_ref()).unwrap();
    assert_eq!((skin.folder.as_str(), skin.name.as_str()), ("Winter Tiger (3)", "Winter Tiger (3)"));
    assert_eq!(env.store.all().len(), 3, "both versions stay");
    assert_eq!(env.queue.get(&item.id).unwrap().target_folder.as_deref(), Some("Winter Tiger (3)"));
}

#[test]
fn skip_installs_nothing_and_forgets_the_item() {
    let env = Env::new("skip");
    env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    let before = env.store.all();
    let item = env.analyze(&fixture("Winter Tiger"));
    let job = env.prepare(&item.id, None, Some(ConflictPolicy::Skip)).unwrap();
    assert!(job.is_skip());
    assert!(env.queue.get(&item.id).is_none(), "the item leaves the queue");
    let installed = env.run(job);

    assert_eq!(installed.events.len(), 1);
    let done = installed.last();
    assert_eq!((done.step, done.pct, done.message.as_deref()), (InstallStep::Done, 100, Some(SKIPPED)));
    assert!(done.skin_id.is_none() && done.backup_id.is_none());
    assert_eq!(env.store.all(), before, "index untouched");
    assert_eq!(names_in(&env.user_skins), ["Winter Tiger"], "no copy, no staging");
    assert_eq!(fs::read_to_string(env.user_skins.join("Winter Tiger").join("old.txt")).unwrap(), "old Winter Tiger");
}

#[test]
fn skip_without_a_clash_installs_normally() {
    let env = Env::new("skip-free");
    let item = env.analyze(&fixture("Winter Tiger"));
    let installed = env.install(&item.id, None, Some(ConflictPolicy::Skip));
    assert!(installed.last().skin_id.is_some());
    assert!(env.user_skins.join("Winter Tiger").is_dir());
}

#[test]
fn ask_refuses_with_conflict_so_the_ui_can_ask() {
    let env = Env::new("ask");
    let owner = env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    let item = env.analyze(&fixture("Winter Tiger"));
    assert_eq!(env.settings.conflict_policy, ConflictPolicy::Ask, "the default");
    let e = err(env.prepare(&item.id, None, None));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Conflict, ALREADY_INSTALLED));
    let e = err(env.prepare(&item.id, None, Some(ConflictPolicy::Ask)));
    assert_eq!(e.code, ErrorCode::Conflict);
    let after = env.queue.get(&item.id).unwrap();
    assert_eq!(after.status, QueueStatus::Conflict, "still waiting, not installing");
    assert_eq!(after.conflict_with.as_deref(), Some(owner.as_str()));
    assert!(names_in(&env.partial()).is_empty());
}

#[test]
fn the_settings_policy_applies_when_the_install_doesnt_choose() {
    let mut env = Env::new("policy");
    env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    env.settings.conflict_policy = ConflictPolicy::Copy;
    let item = env.analyze(&fixture("Winter Tiger"));
    let installed = env.install(&item.id, None, None);
    assert!(installed.last().skin_id.is_some());
    assert!(env.user_skins.join("Winter Tiger (2)").is_dir());
}

// ── Picking a vehicle ───────────────────────────────────────────────────────

#[test]
fn a_pack_needs_a_vehicle_and_installs_only_that_skin() {
    let env = Env::new("pick");
    let item = env.analyze(&fixture("Desert Pack"));
    let e = err(env.prepare(&item.id, None, None));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, "Pick a vehicle first"));
    let e = err(env.prepare(&item.id, Some("us_m1a2_sep"), None));
    assert_eq!(e.code, ErrorCode::InvalidInput);
    assert_eq!(env.queue.get(&item.id).unwrap().status, QueueStatus::NeedsLook, "a refused pick changes nothing");

    let installed = env.install(&item.id, Some("F_4E"), None);
    assert!(installed.last().skin_id.is_some());
    assert_eq!(names_in(&env.user_skins), [".livery", "Phantom Desert"]);
    let after = env.queue.get(&item.id).unwrap();
    assert_eq!(after.status, QueueStatus::Done);
    assert_eq!(after.vehicle.unwrap().code, "f_4e", "the pick is final: the item is that skin now");
    assert!(after.candidates.is_empty());
}

#[test]
fn a_pick_that_clashes_turns_the_item_into_a_conflict_and_can_be_resolved() {
    let env = Env::new("pick-clash");
    env.installed("Su-27 Desert", "su_27");
    let item = env.analyze(&fixture("Desert Pack"));
    let e = err(env.prepare(&item.id, Some("su_27"), None));
    assert_eq!(e.code, ErrorCode::Conflict);
    let after = env.queue.get(&item.id).unwrap();
    assert_eq!(after.status, QueueStatus::Conflict);
    assert_eq!(after.target_folder.as_deref(), Some("Su-27 Desert"));
    // The UI sends the same pick again with the user's choice.
    let installed = env.install(&item.id, Some("su_27"), Some(ConflictPolicy::Copy));
    assert!(installed.last().skin_id.is_some());
    assert!(env.user_skins.join("Su-27 Desert (2)").is_dir());
}

// ── Failures ────────────────────────────────────────────────────────────────

/// A folder source whose copy fails after `fail_after` files.
struct FailingSource {
    inner: FolderSource,
    fail_after: u64,
}

impl SkinSource for FailingSource {
    fn entries(&self) -> AppResult<Vec<SourceEntry>> {
        self.inner.entries()
    }

    fn read(&self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        self.inner.read(path, limit)
    }

    fn extract(
        &self,
        root: &str,
        dest: &Path,
        progress: &mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<ExtractTick> {
        self.inner.extract(root, dest, &mut |tick| {
            progress(tick)?;
            if tick.files_done >= self.fail_after {
                return Err(AppError::new(ErrorCode::Io, "Could not copy the skin files").with_detail("simulated"));
            }
            Ok(())
        })
    }
}

/// A folder source that "forgets" to copy one file but reports success.
struct LossySource(FolderSource);

impl SkinSource for LossySource {
    fn entries(&self) -> AppResult<Vec<SourceEntry>> {
        self.0.entries()
    }

    fn read(&self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        self.0.read(path, limit)
    }

    fn extract(
        &self,
        root: &str,
        dest: &Path,
        progress: &mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<ExtractTick> {
        let tick = self.0.extract(root, dest, progress)?;
        fs::remove_file(dest.join("tiger_camo.tga")).unwrap();
        Ok(tick)
    }
}

#[test]
fn a_failed_copy_leaves_no_trace_and_can_be_retried() {
    let env = Env::new("fail");
    let item = env.analyze(&fixture("Winter Tiger"));
    let job = env.prepare(&item.id, None, None).unwrap();
    let failing = FailingSource { inner: FolderSource::new(fixture("Winter Tiger")), fail_after: 2 };
    let mut events = Vec::new();
    run_with_source(&env.ctx(), job, &failing, &mut |p| events.push(p.clone()));

    let last = events.last().unwrap();
    assert_eq!((last.step, last.message.as_deref()), (InstallStep::Error, Some("Could not copy the skin files")));
    assert!(last.skin_id.is_none());
    assert!(!env.user_skins.join("Winter Tiger").exists(), "nothing reached UserSkins");
    assert!(names_in(&env.partial()).is_empty(), "the partial copy is removed");
    assert!(env.store.all().is_empty(), "index untouched");
    let after = env.queue.get(&item.id).unwrap();
    assert_eq!(after.status, QueueStatus::Error);
    assert_eq!(after.error.as_deref(), Some("Could not copy the skin files"));

    // A retry with a working source goes through.
    let installed = env.install(&item.id, None, None);
    assert!(installed.last().skin_id.is_some());
    assert_eq!(tree(&env.user_skins.join("Winter Tiger")), tree(&fixture("Winter Tiger")));
}

#[test]
fn an_incomplete_copy_fails_verification() {
    let env = Env::new("lossy");
    let item = env.analyze(&fixture("Winter Tiger"));
    let job = env.prepare(&item.id, None, None).unwrap();
    let mut events = Vec::new();
    run_with_source(&env.ctx(), job, &LossySource(FolderSource::new(fixture("Winter Tiger"))), &mut |p| {
        events.push(p.clone())
    });
    let last = events.last().unwrap();
    assert_eq!((last.step, last.message.as_deref()), (InstallStep::Error, Some("The copy is incomplete")));
    assert!(events.iter().any(|e| e.step == InstallStep::Verify), "failed while verifying");
    assert!(!env.user_skins.join("Winter Tiger").exists());
    assert!(names_in(&env.partial()).is_empty());
}

#[test]
fn a_source_that_vanished_ends_in_an_error_event() {
    let env = Env::new("vanished");
    let src = env.tmp.path().join("downloads").join("Gone Skin");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("su_27.blk"), "replace_tex{}").unwrap();
    let item = env.analyze(&src);
    let job = env.prepare(&item.id, None, None).unwrap();
    fs::remove_dir_all(&src).unwrap();
    let installed = env.run(job);
    assert_eq!(installed.events.first().unwrap().step, InstallStep::Extract);
    assert_eq!(installed.last().step, InstallStep::Error);
    assert_eq!(installed.last().message.as_deref(), Some("The file or folder can't be found"));
    assert_eq!(env.queue.get(&item.id).unwrap().status, QueueStatus::Error);
}

#[test]
fn a_name_taken_while_copying_is_a_conflict_under_ask() {
    let env = Env::new("race");
    let item = env.analyze(&fixture("Winter Tiger"));
    let job = env.prepare(&item.id, None, None).unwrap();
    // Someone installs the same folder name before the rename.
    let owner = env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    let installed = env.run(job);
    assert_eq!(installed.last().step, InstallStep::Error);
    assert_eq!(installed.last().message.as_deref(), Some("Another skin folder already has this name"));
    assert_eq!(fs::read_to_string(env.user_skins.join("Winter Tiger").join("old.txt")).unwrap(), "old Winter Tiger");
    assert!(names_in(&env.partial()).is_empty());
    let after = env.queue.get(&item.id).unwrap();
    assert_eq!(after.status, QueueStatus::Conflict, "waiting again, as a conflict");
    assert_eq!(after.conflict_with.as_deref(), Some(owner.as_str()));
    assert!(installed.changed.iter().any(|i| i.id == item.id && i.status == QueueStatus::Conflict));
}

#[test]
fn items_that_cant_install_are_refused() {
    let env = Env::new("refuse");
    let e = err(env.prepare("q-unknown", None, None));
    assert_eq!(e.code, ErrorCode::NotFound);

    let zip = env.tmp.write("skin.zip", b"PK");
    let zipped = env.analyze(&zip);
    let e = err(env.prepare(&zipped.id, None, None));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, UNSUPPORTED_ARCHIVES));

    let loose = env.analyze(&fixture("Loose Textures"));
    assert_eq!(err(env.prepare(&loose.id, None, None)).code, ErrorCode::InvalidInput);

    let item = env.analyze(&fixture("Winter Tiger"));
    let job = env.prepare(&item.id, None, None).unwrap();
    assert_eq!(err(env.prepare(&item.id, None, None)).code, ErrorCode::InvalidInput, "already installing");
    let e = err(env.queue.remove(&item.id, Some(&env.user_skins), &env.store.snapshot()));
    assert_eq!(e.code, ErrorCode::InvalidInput, "can't be removed while installing");
    // Analysing the same path again while it installs changes nothing.
    assert_eq!(env.analyze(&fixture("Winter Tiger")).status, QueueStatus::Installing);
    env.run(job);
    assert_eq!(err(env.prepare(&item.id, None, None)).code, ErrorCode::InvalidInput, "already installed");
    // A finished item gets a new row when its path is dropped again.
    let again = env.analyze(&fixture("Winter Tiger"));
    assert_ne!(again.id, item.id);
    assert_eq!(again.status, QueueStatus::Conflict);
}

#[test]
fn a_missing_user_skins_folder_is_not_found() {
    let env = Env::new("nouserskins");
    let item = env.analyze(&fixture("Winter Tiger"));
    fs::remove_dir_all(&env.user_skins).unwrap();
    let e = err(env.prepare(&item.id, None, None));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, USER_SKINS_GONE));
    assert!(!env.user_skins.exists(), "never created by an install");
}

// ── Staging left behind, neighbours in the queue ────────────────────────────

#[test]
fn stale_staging_goes_before_the_first_install() {
    let env = Env::new("stale");
    let old = env.partial().join("i-0-0").join("Half Copied");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join(PARTIAL_MARKER), "").unwrap();
    fs::write(env.partial().join("stray.tmp"), "x").unwrap();
    assert_eq!(purge_partials(&env.tmp.path().join("nowhere")), 0, "nothing to do without the folder");

    let item = env.analyze(&fixture("Winter Tiger"));
    env.install(&item.id, None, None);
    assert!(names_in(&env.partial()).is_empty(), "purged once, before staging anything");
    assert!(env.user_skins.join("Winter Tiger").is_dir());

    // Once per session and folder: later leftovers wait for the next launch.
    fs::create_dir_all(env.partial().join("i-1-1")).unwrap();
    env.queue.ensure_partials_purged(&env.user_skins);
    assert_eq!(names_in(&env.partial()), ["i-1-1"]);
    assert_eq!(purge_partials(&env.user_skins), 1);
}

#[test]
fn installing_one_item_turns_its_queued_twin_into_a_conflict_with_the_new_skin() {
    let env = Env::new("twins");
    let other = env.tmp.path().join("downloads").join("Winter Tiger");
    fs::create_dir_all(&other).unwrap();
    fs::copy(
        fixture("Winter Tiger").join("germ_pzkpfw_VI_ausf_b_tiger_IIH.blk"),
        other.join("germ_pzkpfw_VI_ausf_b_tiger_IIH.blk"),
    )
    .unwrap();
    let first = env.analyze(&fixture("Winter Tiger"));
    let second = env.analyze(&other);
    assert_eq!(second.conflict_with, Some(format!("{QUEUE_PREFIX}{}", first.id)));

    let installed = env.install(&first.id, None, None);
    let skin_id = installed.last().skin_id.clone().unwrap();
    let twin = installed.changed.iter().find(|i| i.id == second.id).expect("the twin is re-sent");
    assert_eq!(twin.status, QueueStatus::Conflict);
    assert_eq!(twin.conflict_with.as_deref(), Some(skin_id.as_str()));
    assert_eq!(twin.note.as_deref(), Some("Same folder name as “Winter Tiger” (installed)"));
}
