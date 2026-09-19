//! What a War Thunder root looks like on disk: validation, normalising a folder the user picked,
//! version, existing skins, standalone-launcher locations, and path helpers shared by detection.

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Folder (inside the game root) the game loads user skins from.
pub const USER_SKINS: &str = "UserSkins";

/// Sub-folders of a root a user is likely to pick by mistake; picking one selects its parent.
/// `win64`/`win32` matter most: they hold `aces.exe`, so on their own they would pass validation.
const ROOT_SUBFOLDERS: [&str; 5] = [USER_SKINS, "win64", "win32", "content", "content.hq"];

pub fn user_skins_dir(root: &Path) -> PathBuf {
    root.join(USER_SKINS)
}

/// A game root is a folder with `UserSkins/`, `launcher.exe`, `aces.exe` or `win64/aces.exe`.
pub fn is_game_root(path: &Path) -> bool {
    path.is_dir()
        && (path.join(USER_SKINS).is_dir()
            || path.join("launcher.exe").is_file()
            || path.join("aces.exe").is_file()
            || path.join("win64").join("aces.exe").is_file())
}

/// The game root for a folder the user picked: the folder itself, or its parent when the pick is
/// `UserSkins/`, `win64/`, `content/` (…) or any other direct child of a valid root.
pub fn normalize_root(picked: &Path) -> Option<PathBuf> {
    let picked = native_path(&picked.to_string_lossy());
    if !picked.exists() {
        return None;
    }
    let parent = picked.parent().filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf);
    let is_subfolder = picked
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| ROOT_SUBFOLDERS.iter().any(|s| s.eq_ignore_ascii_case(n)));
    if is_subfolder && parent.as_deref().is_some_and(is_game_root) {
        return parent;
    }
    if is_game_root(&picked) {
        return Some(picked);
    }
    parent.filter(|p| is_game_root(p))
}

/// Game version from the first line of `content/pkg_main.ver` (e.g. "2.59.0.13"), falling back
/// to a root-level `version` file. `None` unless it looks like a dotted version.
pub fn read_version(root: &Path) -> Option<String> {
    [root.join("content").join("pkg_main.ver"), root.join("version")]
        .iter()
        .find_map(|file| first_line(file).filter(|line| looks_like_version(line)))
}

fn first_line(file: &Path) -> Option<String> {
    let mut text = String::new();
    // The file is one short line; never read more than a few KB of whatever sits there.
    fs::File::open(file).ok()?.take(4096).read_to_string(&mut text).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    Some(text.lines().next()?.trim().to_owned())
}

fn looks_like_version(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    s.len() <= 32 && parts.len() >= 2 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Skin folders in `UserSkins` (0 when the folder is missing). Hidden (`.`-prefixed) folders are
/// skipped, like the library scan does, so First run and the hangar agree on the count.
pub fn count_skins(root: &Path) -> u32 {
    let Ok(entries) = fs::read_dir(user_skins_dir(root)) else { return 0 };
    let count = entries
        .filter_map(Result::ok)
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.') && e.path().is_dir())
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// Where the standalone launcher installs the game. `env` looks up environment variables
/// (injected so tests do not depend on the machine). The caller validates each candidate.
pub fn standalone_candidates(env: impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let under = |var: &str, parts: &[&str]| {
        env(var).filter(|v| !v.is_empty()).map(|base| parts.iter().fold(PathBuf::from(base), |p, part| p.join(part)))
    };
    let mut out: Vec<PathBuf> = [
        under("LOCALAPPDATA", &["WarThunder"]),
        under("ProgramFiles(x86)", &["WarThunder"]),
        under("ProgramFiles", &["WarThunder"]),
        under("ProgramFiles(x86)", &["Gaijin", "War Thunder"]),
    ]
    .into_iter()
    .flatten()
    .collect();
    if cfg!(windows) {
        out.push(PathBuf::from(r"C:\Games\WarThunder"));
    }
    dedupe_paths(out)
}

// ── Path helpers ────────────────────────────────────────────────────────────

/// A path as shown to the user and stored in settings: OS-native separators, no trailing
/// separator, no `\\?\` / `\\?\UNC\` prefix, upper-case drive letter.
pub fn display_path(path: &Path) -> String {
    let mut s = path.to_string_lossy().into_owned();
    let windows = cfg!(windows);
    if windows {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            s = format!(r"\\{rest}");
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            if rest.as_bytes().get(1) == Some(&b':') {
                s = rest.to_owned();
            }
        }
        s = s.replace('/', "\\");
        if s.as_bytes().get(1) == Some(&b':') {
            if let Some(drive) = s.get_mut(..1) {
                drive.make_ascii_uppercase();
            }
        }
    }
    let sep = if windows { '\\' } else { '/' };
    // Keep the separator of a bare root ("/", "C:\").
    let min_len = if windows && s.as_bytes().get(1) == Some(&b':') { 3 } else { 1 };
    while s.len() > min_len && s.ends_with(sep) {
        s.pop();
    }
    s
}

/// A path typed, stored or read from Steam (`c:/program files (x86)/steam`) in native form.
pub fn native_path(raw: &str) -> PathBuf {
    PathBuf::from(display_path(Path::new(raw.trim())))
}

/// Comparison key: native form, case-insensitive on Windows.
pub fn path_key(path: &Path) -> String {
    let s = display_path(path);
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// Drops later duplicates (by `path_key`), keeping order.
pub fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths.into_iter().filter(|p| seen.insert(path_key(p))).collect()
}
