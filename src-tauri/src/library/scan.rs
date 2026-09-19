//! Reads skin folders in `UserSkins` into `HangarSkin`s, with the attention rules:
//! no `.blk`, unreadable `.blk` or an unknown root block in it, textures it references that are
//! missing, and the partial-extract marker Livery leaves when an install is interrupted.
//!
//! Only reads. Each sub-directory is one skin; files at the top of `UserSkins` and hidden
//! (`.`-prefixed) folders are ignored.

use super::blk;
use super::time;
use super::vehicles::{self, TEMPLATE_PREFIX};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{Attention, AttentionKind, HangarSkin, Origin, Vehicle};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;

/// Marker file Livery writes into a skin folder while extracting and removes when done.
pub const PARTIAL_MARKER: &str = ".livery-partial";

/// Id prefix of a skin found on disk but not in the index yet.
pub const DISK_ID_PREFIX: &str = "disk:";

/// Id prefix of a skin found in Livery's inactive folder but not in the index
/// (`/` can't be part of a folder name, so these never collide with `disk:<folder>`).
pub const INACTIVE_ID_PREFIX: &str = "disk:inactive/";

/// Root blocks the game understands in a skin `.blk`.
const KNOWN_ROOT_BLOCKS: [&str; 2] = ["replace_tex", "set_tex"];

/// Skin `.blk` files are a few hundred bytes; never read more than this.
const MAX_BLK_BYTES: u64 = 4 * 1024 * 1024;

/// How deep sub-folders are followed for the size and texture lookups.
const MAX_DEPTH: usize = 16;

/// Every skin folder in `user_skins`, sorted by folder name (case-insensitive). A missing
/// `UserSkins` folder has no skins.
pub fn scan_dir(user_skins: &Path) -> AppResult<Vec<HangarSkin>> {
    let entries = match fs::read_dir(user_skins) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(AppError::new(ErrorCode::Io, "Could not read the UserSkins folder").with_detail(e.to_string()))
        }
    };
    let mut skins: Vec<HangarSkin> = entries.filter_map(Result::ok).filter_map(|e| scan_skin(&e.path())).collect();
    skins.sort_by(|a, b| a.folder.to_lowercase().cmp(&b.folder.to_lowercase()).then_with(|| a.folder.cmp(&b.folder)));
    Ok(skins)
}

/// Every skin folder in Livery's inactive folder (`UserSkins/.livery/inactive`), like
/// `scan_dir` but marked inactive.
pub fn scan_inactive_dir(inactive: &Path) -> AppResult<Vec<HangarSkin>> {
    Ok(scan_dir(inactive)?.into_iter().map(mark_inactive).collect())
}

/// A scanned skin that sits in the inactive folder: `active: false`, `disk:inactive/<folder>` id.
pub fn mark_inactive(skin: HangarSkin) -> HangarSkin {
    HangarSkin { id: format!("{INACTIVE_ID_PREFIX}{}", skin.folder), active: false, ..skin }
}

/// One skin folder, or `None` when `dir` is not one (missing, not a directory, hidden name).
/// The id is `disk:<folder>` until the index assigns one.
pub fn scan_skin(dir: &Path) -> Option<HangarSkin> {
    let folder = dir.file_name()?.to_string_lossy().into_owned();
    if folder.starts_with('.') || !dir.is_dir() {
        return None;
    }
    let contents = Contents::read(dir);
    let (vehicle, attention) = inspect(dir, &folder, &contents);
    let modified = fs::metadata(dir).and_then(|m| m.modified()).unwrap_or_else(|_| SystemTime::now());
    let origin =
        if vehicles::strip_prefix_ci(&folder, TEMPLATE_PREFIX).is_some() { Origin::Mine } else { Origin::Imported };
    Some(HangarSkin {
        id: format!("{DISK_ID_PREFIX}{folder}"),
        name: folder.clone(),
        folder,
        vehicle,
        origin,
        author: None,
        size_bytes: contents.size,
        // A folder in UserSkins is active; `mark_inactive` flips skins found in the inactive folder.
        active: true,
        installed_at: time::rfc3339_utc(modified),
        source_id: None,
        attention,
        temporary: false,
    })
}

/// What a skin folder holds.
#[derive(Default)]
struct Contents {
    /// File names directly in the folder, as on disk.
    top_files: Vec<String>,
    /// Every file's path relative to the folder, lower-cased, `/`-separated.
    files: HashSet<String>,
    /// Total size of every file, recursively.
    size: u64,
}

impl Contents {
    fn read(dir: &Path) -> Self {
        let mut contents = Self::default();
        contents.walk(dir, "", 0);
        contents
    }

    fn walk(&mut self, dir: &Path, prefix: &str, depth: usize) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.filter_map(Result::ok) {
            // `file_type` does not follow links, so a junction loop can't trap the walk.
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = format!("{prefix}{name}");
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    self.walk(&entry.path(), &format!("{rel}/"), depth + 1);
                }
            } else if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    self.size = self.size.saturating_add(meta.len());
                    self.files.insert(rel.to_lowercase());
                    if depth == 0 {
                        self.top_files.push(name);
                    }
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

/// The vehicle and the attention list of a folder.
fn inspect(dir: &Path, folder: &str, contents: &Contents) -> (Vehicle, Vec<Attention>) {
    let mut attention = Vec::new();
    if contents.has(PARTIAL_MARKER) {
        attention.push(Attention {
            kind: AttentionKind::PartialExtract,
            message: "archive was only partially extracted".into(),
            file: None,
        });
    }
    let Some(blk_name) = contents.blk() else {
        attention.push(Attention {
            kind: AttentionKind::NoBlk,
            message: "no .blk file, so the game can't use it".into(),
            file: None,
        });
        return (vehicles::from_folder_name(folder), attention);
    };

    // The file name is the vehicle's internal code.
    let vehicle = vehicles::resolve(&blk_name[..blk_name.len() - 4]);
    match read_blk(&dir.join(blk_name)) {
        Err(reason) => {
            tracing::debug!(folder, blk = blk_name, %reason, "skin blk can't be read");
            attention.push(Attention {
                kind: AttentionKind::UnreadableBlk,
                message: format!("{blk_name} can't be read ({reason})"),
                file: Some(blk_name.to_owned()),
            });
        }
        Ok(root) => {
            let unknown: Vec<&str> = root
                .blocks
                .iter()
                .map(|(name, _)| name.as_str())
                .filter(|name| !KNOWN_ROOT_BLOCKS.contains(name))
                .collect();
            if !unknown.is_empty() {
                tracing::debug!(folder, blk = blk_name, ?unknown, "unknown blk blocks");
                attention.push(Attention {
                    kind: AttentionKind::UnknownBlkBlock,
                    message: format!("{blk_name} has an unknown block"),
                    file: Some(blk_name.to_owned()),
                });
            }
            for file in missing_textures(&root, contents) {
                attention.push(Attention {
                    kind: AttentionKind::MissingTexture,
                    message: format!("{file} is missing"),
                    file: Some(file),
                });
            }
        }
    }
    (vehicle, attention)
}

fn read_blk(path: &Path) -> Result<blk::Block, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_BLK_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BLK_BYTES {
        return Err("the file is too large for a skin .blk".into());
    }
    blk::parse_bytes(&bytes).map_err(|e| e.to_string())
}

/// Textures the `to` params of `replace_tex` / `set_tex` point at that are not in the folder,
/// once each, in blk order. A trailing `*` is ignored; a name without extension may be a
/// `.dds` or a `.tga` and is reported as `.dds`. Matching is case-insensitive.
fn missing_textures(root: &blk::Block, contents: &Contents) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    for target in texture_targets(root) {
        let name = target.trim().trim_end_matches('*').trim().replace('\\', "/");
        let name = name.trim_start_matches("./");
        if name.is_empty() || !seen.insert(name.to_lowercase()) {
            continue;
        }
        let present = if has_extension(name) {
            contents.has(name)
        } else {
            contents.has(&format!("{name}.dds")) || contents.has(&format!("{name}.tga"))
        };
        if !present {
            missing.push(if has_extension(name) { name.to_owned() } else { format!("{name}.dds") });
        }
    }
    missing
}

/// `to` values of the `replace_tex` / `set_tex` root blocks, in file order.
fn texture_targets(root: &blk::Block) -> impl Iterator<Item = &str> {
    root.blocks
        .iter()
        .filter(|(name, _)| KNOWN_ROOT_BLOCKS.contains(&name.as_str()))
        .flat_map(|(_, block)| block.params_named("to"))
        .filter_map(blk::Value::as_str)
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
