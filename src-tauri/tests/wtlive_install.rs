//! Installing from WT Live with a fake client that serves a real ZIP: the folder and index
//! entry, progress, conflicts, Try in game with Keep and Discard, leftovers at launch, and the
//! textures of a post before installing.

use livery_lib::archive::analyze::NO_BLK_ERROR;
use livery_lib::archive::install::{ALREADY_INSTALLED, SKIPPED, USER_SKINS_GONE};
use livery_lib::error::{AppError, AppResult, ErrorCode};
use livery_lib::library::index::LibraryStore;
use livery_lib::model::{
    Author, Category, ConflictPolicy, FollowEntry, HangarSkin, InstallMode, InstallProgress, InstallStep, Origin,
    SearchParams, SearchResult, Settings, WtLiveSkin,
};
use livery_lib::wtlive::install::{self, Ctx, Installing, ALREADY_INSTALLING, DOWNLOAD_END, NOT_TRIED};
use livery_lib::wtlive::{DownloadProgress, WtLiveClient};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const TIGER: &str = "germ_pzkpfw_VI_ausf_b_tiger_IIH";

/// Serves posts by id and a ZIP of `tests/fixtures/sources/Winter Tiger` (or no skin at all).
struct FakeClient {
    dir: PathBuf,
    author: Mutex<String>,
    empty_archive: bool,
    /// Serves `tests/fixtures/sources/Desert Pack` (three skins) instead.
    pack: bool,
}

impl FakeClient {
    fn post_skin(&self, id: &str) -> WtLiveSkin {
        let author = self.author.lock().unwrap().clone();
        WtLiveSkin {
            id: id.into(),
            name: format!("Winter Tiger {id}"),
            vehicle: livery_lib::library::vehicles::resolve(TIGER),
            author: Author { id: "77".into(), name: author, url: String::new(), skin_count: None },
            category: Category::Historical,
            downloads: 1,
            likes: 1,
            posted_at: "2026-10-01T00:00:00Z".into(),
            size_bytes: 1,
            images: vec![],
            post_url: String::new(),
            download_url: String::new(),
            files: None,
            is_new: None,
            description: None,
        }
    }
}

impl WtLiveClient for FakeClient {
    fn ready(&self) -> AppResult<()> {
        Ok(())
    }
    fn search(&self, _: &SearchParams) -> AppResult<SearchResult> {
        unreachable!()
    }
    fn post(&self, id: &str) -> AppResult<WtLiveSkin> {
        Ok(self.post_skin(id))
    }
    fn following_new(&self, _: &[FollowEntry]) -> AppResult<Vec<WtLiveSkin>> {
        unreachable!()
    }
    fn archive(&self, id: &str, progress: &mut dyn FnMut(DownloadProgress)) -> AppResult<PathBuf> {
        let path = self.dir.join(format!("{id}.zip"));
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        if self.empty_archive {
            zip.start_file("readme.txt", options).unwrap();
            zip.write_all(b"no skin here").unwrap();
        } else if self.pack {
            let pack = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sources/Desert Pack");
            let mut skins: Vec<_> = fs::read_dir(&pack).unwrap().map(|e| e.unwrap().path()).collect();
            skins.sort();
            for skin in skins.iter().filter(|p| p.is_dir()) {
                let mut files: Vec<_> = fs::read_dir(skin).unwrap().map(|e| e.unwrap().path()).collect();
                files.sort();
                for file in files.iter().filter(|p| p.is_file()) {
                    let rel = format!(
                        "pack/{}/{}",
                        skin.file_name().unwrap().to_string_lossy(),
                        file.file_name().unwrap().to_string_lossy()
                    );
                    zip.start_file(rel, options).unwrap();
                    zip.write_all(&fs::read(file).unwrap()).unwrap();
                }
            }
        } else {
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sources/Winter Tiger");
            for rel in
                [format!("{TIGER}.blk"), "tiger_body_c.dds".into(), "tiger_camo.tga".into(), "extras/readme.txt".into()]
            {
                zip.start_file(format!("Winter Tiger/{rel}"), options).unwrap();
                zip.write_all(&fs::read(source.join(&rel)).unwrap()).unwrap();
            }
        }
        zip.finish().unwrap();
        let size = fs::metadata(&path).unwrap().len();
        progress(DownloadProgress { received: size / 2, total: Some(size) });
        progress(DownloadProgress { received: size, total: Some(size) });
        Ok(path)
    }
}

struct Env {
    root: PathBuf,
    user_skins: PathBuf,
    store: LibraryStore,
    settings: Settings,
    client: FakeClient,
    installing: Installing,
}

impl Env {
    fn new(name: &str) -> Self {
        Self::with(name, false)
    }

    fn pack(name: &str) -> Self {
        let mut env = Self::with(name, false);
        env.client.pack = true;
        env
    }

    fn with(name: &str, empty_archive: bool) -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("livery-wtlive-install-{name}-{}-{nanos}", std::process::id()));
        let user_skins = root.join("UserSkins");
        let downloads = root.join("downloads");
        fs::create_dir_all(&user_skins).unwrap();
        fs::create_dir_all(&downloads).unwrap();
        let store = LibraryStore::load(root.join("library.json"));
        let client = FakeClient { dir: downloads, author: Mutex::new("Ostwind".into()), empty_archive, pack: false };
        Self { root, user_skins, store, settings: Settings::default(), client, installing: Installing::default() }
    }

    fn ctx(&self) -> Ctx<'_> {
        Ctx { user_skins: &self.user_skins, library: &self.store, settings: &self.settings, client: &self.client }
    }

    fn prepare(&self, id: &str, mode: InstallMode, conflict: Option<ConflictPolicy>) -> AppResult<install::Job> {
        install::prepare(&self.ctx(), &self.installing, id, mode, conflict)
    }

    /// Prepares and runs; returns the result and the events.
    fn install(
        &self,
        id: &str,
        mode: InstallMode,
        conflict: Option<ConflictPolicy>,
    ) -> (AppResult<Option<HangarSkin>>, Vec<InstallProgress>) {
        let job = match self.prepare(id, mode, conflict) {
            Ok(job) => job,
            Err(e) => return (Err(e), Vec::new()),
        };
        let mut events = Vec::new();
        let result = install::run(&self.ctx(), &job, &mut |p| events.push(p.clone()));
        self.installing.release(id);
        (result, events)
    }

    fn installed(&self, id: &str, mode: InstallMode) -> HangarSkin {
        self.install(id, mode, None).0.unwrap().unwrap()
    }

    fn skins(&self) -> Vec<HangarSkin> {
        self.store.all()
    }

    fn folders(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.user_skins)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != ".livery")
            .collect();
        names.sort();
        names
    }

    fn staging_is_empty(&self) -> bool {
        let partial = self.user_skins.join(".livery").join("partial");
        fs::read_dir(&partial).map_or(true, |mut d| d.next().is_none())
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn folder() -> String {
    format!("{TIGER}_Ostwind")
}

fn mark(dir: &Path, text: &str) {
    fs::write(dir.join("mark.txt"), text).unwrap();
}

fn read_mark(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join("mark.txt")).ok()
}

#[test]
fn a_post_installs_as_vehicle_and_author_with_its_origin() {
    let env = Env::new("normal");
    let (result, events) = env.install("101", InstallMode::Normal, None);
    let skin = result.unwrap().unwrap();
    assert_eq!(skin.folder, folder());
    assert_eq!(skin.name, "Winter Tiger 101");
    assert_eq!(skin.origin, Origin::Wtlive);
    assert_eq!(skin.source_id.as_deref(), Some("101"));
    assert_eq!(skin.author.as_ref().map(|a| a.name.as_str()), Some("Ostwind"));
    assert_eq!(skin.vehicle.code, TIGER);
    assert!(skin.active && !skin.temporary);
    assert!(env.user_skins.join(folder()).join(format!("{TIGER}.blk")).is_file());
    assert!(env.user_skins.join(folder()).join("extras/readme.txt").is_file());
    assert_eq!(env.skins(), vec![skin.clone()]);
    assert!(env.staging_is_empty());

    // download → extract → verify → done, pct never going back, no queue id.
    let steps: Vec<InstallStep> = events.iter().map(|e| e.step).collect();
    assert_eq!(steps.first(), Some(&InstallStep::Download));
    assert_eq!(steps.last(), Some(&InstallStep::Done));
    assert!(steps.contains(&InstallStep::Extract) && steps.contains(&InstallStep::Verify));
    assert!(events.windows(2).all(|w| w[0].pct <= w[1].pct));
    assert!(events.iter().filter(|e| e.step == InstallStep::Download).all(|e| e.pct <= DOWNLOAD_END));
    assert!(events.iter().filter(|e| e.step == InstallStep::Extract).all(|e| e.pct >= DOWNLOAD_END));
    assert!(events.iter().all(|e| e.queue_id.is_none() && e.install_id == events[0].install_id));
    let done = events.last().unwrap();
    assert_eq!((done.pct, done.skin_id.as_deref()), (100, Some(skin.id.as_str())));
}

#[test]
fn another_post_with_the_same_folder_name_installs_beside_it() {
    let env = Env::new("beside");
    env.installed("101", InstallMode::Normal);
    let second = env.installed("102", InstallMode::Normal);
    assert_eq!(second.folder, format!("{} (2)", folder()));
    assert_eq!(env.folders(), [folder(), format!("{} (2)", folder())]);
}

#[test]
fn an_installed_post_follows_the_conflict_policy() {
    let env = Env::new("conflicts");
    let first = env.installed("101", InstallMode::Normal);
    // Settings say Ask: the UI gets `conflict` and asks.
    let e = env.prepare("101", InstallMode::Normal, None).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Conflict, ALREADY_INSTALLED));
    assert_eq!(e.detail.as_deref(), Some(folder().as_str()));
    assert!(!env.installing.contains("101"), "a refused install claims nothing");

    // Skip: nothing changes, done says skipped.
    let (result, events) = env.install("101", InstallMode::Normal, Some(ConflictPolicy::Skip));
    assert_eq!(result.unwrap(), None);
    assert_eq!(events.len(), 1);
    assert_eq!((events[0].step, events[0].message.as_deref()), (InstallStep::Done, Some(SKIPPED)));
    assert_eq!(env.skins(), vec![first.clone()]);

    // Copy: another copy, named "(2)".
    let copy = env.install("101", InstallMode::Normal, Some(ConflictPolicy::Copy)).0.unwrap().unwrap();
    assert_eq!(copy.name, "Winter Tiger 101 (2)");
    assert_eq!(copy.folder, format!("{} (2)", folder()));

    // Replace: the installed version is backed up and the new one takes its folder.
    mark(&env.user_skins.join(folder()), "old");
    let (result, events) = env.install("101", InstallMode::Normal, Some(ConflictPolicy::Replace));
    let replaced = result.unwrap().unwrap();
    assert_eq!(replaced.folder, folder());
    assert_ne!(replaced.id, first.id);
    assert!(events.last().unwrap().backup_id.is_some(), "Undo has a backup");
    assert_eq!(read_mark(&env.user_skins.join(folder())), None, "the new version is in place");
    assert!(env.skins().iter().all(|s| s.id != first.id));
}

#[test]
fn the_same_post_cant_install_twice_at_once() {
    let env = Env::new("twice");
    let job = env.prepare("101", InstallMode::Normal, None).unwrap();
    let e = env.prepare("101", InstallMode::Normal, None).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, ALREADY_INSTALLING));
    assert!(env.prepare("102", InstallMode::Normal, None).is_ok(), "another post can");
    install::run(&env.ctx(), &job, &mut |_| {}).unwrap();
    env.installing.release("101");
    assert!(!env.installing.contains("101"));
}

#[test]
fn a_pack_installs_every_skin_with_its_own_vehicle() {
    let env = Env::pack("pack");
    let main = env.installed("101", InstallMode::Normal);
    // The post's vehicle (a Tiger) isn't in the pack: the first skin is the main one.
    assert_eq!(main.vehicle.code, "bf-109g-6");
    assert_eq!(main.name, "Winter Tiger 101");
    assert_eq!(env.folders(), ["bf-109g-6_Ostwind", "f_4e_Ostwind", "su_27_Ostwind"]);
    let skins = env.skins();
    assert_eq!(skins.len(), 3);
    assert!(skins.iter().all(|s| s.source_id.as_deref() == Some("101") && s.origin == Origin::Wtlive && s.active));
    let codes: Vec<&str> = skins.iter().map(|s| s.vehicle.code.as_str()).collect();
    assert_eq!(codes, ["bf-109g-6", "f_4e", "su_27"]);
    assert!(skins[1].name.starts_with("Winter Tiger 101 · "), "{}", skins[1].name);
    assert!(env.staging_is_empty());

    // Installed again with Copy: the post counts as installed, so only the main skin is copied.
    env.install("101", InstallMode::Normal, Some(ConflictPolicy::Copy)).0.unwrap();
    assert_eq!(env.skins().len(), 4);
}

#[test]
fn trying_a_pack_in_game_installs_only_its_main_skin() {
    let env = Env::pack("pack-try");
    let tried = env.installed("101", InstallMode::Temporary);
    assert!(tried.temporary);
    assert_eq!(env.skins().len(), 1);
    assert_eq!(env.folders(), ["bf-109g-6_Ostwind"]);
}

#[test]
fn an_archive_without_a_skin_fails_and_leaves_nothing() {
    let env = Env::with("empty", true);
    let (result, events) = env.install("101", InstallMode::Normal, None);
    let e = result.unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, NO_BLK_ERROR));
    let last = events.last().unwrap();
    assert_eq!((last.step, last.message.as_deref()), (InstallStep::Error, Some(NO_BLK_ERROR)));
    assert!(env.folders().is_empty() && env.skins().is_empty() && env.staging_is_empty());
}

#[test]
fn a_missing_user_skins_folder_is_not_found() {
    let env = Env::new("gone");
    fs::remove_dir_all(&env.user_skins).unwrap();
    let e = env.prepare("101", InstallMode::Normal, None).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, USER_SKINS_GONE));
}

// ── Try in game ─────────────────────────────────────────────────────────────

#[test]
fn a_try_is_temporary_until_kept() {
    let env = Env::new("keep");
    let tried = env.installed("101", InstallMode::Temporary);
    assert!(tried.temporary);
    assert!(env.user_skins.join(folder()).is_dir(), "in the game while tried");
    let kept = install::finalize(&env.user_skins, &env.store, "101", true, true).unwrap().unwrap();
    assert_eq!(kept.id, tried.id);
    assert!(!kept.temporary);
    assert_eq!(env.skins(), vec![kept]);
    let e = install::finalize(&env.user_skins, &env.store, "101", true, true).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, NOT_TRIED));
}

#[test]
fn discarding_a_try_removes_it() {
    let env = Env::new("discard");
    env.installed("101", InstallMode::Temporary);
    assert_eq!(install::finalize(&env.user_skins, &env.store, "101", false, true).unwrap(), None);
    assert!(env.folders().is_empty());
    assert!(env.skins().is_empty());
}

#[test]
fn discarding_a_try_that_replaced_a_version_puts_it_back() {
    let mut env = Env::new("restore");
    env.settings.backups = false; // a try keeps its backup anyway
    let original = env.installed("101", InstallMode::Normal);
    mark(&env.user_skins.join(folder()), "original");
    let tried = env.install("101", InstallMode::Temporary, Some(ConflictPolicy::Replace)).0.unwrap().unwrap();
    assert!(tried.temporary);
    assert_eq!(read_mark(&env.user_skins.join(folder())), None, "the try is in the game");
    assert_eq!(env.store.snapshot().tried_backups.len(), 1);

    install::finalize(&env.user_skins, &env.store, "101", false, true).unwrap();
    let skins = env.skins();
    assert_eq!(skins.len(), 1);
    assert_eq!(skins[0].id, original.id, "the original version is back, id and all");
    assert!(!skins[0].temporary);
    assert_eq!(read_mark(&env.user_skins.join(folder())).as_deref(), Some("original"));
    assert!(env.store.snapshot().tried_backups.is_empty());
}

#[test]
fn installing_a_post_being_tried_takes_over_the_try() {
    let env = Env::new("takeover");
    let tried = env.installed("101", InstallMode::Temporary);
    let installed = env.installed("101", InstallMode::Normal);
    assert_eq!((installed.id.as_str(), installed.folder.as_str()), (tried.id.as_str(), tried.folder.as_str()));
    assert!(!installed.temporary);
    assert_eq!(env.skins().len(), 1);
    assert_eq!(env.folders(), [folder()]);
}

#[test]
fn tries_left_by_the_last_session_are_discarded_at_launch() {
    let env = Env::new("purge");
    let kept = env.installed("101", InstallMode::Normal);
    *env.client.author.lock().unwrap() = "Other".into();
    env.installed("102", InstallMode::Temporary);
    assert_eq!(install::purge_tries(&env.user_skins, &env.store, next_launch()), 1);
    assert_eq!(env.skins(), vec![kept]);
    assert_eq!(env.folders(), [folder()]);
    assert_eq!(install::purge_tries(&env.user_skins, &env.store, next_launch()), 0);
}

// ── Textures before installing ──────────────────────────────────────────────

#[test]
fn a_posts_textures_are_read_from_its_archive() {
    let env = Env::new("textures");
    let textures = install::post_textures(&env.client, "101").unwrap();
    let files: Vec<&str> = textures.iter().map(|t| t.file.as_str()).collect();
    assert!(files.contains(&"tiger_body_c.dds"), "{files:?}");
    assert!(env.folders().is_empty(), "nothing is installed");
    let empty = Env::with("textures-empty", true);
    let e = install::post_textures(&empty.client, "101").unwrap_err();
    assert_eq!(e.message, NO_BLK_ERROR);
}

#[test]
fn errors_say_what_failed() {
    // A client that can't download: the install ends with the client's error.
    struct Down(FakeClient);
    impl WtLiveClient for Down {
        fn ready(&self) -> AppResult<()> {
            Ok(())
        }
        fn search(&self, p: &SearchParams) -> AppResult<SearchResult> {
            self.0.search(p)
        }
        fn post(&self, id: &str) -> AppResult<WtLiveSkin> {
            self.0.post(id)
        }
        fn following_new(&self, f: &[FollowEntry]) -> AppResult<Vec<WtLiveSkin>> {
            self.0.following_new(f)
        }
        fn archive(&self, _: &str, _: &mut dyn FnMut(DownloadProgress)) -> AppResult<PathBuf> {
            Err(AppError::new(ErrorCode::Network, "WT Live can't be reached"))
        }
    }
    let env = Env::new("down");
    let down =
        Down(FakeClient { dir: env.root.clone(), author: Mutex::new("x".into()), empty_archive: false, pack: false });
    let ctx = Ctx { user_skins: &env.user_skins, library: &env.store, settings: &env.settings, client: &down };
    let job = install::prepare(&ctx, &env.installing, "101", InstallMode::Normal, None).unwrap();
    let mut events = Vec::new();
    let e = install::run(&ctx, &job, &mut |p| events.push(p.clone())).unwrap_err();
    assert_eq!(e.code, ErrorCode::Network);
    assert_eq!(events.last().unwrap().step, InstallStep::Error);
    assert!(env.skins().is_empty());
}

#[test]
fn a_try_started_this_session_survives_the_launch_purge() {
    let env = Env::new("purge-new");
    let launched = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
    env.installed("101", InstallMode::Temporary);
    assert_eq!(install::purge_tries(&env.user_skins, &env.store, launched), 0);
    assert_eq!(env.skins().len(), 1);
}

#[test]
fn the_version_a_try_replaced_survives_clear_and_purge_and_isnt_listed() {
    use livery_lib::backup;
    let env = Env::new("tried-backup");
    let original = env.installed("101", InstallMode::Normal);
    env.install("101", InstallMode::Temporary, Some(ConflictPolicy::Replace)).0.unwrap().unwrap();
    let tried_backup = env.store.snapshot().tried_backups.values().next().cloned().unwrap();
    assert!(backup::list(&env.store).iter().all(|b| b.id != tried_backup), "not offered in Settings → Backups");
    backup::clear(&env.user_skins, &env.store, None).unwrap();
    let far_future = std::time::SystemTime::now() + std::time::Duration::from_secs(400 * 24 * 3600);
    backup::purge(&env.user_skins, &env.store, far_future, 1, &[]).unwrap();
    assert!(env.store.snapshot().backups.iter().any(|b| b.backup.id == tried_backup), "still there");
    install::finalize(&env.user_skins, &env.store, "101", false, true).unwrap();
    assert_eq!(env.skins()[0].id, original.id, "Discard still brings it back");
}

#[test]
fn keeping_a_try_with_backups_off_leaves_only_an_undo_backup() {
    let env = Env::new("keep-off");
    env.installed("101", InstallMode::Normal);
    env.install("101", InstallMode::Temporary, Some(ConflictPolicy::Replace)).0.unwrap().unwrap();
    install::finalize(&env.user_skins, &env.store, "101", true, false).unwrap();
    let library = env.store.snapshot();
    assert!(library.tried_backups.is_empty());
    assert!(library.backups.iter().all(|b| b.ephemeral), "gone within a minute, like any backup with backups off");
    assert!(livery_lib::backup::list(&env.store).is_empty());
}

/// A launch after everything installed so far (install times are stored to the second).
fn next_launch() -> std::time::SystemTime {
    std::time::SystemTime::now() + std::time::Duration::from_secs(2)
}
