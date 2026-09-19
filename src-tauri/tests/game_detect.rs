//! `detect` event order and source priority with fake inputs, and the `set_game_path` core
//! (`apply_game_path`) on temp folders. `detects_real_install` is a manual, read-only check.

use livery_lib::game::root::{display_path, native_path};
use livery_lib::game::{apply_game_path, detect, prepare_game_root, DetectInputs, NOT_A_GAME_FOLDER};
use livery_lib::model::{DetectEvent, DetectState, GameDetection, GameSource};
use livery_lib::settings::SettingsStore;
use livery_lib::ErrorCode;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-detect-{name}-{}-{n}", std::process::id()));
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
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A game root at `rel` with launcher, version and `skins` skin folders.
fn game_root(tmp: &TempDir, rel: &str, version: &str, skins: usize) -> PathBuf {
    tmp.file(&format!("{rel}/launcher.exe"), "");
    tmp.file(&format!("{rel}/content/pkg_main.ver"), version);
    for i in 0..skins {
        tmp.file(&format!("{rel}/UserSkins/skin_{i}/ussr_t_34_85.blk"), "");
    }
    tmp.path().join(rel)
}

/// A Steam folder whose `libraryfolders.vdf` lists `library`, where War Thunder has a manifest.
fn steam_with_war_thunder(tmp: &TempDir, library: &Path) -> PathBuf {
    let escaped = library.display().to_string().replace('\\', "\\\\");
    tmp.file(
        "Steam/steamapps/libraryfolders.vdf",
        &format!("\"libraryfolders\"\n{{\n\t\"1\"\n\t{{\n\t\t\"path\"\t\t\"{escaped}\"\n\t\t\"apps\"\n\t\t{{\n\t\t\t\"236390\"\t\t\"1\"\n\t\t}}\n\t}}\n}}\n"),
    );
    let rel = library.strip_prefix(tmp.path()).unwrap().to_string_lossy().replace('\\', "/");
    tmp.file(&format!("{rel}/steamapps/appmanifest_236390.acf"), "\"AppState\" { \"installdir\" \"War Thunder\" }");
    tmp.path().join("Steam")
}

fn run(inputs: &DetectInputs) -> (Vec<DetectEvent>, GameDetection) {
    let mut events = Vec::new();
    let result = detect(inputs, |e| events.push(e));
    (events, result)
}

fn ev(source: GameSource, state: DetectState) -> DetectEvent {
    DetectEvent { source, state }
}

// ── detect ──────────────────────────────────────────────────────────────────

#[test]
fn steam_install_is_found_and_rows_are_reported_in_order() {
    let tmp = TempDir::new("steam");
    let library = tmp.path().join("SteamLibrary");
    let root = game_root(&tmp, "SteamLibrary/steamapps/common/War Thunder", "2.59.0.13", 2);
    let steam = steam_with_war_thunder(&tmp, &library);
    // Like %LOCALAPPDATA%\WarThunder on a Steam machine: only the launcher's downloads folder.
    tmp.file("LocalAppData/WarThunder/downloads/x.tmp", "");
    let inputs = DetectInputs {
        steam_roots: vec![steam],
        standalone: vec![tmp.path().join("LocalAppData").join("WarThunder"), tmp.path().join("missing")],
        custom: None,
    };

    let (events, result) = run(&inputs);
    use DetectState::*;
    use GameSource::*;
    assert_eq!(
        events,
        vec![
            ev(Steam, Checking),
            ev(Steam, Found),
            ev(Standalone, Checking),
            ev(Standalone, NotFound),
            ev(Custom, Skipped),
        ]
    );
    assert_eq!(
        result,
        GameDetection {
            found: true,
            source: Some(Steam),
            path: Some(display_path(&root)),
            version: Some("2.59.0.13".into()),
            existing_skins: 2,
        }
    );
}

#[test]
fn steam_wins_over_standalone_and_custom() {
    let tmp = TempDir::new("priority");
    let library = tmp.path().join("Lib");
    game_root(&tmp, "Lib/steamapps/common/War Thunder", "2.59.0.13", 1);
    let standalone = game_root(&tmp, "Standalone", "2.58.0.1", 0);
    let custom = game_root(&tmp, "Custom", "2.57.0.1", 5);
    let inputs = DetectInputs {
        steam_roots: vec![steam_with_war_thunder(&tmp, &library)],
        standalone: vec![standalone.clone()],
        custom: Some(custom.clone()),
    };
    let (events, result) = run(&inputs);
    assert_eq!(result.source, Some(GameSource::Steam));
    assert_eq!(result.version.as_deref(), Some("2.59.0.13"));
    assert_eq!(events.iter().filter(|e| e.state == DetectState::Found).count(), 3, "every source is still checked");

    let (_, result) = run(&DetectInputs { steam_roots: vec![], ..inputs.clone() });
    assert_eq!(result.source, Some(GameSource::Standalone));
    assert_eq!(result.path, Some(display_path(&standalone)));
    assert_eq!(result.existing_skins, 0);

    let (_, result) = run(&DetectInputs { steam_roots: vec![], standalone: vec![], ..inputs });
    assert_eq!(result.source, Some(GameSource::Custom));
    assert_eq!(result.path, Some(display_path(&custom)));
    assert_eq!(result.existing_skins, 5);
}

#[test]
fn saved_custom_path_is_normalised() {
    let tmp = TempDir::new("custom");
    let root = game_root(&tmp, "Games/WT", "2.59.0.13", 1);
    let inputs = DetectInputs { custom: Some(root.join("UserSkins")), ..Default::default() };
    let (events, result) = run(&inputs);
    assert_eq!(events.last(), Some(&ev(GameSource::Custom, DetectState::Found)));
    assert_eq!(result.path, Some(display_path(&root)));
}

#[test]
fn nothing_found_reports_every_row() {
    let tmp = TempDir::new("none");
    let inputs = DetectInputs {
        steam_roots: vec![tmp.path().join("NoSteam")],
        standalone: vec![tmp.path().join("NoStandalone")],
        custom: Some(tmp.path().join("Gone")),
    };
    let (events, result) = run(&inputs);
    use DetectState::*;
    use GameSource::*;
    assert_eq!(
        events,
        vec![
            ev(Steam, Checking),
            ev(Steam, NotFound),
            ev(Standalone, Checking),
            ev(Standalone, NotFound),
            ev(Custom, Checking),
            ev(Custom, NotFound),
        ]
    );
    assert_eq!(result, GameDetection::not_found());
}

#[test]
fn from_system_ignores_a_blank_saved_path() {
    assert_eq!(DetectInputs::from_system(Some("   ")).custom, None);
    assert_eq!(DetectInputs::from_system(None).custom, None);
    assert_eq!(DetectInputs::from_system(Some(" D:/Games/WT/ ")).custom, Some(native_path("D:/Games/WT")));
}

// ── set_game_path core ──────────────────────────────────────────────────────

#[test]
fn setting_a_folder_creates_user_skins_and_persists_it() {
    let tmp = TempDir::new("set");
    tmp.file("WT/win64/aces.exe", "");
    tmp.file("WT/content/pkg_main.ver", "2.59.0.13\n");
    let root = tmp.path().join("WT");
    let store = SettingsStore::load(tmp.path().join("appdata").join("settings.json"));

    // The user picked the win64 folder by mistake: the root is used instead.
    let picked = root.join("win64").display().to_string();
    let result = apply_game_path(&store, &picked, None).unwrap();
    assert!(root.join("UserSkins").is_dir(), "UserSkins is created");
    assert!(!root.join("win64").join("UserSkins").exists());
    assert_eq!(
        result,
        GameDetection {
            found: true,
            source: Some(GameSource::Custom),
            path: Some(display_path(&root)),
            version: Some("2.59.0.13".into()),
            existing_skins: 0,
        }
    );

    let saved = store.get();
    assert_eq!(saved.game_path, result.path);
    assert_eq!(saved.game_source, Some(GameSource::Custom));
    assert_eq!(saved.game_version.as_deref(), Some("2.59.0.13"));
    let reloaded = SettingsStore::load(tmp.path().join("appdata").join("settings.json")).get();
    assert_eq!(reloaded, saved, "written to disk");
}

#[test]
fn setting_a_detected_folder_keeps_its_source_and_existing_skins() {
    let tmp = TempDir::new("setsteam");
    let root = game_root(&tmp, "WT", "2.59.0.13", 3);
    let store = SettingsStore::load(tmp.path().join("settings.json"));
    let quoted = format!("  \"{}\"  ", root.display());
    let result = apply_game_path(&store, &quoted, Some(GameSource::Steam)).unwrap();
    assert_eq!(result.source, Some(GameSource::Steam));
    assert_eq!(result.existing_skins, 3);
    assert_eq!(store.get().game_source, Some(GameSource::Steam));
}

#[test]
fn an_invalid_folder_is_rejected_without_writing() {
    let tmp = TempDir::new("invalid");
    tmp.file("LocalAppData/WarThunder/downloads/x.tmp", "");
    let not_a_game = tmp.path().join("LocalAppData").join("WarThunder");
    let store = SettingsStore::load(tmp.path().join("settings.json"));

    for path in [not_a_game.display().to_string(), tmp.path().join("missing").display().to_string(), String::new()] {
        let err = apply_game_path(&store, &path, None).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert_eq!(err.message, NOT_A_GAME_FOLDER);
        assert_eq!(err.message, "That folder doesn't look like a War Thunder install");
        assert_eq!(err.detail.as_deref(), Some(path.as_str()));
    }
    assert!(!not_a_game.join("UserSkins").exists(), "nothing is created in a rejected folder");
    assert!(!tmp.path().join("settings.json").exists(), "settings are untouched");
    assert_eq!(store.get().game_path, None);
}

#[test]
fn a_file_named_user_skins_is_an_io_error() {
    let tmp = TempDir::new("blocked");
    tmp.file("WT/launcher.exe", "");
    tmp.file("WT/UserSkins", "not a folder");
    let err = prepare_game_root(&tmp.path().join("WT").display().to_string()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(err.message, "Could not create the UserSkins folder");
}

// ── Manual check on this machine ────────────────────────────────────────────

/// `cargo test --test game_detect -- --ignored --nocapture`. Reads only: registry, Steam files,
/// the game folder. Never writes.
#[test]
#[ignore = "reads the real machine; run manually"]
fn detects_real_install() {
    let inputs = DetectInputs::from_system(None);
    println!("inputs: {inputs:#?}");
    println!("steam candidates: {:#?}", livery_lib::game::steam::war_thunder_candidates(&inputs.steam_roots));
    let (events, result) = run(&inputs);
    for e in &events {
        println!("event: {e:?}");
    }
    println!("result: {result:#?}");
}
