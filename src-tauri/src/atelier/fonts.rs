//! Installed fonts for Atelier's text layers: the `.ttf`/`.otf` files Windows lists under
//! `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` and the same key under HKCU
//! (per-user installs), re-read on every call. `.ttc` collections are left out: a `FontFace` from
//! their bytes loads face 0 only, which would misname the others. Other systems list none.
//!
//! A font's bytes are only ever served for a `(family, style)` found in a fresh list, never for a
//! path the frontend sends. Layers store `{ family, style }`, which travel between PCs.

use crate::atelier::assets::is_local_absolute;
use crate::error::{AppError, AppResult, ErrorCode};
pub use crate::model::FontInfo;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// `notFound`: no installed `.ttf`/`.otf` font has this family and style (or its file is gone or
/// larger than [`MAX_FONT_BYTES`]).
pub const FONT_NOT_FOUND: &str = "This font isn't installed";

/// Largest font file served.
pub const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;

/// Font file extensions listed (any case).
pub const FONT_EXTENSIONS: [&str; 2] = ["ttf", "otf"];

/// Registry key (under HKLM and HKCU) that lists the installed fonts.
pub const FONTS_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";

/// Words that end a registry font name as its style rather than its family (any case).
const STYLE_WORDS: [&str; 22] = [
    "Regular",
    "Normal",
    "Bold",
    "Italic",
    "Oblique",
    "Light",
    "Semilight",
    "Semibold",
    "Demibold",
    "Medium",
    "Black",
    "Heavy",
    "Thin",
    "ExtraLight",
    "UltraLight",
    "ExtraBold",
    "UltraBold",
    "Hairline",
    "Extra",
    "Ultra",
    "Semi",
    "Demi",
];

/// One installed font: what the UI sees and where its file is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontEntry {
    pub info: FontInfo,
    pub path: PathBuf,
}

/// Family and style of a registry value name such as `Segoe UI Semibold Italic (TrueType)`: the
/// trailing `(…)` goes, then trailing style words ([`STYLE_WORDS`]) make the style (`Regular`
/// when there are none). `None` for an empty name or a collection (`A & B (TrueType)`).
pub fn parse_registry_name(name: &str) -> Option<(String, String)> {
    let mut name = name.trim();
    if let Some(open) = name.strip_suffix(')').and_then(|n| n.rfind('(')) {
        name = name[..open].trim_end();
    }
    if name.is_empty() || name.contains(" & ") {
        return None;
    }
    let words: Vec<&str> = name.split_whitespace().collect();
    let mut split = words.len();
    while split > 1 && STYLE_WORDS.iter().any(|w| w.eq_ignore_ascii_case(words[split - 1])) {
        split -= 1;
    }
    let family = words[..split].join(" ");
    let style = if split == words.len() { "Regular".to_owned() } else { words[split..].join(" ") };
    Some((family, style))
}

/// The file a registry value's data names: a bare file name in `fonts_dir`, or a local absolute
/// path (per-user installs); a `.ttf`/`.otf` that exists. Anything else (relative folders, UNC,
/// other extensions) is `None`.
fn resolve_file(data: &str, fonts_dir: &Path) -> Option<PathBuf> {
    let data = data.trim().trim_end_matches('\0');
    if data.is_empty() {
        return None;
    }
    let given = Path::new(data);
    let path = if is_local_absolute(given) {
        given.to_path_buf()
    } else {
        let mut components = given.components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(_)), None) => fonts_dir.join(given),
            _ => return None,
        }
    };
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    (FONT_EXTENSIONS.contains(&ext.as_str()) && path.is_file()).then_some(path)
}

/// The font list from registry values `(name, data)` in reading order: each one whose name
/// parses ([`parse_registry_name`]) and whose file resolves (bare names against `fonts_dir`).
/// The first entry of a family and style wins; sorted by family, then `Regular` first, then style.
pub fn entries_from(values: impl IntoIterator<Item = (String, String)>, fonts_dir: &Path) -> Vec<FontEntry> {
    let mut seen = HashSet::new();
    let mut entries: Vec<FontEntry> = values
        .into_iter()
        .filter_map(|(name, data)| {
            let (family, style) = parse_registry_name(&name)?;
            let path = resolve_file(&data, fonts_dir)?;
            if !seen.insert((family.to_lowercase(), style.to_lowercase())) {
                return None;
            }
            let file = path.file_name()?.to_string_lossy().into_owned();
            Some(FontEntry { info: FontInfo { family, style, file }, path })
        })
        .collect();
    entries.sort_by(|a, b| {
        let key =
            |e: &FontEntry| (e.info.family.to_lowercase(), e.info.style != "Regular", e.info.style.to_lowercase());
        key(a).cmp(&key(b))
    });
    entries
}

/// The fonts installed on this PC, read now (see the module doc). Empty off Windows.
pub fn system_fonts() -> Vec<FontEntry> {
    platform_fonts()
}

#[cfg(windows)]
fn platform_fonts() -> Vec<FontEntry> {
    use winreg::types::FromRegValue;
    use winreg::{HKCU, HKLM};
    let windows = std::env::var_os("WINDIR")
        .or_else(|| std::env::var_os("SystemRoot"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let values: Vec<(String, String)> = [HKLM, HKCU]
        .iter()
        .filter_map(|hive| hive.open_subkey(FONTS_KEY).ok())
        .flat_map(|key| {
            key.enum_values()
                .filter_map(Result::ok)
                .filter_map(|(name, value)| String::from_reg_value(&value).ok().map(|data| (name, data)))
                .collect::<Vec<_>>()
        })
        .collect();
    entries_from(values, &windows.join("Fonts"))
}

#[cfg(not(windows))]
fn platform_fonts() -> Vec<FontEntry> {
    Vec::new()
}

fn not_found(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::NotFound, FONT_NOT_FOUND).with_detail(detail.into())
}

/// The bytes of the font of `entries` with this family and style (any case): its file
/// canonicalised, at most [`MAX_FONT_BYTES`]. `notFound` ([`FONT_NOT_FOUND`]) otherwise.
pub fn font_bytes(entries: &[FontEntry], family: &str, style: &str) -> AppResult<Vec<u8>> {
    let entry = entries
        .iter()
        .find(|e| e.info.family.eq_ignore_ascii_case(family) && e.info.style.eq_ignore_ascii_case(style))
        .ok_or_else(|| not_found(format!("{family} {style}")))?;
    let path = fs::canonicalize(&entry.path).map_err(|e| not_found(format!("{}: {e}", entry.info.file)))?;
    let meta = fs::metadata(&path).map_err(|e| not_found(format!("{}: {e}", entry.info.file)))?;
    if !meta.is_file() || meta.len() > MAX_FONT_BYTES {
        return Err(not_found(format!("{}: {} bytes", entry.info.file, meta.len())));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    fs::File::open(&path)
        .and_then(|f| f.take(MAX_FONT_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| AppError::new(ErrorCode::Io, FONT_NOT_FOUND).with_detail(format!("{}: {e}", entry.info.file)))?;
    if bytes.len() as u64 > MAX_FONT_BYTES {
        return Err(not_found(format!("{}: more than {MAX_FONT_BYTES} bytes", entry.info.file)));
    }
    Ok(bytes)
}
