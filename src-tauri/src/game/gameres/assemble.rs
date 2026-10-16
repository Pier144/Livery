//! A vehicle's paintable model, put together from its DynModel (LOD 0), skeleton and materials:
//! one part per (node, `_c` texture), placed in model space, converted to right-handed axes,
//! plus the template textures and the binary the frontend reads (`src/atelier/modelBuffer.ts`).

use super::desc::materials;
use super::dxp::{top_level, DxpDir};
use super::dynmodel;
use super::grp::{Grp, DYN_MODEL, GEOM_NODE_TREE};
use super::index::GameResIndex;
use super::skeleton::{transform_normal, transform_point, Skeleton};
use super::{bad, MODEL_NOT_FOUND, MODEL_UNREADABLE, TEXTURE_NOT_FOUND, TEXTURE_OVERRIDES};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::binblk::Blk;
use crate::textures::bc;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;

/// Largest DxP2 directory read for a template.
const MAX_DXP_DIR: usize = 64 * 1024 * 1024;

const IDENTITY: [[f32; 4]; 4] =
    [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PartGroup {
    Hull,
    Turret,
    Gun,
}

/// A paintable texture of the model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    /// Base name, ends in `_c`.
    pub texture: String,
    pub width: u32,
    pub height: u32,
    pub hq: bool,
    pub paintable_by_default: bool,
}

/// The triangles of one node drawn with one slot. Parts are stored one after the other in the
/// model's arrays, in order (see [`encode`] for the offsets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub node: String,
    pub group: PartGroup,
    pub slot: usize,
    pub vertex_count: u32,
    pub index_count: u32,
}

/// Right-handed (z negated, winding flipped), model space, UV origin top-left.
#[derive(Debug, Clone, PartialEq)]
pub struct VehicleModel {
    pub vehicle: String,
    pub model: String,
    pub slots: Vec<Slot>,
    pub parts: Vec<Part>,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub uvs: Vec<f32>,
    /// Absolute into the shared vertex arrays.
    pub indices: Vec<u32>,
    /// 2 = z (the axis that was negated).
    pub mirror_axis: u8,
}

fn model_not_found(detail: String) -> AppError {
    AppError::new(ErrorCode::NotFound, MODEL_NOT_FOUND).with_detail(detail)
}

fn texture_not_found(detail: String) -> AppError {
    AppError::new(ErrorCode::NotFound, TEXTURE_NOT_FOUND).with_detail(detail)
}

fn io(path: &Path, e: std::io::Error) -> AppError {
    let detail = format!("{}: {e}", path.display());
    if e.kind() == std::io::ErrorKind::NotFound {
        model_not_found(detail)
    } else {
        AppError::new(ErrorCode::Io, MODEL_UNREADABLE).with_detail(detail)
    }
}

/// Vertices of one part being built.
#[derive(Default)]
struct PartBuf {
    positions: Vec<f32>,
    normals: Vec<f32>,
    uvs: Vec<f32>,
    indices: Vec<u32>,
}

/// Loads `vehicle`'s paintable model (see the module doc). Elements whose material has no `_c`
/// diffuse in the texture index are left out.
pub fn load(game_root: &Path, index: &GameResIndex, desc: &Blk, vehicle: &str) -> AppResult<VehicleModel> {
    if index.overrides(vehicle) {
        return Err(AppError::new(ErrorCode::Unsupported, TEXTURE_OVERRIDES).with_detail(vehicle.to_owned()));
    }
    let model = index.model(vehicle).ok_or_else(|| model_not_found(vehicle.to_owned()))?;
    let pack = index.grp_of.get(model).ok_or_else(|| model_not_found(format!("{vehicle}: {model}")))?;
    let path = game_root.join(pack);
    let bytes = std::fs::read(&path).map_err(|e| io(&path, e))?;
    let grp = Grp::parse(&bytes, Some(bytes.len()))?;
    let resource = |name: &str, class| {
        let res = grp.find(name, class).ok_or_else(|| bad(format!("{name} isn't in {pack}")))?;
        bytes.get(res.start..res.end).ok_or_else(|| bad(format!("{name}: bytes {}..{}", res.start, res.end)))
    };
    let dm = dynmodel::parse(resource(model, DYN_MODEL)?)?;
    let skeleton = Skeleton::parse(resource(&format!("{model}_skeleton"), GEOM_NODE_TREE)?)?;
    let mats = materials(desc, model).ok_or_else(|| bad(format!("no materials for {model}")))?;

    let mut slots: Vec<Slot> = Vec::new();
    // Keyed by the lowercased name: materials may spell one texture in different cases.
    let mut slot_of: HashMap<String, usize> = HashMap::new();
    let mut skipped: HashSet<String> = HashSet::new();
    let mut parts: Vec<(Part, PartBuf)> = Vec::new();
    let mut part_of: HashMap<(i32, usize), usize> = HashMap::new();
    for rigid in &dm.rigids {
        let node = dm.node_names.get(&rigid.node_id).cloned().unwrap_or_else(|| format!("node {}", rigid.node_id));
        let wtm = skeleton.by_name(&node).map_or(IDENTITY, |n| n.wtm);
        for elem in &rigid.elems {
            let Some(texture) = mats.diffuse_of_mat.get(elem.mat as usize).and_then(Option::as_deref) else { continue };
            let key = texture.to_lowercase();
            if !key.ends_with("_c") {
                continue;
            }
            let Some(tex) = index.texture(texture) else { continue };
            if !matches!(&tex.fourcc, b"DXT1" | b"DXT5") {
                if skipped.insert(key) {
                    tracing::warn!(texture, fourcc = ?String::from_utf8_lossy(&tex.fourcc), "texture format Atelier can't paint, left out");
                }
                continue;
            }
            let slot = *slot_of.entry(key).or_insert_with(|| {
                slots.push(Slot {
                    texture: texture.to_owned(),
                    width: u32::from(tex.w),
                    height: u32::from(tex.h),
                    hq: tex.hq,
                    paintable_by_default: paintable_by_default(texture, model),
                });
                slots.len() - 1
            });
            let part = *part_of.entry((rigid.node_id, slot)).or_insert_with(|| {
                let group = group_of(&skeleton.ancestry(&node));
                let part = Part { node: node.clone(), group, slot, vertex_count: 0, index_count: 0 };
                parts.push((part, PartBuf::default()));
                parts.len() - 1
            });
            append(&mut parts[part].1, elem, &dm.vdata[elem.vdata as usize], &wtm);
        }
    }
    if slots.is_empty() {
        return Err(texture_not_found(format!("{vehicle}: no _c texture of {model} in the packs")));
    }

    let mut out = VehicleModel {
        vehicle: vehicle.to_owned(),
        model: model.to_owned(),
        slots,
        parts: Vec::with_capacity(parts.len()),
        positions: Vec::new(),
        normals: Vec::new(),
        uvs: Vec::new(),
        indices: Vec::new(),
        mirror_axis: 2,
    };
    for (mut part, buf) in parts {
        // At most MAX_INDICES vertices in all (each element index adds at most one).
        let base = (out.positions.len() / 3) as u32;
        part.vertex_count = (buf.positions.len() / 3) as u32;
        part.index_count = buf.indices.len() as u32;
        out.positions.extend(buf.positions);
        out.normals.extend(buf.normals);
        out.uvs.extend(buf.uvs);
        out.indices.extend(buf.indices.iter().map(|&i| i + base));
        out.parts.push(part);
    }
    Ok(out)
}

/// A slot painted unless the user unticks it: the vehicle's own body, turret and gun textures
/// (the 76W Jumbo reuses `m4a3e2_sherman_jumbo_body_c`), or any texture named after the model.
/// Shared ones (machine guns, nets, tracks, barrels) aren't. Case-insensitive: the Tiger II's
/// model is `pzkpfw_VI_ausf_B_tiger_h`, its textures `pzkpfw_vi_ausf_b_tiger_h_*_c`.
pub fn paintable_by_default(texture: &str, model: &str) -> bool {
    let texture = texture.to_lowercase();
    ["_body_c", "_turret_c", "_gun_c"].iter().any(|s| texture.ends_with(s))
        || texture.starts_with(&model.to_lowercase())
}

/// Gun when the node or an ancestor starts with `bone_gun` or `gun_barrel`, else turret when
/// one starts with `bone_turret`, else hull.
fn group_of(ancestry: &[&str]) -> PartGroup {
    if ancestry.iter().any(|n| n.starts_with("bone_gun") || n.starts_with("gun_barrel")) {
        PartGroup::Gun
    } else if ancestry.iter().any(|n| n.starts_with("bone_turret")) {
        PartGroup::Turret
    } else {
        PartGroup::Hull
    }
}

/// Determinant of the 3x3 part of a column-major matrix: negative for a mirroring transform.
/// Informational (see [`append`] on winding).
pub fn determinant(m: &[[f32; 4]; 4]) -> f32 {
    let [a, b, c] = [m[0], m[1], m[2]];
    a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1])
}

/// Appends an element's triangles to `buf`, copying only the vertices they use (remapped per
/// element), placed by `wtm`, z negated, each triangle's 2nd and 3rd index swapped. LOD 0 has
/// at most `dynmodel::MAX_INDICES` element indices, so the part's counts fit `u32`.
///
/// One swap fits every node, mirrored or not. Almost every skeleton node's `wtm` mirrors
/// (det < 0: 12,483 of 12,598 rigids in a sample of 136 vehicles), and the game stores those
/// nodes' triangles reversed, so that after `wtm` every triangle has the same winding against
/// its normals; only the z negation then needs undoing. Checked on the real install: with this
/// rule 100% of the Jumbo's and the Tiger II's triangles face their normals; flipping only where
/// det > 0 left every mirrored node's triangles inside out.
fn append(buf: &mut PartBuf, elem: &dynmodel::Elem, vdata: &dynmodel::Vdata, wtm: &[[f32; 4]; 4]) {
    let mut local: HashMap<usize, u32> =
        HashMap::with_capacity((elem.numf as usize).saturating_mul(3).min(vdata.positions.len()));
    let mut tri = [0u32; 3];
    for (k, v) in elem.vertex_indices(vdata).enumerate() {
        let next = (buf.positions.len() / 3) as u32;
        let id = *local.entry(v).or_insert(next);
        if id == next {
            // `parse` checked every index against the vertex count.
            let (p, n, uv) = (vdata.positions[v], vdata.normals[v], vdata.uvs[v]);
            let [x, y, z] = transform_point(wtm, p);
            buf.positions.extend_from_slice(&[x, y, -z]);
            let [nx, ny, nz] = transform_normal(wtm, n);
            buf.normals.extend_from_slice(&[nx, ny, -nz]);
            buf.uvs.extend_from_slice(&uv);
        }
        tri[k % 3] = id;
        if k % 3 == 2 {
            buf.indices.extend_from_slice(&[tri[0], tri[2], tri[1]]);
        }
    }
}

/// The slot's template texture: the game's `_c` texture (HQ when installed) decoded to RGBA8,
/// RGB doubled and clamped (the game stores it at half intensity), alpha 255.
pub fn template_texture(game_root: &Path, index: &GameResIndex, slot: &Slot) -> AppResult<Vec<u8>> {
    let tex = index.texture(&slot.texture).ok_or_else(|| texture_not_found(slot.texture.clone()))?;
    let path = game_root.join(&tex.pack);
    let texture_io = |e: std::io::Error| {
        let detail = format!("{}: {e}", path.display());
        if e.kind() == std::io::ErrorKind::NotFound {
            texture_not_found(detail)
        } else {
            AppError::new(ErrorCode::Io, MODEL_UNREADABLE).with_detail(detail)
        }
    };
    let mut file = std::fs::File::open(&path).map_err(texture_io)?;
    let mut head = Vec::new();
    (&mut file).take(16).read_to_end(&mut head).map_err(texture_io)?;
    let dump = head.get(12..16).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize).unwrap_or(0);
    if dump > MAX_DXP_DIR {
        return Err(bad(format!("{}: directory of {dump} bytes", tex.pack)));
    }
    (&mut file).take(dump as u64).read_to_end(&mut head).map_err(texture_io)?;
    let dir = DxpDir::parse(&head)?;
    let entry = dir
        .entries
        .iter()
        .find(|e| e.name == tex.entry)
        .ok_or_else(|| texture_not_found(format!("{} in {}", tex.entry, tex.pack)))?;
    let blocks = top_level(&mut file, entry)?;
    let mut rgba = bc::decode(&entry.header.fourcc, &blocks, usize::from(entry.header.w), usize::from(entry.header.h))?;
    for px in rgba.chunks_exact_mut(4) {
        for c in &mut px[..3] {
            *c = c.saturating_mul(2);
        }
        px[3] = 255;
    }
    Ok(rgba)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeaderPart<'a> {
    node: &'a str,
    group: PartGroup,
    slot: usize,
    vertex_offset: u32,
    vertex_count: u32,
    index_offset: u32,
    index_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Header<'a> {
    vehicle: &'a str,
    model: &'a str,
    mirror_axis: u8,
    slots: &'a [Slot],
    parts: Vec<HeaderPart<'a>>,
    vertex_count: usize,
    index_count: usize,
}

/// The binary the frontend reads (little-endian): `"LVM1"`, `u32` header length, the header
/// JSON (UTF-8, padded with spaces to a multiple of 4: vehicle, model, mirrorAxis, slots, parts
/// with their vertex and index offsets, vertexCount, indexCount), then f32 positions (3 per
/// vertex), f32 normals (3), f32 UVs (2) and u32 indices (absolute).
pub fn encode(model: &VehicleModel) -> Vec<u8> {
    let (mut vertex_offset, mut index_offset) = (0, 0);
    let parts = model
        .parts
        .iter()
        .map(|p| {
            let part = HeaderPart {
                node: &p.node,
                group: p.group,
                slot: p.slot,
                vertex_offset,
                vertex_count: p.vertex_count,
                index_offset,
                index_count: p.index_count,
            };
            vertex_offset += p.vertex_count;
            index_offset += p.index_count;
            part
        })
        .collect();
    let header = Header {
        vehicle: &model.vehicle,
        model: &model.model,
        mirror_axis: model.mirror_axis,
        slots: &model.slots,
        parts,
        vertex_count: model.positions.len() / 3,
        index_count: model.indices.len(),
    };
    let mut json = serde_json::to_vec(&header).unwrap_or_default();
    json.resize(json.len().next_multiple_of(4), b' ');
    let floats = model.positions.len() + model.normals.len() + model.uvs.len();
    let mut out = Vec::with_capacity(8 + json.len() + 4 * (floats + model.indices.len()));
    out.extend_from_slice(b"LVM1");
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    for v in model.positions.iter().chain(&model.normals).chain(&model.uvs) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for i in &model.indices {
        out.extend_from_slice(&i.to_le_bytes());
    }
    out
}
