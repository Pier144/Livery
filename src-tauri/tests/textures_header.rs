//! DDS/TGA header parser: every format mapping (FourCC, DXGI, uncompressed masks, TGA image
//! types and depths), dimensions, the committed header-only fixtures, and truncated or garbage
//! input (an error, never a panic).

use livery_lib::textures::header::{
    dxgi_format, parse, parse_dds, parse_tga, Header, HeaderError, TextureKind, DDS_UNKNOWN_FORMAT, HEADER_BYTES,
};
use std::path::PathBuf;

// ── Builders ────────────────────────────────────────────────────────────────

const DDPF_ALPHAPIXELS: u32 = 0x1;
const DDPF_ALPHA: u32 = 0x2;
const DDPF_FOURCC: u32 = 0x4;
const DDPF_RGB: u32 = 0x40;
const DDPF_YUV: u32 = 0x200;
const DDPF_LUMINANCE: u32 = 0x2_0000;

fn put(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

/// A 128-byte DDS header (magic included) with the given pixel format fields.
fn dds(width: u32, height: u32, pf_flags: u32, fourcc: [u8; 4], bit_count: u32, masks: [u32; 4]) -> Vec<u8> {
    let mut b = vec![0u8; 128];
    b[..4].copy_from_slice(b"DDS ");
    put(&mut b, 4, 124);
    put(&mut b, 8, 0x1 | 0x2 | 0x4 | 0x1000);
    put(&mut b, 12, height);
    put(&mut b, 16, width);
    put(&mut b, 28, 1);
    put(&mut b, 76, 32);
    put(&mut b, 80, pf_flags);
    b[84..88].copy_from_slice(&fourcc);
    put(&mut b, 88, bit_count);
    for (i, mask) in masks.into_iter().enumerate() {
        put(&mut b, 92 + 4 * i, mask);
    }
    put(&mut b, 108, 0x1000);
    b
}

fn dds_fourcc(fourcc: &[u8; 4], width: u32, height: u32) -> Vec<u8> {
    dds(width, height, DDPF_FOURCC, *fourcc, 0, [0; 4])
}

/// A 148-byte DDS header with the DX10 extension.
fn dds_dx10(dxgi: u32, width: u32, height: u32) -> Vec<u8> {
    let mut b = dds_fourcc(b"DX10", width, height);
    b.resize(148, 0);
    put(&mut b, 128, dxgi);
    put(&mut b, 132, 3);
    put(&mut b, 140, 1);
    b
}

fn dds_masks(pf_flags: u32, bit_count: u32, masks: [u32; 4]) -> Vec<u8> {
    dds(256, 256, pf_flags, [0; 4], bit_count, masks)
}

/// An 18-byte TGA header.
fn tga_full(color_map_type: u8, image_type: u8, entry_bits: u8, depth: u8, width: u16, height: u16) -> Vec<u8> {
    let mut b = vec![0u8; 18];
    b[1] = color_map_type;
    b[2] = image_type;
    if color_map_type == 1 {
        b[5..7].copy_from_slice(&256u16.to_le_bytes());
        b[7] = entry_bits;
    }
    b[12..14].copy_from_slice(&width.to_le_bytes());
    b[14..16].copy_from_slice(&height.to_le_bytes());
    b[16] = depth;
    b[17] = 0x20;
    b
}

fn tga(image_type: u8, depth: u8, width: u16, height: u16) -> Vec<u8> {
    tga_full(0, image_type, 0, depth, width, height)
}

fn format_of(result: Result<Header, HeaderError>) -> String {
    result.unwrap_or_else(|e| panic!("header should parse: {e}")).format
}

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("textures").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

// ── DDS: FourCC ─────────────────────────────────────────────────────────────

#[test]
fn dds_fourcc_codes_map_to_block_formats() {
    let cases: [(&[u8; 4], &str); 14] = [
        (b"DXT1", "BC1"),
        (b"DXT2", "BC2"),
        (b"DXT3", "BC2"),
        (b"DXT4", "BC3"),
        (b"DXT5", "BC3"),
        (b"RXGB", "BC3"),
        (b"ATI1", "BC4"),
        (b"BC4U", "BC4"),
        (b"BC4S", "BC4"),
        (b"ATI2", "BC5"),
        (b"BC5U", "BC5"),
        (b"BC5S", "BC5"),
        (b"A2XY", "BC5"),
        (b"ABCD", DDS_UNKNOWN_FORMAT),
    ];
    for (fourcc, expected) in cases {
        let header = parse_dds(&dds_fourcc(fourcc, 1024, 1024)).unwrap();
        assert_eq!(header.format, expected, "{}", String::from_utf8_lossy(fourcc));
        assert_eq!((header.width, header.height), (1024, 1024));
    }
}

#[test]
fn dds_numeric_d3dfmt_fourccs_are_named() {
    for (code, expected) in [(36u32, "RGBA16"), (111, "R16F"), (112, "RG16F"), (113, "RGBA16F"), (114, "R32F")] {
        assert_eq!(format_of(parse_dds(&dds_fourcc(&code.to_le_bytes(), 512, 512))), expected, "D3DFMT {code}");
    }
    assert_eq!(format_of(parse_dds(&dds_fourcc(&115u32.to_le_bytes(), 512, 512))), "RG32F");
    assert_eq!(format_of(parse_dds(&dds_fourcc(&116u32.to_le_bytes(), 512, 512))), "RGBA32F");
    assert_eq!(format_of(parse_dds(&dds_fourcc(&999u32.to_le_bytes(), 512, 512))), DDS_UNKNOWN_FORMAT);
}

#[test]
fn dds_fourcc_is_used_when_the_flag_is_missing() {
    let bytes = dds(512, 512, 0, *b"DXT5", 0, [0; 4]);
    assert_eq!(format_of(parse_dds(&bytes)), "BC3");
}

#[test]
fn dds_width_and_height_come_from_their_own_fields() {
    let header = parse_dds(&dds_fourcc(b"DXT1", 1024, 512)).unwrap();
    assert_eq!((header.width, header.height), (1024, 512));
    let header = parse_dds(&dds_dx10(98, 256, 2048)).unwrap();
    assert_eq!((header.width, header.height), (256, 2048));
}

// ── DDS: DX10 / DXGI ────────────────────────────────────────────────────────

#[test]
fn dxgi_block_formats_share_a_label_across_unorm_srgb_and_typeless() {
    let cases: [(std::ops::RangeInclusive<u32>, &str); 7] = [
        (70..=72, "BC1"),
        (73..=75, "BC2"),
        (76..=78, "BC3"),
        (79..=81, "BC4"),
        (82..=84, "BC5"),
        (94..=96, "BC6H"),
        (97..=99, "BC7"),
    ];
    for (values, expected) in cases {
        for dxgi in values {
            assert_eq!(format_of(parse_dds(&dds_dx10(dxgi, 4096, 4096))), expected, "DXGI {dxgi}");
        }
    }
}

#[test]
fn dxgi_uncompressed_formats_are_labelled_by_channels() {
    let cases: [(u32, &str); 22] = [
        (27, "RGBA8"),
        (28, "RGBA8"),
        (29, "RGBA8"),
        (31, "RGBA8"),
        (87, "RGBA8"),
        (90, "RGBA8"),
        (91, "RGBA8"),
        (88, "RGB8"),
        (92, "RGB8"),
        (93, "RGB8"),
        (61, "R8"),
        (60, "R8"),
        (63, "R8"),
        (49, "RG8"),
        (51, "RG8"),
        (65, "A8"),
        (2, "RGBA32F"),
        (10, "RGBA16F"),
        (11, "RGBA16"),
        (24, "RGB10A2"),
        (85, "R5G6B5"),
        (86, "RGB5A1"),
    ];
    for (dxgi, expected) in cases {
        assert_eq!(format_of(parse_dds(&dds_dx10(dxgi, 1024, 1024))), expected, "DXGI {dxgi}");
    }
    assert_eq!(dxgi_format(115), Some("RGBA4"));
    assert_eq!(dxgi_format(26), Some("R11G11B10F"));
    assert_eq!(dxgi_format(56), Some("R16"));
    assert_eq!(dxgi_format(41), Some("R32F"));
}

#[test]
fn unknown_dxgi_formats_fall_back_to_dds() {
    // 0 = UNKNOWN, 20 = D32_FLOAT_S8X24_UINT (depth), 45 = D24_UNORM_S8_UINT, then out of range.
    for dxgi in [0u32, 20, 45, 100, 132, u32::MAX] {
        assert_eq!(format_of(parse_dds(&dds_dx10(dxgi, 512, 512))), DDS_UNKNOWN_FORMAT, "DXGI {dxgi}");
    }
}

#[test]
fn dx10_header_needs_the_extension_bytes() {
    let full = dds_dx10(98, 1024, 1024);
    assert_eq!(full.len(), HEADER_BYTES);
    for len in 128..HEADER_BYTES {
        assert_eq!(parse_dds(&full[..len]), Err(HeaderError::Truncated), "{len} bytes");
    }
    // Longer input (a whole file) is fine: only the header is looked at.
    let mut longer = full.clone();
    longer.extend_from_slice(&[0xAB; 4096]);
    assert_eq!(format_of(parse_dds(&longer)), "BC7");
}

// ── DDS: uncompressed masks ─────────────────────────────────────────────────

#[test]
fn dds_rgb_masks_map_to_channel_labels() {
    let rgba = DDPF_RGB | DDPF_ALPHAPIXELS;
    let cases: [(u32, u32, [u32; 4], &str); 12] = [
        // A8R8G8B8 and A8B8G8R8
        (rgba, 32, [0xff_0000, 0xff00, 0xff, 0xff00_0000], "RGBA8"),
        (rgba, 32, [0xff, 0xff00, 0xff_0000, 0xff00_0000], "RGBA8"),
        // X8R8G8B8 and R8G8B8
        (DDPF_RGB, 32, [0xff_0000, 0xff00, 0xff, 0], "RGB8"),
        (DDPF_RGB, 24, [0xff_0000, 0xff00, 0xff, 0], "RGB8"),
        // Alpha mask without the flag still counts (as DirectXTex reads it).
        (DDPF_RGB, 32, [0xff_0000, 0xff00, 0xff, 0xff00_0000], "RGBA8"),
        (DDPF_RGB, 16, [0xf800, 0x07e0, 0x001f, 0], "R5G6B5"),
        (rgba, 16, [0x7c00, 0x03e0, 0x001f, 0x8000], "RGB5A1"),
        (DDPF_RGB, 16, [0x7c00, 0x03e0, 0x001f, 0], "RGB5"),
        (rgba, 16, [0x0f00, 0x00f0, 0x000f, 0xf000], "RGBA4"),
        (rgba, 32, [0x3ff, 0xffc00, 0x3ff0_0000, 0xc000_0000], "RGB10A2"),
        (DDPF_RGB, 8, [0xff, 0, 0, 0], "R8"),
        (DDPF_RGB, 16, [0xff, 0xff00, 0, 0], "RG8"),
    ];
    for (flags, bits, masks, expected) in cases {
        assert_eq!(format_of(parse_dds(&dds_masks(flags, bits, masks))), expected, "{masks:x?}");
    }
}

#[test]
fn dds_luminance_and_alpha_only_formats() {
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_LUMINANCE, 8, [0xff, 0, 0, 0]))), "L8");
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_LUMINANCE | DDPF_ALPHAPIXELS, 16, [0xff, 0, 0, 0xff00]))), "L8A8");
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_LUMINANCE, 16, [0xffff, 0, 0, 0]))), "L16");
    // Luminance without a mask: the bit count says it.
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_LUMINANCE, 8, [0; 4]))), "L8");
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_ALPHA, 8, [0, 0, 0, 0xff]))), "A8");
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_ALPHA, 8, [0; 4]))), "A8");
}

#[test]
fn dds_pixel_formats_we_dont_name_are_labelled_dds() {
    // YUV, no flags at all, RGB with no red mask, and red + blue without green.
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_YUV, 16, [0; 4]))), DDS_UNKNOWN_FORMAT);
    assert_eq!(format_of(parse_dds(&dds_masks(0, 0, [0; 4]))), DDS_UNKNOWN_FORMAT);
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_RGB, 32, [0; 4]))), DDS_UNKNOWN_FORMAT);
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_RGB, 16, [0xff, 0, 0xff00, 0]))), DDS_UNKNOWN_FORMAT);
    assert_eq!(format_of(parse_dds(&dds_masks(DDPF_LUMINANCE, 0, [0; 4]))), DDS_UNKNOWN_FORMAT);
}

// ── DDS: errors ─────────────────────────────────────────────────────────────

#[test]
fn dds_errors() {
    let valid = dds_fourcc(b"DXT1", 512, 512);

    let mut wrong_magic = valid.clone();
    wrong_magic[..4].copy_from_slice(b"DDS\0");
    assert_eq!(parse_dds(&wrong_magic), Err(HeaderError::NotRecognized));
    assert_eq!(parse_dds(b"PNG"), Err(HeaderError::NotRecognized));

    let mut wrong_size = valid.clone();
    put(&mut wrong_size, 4, 100);
    assert!(matches!(parse_dds(&wrong_size), Err(HeaderError::Invalid(_))));

    for (width, height) in [(0, 512), (512, 0), (70_000, 512), (512, u32::MAX)] {
        assert!(
            matches!(parse_dds(&dds_fourcc(b"DXT1", width, height)), Err(HeaderError::Invalid(_))),
            "{width}×{height}"
        );
    }
}

#[test]
fn every_prefix_of_a_dds_header_is_truncated() {
    let valid = dds_fourcc(b"DXT5", 2048, 2048);
    for len in 0..valid.len() {
        assert_eq!(parse_dds(&valid[..len]), Err(HeaderError::Truncated), "{len} bytes");
    }
    assert_eq!(format_of(parse_dds(&valid)), "BC3");
}

// ── TGA ─────────────────────────────────────────────────────────────────────

#[test]
fn tga_image_types_and_depths() {
    let cases: [(u8, u8, &str); 12] = [
        (2, 32, "RGBA8"),
        (2, 24, "RGB8"),
        (2, 16, "RGB5A1"),
        (2, 15, "RGB5"),
        (3, 8, "R8"),
        (3, 16, "R8A8"),
        (10, 32, "RGBA8 RLE"),
        (10, 24, "RGB8 RLE"),
        (10, 16, "RGB5A1 RLE"),
        (11, 8, "R8 RLE"),
        (11, 16, "R8A8 RLE"),
        (10, 15, "RGB5 RLE"),
    ];
    for (image_type, depth, expected) in cases {
        let header = parse_tga(&tga(image_type, depth, 1024, 1024)).unwrap();
        assert_eq!(header.format, expected, "type {image_type}, {depth} bits");
    }
}

#[test]
fn tga_colour_mapped_images_need_their_palette() {
    assert_eq!(format_of(parse_tga(&tga_full(1, 1, 24, 8, 256, 256))), "P8");
    assert_eq!(format_of(parse_tga(&tga_full(1, 9, 32, 8, 256, 256))), "P8 RLE");
    assert_eq!(format_of(parse_tga(&tga_full(1, 1, 16, 16, 256, 256))), "P16");
    // A truecolor image may carry an (unused) palette.
    assert_eq!(format_of(parse_tga(&tga_full(1, 2, 24, 32, 256, 256))), "RGBA8");
    // Colour-mapped without a palette, or with a 24-bit index.
    assert!(matches!(parse_tga(&tga_full(0, 1, 0, 8, 256, 256)), Err(HeaderError::Invalid(_))));
    assert!(matches!(parse_tga(&tga_full(1, 1, 24, 24, 256, 256)), Err(HeaderError::Invalid(_))));
}

#[test]
fn tga_width_and_height_are_little_endian() {
    let header = parse_tga(&tga(2, 32, 0x0400, 0x0300)).unwrap();
    assert_eq!((header.width, header.height), (1024, 768));
    let header = parse_tga(&tga(2, 24, u16::MAX, 1)).unwrap();
    assert_eq!((header.width, header.height), (65_535, 1));
}

#[test]
fn tga_errors() {
    let valid = tga(2, 32, 512, 512);
    for len in 0..valid.len() {
        assert_eq!(parse_tga(&valid[..len]), Err(HeaderError::Truncated), "{len} bytes");
    }
    // No image, unknown image types, colour map type out of range, bad palette entry size.
    for image_type in [0u8, 4, 8, 12, 32, 255] {
        assert_eq!(parse_tga(&tga(image_type, 32, 512, 512)), Err(HeaderError::NotRecognized), "type {image_type}");
    }
    assert_eq!(parse_tga(&tga_full(2, 2, 0, 32, 512, 512)), Err(HeaderError::NotRecognized));
    assert_eq!(parse_tga(&tga_full(1, 2, 7, 32, 512, 512)), Err(HeaderError::NotRecognized));
    // Depth that doesn't fit the image type.
    for (image_type, depth) in [(2u8, 8u8), (2, 12), (2, 48), (3, 24), (3, 32), (10, 8), (11, 24)] {
        assert!(
            matches!(parse_tga(&tga(image_type, depth, 512, 512)), Err(HeaderError::Invalid(_))),
            "type {image_type}, {depth} bits"
        );
    }
    assert!(matches!(parse_tga(&tga(2, 32, 0, 512)), Err(HeaderError::Invalid(_))));
    assert!(matches!(parse_tga(&tga(2, 32, 512, 0)), Err(HeaderError::Invalid(_))));
}

// ── Kinds, dispatch, fixtures ───────────────────────────────────────────────

#[test]
fn kind_comes_from_the_extension() {
    assert_eq!(TextureKind::from_file_name("hull_c.dds"), Some(TextureKind::Dds));
    assert_eq!(TextureKind::from_file_name("Tiger_Turret_C.DDS"), Some(TextureKind::Dds));
    assert_eq!(TextureKind::from_file_name("camo.TgA"), Some(TextureKind::Tga));
    for name in [".dds", "dds", "", "a.png", "a.dds.bak", "a_dds", "skin.blk", "a.tg"] {
        assert_eq!(TextureKind::from_file_name(name), None, "{name:?}");
    }
    // Non-ASCII names don't trip the byte slicing.
    assert_eq!(TextureKind::from_file_name("камуфляж.dds"), Some(TextureKind::Dds));
    assert_eq!(TextureKind::from_file_name("x.ddş"), None);
    assert_eq!(TextureKind::from_file_name("xşdds"), None);
}

#[test]
fn parse_dispatches_on_kind() {
    assert_eq!(format_of(parse(TextureKind::Dds, &dds_fourcc(b"DXT1", 512, 512))), "BC1");
    assert_eq!(format_of(parse(TextureKind::Tga, &tga(10, 32, 512, 512))), "RGBA8 RLE");
    assert_eq!(parse(TextureKind::Dds, &tga(2, 32, 512, 512)), Err(HeaderError::NotRecognized));
}

#[test]
fn committed_fixtures_parse() {
    let cases = [
        ("bc7_4096.dds", TextureKind::Dds, 4096, 4096, "BC7"),
        ("bc5_2048.dds", TextureKind::Dds, 2048, 2048, "BC5"),
        ("dxt1_512.dds", TextureKind::Dds, 512, 512, "BC1"),
        ("rgba8_1024.tga", TextureKind::Tga, 1024, 1024, "RGBA8"),
        ("rle_24_256.tga", TextureKind::Tga, 256, 256, "RGB8 RLE"),
    ];
    for (name, kind, width, height, format) in cases {
        let header = parse(kind, &fixture(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(header, Header { width, height, format: format.to_owned() }, "{name}");
    }
    assert_eq!(parse(TextureKind::Dds, &fixture("truncated.dds")), Err(HeaderError::Truncated));
}

// ── Garbage ─────────────────────────────────────────────────────────────────

/// Deterministic pseudo-random bytes (64-bit LCG, high bits).
fn noise(seed: u64, len: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            (state >> 56) as u8
        })
        .collect()
}

#[test]
fn garbage_never_panics_and_any_accepted_header_is_sane() {
    let check = |result: Result<Header, HeaderError>| {
        if let Ok(header) = result {
            assert!((1..=65_536).contains(&header.width) && (1..=65_536).contains(&header.height), "{header:?}");
            assert!(!header.format.is_empty());
        }
    };
    for seed in 0..400u64 {
        let len = (seed as usize * 7) % 300;
        let bytes = noise(seed, len);
        check(parse_dds(&bytes));
        check(parse_tga(&bytes));
        // Right magic and header size, noise everywhere else.
        let mut dds_like = noise(seed ^ 0xDD5, 128 + (seed as usize % 40));
        dds_like[..4].copy_from_slice(b"DDS ");
        put(&mut dds_like, 4, 124);
        check(parse_dds(&dds_like));
    }
    // Pure noise never passes for a DDS (no magic).
    assert!((0..200u64).all(|seed| parse_dds(&noise(seed, 200)).is_err()));
}

#[test]
fn header_errors_have_readable_text() {
    assert_eq!(HeaderError::Truncated.to_string(), "the header is truncated");
    assert!(HeaderError::Invalid("zero width or height").to_string().contains("zero width"));
}
