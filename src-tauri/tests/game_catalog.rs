//! The game's vehicle list from synthetic data archives (Gaijin's files can't ship in the
//! repository): the `.vromfs.bin` reader, the binary BLK reader, the mapping to vehicles, the
//! cache, and damaged files that must fail cleanly. `game_catalog_real.rs` reads a real install.

use livery_lib::error::ErrorCode;
use livery_lib::game::binblk::{Blk, NameMap, Value};
use livery_lib::game::catalog::{kind_of, nation_of, read_catalog, unit_names, CatalogStore, CATALOG_FILE};
use livery_lib::game::vromfs::{deobfuscate, Vromfs, NAME_MAP_FILE};
use livery_lib::library::vehicles;
use livery_lib::model::{Nation, VehicleType};
use std::fs;
use std::path::{Path, PathBuf};

// ── Encoders (the inverse of what Livery reads) ─────────────────────────────

fn uleb(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// A `.vromfs.bin`: `VRFx` packed with zstd and obfuscated, or `VRFs` stored as is.
fn vromfs(files: &[(&str, &[u8])], packed: bool) -> Vec<u8> {
    let count = files.len();
    let names_at = 0x20;
    let info_at = names_at + 8 * count;
    let mut strings_at = info_at + 16 * count;
    let mut payload = vec![0u8; strings_at];
    payload[0..4].copy_from_slice(&(names_at as u32).to_le_bytes());
    payload[4..8].copy_from_slice(&(count as u32).to_le_bytes());
    payload[16..20].copy_from_slice(&(info_at as u32).to_le_bytes());
    payload[20..24].copy_from_slice(&(count as u32).to_le_bytes());
    for (i, (name, _)) in files.iter().enumerate() {
        payload[names_at + 8 * i..names_at + 8 * i + 8].copy_from_slice(&(strings_at as u64).to_le_bytes());
        // `\u{ff}` is stored as the single byte 0xFF.
        let raw: Vec<u8> = name.chars().map(|c| c as u32 as u8).collect();
        payload.extend_from_slice(&raw);
        payload.push(0);
        strings_at = payload.len();
    }
    for (i, (_, data)) in files.iter().enumerate() {
        while payload.len() % 16 != 0 {
            payload.push(0);
        }
        let at = payload.len();
        payload[info_at + 16 * i..info_at + 16 * i + 4].copy_from_slice(&(at as u32).to_le_bytes());
        payload[info_at + 16 * i + 4..info_at + 16 * i + 8].copy_from_slice(&(data.len() as u32).to_le_bytes());
        payload.extend_from_slice(data);
    }
    let mut out = Vec::new();
    if packed {
        let mut body = zstd::bulk::compress(&payload, 3).unwrap();
        deobfuscate(&mut body);
        out.extend_from_slice(b"VRFx\0\0PC");
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&((body.len() as u32) | (0x30 << 26)).to_le_bytes());
        out.extend_from_slice(&8u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&[65, 0, 59, 2]); // 2.59.0.65
        out.extend_from_slice(&body);
    } else {
        out.extend_from_slice(b"VRFs\0\0PC");
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&payload);
    }
    out.extend_from_slice(&[0u8; 16]); // digest
    out
}

/// A name map file: digests (zero: no dictionary), then zstd of count, size and names.
fn name_map(names: &[&str]) -> Vec<u8> {
    let mut raw = Vec::new();
    let joined: Vec<u8> = names.iter().flat_map(|n| n.bytes().chain(std::iter::once(0))).collect();
    uleb(names.len() as u64, &mut raw);
    uleb(joined.len() as u64, &mut raw);
    raw.extend_from_slice(&joined);
    let mut file = vec![0u8; 40];
    file.extend_from_slice(&zstd::bulk::compress(&raw, 3).unwrap());
    file
}

enum V {
    Str(&'static str),
    Int(i32),
    Bool(bool),
}

struct B {
    name: &'static str,
    params: Vec<(&'static str, V)>,
    children: Vec<B>,
}

fn b(name: &'static str, params: Vec<(&'static str, V)>, children: Vec<B>) -> B {
    B { name, params, children }
}

/// A slim BLK (kind 4, zstd, no dictionary) over the shared `names`; blocks breadth-first so
/// each block's children are contiguous.
fn slim_blk(root: &B, names: &[&str]) -> Vec<u8> {
    let id = |n: &str| names.iter().position(|x| *x == n).unwrap_or_else(|| panic!("{n} not in the name map"));
    let mut order: Vec<&B> = vec![root];
    let mut first_child: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < order.len() {
        let block = order[i];
        first_child.push(order.len());
        order.extend(block.children.iter());
        i += 1;
    }
    let mut data = Vec::new();
    let mut infos = Vec::new();
    for block in &order {
        for (name, value) in &block.params {
            let (ty, raw) = match value {
                V::Str(s) => {
                    let at = data.len() as u32;
                    data.extend_from_slice(s.as_bytes());
                    data.push(0);
                    (1u32, at)
                }
                V::Int(v) => (2, *v as u32),
                V::Bool(v) => (9, u32::from(*v)),
            };
            infos.extend_from_slice(&((id(name) as u32) | (ty << 24)).to_le_bytes());
            infos.extend_from_slice(&raw.to_le_bytes());
        }
    }
    let params: usize = order.iter().map(|b| b.params.len()).sum();
    let mut body = Vec::new();
    uleb(0, &mut body);
    uleb(order.len() as u64, &mut body);
    uleb(params as u64, &mut body);
    uleb(data.len() as u64, &mut body);
    body.extend_from_slice(&data);
    body.extend_from_slice(&infos);
    for (index, block) in order.iter().enumerate() {
        uleb(if index == 0 { 0 } else { id(block.name) as u64 + 1 }, &mut body);
        uleb(block.params.len() as u64, &mut body);
        uleb(block.children.len() as u64, &mut body);
        if !block.children.is_empty() {
            uleb(first_child[index] as u64, &mut body);
        }
    }
    let mut file = vec![4u8];
    file.extend_from_slice(&zstd::bulk::compress(&body, 3).unwrap());
    file
}

const NAMES: &[&str] = &[
    "root",
    "country",
    "rank",
    "unitClass",
    "value",
    "tags",
    "type_light_tank",
    "type_medium_tank",
    "type_battleship",
    "germ_pz_ii",
    "germ_leopard_2a6",
    "us_iowa",
    "soldier",
    "mystery",
    "ussr_mig_15",
    "country_germany",
    "country_usa",
    "country_ussr",
    "air",
    "a_name",
    "it_leopard_2a6",
    "country_italy",
];

fn unit(code: &'static str, country: &'static str, rank: i32, class: &'static str) -> B {
    b(
        code,
        vec![
            ("value", V::Int(100)),
            ("country", V::Str(country)),
            ("rank", V::Int(rank)),
            ("unitClass", V::Str(class)),
        ],
        vec![],
    )
}

fn wpcost() -> Vec<u8> {
    let root = b(
        "root",
        vec![],
        vec![
            unit("germ_pz_ii", "country_germany", 1, "exp_tank"),
            unit("germ_leopard_2a6", "country_germany", 8, "exp_tank"),
            unit("us_iowa", "country_usa", 7, "exp_cruiser"),
            unit("soldier", "country_usa", 1, "exp_human"),
            unit("mystery", "country_atlantis", 1, "exp_tank"),
            unit("ussr_mig_15", "country_ussr", 5, "exp_fighter"),
            unit("it_leopard_2a6", "country_italy", 8, "exp_tank"),
        ],
    );
    slim_blk(&root, NAMES)
}

fn unittags() -> Vec<u8> {
    let tagged = |code: &'static str, tag: &'static str| {
        b(code, vec![], vec![b("tags", vec![(tag, V::Bool(true)), ("air", V::Bool(false))], vec![])])
    };
    let root = b(
        "root",
        vec![],
        vec![
            tagged("germ_pz_ii", "type_light_tank"),
            tagged("germ_leopard_2a6", "type_medium_tank"),
            tagged("us_iowa", "type_battleship"),
        ],
    );
    slim_blk(&root, NAMES)
}

const UNITS_CSV: &str = "\u{feff}\"<ID|readonly|noverify>\";\"<English>\";\"<Italian>\"\n\
\"germ_pz_ii_shop\";\"Pz.II C\";\"Pz.II C\"\n\
\"germ_pz_ii_0\";\"Panzerkampfwagen II Ausf.C\";\"x\"\n\
\"germ_leopard_2a6_0\";\"Leopard 2A6\";\"Leopard 2A6\"\n\
\"us_iowa_shop\";\"USS \"\"Iowa\"\"\";\"USS Iowa\"\r\n\
\"note\";\"a quoted\nline break\";\"\"\n\
\"ussr_mig_15_1\";\"MiG-15\";\"MiG-15\"\n\
\"it_leopard_2a6_shop\";\"\u{25d4}Leopard\u{a0}2A6\";\"x\"\n";

struct Game(PathBuf);

impl Game {
    fn new(name: &str) -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("livery-catalog-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let game = Self(dir);
        game.write_char(&wpcost());
        fs::write(game.0.join("lang.vromfs.bin"), vromfs(&[("lang/units.csv", UNITS_CSV.as_bytes())], true)).unwrap();
        game
    }

    fn write_char(&self, wpcost: &[u8]) {
        let nm = name_map(NAMES);
        let tags = unittags();
        let files: [(&str, &[u8]); 3] =
            [(NAME_MAP_FILE, &nm), ("config/wpcost.blk", wpcost), ("config/unittags.blk", &tags)];
        fs::write(self.0.join("char.vromfs.bin"), vromfs(&files, true)).unwrap();
    }
}

impl Drop for Game {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// ── Archives ────────────────────────────────────────────────────────────────

#[test]
fn archives_unpack_packed_or_stored() {
    let files: [(&str, &[u8]); 2] = [("a/one.txt", b"first"), ("b/two.bin", &[0, 1, 2, 3, 255])];
    for packed in [true, false] {
        let archive = Vromfs::from_bytes(&vromfs(&files, packed)).unwrap();
        assert_eq!(archive.paths(), ["a/one.txt", "b/two.bin"]);
        assert_eq!(archive.file("a/one.txt"), Some(&b"first"[..]));
        assert_eq!(archive.file("b/two.bin"), Some(&[0, 1, 2, 3, 255][..]));
        assert_eq!(archive.file("missing"), None);
        assert_eq!(archive.version(), packed.then_some("2.59.0.65"));
    }
    let nm = Vromfs::from_bytes(&vromfs(&[(NAME_MAP_FILE, b"x")], true)).unwrap();
    assert_eq!(nm.file(NAME_MAP_FILE), Some(&b"x"[..]), "the name map's \\xff name");
}

#[test]
fn damaged_archives_are_parse_errors_never_panics() {
    let good = vromfs(&[("a.txt", b"hello world, hello archive"), ("b.txt", b"second")], true);
    for bad in [&b""[..], b"VRFx", b"NOPE\0\0PC\0\0\0\0\0\0\0\0", &good[..30], &good[..good.len() / 2]] {
        assert_eq!(Vromfs::from_bytes(bad).unwrap_err().code, ErrorCode::Parse);
    }
    // Every single-byte change either reads or fails cleanly.
    let mut seed: u32 = 7;
    for _ in 0..400 {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        let mut copy = good.clone();
        let at = (seed as usize >> 4) % copy.len();
        copy[at] ^= (seed >> 24) as u8 | 1;
        let _ = Vromfs::from_bytes(&copy);
    }
    let stored = vromfs(&[("a.txt", b"abc")], false);
    let mut broken = stored.clone();
    broken[16 + 16..16 + 20].copy_from_slice(&u32::MAX.to_le_bytes()); // data table offset
    assert_eq!(Vromfs::from_bytes(&broken).unwrap_err().code, ErrorCode::Parse);
}

#[test]
fn a_missing_archive_is_not_found() {
    let e = Vromfs::open(Path::new("Z:/no/such/char.vromfs.bin")).unwrap_err();
    assert!(matches!(e.code, ErrorCode::NotFound | ErrorCode::Io), "{e:?}");
}

// ── Binary BLK ──────────────────────────────────────────────────────────────

#[test]
fn slim_blk_reads_blocks_and_params() {
    let names = NameMap::parse(&name_map(NAMES), None).unwrap();
    assert_eq!(names.len(), NAMES.len());
    let blk = Blk::parse(&wpcost(), Some(&names), None).unwrap();
    let root = blk.root();
    assert_eq!(root.name(), None);
    let codes: Vec<&str> = root.children().filter_map(|c| c.name()).collect();
    assert_eq!(
        codes,
        ["germ_pz_ii", "germ_leopard_2a6", "us_iowa", "soldier", "mystery", "ussr_mig_15", "it_leopard_2a6"]
    );
    let leopard = root.child("germ_leopard_2a6").unwrap();
    assert_eq!(leopard.param("rank"), Some(Value::Int(8)));
    assert_eq!(
        leopard.param("country").and_then(|v| v.as_str().map(str::to_owned)).as_deref(),
        Some("country_germany")
    );
    assert_eq!(leopard.param("nope"), None);
    let tags = Blk::parse(&unittags(), Some(&names), None).unwrap();
    let iowa_tags = tags.root().child("us_iowa").unwrap().child("tags").unwrap();
    assert_eq!(iowa_tags.param("type_battleship").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(iowa_tags.params().count(), 2);
}

#[test]
fn damaged_blk_files_are_parse_errors() {
    let names = NameMap::parse(&name_map(NAMES), None).unwrap();
    let good = wpcost();
    assert_eq!(Blk::parse(&good, None, None).unwrap_err().code, ErrorCode::Parse, "slim without a name map");
    assert_eq!(Blk::parse(&[], Some(&names), None).unwrap_err().code, ErrorCode::Parse);
    assert_eq!(Blk::parse(&[9, 1, 2], Some(&names), None).unwrap_err().code, ErrorCode::Parse);
    assert_eq!(Blk::parse(&good[..good.len() / 2], Some(&names), None).unwrap_err().code, ErrorCode::Parse);
    // A name map without the names a file refers to.
    let small = NameMap::parse(&name_map(&["root"]), None).unwrap();
    assert_eq!(Blk::parse(&good, Some(&small), None).unwrap_err().code, ErrorCode::Parse);
    assert_eq!(NameMap::parse(&[0; 10], None).unwrap_err().code, ErrorCode::Parse);
    assert!(!NameMap::needs_dictionary(&name_map(NAMES)));
}

// ── The vehicle list ────────────────────────────────────────────────────────

#[test]
fn the_list_maps_nation_type_class_rank_and_name() {
    let game = Game::new("map");
    let catalog = read_catalog(&game.0).unwrap();
    assert_eq!(catalog.version.as_deref(), Some("2.59.0.65"));
    let codes: Vec<&str> = catalog.vehicles.iter().map(|v| v.code.as_str()).collect();
    assert_eq!(
        codes,
        ["us_iowa", "germ_pz_ii", "ussr_mig_15", "germ_leopard_2a6", "it_leopard_2a6"],
        "shorter codes first, the marked foreign variant last; infantry and unknown nations left out"
    );
    assert_eq!(catalog.vehicles.last().unwrap().name, "Leopard 2A6", "the mark and the non-breaking space go");
    let find = |code: &str| catalog.vehicles.iter().find(|v| v.code == code).unwrap().clone();
    let pz = find("germ_pz_ii");
    assert_eq!(
        (pz.name.as_str(), pz.nation, pz.vehicle_type, pz.class.as_str(), pz.rank),
        ("Pz.II C", Nation::Ger, VehicleType::Ground, "Light tank", Some(1))
    );
    assert_eq!(find("germ_leopard_2a6").class, "Medium tank");
    assert_eq!(find("germ_leopard_2a6").name, "Leopard 2A6", "the full name when there's no shop name");
    let iowa = find("us_iowa");
    assert_eq!(
        (iowa.name.as_str(), iowa.vehicle_type, iowa.class.as_str()),
        ("USS \"Iowa\"", VehicleType::Naval, "Battleship")
    );
    assert_eq!(find("ussr_mig_15").name, "ussr_mig_15", "only `_shop` and `_0` names count");
}

#[test]
fn without_the_language_archive_names_are_codes() {
    let game = Game::new("nolang");
    fs::remove_file(game.0.join("lang.vromfs.bin")).unwrap();
    let catalog = read_catalog(&game.0).unwrap();
    assert!(catalog.vehicles.iter().all(|v| v.name == v.code));
    fs::remove_file(game.0.join("char.vromfs.bin")).unwrap();
    assert!(read_catalog(&game.0).is_err());
}

#[test]
fn classes_and_nations() {
    assert_eq!(nation_of("country_israel"), Some(Nation::Isr));
    assert_eq!(nation_of("country_moon"), None);
    assert_eq!(kind_of("exp_helicopter", &["type_attack_helicopter"]), Some((VehicleType::Heli, "Attack helicopter")));
    assert_eq!(kind_of("exp_tank", &[]), Some((VehicleType::Ground, "Tank")));
    assert_eq!(kind_of("exp_cruiser", &["type_light_cruiser"]), Some((VehicleType::Naval, "Light cruiser")));
    assert_eq!(kind_of("exp_SPAA", &[]), Some((VehicleType::Ground, "SPAA")));
    assert_eq!(kind_of("exp_human", &[]), None);
}

#[test]
fn units_csv_handles_quotes_and_line_breaks() {
    let names = unit_names(UNITS_CSV.as_bytes());
    assert_eq!(names.get("germ_pz_ii").map(String::as_str), Some("Pz.II C"));
    assert_eq!(names.get("us_iowa").map(String::as_str), Some("USS \"Iowa\""));
    assert!(!names.contains_key("note"));
    assert!(unit_names(b"no header at all").is_empty());
}

#[test]
fn the_list_is_cached_until_the_game_changes_and_drives_lookups() {
    let game = Game::new("cache");
    let data = game.0.join("data");
    let store = CatalogStore::new(data.join(CATALOG_FILE));
    let list = store.vehicles_for(&game.0).unwrap();
    assert_eq!(list.len(), 5);
    assert!(data.join(CATALOG_FILE).is_file(), "cached");
    // Lookups and hashtags now use the game's list.
    assert_eq!(vehicles::lookup("germ_pz_ii").map(|v| v.name), Some("Pz.II C".into()));
    let tag = |key: &str, nation| vehicles::by_hashtag(key, nation).map(|v| v.code);
    assert_eq!(tag("pzii", None).as_deref(), Some("germ_pz_ii"), "the code without its prefix");
    assert_eq!(tag("pz", None), None, "keys under 3 characters never match");
    assert_eq!(tag("pziic", None).as_deref(), Some("germ_pz_ii"));
    assert_eq!(tag("leopard2a6", None).as_deref(), Some("germ_leopard_2a6"), "the original first");
    assert_eq!(tag("leopard2a6", Some(Nation::Ita)).as_deref(), Some("it_leopard_2a6"), "unless the post says Italy");
    assert_eq!(vehicles::by_name("leopard2a6", None).map(|v| v.code).as_deref(), Some("germ_leopard_2a6"));
    let from_title = livery_lib::wtlive::api::infer_vehicle(&[], "Desert camo for the Pz.II C, 1941");
    assert_eq!(from_title.vehicle.code, "germ_pz_ii", "from the title");
    let one_word = livery_lib::wtlive::api::infer_vehicle(&[], "Leopard skin");
    assert_eq!(one_word.vehicle.code, "", "one word without a digit never matches");
    let dash = livery_lib::wtlive::api::infer_vehicle(&[], "Turkey - Leopard 2NG");
    assert_eq!(dash.vehicle.code, "", "a lone dash isn't a word");

    // Another session reads the cache, not the archives.
    let again = CatalogStore::new(data.join(CATALOG_FILE));
    fs::write(game.0.join("lang.vromfs.bin"), b"").unwrap(); // would give code names if read
    let lang_stamp = livery_lib::game::catalog::Stamp::of(&game.0).unwrap();
    assert_eq!(lang_stamp.lang_size, 0);
    // The language archive changed, so it is read again (names fall back to codes).
    let reread = again.vehicles_for(&game.0).unwrap();
    assert!(reread.iter().all(|v| v.name == v.code));

    // A game update with a new vehicle list is picked up.
    let root = b("root", vec![], vec![unit("germ_pz_ii", "country_germany", 2, "exp_tank")]);
    game.write_char(&slim_blk(&root, NAMES));
    let updated = CatalogStore::new(data.join(CATALOG_FILE)).vehicles_for(&game.0).unwrap();
    assert_eq!(updated.len(), 1);
    assert_eq!(updated[0].rank, Some(2));
    vehicles::reset_to_seed();
}

#[test]
fn a_cache_from_another_game_folder_isnt_used() {
    let first = Game::new("first");
    let second = Game::new("second");
    let data = first.0.join("data");
    CatalogStore::new(data.join(CATALOG_FILE)).vehicles_for(&first.0).unwrap();
    let root = b("root", vec![], vec![unit("us_iowa", "country_usa", 7, "exp_cruiser")]);
    second.write_char(&slim_blk(&root, NAMES));
    let list = CatalogStore::new(data.join(CATALOG_FILE)).vehicles_for(&second.0).unwrap();
    assert_eq!(list.iter().map(|v| v.code.as_str()).collect::<Vec<_>>(), ["us_iowa"]);
    vehicles::reset_to_seed();
}

#[test]
fn names_lose_the_game_s_variant_marks() {
    assert_eq!(vehicles::clean_name("\u{25d4}Leopard 2A4"), ("Leopard 2A4".to_owned(), true));
    assert_eq!(vehicles::clean_name("Ju\u{a0}87\u{a0}B-2"), ("Ju 87 B-2".to_owned(), false));
    assert_eq!(vehicles::clean_name("\u{f059}Spitfire"), ("Spitfire".to_owned(), true));
    assert_eq!(vehicles::clean_name("\"Black Cat\" M18"), ("\"Black Cat\" M18".to_owned(), false));
    assert_eq!(vehicles::clean_name("\u{2622}"), ("\u{2622}".to_owned(), false), "nothing left: kept as is");
}
