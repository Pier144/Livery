//! DDS writer for the textures Atelier paints: DXT5 (BC3), one level, no mipmaps.

/// Size of the `DDS_HEADER` structure (after the magic).
const HEADER_SIZE: u32 = 124;
const DDSD_CAPS: u32 = 0x1;
const DDSD_HEIGHT: u32 = 0x2;
const DDSD_WIDTH: u32 = 0x4;
const DDSD_PIXELFORMAT: u32 = 0x1000;
const DDSD_LINEARSIZE: u32 = 0x80000;
const DDPF_FOURCC: u32 = 0x4;
const DDSCAPS_TEXTURE: u32 = 0x1000;
/// Size of the `DDS_PIXELFORMAT` structure.
const PIXEL_FORMAT_SIZE: u32 = 32;

/// A DDS file of `w`×`h` holding `blocks` (the DXT5 blocks of the top level, as
/// `textures::bc::encode_dxt5` returns them): `"DDS "`, the 124-byte header (caps, height,
/// width, pixel format, linear size = `blocks.len()`; FourCC `DXT5`; caps texture), the blocks.
pub fn write_dxt5(w: u32, h: u32, blocks: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(128 + blocks.len());
    out.extend_from_slice(b"DDS ");
    let mut put = |v: u32| out.extend_from_slice(&v.to_le_bytes());
    put(HEADER_SIZE);
    put(DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | DDSD_LINEARSIZE);
    put(h);
    put(w);
    put(u32::try_from(blocks.len()).unwrap_or(u32::MAX));
    put(0); // depth
    put(0); // mipmap count: none
    for _ in 0..11 {
        put(0); // reserved
    }
    put(PIXEL_FORMAT_SIZE);
    put(DDPF_FOURCC);
    put(u32::from_le_bytes(*b"DXT5"));
    for _ in 0..5 {
        put(0); // RGB bit count and masks
    }
    put(DDSCAPS_TEXTURE);
    for _ in 0..4 {
        put(0); // caps2, caps3, caps4, reserved
    }
    out.extend_from_slice(blocks);
    out
}
