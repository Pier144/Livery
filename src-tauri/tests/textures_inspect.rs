//! Texture lists: one file (header facts, size, warnings), a whole skin folder (top-level
//! textures, blk references missing from the folder, the blk itself, sort order) and an indexed
//! skin wherever its folder is (active or inactive). Temp folders only.

use livery_lib::error::ErrorCode;
use livery_lib::library::blk;
use livery_lib::library::index::LibraryStore;
use livery_lib::library::layout::inactive_dir;
use livery_lib::library::{import_folders, scan_game};
use livery_lib::model::TextureInfo;
use livery_lib::textures::inspect::{
    heavy_warning, size_warning, BLK_FORMAT, MISSING_WARNING, NOT_SQUARE_POW2_WARNING, UNREADABLE_WARNING,
};
use livery_lib::textures::{
    blk_texture_refs, inspect_file, inspect_skin, inspect_skin_dir, read_blk_refs, textures_for_skin,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-textures-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("textures").join(name)
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    fs::read(fixture(name)).unwrap()
}

fn put(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

/// A DX10 BC7 header of the given size.
fn bc7(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = fixture_bytes("bc7_4096.dds");
    put(&mut bytes, 12, height);
    put(&mut bytes, 16, width);
    bytes
}

fn texture(file: &str, width: u32, height: u32, format: &str, size: u64, warning: Option<String>) -> TextureInfo {
    TextureInfo {
        file: file.to_owned(),
        width: Some(width),
        height: Some(height),
        format: Some(format.to_owned()),
        size_bytes: Some(size),
        warning,
        missing: false,
    }
}

fn missing(file: &str) -> TextureInfo {
    TextureInfo {
        file: file.to_owned(),
        width: None,
        height: None,
        format: None,
        size_bytes: None,
        warning: Some(MISSING_WARNING.to_owned()),
        missing: true,
    }
}

fn blk_entry(file: &str, size: u64) -> TextureInfo {
    TextureInfo {
        file: file.to_owned(),
        width: None,
        height: None,
        format: Some(BLK_FORMAT.to_owned()),
        size_bytes: Some(size),
        warning: None,
        missing: false,
    }
}

fn files(list: &[TextureInfo]) -> Vec<&str> {
    list.iter().map(|t| t.file.as_str()).collect()
}

// ── Warnings ────────────────────────────────────────────────────────────────

#[test]
fn size_warnings_follow_the_rules() {
    for side in [128u32, 256, 512, 1024, 2048, 4096] {
        assert_eq!(size_warning(side, side), None, "{side}²");
    }
    assert_eq!(size_warning(8192, 8192).as_deref(), Some("Very heavy texture (8192²). Load times may suffer."));
    let not_square = Some(NOT_SQUARE_POW2_WARNING.to_owned());
    // Not square (even when heavy), not a power of two, or outside 128–8192.
    for (width, height) in [(2048, 1024), (8192, 4096), (1000, 1000), (3000, 3000), (64, 64), (16384, 16384), (1, 1)] {
        assert_eq!(size_warning(width, height), not_square, "{width}×{height}");
    }
    assert_eq!(heavy_warning(8192, 4096), "Very heavy texture (8192×4096). Load times may suffer.");
    assert_eq!(NOT_SQUARE_POW2_WARNING, "Not a square power-of-two size (e.g. 2048²); the game may skip it.");
    assert_eq!(UNREADABLE_WARNING, "Can't read the texture header.");
    assert_eq!(MISSING_WARNING, "Referenced in skin.blk but not in the archive.");
}

// ── One file ────────────────────────────────────────────────────────────────

#[test]
fn committed_fixtures_inspect() {
    let cases = [
        ("bc7_4096.dds", 4096, "BC7", 148),
        ("bc5_2048.dds", 2048, "BC5", 128),
        ("dxt1_512.dds", 512, "BC1", 128),
        ("rgba8_1024.tga", 1024, "RGBA8", 18),
        ("rle_24_256.tga", 256, "RGB8 RLE", 18),
    ];
    for (name, side, format, size) in cases {
        assert_eq!(inspect_file(&fixture(name)), texture(name, side, side, format, size, None), "{name}");
    }
}

#[test]
fn unreadable_headers_get_a_warning_and_keep_their_size() {
    let expected = |file: &str, size: Option<u64>| TextureInfo {
        file: file.to_owned(),
        width: None,
        height: None,
        format: None,
        size_bytes: size,
        warning: Some(UNREADABLE_WARNING.to_owned()),
        missing: false,
    };
    assert_eq!(inspect_file(&fixture("truncated.dds")), expected("truncated.dds", Some(100)));

    let tmp = TempDir::new("unreadable");
    let cases: [(&str, &[u8]); 4] = [
        ("garbage.dds", b"this is not a texture at all, just some text"),
        ("empty.tga", b""),
        // A TGA header in a .dds file, and a PNG signature in a .tga file.
        ("swapped.dds", &fixture_bytes("rgba8_1024.tga")),
        ("image.tga", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\0\0\0"),
    ];
    for (name, bytes) in cases {
        let path = tmp.write(name, bytes);
        assert_eq!(inspect_file(&path), expected(name, Some(bytes.len() as u64)), "{name}");
    }
    // Gone, and a folder named like a texture.
    assert_eq!(inspect_file(&tmp.path().join("gone.dds")), expected("gone.dds", None));
    fs::create_dir(tmp.path().join("folder.dds")).unwrap();
    assert_eq!(inspect_file(&tmp.path().join("folder.dds")), expected("folder.dds", None));
}

#[test]
fn size_warnings_reach_the_texture_info() {
    let tmp = TempDir::new("warnings");
    let heavy = tmp.write("hull_c.dds", &bc7(8192, 8192));
    assert_eq!(inspect_file(&heavy), texture("hull_c.dds", 8192, 8192, "BC7", 148, Some(heavy_warning(8192, 8192))));
    let wide = tmp.write("wide.dds", &bc7(2048, 1024));
    assert_eq!(inspect_file(&wide).warning.as_deref(), Some(NOT_SQUARE_POW2_WARNING));
    let odd = tmp.write("odd.dds", &bc7(1000, 1000));
    assert_eq!(inspect_file(&odd).warning.as_deref(), Some(NOT_SQUARE_POW2_WARNING));
}

#[test]
fn only_the_header_is_read_and_the_size_is_the_file_length() {
    let tmp = TempDir::new("length");
    let mut bytes = fixture_bytes("dxt1_512.dds");
    bytes.extend(std::iter::repeat(0x5A).take(512 * 512 / 2));
    let path = tmp.write("big.dds", &bytes);
    assert_eq!(inspect_file(&path), texture("big.dds", 512, 512, "BC1", 128 + 131_072, None));
}

#[test]
fn a_dds_with_another_extension_is_recognised_by_its_magic() {
    let tmp = TempDir::new("magic");
    let path = tmp.write("hull_c.bin", &fixture_bytes("bc5_2048.dds"));
    assert_eq!(inspect_file(&path), texture("hull_c.bin", 2048, 2048, "BC5", 128, None));
    let text = tmp.write("notes.txt", b"hello");
    assert_eq!(inspect_file(&text).warning.as_deref(), Some(UNREADABLE_WARNING));
}

// ── Skin folders ────────────────────────────────────────────────────────────

#[test]
fn skin_dir_lists_textures_then_missing_references_then_the_blk() {
    let tmp = TempDir::new("skin-dir");
    let dir = tmp.path().join("Winter T-34");
    let skin = |rel: &str, bytes: &[u8]| tmp.write(&format!("Winter T-34/{rel}"), bytes);
    skin("b_hull.dds", &fixture_bytes("bc7_4096.dds"));
    skin("A_turret.DDS", &fixture_bytes("bc5_2048.dds"));
    skin("camo.tga", &fixture_bytes("rle_24_256.tga"));
    skin("broken.dds", b"garbage");
    skin("readme.txt", b"not a texture");
    skin("preview.png", b"not listed either");
    skin("extras/detail_c.dds", &fixture_bytes("dxt1_512.dds"));
    skin("ussr_t_34_85.blk", b"replace_tex{ to:t=\"b_hull\" }");
    skin("zz_second.blk", b"ignored");

    let refs = [
        "b_hull*",              // present (no extension → .dds)
        "Camo.TGA",             // present, other case
        "extras\\detail_c.dds", // present in a sub-folder (not listed at the top)
        "zeta_n",               // missing → zeta_n.dds
        "./absent.tga",         // missing, "./" dropped
        "missing_c*",           // missing → missing_c.dds
        "missing_c.dds",        // same missing file again: listed once
        "MISSING_C",            // and again, other case
        "sub/gone.dds",         // missing in a sub-folder
        "  ",                   // empty
        "*",                    // empty once the star is gone
    ];
    let list = inspect_skin_dir(&dir, &refs).unwrap();
    assert_eq!(
        list,
        vec![
            texture("A_turret.DDS", 2048, 2048, "BC5", 128, None),
            texture("b_hull.dds", 4096, 4096, "BC7", 148, None),
            TextureInfo {
                file: "broken.dds".into(),
                width: None,
                height: None,
                format: None,
                size_bytes: Some(7),
                warning: Some(UNREADABLE_WARNING.into()),
                missing: false,
            },
            texture("camo.tga", 256, 256, "RGB8 RLE", 18, None),
            missing("absent.tga"),
            missing("missing_c.dds"),
            missing("sub/gone.dds"),
            missing("zeta_n.dds"),
            blk_entry("ussr_t_34_85.blk", 28),
        ]
    );
}

#[test]
fn skin_dir_accepts_owned_and_borrowed_refs() {
    let tmp = TempDir::new("refs-types");
    tmp.write("hull_c.dds", &fixture_bytes("dxt1_512.dds"));
    let owned: Vec<String> = vec!["hull_c".into(), "turret_c".into()];
    let borrowed: [&str; 0] = [];
    assert_eq!(files(&inspect_skin_dir(tmp.path(), &owned).unwrap()), ["hull_c.dds", "turret_c.dds"]);
    assert_eq!(files(&inspect_skin_dir(tmp.path(), &borrowed).unwrap()), ["hull_c.dds"]);
}

#[test]
fn a_tga_satisfies_a_reference_without_extension() {
    let tmp = TempDir::new("tga-ref");
    tmp.write("cockpit_c.TGA", &fixture_bytes("rgba8_1024.tga"));
    let list = inspect_skin_dir(tmp.path(), &["cockpit_c", "cockpit_c.dds"]).unwrap();
    // `cockpit_c` is there as a .tga; `cockpit_c.dds` names the .dds explicitly and is missing.
    assert_eq!(files(&list), ["cockpit_c.TGA", "cockpit_c.dds"]);
    assert!(list[1].missing);
}

#[test]
fn inspect_skin_reads_the_references_from_its_blk() {
    let tmp = TempDir::new("skin-blk");
    let blk = "// T-34 winter\n\
               replace_tex { from:t=\"t_34_85_body_c*\"; to:t=\"hull_c*\" }\n\
               replace_tex { from:t=\"t_34_85_turret_c*\"; to:t=\"turret_c\" }\n\
               set_tex { to:t=\"decal_c.tga\" }\n\
               unknown_block { to:t=\"not_a_reference\" }\n";
    tmp.write("ussr_t_34_85.blk", blk.as_bytes());
    tmp.write("hull_c.dds", &fixture_bytes("bc7_4096.dds"));
    tmp.write("Turret_C.dds", &fixture_bytes("bc5_2048.dds"));
    let list = inspect_skin(tmp.path()).unwrap();
    assert_eq!(
        list,
        vec![
            texture("hull_c.dds", 4096, 4096, "BC7", 148, None),
            texture("Turret_C.dds", 2048, 2048, "BC5", 128, None),
            missing("decal_c.tga"),
            blk_entry("ussr_t_34_85.blk", blk.len() as u64),
        ]
    );
}

#[test]
fn inspect_skin_picks_the_alphabetically_first_blk() {
    let tmp = TempDir::new("two-blks");
    tmp.write("b_vehicle.blk", b"replace_tex { to:t=\"from_b\" }");
    tmp.write("A_vehicle.BLK", b"replace_tex { to:t=\"from_a\" }");
    assert_eq!(files(&inspect_skin(tmp.path()).unwrap()), ["from_a.dds", "A_vehicle.BLK"]);
}

#[test]
fn an_unreadable_blk_references_nothing_but_is_still_listed() {
    let tmp = TempDir::new("bad-blk");
    let unclosed = b"replace_tex { to:t=\"hull_c\" ";
    tmp.write("us_m1a2_sep.blk", unclosed);
    tmp.write("hull_n.dds", &fixture_bytes("bc5_2048.dds"));
    assert_eq!(
        inspect_skin(tmp.path()).unwrap(),
        vec![texture("hull_n.dds", 2048, 2048, "BC5", 128, None), blk_entry("us_m1a2_sep.blk", unclosed.len() as u64)]
    );
    assert!(read_blk_refs(&tmp.path().join("us_m1a2_sep.blk")).is_err());
}

#[test]
fn a_folder_without_blk_lists_only_its_textures() {
    let tmp = TempDir::new("no-blk");
    tmp.write("z.tga", &fixture_bytes("rgba8_1024.tga"));
    tmp.write("a.dds", &fixture_bytes("dxt1_512.dds"));
    assert_eq!(files(&inspect_skin(tmp.path()).unwrap()), ["a.dds", "z.tga"]);
    assert_eq!(inspect_skin(&tmp.path().join("nothing")).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn an_empty_folder_has_an_empty_list() {
    let tmp = TempDir::new("empty");
    assert!(inspect_skin(tmp.path()).unwrap().is_empty());
    assert_eq!(inspect_skin_dir(tmp.path(), &["a"]).unwrap(), vec![missing("a.dds")]);
}

#[test]
fn a_missing_folder_is_not_found() {
    let tmp = TempDir::new("missing-folder");
    let err = inspect_skin_dir(&tmp.path().join("gone"), &["hull_c"]).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[test]
fn blk_texture_refs_are_raw_in_file_order() {
    let root = blk::parse(
        "replace_tex { from:t=\"a*\"; to:t=\"hull_c*\"; to:t=\"hull_n\" }\n\
         other { to:t=\"skipped\" }\n\
         set_tex { to:t=\"camo.tga\"; size:i=3 }",
    )
    .unwrap();
    assert_eq!(blk_texture_refs(&root), ["hull_c*", "hull_n", "camo.tga"]);
}

#[test]
fn texture_info_wire_shape() {
    let json = serde_json::to_value(vec![
        texture("hull_c.dds", 4096, 4096, "BC7", 148, None),
        missing("turret_c.dds"),
        blk_entry("ussr_t_34_85.blk", 28),
    ])
    .unwrap();
    assert_eq!(
        json,
        serde_json::json!([
            { "file": "hull_c.dds", "width": 4096, "height": 4096, "format": "BC7", "sizeBytes": 148 },
            { "file": "turret_c.dds", "warning": MISSING_WARNING, "missing": true },
            { "file": "ussr_t_34_85.blk", "format": "BLK", "sizeBytes": 28 },
        ])
    );
}

// ── Indexed skins ───────────────────────────────────────────────────────────

#[test]
fn textures_for_skin_finds_active_and_inactive_folders() {
    let tmp = TempDir::new("for-skin");
    let user_skins = tmp.path().join("game").join("UserSkins");
    let active = user_skins.join("Winter T-34");
    let parked = inactive_dir(&user_skins).join("Desert Tiger");
    for (dir, code, texture_file) in [(&active, "ussr_t_34_85", "hull_c.dds"), (&parked, "germ_tiger", "body_c.dds")] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(format!("{code}.blk")), "replace_tex { to:t=\"hull_c\"; to:t=\"body_c\" }").unwrap();
        fs::write(dir.join(texture_file), fixture_bytes("dxt1_512.dds")).unwrap();
    }
    let store = LibraryStore::load(tmp.path().join("data").join("library.json"));
    let index = import_folders(&user_skins, &store, &["Winter T-34".to_owned(), "Desert Tiger".to_owned()]).unwrap();
    let id_of = |folder: &str| index.iter().find(|s| s.folder == folder).unwrap().id.clone();

    let list = textures_for_skin(&user_skins, &store, &id_of("Winter T-34")).unwrap();
    assert_eq!(files(&list), ["hull_c.dds", "body_c.dds", "ussr_t_34_85.blk"]);
    assert_eq!(list[0], texture("hull_c.dds", 512, 512, "BC1", 128, None));
    assert!(list[1].missing);

    let list = textures_for_skin(&user_skins, &store, &id_of("Desert Tiger")).unwrap();
    assert_eq!(files(&list), ["body_c.dds", "hull_c.dds", "germ_tiger.blk"]);

    // The index says active but the folder was parked by hand: still found.
    fs::rename(&active, inactive_dir(&user_skins).join("Winter T-34")).unwrap();
    assert_eq!(textures_for_skin(&user_skins, &store, &id_of("Winter T-34")).unwrap().len(), 3);
}

#[test]
fn textures_for_skin_errors() {
    let tmp = TempDir::new("for-skin-errors");
    let user_skins = tmp.path().join("UserSkins");
    fs::create_dir_all(user_skins.join("Gone Soon")).unwrap();
    fs::write(user_skins.join("Gone Soon").join("su_27.blk"), "").unwrap();
    let store = LibraryStore::load(tmp.path().join("library.json"));
    let index = import_folders(&user_skins, &store, &["Gone Soon".to_owned()]).unwrap();

    let err = textures_for_skin(&user_skins, &store, "s-unknown").unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.detail.as_deref(), Some("s-unknown"));

    fs::remove_dir_all(user_skins.join("Gone Soon")).unwrap();
    let err = textures_for_skin(&user_skins, &store, &index[0].id).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.detail.as_deref(), Some("Gone Soon"));
    // A rescan prunes it; the id is then unknown.
    scan_game(&user_skins, &store).unwrap();
    assert_eq!(textures_for_skin(&user_skins, &store, &index[0].id).unwrap_err().code, ErrorCode::NotFound);
}
