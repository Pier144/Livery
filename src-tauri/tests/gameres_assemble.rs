//! The game-resource index and the assembled vehicle model on a synthetic game root: an
//! `aces.vromfs.bin` with tankmodels BLKs, `grp_hdr.vromfs.bin` header copies, a `.grp` with a
//! DynModel and skeleton, raw DXT5 `.dxp.bin` packs and a `dynModelDesc.bin`.

mod common;

use common::gameres::{
    dxp_bytes, dxp_cache, dynmodel_bytes, grp_bytes, grp_cache, skeleton_bytes, Ib, TElem, TModel, TNode, TRigid, TTex,
    TVdata, TVertex, TexPack,
};
use common::{b, fat_blk, name_map, slim_blk, vromfs, V};
use livery_lib::error::ErrorCode;
use livery_lib::game::gameres::assemble::{self, PartGroup};
use livery_lib::game::gameres::grp::{DYN_MODEL, GEOM_NODE_TREE};
use livery_lib::game::gameres::index::{self, GameResIndex, IndexStore};
use livery_lib::game::gameres::{desc, MODEL_NOT_FOUND, TEXTURE_NOT_FOUND, TEXTURE_OVERRIDES};
use livery_lib::game::vromfs::NAME_MAP_FILE;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-assemble-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn write(&self, rel: &str, bytes: &[u8]) {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const NAMES: &[&str] =
    &["model", "default_skin", "set_tex", "from", "to", "param", "user_skin", "replace_tex", "name", "skin"];

/// The tankmodels BLKs: a plain vehicle, one that sets its own `_c` textures (Cobra King style),
/// one that only touches them in `user_skin` and an alternative `skin`, an upper-case file name and a
/// weapon preset in a subfolder (not a vehicle).
fn aces() -> Vec<u8> {
    let plain = slim_blk(&b("", vec![("model", V::Str("tank_a"))], vec![]), NAMES);
    let king = slim_blk(
        &b(
            "",
            vec![("model", V::Str("tank_a"))],
            vec![b(
                "default_skin",
                vec![],
                vec![b(
                    "set_tex",
                    vec![
                        ("from", V::Str("tank_a_body_c*")),
                        ("to", V::Str("tank_a_king_body_c*")),
                        ("param", V::Str("camo_skin_tex")),
                    ],
                    vec![],
                )],
            )],
        ),
        NAMES,
    );
    let skins = slim_blk(
        &b(
            "",
            vec![("model", V::Str("tank_a"))],
            vec![
                b(
                    "user_skin",
                    vec![("name", V::Str("tank_skins"))],
                    vec![b("replace_tex", vec![("from", V::Str("tank_a_body_c*"))], vec![])],
                ),
                b(
                    "skin",
                    vec![("name", V::Str("winter"))],
                    vec![
                        b("replace_tex", vec![("from", V::Str("camo*")), ("to", V::Str("camo_winter*"))], vec![]),
                        b(
                            "set_tex",
                            vec![("from", V::Str("tank_a_body_c*")), ("to", V::Str("tank_a_winter_c*"))],
                            vec![],
                        ),
                    ],
                ),
                // Camo outside any skin block isn't a `_c` texture either.
                b("default_skin", vec![], vec![b("replace_tex", vec![("from", V::Str("camo*"))], vec![])]),
            ],
        ),
        NAMES,
    );
    let nm = name_map(NAMES);
    vromfs(
        &[
            (NAME_MAP_FILE, &nm),
            ("gamedata/units/tankmodels/tank_a.blk", &plain),
            ("gamedata/units/tankmodels/tank_king.blk", &king),
            ("gamedata/units/tankmodels/tank_skins.blk", &skins),
            ("gamedata/units/tankmodels/Tank_Upper.blk", &plain),
            ("gamedata/units/tankmodels/weaponpresets/tank_a_default.blk", &plain),
        ],
        true,
    )
}

fn vertex(pos: [i16; 3]) -> TVertex {
    TVertex { pos, normal_bgra: [255, 128, 128, 0], uv: [1024, 2048] }
}

fn elem(mat: u32, si: u32, numf: u32) -> TElem {
    TElem { mat, vdata: 0, si, numf, base_vertex: 0 }
}

fn translate(x: f32, y: f32, z: f32) -> [[f32; 4]; 4] {
    [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [x, y, z, 1.0]]
}

/// `tank_a`: a quad on `@root` (body), a triangle on the turret (turret) and one on the gun
/// (body); plus glass and a `_c` texture no pack has, both left out.
fn grp() -> Vec<u8> {
    let model = TModel {
        vdata: vec![TVdata::new(
            vec![vertex([32767, 0, 0]), vertex([0, 32767, 0]), vertex([0, 0, 32767]), vertex([32767, 32767, 32767])],
            vec![0, 1, 2, 2, 1, 3],
            Ib::Packed,
        )],
        lods: vec![vec![
            TRigid { node_id: 0, elems: vec![elem(0, 0, 2), elem(2, 0, 1), elem(3, 0, 1)] },
            TRigid { node_id: 1, elems: vec![elem(1, 0, 1)] },
            TRigid { node_id: 2, elems: vec![elem(0, 3, 1)] },
        ]],
        names: vec![("@root", 0), ("bone_gun", 2), ("bone_turret", 1)],
        offset: [0.0; 3],
        scale: [1.0; 3],
        tag: 0,
        tex_str: None,
    };
    let skeleton = skeleton_bytes(
        &[
            TNode { name: "", parent: None, wtm: translate(0.0, 0.0, 0.0) },
            TNode { name: "bone_turret", parent: Some(0), wtm: translate(0.5, 1.5, 0.0) },
            TNode { name: "bone_gun", parent: Some(1), wtm: translate(2.0, 0.0, 0.0) },
        ],
        false,
    );
    let dm = dynmodel_bytes(&model);
    // `tank_a_dmg`: a model no vehicle names (left out of the index).
    grp_bytes(&[
        (DYN_MODEL, "tank_a", &dm),
        (GEOM_NODE_TREE, "tank_a_skeleton", &skeleton),
        (DYN_MODEL, "tank_a_dmg", &dm),
    ])
}

fn desc_file() -> Vec<u8> {
    let names = &["tank_a", "tex", "matR", "mat", "t0"];
    // Names may differ in case from the packs' (the Tiger II's do).
    let tex = ["tank_a_body_c*", "TANK_A_Turret_C*", "glass*", "tank_a_missing_c*"];
    let root = b(
        "",
        vec![],
        vec![b(
            "tank_a",
            vec![],
            vec![
                b("tex", tex.into_iter().map(|t| ("tex", V::Str(t))).collect(), vec![]),
                b("matR", vec![], (0..4).map(|i| b("mat", vec![("t0", V::Int(i))], vec![])).collect()),
            ],
        )],
    );
    let fat = fat_blk(&root, names);
    let frame = zstd::bulk::compress(&fat, 3).unwrap();
    let mut out = vec![2u8];
    out.extend_from_slice(&(frame.len() as u32).to_le_bytes()[..3]);
    out.extend_from_slice(&frame);
    out
}

/// A DXT5 block: alpha 10, one RGB565 colour.
fn dxt5(c: u16) -> Vec<u8> {
    let mut block = vec![10, 10, 0, 0, 0, 0, 0, 0];
    block.extend_from_slice(&c.to_le_bytes());
    block.extend_from_slice(&c.to_le_bytes());
    block.extend_from_slice(&[0; 4]);
    block
}

fn tex(name: &'static str, w: u16, h: u16, colour: u16) -> TTex {
    let blocks = usize::from(w / 4) * usize::from(h / 4);
    TTex {
        name,
        fourcc: *b"DXT5",
        flags: 0,
        w,
        h,
        levels: 1,
        dxt_shift: 4,
        data: dxt5(colour).repeat(blocks),
        pack: TexPack::Raw,
    }
}

/// RGB565 of (66, 65, 66) after expansion: doubled, (132, 130, 132).
const GREY: u16 = (8 << 11) | (16 << 5) | 8;

/// Writes the whole game root.
fn game() -> TempDir {
    let dir = TempDir::new("game");
    dir.write(index::ACES, &aces());
    let grp = grp();
    dir.write("content/base/res/tanks/tank_a.grp", &grp);
    let base = dxp_bytes(2, &[tex("tank_a_body_c*?q0-1-1u01", 8, 8, GREY), tex("tank_a_body_c$tq*", 4, 4, 0)]);
    dir.write("content/base/res/tanks/tank_a.dxp.bin", &base);
    let other = dxp_bytes(3, &[tex("tank_a_body_c*", 4, 4, 0), tex("tank_a_turret_c*", 4, 4, 0)]);
    dir.write(
        "content/base/res/grp_hdr.vromfs.bin",
        &vromfs(
            &[
                ("tanks/tank_a.grpcache.bin", &grp_cache(&grp)),
                ("tanks/tank_a.dxp.bincache.bin", &dxp_cache(&base)),
                ("tanks/other.dxp.bincache.bin", &dxp_cache(&other)),
            ],
            true,
        ),
    );
    // A 0x0 HQ part (shared textures have some) doesn't count.
    let hq = dxp_bytes(3, &[tex("tank_a_turret_c$hq*", 8, 4, 0xF800), tex("tank_a_body_c$hq*", 0, 0, 0)]);
    dir.write("content.hq/hq_tex/res/hq_tex_tanks/tank_a.dxp.bin", &hq);
    dir.write(
        "content.hq/hq_tex/res/grp_hdr.vromfs.bin",
        &vromfs(&[("hq_tex_tanks/tank_a.dxp.bincache.bin", &dxp_cache(&hq))], false),
    );
    dir.write(desc::DESC, &desc_file());
    dir
}

fn root(dir: &TempDir) -> &Path {
    &dir.0
}

#[test]
fn the_index_maps_vehicles_models_packs_and_textures() {
    let dir = game();
    let index = index::build(root(&dir)).unwrap();
    assert!(index.version.starts_with("aces 2.59.0.65; content/base/res "), "{}", index.version);
    assert!(index.version.contains("; content.hq/hq_tex/res "));
    let mut vehicles: Vec<_> = index.model_of.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    vehicles.sort_unstable();
    assert_eq!(
        vehicles,
        [("tank_a", "tank_a"), ("tank_king", "tank_a"), ("tank_skins", "tank_a"), ("tank_upper", "tank_a")]
    );
    assert_eq!(index.model("TANK_Upper"), Some("tank_a"));
    assert_eq!(index.overrides_of.iter().collect::<Vec<_>>(), ["tank_king"]);
    assert!(index.overrides("Tank_King"));
    assert_eq!(index.grp_of["tank_a"], "content/base/res/tanks/tank_a.grp");
    assert_eq!(index.grp_of.len(), 1, "only models a vehicle uses: {:?}", index.grp_of);

    let body = &index.tex_of["tank_a_body_c"];
    assert_eq!(body.len(), 3, "thumbnails are left out: {body:?}");
    // The texture to read: not the 0x0 HQ part, the largest sized one; any case.
    let best = index.texture("TANK_A_BODY_C").unwrap();
    assert_eq!((best.pack.as_str(), best.w, best.hq), ("content/base/res/tanks/tank_a.dxp.bin", 8, false));
    assert!(index.texture("tank_a_glass").is_none());
    let main = body.iter().find(|t| t.pack == "content/base/res/tanks/tank_a.dxp.bin").unwrap();
    assert_eq!((main.entry.as_str(), main.w, main.h, &main.fourcc), ("tank_a_body_c*?q0-1-1u01", 8, 8, b"DXT5"));
    assert!(!main.hq);
    assert!(body.iter().any(|t| t.pack == "content/base/res/tanks/other.dxp.bin" && t.w == 4));
    let turret = &index.tex_of["tank_a_turret_c"];
    let hq = turret.iter().find(|t| t.hq).unwrap();
    assert_eq!((hq.pack.as_str(), hq.w, hq.h), ("content.hq/hq_tex/res/hq_tex_tanks/tank_a.dxp.bin", 8, 4));
}

#[test]
fn the_model_is_assembled_right_handed_by_node_and_slot() {
    let dir = game();
    let index = index::build(root(&dir)).unwrap();
    let desc = desc::read(root(&dir)).unwrap();
    let m = assemble::load(root(&dir), &index, &desc, "Tank_A").unwrap();
    assert_eq!((m.vehicle.as_str(), m.model.as_str(), m.mirror_axis), ("Tank_A", "tank_a", 2));

    // Slots in order of first use; HQ size when there is one, else the largest pack's.
    let slots: Vec<_> =
        m.slots.iter().map(|s| (s.texture.as_str(), s.width, s.height, s.hq, s.paintable_by_default)).collect();
    assert_eq!(slots, [("tank_a_body_c", 8, 8, false, true), ("TANK_A_Turret_C", 8, 4, true, true)]);

    let parts: Vec<_> =
        m.parts.iter().map(|p| (p.node.as_str(), p.group, p.slot, p.vertex_count, p.index_count)).collect();
    assert_eq!(
        parts,
        [
            ("@root", PartGroup::Hull, 0, 4, 6),
            ("bone_turret", PartGroup::Turret, 1, 3, 3),
            ("bone_gun", PartGroup::Gun, 0, 3, 3)
        ]
    );

    let pos: Vec<[f32; 3]> = m.positions.chunks(3).map(|c| [c[0], c[1], c[2]]).collect();
    assert_eq!(
        pos,
        [
            // Hull (identity), z negated.
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, -1.0],
            [1.0, 1.0, -1.0],
            // Turret, moved by (0.5, 1.5, 0): vertices 0, 1, 2.
            [1.5, 1.5, 0.0],
            [0.5, 2.5, 0.0],
            [0.5, 1.5, -1.0],
            // Gun, moved by (2, 0, 0): vertices 2, 1, 3 (only those its triangle uses).
            [2.0, 0.0, -1.0],
            [2.0, 1.0, 0.0],
            [3.0, 1.0, -1.0],
        ]
    );
    // Winding flipped (2nd and 3rd swapped), absolute into the shared arrays.
    assert_eq!(m.indices, [0, 2, 1, 2, 3, 1, 4, 6, 5, 7, 9, 8]);
    // Normals: placed, normalised, z negated (bytes B,G,R = 255,128,128).
    let n = &m.normals[..3];
    let c = 128.0 / 255.0 * 2.0 - 1.0;
    let len = (2.0 * c * c + 1.0f32).sqrt();
    assert!((n[0] - c / len).abs() < 1e-5 && (n[1] - c / len).abs() < 1e-5 && (n[2] + 1.0 / len).abs() < 1e-5, "{n:?}");
    assert_eq!(&m.uvs[..2], &[0.25, 0.5]);
    assert_eq!((m.normals.len(), m.uvs.len()), (30, 20));
}

#[test]
fn templates_are_the_decoded_textures_doubled() {
    let dir = game();
    let index = index::build(root(&dir)).unwrap();
    let desc = desc::read(root(&dir)).unwrap();
    let m = assemble::load(root(&dir), &index, &desc, "tank_a").unwrap();
    let body = assemble::template_texture(root(&dir), &index, &m.slots[0]).unwrap();
    assert_eq!(body.len(), 8 * 8 * 4);
    assert!(body.chunks(4).all(|p| p == [132, 130, 132, 255]), "{:?}", &body[..4]);
    // The HQ part, red clamped at 255.
    let turret = assemble::template_texture(root(&dir), &index, &m.slots[1]).unwrap();
    assert_eq!(turret.len(), 8 * 4 * 4);
    assert!(turret.chunks(4).all(|p| p == [255, 0, 0, 255]));

    // A pack the index lists but the disk doesn't have.
    fs::remove_file(dir.0.join("content.hq/hq_tex/res/hq_tex_tanks/tank_a.dxp.bin")).unwrap();
    let e = assemble::template_texture(root(&dir), &index, &m.slots[1]).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, TEXTURE_NOT_FOUND));
    let mut slot = m.slots[0].clone();
    slot.texture = "nothing_c".into();
    let e = assemble::template_texture(root(&dir), &index, &slot).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, TEXTURE_NOT_FOUND));
}

#[test]
fn vehicles_that_cant_be_loaded_say_why() {
    let dir = game();
    let index = index::build(root(&dir)).unwrap();
    let desc = desc::read(root(&dir)).unwrap();
    let e = assemble::load(root(&dir), &index, &desc, "tank_king").unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, TEXTURE_OVERRIDES));
    let e = assemble::load(root(&dir), &index, &desc, "tank_nope").unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, MODEL_NOT_FOUND));
    // Only touching `_c` textures inside user_skin is fine.
    assemble::load(root(&dir), &index, &desc, "tank_skins").unwrap();

    // No paintable texture in the packs.
    let mut bare = index.clone();
    bare.tex_of.clear();
    let e = assemble::load(root(&dir), &bare, &desc, "tank_a").unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, TEXTURE_NOT_FOUND));
    // The pack is gone.
    fs::remove_file(dir.0.join("content/base/res/tanks/tank_a.grp")).unwrap();
    let e = assemble::load(root(&dir), &index, &desc, "tank_a").unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, MODEL_NOT_FOUND));
    // A damaged pack.
    dir.write("content/base/res/tanks/tank_a.grp", &grp()[..200]);
    assert_eq!(assemble::load(root(&dir), &index, &desc, "tank_a").unwrap_err().code, ErrorCode::Parse);
}

#[test]
fn encode_writes_the_documented_binary() {
    let dir = game();
    let index = index::build(root(&dir)).unwrap();
    let desc = desc::read(root(&dir)).unwrap();
    let m = assemble::load(root(&dir), &index, &desc, "tank_a").unwrap();
    let bytes = assemble::encode(&m);
    assert_eq!(&bytes[..4], b"LVM1");
    let len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    assert_eq!(len % 4, 0);
    let header: serde_json::Value = serde_json::from_slice(&bytes[8..8 + len]).unwrap();
    assert_eq!(header["vehicle"], "tank_a");
    assert_eq!(header["model"], "tank_a");
    assert_eq!(header["mirrorAxis"], 2);
    assert_eq!((header["vertexCount"].as_u64(), header["indexCount"].as_u64()), (Some(10), Some(12)));
    assert_eq!(
        header["slots"][1],
        serde_json::json!({ "texture": "TANK_A_Turret_C", "width": 8, "height": 4, "hq": true, "paintableByDefault": true })
    );
    assert_eq!(
        header["parts"][2],
        serde_json::json!({ "node": "bone_gun", "group": "gun", "slot": 0, "vertexOffset": 7, "vertexCount": 3, "indexOffset": 9, "indexCount": 3 })
    );
    assert_eq!(header["parts"][1]["group"], "turret");
    assert_eq!(header["parts"][0]["group"], "hull");

    let body = &bytes[8 + len..];
    assert_eq!(body.len(), 4 * (10 * 3 + 10 * 3 + 10 * 2) + 4 * 12);
    let f32_at = |i: usize| f32::from_le_bytes(body[4 * i..4 * i + 4].try_into().unwrap());
    assert_eq!(f32_at(8), -1.0, "positions first: vertex 2's z");
    assert_eq!(f32_at(60), 0.25, "then normals, then UVs");
    let indices: Vec<u32> = body[4 * 80..].chunks(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
    assert_eq!(indices, m.indices);
}

#[test]
fn the_store_caches_by_version() {
    let dir = game();
    let cache = dir.0.join("data/atelier/gameres-index.json");
    let store = IndexStore::new(cache.clone());
    let first = store.get(root(&dir)).unwrap();
    assert!(cache.is_file());
    assert!(std::sync::Arc::ptr_eq(&first, &store.get(root(&dir)).unwrap()), "kept in memory");

    // A new store reads the cached file (here edited, to tell it from a rebuild).
    let mut edited: GameResIndex = serde_json::from_slice(&fs::read(&cache).unwrap()).unwrap();
    edited.model_of.insert("from_cache".into(), "x".into());
    fs::write(&cache, serde_json::to_vec(&edited).unwrap()).unwrap();
    let again = IndexStore::new(cache.clone());
    assert_eq!(again.get(root(&dir)).unwrap().model("from_cache"), Some("x"));

    // A changed header archive (another size) is a new version: rebuilt.
    dir.write("content.hq/hq_tex/res/grp_hdr.vromfs.bin", &vromfs(&[], false));
    let rebuilt = again.get(root(&dir)).unwrap();
    assert_eq!(rebuilt.model("from_cache"), None);
    assert!(!rebuilt.tex_of["tank_a_turret_c"].iter().any(|t| t.hq));
    // `forget` drops the memory copy; the file (now the rebuilt one) still serves.
    again.forget();
    assert_eq!(*again.get(root(&dir)).unwrap(), *rebuilt);
    // An unreadable cache is rebuilt, not an error.
    fs::write(&cache, b"{not json").unwrap();
    assert_eq!(*IndexStore::new(cache).get(root(&dir)).unwrap(), *rebuilt);
}

#[test]
fn body_turret_gun_and_the_models_own_textures_are_paintable_by_default() {
    let model = "m4a3e2_76w_sherman_jumbo";
    for texture in [
        "m4a3e2_sherman_jumbo_body_c",
        "M4A3E2_Sherman_Jumbo_TURRET_C",
        "m4a3e2_76w_sherman_jumbo_gun_c",
        "m4a3e2_76w_sherman_jumbo_armor_c",
    ] {
        assert!(assemble::paintable_by_default(texture, model), "{texture}");
    }
    for texture in
        ["mg_browning_m2hb_mount_c", "us_net_tile_c", "us_sherman_vvss_t_74_phys_track_c", "rifled_barrel_a_c"]
    {
        assert!(!assemble::paintable_by_default(texture, model), "{texture}");
    }
    assert!(assemble::paintable_by_default("pzkpfw_vi_ausf_b_tiger_h_armor_c", "pzkpfw_VI_ausf_B_tiger_h"));
}

#[test]
fn without_aces_there_is_no_index() {
    let dir = TempDir::new("empty");
    assert!(index::build(&dir.0).is_err());
}
