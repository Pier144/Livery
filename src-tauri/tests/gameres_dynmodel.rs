//! DynModel and GeomNodeTree readers on synthetic resources built by `common::gameres` (formats
//! doc sections 2 and 2b): unpacked vertices, index buffers in each storage, LOD 0 only, node
//! names, skeleton parents and matrices, and damaged input.

mod common;

use common::gameres::{dynmodel_bytes, patch_u32, Ib, TElem, TModel, TRigid, TVdata, TVertex, MATVDATA_AT};
use livery_lib::error::{AppError, ErrorCode};
use livery_lib::game::gameres::dynmodel::{self, DynModel};

fn assert_parse<T: std::fmt::Debug>(r: Result<T, AppError>) -> String {
    let e = r.unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse, "{e:?}");
    e.detail.unwrap_or_default()
}

fn vertex(pos: [i16; 3], normal_bgra: [u8; 4], uv: [i16; 2]) -> TVertex {
    TVertex { pos, normal_bgra, uv }
}

/// A quad (two triangles) in vdata 0.
fn quad() -> Vec<TVertex> {
    vec![
        vertex([32767, -32767, 0], [255, 128, 0, 0], [4096, 2048]),
        vertex([0, 0, 0], [0, 0, 255, 0], [0, 0]),
        vertex([-32767, 32767, 32767], [128, 255, 128, 0], [-4096, 8192]),
        vertex([16384, 0, -16384], [0, 255, 0, 0], [1024, 3072]),
    ]
}

fn elem(mat: u32, vdata: u32, si: u32, numf: u32, base_vertex: i32) -> TElem {
    TElem { mat, vdata, si, numf, base_vertex }
}

/// One vdata used by LOD 0 (one rigid, one elem), a second one only LOD 1 uses.
fn model(ib: Ib) -> TModel {
    TModel {
        vdata: vec![TVdata::new(quad(), vec![0, 1, 2, 2, 1, 3], ib), TVdata::new(quad(), vec![0, 1, 2], Ib::U16)],
        lods: vec![
            vec![TRigid { node_id: 1, elems: vec![elem(3, 0, 0, 2, 0)] }],
            vec![TRigid { node_id: 0, elems: vec![elem(0, 1, 0, 1, 0)] }],
        ],
        names: vec![("@root", 0), ("bone_gun", 2), ("bone_turret", 1)],
        offset: [1.0, 1.0, 1.0],
        scale: [2.0, 4.0, 8.0],
        tag: 0,
        tex_str: None,
    }
}

fn parse(m: &TModel) -> DynModel {
    dynmodel::parse(&dynmodel_bytes(m)).unwrap()
}

fn close(a: [f32; 3], b: [f32; 3]) -> bool {
    a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 1e-4)
}

#[test]
fn the_synthetic_model_unpacks_positions_normals_and_uvs() {
    let m = parse(&model(Ib::U16));
    assert_eq!(m.rigids.len(), 1, "LOD 0 only");
    assert_eq!(m.rigids[0].node_id, 1);
    let e = &m.rigids[0].elems[0];
    assert_eq!((e.mat, e.vdata, e.si, e.numf, e.base_vertex), (3, 0, 0, 2, 0));
    assert_eq!(m.vdata.len(), 2);
    let v = &m.vdata[0];
    // s / 32767 * scale + offset.
    assert_eq!(v.positions[0], [3.0, -3.0, 1.0]);
    assert_eq!(v.positions[1], [1.0, 1.0, 1.0]);
    assert_eq!(v.positions[2], [-1.0, 5.0, 9.0]);
    assert!(close(v.positions[3], [1.0 + 2.0 * 16384.0 / 32767.0, 1.0, 1.0 - 8.0 * 16384.0 / 32767.0]));
    // Bytes B,G,R,A -> (R,G,B) / 255 * 2 - 1.
    assert!(close(v.normals[0], [-1.0, 128.0 / 255.0 * 2.0 - 1.0, 1.0]));
    assert_eq!(v.normals[1], [1.0, -1.0, -1.0]);
    // SHORT2 / 4096.
    assert_eq!(v.uvs[0], [1.0, 0.5]);
    assert_eq!(v.uvs[2], [-1.0, 2.0]);
    assert_eq!(v.uvs[3], [0.25, 0.75]);
    assert_eq!(v.indices, [0, 1, 2, 2, 1, 3]);
    assert!(!v.packed_indices);
    assert_eq!(m.vdata[1], Default::default(), "a vdata only LOD 1 uses isn't decoded");
}

#[test]
fn node_names_map_ids_to_names() {
    let m = parse(&model(Ib::U16));
    assert_eq!(m.node_names.len(), 3);
    assert_eq!(m.node_names[&0], "@root");
    assert_eq!(m.node_names[&1], "bone_turret");
    assert_eq!(m.node_names[&2], "bone_gun");
}

#[test]
fn packed_and_32_bit_index_buffers_decode_to_the_same_indices() {
    let raw = parse(&model(Ib::U16));
    for ib in [Ib::U32, Ib::Packed] {
        let m = parse(&model(ib));
        assert_eq!(m.vdata[0].indices, raw.vdata[0].indices, "{ib:?}");
        assert_eq!(m.vdata[0].positions, raw.vdata[0].positions);
        assert_eq!(m.vdata[0].packed_indices, ib == Ib::Packed);
    }
}

#[test]
fn a_large_packed_buffer_decodes() {
    let vertices: Vec<TVertex> = (0..3000).map(|i| vertex([i as i16, 0, 0], [0; 4], [0, 0])).collect();
    let indices: Vec<u32> = (0..2999u32).flat_map(|i| [i, i + 1, (i * 7) % 3000]).collect();
    let mut m = model(Ib::Packed);
    m.vdata[0] = TVdata::new(vertices, indices.clone(), Ib::Packed);
    m.lods[0][0].elems[0].numf = 2999;
    assert_eq!(parse(&m).vdata[0].indices, indices);
}

#[test]
fn zstd_blocks_the_stride_20_layout_and_inline_texture_names_read_the_same() {
    let want = parse(&model(Ib::U16));
    let mut zstd = model(Ib::U16);
    zstd.tag = 1;
    assert_eq!(parse(&zstd), want);
    let mut wide = model(Ib::U16);
    wide.vdata[0].with_tc1 = true;
    assert_eq!(parse(&wide), want);
    let mut tex = model(Ib::U16);
    tex.tex_str = Some(vec![7u8; 37]);
    assert_eq!(parse(&tex), want);
}

#[test]
fn base_vertex_offsets_the_element_indices() {
    let mut m = model(Ib::U16);
    m.vdata[0].indices = vec![0, 1, 0, 1, 0, 1];
    m.lods[0][0].elems = vec![elem(0, 0, 0, 1, 2), elem(1, 0, 3, 1, 1)];
    let parsed = parse(&m);
    let v = &parsed.vdata[0];
    let elems = &parsed.rigids[0].elems;
    assert_eq!(elems[0].vertex_indices(v).collect::<Vec<_>>(), [2, 3, 2]);
    assert_eq!(elems[1].vertex_indices(v).collect::<Vec<_>>(), [2, 1, 2]);
}

#[test]
fn several_rigids_and_elements_keep_their_order() {
    let mut m = model(Ib::U16);
    m.lods[0] = vec![
        TRigid { node_id: 2, elems: vec![elem(5, 0, 3, 1, 0), elem(6, 0, 0, 1, 0)] },
        TRigid { node_id: 0, elems: vec![] },
        TRigid { node_id: 1, elems: vec![elem(7, 0, 0, 2, 0)] },
    ];
    let parsed = parse(&m);
    let ids: Vec<i32> = parsed.rigids.iter().map(|r| r.node_id).collect();
    assert_eq!(ids, [2, 0, 1]);
    let mats: Vec<u32> = parsed.rigids.iter().flat_map(|r| r.elems.iter().map(|e| e.mat)).collect();
    assert_eq!(mats, [5, 6, 7]);
}

#[test]
fn every_truncation_is_an_error() {
    for tag in [0, 1] {
        let mut m = model(Ib::Packed);
        m.tag = tag;
        let bytes = dynmodel_bytes(&m);
        // The bytes after LOD 0's last mesh (LOD 1) aren't read.
        let lod1 = 32 + 32 + (48 + 48);
        for cut in 0..bytes.len() - lod1 {
            assert_parse(dynmodel::parse(&bytes[..cut]));
        }
        dynmodel::parse(&bytes[..bytes.len() - lod1]).unwrap();
    }
}

#[test]
fn an_unknown_vertex_layout_is_refused() {
    // Position as FLOAT3, an unknown data type, and no UV.
    for decl in [
        vec![(2, 0, 0), (4, 1, 0), (6, 3, 0)],
        vec![(10, 0, 0), (4, 1, 0), (30, 5, 0), (6, 3, 0)],
        vec![(10, 0, 0), (4, 1, 0), (6, 3, 1)],
        vec![(10, 0, 0), (4, 1, 0), (6, 3, 0), (3, 5, 0)], // 32 bytes in a 16-byte stride
    ] {
        let mut m = model(Ib::U16);
        m.vdata[0].decl = Some(decl.clone());
        let detail = assert_parse(dynmodel::parse(&dynmodel_bytes(&m)));
        assert!(detail.contains("vertex layout"), "{decl:?}: {detail}");
    }
    // A layout LOD 0 doesn't use isn't looked at.
    let mut m = model(Ib::U16);
    m.vdata[1].decl = Some(vec![(30, 0, 0)]);
    parse(&m);
}

#[test]
fn other_vertex_packings_are_refused() {
    let bytes = dynmodel_bytes(&model(Ib::U16));
    let hdr = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
    for packing in [0, 0x4000_0000, 0x8000_0000, 0xE000_0000] {
        let mut b = bytes.clone();
        patch_u32(&mut b, 16, (hdr & 0x1FFF_FFFF) | packing);
        assert!(assert_parse(dynmodel::parse(&b)).contains("packing"), "{packing:#X}");
    }
}

#[test]
fn limits_and_counts_are_checked() {
    let bytes = dynmodel_bytes(&model(Ib::U16));
    // vdataCount over 64, negative, or different from the header's vdata tab.
    for count in [65u32, u32::MAX, 3, 1] {
        let mut b = bytes.clone();
        patch_u32(&mut b, 12, count);
        assert_parse(dynmodel::parse(&b));
    }
    // vertNum over 4,000,000; one vertex fewer leaves bytes over.
    let vert_num = MATVDATA_AT + 0x20;
    for n in [4_000_001u32, 3] {
        let mut b = bytes.clone();
        patch_u32(&mut b, vert_num, n);
        assert_parse(dynmodel::parse(&b));
    }
    // Negative LODs dump size.
    let mut b = bytes.clone();
    patch_u32(&mut b, 0, u32::MAX);
    assert_parse(dynmodel::parse(&b));
}

#[test]
fn more_than_4096_rigids_is_an_error() {
    let mut m = model(Ib::U16);
    m.lods[0] = (0..4097).map(|_| TRigid { node_id: 0, elems: vec![] }).collect();
    assert!(assert_parse(dynmodel::parse(&dynmodel_bytes(&m))).contains("4097"));
    m.lods[0].pop();
    assert_eq!(parse(&m).rigids.len(), 4096);
}

#[test]
fn elements_outside_their_buffers_are_errors() {
    for bad in [
        elem(0, 0, 0, 3, 0),  // 9 indices of 6
        elem(0, 0, 6, 1, 0),  // starts at the end
        elem(0, 0, 0, 2, 1),  // index 3 + 1 = vertex 4 of 4
        elem(0, 0, 0, 2, -1), // index 0 - 1
        elem(0, 2, 0, 1, 0),  // vdata 2 of 2
        elem(0, 0, u32::MAX >> 1, 1, 0),
    ] {
        let mut m = model(Ib::U16);
        m.lods[0][0].elems = vec![bad];
        assert_parse(dynmodel::parse(&dynmodel_bytes(&m)));
    }
}

#[test]
fn a_model_without_lods_is_an_error() {
    let mut m = model(Ib::U16);
    m.lods.clear();
    assert!(assert_parse(dynmodel::parse(&dynmodel_bytes(&m))).contains("LOD"));
}
