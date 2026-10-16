//! Materials (`dynModelDesc.bin`) and DxP2 texture packs on synthetic files: texture lists and
//! diffuse slots, the pack directory (versions 2 and 3, cache copies), entry names, the top mip
//! level under each storage (raw, zstd, Oodle, reversed mips, generated mips) and damaged packs.

mod common;

use common::gameres::{dxp_bytes, dxp_cache, patch_u32, TTex, TexPack, DXP_ARRAYS_AT};
use common::{b, fat_blk, V};
use livery_lib::error::{AppError, ErrorCode};
use livery_lib::game::binblk::Blk;
use livery_lib::game::gameres::codec;
use livery_lib::game::gameres::desc::{materials, ModelMaterials};
use livery_lib::game::gameres::dxp::{base_name, is_hq, top_level, DxpDir, DxpEntry};
use std::io::Cursor;

fn assert_parse<T: std::fmt::Debug>(r: Result<T, AppError>) -> String {
    let e = r.unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse, "{e:?}");
    e.detail.unwrap_or_default()
}

// ── dynModelDesc.bin ────────────────────────────────────────────────────────

const NAMES: &[&str] = &["tank_a", "tex", "matR", "mat", "cls", "t0", "t1", "tank_b", "matS"];

fn desc_file() -> Vec<u8> {
    let tank_a = b(
        "tank_a",
        vec![],
        vec![
            b(
                "tex",
                vec![
                    ("tex", V::Str("tank_a_body_c*")),
                    ("tex", V::Str("us_camo_olive*")),
                    ("tex", V::Str("tank_a_turret_c*")),
                    ("tex", V::Str("tank_a_body_n*")),
                ],
                vec![],
            ),
            b(
                "matR",
                vec![],
                vec![
                    b(
                        "mat",
                        vec![("cls", V::Str("dynamic_masked_tank")), ("t0", V::Int(0)), ("t1", V::Int(1))],
                        vec![],
                    ),
                    b("mat", vec![("cls", V::Str("dynamic_masked_tank")), ("t0", V::Int(2))], vec![]),
                    b("mat", vec![("cls", V::Str("glass")), ("t0", V::Int(-1))], vec![]),
                    b("mat", vec![("cls", V::Str("no_texture"))], vec![]),
                    b("mat", vec![("t0", V::Int(9))], vec![]),
                    b("mat", vec![("t0", V::Int(0))], vec![]),
                ],
            ),
            b("matS", vec![], vec![b("mat", vec![("t0", V::Int(3))], vec![])]),
        ],
    );
    let tank_b = b("tank_b", vec![], vec![b("tex", vec![("tex", V::Str("tank_b_c*"))], vec![])]);
    fat_blk(&b("", vec![], vec![tank_a, tank_b]), NAMES)
}

/// Kind 2: `u24` packed size, then a zstd frame holding the kind 1 file (what the game ships).
fn kind2(fat: &[u8]) -> Vec<u8> {
    let frame = zstd::bulk::compress(fat, 3).unwrap();
    let mut out = vec![2u8];
    out.extend_from_slice(&(frame.len() as u32).to_le_bytes()[..3]);
    out.extend_from_slice(&frame);
    out
}

#[test]
fn materials_list_textures_and_each_rigid_materials_diffuse() {
    for file in [desc_file(), kind2(&desc_file())] {
        let desc = Blk::parse(&file, None, None).unwrap();
        let m = materials(&desc, "tank_a").unwrap();
        assert_eq!(m.textures, ["tank_a_body_c", "us_camo_olive", "tank_a_turret_c", "tank_a_body_n"]);
        let diffuse: Vec<Option<&str>> = m.diffuse_of_mat.iter().map(|d| d.as_deref()).collect();
        // t0 = 0, 2, -1, missing, out of range, 0; matS isn't read.
        assert_eq!(diffuse, [Some("tank_a_body_c"), Some("tank_a_turret_c"), None, None, None, Some("tank_a_body_c")]);
        assert_eq!(
            materials(&desc, "tank_b").unwrap(),
            ModelMaterials { textures: vec!["tank_b_c".into()], diffuse_of_mat: vec![] }
        );
        assert!(materials(&desc, "tank_c").is_none());
        assert!(materials(&desc, "tex").is_none(), "only top-level model blocks");
    }
}

// ── DxP2 ────────────────────────────────────────────────────────────────────

/// A DXT1 block of one colour (RGB565 `c`, all indices 0).
fn dxt1(c: u16) -> Vec<u8> {
    let mut b = c.to_le_bytes().to_vec();
    b.extend_from_slice(&c.to_le_bytes());
    b.extend_from_slice(&[0; 4]);
    b
}

/// A DXT5 block: alpha `a`, colour `c`.
fn dxt5(a: u8, c: u16) -> Vec<u8> {
    let mut b = vec![a, a, 0, 0, 0, 0, 0, 0];
    b.extend(dxt1(c));
    b
}

fn blocks(n: usize, block: Vec<u8>) -> Vec<u8> {
    block.repeat(n)
}

const GENMIP_KAIZER: u32 = 0x4000;
const REV_MIP_ORDER: u32 = 0x40000;
const HQ_PART: u32 = 0x80000;

/// body 8x8 DXT5 (top 4 blocks then a 1-block mip), its `$hq` part 16x8 DXT1 with reversed mips,
/// gun 4x4 DXT5 with Kaiser mip generation (12 trailing bytes), a BC7 normal map and a thumbnail.
fn textures(pack: TexPack) -> Vec<TTex> {
    let mut body = blocks(4, dxt5(200, 0xF800));
    body.extend(dxt5(10, 0x001F));
    // Smallest first: mip 1 (8x4 = 2x1 blocks), then mip 0 (16x8 = 4x2 blocks).
    let mut hq = blocks(2, dxt1(0x07E0));
    hq.extend(blocks(8, dxt1(0xFFFF)));
    let mut gun = dxt5(255, 0x0000);
    gun.extend_from_slice(&[1; 12]);
    vec![
        TTex {
            name: "tank_a_body_c*?q0-1-1u01",
            fourcc: *b"DXT5",
            flags: 0x11,
            w: 8,
            h: 8,
            levels: 2,
            dxt_shift: 4,
            data: body,
            pack,
        },
        TTex {
            name: "tank_a_body_c$hq*",
            fourcc: *b"DXT1",
            flags: HQ_PART | REV_MIP_ORDER,
            w: 16,
            h: 8,
            levels: 2,
            dxt_shift: 3,
            data: hq,
            pack,
        },
        TTex {
            name: "tank_a_gun_c*",
            fourcc: *b"DXT5",
            flags: GENMIP_KAIZER | REV_MIP_ORDER,
            w: 4,
            h: 4,
            levels: 3,
            dxt_shift: 4,
            data: gun,
            pack,
        },
        TTex {
            name: "tank_a_body_n*",
            fourcc: *b"BC7 ",
            flags: 0,
            w: 4,
            h: 4,
            levels: 1,
            dxt_shift: 4,
            data: vec![0; 16],
            pack,
        },
        TTex {
            name: "tank_a_body_c$tq*",
            fourcc: *b"DXT1",
            flags: 0,
            w: 4,
            h: 4,
            levels: 1,
            dxt_shift: 3,
            data: dxt1(0x1234),
            pack,
        },
    ]
}

fn with_worker() {
    codec::set_worker_exe(env!("CARGO_BIN_EXE_livery"));
}

#[test]
fn the_directory_reads_names_headers_and_records() {
    for version in [2, 3] {
        let file = dxp_bytes(version, &textures(TexPack::Zstd));
        for head in [file.clone(), dxp_cache(&file)] {
            let dir = DxpDir::parse(&head).unwrap();
            let names: Vec<&str> = dir.entries.iter().map(|e| e.name.as_str()).collect();
            assert_eq!(
                names,
                [
                    "tank_a_body_c*?q0-1-1u01",
                    "tank_a_body_c$hq*",
                    "tank_a_gun_c*",
                    "tank_a_body_n*",
                    "tank_a_body_c$tq*"
                ]
            );
            let hq = &dir.entries[1];
            assert_eq!(&hq.header.fourcc, b"DXT1");
            assert_eq!((hq.header.w, hq.header.h, hq.header.levels, hq.header.dxt_shift), (16, 8, 2, 3));
            assert_eq!(hq.header.flags, HQ_PART | REV_MIP_ORDER | 0x2000_0000);
            assert_eq!(hq.header.mem_sz, 80);
            assert!(hq.header.packed_sz > 0);
            assert_eq!(hq.data_size, hq.header.packed_sz);
            assert!(hq.ofs >= dxp_cache(&file).len() as u64);
            assert!(dir.entries.windows(2).all(|w| w[0].ofs < w[1].ofs));
        }
    }
}

#[test]
fn entry_names_split_into_base_name_and_part() {
    assert_eq!(base_name("m4a3e2_sherman_jumbo_body_c*?q0-1-1u01"), "m4a3e2_sherman_jumbo_body_c");
    assert_eq!(base_name("m4a3e2_sherman_jumbo_body_c$hq*"), "m4a3e2_sherman_jumbo_body_c");
    assert_eq!(base_name("m4a3e2_sherman_jumbo_body_c$tq*"), "m4a3e2_sherman_jumbo_body_c");
    assert_eq!(base_name("plain"), "plain");
    assert_eq!(base_name("*"), "");
    assert!(is_hq("m4a3e2_sherman_jumbo_body_c$hq*"));
    assert!(!is_hq("m4a3e2_sherman_jumbo_body_c*?q0-1-1u01"));
    assert!(!is_hq("m4a3e2_sherman_jumbo_body_c$tq*"));
    assert!(!is_hq("tank_hq_c*"), "only the part after the base name counts");
}

#[test]
fn the_top_level_is_found_under_every_storage() {
    with_worker();
    for pack in [TexPack::Raw, TexPack::Zstd, TexPack::Oodle] {
        for version in [2, 3] {
            let file = dxp_bytes(version, &textures(pack));
            let dir = DxpDir::parse(&file).unwrap();
            let mut cur = Cursor::new(&file);
            // Top level first.
            assert_eq!(top_level(&mut cur, &dir.entries[0]).unwrap(), blocks(4, dxt5(200, 0xF800)), "{pack:?}");
            // Reversed: the top level is the last 4x2 blocks.
            assert_eq!(top_level(&mut cur, &dir.entries[1]).unwrap(), blocks(8, dxt1(0xFFFF)), "{pack:?}");
            // Generated mips win over the reversed order: the top level comes first.
            assert_eq!(top_level(&mut cur, &dir.entries[2]).unwrap(), dxt5(255, 0), "{pack:?}");
            assert_eq!(top_level(&mut cur, &dir.entries[4]).unwrap(), dxt1(0x1234), "{pack:?}");
            let detail = assert_parse(top_level(&mut cur, &dir.entries[3]));
            assert!(detail.contains("texture format"), "{detail}");
        }
    }
}

#[test]
fn levels_smaller_than_a_block_take_one_block() {
    let tex = TTex {
        name: "tiny*",
        fourcc: *b"DXT1",
        flags: 0,
        w: 2,
        h: 1,
        levels: 1,
        dxt_shift: 3,
        data: dxt1(7),
        pack: TexPack::Raw,
    };
    let file = dxp_bytes(3, &[tex]);
    let dir = DxpDir::parse(&file).unwrap();
    assert_eq!(top_level(&mut Cursor::new(&file), &dir.entries[0]).unwrap(), dxt1(7));
}

#[test]
fn damaged_directories_are_errors() {
    let file = dxp_bytes(2, &textures(TexPack::Raw));
    let head = dxp_cache(&file);
    for cut in 0..head.len() {
        assert_parse(DxpDir::parse(&head[..cut]));
    }
    let mut cases: Vec<(&str, Vec<u8>)> = Vec::new();
    let mut h = head.clone();
    h[0] = b'X';
    cases.push(("magic", h));
    let mut h = head.clone();
    patch_u32(&mut h, 4, 4);
    cases.push(("version", h));
    let mut h = head.clone();
    // The tabs' counts sit at dump +0x04, +0x14, +0x24 (file +0x10).
    patch_u32(&mut h, 0x10 + 0x14, 4);
    cases.push(("fewer headers than names", h));
    let mut h = head.clone();
    for count in [0x14, 0x24, 0x34] {
        patch_u32(&mut h, count, 0x7FFF_FFFF);
    }
    cases.push(("huge count", h));
    // Version 2 records start after the name pointers and headers; ofs is at +12.
    let mut h = head.clone();
    patch_u32(&mut h, DXP_ARRAYS_AT + 5 * 8 + 5 * 32 + 12, 0x8000_0000);
    cases.push(("negative offset", h));
    for (what, h) in cases {
        let r = DxpDir::parse(&h);
        assert!(r.as_ref().is_err_and(|e| e.code == ErrorCode::Parse), "{what}: {r:?}");
    }
}

#[test]
fn damaged_texture_data_is_an_error() {
    with_worker();
    for pack in [TexPack::Raw, TexPack::Zstd, TexPack::Oodle] {
        let file = dxp_bytes(3, &textures(pack));
        let dir = DxpDir::parse(&file).unwrap();
        let body = &dir.entries[0];
        // The file ends inside the texture's data.
        let cut = &file[..body.ofs as usize + body.data_size as usize - 1];
        assert_parse(top_level(&mut Cursor::new(cut), body));
        // Unpacked bytes too few for the top level.
        let mut small = body.clone();
        small.header.w = 16;
        assert_parse(top_level(&mut Cursor::new(&file), &small));
        // Another compression (7zip), a block shift that doesn't match the format, no size.
        let changes: [fn(&mut DxpEntry); 4] = [
            |e| e.header.flags = 0x4000_0000,
            |e| e.header.dxt_shift = 3,
            |e| e.header.h = 0,
            |e| e.data_size = u32::MAX,
        ];
        for change in changes {
            let mut e = body.clone();
            change(&mut e);
            assert_parse(top_level(&mut Cursor::new(&file), &e));
        }
    }
    // A compressed stream unpacking to a different size than the header says.
    let file = dxp_bytes(3, &textures(TexPack::Zstd));
    let dir = DxpDir::parse(&file).unwrap();
    let mut e = dir.entries[0].clone();
    e.header.mem_sz += 16;
    assert_parse(top_level(&mut Cursor::new(&file), &e));
}
