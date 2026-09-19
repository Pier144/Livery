//! One library index per game root, on temp folders: changing the game folder shows that
//! folder's skins, collections and backups (and changing back restores the first ones), the
//! pre-M6 `library.json` migrates once to the first root, a corrupt per-root file is set aside,
//! and spellings of one folder share an index.

use livery_lib::error::ErrorCode;
use livery_lib::game::apply_game_path;
use livery_lib::library::index::LibraryStore;
use livery_lib::library::roots::{root_key, LEGACY_INDEX, LIBRARY_DIR};
use livery_lib::library::{collections, import_folders, ops, GameLibrary, Libraries, NO_GAME_FOLDER};
use livery_lib::model::Settings;
use livery_lib::settings::SettingsStore;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-roots-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    /// The app data dir.
    fn data(&self) -> PathBuf {
        self.0.join("data")
    }

    fn legacy(&self) -> PathBuf {
        self.data().join(LEGACY_INDEX)
    }

    fn libraries(&self) -> Libraries {
        Libraries::new(&self.data())
    }

    fn settings(&self) -> SettingsStore {
        SettingsStore::load(self.data().join("settings.json"))
    }

    /// A game root (`launcher.exe`) with skin folders in its `UserSkins`.
    fn game(&self, name: &str, skins: &[&str]) -> PathBuf {
        let root = self.0.join(name);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("launcher.exe"), "").unwrap();
        for folder in skins {
            let dir = root.join("UserSkins").join(folder);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("su_27.blk"), "").unwrap();
        }
        root
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn folders(store: &LibraryStore) -> Vec<String> {
    store.all().into_iter().map(|s| s.folder).collect()
}

/// `set_game_path` without the app: save the folder, then resolve what the commands work on.
fn switch(settings: &SettingsStore, libraries: &Libraries, game: &Path) -> GameLibrary {
    apply_game_path(settings, &game.display().to_string(), None).unwrap();
    GameLibrary::resolve(settings.get(), libraries).unwrap()
}

#[test]
fn switching_game_folders_shows_each_folders_skins_collections_and_backups() {
    let tmp = TempDir::new("switch");
    let a = tmp.game("War Thunder", &["Winter", "Desert"]);
    let b = tmp.game("War Thunder Test", &["Jungle"]);
    let settings = tmp.settings();
    let libraries = tmp.libraries();

    let lib = switch(&settings, &libraries, &a);
    let index = import_folders(&lib.user_skins, &lib.store, &strings(&["Winter", "Desert"])).unwrap();
    let set = collections::create(&lib.store, "Cold", None).unwrap();
    collections::set_skins(&lib.store, &set.id, &[index[0].id.clone()], &[]).unwrap();
    let deleted = ops::delete(&lib.user_skins, &lib.store, &[index[1].id.clone()], true, SystemTime::now()).unwrap();
    assert_eq!(folders(&lib.store), ["Winter"]);

    // Another game folder: none of the first folder's skins, collections or backups.
    let lib_b = switch(&settings, &libraries, &b);
    assert!(lib_b.user_skins.starts_with(&b));
    assert!(lib_b.store.all().is_empty(), "a new folder starts empty");
    assert!(collections::list(&lib_b.store).collections.is_empty());
    assert!(lib_b.store.snapshot().backups.is_empty());
    import_folders(&lib_b.user_skins, &lib_b.store, &strings(&["Jungle"])).unwrap();
    assert_eq!(folders(&lib_b.store), ["Jungle"]);

    // Back to the first one: everything as it was, Undo of the delete included.
    let lib = switch(&settings, &libraries, &a);
    assert_eq!(folders(&lib.store), ["Winter"]);
    let state = collections::list(&lib.store);
    assert_eq!(state.collections.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Cold"]);
    assert_eq!(state.collections[0].skin_ids, [index[0].id.clone()]);
    let restored = ops::restore(&lib.user_skins, &lib.store, &deleted.backup_ids).unwrap();
    assert_eq!(restored[0].folder, "Desert");
    assert_eq!(folders(&lib.store), ["Winter", "Desert"]);

    // Each folder has its own file, which a new session reads back.
    let (file_a, file_b) = (libraries.index_path(&a), libraries.index_path(&b));
    assert_ne!(file_a, file_b);
    assert_eq!(file_a.parent().unwrap(), tmp.data().join(LIBRARY_DIR));
    let json: serde_json::Value = serde_json::from_slice(&fs::read(&file_b).unwrap()).unwrap();
    assert_eq!(json["gameRoot"], b.display().to_string(), "the file says which folder it belongs to");
    let next_session = tmp.libraries();
    assert_eq!(folders(&next_session.for_root(&a)), ["Winter", "Desert"]);
    assert_eq!(folders(&next_session.for_root(&b)), ["Jungle"]);
    assert!(!tmp.legacy().exists(), "nothing is written to the old single index");
}

#[test]
fn one_store_per_folder_for_the_whole_session() {
    let tmp = TempDir::new("same");
    let a = tmp.game("A", &[]);
    let b = tmp.game("B", &[]);
    let libraries = tmp.libraries();
    assert!(Arc::ptr_eq(&libraries.for_root(&a), &libraries.for_root(&a)));
    assert!(!Arc::ptr_eq(&libraries.for_root(&a), &libraries.for_root(&b)));
    // A trailing separator is the same folder.
    let with_sep = PathBuf::from(format!("{}{}", a.display(), std::path::MAIN_SEPARATOR));
    assert_eq!(libraries.index_path(&with_sep), libraries.index_path(&a));
    assert!(Arc::ptr_eq(&libraries.for_root(&with_sep), &libraries.for_root(&a)));
    if cfg!(windows) {
        let upper = PathBuf::from(a.display().to_string().to_uppercase());
        assert_eq!(libraries.index_path(&upper), libraries.index_path(&a), "case doesn't matter on Windows");
    }
}

#[test]
fn the_file_name_is_a_stable_hash_of_the_folder() {
    let key = root_key(Path::new(r"D:\SteamLibrary\steamapps\common\War Thunder"));
    assert_eq!(key.len(), 16);
    assert!(key.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{key}");
    if cfg!(windows) {
        // FNV-1a of "d:\steamlibrary\steamapps\common\war thunder": pinned so an upgrade of Rust
        // (or of this code) can't silently orphan every index.
        assert_eq!(key, "8511e281b611535f");
        assert_eq!(root_key(Path::new("d:/steamlibrary/steamapps/common/war thunder/")), key);
    }
}

#[test]
fn the_legacy_index_moves_to_the_first_folder_only() {
    let tmp = TempDir::new("migrate");
    let a = tmp.game("War Thunder", &["Winter", "Desert"]);
    let b = tmp.game("Other", &["Jungle"]);
    // An index written by a build from before per-folder indexes.
    let old = LibraryStore::load(tmp.legacy());
    let before = import_folders(&a.join("UserSkins"), &old, &strings(&["Winter", "Desert"])).unwrap();
    collections::create(&old, "Night", None).unwrap();
    let original = fs::read(tmp.legacy()).unwrap();
    drop(old);

    // At launch the saved game folder is asked for first.
    let libraries = tmp.libraries();
    let store = libraries.for_root(&a);
    assert_eq!(store.all(), before, "same ids, same skins");
    assert_eq!(collections::list(&store).collections[0].name, "Night");
    assert!(!tmp.legacy().exists(), "moved, not copied");
    assert_eq!(fs::read(libraries.index_path(&a)).unwrap(), original, "moved as it was");

    // Another folder doesn't inherit it, in this session or the next one.
    assert!(libraries.for_root(&b).all().is_empty());
    assert!(tmp.libraries().for_root(&b).all().is_empty());
    assert_eq!(tmp.libraries().for_root(&a).all(), before);
}

#[test]
fn a_legacy_index_is_ignored_once_a_folder_has_its_own() {
    let tmp = TempDir::new("no-remigrate");
    let a = tmp.game("A", &["Winter"]);
    let b = tmp.game("B", &[]);
    let libraries = tmp.libraries();
    import_folders(&a.join("UserSkins"), &libraries.for_root(&a), &strings(&["Winter"])).unwrap();
    // A library.json shows up again (an older build ran, or the user put it back).
    let stray = LibraryStore::load(tmp.legacy());
    import_folders(&a.join("UserSkins"), &stray, &strings(&["Winter"])).unwrap();

    assert!(tmp.libraries().for_root(&b).all().is_empty(), "never merged into another folder");
    assert!(tmp.legacy().is_file(), "left alone");
}

#[test]
fn without_a_legacy_index_a_folder_starts_empty_and_nothing_is_written() {
    let tmp = TempDir::new("fresh");
    let a = tmp.game("A", &["Winter"]);
    let libraries = tmp.libraries();
    assert!(libraries.for_root(&a).all().is_empty());
    assert!(!libraries.index_path(&a).exists(), "loading never writes");
    assert!(!tmp.legacy().exists());
}

#[test]
fn a_corrupt_folder_index_is_set_aside_and_starts_empty() {
    let tmp = TempDir::new("corrupt");
    let a = tmp.game("A", &["Winter"]);
    let b = tmp.game("B", &["Jungle"]);
    let libraries = tmp.libraries();
    import_folders(&b.join("UserSkins"), &libraries.for_root(&b), &strings(&["Jungle"])).unwrap();
    let path = libraries.index_path(&a);
    fs::write(&path, "{ not json").unwrap();

    let next_session = tmp.libraries();
    let store = next_session.for_root(&a);
    assert!(store.all().is_empty());
    assert_eq!(fs::read_to_string(path.with_extension("json.bad")).unwrap(), "{ not json");
    assert_eq!(folders(&next_session.for_root(&b)), ["Jungle"], "the other folder is untouched");
    // The next change writes a fresh file.
    import_folders(&a.join("UserSkins"), &store, &strings(&["Winter"])).unwrap();
    assert_eq!(folders(&tmp.libraries().for_root(&a)), ["Winter"]);
}

#[test]
fn what_commands_get_without_a_usable_game_folder() {
    let tmp = TempDir::new("none");
    let libraries = tmp.libraries();
    let none = Settings::default();
    assert!(libraries.for_settings(&none).is_none(), "no folder saved: no index");
    let e = GameLibrary::resolve(none, &libraries).err().unwrap();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, NO_GAME_FOLDER));

    // A saved folder that can't be found (an unplugged drive) still has its index, but nothing
    // can work on its skin folders.
    let gone = Settings { game_path: Some(tmp.0.join("Unplugged").display().to_string()), ..Settings::default() };
    assert!(libraries.for_settings(&gone).is_some());
    assert_eq!(GameLibrary::resolve(gone, &libraries).err().unwrap().code, ErrorCode::NotFound);
}

#[test]
fn a_detached_index_is_empty_and_never_saved() {
    let store = LibraryStore::detached();
    assert!(store.all().is_empty());
    assert!(store.game_root().is_none());
    let e = collections::create(&store, "Nowhere", None).unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
    assert!(collections::list(&store).collections.is_empty(), "the change was undone");
}
