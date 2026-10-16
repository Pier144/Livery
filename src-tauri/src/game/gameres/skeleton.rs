//! GeomNodeTree reader (a model's `<model>_skeleton`, formats doc section 2b): node names,
//! parents and model-space matrices, so each rigid of a DynModel can be placed.
//!
//! ```text
//! u32 a    dump size = a & 0xFFFFF (a >> 20: lastUnimportantCount)
//! u32 n    node count; bit 31 = the dump is an IGenLoad block (zstd / Oodle)
//! dump     n x 160 bytes, offsets relative to the dump:
//!          mat44f tm (local), mat44f wtm (model space), 4 columns of 4 f32 each (col3 = translation)
//!          PatchableTab child (offset / 160 = first child, count), PatchablePtr parent, PatchablePtr name
//! ```

use super::bad;
use super::bytes::Reader;
use super::codec::read_block;
use crate::error::AppResult;

const NODE: usize = 160;
const COMPRESSED: u32 = 0x8000_0000;
/// The dump size field has 20 bits.
const MAX_DUMP: usize = 0xFFFFF;

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub name: String,
    pub parent: Option<usize>,
    /// Model-space matrix as 4 columns (`wtm[3]` is the translation).
    pub wtm: [[f32; 4]; 4],
}

#[derive(Debug, Clone, PartialEq)]
pub struct Skeleton {
    pub nodes: Vec<Node>,
}

impl Skeleton {
    /// Reads a GeomNodeTree resource (its bytes from the `.grp`). Parents come from the children
    /// tables (node `i`'s children are `[ofs / 160, ofs / 160 + count)`), which must come after
    /// their parent, inside the tree, and name each node at most once.
    pub fn parse(res: &[u8]) -> AppResult<Self> {
        let mut cur = Reader::new(res);
        let dump_sz = (cur.u32()? as usize) & MAX_DUMP;
        let n_word = cur.u32()?;
        let count = (n_word & !COMPRESSED) as usize;
        if count.checked_mul(NODE).is_none_or(|len| len > dump_sz) {
            return Err(bad(format!("{count} nodes in a {dump_sz}-byte skeleton")));
        }
        let unpacked;
        let dump = if n_word & COMPRESSED != 0 {
            unpacked = read_block(&mut cur, MAX_DUMP)?;
            unpacked.get(..dump_sz).ok_or_else(|| bad(format!("skeleton block of {} bytes", unpacked.len())))?
        } else {
            cur.take(dump_sz)?
        };
        let r = Reader::new(dump);

        let mut nodes = Vec::with_capacity(count);
        let mut parents: Vec<Option<usize>> = vec![None; count];
        for i in 0..count {
            let o = i * NODE;
            let mut wtm = [[0f32; 4]; 4];
            for (c, column) in wtm.iter_mut().enumerate() {
                for (k, v) in column.iter_mut().enumerate() {
                    *v = r.f32_at(o + 64 + 16 * c + 4 * k)?;
                }
            }
            let (child_ofs, child_count) = r.tab(o + 128)?;
            let name = r.cstr(r.u32_at(o + 152)? as usize)?;
            if child_count > 0 {
                let child_ofs = child_ofs as usize;
                if !child_ofs.is_multiple_of(NODE) {
                    return Err(bad(format!("node {i}: children at byte {child_ofs}")));
                }
                let first = child_ofs / NODE;
                let end = first.checked_add(child_count as usize).filter(|&end| end <= count);
                let Some(end) = end.filter(|_| first > i) else {
                    return Err(bad(format!("node {i}: children {first}+{child_count} of {count}")));
                };
                for (child, parent) in parents.iter_mut().enumerate().take(end).skip(first) {
                    if parent.replace(i).is_some() {
                        return Err(bad(format!("node {child} has two parents")));
                    }
                }
            }
            nodes.push(Node { name, parent: None, wtm });
        }
        for (node, parent) in nodes.iter_mut().zip(parents) {
            node.parent = parent;
        }
        Ok(Self { nodes })
    }

    pub fn by_name(&self, name: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.name == name)
    }

    /// Names from `name` up to the root, `name` first; empty when there is no such node.
    pub fn ancestry(&self, name: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let mut at = self.nodes.iter().position(|n| n.name == name);
        // Parents always come before their children (checked by `parse`), so this ends; the
        // bound is a second guard.
        while let Some(i) = at {
            if out.len() > self.nodes.len() {
                break;
            }
            out.push(self.nodes[i].name.as_str());
            at = self.nodes[i].parent;
        }
        out
    }
}

/// `col0 * x + col1 * y + col2 * z + col3`.
pub fn transform_point(wtm: &[[f32; 4]; 4], p: [f32; 3]) -> [f32; 3] {
    [0, 1, 2].map(|k| wtm[0][k] * p[0] + wtm[1][k] * p[1] + wtm[2][k] * p[2] + wtm[3][k])
}

/// The 3x3 part of `wtm` applied to `n`, normalised (a zero vector stays zero).
pub fn transform_normal(wtm: &[[f32; 4]; 4], n: [f32; 3]) -> [f32; 3] {
    let v = [0, 1, 2].map(|k| wtm[0][k] * n[0] + wtm[1][k] * n[1] + wtm[2][k] * n[2]);
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len > 1e-12 {
        v.map(|c| c / len)
    } else {
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transforms_points_by_columns_and_normals_by_the_rotation() {
        // 90 degrees about y (x -> -z, z -> x), scaled by 2, moved by (1, 2, 3).
        let wtm = [[0.0, 0.0, -2.0, 0.0], [0.0, 2.0, 0.0, 0.0], [2.0, 0.0, 0.0, 0.0], [1.0, 2.0, 3.0, 1.0]];
        assert_eq!(transform_point(&wtm, [1.0, 0.0, 0.0]), [1.0, 2.0, 1.0]);
        assert_eq!(transform_point(&wtm, [0.0, 1.0, 1.0]), [3.0, 4.0, 3.0]);
        assert_eq!(transform_normal(&wtm, [1.0, 0.0, 0.0]), [0.0, 0.0, -1.0]);
        assert_eq!(transform_normal(&wtm, [0.0, 0.0, 0.0]), [0.0, 0.0, 0.0]);
    }
}
