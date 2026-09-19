//! Steam side of game detection: a small KeyValues (VDF) parser, library discovery from
//! `libraryfolders.vdf` (current and legacy layouts), `appmanifest_236390.acf` → `installdir`,
//! and the Steam install folders known to the system (registry on Windows).

use super::root::{dedupe_paths, native_path, path_key};
use crate::error::{AppError, ErrorCode};
use std::fmt;
use std::fs;
use std::iter::Peekable;
use std::path::{Path, PathBuf};
use std::str::Chars;

/// War Thunder's Steam app id.
pub const WAR_THUNDER_APP_ID: &str = "236390";
/// `installdir` Steam uses for War Thunder when the manifest does not say otherwise.
pub const DEFAULT_INSTALL_DIR: &str = "War Thunder";

/// Deeper nesting than this is treated as malformed (Steam files use 3–4 levels).
const MAX_DEPTH: usize = 64;

// ── KeyValues tree ──────────────────────────────────────────────────────────

/// A KeyValues node. Blocks keep their entries in file order; keys may repeat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Vdf {
    Value(String),
    Block(Vec<(String, Vdf)>),
}

impl Vdf {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Value(v) => Some(v),
            Vdf::Block(_) => None,
        }
    }

    /// Entries of a block; empty for a plain value.
    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Block(entries) => entries,
            Vdf::Value(_) => &[],
        }
    }

    /// First entry with this key. Steam treats keys case-insensitively ("LibraryFolders").
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        self.entries().iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
    }
}

/// Where and why a VDF file could not be parsed (1-based line and column).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VdfError {
    pub line: usize,
    pub column: usize,
    pub message: &'static str,
}

impl fmt::Display for VdfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at line {}, column {}", self.message, self.line, self.column)
    }
}

impl std::error::Error for VdfError {}

impl From<VdfError> for AppError {
    fn from(e: VdfError) -> Self {
        AppError::new(ErrorCode::Parse, "Could not read a Steam library file").with_detail(e.to_string())
    }
}

/// Parses KeyValues text: quoted or bare tokens, nested `{ }` blocks, `//` comments,
/// `\\` `\"` `\n` `\t` escapes (other backslashes are kept as written) and `[$WIN32]`-style
/// conditionals (ignored). Returns the root block. Malformed input is an error, never a panic.
pub fn parse_vdf(text: &str) -> Result<Vdf, VdfError> {
    let mut lexer = Lexer::new(text.strip_prefix('\u{feff}').unwrap_or(text));
    parse_block(&mut lexer, 0).map(Vdf::Block)
}

enum Token {
    Str(String),
    Open,
    Close,
    Eof,
}

struct Lexer<'a> {
    chars: Peekable<Chars<'a>>,
    line: usize,
    column: usize,
}

impl<'a> Lexer<'a> {
    fn new(text: &'a str) -> Self {
        Self { chars: text.chars().peekable(), line: 1, column: 1 }
    }

    fn peek(&mut self) -> Option<char> {
        self.chars.peek().copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.chars.next()?;
        if c == '\n' {
            self.line += 1;
            self.column = 1;
        } else {
            self.column += 1;
        }
        Some(c)
    }

    fn error(&self, (line, column): (usize, usize), message: &'static str) -> VdfError {
        VdfError { line, column, message }
    }

    fn skip_line(&mut self) {
        while let Some(c) = self.bump() {
            if c == '\n' {
                break;
            }
        }
    }

    /// Next token and the position where it starts.
    fn next(&mut self) -> Result<(Token, (usize, usize)), VdfError> {
        loop {
            while self.peek().is_some_and(char::is_whitespace) {
                self.bump();
            }
            let pos = (self.line, self.column);
            let Some(c) = self.peek() else { return Ok((Token::Eof, pos)) };
            match c {
                '{' | '}' => {
                    self.bump();
                    return Ok((if c == '{' { Token::Open } else { Token::Close }, pos));
                }
                '"' => {
                    self.bump();
                    return self.quoted(pos).map(|s| (Token::Str(s), pos));
                }
                '[' => {
                    // `[$WIN32]` conditional: not needed for Steam's own files, skip it.
                    while let Some(c) = self.bump() {
                        if c == ']' || c == '\n' {
                            break;
                        }
                    }
                }
                '/' => {
                    self.bump();
                    if self.peek() == Some('/') {
                        self.skip_line();
                    } else {
                        return Ok((Token::Str(self.bare(String::from("/"))), pos));
                    }
                }
                _ => return Ok((Token::Str(self.bare(String::new())), pos)),
            }
        }
    }

    fn quoted(&mut self, start: (usize, usize)) -> Result<String, VdfError> {
        let mut out = String::new();
        loop {
            match self.bump() {
                None => return Err(self.error(start, "unterminated string")),
                Some('"') => return Ok(out),
                Some('\\') => match self.bump() {
                    None => return Err(self.error(start, "unterminated string")),
                    Some('\\') => out.push('\\'),
                    Some('"') => out.push('"'),
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                },
                Some(c) => out.push(c),
            }
        }
    }

    /// Unquoted token: runs until whitespace, a quote or a brace.
    fn bare(&mut self, mut out: String) -> String {
        while let Some(c) = self.peek() {
            if c.is_whitespace() || matches!(c, '"' | '{' | '}') {
                break;
            }
            out.push(c);
            self.bump();
        }
        out
    }
}

fn parse_block(lexer: &mut Lexer<'_>, depth: usize) -> Result<Vec<(String, Vdf)>, VdfError> {
    let nested = depth > 0;
    let mut entries = Vec::new();
    loop {
        let (token, pos) = lexer.next()?;
        let key = match token {
            Token::Str(key) => key,
            Token::Close if nested => return Ok(entries),
            Token::Close => return Err(lexer.error(pos, "unexpected '}'")),
            Token::Eof if nested => return Err(lexer.error(pos, "missing '}' before end of file")),
            Token::Eof => return Ok(entries),
            Token::Open => return Err(lexer.error(pos, "expected a key before '{'")),
        };
        let (token, pos) = lexer.next()?;
        let value = match token {
            Token::Str(value) => Vdf::Value(value),
            Token::Open if depth >= MAX_DEPTH => return Err(lexer.error(pos, "blocks nested too deeply")),
            Token::Open => Vdf::Block(parse_block(lexer, depth + 1)?),
            Token::Close | Token::Eof => return Err(lexer.error(pos, "missing value for key")),
        };
        entries.push((key, value));
    }
}

// ── Libraries and manifests ─────────────────────────────────────────────────

/// One Steam library folder (the folder that holds `steamapps/`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SteamLibrary {
    pub path: PathBuf,
    /// App ids Steam lists in this library; `None` when unknown (legacy file format).
    pub apps: Option<Vec<String>>,
}

impl SteamLibrary {
    /// `true` when the app is listed, or when the library does not list its apps.
    pub fn may_contain(&self, app_id: &str) -> bool {
        match &self.apps {
            Some(apps) => apps.iter().any(|a| a == app_id),
            None => true,
        }
    }
}

/// Libraries in a `libraryfolders.vdf`. Supports the current layout
/// (`"0" { "path" "…" "apps" { "236390" "…" } }`) and the legacy one (`"1" "D:\\SteamLibrary"`).
pub fn parse_library_folders(text: &str) -> Result<Vec<SteamLibrary>, VdfError> {
    let root = parse_vdf(text)?;
    let Some(folders) = root.get("libraryfolders") else { return Ok(Vec::new()) };
    let libraries = folders
        .entries()
        .iter()
        // Library entries have numeric keys; this skips `TimeNextStatsReport`, `ContentStatsID`…
        .filter(|(key, _)| !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|(_, value)| {
            let (path, apps) = match value {
                Vdf::Value(path) => (path.as_str(), None),
                Vdf::Block(_) => (
                    value.get("path")?.as_str()?,
                    value.get("apps").map(|apps| apps.entries().iter().map(|(id, _)| id.clone()).collect()),
                ),
            };
            (!path.trim().is_empty()).then(|| SteamLibrary { path: native_path(path), apps })
        })
        .collect();
    Ok(libraries)
}

/// `installdir` from an app manifest (`.acf`). `None` when missing or not a plain folder name.
pub fn parse_install_dir(text: &str) -> Result<Option<String>, VdfError> {
    let root = parse_vdf(text)?;
    let dir = root.get("AppState").and_then(|state| state.get("installdir")).and_then(Vdf::as_str).map(str::trim);
    Ok(dir.filter(|d| !d.is_empty() && *d != "." && *d != ".." && !d.contains(['/', '\\', ':'])).map(str::to_owned))
}

/// Libraries of every Steam install: those listed in `libraryfolders.vdf`, then the install folder
/// itself (always a library, and the only one the legacy format leaves implicit). Deduplicated.
pub fn discover_libraries(steam_roots: &[PathBuf]) -> Vec<SteamLibrary> {
    let mut libraries: Vec<SteamLibrary> = Vec::new();
    for steam_root in steam_roots {
        let files = [
            steam_root.join("steamapps").join("libraryfolders.vdf"),
            steam_root.join("config").join("libraryfolders.vdf"),
        ];
        // The first file that reads and parses wins; a corrupt one falls through to the next.
        let parsed = files.iter().filter_map(|f| fs::read_to_string(f).ok()).find_map(|text| {
            parse_library_folders(&text)
                .inspect_err(|e| tracing::warn!(error = %e, "libraryfolders.vdf could not be parsed"))
                .ok()
        });
        libraries.extend(parsed.unwrap_or_default());
        libraries.push(SteamLibrary { path: steam_root.clone(), apps: None });
    }
    let mut seen = std::collections::HashSet::new();
    libraries.retain(|lib| seen.insert(path_key(&lib.path)));
    libraries
}

/// Folders where Steam may have installed War Thunder, most likely first: libraries with an
/// `appmanifest_236390.acf` (using its `installdir`), then libraries that list the app or do
/// not list their apps (default `War Thunder` folder). The caller validates each candidate.
pub fn war_thunder_candidates(steam_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut with_manifest = Vec::new();
    let mut guessed = Vec::new();
    for library in discover_libraries(steam_roots) {
        let steamapps = library.path.join("steamapps");
        let manifest = steamapps.join(format!("appmanifest_{WAR_THUNDER_APP_ID}.acf"));
        match fs::read_to_string(&manifest) {
            Ok(text) => {
                let dir = parse_install_dir(&text).ok().flatten().unwrap_or_else(|| DEFAULT_INSTALL_DIR.to_owned());
                with_manifest.push(steamapps.join("common").join(dir));
            }
            Err(_) if library.may_contain(WAR_THUNDER_APP_ID) => {
                guessed.push(steamapps.join("common").join(DEFAULT_INSTALL_DIR));
            }
            Err(_) => {}
        }
    }
    with_manifest.extend(guessed);
    dedupe_paths(with_manifest)
}

// ── Steam install folders ───────────────────────────────────────────────────

/// Steam install folders on this machine. Windows: `HKCU\Software\Valve\Steam\SteamPath`,
/// `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath` (+ the 32-bit-OS key), then the default
/// `C:\Program Files (x86)\Steam`. Elsewhere: the usual per-user folders. Only existing ones.
pub fn system_steam_roots() -> Vec<PathBuf> {
    let mut roots = platform_steam_roots();
    roots.retain(|p| p.is_dir());
    dedupe_paths(roots)
}

#[cfg(windows)]
fn platform_steam_roots() -> Vec<PathBuf> {
    use winreg::{HKCU, HKLM};
    let reads = [
        (HKCU, r"Software\Valve\Steam", "SteamPath"),
        (HKLM, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
        (HKLM, r"SOFTWARE\Valve\Steam", "InstallPath"),
    ];
    let mut roots: Vec<PathBuf> = reads
        .iter()
        .filter_map(|(hive, key, value)| hive.open_subkey(key).and_then(|k| k.get_value::<String, _>(value)).ok())
        .filter(|v| !v.trim().is_empty())
        .map(|v| native_path(&v))
        .collect();
    if let Some(pf) = std::env::var_os("ProgramFiles(x86)").filter(|v| !v.is_empty()) {
        roots.push(Path::new(&pf).join("Steam"));
    }
    roots.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    roots
}

#[cfg(not(windows))]
fn platform_steam_roots() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) else { return Vec::new() };
    let home = Path::new(&home);
    vec![
        home.join(".steam").join("steam"),
        home.join(".local").join("share").join("Steam"),
        home.join("Library").join("Application Support").join("Steam"),
    ]
}
