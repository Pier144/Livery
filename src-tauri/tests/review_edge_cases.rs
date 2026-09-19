//! Edge cases found in review: hostile file names and inputs for the game and library parsers.

use livery_lib::game::root::{display_path, normalize_root};
use livery_lib::game::steam::{parse_install_dir, parse_library_folders, parse_vdf};
use livery_lib::library::{blk, scan};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

fn temp(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("livery-review-{name}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn blk_extension_is_matched_ascii_case_insensitively() {
    let dir = temp("kelvin");
    let skin = dir.join("Kelvin");
    fs::create_dir_all(&skin).unwrap();
    // U+212A KELVIN SIGN lower-cases to ASCII 'k': "x.BL\u{212A}" lower-cases to "x.blk".
    fs::write(skin.join("ussr_t_34.BL\u{212A}"), "replace_tex{ from:t=\"a*\"; to:t=\"b*\" }").unwrap();
    fs::write(skin.join("b.dds"), "x").unwrap();
    let found = scan::scan_skin(&skin).expect("a skin folder");
    assert_eq!(found.attention.len(), 1, "not a .blk, so the folder has none: {:?}", found.attention);
    assert_eq!(found.attention[0].kind, livery_lib::model::AttentionKind::NoBlk);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn vdf_hostile_inputs_error_without_panicking() {
    let deep = "\"a\" {".repeat(200_000);
    assert!(parse_vdf(&deep).is_err());
    assert!(parse_vdf("\"a\" \"unterminated").is_err());
    assert!(parse_vdf("\"a\" \"b\\").is_err());
    assert!(parse_vdf("}").is_err());
    assert!(parse_vdf("{").is_err());
    assert!(parse_vdf("\"a\"").is_err());
    assert!(parse_vdf("[$WIN32").is_ok());
    assert!(parse_vdf(
        "\u{feff}\"libraryfolders\"\r\n{\r\n\t\"0\"\r\n\t{\r\n\t\t\"path\"\t\t\"D:\\SteamLibrary\"\r\n\t}\r\n}\r\n"
    )
    .is_ok());
    assert_eq!(parse_install_dir("\"AppState\" { \"installdir\" \"..\\..\\Windows\" }").unwrap(), None);
    assert!(parse_library_folders("\"libraryfolders\" { \"0\" { \"apps\" { } } }").unwrap().is_empty());

    let huge = format!("\"k\" \"{}\"", "x".repeat(8 * 1024 * 1024));
    let t = Instant::now();
    assert!(parse_vdf(&huge).is_ok());
    let bare = "x".repeat(8 * 1024 * 1024);
    assert!(parse_vdf(&bare).is_err());
    let comments = "//\n".repeat(1_000_000);
    assert!(parse_vdf(&comments).is_ok());
    assert!(t.elapsed().as_secs() < 20, "linear time");
}

#[test]
fn blk_hostile_inputs_error_without_panicking() {
    let cases: Vec<String> = vec![
        "a:t=\"x".into(),
        "a:t='x\n'".into(),
        "a:t=\"~".into(),
        "a:t=\"~\u{e9}\"".into(),
        "a:t=\"\"\"never".into(),
        "/* never".into(),
        "a{".into(),
        "}".into(),
        "a:".into(),
        "a:t".into(),
        "a:t=".into(),
        ":t=\"x\"".into(),
        "include".into(),
        "include \"".into(),
        "@override:".into(),
        "@override:{}".into(),
        "a:i=99999999999999999999999999999999999999999".into(),
        "a:i=-0x".into(),
        "a:c=1,2".into(),
        "a:c=256,0,0".into(),
        "a:r=inf".into(),
        "a:p2=1,2,3".into(),
        "\u{feff}a:t=\"x\"\r\nb{\r\nc:i=1\r\n}\r\n".into(),
        "\u{e9}\u{e9}:t=\"\u{e9}\"; \u{4e2d}{ }".into(),
        "a = \u{e9}}".into(),
    ];
    for case in &cases {
        let _ = blk::parse(case);
        let _ = blk::parse_bytes(case.as_bytes());
    }
    let deep = "a{".repeat(1_000_000);
    assert!(blk::parse(&deep).is_err());

    let t = Instant::now();
    let huge = format!("a:t=\"{}\"", "x".repeat(8 * 1024 * 1024));
    assert!(blk::parse(&huge).is_ok());
    let bare = format!("a={}", "y".repeat(8 * 1024 * 1024));
    assert!(blk::parse(&bare).is_ok());
    let many = "a:i=1;".repeat(500_000);
    assert_eq!(blk::parse(&many).unwrap().params.len(), 500_000);
    let comment = format!("/*{}", "*".repeat(8 * 1024 * 1024));
    assert!(blk::parse(&comment).is_err());
    assert!(t.elapsed().as_secs() < 20, "linear time");
}

#[cfg(windows)]
#[test]
fn verbatim_unc_paths_display_as_plain_unc() {
    assert_eq!(display_path(std::path::Path::new(r"\\?\UNC\nas\games\War Thunder\")), r"\\nas\games\War Thunder");
    assert_eq!(display_path(std::path::Path::new(r"\\nas\games\")), r"\\nas\games");
    assert_eq!(display_path(std::path::Path::new(r"\\?\d:\Games\WT\")), r"D:\Games\WT");
    assert_eq!(display_path(std::path::Path::new("c:/program files (x86)/steam/")), r"C:\program files (x86)\steam");
}

#[test]
fn picked_nested_skin_folder_is_not_guessed() {
    let dir = temp("nested");
    fs::create_dir_all(dir.join("UserSkins").join("My Skin")).unwrap();
    fs::write(dir.join("launcher.exe"), "").unwrap();
    assert_eq!(normalize_root(&dir.join("UserSkins").join("My Skin")), None);
    assert_eq!(normalize_root(&dir.join("UserSkins")).map(|p| display_path(&p)), Some(display_path(&dir)));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn corrupt_steamapps_vdf_falls_back_to_config_vdf() {
    use livery_lib::game::steam::war_thunder_candidates;
    let dir = temp("vdf-fallback");
    let steam = dir.join("Steam");
    let library = dir.join("Lib");
    fs::create_dir_all(steam.join("steamapps")).unwrap();
    fs::create_dir_all(steam.join("config")).unwrap();
    fs::create_dir_all(library.join("steamapps")).unwrap();
    fs::write(steam.join("steamapps").join("libraryfolders.vdf"), "\"libraryfolders\" { \"0\" {").unwrap();
    let escaped = library.to_string_lossy().replace('\\', "\\\\");
    fs::write(steam.join("config").join("libraryfolders.vdf"), format!("\"LibraryFolders\" {{ \"1\" \"{escaped}\" }}"))
        .unwrap();
    fs::write(library.join("steamapps").join("appmanifest_236390.acf"), "\"AppState\" { \"installdir\" \"WT\" }")
        .unwrap();
    let candidates = war_thunder_candidates(&[steam]);
    assert_eq!(
        candidates.first().map(|p| display_path(p)),
        Some(display_path(&library.join("steamapps").join("common").join("WT")))
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn count_skins_skips_hidden_folders_like_the_scan() {
    use livery_lib::game::root::count_skins;
    let dir = temp("count");
    fs::create_dir_all(dir.join("UserSkins").join("A")).unwrap();
    fs::create_dir_all(dir.join("UserSkins").join(".trash")).unwrap();
    fs::write(dir.join("UserSkins").join("loose.txt"), "").unwrap();
    assert_eq!(count_skins(&dir), 1);
    fs::remove_dir_all(dir).ok();
}
