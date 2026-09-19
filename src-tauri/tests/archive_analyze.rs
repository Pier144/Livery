//! Queue analysis: skin roots in the committed `fixtures/sources` (one skin, a pack of three, no
//! blk, a skin two folders down), statuses and notes, name clashes (active, inactive, unindexed,
//! another queued item), unsupported archives, the queue store (dedupe, order, remove) and the
//! texture list of a queued item. Temp folders for everything that is written.

use livery_lib::archive::analyze::{
    analyze_source, find_clash, sanitize_folder_name, FALLBACK_FOLDER, MAX_ROOT_DEPTH, NO_BLK_ERROR,
};
use livery_lib::archive::source::NOT_A_SOURCE;
use livery_lib::archive::{analyze_path, textures_for_queue, FolderSource, QueueStore, Queued, UNSUPPORTED_ARCHIVES};
use livery_lib::error::{AppError, ErrorCode};
use livery_lib::library::index::LibraryStore;
use livery_lib::library::layout::inactive_dir;
use livery_lib::library::{import_folders, ops};
use livery_lib::model::{FileEntry, QueueItem, QueueStatus};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-analyze-{name}-{}-{n}", std::process::id()));
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

fn size(path: &Path) -> u64 {
    fs::metadata(path).unwrap().len()
}

fn err<T>(result: Result<T, AppError>) -> AppError {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

/// A game folder in a temp dir with its library and queue.
struct Env {
    tmp: TempDir,
    user_skins: PathBuf,
    store: LibraryStore,
    queue: QueueStore,
}

impl Env {
    fn new(name: &str) -> Self {
        let tmp = TempDir::new(name);
        let user_skins = tmp.path().join("game").join("UserSkins");
        fs::create_dir_all(&user_skins).unwrap();
        let store = LibraryStore::load(tmp.path().join("data").join("library.json"));
        Self { tmp, user_skins, store, queue: QueueStore::default() }
    }

    fn queued(&self, path: &Path) -> Queued {
        analyze_path(path, Some(&self.user_skins), &self.store, &self.queue).unwrap()
    }

    fn analyze(&self, path: &Path) -> QueueItem {
        self.queued(path).item
    }

    /// A skin folder already in `UserSkins` (optionally imported into the index).
    fn installed(&self, folder: &str, code: &str, import: bool) {
        let dir = self.user_skins.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{code}.blk")), "replace_tex{}").unwrap();
        if import {
            import_folders(&self.user_skins, &self.store, &[folder.to_owned()]).unwrap();
        }
    }

    fn skin_id(&self, folder: &str) -> String {
        self.store.all().into_iter().find(|s| s.folder == folder).unwrap().id
    }
}

// ── Skin roots ──────────────────────────────────────────────────────────────

#[test]
fn a_single_skin_folder_is_one_root_at_the_top() {
    let analysis = analyze_source(&FolderSource::new(fixture("Winter Tiger")), "Winter Tiger").unwrap();
    assert_eq!(analysis.roots.len(), 1);
    let root = &analysis.roots[0];
    assert_eq!(root.dir, "");
    assert_eq!(root.blk, "germ_pzkpfw_VI_ausf_b_tiger_IIH.blk");
    assert_eq!(root.vehicle.name, "Tiger II (H)", "vehicle from the catalog via the blk stem");
    assert_eq!(root.target_folder, "Winter Tiger", "the source folder's own name");
    assert!(root.blk_ok);
    assert_eq!(root.texture_count, 2);
    let paths: Vec<&str> = root.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        ["extras/readme.txt", "germ_pzkpfw_VI_ausf_b_tiger_IIH.blk", "tiger_body_c.dds", "tiger_camo.tga"],
        "every file under the root, relative, sorted"
    );
    let dir = fixture("Winter Tiger");
    assert_eq!(
        root.files[2],
        FileEntry { path: "tiger_body_c.dds".into(), size_bytes: size(&dir.join("tiger_body_c.dds")) }
    );
    let total: u64 = root.files.iter().map(|f| f.size_bytes).sum();
    assert_eq!(analysis.size_bytes, total);
}

#[test]
fn a_pack_has_one_root_per_skin_folder_ordered_by_path() {
    let analysis = analyze_source(&FolderSource::new(fixture("Desert Pack")), "Desert Pack").unwrap();
    let roots: Vec<(&str, &str, &str)> =
        analysis.roots.iter().map(|r| (r.dir.as_str(), r.vehicle.code.as_str(), r.target_folder.as_str())).collect();
    assert_eq!(
        roots,
        [
            ("Gustav Desert", "bf-109g-6", "Gustav Desert"),
            ("Phantom Desert", "f_4e", "Phantom Desert"),
            ("Su-27 Desert", "su_27", "Su-27 Desert"),
        ]
    );
    assert_eq!(analysis.roots[1].files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["f4e_c.dds", "f_4e.blk"]);
}

#[test]
fn a_root_two_folders_down_is_found_with_paths_relative_to_it() {
    let analysis = analyze_source(&FolderSource::new(fixture("Nested Download")), "Nested Download").unwrap();
    assert_eq!(analysis.roots.len(), 1);
    let root = &analysis.roots[0];
    assert_eq!(root.dir, "outer/Inner Skin");
    assert_eq!(root.target_folder, "Inner Skin");
    assert_eq!(root.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["su27_c.dds", "su_27.blk"]);
    assert_eq!(
        analysis.size_bytes,
        root.files.iter().map(|f| f.size_bytes).sum::<u64>()
            + size(&fixture("Nested Download").join("outer").join("info.txt"))
    );
}

#[test]
fn a_folder_without_blk_has_no_root() {
    let analysis = analyze_source(&FolderSource::new(fixture("Loose Textures")), "Loose Textures").unwrap();
    assert!(analysis.roots.is_empty());
    assert!(analysis.size_bytes > 0);
}

#[test]
fn roots_deeper_than_the_limit_or_hidden_are_ignored() {
    let tmp = TempDir::new("deep");
    let at_limit = (1..=MAX_ROOT_DEPTH).map(|n| format!("l{n}")).collect::<Vec<_>>().join("/");
    tmp.write(&format!("src/{at_limit}/su_27.blk"), b"replace_tex{}");
    tmp.write(&format!("src/{at_limit}/too deep/f_4e.blk"), b"replace_tex{}");
    tmp.write("src/.git/x/us_m1a2_sep.blk", b"");
    tmp.write("src/__MACOSX/Skin/ussr_t_34_85.blk", b"");
    let analysis = analyze_source(&FolderSource::new(tmp.path().join("src")), "src").unwrap();
    let dirs: Vec<&str> = analysis.roots.iter().map(|r| r.dir.as_str()).collect();
    assert_eq!(dirs, [at_limit.as_str()]);
}

#[test]
fn the_skin_blk_is_the_alphabetically_first_and_a_bad_one_is_flagged() {
    let tmp = TempDir::new("blk");
    tmp.write("Two/su_27.blk", b"replace_tex{ to:t=\"a\" }");
    tmp.write("Two/F_4E.BLK", b"this { is not blk");
    tmp.write("Two/a.dds", b"x");
    tmp.write("Two/b.TGA", b"x");
    tmp.write("Two/sub/c.dds", b"x");
    let analysis = analyze_source(&FolderSource::new(tmp.path().join("Two")), "Two").unwrap();
    let root = &analysis.roots[0];
    assert_eq!(root.blk, "F_4E.BLK");
    assert_eq!(root.vehicle.code, "f_4e", "catalog spelling of the code");
    assert!(!root.blk_ok);
    assert_eq!(root.texture_count, 2, "top-level textures only, like the texture table");
}

#[test]
fn folder_names_are_sanitized() {
    assert_eq!(sanitize_folder_name("Winter Tiger", "x"), "Winter Tiger");
    assert_eq!(sanitize_folder_name(".hidden skin", "x"), "hidden skin");
    assert_eq!(sanitize_folder_name("a:b*c?", "x"), "a_b_c_");
    assert_eq!(sanitize_folder_name("trailing. . ", "x"), "trailing");
    assert_eq!(sanitize_folder_name("CON", "x"), "CON_");
    assert_eq!(sanitize_folder_name("com1.skin", "x"), "com1_.skin", "the device name itself changes");
    assert_eq!(sanitize_folder_name("NUL .tar", "x"), "NUL_ .tar");
    assert_eq!(sanitize_folder_name("LPT¹", "x"), "LPT¹_", "superscript digits are device names too");
    assert_eq!(sanitize_folder_name("COM10", "x"), "COM10");
    assert_eq!(sanitize_folder_name("COM0", "x"), "COM0", "COM0 isn't a device name");
    assert_eq!(sanitize_folder_name("...", "su_27"), "su_27", "nothing left: the vehicle code");
    assert_eq!(sanitize_folder_name("", ""), FALLBACK_FOLDER);
    assert_eq!(sanitize_folder_name(&"n".repeat(300), "x").chars().count(), 120);
}

// ── Queue items ─────────────────────────────────────────────────────────────

#[test]
fn a_ready_item_carries_vehicle_target_files_and_note() {
    let env = Env::new("ready");
    let item = env.analyze(&fixture("Winter Tiger"));
    assert!(item.id.starts_with("q-"), "{}", item.id);
    assert_eq!(item.status, QueueStatus::Ready);
    assert_eq!(item.file_name, "Winter Tiger");
    assert!(item.path.ends_with("Winter Tiger"));
    assert_eq!(item.vehicle.as_ref().unwrap().code, "germ_pzkpfw_VI_ausf_b_tiger_IIH");
    assert_eq!(item.target_folder.as_deref(), Some("Winter Tiger"));
    assert_eq!(item.files.len(), 4);
    assert_eq!(item.texture_count, Some(2));
    assert_eq!(item.blk_ok, Some(true));
    assert_eq!(item.note.as_deref(), Some("4 files · 2 textures · germ_pzkpfw_VI_ausf_b_tiger_IIH.blk ok"));
    assert_eq!(item.size_bytes, item.files.iter().map(|f| f.size_bytes).sum::<u64>());
    assert!(item.conflict_with.is_none() && item.error.is_none() && item.candidates.is_empty());
    assert_eq!(env.queue.list(), std::slice::from_ref(&item), "stored");
    assert_eq!(env.queue.get(&item.id), Some(item));
}

#[test]
fn a_pack_needs_a_look_with_one_candidate_per_skin() {
    let env = Env::new("pack");
    let item = env.analyze(&fixture("Desert Pack"));
    assert_eq!(item.status, QueueStatus::NeedsLook);
    let codes: Vec<&str> = item.candidates.iter().map(|v| v.code.as_str()).collect();
    assert_eq!(codes, ["bf-109g-6", "f_4e", "su_27"]);
    assert_eq!(item.note.as_deref(), Some("Can't detect the vehicle: 3 folders inside. Pick one to continue."));
    assert!(item.vehicle.is_none() && item.target_folder.is_none() && item.files.is_empty());
}

#[test]
fn a_nested_skin_is_ready_under_its_own_folder_name() {
    let env = Env::new("nested");
    let item = env.analyze(&fixture("Nested Download"));
    assert_eq!(item.status, QueueStatus::Ready);
    assert_eq!(item.file_name, "Nested Download");
    assert_eq!(item.target_folder.as_deref(), Some("Inner Skin"));
    assert_eq!(item.note.as_deref(), Some("2 files · 1 texture · su_27.blk ok"));
}

#[test]
fn a_folder_without_blk_is_an_error_item() {
    let env = Env::new("noblk");
    let item = env.analyze(&fixture("Loose Textures"));
    assert_eq!(item.status, QueueStatus::Error);
    assert_eq!(item.error.as_deref(), Some(NO_BLK_ERROR));
    assert!(item.size_bytes > 0);
    assert_eq!(env.queue.list().len(), 1, "kept so the row can explain itself");
    let e = err(textures_for_queue(&env.queue, &item.id));
    assert_eq!(e.code, ErrorCode::InvalidInput);
}

#[test]
fn an_archive_is_an_error_item_with_the_unsupported_message() {
    let env = Env::new("zip");
    let zip = env.tmp.write("downloads/Tiger Winter.ZIP", &[b'P', b'K', 3, 4, 0, 0, 0, 0, 0, 0]);
    let item = env.analyze(&zip);
    assert_eq!(item.status, QueueStatus::Error);
    assert_eq!(item.error.as_deref(), Some(UNSUPPORTED_ARCHIVES));
    assert_eq!(item.file_name, "Tiger Winter.ZIP");
    assert_eq!(item.size_bytes, 10, "the archive's own size");
    assert_eq!(env.queue.list(), std::slice::from_ref(&item));
    let e = err(textures_for_queue(&env.queue, &item.id));
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert_eq!(e.message, UNSUPPORTED_ARCHIVES);
}

#[test]
fn paths_that_are_not_skins_are_refused_and_not_stored() {
    let env = Env::new("refused");
    let txt = env.tmp.write("readme.txt", b"hi");
    let e = err(analyze_path(&txt, Some(&env.user_skins), &env.store, &env.queue));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, NOT_A_SOURCE));
    let e = err(analyze_path(&env.tmp.path().join("gone"), Some(&env.user_skins), &env.store, &env.queue));
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(env.queue.list().is_empty());
}

#[test]
fn the_queue_is_newest_first_and_a_path_is_queued_once() {
    let env = Env::new("order");
    let first = env.analyze(&fixture("Winter Tiger"));
    let second = env.analyze(&fixture("Desert Pack"));
    assert_eq!(
        env.queue.list().iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        [second.id.clone(), first.id.clone()]
    );

    // The same folder again (spelled differently) is analysed again in place: same id, same spot.
    let spelled = PathBuf::from(format!("{}\\", fixture("Winter Tiger").display()));
    let again = env.analyze(&spelled);
    assert_eq!(again.id, first.id);
    assert_eq!(env.queue.list().len(), 2);

    env.queue.remove(&first.id, Some(&env.user_skins), &env.store.snapshot()).unwrap();
    assert_eq!(env.queue.list().iter().map(|i| i.id.clone()).collect::<Vec<_>>(), std::slice::from_ref(&second.id));
    // Unknown ids are fine.
    assert!(env.queue.remove("q-nope", None, &env.store.snapshot()).unwrap().is_empty());
}

#[test]
fn without_a_game_folder_nothing_can_clash() {
    let env = Env::new("nogame");
    env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH", true);
    let item = analyze_path(&fixture("Winter Tiger"), None, &env.store, &env.queue).unwrap().item;
    assert_eq!(item.status, QueueStatus::Ready);
}

// ── Name clashes ────────────────────────────────────────────────────────────

#[test]
fn a_folder_name_used_by_an_indexed_skin_is_a_conflict_with_it() {
    let env = Env::new("clash-active");
    env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH", true);
    let id = env.skin_id("Winter Tiger");
    let item = env.analyze(&fixture("Winter Tiger"));
    assert_eq!(item.status, QueueStatus::Conflict);
    assert_eq!(item.conflict_with.as_deref(), Some(id.as_str()));
    assert_eq!(item.note.as_deref(), Some("Same folder name as “Winter Tiger” (installed)"));
    assert_eq!(item.target_folder.as_deref(), Some("Winter Tiger"));
    assert!(item.vehicle.is_some() && !item.files.is_empty(), "still describes the skin");
}

#[test]
fn an_inactive_skin_with_the_same_folder_is_a_conflict_too() {
    let env = Env::new("clash-inactive");
    env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH", true);
    let id = env.skin_id("Winter Tiger");
    ops::set_active(&env.user_skins, &env.store, std::slice::from_ref(&id), false).unwrap();
    assert!(inactive_dir(&env.user_skins).join("Winter Tiger").is_dir());
    let item = env.analyze(&fixture("Winter Tiger"));
    assert_eq!(item.status, QueueStatus::Conflict);
    assert_eq!(item.conflict_with.as_deref(), Some(id.as_str()));
    let clash = find_clash(&env.user_skins, &env.store.snapshot(), "Winter Tiger").unwrap();
    assert!(!clash.active);
}

#[test]
fn an_unindexed_folder_is_a_disk_conflict_matched_case_insensitively() {
    let env = Env::new("clash-disk");
    env.installed("WINTER tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH", false);
    let item = env.analyze(&fixture("Winter Tiger"));
    if cfg!(windows) {
        assert_eq!(item.status, QueueStatus::Conflict);
        assert_eq!(item.conflict_with.as_deref(), Some("disk:WINTER tiger"), "the spelling on disk");
    } else {
        assert_eq!(item.status, QueueStatus::Ready, "case-sensitive file systems keep both");
    }
}

#[test]
fn a_second_item_for_the_same_folder_conflicts_with_the_queued_one() {
    let env = Env::new("clash-queue");
    // A copy of the fixture elsewhere: a different source with the same folder name.
    let other = env.tmp.path().join("downloads").join("Winter Tiger");
    fs::create_dir_all(&other).unwrap();
    for name in ["germ_pzkpfw_VI_ausf_b_tiger_IIH.blk", "tiger_body_c.dds"] {
        fs::copy(fixture("Winter Tiger").join(name), other.join(name)).unwrap();
    }
    let first = env.analyze(&fixture("Winter Tiger"));
    let second = env.queued(&other);
    assert_eq!(first.status, QueueStatus::Ready, "the older one keeps the name");
    assert_eq!(second.item.status, QueueStatus::Conflict);
    assert_eq!(second.item.conflict_with, Some(format!("queue:{}", first.id)));
    assert_eq!(second.item.note.as_deref(), Some("Same folder name as “Winter Tiger” (queued)"));
    assert!(second.changed.is_empty(), "the older item didn't change");

    // Once the older item leaves the queue, the newer one is ready (and reported as changed).
    let changed = env.queue.remove(&first.id, Some(&env.user_skins), &env.store.snapshot()).unwrap();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].id, second.item.id);
    assert_eq!(changed[0].status, QueueStatus::Ready);
    assert_eq!(env.queue.get(&second.item.id).unwrap().status, QueueStatus::Ready);
}

#[test]
fn a_skin_installed_meanwhile_turns_ready_items_into_conflicts_on_the_next_analysis() {
    let env = Env::new("clash-later");
    let tiger = env.analyze(&fixture("Winter Tiger"));
    assert_eq!(tiger.status, QueueStatus::Ready);
    env.installed("Winter Tiger", "germ_pzkpfw_VI_ausf_b_tiger_IIH", true);
    let queued = env.queued(&fixture("Nested Download"));
    assert_eq!(queued.changed.len(), 1, "the other item is re-sent");
    assert_eq!(queued.changed[0].status, QueueStatus::Conflict);
    assert_eq!(queued.changed[0].conflict_with, Some(env.skin_id("Winter Tiger")));
}

// ── Textures of a queued item ───────────────────────────────────────────────

#[test]
fn textures_of_a_queued_skin_come_from_the_source() {
    let env = Env::new("textures");
    let item = env.analyze(&fixture("Winter Tiger"));
    let list = textures_for_queue(&env.queue, &item.id).unwrap();
    let files: Vec<(&str, Option<&str>)> = list.iter().map(|t| (t.file.as_str(), t.format.as_deref())).collect();
    assert_eq!(
        files,
        [
            ("tiger_body_c.dds", Some("BC1")),
            ("tiger_camo.tga", Some("RGBA8")),
            ("germ_pzkpfw_VI_ausf_b_tiger_IIH.blk", Some("BLK"))
        ]
    );
    assert_eq!(list[0].width, Some(512));

    let nested = env.analyze(&fixture("Nested Download"));
    let list = textures_for_queue(&env.queue, &nested.id).unwrap();
    assert!(list.iter().any(|t| t.file == "su27_n.dds" && t.missing), "referenced but missing");
}

#[test]
fn textures_of_a_pack_list_every_skin_prefixed_by_its_folder() {
    let env = Env::new("textures-pack");
    let item = env.analyze(&fixture("Desert Pack"));
    let files: Vec<String> = textures_for_queue(&env.queue, &item.id).unwrap().into_iter().map(|t| t.file).collect();
    assert_eq!(
        files,
        [
            "Gustav Desert/bf109_c.dds",
            "Gustav Desert/bf-109g-6.blk",
            "Phantom Desert/f4e_c.dds",
            "Phantom Desert/f_4e.blk",
            "Su-27 Desert/su27_c.dds",
            "Su-27 Desert/su_27.blk",
        ]
    );
    assert_eq!(err(textures_for_queue(&env.queue, "q-unknown")).code, ErrorCode::NotFound);
}
