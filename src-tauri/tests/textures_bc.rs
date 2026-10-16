//! DXT1/DXT5 decoding on hand-made blocks of known colours, and a DXT5 encode/decode round trip.

use livery_lib::error::ErrorCode;
use livery_lib::textures::bc::{decode, encode_dxt5};

/// A DXT1 block: endpoints `c0`, `c1` (RGB565) and the 2-bit index of each pixel.
fn bc1(c0: u16, c1: u16, idx: [u32; 16]) -> Vec<u8> {
    let bits = idx.iter().enumerate().fold(0u32, |acc, (k, &i)| acc | (i << (2 * k)));
    let mut b = c0.to_le_bytes().to_vec();
    b.extend_from_slice(&c1.to_le_bytes());
    b.extend_from_slice(&bits.to_le_bytes());
    b
}

/// A DXT5 alpha block: endpoints and the 3-bit index of each pixel.
fn bc3_alpha(a0: u8, a1: u8, idx: [u64; 16]) -> Vec<u8> {
    let bits = idx.iter().enumerate().fold(0u64, |acc, (k, &i)| acc | (i << (3 * k)));
    let mut b = vec![a0, a1];
    b.extend_from_slice(&bits.to_le_bytes()[..6]);
    b
}

fn pixel(rgba: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] {
    let at = 4 * (y * w + x);
    rgba[at..at + 4].try_into().unwrap()
}

fn ramp<T: From<u8>>(n: u8) -> [T; 16] {
    std::array::from_fn(|k| T::from(k as u8 % n))
}

#[test]
fn a_solid_dxt1_block_is_one_colour() {
    let out = decode(b"DXT1", &bc1(0xF800, 0x0000, [0; 16]), 4, 4).unwrap();
    assert_eq!(out.len(), 64);
    assert!(out.chunks(4).all(|p| p == [255, 0, 0, 255]));
}

#[test]
fn dxt1_four_colour_mode_interpolates_thirds() {
    // c0 > c1: white, black, 2/3 white, 1/3 white.
    let out = decode(b"DXT1", &bc1(0xFFFF, 0x0000, ramp(4)), 4, 4).unwrap();
    assert_eq!(pixel(&out, 4, 0, 0), [255, 255, 255, 255]);
    assert_eq!(pixel(&out, 4, 1, 0), [0, 0, 0, 255]);
    assert_eq!(pixel(&out, 4, 2, 0), [170, 170, 170, 255]);
    assert_eq!(pixel(&out, 4, 3, 0), [85, 85, 85, 255]);
    assert_eq!(pixel(&out, 4, 2, 3), [170, 170, 170, 255], "row-major, low bits first");
}

#[test]
fn dxt1_three_colour_mode_has_a_mean_and_transparent_black() {
    // c0 <= c1: black, white, the mean, transparent.
    let out = decode(b"DXT1", &bc1(0x0000, 0xFFFF, ramp(4)), 4, 4).unwrap();
    assert_eq!(pixel(&out, 4, 0, 0), [0, 0, 0, 255]);
    assert_eq!(pixel(&out, 4, 1, 0), [255, 255, 255, 255]);
    assert_eq!(pixel(&out, 4, 2, 0), [127, 127, 127, 255]);
    assert_eq!(pixel(&out, 4, 3, 0), [0, 0, 0, 0]);
}

#[test]
fn rgb565_expands_to_full_range() {
    // r = 16, g = 32, b = 8 of 31/63/31.
    let c = (16 << 11) | (32 << 5) | 8;
    let out = decode(b"DXT1", &bc1(c, 0, [0; 16]), 4, 4).unwrap();
    assert_eq!(pixel(&out, 4, 0, 0), [132, 130, 66, 255]);
}

#[test]
fn dxt5_alpha_ramps_in_both_modes() {
    // a0 > a1: 8 values in sevenths.
    let mut block = bc3_alpha(255, 0, ramp(8));
    block.extend(bc1(0xF800, 0, [0; 16]));
    let out = decode(b"DXT5", &block, 4, 4).unwrap();
    let alpha: Vec<u8> = (0..8).map(|x| pixel(&out, 4, x % 4, x / 4)[3]).collect();
    assert_eq!(alpha, [255, 0, 218, 182, 145, 109, 72, 36]);
    assert_eq!(&pixel(&out, 4, 0, 0)[..3], &[255, 0, 0]);
    // a0 <= a1: 6 values in fifths, then 0 and 255.
    let mut block = bc3_alpha(0, 255, ramp(8));
    block.extend(bc1(0xF800, 0, [0; 16]));
    let out = decode(b"DXT5", &block, 4, 4).unwrap();
    let alpha: Vec<u8> = (0..8).map(|x| pixel(&out, 4, x % 4, x / 4)[3]).collect();
    assert_eq!(alpha, [0, 255, 51, 102, 153, 204, 0, 255]);
}

#[test]
fn dxt5_colour_is_always_four_colour() {
    // c0 <= c1 would be 3-colour mode in DXT1; in DXT5 index 3 is 1/3 c0 + 2/3 c1, opaque per alpha.
    let mut block = bc3_alpha(128, 128, [0; 16]);
    block.extend(bc1(0x0000, 0xFFFF, [3; 16]));
    let out = decode(b"DXT5", &block, 4, 4).unwrap();
    assert!(out.chunks(4).all(|p| p == [170, 170, 170, 128]), "{:?}", &out[..4]);
}

#[test]
fn blocks_are_laid_out_row_by_row_and_small_levels_are_cropped() {
    // 8x8: red, green / blue, white.
    let mut blocks = bc1(0xF800, 0, [0; 16]);
    blocks.extend(bc1(0x07E0, 0, [0; 16]));
    blocks.extend(bc1(0x001F, 0, [0; 16]));
    blocks.extend(bc1(0xFFFF, 0, [0; 16]));
    let out = decode(b"DXT1", &blocks, 8, 8).unwrap();
    assert_eq!(pixel(&out, 8, 3, 3), [255, 0, 0, 255]);
    assert_eq!(pixel(&out, 8, 4, 0), [0, 255, 0, 255]);
    assert_eq!(pixel(&out, 8, 0, 4), [0, 0, 255, 255]);
    assert_eq!(pixel(&out, 8, 7, 7), [255, 255, 255, 255]);
    // A 2x1 level comes from one padded block.
    let out = decode(b"DXT1", &bc1(0xFFFF, 0, ramp(4)), 2, 1).unwrap();
    assert_eq!(out, [255, 255, 255, 255, 0, 0, 0, 255]);
    // 6x5 needs 2x2 blocks.
    assert_eq!(decode(b"DXT1", &blocks, 6, 5).unwrap().len(), 6 * 5 * 4);
}

#[test]
fn bad_input_is_an_error() {
    let block = bc1(0, 0, [0; 16]);
    for (fourcc, data, w, h) in [
        (b"BC7 ", &block[..], 4, 4),
        (b"DXT1", &block[..7], 4, 4),
        (b"DXT1", &block[..], 8, 4),
        (b"DXT5", &block[..], 4, 4),
        (b"DXT1", &block[..], 0, 4),
        (b"DXT1", &block[..], 4, 100_000),
    ] {
        let r = decode(fourcc, data, w, h);
        assert!(r.is_err_and(|e| e.code == ErrorCode::Parse), "{fourcc:?} {w}x{h}");
    }
    assert!(encode_dxt5(&[0; 63], 4, 4).is_err());
    assert!(encode_dxt5(&[], 0, 0).is_err());
}

#[test]
fn a_gradient_survives_a_dxt5_round_trip() {
    let (w, h) = (64, 64);
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            rgba.extend_from_slice(&[(x * 4) as u8, (y * 4) as u8, ((x + y) * 2) as u8, (255 - y * 2) as u8]);
        }
    }
    let blocks = encode_dxt5(&rgba, w, h).unwrap();
    assert_eq!(blocks.len(), (w / 4) * (h / 4) * 16);
    let back = decode(b"DXT5", &blocks, w, h).unwrap();
    for c in 0..4 {
        let error: f64 = rgba.iter().zip(&back).skip(c).step_by(4).map(|(a, b)| f64::from(a.abs_diff(*b))).sum::<f64>()
            / (w * h) as f64;
        println!("channel {c}: mean abs error {error:.2}");
        assert!(error <= 6.0, "channel {c}: {error}");
    }
}
