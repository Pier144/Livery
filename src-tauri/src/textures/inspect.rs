//! Texture lists for a skin folder: every `.dds` / `.tga` at the top of the folder with its
//! header facts and size warnings, one entry per texture the skin `.blk` references but the
//! folder lacks, and the `.blk` itself. Only reads.
//!
//! Warnings carry an English fallback text (close to the prototype's copy); at most one per
//! file, the most serious first: unreadable header, then not a square power of two (the game
//! may skip it), then heavier than 4096 on a side (slow to load).

use super::header::{self, Header, TextureKind, HEADER_BYTES};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::blk;
use crate::model::{TextureInfo, TextureWarningKind};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

/// Sides above this make a texture heavy to load.
pub const HEAVY_ABOVE: u32 = 4096;
/// Smallest and largest power-of-two side the game is expected to load.
pub const MIN_SIDE: u32 = 128;
pub const MAX_SIDE: u32 = 8192;

/// `format` of the skin's `.blk` entry.
pub const BLK_FORMAT: &str = "BLK";

pub const UNREADABLE_WARNING: &str = "Can't read the texture header.";
pub const NOT_SQUARE_POW2_WARNING: &str = "Not a square power-of-two size (e.g. 2048²); the game may skip it.";
pub const MISSING_WARNING: &str = "Referenced in skin.blk but not in the archive.";

/// Root blocks of a skin `.blk` whose `to` params name the skin's textures (as `library::scan`).
const TEXTURE_BLOCKS: [&str; 2] = ["replace_tex", "set_tex"];

/// Skin `.blk` files are a few hundred bytes; never read more than this (as `library::scan`).
const MAX_BLK_BYTES: u64 = 4 * 1024 * 1024;

/// How deep sub-folders are followed when checking blk references (as `library::scan`).
const MAX_DEPTH: usize = 16;

/// "Very heavy texture (8192²). Load times may suffer." with the real size.
pub fn heavy_warning(width: u32, height: u32) -> String {
    let size = if width == height { format!("{width}²") } else { format!("{width}×{height}") };
    format!("Very heavy texture ({size}). Load times may suffer.")
}

/// The warning a texture of this size gets, if any: a side that isn't a power of two between
/// [`MIN_SIDE`] and [`MAX_SIDE`], or two different sides, first (the game may skip it); then a
/// side above [`HEAVY_ABOVE`].
pub fn size_warning(width: u32, height: u32) -> Option<String> {
    let supported = |side: u32| side.is_power_of_two() && (MIN_SIDE..=MAX_SIDE).contains(&side);
    if width != height || !supported(width) {
        Some(NOT_SQUARE_POW2_WARNING.to_owned())
    } else if width > HEAVY_ABOVE || height > HEAVY_ABOVE {
        Some(heavy_warning(width, height))
    } else {
        None
    }
}

/// One texture file: resolution and format from its header (at most [`HEADER_BYTES`] are read),
/// its length, and the size warning. A header that can't be read (missing file, garbage,
/// truncated, not a `.dds`/`.tga`) gives the unreadable warning instead; this never fails.
pub fn inspect_file(path: &Path) -> TextureInfo {
    let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let size_bytes = fs::metadata(path).ok().filter(fs::Metadata::is_file).map(|m| m.len());
    match read_header(path, &file) {
        Ok(Header { width, height, format }) => {
            let warning = size_warning(width, height);
            let warning_kind = warning.as_deref().map(|w| {
                if w == NOT_SQUARE_POW2_WARNING {
                    TextureWarningKind::NotSquarePow2
                } else {
                    TextureWarningKind::Heavy
                }
            });
            TextureInfo {
                warning,
                warning_kind,
                file,
                width: Some(width),
                height: Some(height),
                format: Some(format),
                size_bytes,
                missing: false,
            }
        }
        Err(reason) => {
            tracing::debug!(file = %file, %reason, "texture header can't be read");
            TextureInfo {
                file,
                width: None,
                height: None,
                format: None,
                size_bytes,
                warning: Some(UNREADABLE_WARNING.to_owned()),
                warning_kind: Some(TextureWarningKind::Unreadable),
                missing: false,
            }
        }
    }
}

/// The header of `path`; the kind comes from the extension of `name` (or the DDS magic).
fn read_header(path: &Path, name: &str) -> Result<Header, String> {
    let mut head = Vec::with_capacity(HEADER_BYTES);
    fs::File::open(path).and_then(|f| f.take(HEADER_BYTES as u64).read_to_end(&mut head)).map_err(|e| e.to_string())?;
    let kind = TextureKind::from_file_name(name)
        .or_else(|| head.starts_with(b"DDS ").then_some(TextureKind::Dds))
        .ok_or_else(|| "not a .dds or .tga file".to_owned())?;
    header::parse(kind, &head).map_err(|e| e.to_string())
}

/// The texture list of a skin folder, given the raw `to` values of its `.blk` (see
/// [`blk_texture_refs`]): the `.dds`/`.tga` files at the top of the folder sorted by name, then
/// the referenced textures missing from the folder (`missing: true`) sorted by name, then the
/// skin's `.blk` (`format: "BLK"`). Reference rules are `library::scan`'s: a trailing `*` is
/// ignored, a name without extension may be a `.dds` or a `.tga` (reported as `.dds`), a path
/// may point into a sub-folder, and matching is case-insensitive.
///
/// Also meant for a staged or extracted folder (install queue). Fails only when the folder
/// itself can't be read.
pub fn inspect_skin_dir<S: AsRef<str>>(dir: &Path, blk_refs: &[S]) -> AppResult<Vec<TextureInfo>> {
    let listing = Listing::read(dir)?;
    Ok(build(dir, &listing, blk_refs))
}

/// [`inspect_skin_dir`] with the references read from the folder's own `.blk` (the
/// alphabetically first top-level `*.blk`, as `library::scan` picks it). An unreadable `.blk`
/// references nothing.
pub fn inspect_skin(dir: &Path) -> AppResult<Vec<TextureInfo>> {
    let listing = Listing::read(dir)?;
    let refs = match listing.blk() {
        Some(name) => read_blk_refs(&dir.join(name)).unwrap_or_else(|reason| {
            tracing::debug!(blk = name, %reason, "skin blk can't be read; no texture references");
            Vec::new()
        }),
        None => Vec::new(),
    };
    Ok(build(dir, &listing, &refs))
}

/// `to` values of the `replace_tex` / `set_tex` root blocks, in file order, as written.
pub fn blk_texture_refs(root: &blk::Block) -> Vec<String> {
    root.blocks
        .iter()
        .filter(|(name, _)| TEXTURE_BLOCKS.contains(&name.as_str()))
        .flat_map(|(_, block)| block.params_named("to"))
        .filter_map(blk::Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Reads and parses a skin `.blk` (capped at 4 MiB) and returns its texture references.
pub fn read_blk_refs(path: &Path) -> Result<Vec<String>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_BLK_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BLK_BYTES {
        return Err("the file is too large for a skin .blk".into());
    }
    let root = blk::parse_bytes(&bytes).map_err(|e| e.to_string())?;
    Ok(blk_texture_refs(&root))
}

fn build<S: AsRef<str>>(dir: &Path, listing: &Listing, blk_refs: &[S]) -> Vec<TextureInfo> {
    let mut textures: Vec<TextureInfo> = listing
        .top_files
        .iter()
        .filter(|name| TextureKind::from_file_name(name).is_some())
        .map(|name| inspect_file(&dir.join(name)))
        .collect();
    sort_by_file(&mut textures);

    let mut missing: Vec<TextureInfo> = missing_references(blk_refs, listing)
        .into_iter()
        .map(|file| TextureInfo {
            file,
            width: None,
            height: None,
            format: None,
            size_bytes: None,
            warning: Some(MISSING_WARNING.to_owned()),
            warning_kind: Some(TextureWarningKind::Missing),
            missing: true,
        })
        .collect();
    sort_by_file(&mut missing);
    textures.append(&mut missing);

    if let Some(name) = listing.blk() {
        textures.push(TextureInfo {
            file: name.to_owned(),
            width: None,
            height: None,
            format: Some(BLK_FORMAT.to_owned()),
            size_bytes: fs::metadata(dir.join(name)).ok().map(|m| m.len()),
            warning: None,
            warning_kind: None,
            missing: false,
        });
    }
    textures
}

/// Case-insensitive by file name, ties broken by the exact spelling.
fn sort_by_file(list: &mut [TextureInfo]) {
    list.sort_by(|a, b| a.file.to_lowercase().cmp(&b.file.to_lowercase()).then_with(|| a.file.cmp(&b.file)));
}

/// Referenced textures the folder lacks, once each (case-insensitive), in reference order.
fn missing_references<S: AsRef<str>>(refs: &[S], listing: &Listing) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    for raw in refs {
        let name = raw.as_ref().trim().trim_end_matches('*').trim().replace('\\', "/");
        let name = name.trim_start_matches("./");
        if name.is_empty() {
            continue;
        }
        let (present, reported) = if has_extension(name) {
            (listing.has(name), name.to_owned())
        } else {
            (listing.has(&format!("{name}.dds")) || listing.has(&format!("{name}.tga")), format!("{name}.dds"))
        };
        if !present && seen.insert(reported.to_lowercase()) {
            missing.push(reported);
        }
    }
    missing
}

/// Whether the last path component ends in a short alphanumeric extension (`.dds`, `.tga`, …).
fn has_extension(name: &str) -> bool {
    let file = name.rsplit('/').next().unwrap_or(name);
    match file.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty() && (1..=5).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// What a skin folder holds.
#[derive(Default)]
struct Listing {
    /// Regular files directly in the folder, as spelled on disk.
    top_files: Vec<String>,
    /// Every file's path relative to the folder, lower-cased, `/`-separated.
    files: HashSet<String>,
}

impl Listing {
    fn read(dir: &Path) -> AppResult<Self> {
        let entries = fs::read_dir(dir).map_err(|e| {
            let code = if e.kind() == io::ErrorKind::NotFound { ErrorCode::NotFound } else { ErrorCode::Io };
            AppError::new(code, "Could not read the skin folder").with_detail(e.to_string())
        })?;
        let mut listing = Self::default();
        listing.add(entries, "", 0);
        Ok(listing)
    }

    fn add(&mut self, entries: fs::ReadDir, prefix: &str, depth: usize) {
        for entry in entries.filter_map(Result::ok) {
            // `file_type` does not follow links, so a junction loop can't trap the walk.
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = format!("{prefix}{name}");
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    if let Ok(children) = fs::read_dir(entry.path()) {
                        self.add(children, &format!("{rel}/"), depth + 1);
                    }
                }
            } else if kind.is_file() {
                self.files.insert(rel.to_lowercase());
                if depth == 0 {
                    self.top_files.push(name);
                }
            }
        }
    }

    fn has(&self, rel: &str) -> bool {
        self.files.contains(&rel.to_lowercase())
    }

    /// The skin's `.blk`: the alphabetically first top-level `*.blk` (case-insensitive).
    fn blk(&self) -> Option<&str> {
        self.top_files
            .iter()
            // ASCII-only: Unicode lower-casing would turn "x.BL\u{212A}" (Kelvin sign) into "x.blk".
            .filter(|name| name.len() > 4 && name.get(name.len() - 4..).is_some_and(|e| e.eq_ignore_ascii_case(".blk")))
            .min_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)))
            .map(String::as_str)
    }
}
