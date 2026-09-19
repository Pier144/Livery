//! Library index persistence (atomic JSON, tolerant load), idempotent import, scan merging,
//! and the command cores (`user_skins_dir`, `scan_game`, `import_folders`) on temp folders.
//! M3 behaviour (inactive folder, v2 index, prune) is in `library_hangar.rs`.

use livery_lib::error::ErrorCode;
use livery_lib::library::index::{new_id, INDEX_VERSION};
use livery_lib::library::{import_folders, scan_game, user_skins_dir, LibraryStore, NO_GAME_FOLDER};
use livery_lib::model::{AttentionKind, Author, HangarSkin, Origin, Settings};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-index-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn file(&self, rel: &str, contents: &str) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }

    fn index_path(&self) -> PathBuf {
        self.0.join("data").join("library.json")
    }

    fn user_skins(&self) -> PathBuf {
        self.0.join("game").join("UserSkins")
    }

    /// A skin folder in the temp `UserSkins` with a blk for `code` and the textures it names.
    fn skin(&self, folder: &str, code: &str, textures: &[&str]) {
        let refs: String = textures.iter().map(|t| format!("replace_tex{{ from:t=\"x*\"; to:t=\"{t}\" }}\n")).collect();
        self.file(&format!("game/UserSkins/{folder}/{code}.blk"), &refs);
        for t in textures {
            self.file(&format!("game/UserSkins/{folder}/{t}"), "texture");
        }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn folders(skins: &[HangarSkin]) -> Vec<&str> {
    skins.iter().map(|s| s.folder.as_str()).collect()
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

// ── Persistence ─────────────────────────────────────────────────────────────

#[test]
fn missing_file_is_an_empty_index() {
    let tmp = TempDir::new("missing");
    let store = LibraryStore::load(tmp.index_path());
    assert_eq!(store.all(), []);
    assert_eq!(store.path(), tmp.index_path());
    assert!(!tmp.index_path().exists(), "loading never writes");
}

#[test]
fn import_persists_and_reloads() {
    let tmp = TempDir::new("roundtrip");
    tmp.skin("Winter", "ussr_t_34_85", &["hull_c.dds"]);
    let store = LibraryStore::load(tmp.index_path());
    let index = import_folders(&tmp.user_skins(), &store, &names(&["Winter"])).unwrap();
    assert_eq!(folders(&index), ["Winter"]);
    assert!(index[0].id.starts_with("s-"), "{}", index[0].id);
    assert_eq!(index[0].vehicle.name, "T-34-85");
    assert!(!tmp.index_path().with_extension("json.tmp").exists(), "temp file is renamed away");

    let json: serde_json::Value = serde_json::from_slice(&fs::read(tmp.index_path()).unwrap()).unwrap();
    assert_eq!(json["version"], INDEX_VERSION);
    assert_eq!(json["skins"][0]["folder"], "Winter");
    assert_eq!(json["skins"][0]["installedAt"], index[0].installed_at.as_str(), "camelCase on disk");

    assert_eq!(LibraryStore::load(tmp.index_path()).all(), index);
}

#[test]
fn corrupt_file_is_set_aside() {
    let tmp = TempDir::new("corrupt");
    let path = tmp.file("data/library.json", "{ \"version\": 1, \"skins\": [");
    let store = LibraryStore::load(path.clone());
    assert_eq!(store.all(), []);
    assert!(!path.exists());
    assert_eq!(fs::read_to_string(path.with_extension("json.bad")).unwrap(), "{ \"version\": 1, \"skins\": [");
}

#[test]
fn unreadable_entries_are_dropped_and_the_original_kept() {
    let tmp = TempDir::new("entries");
    tmp.skin("Good", "su_27", &[]);
    let seeded = LibraryStore::load(tmp.index_path());
    let good = import_folders(&tmp.user_skins(), &seeded, &names(&["Good"])).unwrap().remove(0);

    let text = serde_json::json!({ "version": 1, "skins": [good, { "id": "broken" }] }).to_string();
    let path = tmp.file("data/library.json", &format!("\u{feff}{text}"));
    let store = LibraryStore::load(path.clone());
    assert_eq!(store.all(), [good], "the good entry survives (and a BOM is tolerated)");
    assert!(path.exists(), "the file stays in place");
    assert!(fs::read_to_string(path.with_extension("json.bad")).unwrap().contains("broken"));
}

#[test]
fn ids_are_unique() {
    let ids: HashSet<String> = (0..1000).map(|_| new_id()).collect();
    assert_eq!(ids.len(), 1000);
    assert!(ids.iter().all(|id| id.starts_with("s-") && id.matches('-').count() == 2));
}

// ── Import ──────────────────────────────────────────────────────────────────

#[test]
fn importing_twice_changes_only_disk_facts() {
    let tmp = TempDir::new("idempotent");
    tmp.skin("Winter", "ussr_t_34_85", &["hull_c.dds"]);
    tmp.skin("template_su_27", "su_27", &[]);
    let store = LibraryStore::load(tmp.index_path());
    let first = import_folders(&tmp.user_skins(), &store, &names(&["Winter", "template_su_27"])).unwrap();
    assert_eq!(folders(&first), ["Winter", "template_su_27"]);
    assert_eq!(first[1].origin, Origin::Mine);

    // The texture disappears: the second import refreshes attention and size, nothing else.
    fs::remove_file(tmp.user_skins().join("Winter").join("hull_c.dds")).unwrap();
    let second = import_folders(&tmp.user_skins(), &store, &names(&["Winter", "Winter"])).unwrap();
    assert_eq!(second.len(), 2);
    assert_eq!(second[0].id, first[0].id);
    assert_eq!(second[0].installed_at, first[0].installed_at);
    assert_eq!(second[0].attention.iter().map(|a| a.kind).collect::<Vec<_>>(), [AttentionKind::MissingTexture]);
    assert!(second[0].size_bytes < first[0].size_bytes);
    assert_eq!(second[1], first[1], "untouched skins stay as they were");
    assert_eq!(LibraryStore::load(tmp.index_path()).all(), second);
}

#[cfg(windows)]
#[test]
fn folder_match_is_case_insensitive_on_windows() {
    let tmp = TempDir::new("case");
    tmp.skin("Winter", "su_27", &[]);
    let store = LibraryStore::load(tmp.index_path());
    let first = import_folders(&tmp.user_skins(), &store, &names(&["Winter"])).unwrap();
    let again = import_folders(&tmp.user_skins(), &store, &names(&["WINTER"])).unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].id, first[0].id);
    assert_eq!(again[0].folder, "Winter", "the on-disk spelling is kept");

    // A fresh index also stores the on-disk spelling, whatever the request said.
    let other = LibraryStore::load(tmp.path().join("other.json"));
    assert_eq!(folders(&import_folders(&tmp.user_skins(), &other, &names(&["wInTeR"])).unwrap()), ["Winter"]);
}

#[test]
fn import_rejects_paths_and_skips_vanished_folders() {
    let tmp = TempDir::new("names");
    tmp.skin("Winter", "su_27", &[]);
    let store = LibraryStore::load(tmp.index_path());
    // Hidden names (Livery's own `.livery` included) and names Windows would silently shorten
    // ("...", "Winter.", "Winter ") could point at another folder, so they are refused too.
    for bad in [
        "",
        ".",
        "..",
        "...",
        ".livery",
        ".hidden",
        "../Winter",
        "a/b",
        "a\\b",
        "C:Winter",
        "Winter.",
        "Winter ",
        "a\nb",
    ] {
        let e = import_folders(&tmp.user_skins(), &store, &names(&["Winter", bad])).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput, "{bad:?}");
    }
    assert_eq!(store.all(), [], "nothing is imported when a name is invalid");

    let index = import_folders(&tmp.user_skins(), &store, &names(&["Gone", "Winter"])).unwrap();
    assert_eq!(folders(&index), ["Winter"]);
}

#[test]
fn empty_import_writes_nothing() {
    let tmp = TempDir::new("empty");
    let store = LibraryStore::load(tmp.index_path());
    assert_eq!(import_folders(&tmp.user_skins(), &store, &[]).unwrap(), []);
    assert!(!tmp.index_path().exists());
}

#[test]
fn failed_write_leaves_memory_unchanged() {
    let tmp = TempDir::new("readonly");
    tmp.skin("Winter", "su_27", &[]);
    // The index path is a directory, so the rename over it fails.
    fs::create_dir_all(tmp.index_path()).unwrap();
    let store = LibraryStore::load(tmp.index_path());
    assert!(import_folders(&tmp.user_skins(), &store, &names(&["Winter"])).is_err());
    assert_eq!(store.all(), []);
}

// ── Scan merge ──────────────────────────────────────────────────────────────

#[test]
fn scan_keeps_index_identity_and_refreshes_disk_facts() {
    let tmp = TempDir::new("merge");
    tmp.skin("Winter", "su_27", &["a.dds"]);
    tmp.skin("New One", "f_4e", &[]);
    let path = tmp.index_path();
    let store = LibraryStore::load(path.clone());
    let imported = import_folders(&tmp.user_skins(), &store, &names(&["Winter"])).unwrap().remove(0);

    // Pretend the index knows more than the disk: author, WT Live origin, older date, and a
    // stale "inactive" flag (the folder is in UserSkins, so the disk says active).
    let mut known = imported.clone();
    known.origin = Origin::Wtlive;
    known.author = Some(Author {
        id: "a1".into(),
        name: "Skinner".into(),
        url: "https://example.invalid".into(),
        skin_count: None,
    });
    known.active = false;
    known.installed_at = "2025-01-02T03:04:05Z".into();
    known.source_id = Some("wt-123".into());
    known.name = "Winter Flanker".into();
    fs::write(&path, serde_json::json!({ "version": 1, "skins": [known] }).to_string()).unwrap();
    let store = LibraryStore::load(path.clone());

    fs::remove_file(tmp.user_skins().join("Winter").join("a.dds")).unwrap();
    let skins = scan_game(&tmp.user_skins(), &store).unwrap();
    assert_eq!(folders(&skins), ["New One", "Winter"]);

    let fresh = &skins[0];
    assert_eq!(fresh.id, "disk:New One");
    assert_eq!(fresh.vehicle.name, "F-4E Phantom II");

    let merged = &skins[1];
    assert_eq!(merged.id, known.id);
    assert_eq!(merged.origin, Origin::Wtlive);
    assert_eq!(merged.author, known.author);
    assert!(merged.active, "active comes from where the folder is");
    assert_eq!(merged.installed_at, "2025-01-02T03:04:05Z");
    assert_eq!(merged.source_id.as_deref(), Some("wt-123"));
    assert_eq!(merged.name, "Winter Flanker");
    assert_eq!(merged.attention.len(), 1, "attention is fresh");
    assert!(merged.size_bytes < imported.size_bytes, "size is fresh");

    // Re-check refreshes the index entry it found (and only adds nothing: New One isn't indexed).
    assert_eq!(store.all(), std::slice::from_ref(merged));
    assert_eq!(LibraryStore::load(path).all(), std::slice::from_ref(merged), "and saves it");
}

#[test]
fn scan_of_an_unchanged_library_writes_nothing() {
    let tmp = TempDir::new("nowrite");
    tmp.skin("Winter", "su_27", &[]);
    let store = LibraryStore::load(tmp.index_path());
    // Nothing indexed yet (First run lists folders before importing): no file appears.
    assert_eq!(folders(&scan_game(&tmp.user_skins(), &store).unwrap()), ["Winter"]);
    assert!(!tmp.index_path().exists());

    import_folders(&tmp.user_skins(), &store, &names(&["Winter"])).unwrap();
    // Remove the file behind the store's back: a rescan with the same facts doesn't rewrite it.
    fs::remove_file(tmp.index_path()).unwrap();
    scan_game(&tmp.user_skins(), &store).unwrap();
    assert!(!tmp.index_path().exists());
}

// ── Game folder from settings ───────────────────────────────────────────────

#[test]
fn user_skins_dir_needs_a_saved_existing_game_folder() {
    let tmp = TempDir::new("settings");
    let e = user_skins_dir(&Settings::default()).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, NO_GAME_FOLDER));
    let blank = Settings { game_path: Some("   ".into()), ..Settings::default() };
    assert_eq!(user_skins_dir(&blank).unwrap_err().code, ErrorCode::InvalidInput);

    let gone = Settings { game_path: Some(tmp.path().join("nope").display().to_string()), ..Settings::default() };
    assert_eq!(user_skins_dir(&gone).unwrap_err().code, ErrorCode::NotFound);

    fs::create_dir_all(tmp.path().join("game")).unwrap();
    let ok = Settings { game_path: Some(tmp.path().join("game").display().to_string()), ..Settings::default() };
    assert_eq!(user_skins_dir(&ok).unwrap(), tmp.user_skins());
    // A game folder without UserSkins yet simply has no skins.
    assert_eq!(scan_game(&user_skins_dir(&ok).unwrap(), &LibraryStore::load(tmp.index_path())).unwrap(), []);
}
