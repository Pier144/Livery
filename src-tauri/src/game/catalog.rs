//! The game's vehicle list, read from the user's own War Thunder install (read-only).
//!
//! - `char.vromfs.bin` → `config/wpcost.blk`: one block per unit, with `country`, `rank` and
//!   `unitClass`; `config/unittags.blk`: the `type_*` tags that tell a light tank from a medium
//!   one, or a battleship from a cruiser.
//! - `lang.vromfs.bin` → `lang/units.csv`: the names (`<code>_shop` as in the research tree,
//!   else `<code>_0`), English column.
//!
//! Every vehicle of the game is listed, not only the user's own (that lives on Gaijin's
//! servers). Infantry (`exp_human`) and units without a known nation are left out. The list is
//! kept in `<appData>/vehicles.json` with the size and modification time of both archives, and
//! read again only when the game was updated or another game folder is chosen. It replaces the
//! built-in seed in `library::vehicles` (lookups, hashtag matching) and is sent to the UI by
//! `game_vehicles`.

use super::binblk::{Blk, NameMap};
use super::vromfs::{Vromfs, NAME_MAP_FILE};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::vehicles;
use crate::model::{Nation, Vehicle, VehicleType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

pub const CHAR_ARCHIVE: &str = "char.vromfs.bin";
pub const LANG_ARCHIVE: &str = "lang.vromfs.bin";
pub const WPCOST: &str = "config/wpcost.blk";
pub const UNITTAGS: &str = "config/unittags.blk";
pub const UNITS_CSV: &str = "lang/units.csv";

/// The cache file in the app data dir.
pub const CATALOG_FILE: &str = "vehicles.json";
/// Format version of [`CATALOG_FILE`] (also bumped when the mapping below changes).
pub const CATALOG_VERSION: u32 = 1;

/// `notFound` message when a data file the list comes from is missing.
pub const NO_GAME_DATA: &str = "The game's vehicle data can't be found";

/// The nation of a `country_*` value.
pub fn nation_of(country: &str) -> Option<Nation> {
    Some(match country {
        "country_usa" => Nation::Usa,
        "country_germany" => Nation::Ger,
        "country_ussr" => Nation::Ussr,
        "country_britain" => Nation::Gbr,
        "country_japan" => Nation::Jpn,
        "country_china" => Nation::Chn,
        "country_italy" => Nation::Ita,
        "country_france" => Nation::Fra,
        "country_sweden" => Nation::Swe,
        "country_israel" => Nation::Isr,
        _ => return None,
    })
}

/// Type and class (English, as the Explore Class filter shows them) of a `unitClass`, refined
/// by the unit's `type_*` tags. `None` for what isn't a vehicle (infantry) or isn't known.
pub fn kind_of(unit_class: &str, tags: &[&str]) -> Option<(VehicleType, &'static str)> {
    let has = |tag: &str| tags.contains(&tag);
    Some(match unit_class {
        "exp_fighter" => (VehicleType::Air, "Fighter"),
        "exp_assault" => (VehicleType::Air, "Strike aircraft"),
        "exp_bomber" => (VehicleType::Air, "Bomber"),
        "exp_helicopter" if has("type_attack_helicopter") => (VehicleType::Heli, "Attack helicopter"),
        "exp_helicopter" if has("type_utility_helicopter") => (VehicleType::Heli, "Utility helicopter"),
        "exp_helicopter" => (VehicleType::Heli, "Helicopter"),
        "exp_tank" if has("type_light_tank") => (VehicleType::Ground, "Light tank"),
        "exp_tank" if has("type_medium_tank") => (VehicleType::Ground, "Medium tank"),
        "exp_tank" => (VehicleType::Ground, "Tank"),
        "exp_heavy_tank" => (VehicleType::Ground, "Heavy tank"),
        "exp_tank_destroyer" => (VehicleType::Ground, "Tank destroyer"),
        "exp_SPAA" => (VehicleType::Ground, "SPAA"),
        "exp_destroyer" if has("type_frigate") => (VehicleType::Naval, "Frigate"),
        "exp_destroyer" => (VehicleType::Naval, "Destroyer"),
        "exp_cruiser" if has("type_battleship") => (VehicleType::Naval, "Battleship"),
        "exp_cruiser" if has("type_battlecruiser") => (VehicleType::Naval, "Battlecruiser"),
        "exp_cruiser" if has("type_heavy_cruiser") => (VehicleType::Naval, "Heavy cruiser"),
        "exp_cruiser" if has("type_light_cruiser") => (VehicleType::Naval, "Light cruiser"),
        "exp_cruiser" => (VehicleType::Naval, "Cruiser"),
        "exp_torpedo_boat" => (VehicleType::Naval, "Torpedo boat"),
        "exp_gun_boat" => (VehicleType::Naval, "Gunboat"),
        "exp_torpedo_gun_boat" => (VehicleType::Naval, "Torpedo gunboat"),
        "exp_submarine_chaser" => (VehicleType::Naval, "Submarine chaser"),
        "exp_naval_ferry_barge" => (VehicleType::Naval, "Naval ferry barge"),
        _ => return None,
    })
}

/// What the archives give.
#[derive(Debug, Clone, PartialEq)]
pub struct GameCatalog {
    /// The archive version, e.g. `2.59.0.65`.
    pub version: Option<String>,
    pub vehicles: Vec<Vehicle>,
}

fn data_missing(path: &Path, what: &str) -> AppError {
    AppError::new(ErrorCode::NotFound, NO_GAME_DATA).with_detail(format!("{}: {what}", path.display()))
}

/// Reads the vehicle list of the install at `game_root`. Without `lang.vromfs.bin` (or its
/// `units.csv`), names are the codes.
pub fn read_catalog(game_root: &Path) -> AppResult<GameCatalog> {
    let char_path = game_root.join(CHAR_ARCHIVE);
    let char = Vromfs::open(&char_path)?;
    let nm_file = char.file(NAME_MAP_FILE).ok_or_else(|| data_missing(&char_path, "name map"))?;
    let dict = if NameMap::needs_dictionary(nm_file) {
        char.paths().into_iter().find(|p| p.ends_with(".dict")).and_then(|p| char.file(p))
    } else {
        None
    };
    let names = NameMap::parse(nm_file, dict)?;
    let wpcost = Blk::parse(char.file(WPCOST).ok_or_else(|| data_missing(&char_path, WPCOST))?, Some(&names), dict)?;
    let tags = match char.file(UNITTAGS) {
        Some(file) => Some(Blk::parse(file, Some(&names), dict)?),
        None => None,
    };
    let unit_tags: HashMap<&str, Vec<&str>> = tags
        .as_ref()
        .map(|blk| {
            blk.root()
                .children()
                .filter_map(|unit| {
                    let list = unit.child("tags")?.params().map(|(name, _)| name).filter(|n| n.starts_with("type_"));
                    Some((unit.name()?, list.collect()))
                })
                .collect()
        })
        .unwrap_or_default();
    let unit_names = match Vromfs::open(&game_root.join(LANG_ARCHIVE)) {
        Ok(lang) => lang.file(UNITS_CSV).map(unit_names).unwrap_or_default(),
        Err(e) => {
            tracing::warn!(error = %e, "vehicle names can't be read; codes are shown instead");
            HashMap::new()
        }
    };
    let mut found: Vec<(bool, Vehicle)> = wpcost
        .root()
        .children()
        .filter_map(|unit| {
            let code = unit.name()?;
            let nation = nation_of(unit.param("country")?.as_str()?)?;
            let tags = unit_tags.get(code).map(Vec::as_slice).unwrap_or_default();
            let (vehicle_type, class) = kind_of(unit.param("unitClass")?.as_str()?, tags)?;
            let rank =
                unit.param("rank").and_then(|r| r.as_i64()).and_then(|r| u8::try_from(r).ok()).filter(|r| *r > 0);
            let (name, marked) = match unit_names.get(code) {
                Some(raw) => vehicles::clean_name(raw),
                None => (code.to_owned(), false),
            };
            Some((marked, Vehicle { code: code.to_owned(), name, nation, vehicle_type, class: class.to_owned(), rank }))
        })
        .collect();
    // The variants the game marks (foreign copies, events, killstreaks) after the originals, so
    // an ambiguous hashtag names the original; then shorter codes first.
    found.sort_by(|(am, a), (bm, b)| {
        am.cmp(bm).then(a.code.len().cmp(&b.code.len())).then_with(|| a.code.to_lowercase().cmp(&b.code.to_lowercase()))
    });
    let mut list: Vec<Vehicle> = found.into_iter().map(|(_, v)| v).collect();
    let mut seen = std::collections::HashSet::new();
    list.retain(|v| seen.insert(v.code.to_lowercase()));
    Ok(GameCatalog { version: char.version().map(str::to_owned), vehicles: list })
}

/// `code` → English name, from `units.csv`: `<code>_shop` (research tree), else `<code>_0`.
pub fn unit_names(csv: &[u8]) -> HashMap<String, String> {
    let text = String::from_utf8_lossy(csv);
    let mut rows = CsvRows { rest: text.trim_start_matches('\u{feff}') };
    let Some(header) = rows.next() else { return HashMap::new() };
    let id_col = header.iter().position(|h| h.starts_with("<ID")).unwrap_or(0);
    let Some(en_col) = header.iter().position(|h| h == "<English>") else { return HashMap::new() };
    let mut shop: HashMap<String, String> = HashMap::new();
    let mut full: HashMap<String, String> = HashMap::new();
    for row in rows {
        let (Some(id), Some(name)) = (row.get(id_col), row.get(en_col)) else { continue };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if let Some(code) = id.strip_suffix("_shop") {
            shop.insert(code.to_owned(), name.to_owned());
        } else if let Some(code) = id.strip_suffix("_0") {
            full.insert(code.to_owned(), name.to_owned());
        }
    }
    for (code, name) in full {
        shop.entry(code).or_insert(name);
    }
    shop
}

/// `;`-separated rows with `"`-quoted fields (`""` is a quote; quoted fields may span lines).
struct CsvRows<'a> {
    rest: &'a str,
}

impl Iterator for CsvRows<'_> {
    type Item = Vec<String>;

    fn next(&mut self) -> Option<Vec<String>> {
        if self.rest.is_empty() {
            return None;
        }
        let mut fields = Vec::new();
        let mut field = String::new();
        let mut quoted = false;
        let mut chars = self.rest.char_indices().peekable();
        let mut consumed = self.rest.len();
        while let Some((i, c)) = chars.next() {
            match (quoted, c) {
                (true, '"') if chars.peek().map(|&(_, n)| n) == Some('"') => {
                    field.push('"');
                    chars.next();
                }
                (true, '"') => quoted = false,
                (true, c) => field.push(c),
                (false, '"') => quoted = true,
                (false, ';') => fields.push(std::mem::take(&mut field)),
                (false, '\n') => {
                    consumed = i + 1;
                    break;
                }
                (false, '\r') => {}
                (false, c) => field.push(c),
            }
        }
        fields.push(field);
        self.rest = &self.rest[consumed..];
        Some(fields)
    }
}

// ── Cache and state ─────────────────────────────────────────────────────────

/// Size and modification time of the archives the list was read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub char_size: u64,
    pub char_modified: u64,
    pub lang_size: u64,
    pub lang_modified: u64,
}

impl Stamp {
    pub fn of(game_root: &Path) -> Option<Self> {
        let stat = |name: &str| -> Option<(u64, u64)> {
            let meta = fs::metadata(game_root.join(name)).ok()?;
            let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
            Some((meta.len(), modified))
        };
        let (char_size, char_modified) = stat(CHAR_ARCHIVE)?;
        let (lang_size, lang_modified) = stat(LANG_ARCHIVE).unwrap_or((0, 0));
        Some(Self { char_size, char_modified, lang_size, lang_modified })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    version: u32,
    game_root: String,
    stamp: Stamp,
    #[serde(default)]
    game_version: Option<String>,
    vehicles: Vec<Vehicle>,
}

/// The list in memory: game folder key, the archives' stamp, the vehicles.
type Loaded = (String, Stamp, Arc<Vec<Vehicle>>);

/// The vehicle list of the current game folder: in memory, in [`CATALOG_FILE`], or read from
/// the archives. One reader at a time.
pub struct CatalogStore {
    path: PathBuf,
    current: Mutex<Option<Loaded>>,
    reading: Mutex<()>,
    /// The game folder whose list couldn't be read this session (not tried again).
    failed: Mutex<Option<String>>,
}

impl CatalogStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, current: Mutex::new(None), reading: Mutex::new(()), failed: Mutex::new(None) }
    }

    /// Drops what this session read or failed to read, so the next [`Self::load`] reads again
    /// and installs the list (after Settings → Game → Read the vehicle list was turned back on).
    pub fn forget(&self) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.failed.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// [`Self::vehicles_for`], logging a failure once per game folder and session (the built-in
    /// list stays in use) instead of returning it.
    pub fn load(&self, game_root: &Path) -> Option<Arc<Vec<Vehicle>>> {
        let key = crate::game::root::path_key(game_root);
        if self.failed.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(key.as_str()) {
            return None;
        }
        match self.vehicles_for(game_root) {
            Ok(list) => Some(list),
            Err(e) => {
                tracing::warn!(error = %e, "the game's vehicle list can't be read; using the built-in one");
                *self.failed.lock().unwrap_or_else(|e| e.into_inner()) = Some(key);
                None
            }
        }
    }

    /// The vehicles of the install at `game_root`, and makes them the list `library::vehicles`
    /// looks codes up in. Reads the archives only when they changed since the last read.
    pub fn vehicles_for(&self, game_root: &Path) -> AppResult<Arc<Vec<Vehicle>>> {
        let _one = self.reading.lock().unwrap_or_else(|e| e.into_inner());
        let root_key = crate::game::root::path_key(game_root);
        let stamp = Stamp::of(game_root).ok_or_else(|| data_missing(game_root, CHAR_ARCHIVE))?;
        if let Some((key, known, list)) = self.current.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            if *key == root_key && *known == stamp {
                return Ok(Arc::clone(list));
            }
        }
        let list = match self.read_cache(&root_key, &stamp) {
            Some(list) => list,
            None => {
                let started = std::time::Instant::now();
                let catalog = read_catalog(game_root)?;
                tracing::info!(
                    vehicles = catalog.vehicles.len(),
                    version = ?catalog.version,
                    ms = started.elapsed().as_millis() as u64,
                    "vehicle list read from the game"
                );
                self.write_cache(&root_key, stamp, &catalog);
                catalog.vehicles
            }
        };
        let list = Arc::new(list);
        vehicles::install(&list);
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((root_key, stamp, Arc::clone(&list)));
        Ok(list)
    }

    fn read_cache(&self, root_key: &str, stamp: &Stamp) -> Option<Vec<Vehicle>> {
        let bytes = fs::read(&self.path).ok()?;
        let file: CacheFile = serde_json::from_slice(&bytes).ok()?;
        (file.version == CATALOG_VERSION
            && file.game_root == root_key
            && file.stamp == *stamp
            && !file.vehicles.is_empty())
        .then_some(file.vehicles)
    }

    fn write_cache(&self, root_key: &str, stamp: Stamp, catalog: &GameCatalog) {
        let file = CacheFile {
            version: CATALOG_VERSION,
            game_root: root_key.to_owned(),
            stamp,
            game_version: catalog.version.clone(),
            vehicles: catalog.vehicles.clone(),
        };
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = self.path.parent() {
                fs::create_dir_all(dir)?;
            }
            let tmp = self.path.with_extension("json.tmp");
            fs::write(&tmp, serde_json::to_vec(&file)?)?;
            fs::rename(&tmp, &self.path)
        })();
        if let Err(e) = result {
            tracing::warn!(error = %e, "vehicle list not cached");
        }
    }
}
