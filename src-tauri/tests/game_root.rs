//! Game-root rules on temp folders: validation, normalising a picked folder, version,
//! existing skins, standalone candidates and path display.

use livery_lib::game::root::{
    count_skins, dedupe_paths, display_path, is_game_root, normalize_root, path_key, read_version,
    standalone_candidates,
};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-root-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn dir(&self, rel: &str) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(&path).unwrap();
        path
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

// ── is_game_root ────────────────────────────────────────────────────────────

#[test]
fn a_root_needs_one_marker() {
    let tmp = TempDir::new("markers");
    assert!(!is_game_root(&tmp.dir("empty")));
    assert!(is_game_root(tmp.dir("skins/UserSkins").parent().unwrap()));
    assert!(is_game_root(tmp.file("launcher/launcher.exe", "").parent().unwrap()));
    assert!(is_game_root(tmp.file("aces/aces.exe", "").parent().unwrap()));
    assert!(!is_game_root(&tmp.path().join("missing")));
    assert!(!is_game_root(&tmp.file("plain.txt", "")), "a file is never a root");
    // A folder called launcher.exe is not the launcher.
    assert!(!is_game_root(tmp.dir("fake/launcher.exe").parent().unwrap()));
}

#[test]
fn a_root_with_only_win64_aces_is_valid() {
    // The real Steam install: aces.exe lives only in win64/ (plus launcher.exe, which we omit here).
    let tmp = TempDir::new("win64");
    let root = tmp.file("War Thunder/win64/aces.exe", "").parent().unwrap().parent().unwrap().to_path_buf();
    assert!(is_game_root(&root));
}

#[test]
fn localappdata_with_only_downloads_is_rejected() {
    let tmp = TempDir::new("localappdata");
    let wt = tmp.dir("WarThunder");
    tmp.dir("WarThunder/downloads");
    tmp.file("WarThunder/downloads/part.tmp", "x");
    assert!(!is_game_root(&wt));
    assert_eq!(normalize_root(&wt), None);
    assert_eq!(normalize_root(&wt.join("downloads")), None);
}

// ── normalize_root ──────────────────────────────────────────────────────────

fn real_like_root(tmp: &TempDir) -> PathBuf {
    tmp.file("War Thunder/launcher.exe", "");
    tmp.file("War Thunder/win64/aces.exe", "");
    tmp.file("War Thunder/content/pkg_main.ver", "2.59.0.13");
    tmp.dir("War Thunder/Screenshots");
    tmp.path().join("War Thunder")
}

#[test]
fn picking_the_root_or_one_of_its_children_selects_the_root() {
    let tmp = TempDir::new("normalize");
    let root = real_like_root(&tmp);
    tmp.dir("War Thunder/UserSkins/my_skin");
    assert_eq!(normalize_root(&root).as_deref(), Some(root.as_path()));
    for child in ["UserSkins", "win64", "content", "Screenshots", "launcher.exe"] {
        assert_eq!(normalize_root(&root.join(child)).as_deref(), Some(root.as_path()), "picked {child}");
    }
    // Deeper than a direct child is not guessed.
    assert_eq!(normalize_root(&root.join("UserSkins").join("my_skin")), None);
    assert_eq!(normalize_root(tmp.path()), None, "the folder above the root is not guessed either");
}

#[test]
fn win64_is_not_taken_for_a_root_even_though_it_holds_aces_exe() {
    let tmp = TempDir::new("win64pick");
    let root = real_like_root(&tmp);
    let win64 = root.join("win64");
    assert!(is_game_root(&win64), "on its own win64/ passes the aces.exe rule");
    assert_eq!(normalize_root(&win64).as_deref(), Some(root.as_path()));
    if cfg!(windows) {
        // Case-insensitive file system: the folder name matches whatever case the user sees.
        assert_eq!(normalize_root(&root.join("WIN64")).as_deref().map(path_key), Some(path_key(&root)));
    }
    assert_eq!(normalize_root(&root.join("does-not-exist")), None);
}

#[test]
fn picked_paths_with_trailing_or_forward_slashes_are_accepted() {
    let tmp = TempDir::new("slashes");
    let root = real_like_root(&tmp);
    let with_slash = PathBuf::from(format!("{}/", root.join("win64").display()));
    assert_eq!(normalize_root(&with_slash).map(|p| path_key(&p)), Some(path_key(&root)));
    if cfg!(windows) {
        let forward = PathBuf::from(root.display().to_string().replace('\\', "/"));
        assert_eq!(normalize_root(&forward).map(|p| display_path(&p)), Some(display_path(&root)));
    }
}

// ── read_version / count_skins ──────────────────────────────────────────────

#[test]
fn reads_version_from_pkg_main_ver() {
    let tmp = TempDir::new("version");
    let root = real_like_root(&tmp);
    assert_eq!(read_version(&root).as_deref(), Some("2.59.0.13"));

    tmp.file("War Thunder/content/pkg_main.ver", "\u{feff} 2.61.1.4 \r\nsecond line\r\n");
    assert_eq!(read_version(&root).as_deref(), Some("2.61.1.4"), "BOM, spaces and CRLF are trimmed");
}

#[test]
fn ignores_versions_that_do_not_look_like_versions() {
    let tmp = TempDir::new("badversion");
    let root = tmp.dir("root");
    assert_eq!(read_version(&root), None, "no file");
    for bad in ["", "hello", "2", "2..1", "v2.59", "2.59.x", "1.2.3.4.5.6.7.8.9.10.11.12.13.14.15.16.17"] {
        tmp.file("root/content/pkg_main.ver", bad);
        assert_eq!(read_version(&root), None, "{bad:?}");
    }
    tmp.file("root/version", "2.49.0.1\n");
    assert_eq!(read_version(&root).as_deref(), Some("2.49.0.1"), "falls back to a root-level version file");
}

#[test]
fn counts_skin_folders_only() {
    let tmp = TempDir::new("count");
    let root = tmp.dir("root");
    assert_eq!(count_skins(&root), 0, "no UserSkins yet");
    tmp.dir("root/UserSkins");
    assert_eq!(count_skins(&root), 0);
    tmp.dir("root/UserSkins/t34_winter");
    tmp.dir("root/UserSkins/template_ussr_t_34_85");
    tmp.file("root/UserSkins/tiger_desert/germ_pzkpfw_vi_ausf_h1_tiger.blk", "");
    tmp.file("root/UserSkins/readme.txt", "not a skin");
    assert_eq!(count_skins(&root), 3);
}

// ── standalone candidates ───────────────────────────────────────────────────

#[test]
fn standalone_candidates_follow_the_environment() {
    let env: HashMap<&str, OsString> = HashMap::from([
        ("LOCALAPPDATA", OsString::from("L")),
        ("ProgramFiles(x86)", OsString::from("X86")),
        ("ProgramFiles", OsString::from("")),
    ]);
    let got = standalone_candidates(|name| env.get(name).cloned());
    let mut want = vec![
        Path::new("L").join("WarThunder"),
        Path::new("X86").join("WarThunder"),
        Path::new("X86").join("Gaijin").join("War Thunder"),
    ];
    if cfg!(windows) {
        want.push(PathBuf::from(r"C:\Games\WarThunder"));
    }
    assert_eq!(got, want, "empty variables are skipped");
}

#[test]
fn standalone_candidates_are_deduplicated() {
    let got = standalone_candidates(|name| match name {
        "ProgramFiles(x86)" | "ProgramFiles" => Some(OsString::from("PF")),
        _ => None,
    });
    let wt = got.iter().filter(|p| p.ends_with("WarThunder") && p.starts_with("PF")).count();
    assert_eq!(wt, 1);
}

// ── path helpers ────────────────────────────────────────────────────────────

#[test]
fn dedupe_keeps_first_occurrence() {
    let a = PathBuf::from("a");
    let b = PathBuf::from("b");
    assert_eq!(dedupe_paths(vec![a.clone(), b.clone(), a.clone()]), vec![a, b]);
}

#[cfg(windows)]
#[test]
fn windows_paths_are_displayed_natively() {
    assert_eq!(display_path(Path::new("c:/program files (x86)/steam/")), r"C:\program files (x86)\steam");
    assert_eq!(
        display_path(Path::new(r"\\?\D:\SteamLibrary\steamapps\common\War Thunder")),
        r"D:\SteamLibrary\steamapps\common\War Thunder"
    );
    assert_eq!(display_path(Path::new(r"C:\")), r"C:\");
    assert_eq!(display_path(Path::new(r"D:\Games\\")), r"D:\Games");
    assert_eq!(path_key(Path::new(r"D:\SteamLibrary")), path_key(Path::new("d:/steamlibrary/")));
}

#[cfg(not(windows))]
#[test]
fn unix_paths_lose_only_trailing_slashes() {
    assert_eq!(display_path(Path::new("/home/u/.steam/steam/")), "/home/u/.steam/steam");
    assert_eq!(display_path(Path::new("/")), "/");
    assert_ne!(path_key(Path::new("/a/B")), path_key(Path::new("/a/b")));
}
