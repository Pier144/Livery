//! DDS and TGA header parsing from the first bytes of a file: resolution and a short format
//! label ("BC7", "BC5", "RGBA8", "RGB8 RLE", …). Pure functions over a byte slice; nothing here
//! touches the disk.
//!
//! - DDS: `"DDS "` magic, a 124-byte header, then (FourCC `DX10`) a 20-byte DXGI extension, so
//!   [`HEADER_BYTES`] = 148 is always enough. The label comes from the FourCC, the DXGI format or
//!   the channel bit masks of an uncompressed file; a valid header with a format this module
//!   doesn't name is labelled `"DDS"`.
//! - TGA: an 18-byte header with no signature, so every field is range-checked instead.
//!
//! Garbage or truncated input yields a [`HeaderError`], never a panic.

use std::fmt;

/// The most bytes a header needs: 4 (magic) + 124 (DDS header) + 20 (DX10 extension).
pub const HEADER_BYTES: usize = 148;

/// Label of a DDS file whose header is valid but whose pixel format isn't one we name.
pub const DDS_UNKNOWN_FORMAT: &str = "DDS";

/// Sides above this are not a real texture (Direct3D stops at 16384): the header is garbage.
const MAX_HEADER_SIDE: u32 = 65_536;

const DDS_MAGIC: &[u8; 4] = b"DDS ";
const DDS_HEADER_SIZE: u32 = 124;
/// Magic + header.
const DDS_BYTES: usize = 128;

// DDS_PIXELFORMAT.dwFlags
const DDPF_ALPHA: u32 = 0x2;
const DDPF_FOURCC: u32 = 0x4;
const DDPF_RGB: u32 = 0x40;
const DDPF_YUV: u32 = 0x200;
const DDPF_LUMINANCE: u32 = 0x2_0000;
const DDPF_BUMPDUDV: u32 = 0x8_0000;

const TGA_BYTES: usize = 18;

/// The container, from the file extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextureKind {
    Dds,
    Tga,
}

impl TextureKind {
    /// `.dds` / `.tga` (ASCII case-insensitive, non-empty stem); anything else is `None`.
    pub fn from_file_name(name: &str) -> Option<Self> {
        if name.len() <= 4 {
            return None;
        }
        // ASCII-only: Unicode lower-casing could turn look-alike characters into "dds".
        let ext = name.get(name.len() - 4..)?;
        if ext.eq_ignore_ascii_case(".dds") {
            Some(Self::Dds)
        } else if ext.eq_ignore_ascii_case(".tga") {
            Some(Self::Tga)
        } else {
            None
        }
    }
}

/// What a texture header says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub width: u32,
    pub height: u32,
    /// Short format label, e.g. "BC7", "BC1", "RGBA8", "RGB8 RLE".
    pub format: String,
}

/// Why a header can't be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderError {
    /// The input ends before the header does.
    Truncated,
    /// Not this kind of file (wrong DDS magic, TGA fields out of range).
    NotRecognized,
    /// The header is there but a field makes no sense.
    Invalid(&'static str),
}

impl fmt::Display for HeaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => f.write_str("the header is truncated"),
            Self::NotRecognized => f.write_str("not a texture of this kind"),
            Self::Invalid(why) => write!(f, "invalid header: {why}"),
        }
    }
}

impl std::error::Error for HeaderError {}

/// Parses the header of a file of the given kind from its first bytes.
pub fn parse(kind: TextureKind, bytes: &[u8]) -> Result<Header, HeaderError> {
    match kind {
        TextureKind::Dds => parse_dds(bytes),
        TextureKind::Tga => parse_tga(bytes),
    }
}

// ── DDS ─────────────────────────────────────────────────────────────────────

/// Parses a DDS header (magic included). Needs 128 bytes, 148 when the FourCC is `DX10`.
pub fn parse_dds(bytes: &[u8]) -> Result<Header, HeaderError> {
    let magic_len = bytes.len().min(DDS_MAGIC.len());
    if bytes[..magic_len] != DDS_MAGIC[..magic_len] {
        return Err(HeaderError::NotRecognized);
    }
    if bytes.len() < DDS_BYTES {
        return Err(HeaderError::Truncated);
    }
    if le_u32(bytes, 4) != DDS_HEADER_SIZE {
        return Err(HeaderError::Invalid("DDS header size is not 124"));
    }
    let (width, height) = checked_size(le_u32(bytes, 16), le_u32(bytes, 12))?;

    let flags = le_u32(bytes, 80);
    let fourcc: [u8; 4] = [bytes[84], bytes[85], bytes[86], bytes[87]];
    let uses_fourcc = flags & DDPF_FOURCC != 0
        // Some writers fill in the FourCC and forget the flag.
        || (flags & (DDPF_RGB | DDPF_LUMINANCE | DDPF_ALPHA | DDPF_YUV | DDPF_BUMPDUDV) == 0 && fourcc != [0; 4]);

    let format = if uses_fourcc {
        if &fourcc == b"DX10" {
            if bytes.len() < HEADER_BYTES {
                return Err(HeaderError::Truncated);
            }
            dxgi_format(le_u32(bytes, 128)).map(str::to_owned)
        } else {
            fourcc_format(fourcc).map(str::to_owned)
        }
    } else {
        let masks = [le_u32(bytes, 92), le_u32(bytes, 96), le_u32(bytes, 100), le_u32(bytes, 104)];
        mask_format(flags, le_u32(bytes, 88), masks)
    };
    Ok(Header { width, height, format: format.unwrap_or_else(|| DDS_UNKNOWN_FORMAT.to_owned()) })
}

/// Legacy FourCC codes (and the numeric D3DFMT codes written in their place).
fn fourcc_format(fourcc: [u8; 4]) -> Option<&'static str> {
    Some(match &fourcc {
        b"DXT1" => "BC1",
        b"DXT2" | b"DXT3" => "BC2",
        // RXGB: Doom 3's swizzled DXT5 for normal maps.
        b"DXT4" | b"DXT5" | b"RXGB" => "BC3",
        b"ATI1" | b"BC4U" | b"BC4S" => "BC4",
        b"ATI2" | b"BC5U" | b"BC5S" | b"A2XY" => "BC5",
        _ => {
            return match u32::from_le_bytes(fourcc) {
                36 => Some("RGBA16"),
                111 => Some("R16F"),
                112 => Some("RG16F"),
                113 => Some("RGBA16F"),
                114 => Some("R32F"),
                115 => Some("RG32F"),
                116 => Some("RGBA32F"),
                _ => None,
            }
        }
    })
}

/// DXGI_FORMAT values of the DX10 extension. UNORM, sRGB and typeless variants share a label,
/// and BGRA orders are labelled like the legacy uncompressed formats ("RGBA8", "RGB8").
pub fn dxgi_format(dxgi: u32) -> Option<&'static str> {
    Some(match dxgi {
        2 => "RGBA32F",
        1 | 3 | 4 => "RGBA32",
        6 => "RGB32F",
        5 | 7 | 8 => "RGB32",
        10 => "RGBA16F",
        9 | 11..=14 => "RGBA16",
        16 => "RG32F",
        15 | 17 | 18 => "RG32",
        23..=25 | 89 => "RGB10A2",
        26 => "R11G11B10F",
        27..=32 | 87 | 90 | 91 => "RGBA8",
        88 | 92 | 93 => "RGB8",
        34 => "RG16F",
        33 | 35..=38 => "RG16",
        41 => "R32F",
        39 | 42 | 43 => "R32",
        48..=52 => "RG8",
        54 => "R16F",
        53 | 56..=59 => "R16",
        60..=64 => "R8",
        65 => "A8",
        67 => "RGB9E5",
        70..=72 => "BC1",
        73..=75 => "BC2",
        76..=78 => "BC3",
        79..=81 => "BC4",
        82..=84 => "BC5",
        85 => "R5G6B5",
        86 => "RGB5A1",
        94..=96 => "BC6H",
        97..=99 => "BC7",
        115 => "RGBA4",
        _ => return None,
    })
}

/// Legacy uncompressed formats, labelled from the channel bit masks: "RGBA8", "RGB8", "R8",
/// "RG8", "R5G6B5", "RGB5A1", "RGB10A2", "L8", "L8A8", "A8".
fn mask_format(flags: u32, bit_count: u32, [r, g, b, a]: [u32; 4]) -> Option<String> {
    let alpha = a.count_ones();
    if flags & (DDPF_RGB | DDPF_BUMPDUDV) != 0 {
        return rgba_label(r.count_ones(), g.count_ones(), b.count_ones(), alpha);
    }
    if flags & DDPF_LUMINANCE != 0 {
        let lum = match r.count_ones() {
            0 => bit_count.checked_sub(alpha).filter(|&n| n > 0)?,
            n => n,
        };
        return Some(if alpha > 0 { format!("L{lum}A{alpha}") } else { format!("L{lum}") });
    }
    if flags & DDPF_ALPHA != 0 {
        let bits = if alpha > 0 { alpha } else { bit_count };
        return (bits > 0).then(|| format!("A{bits}"));
    }
    None
}

/// "RGB8" when red, green and blue share a width, "R5G6B5" when they don't; alpha is folded in
/// ("RGBA8") when it has the same width, appended ("RGB5A1") otherwise.
fn rgba_label(r: u32, g: u32, b: u32, a: u32) -> Option<String> {
    let color = match (r, g, b) {
        (0, _, _) | (_, 0, 1..) => return None,
        (r, 0, 0) => format!("R{r}"),
        (r, g, 0) if r == g => format!("RG{r}"),
        (r, g, 0) => format!("R{r}G{g}"),
        (r, g, b) if r == g && g == b => {
            if a == r {
                return Some(format!("RGBA{r}"));
            }
            format!("RGB{r}")
        }
        (r, g, b) => format!("R{r}G{g}B{b}"),
    };
    Some(if a > 0 { format!("{color}A{a}") } else { color })
}

// ── TGA ─────────────────────────────────────────────────────────────────────

/// Parses an 18-byte TGA header. RLE images get a " RLE" suffix ("RGBA8 RLE").
pub fn parse_tga(bytes: &[u8]) -> Result<Header, HeaderError> {
    if bytes.len() < TGA_BYTES {
        return Err(HeaderError::Truncated);
    }
    let color_map_type = bytes[1];
    let image_type = bytes[2];
    let color_map_entry_bits = bytes[7];
    let depth = bytes[16];
    if color_map_type > 1 {
        return Err(HeaderError::NotRecognized);
    }
    if color_map_type == 1 && ![15, 16, 24, 32].contains(&color_map_entry_bits) {
        return Err(HeaderError::NotRecognized);
    }
    let (base, rle) = match image_type {
        1..=3 => (image_type, false),
        9..=11 => (image_type - 8, true),
        _ => return Err(HeaderError::NotRecognized),
    };
    let format = match (base, depth) {
        // Colour-mapped: 8- or 16-bit palette indices, and the palette must be there.
        (1, 8 | 16) if color_map_type == 1 => format!("P{depth}"),
        (1, _) => return Err(HeaderError::Invalid("TGA colour-mapped image without a usable palette")),
        (2, 15) => "RGB5".to_owned(),
        (2, 16) => "RGB5A1".to_owned(),
        (2, 24) => "RGB8".to_owned(),
        (2, 32) => "RGBA8".to_owned(),
        (3, 8) => "R8".to_owned(),
        (3, 16) => "R8A8".to_owned(),
        _ => return Err(HeaderError::Invalid("TGA pixel depth doesn't match the image type")),
    };
    let (width, height) = checked_size(le_u16(bytes, 12).into(), le_u16(bytes, 14).into())?;
    let format = if rle { format!("{format} RLE") } else { format };
    Ok(Header { width, height, format })
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn checked_size(width: u32, height: u32) -> Result<(u32, u32), HeaderError> {
    if width == 0 || height == 0 {
        return Err(HeaderError::Invalid("zero width or height"));
    }
    if width > MAX_HEADER_SIDE || height > MAX_HEADER_SIDE {
        return Err(HeaderError::Invalid("width or height out of range"));
    }
    Ok((width, height))
}

/// Little-endian u32 at `at`; callers check the length first.
fn le_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}
