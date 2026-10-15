//! Vehicle lookup by internal code (the skin's `.blk` file stem).
//!
//! The catalog starts as `src/data/vehicles.json` (a small seed the frontend shares, embedded at
//! build time) and is replaced by the game's own list once `game::catalog` has read it from the
//! install ([`install`]). Codes it doesn't know get a **heuristic** vehicle (name = code, nation
//! from the code prefix, type guessed).

use crate::model::{Nation, Vehicle, VehicleType};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

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
    vehicles: Arc<Vec<Vehicle>>,
    /// Lower-cased code → index in `vehicles`.
    by_code: HashMap<String, usize>,
    /// [`squash`]ed code, code without its nation prefix, and name → the vehicles they name,
    /// best first (for WT Live hashtags): a whole code before a code without its prefix before
    /// a name, then catalog order (the game list puts foreign and event variants last).
    by_tag: HashMap<String, Vec<usize>>,
    /// [`squash`]ed name → the vehicles it names (for post titles), catalog order.
    by_name: HashMap<String, Vec<usize>>,
}

impl Catalog {
    fn new(vehicles: Arc<Vec<Vehicle>>) -> Self {
        let mut by_code = HashMap::with_capacity(vehicles.len());
        let mut ranked: HashMap<String, Vec<(u8, usize)>> = HashMap::with_capacity(vehicles.len() * 3);
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::with_capacity(vehicles.len());
        for (i, v) in vehicles.iter().enumerate() {
            // The first entry wins when a code repeats.
            by_code.entry(v.code.to_lowercase()).or_insert(i);
            for (origin, key) in keys_of(v) {
                let list = ranked.entry(key).or_default();
                if !list.iter().any(|&(_, j)| j == i) {
                    list.push((origin, i));
                }
            }
            let name = squash(&v.name);
            if name.len() >= 3 {
                by_name.entry(name).or_default().push(i);
            }
        }
        let by_tag = ranked
            .into_iter()
            .map(|(key, mut list)| {
                list.sort_unstable();
                (key, list.into_iter().map(|(_, i)| i).collect())
            })
            .collect();
        Self { vehicles, by_code, by_tag, by_name }
    }

    /// The first of `candidates` of `nation` when one is, else the first.
    fn pick(&self, candidates: Option<&Vec<usize>>, nation: Option<Nation>) -> Option<Vehicle> {
        let list = candidates?;
        let chosen =
            nation.and_then(|n| list.iter().find(|&&i| self.vehicles[i].nation == n)).or_else(|| list.first())?;
        Some(self.vehicles[*chosen].clone())
    }
}

fn seed() -> Vec<Vehicle> {
    serde_json::from_str(CATALOG_JSON).unwrap_or_else(|e| {
        tracing::warn!(error = %e, "vehicle catalog is invalid; codes resolve heuristically");
        Vec::new()
    })
}

fn slot() -> &'static RwLock<Arc<Catalog>> {
    static CATALOG: OnceLock<RwLock<Arc<Catalog>>> = OnceLock::new();
    CATALOG.get_or_init(|| RwLock::new(Arc::new(Catalog::new(Arc::new(seed())))))
}

fn catalog() -> Arc<Catalog> {
    Arc::clone(&slot().read().unwrap_or_else(|e| e.into_inner()))
}

/// Makes `vehicles` (the game's list) the catalog every lookup uses from now on. An empty list
/// keeps the current one.
pub fn install(vehicles: &Arc<Vec<Vehicle>>) {
    if vehicles.is_empty() {
        return;
    }
    let next = Arc::new(Catalog::new(Arc::clone(vehicles)));
    *slot().write().unwrap_or_else(|e| e.into_inner()) = next;
}

/// Back to the built-in seed (Settings → Game → Read the vehicle list turned off; tests).
pub fn reset_to_seed() {
    *slot().write().unwrap_or_else(|e| e.into_inner()) = Arc::new(Catalog::new(Arc::new(seed())));
}

/// Every vehicle in the current catalog.
pub fn all() -> Arc<Vec<Vehicle>> {
    Arc::clone(&catalog().vehicles)
}

/// The catalog entry for `code` (case-insensitive), if any.
pub fn lookup(code: &str) -> Option<Vehicle> {
    let catalog = catalog();
    catalog.by_code.get(&code.trim().to_lowercase()).map(|&i| catalog.vehicles[i].clone())
}

/// The vehicle a [`squash`]ed hashtag names: its code, its code without the nation prefix, or
/// its name (keys shorter than 3 characters never match). When several do, one of `nation`
/// (what the post's other hashtags say) is preferred.
pub fn by_hashtag(squashed: &str, nation: Option<Nation>) -> Option<Vehicle> {
    if squashed.len() < 3 {
        return None;
    }
    let catalog = catalog();
    catalog.pick(catalog.by_tag.get(squashed), nation)
}

/// The vehicle whose [`squash`]ed name is exactly `squashed` (words of a post's title).
pub fn by_name(squashed: &str, nation: Option<Nation>) -> Option<Vehicle> {
    if squashed.len() < 3 {
        return None;
    }
    let catalog = catalog();
    catalog.pick(catalog.by_name.get(squashed), nation)
}

/// A name as the game writes it, cleaned for display: the leading symbol the game uses to mark
/// a foreign or special variant (`◔Leopard 2A4`, `␠Tiger`) goes, non-breaking spaces become
/// spaces and zero-width spaces (line-break hints in the Chinese names) go. Also says whether
/// there was such a mark.
pub fn clean_name(raw: &str) -> (String, bool) {
    let spaced = raw.replace('\u{a0}', " ").replace('\u{200b}', "");
    let marker = |c: char| !c.is_alphanumeric() && !matches!(c, '"' | '\'' | '(' | '«' | '[' | '“' | '„' | '「');
    let trimmed = spaced.trim_start_matches(|c: char| marker(c) || c.is_whitespace());
    let marked = trimmed.len() != spaced.trim_start().len();
    let cleaned = trimmed.trim().to_owned();
    if cleaned.is_empty() {
        return (spaced.trim().to_owned(), false);
    }
    (cleaned, marked)
}

/// Lower case without `_ - .`, spaces and other punctuation: `T-34-85` → `t3485`.
pub fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The code without its nation prefix (`ussr_t_34_85` → `t_34_85`), for prefixed codes.
pub fn without_nation(code: &str) -> Option<&str> {
    nation_from_prefix(code)?;
    code.split_once('_').map(|(_, rest)| rest).filter(|rest| !rest.is_empty())
}

/// The hashtag keys of a vehicle with their rank: 0 whole code, 1 code without its nation
/// prefix, 2 name.
fn keys_of(vehicle: &Vehicle) -> Vec<(u8, String)> {
    let code = vehicle.code.to_lowercase();
    let mut keys = vec![(0, squash(&code)), (2, squash(&vehicle.name))];
    if let Some(rest) = without_nation(&code) {
        keys.push((1, squash(rest)));
    }
    keys.retain(|(_, k)| k.len() >= 3);
    keys
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
