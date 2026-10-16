//! Block compression for Atelier: DXT1 (BC1) and DXT5 (BC3) decoding written here, DXT5
//! encoding through `texpresso`.
//!
//! - BC1 block (8 bytes): two RGB565 endpoints `c0`, `c1`, then 16 2-bit indices (row-major, low
//!   bits first). `c0 > c1`: 4 colours (`c0`, `c1`, 2/3 + 1/3, 1/3 + 2/3); else 3 colours
//!   (`c0`, `c1`, the mean) and index 3 is transparent black.
//! - BC3 block (16 bytes): an alpha block (two 8-bit endpoints `a0`, `a1`, 16 3-bit indices;
//!   `a0 > a1`: 8 values interpolated in sevenths, else 6 in fifths plus 0 and 255), then a BC1
//!   colour block always read in 4-colour mode.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::gameres::MODEL_UNREADABLE;

/// Widest or tallest texture decoded or encoded (the game's own `_c` textures are at most 4096).
pub const MAX_SIDE_PX: usize = 8192;

/// `invalidInput` when a painted texture handed to [`encode_dxt5`] doesn't match its size.
pub const APPLY_BAD_TEXTURE: &str = "A painted texture has the wrong size";

/// Decoding reads the game's textures: a failure is a `parse` error of the vehicle's model.
fn bad(detail: String) -> AppError {
    AppError::new(ErrorCode::Parse, MODEL_UNREADABLE).with_detail(detail)
}

/// Decodes DXT1 (8-byte blocks) or DXT5 (16-byte blocks) to RGBA8, `w` x `h` (blocks cover
/// 4 x 4 pixels; a level smaller than a block, or not a multiple of 4, is cropped from padded
/// blocks). `blocks` must hold at least `ceil(w / 4) * ceil(h / 4)` blocks.
pub fn decode(fourcc: &[u8; 4], blocks: &[u8], w: usize, h: usize) -> AppResult<Vec<u8>> {
    let dxt5 = match fourcc {
        b"DXT1" => false,
        b"DXT5" => true,
        other => return Err(bad(format!("texture format {:?}", String::from_utf8_lossy(other)))),
    };
    if !size_ok(w, h) {
        return Err(bad(format!("texture of {w}x{h}")));
    }
    let block_size = if dxt5 { 16 } else { 8 };
    let (bw, bh) = (w.div_ceil(4), h.div_ceil(4));
    let need = bw * bh * block_size;
    if blocks.len() < need {
        return Err(bad(format!("{}x{} texture in {} of {need} bytes", w, h, blocks.len())));
    }
    let mut out = vec![0u8; w * h * 4];
    for (i, block) in blocks[..need].chunks_exact(block_size).enumerate() {
        let (bx, by) = (i % bw, i / bw);
        let pixels = if dxt5 {
            let mut p = colour_block(&block[8..], true);
            let alpha = alpha_block(&block[..8]);
            for (px, a) in p.iter_mut().zip(alpha) {
                px[3] = a;
            }
            p
        } else {
            colour_block(block, false)
        };
        for (k, px) in pixels.iter().enumerate() {
            let (x, y) = (bx * 4 + k % 4, by * 4 + k / 4);
            if x < w && y < h {
                let at = 4 * (y * w + x);
                out[at..at + 4].copy_from_slice(px);
            }
        }
    }
    Ok(out)
}

/// Encodes RGBA8 (`w * h * 4` bytes) to DXT5 blocks with texpresso (quality: ClusterFit). A
/// size of 0 or over [`MAX_SIDE_PX`], or a buffer that isn't `w * h * 4` bytes, is
/// `invalidInput` ([`APPLY_BAD_TEXTURE`]): the image comes from the frontend's bake.
pub fn encode_dxt5(rgba: &[u8], w: usize, h: usize) -> AppResult<Vec<u8>> {
    if !size_ok(w, h) || rgba.len() != w * h * 4 {
        return Err(AppError::new(ErrorCode::InvalidInput, APPLY_BAD_TEXTURE)
            .with_detail(format!("{w}x{h} image in {} bytes", rgba.len())));
    }
    let format = texpresso::Format::Bc3;
    let mut out = vec![0u8; format.compressed_size(w, h)];
    let params = texpresso::Params { algorithm: texpresso::Algorithm::ClusterFit, ..Default::default() };
    format.compress(rgba, w, h, params, &mut out);
    Ok(out)
}

fn size_ok(w: usize, h: usize) -> bool {
    (1..=MAX_SIDE_PX).contains(&w) && (1..=MAX_SIDE_PX).contains(&h)
}

fn rgb565(c: u16) -> [u8; 3] {
    let (r, g, b) = ((c >> 11) & 31, (c >> 5) & 63, c & 31);
    [((r << 3) | (r >> 2)) as u8, ((g << 2) | (g >> 4)) as u8, ((b << 3) | (b >> 2)) as u8]
}

/// The 16 pixels of a BC1 colour block; `four` forces the 4-colour mode (BC3).
fn colour_block(b: &[u8], four: bool) -> [[u8; 4]; 16] {
    let c0 = u16::from_le_bytes([b[0], b[1]]);
    let c1 = u16::from_le_bytes([b[2], b[3]]);
    let (e0, e1) = (rgb565(c0), rgb565(c1));
    let mix = |wa: u16, wb: u16, d: u16| -> [u8; 4] {
        let ch = |k: usize| ((u16::from(e0[k]) * wa + u16::from(e1[k]) * wb) / d) as u8;
        [ch(0), ch(1), ch(2), 255]
    };
    let palette = if four || c0 > c1 {
        [[e0[0], e0[1], e0[2], 255], [e1[0], e1[1], e1[2], 255], mix(2, 1, 3), mix(1, 2, 3)]
    } else {
        [[e0[0], e0[1], e0[2], 255], [e1[0], e1[1], e1[2], 255], mix(1, 1, 2), [0, 0, 0, 0]]
    };
    let bits = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
    std::array::from_fn(|k| palette[((bits >> (2 * k)) & 3) as usize])
}

/// The 16 alpha values of a BC3 alpha block.
fn alpha_block(b: &[u8]) -> [u8; 16] {
    let (a0, a1) = (u16::from(b[0]), u16::from(b[1]));
    let mut values = [0u8; 8];
    values[0] = a0 as u8;
    values[1] = a1 as u8;
    if a0 > a1 {
        for k in 1..7 {
            values[k + 1] = (((7 - k as u16) * a0 + k as u16 * a1) / 7) as u8;
        }
    } else {
        for k in 1..5 {
            values[k + 1] = (((5 - k as u16) * a0 + k as u16 * a1) / 5) as u8;
        }
        values[6] = 0;
        values[7] = 255;
    }
    let bits = b[2..8].iter().rev().fold(0u64, |acc, &x| (acc << 8) | u64::from(x));
    std::array::from_fn(|k| values[((bits >> (3 * k)) & 7) as usize])
}
