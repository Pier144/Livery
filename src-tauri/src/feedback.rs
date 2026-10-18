//! Feedback (Settings → About → Send feedback): the technical details the user may attach to a
//! pre-filled GitHub issue or discussion. Nothing is sent from here: the UI shows the details and
//! opens the page in the browser, where the user submits it (or not).
//!
//! The log tail is anonymised before it leaves the backend: the user's profile folder, the game
//! folder, the app data folder and the Windows user name become placeholders, and any other
//! absolute path keeps only its last part.

use crate::blocking;
use crate::error::AppResult;
use crate::logging::{LOG_DIR, LOG_FILE};
use crate::model::FeedbackDiagnostics;
use crate::settings::SettingsStore;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Log lines offered at most (the UI drops older ones to fit a GitHub link).
pub const LOG_LINES: usize = 40;
/// A longer line is cut (a stack of paths or a payload in a debug line).
const MAX_LINE_CHARS: usize = 300;

/// Where the app data lives (managed at launch), for the log file and the anonymisation.
pub struct DataDir(pub PathBuf);

/// Placeholders for the folders that say who the user is.
#[derive(Debug, Default, Clone)]
pub struct Anonymizer {
    /// `(text to find, placeholder)`, longest first so a game folder inside the profile wins.
    roots: Vec<(String, &'static str)>,
    user_name: Option<String>,
}

impl Anonymizer {
    pub fn new(profile: Option<&Path>, game: Option<&Path>, data: Option<&Path>, user_name: Option<&str>) -> Self {
        let mut roots: Vec<(String, &'static str)> = [(data, "<data>"), (game, "<game>"), (profile, "%USERPROFILE%")]
            .into_iter()
            .filter_map(|(path, label)| {
                let text = path?.to_string_lossy().trim_end_matches(['\\', '/']).to_owned();
                (text.len() > 3).then_some((text, label))
            })
            .collect();
        roots.sort_by_key(|r| std::cmp::Reverse(r.0.len()));
        let user_name = user_name.map(str::trim).filter(|n| n.chars().count() >= 3).map(str::to_owned);
        Self { roots, user_name }
    }

    /// From this machine: `%USERPROFILE%`, `%USERNAME%` (`$HOME`, `$USER` elsewhere), the saved
    /// game folder and the data dir.
    pub fn from_system(game: Option<&Path>, data: Option<&Path>) -> Self {
        let (home, user) = if cfg!(windows) { ("USERPROFILE", "USERNAME") } else { ("HOME", "USER") };
        let profile = std::env::var_os(home).map(PathBuf::from);
        let user = std::env::var(user).ok();
        Self::new(profile.as_deref(), game, data, user.as_deref())
    }

    pub fn line(&self, line: &str) -> String {
        let mut out = line.to_owned();
        for (root, label) in &self.roots {
            out = replace_ci(&out, root, label);
            // The same folder written with forward slashes (some crates log paths that way).
            out = replace_ci(&out, &root.replace('\\', "/"), label);
        }
        out = other_paths(&out);
        if let Some(name) = &self.user_name {
            out = replace_word_ci(&out, name, "<user>");
        }
        if out.chars().count() > MAX_LINE_CHARS {
            out = out.chars().take(MAX_LINE_CHARS).collect::<String>() + "…";
        }
        out
    }
}

/// Every case-insensitive occurrence of `needle` replaced (Windows paths ignore case).
fn replace_ci(haystack: &str, needle: &str, with: &str) -> String {
    if needle.is_empty() {
        return haystack.to_owned();
    }
    let lower = haystack.to_lowercase();
    let find = needle.to_lowercase();
    // Lower-casing can change byte lengths outside ASCII; then only exact matches are replaced.
    if lower.len() != haystack.len() || find.len() != needle.len() {
        return haystack.replace(needle, with);
    }
    let mut out = String::with_capacity(haystack.len());
    let mut last = 0;
    for (i, _) in lower.match_indices(&find) {
        if i < last {
            continue;
        }
        out.push_str(&haystack[last..i]);
        out.push_str(with);
        last = i + needle.len();
    }
    out.push_str(&haystack[last..]);
    out
}

/// `needle` as a whole word (not inside a longer name), any case.
fn replace_word_ci(haystack: &str, needle: &str, with: &str) -> String {
    let lower = haystack.to_lowercase();
    let find = needle.to_lowercase();
    if lower.len() != haystack.len() || find.len() != needle.len() {
        return haystack.to_owned();
    }
    // `_` is a boundary: skin folders are `<code>_<author>`.
    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    let mut out = String::with_capacity(haystack.len());
    let mut last = 0;
    for (i, _) in lower.match_indices(&find) {
        let before = haystack[..i].chars().next_back();
        let after = haystack[i + needle.len()..].chars().next();
        if i < last || word(before) || word(after) {
            continue;
        }
        out.push_str(&haystack[last..i]);
        out.push_str(with);
        last = i + needle.len();
    }
    out.push_str(&haystack[last..]);
    out
}

/// Absolute paths left after the known folders (`D:\Some\Where\file.zip`, `\\server\share\x`)
/// keep only their last part: `<path>\file.zip`.
fn other_paths(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let drive = i + 2 < chars.len()
            && chars[i].is_ascii_alphabetic()
            && chars[i + 1] == ':'
            && matches!(chars[i + 2], '\\' | '/')
            && (i == 0 || !chars[i - 1].is_alphanumeric());
        let unc = i + 2 < chars.len()
            && chars[i] == '\\'
            && chars[i + 1] == '\\'
            && chars[i + 2].is_alphanumeric()
            && (i == 0 || chars[i - 1].is_whitespace() || matches!(chars[i - 1], '"' | '\'' | '(' | '='));
        if !(drive || unc) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // The path runs to the next quote, whitespace or bracket.
        let end = (i..chars.len())
            .find(|&j| matches!(chars[j], '"' | '\'' | ')' | ',' | ';') || chars[j].is_whitespace())
            .unwrap_or(chars.len());
        let path: String = chars[i..end].iter().collect();
        let last = path.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or_default();
        out.push_str("<path>");
        if !last.is_empty() && !last.ends_with(':') {
            out.push('\\');
            out.push_str(last);
        }
        i = end;
    }
    out
}

/// The last `n` lines of the log (the previous session's file first when the current one is short),
/// anonymised. Empty when there is no log.
pub fn log_tail(log_dir: &Path, n: usize, anonymizer: &Anonymizer) -> Vec<String> {
    let read =
        |name: &str| fs::read(log_dir.join(name)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let current = read(LOG_FILE);
    let mut lines: Vec<&str> = current.lines().filter(|l| !l.trim().is_empty()).collect();
    let older;
    if lines.len() < n {
        older = read(crate::logging::OLD_LOG_FILE);
        let mut previous: Vec<&str> = older.lines().filter(|l| !l.trim().is_empty()).collect();
        previous.extend(lines);
        lines = previous;
    }
    let start = lines.len().saturating_sub(n);
    lines[start..].iter().map(|l| anonymizer.line(l)).collect()
}

/// "Windows 11 24H2 (build 26100.2894)", from the registry; the OS name elsewhere.
pub fn os_description() -> String {
    #[cfg(windows)]
    {
        if let Some(text) = windows_version() {
            return text;
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(name) = std::fs::read_to_string("/etc/os-release").ok().as_deref().and_then(os_release_name) {
            return format!("Linux {name} ({})", std::env::consts::ARCH);
        }
    }
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

/// `PRETTY_NAME` of an `os-release` file ("Ubuntu 24.04.4 LTS"), unquoted; `None` when missing.
pub fn os_release_name(text: &str) -> Option<String> {
    let value = text.lines().find_map(|l| l.trim().strip_prefix("PRETTY_NAME="))?.trim();
    let value = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(value).trim();
    // One short line: the file is the distribution's, but nothing long reaches a report.
    (!value.is_empty()).then(|| value.chars().take(80).collect())
}

#[cfg(windows)]
fn windows_version() -> Option<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").ok()?;
    let build: String = key.get_value("CurrentBuildNumber").ok()?;
    let ubr: Option<u32> = key.get_value("UBR").ok();
    let display: Option<String> = key.get_value("DisplayVersion").ok();
    // ProductName still says "Windows 10" on Windows 11: the build number tells them apart.
    let major = if build.parse::<u32>().unwrap_or(0) >= 22000 { "11" } else { "10" };
    let build = match ubr {
        Some(ubr) => format!("{build}.{ubr}"),
        None => build,
    };
    Some(match display {
        Some(d) if !d.is_empty() => format!("Windows {major} {d} (build {build})"),
        _ => format!("Windows {major} (build {build})"),
    })
}

/// Version, Windows and the anonymised log tail, for the user to look at and maybe attach.
#[tauri::command]
pub async fn feedback_diagnostics(app: AppHandle) -> AppResult<FeedbackDiagnostics> {
    blocking(move || {
        let settings = app.state::<SettingsStore>().get();
        let data = app.try_state::<DataDir>().map(|d| d.0.clone());
        let game = settings.game_path.as_deref().map(PathBuf::from);
        let anonymizer = Anonymizer::from_system(game.as_deref(), data.as_deref());
        let log_tail = data.map(|d| log_tail(&d.join(LOG_DIR), LOG_LINES, &anonymizer)).unwrap_or_default();
        Ok(FeedbackDiagnostics { app_version: app.package_info().version.to_string(), os: os_description(), log_tail })
    })
    .await
}
