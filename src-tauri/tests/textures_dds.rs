//! The DDS files Atelier writes read back as DXT5 of the right size, and (ignored) how long DXT5
//! encoding of a painted texture takes.

use livery_lib::atelier::apply::{encode_mips, encode_painted};
use livery_lib::textures::bc::{decode, encode_dxt5};
use livery_lib::textures::dds::{mip_sizes, write_dxt5, write_dxt5_mips};
use livery_lib::textures::header::parse_dds;
use std::time::Instant;

#[test]
fn a_written_dds_reads_back_as_dxt5_of_its_size() {
    let (w, h) = (8usize, 4usize);
    let rgba: Vec<u8> = (0..w * h).flat_map(|i| [(i * 8) as u8, 128, 255 - (i * 8) as u8, 200]).collect();
    let blocks = encode_dxt5(&rgba, w, h).unwrap();
    assert_eq!(blocks.len(), 2 * 16);
    let file = write_dxt5(w as u32, h as u32, &blocks);
    assert_eq!(file.len(), 128 + blocks.len());
    assert_eq!(&file[..4], b"DDS ");
    let header = parse_dds(&file).unwrap();
    assert_eq!((header.width, header.height, header.format.as_str()), (8, 4, "BC3"));
    let le = |at: usize| u32::from_le_bytes(file[at..at + 4].try_into().unwrap());
    assert_eq!(le(8), 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, "caps, height, width, pixel format, linear size");
    assert_eq!(le(20), blocks.len() as u32, "linear size");
    assert_eq!(le(28), 0, "no mipmaps");
    assert_eq!(le(80), 0x4, "FourCC pixel format");
    assert_eq!(&file[84..88], b"DXT5");
    assert_eq!(le(108), 0x1000, "caps: texture");
    assert_eq!(&file[128..], &blocks[..]);
    assert_eq!(decode(b"DXT5", &file[128..], w, h).unwrap().len(), rgba.len());
}

/// A painted-looking image: smooth gradients with noise, not a flat colour (the cluster fit's
/// cost depends on the colours of each block).
fn painted(side: usize) -> Vec<u8> {
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut out = Vec::with_capacity(side * side * 4);
    for y in 0..side {
        for x in 0..side {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let n = (state & 31) as usize;
            out.extend_from_slice(&[
                ((x * 255 / side + n) & 255) as u8,
                ((y * 255 / side + n) & 255) as u8,
                (((x + y) * 127 / side + n) & 255) as u8,
                if (x / 64 + y / 64) % 2 == 0 { 255 } else { 0 },
            ]);
        }
    }
    out
}

/// `cargo test --release --test textures_dds -- --ignored --nocapture` (debug builds are many
/// times slower): `bc::encode_dxt5` (ClusterFit, one thread), texpresso's RangeFit (one thread)
/// and what an apply uses (`apply::encode_painted`: by size, on every core).
#[test]
#[ignore]
fn dxt5_encode_timing() {
    for side in [2048usize, 4096] {
        let rgba = painted(side);
        let start = Instant::now();
        let blocks = encode_dxt5(&rgba, side, side).unwrap();
        let cluster = start.elapsed();
        assert_eq!(blocks.len(), side * side);

        let mut out = vec![0u8; side * side];
        let params = texpresso::Params { algorithm: texpresso::Algorithm::RangeFit, ..Default::default() };
        let start = Instant::now();
        texpresso::Format::Bc3.compress(&rgba, side, side, params, &mut out);
        let range = start.elapsed();
        let start = Instant::now();
        let painted = encode_painted(&rgba, side as u32, side as u32).unwrap();
        let apply = start.elapsed();
        assert!(painted == if side <= 2048 { blocks } else { out }, "strips encode like the whole image");
        let start = Instant::now();
        let levels = encode_mips(&rgba, side as u32, side as u32).unwrap();
        let mips = start.elapsed();
        assert_eq!(levels.len(), mip_sizes(side as u32, side as u32).len());
        println!("DXT5 {side}x{side}: ClusterFit {cluster:.2?}, RangeFit {range:.2?}");
        println!("DXT5 {side}x{side}: apply level 0 {apply:.2?}, apply with mipmaps {mips:.2?}");
    }
}

#[test]
fn mip_chains_end_at_four_by_four() {
    assert_eq!(mip_sizes(4, 4), [(4, 4)]);
    assert_eq!(mip_sizes(16, 16), [(16, 16), (8, 8), (4, 4)]);
    assert_eq!(mip_sizes(16, 4), [(16, 4), (8, 2), (4, 1)]);
    assert_eq!(mip_sizes(4096, 4096).len(), 11);
    assert_eq!(*mip_sizes(2048, 1024).last().unwrap(), (4, 2));
}

#[test]
fn a_mipmapped_dds_lists_its_levels() {
    let levels = [vec![1u8; 64], vec![2u8; 16]];
    let file = write_dxt5_mips(8, 8, &levels);
    assert_eq!(file.len(), 128 + 80);
    let header = parse_dds(&file).unwrap();
    assert_eq!((header.width, header.height, header.format.as_str()), (8, 8, "BC3"));
    let le = |at: usize| u32::from_le_bytes(file[at..at + 4].try_into().unwrap());
    assert_eq!(le(8), 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000, "with the mipmap count");
    assert_eq!(le(20), 64, "linear size: level 0");
    assert_eq!(le(28), 2, "mipmap count");
    assert_eq!(le(108), 0x1000 | 0x8 | 0x40_0000, "caps: texture, complex, mipmap");
    assert_eq!(&file[128..192], &[1u8; 64][..]);
    assert_eq!(&file[192..], &[2u8; 16][..]);
}
