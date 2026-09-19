//! Vehicle lookup by internal code (the skin's `.blk` file stem).
//!
//! The catalog is `src/data/vehicles.json`, the same list the frontend uses, embedded at build
//! time. Codes it doesn't know get a **heuristic** vehicle (name = code, nation from the code
//! prefix, type guessed) until M5 ships the datamined catalog.

use crate::model::{Nation, Vehicle, VehicleType};
use std::collections::HashMap;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../../../src/data/vehicles.json");

/// Folder prefix the game's "create template" button uses: `template_<vehicleCode>`.
pub const TEMPLATE_PREFIX: &str = "template_";

/// English fallback name of a vehicle nothing could be learned about (`code` is empty).
pub const UNKNOWN_NAME: &str = "Unknown vehicle";

/// Code prefixes of ground and naval vehicles. Aircraft codes carry no nation prefix.
const NATION_PREFIXES: [(&str, Nation); 10] = [
    ("germ_", Nation::Ger),
    ("us_", Nation::Usa),
    ("ussr_", Nation::Ussr),
    ("uk_", Nation::Gbr),
    ("jp_", Nation::Jpn),
    ("cn_", Nation::Chn),
    ("it_", Nation::Ita),
    ("fr_", Nation::Fra),
    ("sw_", Nation::Swe),
    ("il_", Nation::Isr),
];

/// Words that mark a prefixed code as a ship or boat rather than a ground vehicle.
const NAVAL_WORDS: [&str; 10] = [
    "destroyer",
    "cruiser",
    "boat",
    "ship",
    "frigate",
    "battleship",
    "submarine",
    "corvette",
    "gunboat",
    "minesweeper",
];

struct Catalog {
    vehicles: Vec<Vehicle>,
    /// Lower-cased code → index in `vehicles`.
    by_code: HashMap<String, usize>,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let vehicles: Vec<Vehicle> = serde_json::from_str(CATALOG_JSON).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "vehicle catalog is invalid; codes resolve heuristically");
            Vec::new()
        });
        let mut by_code = HashMap::with_capacity(vehicles.len());
        for (i, v) in vehicles.iter().enumerate() {
            // The first entry wins when a code repeats.
            by_code.entry(v.code.to_lowercase()).or_insert(i);
        }
        Catalog { vehicles, by_code }
    })
}

/// Every vehicle in the embedded catalog.
pub fn all() -> &'static [Vehicle] {
    &catalog().vehicles
}

/// The catalog entry for `code` (case-insensitive), if any.
pub fn lookup(code: &str) -> Option<Vehicle> {
    let catalog = catalog();
    catalog.by_code.get(&code.trim().to_lowercase()).map(|&i| catalog.vehicles[i].clone())
}

/// The vehicle for a `.blk` stem: the catalog entry, or a heuristic guess (see `guess`).
pub fn resolve(code: &str) -> Vehicle {
    let code = code.trim();
    if code.is_empty() {
        return unknown();
    }
    lookup(code).unwrap_or_else(|| guess(code))
}

/// Heuristic for codes missing from the catalog: name = code, nation from the prefix (`germ_`,
/// `us_`, `ussr_`, …), ground when prefixed (naval when the code names a ship type), else an
/// aircraft of unknown nation. Class stays empty.
pub fn guess(code: &str) -> Vehicle {
    let nation = nation_from_prefix(code);
    let vehicle_type = match nation {
        Some(_) if is_naval(code) => VehicleType::Naval,
        Some(_) => VehicleType::Ground,
        None => VehicleType::Air,
    };
    Vehicle {
        code: code.to_owned(),
        name: code.to_owned(),
        nation: nation.unwrap_or(Nation::Unknown),
        vehicle_type,
        class: String::new(),
        rank: None,
    }
}

/// The vehicle of a skin folder that has no `.blk`, from its name: `template_<code>` gives the
/// code; otherwise the name counts only when it is a catalog code or a nation-prefixed code.
/// Anything else (a free-form name such as "Berlin 1945") is the unknown vehicle.
pub fn from_folder_name(folder: &str) -> Vehicle {
    let (candidate, templated) = match strip_prefix_ci(folder, TEMPLATE_PREFIX) {
        Some(rest) => (rest, true),
        None => (folder, false),
    };
    if !looks_like_code(candidate) {
        return unknown();
    }
    if let Some(vehicle) = lookup(candidate) {
        return vehicle;
    }
    if templated || nation_from_prefix(candidate).is_some() {
        return guess(candidate);
    }
    unknown()
}

/// Nothing is known: empty code, "Unknown vehicle", unknown nation, air.
pub fn unknown() -> Vehicle {
    Vehicle {
        code: String::new(),
        name: UNKNOWN_NAME.to_owned(),
        nation: Nation::Unknown,
        vehicle_type: VehicleType::Air,
        class: String::new(),
        rank: None,
    }
}

pub fn nation_from_prefix(code: &str) -> Option<Nation> {
    NATION_PREFIXES.iter().find(|(prefix, _)| strip_prefix_ci(code, prefix).is_some()).map(|&(_, nation)| nation)
}

fn is_naval(code: &str) -> bool {
    let lower = code.to_lowercase();
    NAVAL_WORDS.iter().any(|word| lower.contains(word))
}

/// Internal codes are one token of letters, digits, `_`, `-` and `.`.
fn looks_like_code(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// `s` without `prefix`, compared ASCII case-insensitively.
pub(crate) fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &s[prefix.len()..])
}
