//! Steam side of game detection: KeyValues parser, `libraryfolders.vdf` (both layouts),
//! `appmanifest_236390.acf`, and library → War Thunder candidate discovery on temp dirs.

use livery_lib::game::steam::{
    discover_libraries, parse_install_dir, parse_library_folders, parse_vdf, war_thunder_candidates, Vdf,
    WAR_THUNDER_APP_ID,
};
use livery_lib::{AppError, ErrorCode};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("game").join(name);
    fs::read_to_string(path).unwrap()
}

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-steam-{name}-{}-{n}", std::process::id()));
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

/// A path as it appears inside a quoted VDF string.
fn vdf_escape(path: &Path) -> String {
    path.display().to_string().replace('\\', "\\\\")
}

fn library_block(index: usize, path: &Path, apps: &[&str]) -> String {
    let apps: String = apps.iter().map(|id| format!("\t\t\t\"{id}\"\t\t\"1000\"\n")).collect();
    format!("\t\"{index}\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t\t\"apps\"\n\t\t{{\n{apps}\t\t}}\n\t}}\n", vdf_escape(path))
}

fn manifest(install_dir: &str) -> String {
    format!("\"AppState\"\n{{\n\t\"appid\"\t\t\"236390\"\n\t\"installdir\"\t\t\"{install_dir}\"\n}}\n")
}

// ── KeyValues parser ────────────────────────────────────────────────────────

#[test]
fn parses_current_libraryfolders_fixture() {
    let libs = parse_library_folders(&fixture("libraryfolders.vdf")).unwrap();
    assert_eq!(libs.len(), 2);
    assert_eq!(libs[0].path, PathBuf::from(r"C:\Program Files (x86)\Steam"));
    assert_eq!(libs[0].apps.as_deref(), Some(&["228980".to_string(), "250820".into(), "431960".into()][..]));
    assert!(!libs[0].may_contain(WAR_THUNDER_APP_ID));
    assert_eq!(libs[1].path, PathBuf::from(r"D:\SteamLibrary"));
    assert!(libs[1].may_contain(WAR_THUNDER_APP_ID));
}

#[test]
fn parses_legacy_libraryfolders_fixture() {
    let libs = parse_library_folders(&fixture("libraryfolders_legacy.vdf")).unwrap();
    let paths: Vec<_> = libs.iter().map(|l| l.path.clone()).collect();
    // `TimeNextStatsReport` and `ContentStatsID` are not libraries.
    assert_eq!(paths, vec![PathBuf::from(r"D:\SteamLibrary"), PathBuf::from(r"E:\Games\Steam Library")]);
    assert!(libs.iter().all(|l| l.apps.is_none() && l.may_contain(WAR_THUNDER_APP_ID)));
}

#[test]
fn reads_installdir_from_manifest_fixture() {
    assert_eq!(parse_install_dir(&fixture("appmanifest_236390.acf")).unwrap().as_deref(), Some("War Thunder"));
}

#[test]
fn rejects_missing_or_unsafe_installdir() {
    assert_eq!(parse_install_dir("\"AppState\" { \"appid\" \"236390\" }").unwrap(), None);
    assert_eq!(parse_install_dir("\"AppState\" { \"installdir\" \"\" }").unwrap(), None);
    assert_eq!(parse_install_dir("\"AppState\" { \"installdir\" \"..\" }").unwrap(), None);
    assert_eq!(parse_install_dir("\"AppState\" { \"installdir\" \"..\\\\..\\\\Windows\" }").unwrap(), None);
    assert_eq!(parse_install_dir("\"AppState\" { \"installdir\" \"C:/x\" }").unwrap(), None);
    assert_eq!(parse_install_dir("\"appstate\" { \"InstallDir\" \"WT\" }").unwrap().as_deref(), Some("WT"));
}

#[test]
fn tolerates_comments_escapes_bare_tokens_and_conditionals() {
    let root = parse_vdf(&fixture("tricky.vdf")).unwrap();
    let r = root.get("root").expect("keys are case-insensitive");
    let s = |key: &str| r.get(key).and_then(Vdf::as_str).map(str::to_owned);
    assert_eq!(s("quoted").as_deref(), Some("has \"quotes\" and a \\ backslash"));
    assert_eq!(s("bare_key").as_deref(), Some("bare_value"));
    assert_eq!(s("path").as_deref(), Some(r"D:\Games\Unescaped"), "unknown escapes are kept as written");
    assert_eq!(s("escapes").as_deref(), Some("tab\there\nnewline"));
    assert_eq!(s("platform").as_deref(), Some("win"), "the [$WIN32] conditional is ignored");
    assert_eq!(s("empty").as_deref(), Some(""));
    assert_eq!(s("dup").as_deref(), Some("first"), "get returns the first of repeated keys");
    assert_eq!(s("url").as_deref(), Some("http://example.com/a//b"), "`//` inside a bare token is not a comment");
    let deeper = r.get("Nested").and_then(|n| n.get("deep")).and_then(|d| d.get("deeper")).and_then(Vdf::as_str);
    assert_eq!(deeper, Some("yes"));
    assert_eq!(r.entries().iter().filter(|(k, _)| k == "dup").count(), 2);
}

#[test]
fn strips_bom_and_accepts_empty_input() {
    let root = parse_vdf("\u{feff}\"a\" \"b\"").unwrap();
    assert_eq!(root.get("a").and_then(Vdf::as_str), Some("b"));
    assert_eq!(parse_vdf("").unwrap(), Vdf::Block(Vec::new()));
    assert_eq!(parse_vdf("  // only a comment\n").unwrap(), Vdf::Block(Vec::new()));
    assert!(parse_library_folders("").unwrap().is_empty());
    assert!(parse_library_folders("\"somethingElse\" { \"0\" \"C:\\\\x\" }").unwrap().is_empty());
}

#[test]
fn malformed_input_is_an_error_not_a_panic() {
    let deep = "\"a\" {".repeat(1000);
    let cases = [
        "\"a\" {",
        "\"a\" { \"b\" \"c\"",
        "\"a\" \"b\" }",
        "\"unterminated",
        "\"a\" \"unterminated\\",
        "\"key\"",
        "\"a\" { \"b\" }",
        "{ \"a\" \"b\" }",
        "\"a\" }",
        deep.as_str(),
    ];
    for text in cases {
        assert!(parse_vdf(text).is_err(), "should fail: {text:.40}");
        assert!(parse_library_folders(text).is_err());
    }
}

#[test]
fn reports_error_position() {
    let err = parse_vdf("\"root\"\n{\n  \"k\" \"v\"\n  \"orphan\"\n}").unwrap_err();
    assert_eq!((err.line, err.column), (5, 1));
    assert_eq!(err.message, "missing value for key");
    let app: AppError = err.into();
    assert_eq!(app.code, ErrorCode::Parse);
    assert_eq!(app.detail.as_deref(), Some("missing value for key at line 5, column 1"));

    let err = parse_vdf("\"a\"\n  \"open").unwrap_err();
    assert_eq!((err.line, err.column, err.message), (2, 3, "unterminated string"));
}

// ── Library discovery ───────────────────────────────────────────────────────

#[test]
fn candidates_prefer_manifests_then_listed_apps() {
    let tmp = TempDir::new("current");
    let steam = tmp.path().join("Steam");
    let listed = tmp.path().join("Listed");
    let manifested = tmp.path().join("Manifested");
    let other = tmp.path().join("Other");
    let vdf = format!(
        "\"libraryfolders\"\n{{\n{}{}{}{}}}\n",
        library_block(0, &steam, &["228980"]),
        library_block(1, &listed, &[WAR_THUNDER_APP_ID, "730"]),
        library_block(2, &manifested, &[]),
        library_block(3, &other, &["730"]),
    );
    tmp.file("Steam/steamapps/libraryfolders.vdf", &vdf);
    tmp.file("Manifested/steamapps/appmanifest_236390.acf", &manifest("WT Custom"));

    let candidates = war_thunder_candidates(std::slice::from_ref(&steam));
    assert_eq!(
        candidates,
        vec![
            manifested.join("steamapps").join("common").join("WT Custom"),
            listed.join("steamapps").join("common").join("War Thunder"),
        ]
    );
}

#[test]
fn legacy_libraries_and_the_steam_folder_are_guessed() {
    let tmp = TempDir::new("legacy");
    let steam = tmp.path().join("Steam");
    let lib = tmp.path().join("Library");
    tmp.file(
        "Steam/steamapps/libraryfolders.vdf",
        &format!("\"LibraryFolders\"\n{{\n\t\"ContentStatsID\"\t\t\"-1\"\n\t\"1\"\t\t\"{}\"\n}}\n", vdf_escape(&lib)),
    );
    let libs = discover_libraries(std::slice::from_ref(&steam));
    assert_eq!(libs.iter().map(|l| l.path.clone()).collect::<Vec<_>>(), vec![lib.clone(), steam.clone()]);

    let common = |p: &Path| p.join("steamapps").join("common").join("War Thunder");
    assert_eq!(war_thunder_candidates(std::slice::from_ref(&steam)), vec![common(&lib), common(&steam)]);
}

#[test]
fn manifest_without_installdir_uses_the_default_folder() {
    let tmp = TempDir::new("noinstalldir");
    let steam = tmp.path().join("Steam");
    tmp.file("Steam/steamapps/appmanifest_236390.acf", "\"AppState\" { \"appid\" \"236390\" }");
    assert_eq!(
        war_thunder_candidates(std::slice::from_ref(&steam)),
        vec![steam.join("steamapps").join("common").join("War Thunder")]
    );
}

#[test]
fn reads_config_libraryfolders_when_steamapps_has_none() {
    let tmp = TempDir::new("config");
    let steam = tmp.path().join("Steam");
    let lib = tmp.path().join("Lib");
    tmp.file(
        "Steam/config/libraryfolders.vdf",
        &format!("\"libraryfolders\"\n{{\n{}}}\n", library_block(1, &lib, &[])),
    );
    let libs = discover_libraries(&[steam]);
    assert_eq!(libs[0].path, lib);
    assert_eq!(libs[0].apps.as_deref(), Some(&[][..]));
}

#[test]
fn missing_or_corrupt_vdf_still_checks_the_steam_folder() {
    let tmp = TempDir::new("corrupt");
    let missing = tmp.path().join("NoVdf");
    let corrupt = tmp.path().join("Corrupt");
    tmp.file("Corrupt/steamapps/libraryfolders.vdf", "\"libraryfolders\" { \"0\" {");
    let libs = discover_libraries(&[missing.clone(), corrupt.clone()]);
    assert_eq!(libs.iter().map(|l| l.path.clone()).collect::<Vec<_>>(), vec![missing, corrupt]);
    assert!(libs.iter().all(|l| l.apps.is_none()));
}

#[test]
fn libraries_are_deduplicated() {
    let tmp = TempDir::new("dedupe");
    let steam = tmp.path().join("Steam");
    tmp.file(
        "Steam/steamapps/libraryfolders.vdf",
        &format!("\"libraryfolders\"\n{{\n{}}}\n", library_block(0, &steam, &[WAR_THUNDER_APP_ID])),
    );
    let libs = discover_libraries(&[steam.clone(), steam.clone()]);
    assert_eq!(libs.len(), 1, "listed once in the vdf, passed twice as a root");
    assert!(libs[0].apps.is_some(), "the vdf entry (with its apps) wins over the implicit root entry");
    assert_eq!(war_thunder_candidates(&[steam.clone(), steam]).len(), 1);
}

#[cfg(windows)]
#[test]
fn library_paths_are_deduplicated_case_insensitively_on_windows() {
    let tmp = TempDir::new("case");
    let steam = tmp.path().join("Steam");
    let upper = PathBuf::from(steam.display().to_string().to_uppercase());
    tmp.file(
        "Steam/steamapps/libraryfolders.vdf",
        &format!("\"libraryfolders\"\n{{\n{}}}\n", library_block(0, &upper, &[WAR_THUNDER_APP_ID])),
    );
    assert_eq!(discover_libraries(&[steam]).len(), 1);
}

#[cfg(windows)]
#[test]
fn registry_style_forward_slash_paths_become_native() {
    let libs =
        parse_library_folders("\"libraryfolders\" { \"0\" { \"path\" \"c:/program files (x86)/steam/\" } }").unwrap();
    assert_eq!(libs[0].path, PathBuf::from(r"C:\program files (x86)\steam"));
}
