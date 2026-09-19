//! `UserSkins` scan and attention rules, on the committed fixture folders (read-only) and on
//! temp folders for the corner cases.

use livery_lib::library::scan::{scan_dir, scan_skin, DISK_ID_PREFIX, PARTIAL_MARKER};
use livery_lib::library::vehicles::UNKNOWN_NAME;
use livery_lib::model::{Attention, AttentionKind, HangarSkin, Nation, Origin, VehicleType};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("userskins")
}

fn fixture_skins() -> Vec<HangarSkin> {
    scan_dir(&fixtures()).unwrap()
}

fn skin<'a>(skins: &'a [HangarSkin], folder: &str) -> &'a HangarSkin {
    skins.iter().find(|s| s.folder == folder).unwrap_or_else(|| panic!("no skin {folder}"))
}

fn kinds(skin: &HangarSkin) -> Vec<AttentionKind> {
    skin.attention.iter().map(|a| a.kind).collect()
}

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-scan-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn file(&self, rel: &str, contents: &str) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// ── Fixture folders ─────────────────────────────────────────────────────────

#[test]
fn one_skin_per_folder_sorted_skipping_files_and_hidden_folders() {
    let folders: Vec<String> = fixture_skins().into_iter().map(|s| s.folder).collect();
    assert_eq!(
        folders,
        [
            "Berlin 1945",
            "Broken Blk",
            "Flanker Sea Grey",
            "My Test Camo",
            "No Blk Here",
            "template_ussr_t_34_85",
            "Winter Tiger"
        ]
    );
}

#[test]
fn a_complete_skin_needs_no_attention() {
    let skins = fixture_skins();
    let tiger = skin(&skins, "Winter Tiger");
    // Case-insensitive lookups: `tiger_turret_c*` is `Tiger_Turret_C.DDS`; `tiger_camo` is a .tga.
    assert_eq!(tiger.attention, []);
    assert_eq!(tiger.id, format!("{DISK_ID_PREFIX}Winter Tiger"));
    assert_eq!(tiger.name, "Winter Tiger");
    assert_eq!(tiger.origin, Origin::Imported);
    assert!(tiger.active);
    assert!(!tiger.temporary);
    assert_eq!(tiger.author, None);
    assert_eq!(tiger.source_id, None);
    assert_eq!(tiger.vehicle.name, "Tiger II (H)");
    assert_eq!(tiger.vehicle.nation, Nation::Ger);
}

#[test]
fn template_folders_are_mine() {
    let skins = fixture_skins();
    let template = skin(&skins, "template_ussr_t_34_85");
    assert_eq!(template.origin, Origin::Mine);
    assert_eq!(template.attention, []);
    assert_eq!(template.vehicle.code, "ussr_t_34_85");
    assert_eq!(template.vehicle.name, "T-34-85");
}

#[test]
fn missing_texture_names_the_file() {
    let skins = fixture_skins();
    let berlin = skin(&skins, "Berlin 1945");
    assert_eq!(
        berlin.attention,
        [Attention {
            kind: AttentionKind::MissingTexture,
            message: "turret_c.dds is missing".into(),
            file: Some("turret_c.dds".into()),
        }]
    );
}

#[test]
fn unknown_root_block_names_the_blk() {
    let skins = fixture_skins();
    let camo = skin(&skins, "My Test Camo");
    assert_eq!(
        camo.attention,
        [Attention {
            kind: AttentionKind::UnknownBlkBlock,
            message: "germ_leopard_2a6.blk has an unknown block".into(),
            file: Some("germ_leopard_2a6.blk".into()),
        }]
    );
    assert_eq!(camo.vehicle.name, "Leopard 2A6");
}

#[test]
fn unreadable_blk_is_flagged_and_says_why() {
    let skins = fixture_skins();
    let broken = skin(&skins, "Broken Blk");
    assert_eq!(kinds(broken), [AttentionKind::UnreadableBlk]);
    let attention = &broken.attention[0];
    assert_eq!(attention.file.as_deref(), Some("us_m1a2_sep.blk"));
    assert!(attention.message.starts_with("us_m1a2_sep.blk can't be read"), "{}", attention.message);
    assert!(attention.message.contains("line 3, column 8"), "{}", attention.message);
    // The vehicle still comes from the file name.
    assert_eq!(broken.vehicle.name, "M1A2 SEP");
}

#[test]
fn no_blk_means_unknown_vehicle() {
    let skins = fixture_skins();
    let loose = skin(&skins, "No Blk Here");
    assert_eq!(
        loose.attention,
        [Attention {
            kind: AttentionKind::NoBlk,
            message: "no .blk file, so the game can't use it".into(),
            file: None,
        }]
    );
    assert_eq!(loose.vehicle.code, "");
    assert_eq!(loose.vehicle.name, UNKNOWN_NAME);
    assert_eq!((loose.vehicle.nation, loose.vehicle.vehicle_type), (Nation::Unknown, VehicleType::Air));
}

#[test]
fn partial_marker_comes_first() {
    let skins = fixture_skins();
    let flanker = skin(&skins, "Flanker Sea Grey");
    assert_eq!(
        flanker.attention,
        [
            Attention {
                kind: AttentionKind::PartialExtract,
                message: "archive was only partially extracted".into(),
                file: None,
            },
            Attention {
                kind: AttentionKind::MissingTexture,
                message: "su27_tail_c.dds is missing".into(),
                file: Some("su27_tail_c.dds".into()),
            },
        ]
    );
    assert_eq!((flanker.vehicle.name.as_str(), flanker.vehicle.vehicle_type), ("Su-27", VehicleType::Air));
}

#[test]
fn size_is_recursive_and_installed_at_is_rfc3339() {
    let skins = fixture_skins();
    let tiger = skin(&skins, "Winter Tiger");
    // Sizes depend on the checkout's line endings; compare with what is on disk.
    let dir = fixtures().join("Winter Tiger");
    let on_disk: u64 =
        ["germ_pzkpfw_VI_ausf_b_tiger_IIH.blk", "tiger_body_c.dds", "Tiger_Turret_C.DDS", "tiger_camo.tga"]
            .iter()
            .map(|f| fs::metadata(dir.join(f)).unwrap().len())
            .sum::<u64>()
            + fs::metadata(dir.join("extras").join("readme.txt")).unwrap().len();
    assert_eq!(tiger.size_bytes, on_disk);

    for s in &skins {
        let t = s.installed_at.as_bytes();
        assert_eq!(t.len(), 20, "{}", s.installed_at);
        assert!(s.installed_at.ends_with('Z') && t[4] == b'-' && t[10] == b'T', "{}", s.installed_at);
    }
}

// ── Temp folders ────────────────────────────────────────────────────────────

#[test]
fn missing_user_skins_is_empty_and_non_skins_are_none() {
    let tmp = TempDir::new("missing");
    assert_eq!(scan_dir(&tmp.path().join("UserSkins")).unwrap(), []);
    let file = tmp.file("UserSkins/readme.txt", "x");
    assert_eq!(scan_skin(&file), None);
    assert_eq!(scan_skin(&tmp.path().join("UserSkins").join("gone")), None);
    tmp.file("UserSkins/.git/config", "x");
    assert_eq!(scan_skin(&tmp.path().join("UserSkins").join(".git")), None);
}

#[test]
fn several_blks_the_alphabetically_first_wins() {
    let tmp = TempDir::new("multi");
    tmp.file("Two/ussr_t_34_85.blk", "replace_tex{ to:t=\"a.dds\" }");
    tmp.file("Two/F_4E.BLK", "");
    tmp.file("Two/a.dds", "x");
    let skin = scan_skin(&tmp.path().join("Two")).unwrap();
    assert_eq!(skin.vehicle.code, "f_4e", "F_4E.BLK sorts first, case-insensitively");
    assert_eq!(skin.attention, []);
}

#[test]
fn blk_in_a_sub_folder_does_not_count() {
    let tmp = TempDir::new("nested");
    tmp.file("Nested/inner/su_27.blk", "");
    let skin = scan_skin(&tmp.path().join("Nested")).unwrap();
    assert_eq!(skin.attention.iter().map(|a| a.kind).collect::<Vec<_>>(), [AttentionKind::NoBlk]);
    assert_eq!(skin.size_bytes, 0);
}

#[test]
fn texture_references_are_normalised() {
    let tmp = TempDir::new("refs");
    tmp.file(
        "Refs/germ_leopard_2a6.blk",
        r#"
        replace_tex{ from:t="a*"; to:t="body_c*" }        // no extension: .dds…
        replace_tex{ from:t="b*"; to:t="TRACKS_C" }       // …or .tga, any case
        replace_tex{ from:t="c*"; to:t="sub\detail_n.dds" } // sub-folder, backslash
        replace_tex{ from:t="d*"; to:t="" }               // nothing referenced
        set_tex{ from:t="e*"; to:t="body_c*"; param:t="camo_skin_tex" } // repeat: once
        set_tex{ from:t="f*"; to:t="gone.png*" }          // has an extension: exact
        set_tex{ from:t="g*"; to:t="gone*" }
        set_tex{ from:t="h*"; to:t="Gone*" }              // same file, other case: once
        "#,
    );
    tmp.file("Refs/Body_C.dds", "x");
    tmp.file("Refs/tracks_c.tga", "x");
    tmp.file("Refs/sub/Detail_N.dds", "x");
    tmp.file("Refs/gone.dds", "x");
    let skin = scan_skin(&tmp.path().join("Refs")).unwrap();
    let missing: Vec<&str> = skin.attention.iter().filter_map(|a| a.file.as_deref()).collect();
    assert_eq!(missing, ["gone.png"]);
    assert_eq!(skin.size_bytes, fs::metadata(tmp.path().join("Refs/germ_leopard_2a6.blk")).unwrap().len() + 4);
}

#[test]
fn only_replace_tex_and_set_tex_are_known_root_blocks() {
    let tmp = TempDir::new("blocks");
    tmp.file("Params/su_27.blk", "name:t=\"user\"\nsome_param:i=3\nreplace_tex{ to:t=\"a.dds\" }");
    tmp.file("Params/a.dds", "x");
    tmp.file("Cased/su_27.blk", "Replace_Tex{ to:t=\"a.dds\" }\nextra{}\nmore{}");
    tmp.file("Cased/a.dds", "x");
    let params = scan_skin(&tmp.path().join("Params")).unwrap();
    assert_eq!(params.attention, [], "root params are fine");
    let cased = scan_skin(&tmp.path().join("Cased")).unwrap();
    // Block names are case-sensitive, and several unknown blocks give one entry.
    assert_eq!(cased.attention.iter().map(|a| a.kind).collect::<Vec<_>>(), [AttentionKind::UnknownBlkBlock]);
}

#[test]
fn partial_marker_alone() {
    let tmp = TempDir::new("partial");
    tmp.file("Half/su_27.blk", "");
    tmp.file(&format!("Half/{PARTIAL_MARKER}"), "");
    let skin = scan_skin(&tmp.path().join("Half")).unwrap();
    assert_eq!(skin.attention.iter().map(|a| a.kind).collect::<Vec<_>>(), [AttentionKind::PartialExtract]);
}

#[test]
fn template_folder_without_blk_still_names_the_vehicle() {
    let tmp = TempDir::new("template");
    tmp.file("template_f_4e/readme.txt", "x");
    tmp.file("TEMPLATE_germ_maus/readme.txt", "x");
    let skins = scan_dir(tmp.path()).unwrap();
    let f4 = skin(&skins, "template_f_4e");
    assert_eq!((f4.origin, f4.vehicle.name.as_str()), (Origin::Mine, "F-4E Phantom II"));
    assert_eq!(kinds(f4), [AttentionKind::NoBlk]);
    let maus = skin(&skins, "TEMPLATE_germ_maus");
    assert_eq!((maus.origin, maus.vehicle.nation), (Origin::Mine, Nation::Ger));
}

/// Manual, read-only check on this machine: `cargo test --test library_scan -- --ignored --nocapture`.
#[test]
#[ignore = "reads the real War Thunder install"]
fn scans_real_install() {
    use livery_lib::game::{detect, root, DetectInputs};
    let detection = detect(&DetectInputs::from_system(None), |_| {});
    let Some(path) = detection.path else {
        println!("War Thunder not found");
        return;
    };
    let skins = scan_dir(&root::user_skins_dir(Path::new(&path))).unwrap();
    println!("{} skins in UserSkins", skins.len());
    for s in &skins {
        println!("  {} · {} ({:?}) · {} B · {:?}", s.folder, s.vehicle.name, s.origin, s.size_bytes, kinds(s));
    }
}
