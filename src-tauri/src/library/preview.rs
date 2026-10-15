//! A skin's own preview picture, when its folder has one (many packs ship a screenshot next to
//! the textures). The Hangar shows it as the card's image; WT Live skins use the post's picture.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Pictures larger than this are not shown (a card is a few hundred pixels wide).
pub const MAX_PREVIEW_BYTES: u64 = 6 * 1024 * 1024;

const TYPES: [(&str, &str); 4] =
    [("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("webp", "image/webp")];

/// Words that make a picture the preview rather than, say, a decal reference.
const PREFERRED: [&str; 5] = ["preview", "screenshot", "screen", "thumb", "cover"];

fn mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)
}

/// The picture to show for the skin in `dir`: pictures directly inside it, else one folder
/// down; within a level, names with a preview word first, then by name. Over-size pictures and
/// links are ignored. `None` when there is none.
pub fn find_preview(dir: &Path) -> Option<PathBuf> {
    let level = |dir: &Path| -> (Vec<PathBuf>, Vec<PathBuf>) {
        let mut pictures = Vec::new();
        let mut folders = Vec::new();
        let Ok(entries) = fs::read_dir(dir) else { return (pictures, folders) };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                folders.push(path);
            } else if kind.is_file()
                && mime(&path).is_some()
                && entry.metadata().is_ok_and(|m| m.len() > 0 && m.len() <= MAX_PREVIEW_BYTES)
            {
                pictures.push(path);
            }
        }
        (pictures, folders)
    };
    let best = |mut pictures: Vec<PathBuf>| -> Option<PathBuf> {
        let rank = |p: &PathBuf| {
            let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            (!PREFERRED.iter().any(|w| name.contains(w)), name)
        };
        pictures.sort_by_key(rank);
        pictures.into_iter().next()
    };
    let (pictures, mut folders) = level(dir);
    if let Some(found) = best(pictures) {
        return Some(found);
    }
    folders.sort();
    best(folders.iter().flat_map(|f| level(f).0).collect())
}

/// The picture as a `data:` URL the webview can show (the CSP allows `data:` images).
pub fn data_url(path: &Path) -> io::Result<String> {
    let mime = mime(path).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a picture"))?;
    let bytes = fs::read(path)?;
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], chunk.get(1).copied().unwrap_or(0), chunk.get(2).copied().unwrap_or(0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn prefers_a_preview_picture_then_looks_one_level_down() {
        let dir = std::env::temp_dir().join(format!("livery-preview-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("shots")).unwrap();
        assert_eq!(find_preview(&dir), None);
        fs::write(dir.join("shots").join("a.jpg"), b"jpg").unwrap();
        assert_eq!(find_preview(&dir), Some(dir.join("shots").join("a.jpg")), "one level down");
        fs::write(dir.join("decal.png"), b"png").unwrap();
        fs::write(dir.join("Preview 1.JPG"), b"jpg").unwrap();
        fs::write(dir.join("body_c.dds"), b"dds").unwrap();
        fs::write(dir.join("empty.png"), b"").unwrap();
        assert_eq!(find_preview(&dir), Some(dir.join("Preview 1.JPG")));
        assert_eq!(data_url(&dir.join("Preview 1.JPG")).unwrap(), "data:image/jpeg;base64,anBn");
        fs::remove_dir_all(&dir).unwrap();
    }
}
