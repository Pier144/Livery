//! Where a vehicle's model and textures live (formats doc section 4), cached per game version.
//!
//! - `aces.vromfs.bin`: `gamedata/units/tankmodels/<code>.blk`, root param `model` = the
//!   DynModel's name; texture overrides (`set_tex` / `replace_tex` of a `_c` texture outside
//!   `user_skin` and `skin`, e.g. cobra_king's `default_skin`) mark vehicles Atelier can't
//!   paint yet.
//! - `grp_hdr.vromfs.bin` (one per resource root): `<pack>.grpcache.bin` = a `.grp`'s header
//!   (its resource names), `<pack>.dxp.bincache.bin` = a `.dxp.bin`'s directory.
//!
//! Building reads about 3,000 small header copies; the result is kept in memory and as JSON
//! under Livery's data folder, keyed by [`version_of`].

use super::dxp::{base_name, is_hq, DxpDir};
use super::grp::{Grp, DYN_MODEL};
use crate::error::AppResult;
use crate::game::binblk::{Blk, Block, NameMap};
use crate::game::vromfs::{read_header_of, Vromfs, NAME_MAP_FILE};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

/// The archive with the vehicles' tankmodels BLKs.
pub const ACES: &str = "aces.vromfs.bin";
/// Folder of the tankmodels BLKs inside [`ACES`] (compared lowercase).
const TANKMODELS: &str = "gamedata/units/tankmodels/";
/// The resource roots holding a `grp_hdr.vromfs.bin`, in lookup order (the first pack listing a
/// model wins).
pub const RES_ROOTS: [&str; 4] =
    ["content/base/res", "content.hq/hq_tex/res", "content/pkg_infantry/res", "content.hq/pkg_cockpits/res"];
pub const GRP_HDR: &str = "grp_hdr.vromfs.bin";

/// Where one texture lives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TexRef {
    /// The `.dxp.bin` pack, relative to the game root (`/`-separated).
    pub pack: String,
    /// The entry's full name in the pack (`…_body_c$hq*`).
    pub entry: String,
    pub hq: bool,
    pub w: u16,
    pub h: u16,
    pub fourcc: [u8; 4],
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameResIndex {
    /// See [`version_of`].
    pub version: String,
    /// Vehicle code (lowercase) -> model (tankmodels only).
    pub model_of: HashMap<String, String>,
    /// Model -> its `.grp` pack relative to the game root
    /// (`content/base/res/tanks/usa_m4a3e2_sherman_jumbo.grp`).
    pub grp_of: HashMap<String, String>,
    /// Base texture name (lowercase) -> every pack entry holding it (thumbnails left out).
    pub tex_of: HashMap<String, Vec<TexRef>>,
    /// Vehicle codes (lowercase) that put their own `_c` textures on a model.
    pub overrides_of: BTreeSet<String>,
}

impl GameResIndex {
    /// The model of `vehicle` (any case).
    pub fn model(&self, vehicle: &str) -> Option<&str> {
        self.model_of.get(&vehicle.to_lowercase()).map(String::as_str)
    }

    /// Whether `vehicle` (any case) overrides its model's `_c` textures.
    pub fn overrides(&self, vehicle: &str) -> bool {
        self.overrides_of.contains(&vehicle.to_lowercase())
    }

    /// The pack entry texture `name` (base name, any case) is read from: its HQ part when there
    /// is one, else the largest other. Entries without a size (some shared textures list a 0x0
    /// HQ part) don't count.
    pub fn texture(&self, name: &str) -> Option<&TexRef> {
        let refs = self.tex_of.get(&name.to_lowercase())?;
        let sized = || refs.iter().filter(|r| r.w > 0 && r.h > 0);
        sized().find(|r| r.hq).or_else(|| sized().max_by_key(|r| u32::from(r.w) * u32::from(r.h)))
    }
}

/// What the index of `game_root` is keyed by: the game version from [`ACES`]'s header (its
/// size and modification time when it has none), plus the size and modification time of every
/// `grp_hdr.vromfs.bin` (so installing the HQ texture pack rebuilds it too).
pub fn version_of(game_root: &Path) -> AppResult<String> {
    let aces = game_root.join(ACES);
    let mut key = match read_header_of(&aces)?.version {
        Some(v) => format!("aces {v}"),
        None => format!("aces {}", stamp(&aces)),
    };
    for root in RES_ROOTS {
        let path = game_root.join(root).join(GRP_HDR);
        if path.is_file() {
            key.push_str(&format!("; {root} {}", stamp(&path)));
        }
    }
    Ok(key)
}

/// `<size>@<mtime seconds>`, `?` for what the file system won't say.
fn stamp(path: &Path) -> String {
    let Ok(meta) = std::fs::metadata(path) else { return "?".into() };
    let secs = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs());
    format!("{}@{}", meta.len(), secs.map_or("?".into(), |s| s.to_string()))
}

/// Builds the index from the game's archives (read-only).
pub fn build(game_root: &Path) -> AppResult<GameResIndex> {
    let started = Instant::now();
    let mut index = GameResIndex { version: version_of(game_root)?, ..Default::default() };

    let aces = Vromfs::open(&game_root.join(ACES))?;
    // The dictionary whenever there is one: kind-5 BLKs need it even when the name map doesn't.
    let dict = aces.paths().into_iter().find(|p| p.ends_with(".dict")).and_then(|p| aces.file(p));
    let names = match aces.file(NAME_MAP_FILE) {
        Some(nm) => Some(NameMap::parse(nm, if NameMap::needs_dictionary(nm) { dict } else { None })?),
        None => None,
    };
    let mut unreadable = 0;
    for path in aces.paths() {
        let lower = path.to_lowercase();
        let Some(file) = lower.strip_prefix(TANKMODELS) else { continue };
        let Some(code) = file.strip_suffix(".blk").filter(|c| !c.contains('/')) else { continue };
        let Some(bytes) = aces.file(path) else { continue };
        let blk = match Blk::parse(bytes, names.as_ref(), dict) {
            Ok(blk) => blk,
            Err(e) => {
                unreadable += 1;
                tracing::debug!(path, detail = ?e.detail, "tankmodels BLK unreadable");
                continue;
            }
        };
        let root = blk.root();
        if let Some(model) = root.param("model").and_then(|v| v.as_str().map(str::to_owned)) {
            index.model_of.insert(code.to_owned(), model);
        }
        if overrides_c_textures(&root) {
            index.overrides_of.insert(code.to_owned());
        }
    }

    let mut packs = 0;
    for root in RES_ROOTS {
        let path = game_root.join(root).join(GRP_HDR);
        if !path.is_file() {
            continue;
        }
        // The base root is required; an optional pack's damaged archive only loses that pack.
        let archive = match Vromfs::open(&path) {
            Ok(archive) => archive,
            Err(e) if root != RES_ROOTS[0] => {
                tracing::warn!(root, detail = ?e.detail, "resource headers unreadable, skipped");
                continue;
            }
            Err(e) => return Err(e),
        };
        for entry in archive.paths() {
            let Some(bytes) = archive.file(entry) else { continue };
            if let Some(pack) = entry.strip_suffix(".grpcache.bin") {
                let Ok(grp) = Grp::parse(bytes, None) else {
                    tracing::debug!(entry, "pack header unreadable");
                    continue;
                };
                let pack = format!("{root}/{pack}.grp");
                for res in grp.resources.iter().filter(|r| r.class_id == DYN_MODEL) {
                    index.grp_of.entry(res.name.clone()).or_insert_with(|| pack.clone());
                }
                packs += 1;
            } else if let Some(pack) = entry.strip_suffix(".dxp.bincache.bin") {
                let Ok(dir) = DxpDir::parse(bytes) else {
                    tracing::debug!(entry, "texture pack directory unreadable");
                    continue;
                };
                let pack = format!("{root}/{pack}.dxp.bin");
                for e in dir.entries.iter().filter(|e| !e.name.contains("$tq")) {
                    index.tex_of.entry(base_name(&e.name).to_lowercase()).or_default().push(TexRef {
                        pack: pack.clone(),
                        entry: e.name.clone(),
                        hq: is_hq(&e.name),
                        w: e.header.w,
                        h: e.header.h,
                        fourcc: e.header.fourcc,
                    });
                }
                packs += 1;
            }
        }
    }
    tracing::info!(
        ms = started.elapsed().as_millis() as u64,
        vehicles = index.model_of.len(),
        models = index.grp_of.len(),
        textures = index.tex_of.len(),
        overrides = index.overrides_of.len(),
        packs,
        unreadable,
        "game resource index built"
    );
    Ok(index)
}

/// A `set_tex` / `replace_tex` block whose `from` is a `_c` texture: the vehicle draws its own
/// diffuse textures over the model's (cobra_king's
/// `default_skin { set_tex { from = "m4a3e2_sherman_jumbo_body_c*" … } }`). Not inside
/// `user_skin` (the template skin makers start from) or `skin` (alternative skins the player
/// picks instead of a user skin). In the 2026-10 game: 164 vehicles, all in `default_skin`;
/// counting `skin` blocks too would add 17 whose default look is the model's own.
fn overrides_c_textures(block: &Block) -> bool {
    block.children().any(|child| match child.name() {
        Some("user_skin" | "skin") => false,
        Some("set_tex" | "replace_tex") => child
            .param("from")
            .and_then(|v| v.as_str().map(|s| s.trim_end_matches('*').ends_with("_c")))
            .unwrap_or(false),
        _ => overrides_c_textures(&child),
    })
}

/// The index in memory and on disk (`<data>/atelier/gameres-index.json`).
pub struct IndexStore {
    cache: PathBuf,
    current: Mutex<Option<Arc<GameResIndex>>>,
}

impl IndexStore {
    pub fn new(cache: PathBuf) -> Self {
        Self { cache, current: Mutex::new(None) }
    }

    /// The index of `game_root`: the one in memory, else the cached file, else a new build
    /// (written to the cache; a failed write is logged). Each is used only when its version
    /// matches [`version_of`] now. Callers wait for one another during a build.
    pub fn get(&self, game_root: &Path) -> AppResult<Arc<GameResIndex>> {
        let version = version_of(game_root)?;
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(index) = current.as_ref().filter(|i| i.version == version) {
            return Ok(Arc::clone(index));
        }
        let cached = std::fs::read(&self.cache)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<GameResIndex>(&bytes).ok())
            .filter(|i| i.version == version);
        let index = match cached {
            Some(index) => index,
            None => {
                let index = build(game_root)?;
                if let Err(e) = self.save(&index) {
                    tracing::warn!(error = %e, path = %self.cache.display(), "game resource index not cached");
                }
                index
            }
        };
        let index = Arc::new(index);
        *current = Some(Arc::clone(&index));
        Ok(index)
    }

    /// Drops the index held in memory (the cached file stays, keyed by version).
    pub fn forget(&self) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn save(&self, index: &GameResIndex) -> std::io::Result<()> {
        if let Some(dir) = self.cache.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.cache.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(index)?)?;
        std::fs::rename(&tmp, &self.cache)
    }
}
