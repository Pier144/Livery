//! `content/base/res/dynModelDesc.bin` (formats doc section 2c): a binary BLK (kind 2) with one
//! block per model that keeps its materials outside the DynModel (every tank does):
//!
//! ```text
//! m4a3e2_sherman_jumbo {
//!   tex { tex="m4a3e2_sherman_jumbo_turret_c*" tex="us_camo_olive*" ... }   index = position
//!   matR { mat { cls="dynamic_masked_tank" t0=7 t1=1 t2=8 t3=9 } ... }       rigid materials
//!   matS { ... }                                                             skinned, not read
//! }
//! ```
//!
//! `RElem.mat` indexes `matR`; `t0` is the diffuse (`_c`) texture, an index into `tex`.

use crate::game::binblk::{Blk, Block};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelMaterials {
    /// The model's texture list in order, each name without its trailing `*`.
    pub textures: Vec<String>,
    /// `matR` index -> its `t0` (diffuse) texture name without the trailing `*`; `None` when the
    /// material has no `t0`, `t0 = -1`, or an index outside the texture list.
    pub diffuse_of_mat: Vec<Option<String>>,
}

/// The materials of `model`, `None` when the description has no block for it.
pub fn materials(desc: &Blk, model: &str) -> Option<ModelMaterials> {
    let block = desc.root().child(model)?;
    let textures: Vec<String> = block
        .child("tex")
        .map(|tex| {
            tex.params()
                .filter(|(name, _)| *name == "tex")
                .map(|(_, v)| v.as_str().map(strip_star).unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default();
    let diffuse_of_mat = block
        .child("matR")
        .map(|mats| mats.children().filter(|m| m.name() == Some("mat")).map(|m| diffuse(&m, &textures)).collect())
        .unwrap_or_default();
    Some(ModelMaterials { textures, diffuse_of_mat })
}

fn diffuse(mat: &Block, textures: &[String]) -> Option<String> {
    let index = usize::try_from(mat.param("t0")?.as_i64()?).ok()?;
    textures.get(index).filter(|name| !name.is_empty()).cloned()
}

fn strip_star(name: &str) -> &str {
    name.strip_suffix('*').unwrap_or(name)
}
