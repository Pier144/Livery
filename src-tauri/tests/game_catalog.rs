//! The game's vehicle list from synthetic data archives (Gaijin's files can't ship in the
//! repository): the `.vromfs.bin` reader, the binary BLK reader, the mapping to vehicles, the
//! cache, and damaged files that must fail cleanly. `game_catalog_real.rs` reads a real install.

mod common;

use common::{b, blk_body, fat_blk, fat_body, name_map, slim_blk, vromfs, with_kind, B, V};
use livery_lib::error::ErrorCode;
use livery_lib::game::binblk::{Blk, NameMap, Value};
use livery_lib::game::catalog::{
    kind_of, names_by_language, nation_of, read_catalog, unit_names, CatalogStore, CATALOG_FILE,
};
use livery_lib::game::vromfs::{Vromfs, NAME_MAP_FILE};
use livery_lib::library::vehicles;
use livery_lib::model::{Language, Nation, VehicleType};
use std::fs;
use std::path::{Path, PathBuf};

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

/// Tests that install a list into `library::vehicles` (one global catalog) run one at a time.
static GLOBAL_CATALOG: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn global_catalog() -> std::sync::MutexGuard<'static, ()> {
    GLOBAL_CATALOG.lock().unwrap_or_else(|e| e.into_inner())
}

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

// ── Binary BLK kinds (Dagor's numbering: 1 fat, 2 fat+zstd, 3 slim, 4 slim+zstd, 5 + dictionary) ──

fn sample_tree() -> B {
    b(
        "root",
        vec![],
        vec![
            unit("germ_pz_ii", "country_germany", 1, "exp_tank"),
            unit("germ_leopard_2a6", "country_germany", 8, "exp_tank"),
        ],
    )
}

fn assert_sample(blk: &Blk) {
    let codes: Vec<&str> = blk.root().children().filter_map(|c| c.name()).collect();
    assert_eq!(codes, ["germ_pz_ii", "germ_leopard_2a6"]);
    let leopard = blk.root().child("germ_leopard_2a6").unwrap();
    assert_eq!(leopard.param("rank"), Some(Value::Int(8)));
    assert_eq!(
        leopard.param("country").and_then(|v| v.as_str().map(str::to_owned)).as_deref(),
        Some("country_germany")
    );
}

fn parse_error_detail(file: &[u8], shared: Option<&NameMap>, dict: Option<&[u8]>) -> String {
    let e = Blk::parse(file, shared, dict).unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse);
    e.detail.unwrap_or_default()
}

#[test]
fn kind_3_is_slim_and_not_compressed() {
    let names = NameMap::parse(&name_map(NAMES), None).unwrap();
    let file = with_kind(3, &blk_body(&sample_tree(), NAMES, false));
    assert_sample(&Blk::parse(&file, Some(&names), None).unwrap());
    assert!(parse_error_detail(&file, None, None).contains("name map"));
}

#[test]
fn kind_4_is_slim_zstd_with_or_without_a_dictionary() {
    let names = NameMap::parse(&name_map(NAMES), None).unwrap();
    let file = slim_blk(&sample_tree(), NAMES);
    assert_eq!(file[0], 4);
    assert_sample(&Blk::parse(&file, Some(&names), None).unwrap());
    assert_sample(&Blk::parse(&file, Some(&names), Some(b"an unrelated dictionary")).unwrap());
    // A kind 4 frame that does lean on the dictionary reads too once it is passed.
    let body = blk_body(&sample_tree(), NAMES, false);
    let packed = zstd::bulk::Compressor::with_dictionary(3, &body).unwrap().compress(&body).unwrap();
    assert_sample(&Blk::parse(&with_kind(4, &packed), Some(&names), Some(&body)).unwrap());
}

#[test]
fn kind_5_needs_its_zstd_dictionary() {
    let names = NameMap::parse(&name_map(NAMES), None).unwrap();
    let body = blk_body(&sample_tree(), NAMES, false);
    // A raw-content dictionary holding the body: the frame is then mostly one match into it, so
    // it can't be unpacked without the dictionary (zstd's trainer isn't compiled into the crate).
    let dict = body.clone();
    let packed = zstd::bulk::Compressor::with_dictionary(3, &dict).unwrap().compress(&body).unwrap();
    assert!(
        packed.len() < body.len() / 2,
        "the frame should lean on the dictionary ({} of {})",
        packed.len(),
        body.len()
    );
    let file = with_kind(5, &packed);
    assert_sample(&Blk::parse(&file, Some(&names), Some(&dict)).unwrap());
    assert!(parse_error_detail(&file, Some(&names), None).contains("zstd"));
}

#[test]
fn kind_1_is_fat_with_its_own_names() {
    let file = fat_blk(&sample_tree(), NAMES);
    assert_sample(&Blk::parse(&file, None, None).unwrap());
    // Shared names are not needed (and not used) by a fat file.
    let names = NameMap::parse(&name_map(&["root"]), None).unwrap();
    assert_sample(&Blk::parse(&file, Some(&names), None).unwrap());
}

#[test]
fn kind_2_is_fat_inside_a_sized_zstd_frame() {
    let tree = sample_tree();
    let inner = fat_blk(&tree, NAMES);
    let frame = zstd::bulk::compress(&inner, 3).unwrap();
    let mut file = vec![2u8];
    file.extend_from_slice(&(frame.len() as u32).to_le_bytes()[..3]);
    file.extend_from_slice(&frame);
    assert_sample(&Blk::parse(&file, None, None).unwrap());
    // Bytes after the frame (a padded file) are ignored.
    file.extend_from_slice(&[0, 0, 0, 0]);
    assert_sample(&Blk::parse(&file, None, None).unwrap());
}

#[test]
fn packed_fat_files_that_are_damaged_or_nested_fail_cleanly() {
    let tree = sample_tree();
    let packed = |inner: &[u8]| {
        let frame = zstd::bulk::compress(inner, 3).unwrap();
        let mut file = vec![2u8];
        file.extend_from_slice(&(frame.len() as u32).to_le_bytes()[..3]);
        file.extend_from_slice(&frame);
        file
    };
    // The inner file must be a plain fat one, never another packed kind.
    for kind in [2u8, 3, 4, 5] {
        let nested = packed(&with_kind(kind, &fat_body(&tree, NAMES)));
        assert!(parse_error_detail(&nested, None, None).contains("nested packed BLK"), "kind {kind}");
    }
    assert!(parse_error_detail(&packed(&[]), None, None).contains("nested packed BLK"));
    // Truncated size, a size past the end of the file, a frame that isn't zstd.
    assert!(parse_error_detail(&[2, 1, 0], None, None).contains("truncated"));
    assert!(parse_error_detail(&[2, 0xFF, 0xFF, 0xFF, 1, 2, 3], None, None).contains("truncated"));
    assert!(parse_error_detail(&[2, 4, 0, 0, 9, 9, 9, 9], None, None).contains("zstd"));
    let good = packed(&fat_blk(&tree, NAMES));
    assert_eq!(Blk::parse(&good[..good.len() - 3], None, None).unwrap_err().code, ErrorCode::Parse);
}

#[test]
fn kinds_outside_1_to_5_are_not_binary_blk_files() {
    for kind in [0u8, 6, 7, 255] {
        let detail = parse_error_detail(&with_kind(kind, &fat_body(&sample_tree(), NAMES)), None, None);
        assert!(detail.contains(&format!("not a binary BLK (kind {kind})")), "{detail}");
    }
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
    let _one = global_catalog();
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
    let _one = global_catalog();
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

// ── Names in the other UI languages ─────────────────────────────────────────

/// `units.csv` with the game's full header (every language column, BOM, CRLF), synthetic rows.
const UNITS_LOCALIZED: &[u8] = include_bytes!("fixtures/game/units_localized.csv");

#[test]
fn units_csv_columns_give_each_ui_language_its_names() {
    let all = names_by_language(UNITS_LOCALIZED);
    assert_eq!(all.keys().copied().collect::<Vec<_>>(), Language::ALL, "every UI language has its column");
    let name = |lang: Language, code: &str| all[&lang].get(code).cloned();
    assert_eq!(name(Language::En, "us_iowa").as_deref(), Some("USS \"Iowa\""));
    assert_eq!(name(Language::Ru, "us_iowa").as_deref(), Some("USS «Айова»"));
    assert_eq!(name(Language::Pl, "us_iowa").as_deref(), Some("USS \"Iowa\""), "an empty cell takes the English name");
    assert_eq!(name(Language::ZhCn, "germ_pz_ii").as_deref(), Some("二号坦克 C 型"), "the shop name wins over `_0`");
    assert_eq!(name(Language::De, "germ_pz_ii").as_deref(), Some("Pz.II C"));
    assert_eq!(unit_names(UNITS_LOCALIZED), all[&Language::En], "unit_names is the English column");
    // Without an English column nothing is read.
    assert!(names_by_language("\"<ID|readonly|noverify>\";\"<Russian>\"\n\"a_shop\";\"б\"\n".as_bytes()).is_empty());
}

#[test]
fn the_list_keeps_only_the_names_that_differ_from_english() {
    let game = Game::new("local");
    fs::write(game.0.join("lang.vromfs.bin"), vromfs(&[("lang/units.csv", UNITS_LOCALIZED)], true)).unwrap();
    let catalog = read_catalog(&game.0).unwrap();
    let english = |code: &str| catalog.vehicles.iter().find(|v| v.code == code).unwrap().name.clone();
    assert_eq!(english("ussr_mig_15"), "MiG-15", "Vehicle.name stays English");
    assert_eq!(english("it_leopard_2a6"), "Leopard 2A6");
    assert!(!catalog.names.contains_key(&Language::En));
    let ru = &catalog.names[&Language::Ru];
    assert_eq!(ru.get("ussr_mig_15").map(String::as_str), Some("МиГ-15"));
    assert_eq!(ru.get("us_iowa").map(String::as_str), Some("USS «Айова»"));
    assert!(!ru.contains_key("germ_pz_ii"), "same as English: not kept");
    let zh = &catalog.names[&Language::ZhCn];
    assert_eq!(zh.get("ussr_mig_15").map(String::as_str), Some("米格-15"), "zero-width spaces go");
    assert_eq!(zh.get("it_leopard_2a6").map(String::as_str), Some("豹 2A6"), "the variant mark goes");
    assert_eq!(zh.get("germ_leopard_2a6").map(String::as_str), Some("豹 2A6"));
    assert!(catalog.names[&Language::It].is_empty(), "nothing differs in Italian");
}

#[test]
fn local_names_are_cached_with_the_list() {
    let _one = global_catalog();
    let game = Game::new("localcache");
    fs::write(game.0.join("lang.vromfs.bin"), vromfs(&[("lang/units.csv", UNITS_LOCALIZED)], true)).unwrap();
    let data = game.0.join("data");
    let store = CatalogStore::new(data.join(CATALOG_FILE));
    let ru = store.names_for(&game.0, Language::Ru).unwrap();
    assert_eq!(ru.get("ussr_mig_15").map(String::as_str), Some("МиГ-15"));
    assert!(store.names_for(&game.0, Language::En).unwrap().is_empty(), "English needs no extra names");
    // Another session gets them from the cache file.
    let cached = CatalogStore::new(data.join(CATALOG_FILE));
    let text = fs::read_to_string(data.join(CATALOG_FILE)).unwrap();
    assert!(text.contains("\"version\":2") && text.contains("\"zh-CN\""), "{text}");
    assert_eq!(
        cached.names_for(&game.0, Language::ZhCn).unwrap().get("ussr_mig_15").map(String::as_str),
        Some("米格-15")
    );
    // Codes and lookups stay English.
    assert_eq!(vehicles::lookup("ussr_mig_15").map(|v| v.name).as_deref(), Some("MiG-15"));
    // A version 1 cache (no names) is read again from the archives.
    let old = text.replace("\"version\":2", "\"version\":1");
    fs::write(data.join(CATALOG_FILE), old).unwrap();
    let again = CatalogStore::new(data.join(CATALOG_FILE));
    assert!(!again.names_for(&game.0, Language::Ru).unwrap().is_empty());
    assert!(fs::read_to_string(data.join(CATALOG_FILE)).unwrap().contains("\"version\":2"), "rewritten");
    vehicles::reset_to_seed();
}

#[test]
fn chinese_names_keep_their_quotes() {
    assert_eq!(vehicles::clean_name("\u{201c}豹\u{201d}\u{200b}2A6"), ("\u{201c}豹\u{201d}2A6".to_owned(), false));
    assert_eq!(vehicles::clean_name("\u{25d4}豹\u{200b}2A6"), ("豹2A6".to_owned(), true));
}
