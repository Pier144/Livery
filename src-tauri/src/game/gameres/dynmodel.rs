//! DynModel reader (`DynamicRenderableSceneLodsResource`, formats doc section 2): the LOD 0
//! rigid objects, their render elements, the node names and the unpacked vertex data those
//! elements use. Only LOD 0 is kept; skinned meshes (tracks) are ignored.
//!
//! ```text
//! i32 resSz | i32 texCount | i32 matCount | i32 vdataCount | u32 matVdataHdrSz
//! [texCount != -1: i32 sz + TexStr dump, skipped]
//! matVdata block (IGenLoad: none / zstd / Oodle)       vertex and index buffers, see `vdata_layout`
//! LODs dump (resSz bytes)                              lods tab, bbox, bpC254 (offset), bpC255 (scale), Lod[]
//! i32 sz + names dump                                  sorted node names + their ids
//! LOD 0 scene dump (Lod.sceneResSz bytes)              rigids tab (32-byte RigidObject), skins tab
//! one ShaderMesh dump per rigid (RigidObject.meshResSz) elems tab (48-byte RElem)
//! (LODs 1.. and the skinned meshes follow; not read)
//! ```

use super::bad;
use super::bytes::Reader;
use super::codec::{read_block, MAX_VERTEX_DATA};
use super::meshopt::decode_index_sequence;
use crate::error::AppResult;
use std::collections::{BTreeSet, HashMap};

/// Most vertex buffers a model may declare.
pub const MAX_VDATA: usize = 64;
/// Most vertices in one vertex buffer.
pub const MAX_VERTICES: usize = 4_000_000;
/// Most indices over all of a model's index buffers.
pub const MAX_INDICES: usize = 16_000_000;
/// Most rigid objects in LOD 0.
pub const MAX_RIGIDS: usize = 4096;

/// `matVdataHdrSz` top bits meaning "an IGenLoad block follows" (its tag names the compression).
const BLOCK_PACKED: u32 = 0xC000_0000;
const PACKING_MASK: u32 = 0xE000_0000;

/// VdataHdr flags.
const VDATA_I16: u32 = 0x20;
const VDATA_I32: u32 = 0x40;
const VDATA_PACKED_IB: u32 = 0x200;

/// Channel usages and vertex data types (`dag_consts_base.h`) the reader decodes.
const USAGE_POS: i32 = 0;
const USAGE_NORM: i32 = 1;
const USAGE_TC: i32 = 3;
const VSDT_E3DCOLOR: u32 = 4;
const VSDT_SHORT2: u32 = 6;
const VSDT_SHORT4N: u32 = 10;

const VDATA_HDR: usize = 32;
const CHANNEL: usize = 12;
const LOD: usize = 16;
const RIGID: usize = 32;
const ELEM: usize = 48;

/// One render element of a rigid: `numf` triangles from `si` in vdata `vdata`'s index buffer,
/// each index plus `base_vertex` naming a vertex of that vdata, drawn with material `mat` (an
/// index into the model's `matR` list in `dynModelDesc.bin`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Elem {
    pub mat: u32,
    pub vdata: u32,
    pub si: u32,
    pub numf: u32,
    pub base_vertex: i32,
}

/// A rigid object of LOD 0: elements attached to node `node_id` (see [`DynModel::node_names`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rigid {
    pub node_id: i32,
    pub elems: Vec<Elem>,
}

/// One unpacked vertex buffer: positions in the rigid's node space (already scaled by the
/// model's unpack constants), normals as stored (not normalised), UV set 0 (DirectX convention,
/// origin top-left), and the whole index buffer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Vdata {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
    /// The index buffer was meshoptimizer-packed in the file.
    pub packed_indices: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DynModel {
    /// nodeId -> name, from the names dump's `id` table.
    pub node_names: HashMap<i32, String>,
    /// LOD 0.
    pub rigids: Vec<Rigid>,
    /// Every vdata of the model by index; only those LOD 0's elements use are decoded, the
    /// others are empty.
    pub vdata: Vec<Vdata>,
}

impl Elem {
    /// The element's triangle indices into its vdata's vertices (`base_vertex` applied).
    /// [`parse`] has checked that they are in range.
    pub fn vertex_indices<'a>(&self, vdata: &'a Vdata) -> impl Iterator<Item = usize> + 'a {
        let start = self.si as usize;
        let end = start + 3 * self.numf as usize;
        let base = i64::from(self.base_vertex);
        vdata.indices.get(start..end).unwrap_or(&[]).iter().map(move |&i| (i64::from(i) + base) as usize)
    }
}

/// Reads a DynModel resource (its bytes from the `.grp`).
pub fn parse(res: &[u8]) -> AppResult<DynModel> {
    let mut cur = Reader::new(res);
    let res_sz = non_negative(cur.i32()?, "LODs dump size")?;
    let tex_count = cur.i32()?;
    let _mat_count = cur.i32()?;
    let vdata_count = non_negative(cur.i32()?, "vdata count")?;
    if vdata_count > MAX_VDATA {
        return Err(bad(format!("{vdata_count} vertex buffers (at most {MAX_VDATA})")));
    }
    let hdr_word = cur.u32()?;
    if tex_count != -1 {
        // Inline texture names (never seen on tanks): the materials come from dynModelDesc.bin.
        let size = non_negative(cur.i32()?, "texture names size")?;
        cur.skip(size)?;
    }
    if hdr_word & PACKING_MASK != BLOCK_PACKED {
        return Err(bad(format!("vertex data packing {hdr_word:#010X}")));
    }
    let hdr_sz = (hdr_word & 0x3FFF_FFFF) as usize;
    let raw = read_block(&mut cur, MAX_VERTEX_DATA)?;
    let layouts = vdata_layout(&raw, hdr_sz, vdata_count)?;

    // LODs dump: the unpack constants and LOD 0's scene size.
    let lods = Reader::new(cur.take(res_sz)?);
    let (lods_ofs, lods_count) = lods.tab(0)?;
    if lods_count == 0 {
        return Err(bad("model without LODs"));
    }
    let offset = [lods.f32_at(0x28)?, lods.f32_at(0x2C)?, lods.f32_at(0x30)?];
    let scale = [lods.f32_at(0x38)?, lods.f32_at(0x3C)?, lods.f32_at(0x40)?];
    lods.slice(lods_ofs as usize, LOD)?;
    let scene_sz = lods.u32_at(lods_ofs as usize)? as usize;

    let names_sz = non_negative(cur.i32()?, "names size")?;
    let node_names = node_names(cur.take(names_sz)?)?;

    // LOD 0's scene, then one mesh dump per rigid.
    let scene = Reader::new(cur.take(scene_sz)?);
    let (rigids_ofs, rigids_count) = scene.tab(0)?;
    let rigids_count = rigids_count as usize;
    if rigids_count > MAX_RIGIDS {
        return Err(bad(format!("{rigids_count} rigid objects (at most {MAX_RIGIDS})")));
    }
    scene.slice(rigids_ofs as usize, rigids_count * RIGID)?;
    let mut rigids = Vec::with_capacity(rigids_count);
    for k in 0..rigids_count {
        let at = rigids_ofs as usize + k * RIGID;
        let mesh_sz = scene.u32_at(at)? as usize;
        let node_id = scene.i32_at(at + 24)?;
        let mesh = Reader::new(cur.take(mesh_sz)?);
        let (elems_ofs, elems_count) = mesh.tab(0)?;
        let elems_len = (elems_count as usize).checked_mul(ELEM).ok_or_else(|| bad("element table overflows"))?;
        mesh.slice(elems_ofs as usize, elems_len)?;
        let mut elems = Vec::with_capacity(elems_count as usize);
        for e in 0..elems_count as usize {
            let at = elems_ofs as usize + e * ELEM;
            // u64 shaderElem, u64 matIndex, u64 vdataIndex (indices, read as their low u32),
            // i32 vdOrderIndex, sv, numv, si, numf, baseVertex.
            let elem = Elem {
                mat: mesh.u32_at(at + 8)?,
                vdata: mesh.u32_at(at + 16)?,
                si: non_negative(mesh.i32_at(at + 36)?, "element start index")? as u32,
                numf: non_negative(mesh.i32_at(at + 40)?, "element triangle count")? as u32,
                base_vertex: mesh.i32_at(at + 44)?,
            };
            if elem.vdata as usize >= vdata_count {
                return Err(bad(format!("rigid {k}: element uses vdata {} of {vdata_count}", elem.vdata)));
            }
            elems.push(elem);
        }
        rigids.push(Rigid { node_id, elems });
    }

    // Decode only the vertex buffers LOD 0 draws from.
    let used: BTreeSet<usize> = rigids.iter().flat_map(|r| r.elems.iter().map(|e| e.vdata as usize)).collect();
    let mut vdata = vec![Vdata::default(); vdata_count];
    for &i in &used {
        vdata[i] = decode_vdata(&raw, &layouts[i], offset, scale).map_err(|e| prefix(e, i))?;
    }
    for (k, rigid) in rigids.iter().enumerate() {
        for elem in &rigid.elems {
            check_elem(elem, &vdata[elem.vdata as usize], layouts[elem.vdata as usize].vert_num)
                .map_err(|e| prefix(e, k))?;
        }
    }
    Ok(DynModel { node_names, rigids, vdata })
}

fn non_negative(v: i32, what: &str) -> AppResult<usize> {
    usize::try_from(v).map_err(|_| bad(format!("{what} {v}")))
}

fn prefix(mut e: crate::error::AppError, i: usize) -> crate::error::AppError {
    e.detail = e.detail.map(|d| format!("#{i}: {d}"));
    e
}

/// Names dump: `map` tab of 8-byte name pointers (sorted names) and `id` tab of u16 node ids
/// (empty = the ids are the positions).
fn node_names(dump: &[u8]) -> AppResult<HashMap<i32, String>> {
    let r = Reader::new(dump);
    let (map_ofs, map_count) = r.tab(0)?;
    let (id_ofs, id_count) = r.tab(0x10)?;
    let (map_ofs, map_count, id_ofs, id_count) =
        (map_ofs as usize, map_count as usize, id_ofs as usize, id_count as usize);
    r.slice(map_ofs, map_count.checked_mul(8).ok_or_else(|| bad("name map overflows"))?)?;
    if id_count != 0 && id_count != map_count {
        return Err(bad(format!("{map_count} node names with {id_count} ids")));
    }
    r.slice(id_ofs, id_count * 2)?;
    let mut out = HashMap::with_capacity(map_count);
    for k in 0..map_count {
        let name = r.cstr(r.u32_at(map_ofs + 8 * k)? as usize)?;
        let id = if id_count == 0 { k as i32 } else { i32::from(r.u16_at(id_ofs + 2 * k)?) };
        out.insert(id, name);
    }
    Ok(out)
}

/// Where one vdata lives in the unpacked buffer and how it is laid out.
#[derive(Debug)]
struct Layout {
    vert_num: usize,
    stride: usize,
    flags: u32,
    /// (VSDT code, usage, usage index) in vDecl order.
    channels: Vec<(u32, i32, i16)>,
    vb: usize,
    ib: usize,
    ib_len: usize,
    index_count: usize,
    index_size: usize,
}

/// The unpacked matVdata: a header (`hdr_sz` bytes: `mat` tab, `vdata` tab of 32-byte VdataHdr
/// each with its vDecl tab), then each vdata's vertex buffer (`vertNum * stride`) and index
/// buffer (packed size when `flags & 0x200`, else `idxSize`), in order, filling the buffer
/// exactly.
fn vdata_layout(raw: &[u8], hdr_sz: usize, count: usize) -> AppResult<Vec<Layout>> {
    let h =
        Reader::new(raw.get(..hdr_sz).ok_or_else(|| bad(format!("vertex header of {hdr_sz} bytes in {}", raw.len())))?);
    let (vd_ofs, vd_count) = h.tab(0x10)?;
    if vd_count as usize != count {
        return Err(bad(format!("{vd_count} vertex buffers, the model says {count}")));
    }
    h.slice(vd_ofs as usize, count * VDATA_HDR)?;
    let mut at = hdr_sz;
    let mut total_indices = 0usize;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let o = vd_ofs as usize + i * VDATA_HDR;
        let vert_num = h.u32_at(o)? as usize;
        let w1 = h.u32_at(o + 4)?;
        let w2 = h.u32_at(o + 8)?;
        let flags = h.u32_at(o + 12)?;
        let (decl_ofs, decl_count) = h.tab(o + 16)?;
        if vert_num > MAX_VERTICES {
            return Err(bad(format!("vdata {i}: {vert_num} vertices (at most {MAX_VERTICES})")));
        }
        let stride = (w1 & 0xFF) as usize;
        let idx_size = (w2 & 0x0FFF_FFFF) as usize;
        let packed_size = ((w1 >> 8) | ((w2 >> 28) << 24)) as usize;
        let decl_len = (decl_count as usize).checked_mul(CHANNEL).ok_or_else(|| bad("vertex declaration overflows"))?;
        h.slice(decl_ofs as usize, decl_len)?;
        let mut channels = Vec::with_capacity(decl_count as usize);
        for k in 0..decl_count as usize {
            let c = decl_ofs as usize + k * CHANNEL;
            channels.push((h.u32_at(c)? >> 16, h.i32_at(c + 4)?, h.u16_at(c + 8)? as i16));
        }
        let index_size = if flags & VDATA_I32 != 0 || (vert_num > 65536 && flags & VDATA_I16 == 0) { 4 } else { 2 };
        if idx_size % index_size != 0 {
            return Err(bad(format!("vdata {i}: {idx_size} index bytes of {index_size}-byte indices")));
        }
        let index_count = idx_size / index_size;
        total_indices += index_count;
        if total_indices > MAX_INDICES {
            return Err(bad(format!("over {MAX_INDICES} indices")));
        }
        let vb = at;
        let vb_len = vert_num * stride; // <= 4,000,000 * 255
        let ib = vb.checked_add(vb_len).ok_or_else(|| bad("vertex data overflows"))?;
        let ib_len = if flags & VDATA_PACKED_IB != 0 { packed_size } else { idx_size };
        at = ib.checked_add(ib_len).ok_or_else(|| bad("vertex data overflows"))?;
        if at > raw.len() {
            return Err(bad(format!("vdata {i} ends at {at}, past the vertex data ({})", raw.len())));
        }
        out.push(Layout { vert_num, stride, flags, channels, vb, ib, ib_len, index_count, index_size });
    }
    if at != raw.len() {
        return Err(bad(format!("vertex data has {} bytes after the last buffer", raw.len() - at)));
    }
    Ok(out)
}

/// Bytes of a vertex data type, `None` for one the reader doesn't know.
fn vsdt_size(code: u32) -> Option<usize> {
    Some(match code {
        0 => 4,  // FLOAT1
        1 => 8,  // FLOAT2
        2 => 12, // FLOAT3
        3 => 16, // FLOAT4
        4 => 4,  // E3DCOLOR
        5 => 4,  // UBYTE4
        6 => 4,  // SHORT2
        7 => 8,  // SHORT4
        9 => 4,  // SHORT2N
        10 => 8, // SHORT4N
        11 => 4, // USHORT2N
        12 => 8, // USHORT4N
        13 => 4, // UDEC3
        14 => 4, // DEC3N
        15 => 4, // HALF2
        16 => 8, // HALF4
        17 => 4, // INT1
        21 => 4, // UINT1
        _ => return None,
    })
}

/// Decodes positions (POS SHORT4N, `s / 32767 * scale + offset`), normals (NORM E3DCOLOR, bytes
/// B,G,R,A -> `(R,G,B) / 255 * 2 - 1`), UV 0 (TC 0 SHORT2, `/ 4096`) and the indices.
fn decode_vdata(raw: &[u8], l: &Layout, offset: [f32; 3], scale: [f32; 3]) -> AppResult<Vdata> {
    let mut at = 0;
    let (mut pos, mut norm, mut tc) = (None, None, None);
    for &(code, usage, index) in &l.channels {
        let size = vsdt_size(code).ok_or_else(|| bad(format!("vertex layout: data type {code}")))?;
        match (usage, index, code) {
            (USAGE_POS, 0, VSDT_SHORT4N) => pos = Some(at),
            (USAGE_NORM, 0, VSDT_E3DCOLOR) => norm = Some(at),
            (USAGE_TC, 0, VSDT_SHORT2) => tc = Some(at),
            (USAGE_POS | USAGE_NORM | USAGE_TC, 0, _) => {
                return Err(bad(format!("vertex layout: usage {usage} as data type {code}")));
            }
            _ => {}
        }
        at += size;
    }
    let (Some(pos), Some(norm), Some(tc)) = (pos, norm, tc) else {
        return Err(bad(format!("vertex layout {:?} without position, normal or UV", l.channels)));
    };
    if at > l.stride {
        return Err(bad(format!("vertex layout of {at} bytes in a {}-byte stride", l.stride)));
    }

    let vb = &raw[l.vb..l.vb + l.vert_num * l.stride];
    let i16_at = |b: &[u8], o: usize| f32::from(i16::from_le_bytes([b[o], b[o + 1]]));
    let mut positions = Vec::with_capacity(l.vert_num);
    let mut normals = Vec::with_capacity(l.vert_num);
    let mut uvs = Vec::with_capacity(l.vert_num);
    for v in vb.chunks_exact(l.stride) {
        let p = [i16_at(v, pos), i16_at(v, pos + 2), i16_at(v, pos + 4)];
        positions.push([0, 1, 2].map(|k| p[k] / 32767.0 * scale[k] + offset[k]));
        let n = &v[norm..norm + 4];
        normals.push([n[2], n[1], n[0]].map(|c| f32::from(c) / 255.0 * 2.0 - 1.0));
        uvs.push([i16_at(v, tc) / 4096.0, i16_at(v, tc + 2) / 4096.0]);
    }

    let ib = &raw[l.ib..l.ib + l.ib_len];
    let packed_indices = l.flags & VDATA_PACKED_IB != 0;
    let indices = if packed_indices {
        decode_index_sequence(ib, l.index_count)?
    } else if l.index_size == 2 {
        ib.chunks_exact(2).map(|c| u32::from(u16::from_le_bytes([c[0], c[1]]))).collect()
    } else {
        ib.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
    };
    Ok(Vdata { positions, normals, uvs, indices, packed_indices })
}

/// An element's triangles lie in its vdata's index buffer and name vertices of it.
fn check_elem(e: &Elem, vdata: &Vdata, vert_num: usize) -> AppResult<()> {
    let end = (e.numf as usize)
        .checked_mul(3)
        .and_then(|n| n.checked_add(e.si as usize))
        .ok_or_else(|| bad("element range overflows"))?;
    let tris = vdata.indices.get(e.si as usize..end).ok_or_else(|| {
        bad(format!("element indices {}..{end} past the index buffer ({})", e.si, vdata.indices.len()))
    })?;
    let base = i64::from(e.base_vertex);
    if let Some(&bad_index) = tris.iter().find(|&&i| {
        let v = i64::from(i) + base;
        v < 0 || v >= vert_num as i64
    }) {
        return Err(bad(format!("element index {bad_index} + {base} outside {vert_num} vertices")));
    }
    Ok(())
}
