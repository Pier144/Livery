//! DDS writer for the textures Atelier paints: DXT5 (BC3), with their mipmaps. The game's own
//! skins (and the packs on WT Live) ship mipmapped DDS; a single level shimmers at a distance.

/// Size of the `DDS_HEADER` structure (after the magic).
const HEADER_SIZE: u32 = 124;
const DDSD_CAPS: u32 = 0x1;
const DDSD_HEIGHT: u32 = 0x2;
const DDSD_WIDTH: u32 = 0x4;
const DDSD_PIXELFORMAT: u32 = 0x1000;
const DDSD_MIPMAPCOUNT: u32 = 0x20000;
const DDSD_LINEARSIZE: u32 = 0x80000;
const DDPF_FOURCC: u32 = 0x4;
const DDSCAPS_COMPLEX: u32 = 0x8;
const DDSCAPS_TEXTURE: u32 = 0x1000;
const DDSCAPS_MIPMAP: u32 = 0x40_0000;
/// Size of the `DDS_PIXELFORMAT` structure.
const PIXEL_FORMAT_SIZE: u32 = 32;

/// The size of each level of a mip chain from `w`×`h` down to 4×4: every level halves both sides
/// (never below 1), and the chain ends with the first level whose sides are both at most 4.
pub fn mip_sizes(w: u32, h: u32) -> Vec<(u32, u32)> {
    let mut sizes = vec![(w, h)];
    let (mut lw, mut lh) = (w, h);
    while lw.max(lh) > 4 {
        lw = (lw / 2).max(1);
        lh = (lh / 2).max(1);
        sizes.push((lw, lh));
    }
    sizes
}

/// A DDS file of `w`×`h` with one level: see [`write_dxt5_mips`].
pub fn write_dxt5(w: u32, h: u32, blocks: &[u8]) -> Vec<u8> {
    write_dxt5_mips(w, h, &[blocks])
}

/// A DDS file of `w`×`h` holding `levels`, the DXT5 blocks of each level largest first (level 0
/// is `w`×`h`, then the sizes [`mip_sizes`] gives): `"DDS "`, the 124-byte header (caps, height,
/// width, pixel format, linear size = level 0's bytes, and with more than one level the mipmap
/// count and the complex and mipmap caps; FourCC `DXT5`), then the levels one after the other.
pub fn write_dxt5_mips<L: AsRef<[u8]>>(w: u32, h: u32, levels: &[L]) -> Vec<u8> {
    let total: usize = levels.iter().map(|l| l.as_ref().len()).sum();
    let top = levels.first().map_or(0, |l| l.as_ref().len());
    let mipmapped = levels.len() > 1;
    let mut out = Vec::with_capacity(128 + total);
    out.extend_from_slice(b"DDS ");
    let mut put = |v: u32| out.extend_from_slice(&v.to_le_bytes());
    put(HEADER_SIZE);
    let mip_flag = if mipmapped { DDSD_MIPMAPCOUNT } else { 0 };
    put(DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | DDSD_LINEARSIZE | mip_flag);
    put(h);
    put(w);
    put(u32::try_from(top).unwrap_or(u32::MAX));
    put(0); // depth
    put(if mipmapped { u32::try_from(levels.len()).unwrap_or(u32::MAX) } else { 0 });
    for _ in 0..11 {
        put(0); // reserved
    }
    put(PIXEL_FORMAT_SIZE);
    put(DDPF_FOURCC);
    put(u32::from_le_bytes(*b"DXT5"));
    for _ in 0..5 {
        put(0); // RGB bit count and masks
    }
    put(DDSCAPS_TEXTURE | if mipmapped { DDSCAPS_COMPLEX | DDSCAPS_MIPMAP } else { 0 });
    for _ in 0..4 {
        put(0); // caps2, caps3, caps4, reserved
    }
    for level in levels {
        out.extend_from_slice(level.as_ref());
    }
    out
}
