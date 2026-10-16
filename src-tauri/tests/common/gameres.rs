//! Builders for the game-resource formats (GRP2 packs and what they hold), following
//! docs/superpowers/specs/2026-10-16-atelier-phase0-formats.md. The inverse of
//! `livery_lib::game::gameres`, so synthetic packs can stand in for Gaijin's files.

/// A GRP2 (or `magic`) pack: header, the three PatchableTabs, the name map and resource table,
/// the names, then every resource's bytes (16-byte aligned). A resource with no data (an empty
/// slice) gets offset 0, as the engine writes for resources without a payload.
///
/// ```text
/// 0x00 magic | u32 descOnlySize | u32 fullDataSize | u32 restFileSize (file size - 16)
/// 0x10 nameMap tab | resTable tab | resData tab (always empty here)
/// ```
pub fn grp_with_magic(magic: &[u8; 4], resources: &[(u32, &str, &[u8])]) -> Vec<u8> {
    let count = resources.len();
    let name_map_at = 0x40;
    let res_table_at = name_map_at + 4 * count;
    let names_at = res_table_at + 12 * count;
    let mut desc = vec![0u8; names_at];
    let mut name_offsets = Vec::new();
    for (_, name, _) in resources {
        name_offsets.push(desc.len() as i32);
        desc.extend_from_slice(name.as_bytes());
        desc.push(0);
    }
    let desc_end = desc.len();
    let mut file = desc;
    let mut data_offsets = Vec::new();
    for (_, _, data) in resources {
        if data.is_empty() {
            data_offsets.push(0u32);
            continue;
        }
        while file.len() % 16 != 0 {
            file.push(0);
        }
        data_offsets.push(file.len() as u32);
        file.extend_from_slice(data);
    }
    file[0..4].copy_from_slice(magic);
    file[4..8].copy_from_slice(&(desc_end as u32 - 16).to_le_bytes());
    file[8..12].copy_from_slice(&(desc_end as u32 - 16).to_le_bytes());
    let rest = file.len() as u32 - 16;
    file[12..16].copy_from_slice(&rest.to_le_bytes());
    // nameMap tab, resTable tab; the resData tab (0x30) stays empty.
    file[0x10..0x14].copy_from_slice(&(name_map_at as u32).to_le_bytes());
    file[0x14..0x18].copy_from_slice(&(count as u32).to_le_bytes());
    file[0x20..0x24].copy_from_slice(&(res_table_at as u32).to_le_bytes());
    file[0x24..0x28].copy_from_slice(&(count as u32).to_le_bytes());
    for (i, offset) in name_offsets.iter().enumerate() {
        file[name_map_at + 4 * i..name_map_at + 4 * i + 4].copy_from_slice(&offset.to_le_bytes());
    }
    for (i, (class_id, _, _)) in resources.iter().enumerate() {
        let at = res_table_at + 12 * i;
        file[at..at + 4].copy_from_slice(&class_id.to_le_bytes());
        file[at + 4..at + 8].copy_from_slice(&data_offsets[i].to_le_bytes());
        file[at + 8..at + 10].copy_from_slice(&(i as u16).to_le_bytes());
    }
    file
}

/// A `GRP2` pack, see [`grp_with_magic`].
pub fn grp_bytes(resources: &[(u32, &str, &[u8])]) -> Vec<u8> {
    grp_with_magic(b"GRP2", resources)
}

/// What `grp_hdr.vromfs.bin` stores for a pack (`.grpcache.bin`): its first `fullDataSize + 16` bytes.
pub fn grp_cache(file: &[u8]) -> Vec<u8> {
    let full = u32::from_le_bytes(file[8..12].try_into().unwrap()) as usize;
    file[..16 + full].to_vec()
}

// ── DynModel ────────────────────────────────────────────────────────────────

/// A vertex as the stride-16 layout stores it: POS SHORT4N (w = 32767), NORM E3DCOLOR (bytes
/// B,G,R,A), TC0 SHORT2 (UV * 4096).
#[derive(Debug, Clone, Copy)]
pub struct TVertex {
    pub pos: [i16; 3],
    pub normal_bgra: [u8; 4],
    pub uv: [i16; 2],
}

/// How a vdata's index buffer is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ib {
    /// Raw 16-bit indices (flag I16).
    U16,
    /// Raw 32-bit indices (flag I32).
    U32,
    /// 16-bit indices, meshoptimizer-packed (flags I16 | PACKED_IB).
    Packed,
}

pub struct TVdata {
    pub vertices: Vec<TVertex>,
    pub indices: Vec<u32>,
    pub ib: Ib,
    /// The stride-20 layout: TC1 SHORT2 (written as zeros) before the stride-16 channels.
    pub with_tc1: bool,
    /// Replaces the vertex declaration ((VSDT code, usage, usage index) per channel); the vertex
    /// bytes stay those of the layout above.
    pub decl: Option<Vec<(u32, i32, i16)>>,
}

impl TVdata {
    pub fn new(vertices: Vec<TVertex>, indices: Vec<u32>, ib: Ib) -> Self {
        Self { vertices, indices, ib, with_tc1: false, decl: None }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TElem {
    pub mat: u32,
    pub vdata: u32,
    pub si: u32,
    pub numf: u32,
    pub base_vertex: i32,
}

pub struct TRigid {
    pub node_id: i32,
    pub elems: Vec<TElem>,
}

pub struct TModel {
    pub vdata: Vec<TVdata>,
    /// LOD 0 first.
    pub lods: Vec<Vec<TRigid>>,
    /// (name, node id) in the order the names dump lists them (the game sorts them).
    pub names: Vec<(&'static str, u16)>,
    /// bpC254 (position offset) and bpC255 (position scale).
    pub offset: [f32; 3],
    pub scale: [f32; 3],
    /// Tag of the vertex data block: 0 none, 1 zstd.
    pub tag: u32,
    /// Inline texture names (texCount != -1): the payload after `i32 sz`.
    pub tex_str: Option<Vec<u8>>,
}

/// Where the matVdata header starts in a model built with no `tex_str`: after the five header
/// ints and the block word. With `tag: 0` the header is stored as is, so its fields can be
/// patched there: the vdata tab at +0x10, the first VdataHdr at +0x20.
pub const MATVDATA_AT: usize = 24;

/// A 16-byte PatchableTab.
fn tab(out: &mut Vec<u8>, ofs: usize, count: usize) {
    out.extend_from_slice(&(ofs as u32).to_le_bytes());
    out.extend_from_slice(&(count as u32).to_le_bytes());
    out.extend_from_slice(&[0u8; 8]);
}

/// meshoptimizer's index-sequence encoding (version 1, every index coded against `last[0]`).
pub fn meshopt_encode(indices: &[u32]) -> Vec<u8> {
    let mut out = vec![0xD1];
    let mut last = 0u32;
    for &idx in indices {
        let d = idx.wrapping_sub(last) as i32;
        let mut v = (((d << 1) ^ (d >> 31)) as u32) << 1;
        last = idx;
        loop {
            let low = (v & 0x7F) as u8;
            v >>= 7;
            if v == 0 {
                out.push(low);
                break;
            }
            out.push(low | 0x80);
        }
    }
    out.extend_from_slice(&[0; 4]);
    out
}

/// The unpacked matVdata buffer and its header size: `mat` tab (empty), `vdata` tab, the
/// 32-byte VdataHdrs, the vertex declarations, then each vdata's vertex and index buffers.
fn matvdata(vdata: &[TVdata]) -> (Vec<u8>, usize) {
    let mut h = Vec::new();
    tab(&mut h, 0, 0);
    tab(&mut h, 0x20, vdata.len());
    let decls: Vec<Vec<(u32, i32, i16)>> = vdata
        .iter()
        .map(|v| {
            v.decl.clone().unwrap_or_else(|| {
                let mut d = Vec::new();
                if v.with_tc1 {
                    d.push((6, 3, 1));
                }
                d.extend([(10, 0, 0), (4, 1, 0), (6, 3, 0)]);
                d
            })
        })
        .collect();
    let mut decl_at = 0x20 + 32 * vdata.len();
    let mut buffers = Vec::new();
    for (v, decl) in vdata.iter().zip(&decls) {
        let stride: u32 = if v.with_tc1 { 20 } else { 16 };
        let mut vb = Vec::new();
        for vert in &v.vertices {
            if v.with_tc1 {
                vb.extend_from_slice(&[0u8; 4]);
            }
            for c in vert.pos.iter().chain(&[32767]) {
                vb.extend_from_slice(&c.to_le_bytes());
            }
            vb.extend_from_slice(&vert.normal_bgra);
            for c in vert.uv {
                vb.extend_from_slice(&c.to_le_bytes());
            }
        }
        let (flags, idx_size, ib): (u32, usize, Vec<u8>) = match v.ib {
            Ib::U16 => (0x20, 2 * v.indices.len(), v.indices.iter().flat_map(|&i| (i as u16).to_le_bytes()).collect()),
            Ib::U32 => (0x40, 4 * v.indices.len(), v.indices.iter().flat_map(|&i| i.to_le_bytes()).collect()),
            Ib::Packed => (0x220, 2 * v.indices.len(), meshopt_encode(&v.indices)),
        };
        let packed = if v.ib == Ib::Packed { ib.len() as u32 } else { 0 };
        h.extend_from_slice(&(v.vertices.len() as u32).to_le_bytes());
        h.extend_from_slice(&(stride | ((packed & 0xFF_FFFF) << 8)).to_le_bytes());
        h.extend_from_slice(&(idx_size as u32 | ((packed >> 24) << 28)).to_le_bytes());
        h.extend_from_slice(&flags.to_le_bytes());
        tab(&mut h, decl_at, decl.len());
        decl_at += 12 * decl.len();
        buffers.push((vb, ib));
    }
    for decl in &decls {
        for &(code, usage, index) in decl {
            h.extend_from_slice(&(code << 16).to_le_bytes());
            h.extend_from_slice(&usage.to_le_bytes());
            h.extend_from_slice(&index.to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
        }
    }
    let hdr_sz = h.len();
    for (vb, ib) in buffers {
        h.extend_from_slice(&vb);
        h.extend_from_slice(&ib);
    }
    (h, hdr_sz)
}

/// A DynModel resource, following the formats doc section 2 (see [`TModel`]): header ints,
/// [TexStr], the matVdata block, the LODs dump, the names dump, then per LOD its scene dump and
/// one ShaderMesh dump per rigid.
pub fn dynmodel_bytes(m: &TModel) -> Vec<u8> {
    let (raw, hdr_sz) = matvdata(&m.vdata);
    let block = match m.tag {
        0 => raw,
        1 => zstd::bulk::compress(&raw, 3).unwrap(),
        other => panic!("tag {other}"),
    };

    let mut scenes = Vec::new();
    for rigids in &m.lods {
        let meshes: Vec<Vec<u8>> = rigids
            .iter()
            .map(|r| {
                let mut mesh = Vec::new();
                tab(&mut mesh, 0x30, r.elems.len());
                mesh.extend_from_slice(&[0u8; 16]); // stageEndElemIdx
                mesh.extend_from_slice(&0x8000_0001u32.to_le_bytes()); // maxMatPass
                mesh.extend_from_slice(&[0u8; 12]);
                for e in &r.elems {
                    for v in [0u64, u64::from(e.mat), u64::from(e.vdata)] {
                        mesh.extend_from_slice(&v.to_le_bytes());
                    }
                    for v in [0i32, 0, 0, e.si as i32, e.numf as i32, e.base_vertex] {
                        mesh.extend_from_slice(&v.to_le_bytes());
                    }
                }
                mesh
            })
            .collect();
        let mut scene = Vec::new();
        tab(&mut scene, 0x20, rigids.len());
        tab(&mut scene, 0, 0); // skins
        for (r, mesh) in rigids.iter().zip(&meshes) {
            scene.extend_from_slice(&(mesh.len() as u32).to_le_bytes());
            scene.extend_from_slice(&[0u8; 4]);
            scene.extend_from_slice(&[0u8; 16]); // bounding sphere
            scene.extend_from_slice(&r.node_id.to_le_bytes());
            scene.extend_from_slice(&0u32.to_le_bytes());
        }
        scenes.push((scene, meshes));
    }

    let mut lods = Vec::new();
    tab(&mut lods, 0x48, m.lods.len());
    lods.extend_from_slice(&[0u8; 24]); // bbox
    for v in m.offset.iter().chain(&[0.0]).chain(&m.scale).chain(&[0.0]) {
        lods.extend_from_slice(&v.to_le_bytes());
    }
    for (i, (scene, _)) in scenes.iter().enumerate() {
        lods.extend_from_slice(&(scene.len() as u32).to_le_bytes());
        lods.extend_from_slice(&[0u8; 4]);
        lods.extend_from_slice(&(100.0f32 * (i + 1) as f32).to_le_bytes());
        lods.extend_from_slice(&1.0f32.to_le_bytes());
    }

    let mut names = Vec::new();
    let n = m.names.len();
    tab(&mut names, 0x20, n);
    tab(&mut names, 0x20 + 8 * n, n);
    let mut strings_at = 0x20 + 8 * n + 2 * n;
    for (name, _) in &m.names {
        names.extend_from_slice(&(strings_at as u64).to_le_bytes());
        strings_at += name.len() + 1;
    }
    for (_, id) in &m.names {
        names.extend_from_slice(&id.to_le_bytes());
    }
    for (name, _) in &m.names {
        names.extend_from_slice(name.as_bytes());
        names.push(0);
    }

    let mut out = Vec::new();
    out.extend_from_slice(&(lods.len() as i32).to_le_bytes());
    let tex_count: i32 = if m.tex_str.is_some() { 1 } else { -1 };
    out.extend_from_slice(&tex_count.to_le_bytes());
    out.extend_from_slice(&(-1i32).to_le_bytes());
    out.extend_from_slice(&(m.vdata.len() as i32).to_le_bytes());
    out.extend_from_slice(&(0xC000_0000u32 | hdr_sz as u32).to_le_bytes());
    if let Some(tex) = &m.tex_str {
        out.extend_from_slice(&(tex.len() as i32).to_le_bytes());
        out.extend_from_slice(tex);
    }
    out.extend_from_slice(&((m.tag << 30) | block.len() as u32).to_le_bytes());
    out.extend_from_slice(&block);
    out.extend_from_slice(&lods);
    out.extend_from_slice(&(names.len() as i32).to_le_bytes());
    out.extend_from_slice(&names);
    for (scene, meshes) in scenes {
        out.extend_from_slice(&scene);
        for mesh in meshes {
            out.extend_from_slice(&mesh);
        }
    }
    out
}

// ── GeomNodeTree ────────────────────────────────────────────────────────────

pub struct TNode {
    pub name: &'static str,
    pub parent: Option<usize>,
    /// Model-space matrix as 4 columns (the 4th is the translation).
    pub wtm: [[f32; 4]; 4],
}

/// Bytes before a skeleton's dump (`u32 a`, `u32 n`) when it is stored uncompressed.
pub const SKELETON_DUMP_AT: usize = 8;

/// A GeomNodeTree resource (formats doc section 2b): `u32 a` (dump size), `u32 n` (bit 31 =
/// compressed), then the dump (stored, or a zstd IGenLoad block when `zstd`): `n` x 160-byte
/// nodes (tm = wtm here, wtm, child tab, parent ptr, name ptr), then the names. Each node's
/// children must be contiguous (the game stores the tree breadth-first).
pub fn skeleton_bytes(nodes: &[TNode], zstd: bool) -> Vec<u8> {
    let n = nodes.len();
    let mut dump = Vec::new();
    let mut name_at = 160 * n;
    for (i, node) in nodes.iter().enumerate() {
        for _ in 0..2 {
            for column in node.wtm {
                for v in column {
                    dump.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        let children: Vec<usize> = (0..n).filter(|&j| nodes[j].parent == Some(i)).collect();
        if let (Some(&first), Some(&last)) = (children.first(), children.last()) {
            assert_eq!(last - first + 1, children.len(), "node {i}: children must be contiguous");
        }
        tab(&mut dump, 160 * children.first().copied().unwrap_or(0), children.len());
        dump.extend_from_slice(&((160 * node.parent.unwrap_or(i)) as u64).to_le_bytes());
        dump.extend_from_slice(&(name_at as u64).to_le_bytes());
        name_at += node.name.len() + 1;
    }
    for node in nodes {
        dump.extend_from_slice(node.name.as_bytes());
        dump.push(0);
    }
    let mut out = Vec::new();
    out.extend_from_slice(&(dump.len() as u32).to_le_bytes());
    out.extend_from_slice(&(n as u32 | if zstd { 0x8000_0000 } else { 0 }).to_le_bytes());
    if zstd {
        let frame = zstd::bulk::compress(&dump, 3).unwrap();
        out.extend_from_slice(&((1u32 << 30) | frame.len() as u32).to_le_bytes());
        out.extend_from_slice(&frame);
    } else {
        out.extend_from_slice(&dump);
    }
    out
}

// ── DxP2 ────────────────────────────────────────────────────────────────────

/// One texture of a DxP2 pack. `data` is the unpacked payload (all stored mip levels); the
/// builder sets the compression bits of `flags`, `memSz` and `packedSz`.
pub struct TTex {
    pub name: &'static str,
    pub fourcc: [u8; 4],
    pub flags: u32,
    pub w: u16,
    pub h: u16,
    pub levels: u8,
    pub dxt_shift: u8,
    pub data: Vec<u8>,
    pub pack: TexPack,
}

/// How a texture's data is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TexPack {
    Raw,
    Zstd,
    /// Oodle, as uncompressed Oodle blocks (`0xCC 0x0C` + up to 256 KiB each): the format has no
    /// open encoder, but every decoder reads these.
    Oodle,
}

/// `data` as an Oodle stream of uncompressed blocks.
pub fn oodle_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in data.chunks(0x40000) {
        out.extend_from_slice(&[0xCC, 0x0C]);
        out.extend_from_slice(chunk);
    }
    out
}

/// Bytes of the DxP2 directory before the dump's arrays: the 16-byte file header, then the
/// three tabs (names, headers, records).
pub const DXP_ARRAYS_AT: usize = 0x10 + 0x30;

/// A DxP2 pack (formats doc section 3): header, dump (tabs, name pointers, DDSx headers,
/// records of `version` 2 or 3, names), then each texture's data at its absolute offset.
pub fn dxp_bytes(version: u32, texs: &[TTex]) -> Vec<u8> {
    let n = texs.len();
    let record = if version == 2 { 24 } else { 12 };
    let names_at = 0x30;
    let headers_at = names_at + 8 * n;
    let records_at = headers_at + 32 * n;
    let strings_at = records_at + record * n;
    let mut dump = Vec::new();
    tab(&mut dump, names_at, n);
    tab(&mut dump, headers_at, n);
    tab(&mut dump, records_at, n);
    let mut at = strings_at;
    for t in texs {
        dump.extend_from_slice(&(at as u64).to_le_bytes());
        at += t.name.len() + 1;
    }
    let dump_len = at;
    let payloads: Vec<Vec<u8>> = texs
        .iter()
        .map(|t| match t.pack {
            TexPack::Raw => t.data.clone(),
            TexPack::Zstd => zstd::bulk::compress(&t.data, 3).unwrap(),
            TexPack::Oodle => oodle_stored(&t.data),
        })
        .collect();
    for (t, payload) in texs.iter().zip(&payloads) {
        dump.extend_from_slice(b"DDSx");
        dump.extend_from_slice(&t.fourcc);
        let compression = match t.pack {
            TexPack::Raw => 0,
            TexPack::Zstd => 0x2000_0000,
            TexPack::Oodle => 0x6000_0000,
        };
        dump.extend_from_slice(&((t.flags & 0x1FFF_FFFF) | compression).to_le_bytes());
        dump.extend_from_slice(&t.w.to_le_bytes());
        dump.extend_from_slice(&t.h.to_le_bytes());
        dump.extend_from_slice(&[t.levels, 0, 1, 0, 0, 0, 0, t.dxt_shift]);
        dump.extend_from_slice(&(t.data.len() as u32).to_le_bytes());
        let packed = if t.pack == TexPack::Raw { 0 } else { payload.len() as u32 };
        dump.extend_from_slice(&packed.to_le_bytes());
    }
    let mut data_at = (0x10 + dump_len).next_multiple_of(16);
    for (i, payload) in payloads.iter().enumerate() {
        if version == 2 {
            dump.extend_from_slice(&0u64.to_le_bytes());
        }
        dump.extend_from_slice(&(i as i32).to_le_bytes());
        dump.extend_from_slice(&(data_at as i32).to_le_bytes());
        dump.extend_from_slice(&(payload.len() as i32).to_le_bytes());
        if version == 2 {
            dump.extend_from_slice(&0u32.to_le_bytes());
        }
        data_at = (data_at + payload.len()).next_multiple_of(16);
    }
    for t in texs {
        dump.extend_from_slice(t.name.as_bytes());
        dump.push(0);
    }
    assert_eq!(dump.len(), dump_len);
    let mut out = Vec::new();
    out.extend_from_slice(b"DxP2");
    out.extend_from_slice(&version.to_le_bytes());
    out.extend_from_slice(&(n as u32).to_le_bytes());
    out.extend_from_slice(&(dump_len as u32).to_le_bytes());
    out.extend_from_slice(&dump);
    for payload in &payloads {
        out.resize(out.len().next_multiple_of(16), 0);
        out.extend_from_slice(payload);
    }
    out
}

/// What `grp_hdr.vromfs.bin` stores for a pack (`.dxp.bincache.bin`): its first `16 + dumpSize` bytes.
pub fn dxp_cache(file: &[u8]) -> Vec<u8> {
    let dump = u32::from_le_bytes(file[12..16].try_into().unwrap()) as usize;
    file[..16 + dump].to_vec()
}

/// Overwrites the `u32` at `at` (for damaging a built resource).
pub fn patch_u32(bytes: &mut [u8], at: usize, v: u32) {
    bytes[at..at + 4].copy_from_slice(&v.to_le_bytes());
}
