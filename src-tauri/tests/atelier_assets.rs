//! Atelier's project pictures on temp folders: import from PNG/JPEG/WebP (EXIF orientation, size
//! limits, refused paths), raw RGBA read/write that keeps colour under alpha 0, asset ids and the
//! garbage collection run when the editor opens a project. Every picture is made in the test.

use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPEncoder;
use image::{GrayImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use livery_lib::atelier::assets::{
    gc, import, is_asset_id, read_rgba, referenced_ids, write_rgba, ASSETS_DIR, ASSET_INVALID, ASSET_NOT_FOUND,
    IMAGE_TOO_LARGE, IMAGE_UNREADABLE, MAX_ASSET_SIDE,
};
use livery_lib::atelier::AtelierState;
use livery_lib::error::{AppError, ErrorCode};
use livery_lib::library::index::new_id_with;
use livery_lib::model::{AtelierProject, AtelierSlotChoice};
use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::SystemTime;

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-assets-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn err<T: std::fmt::Debug>(result: Result<T, AppError>) -> AppError {
    result.expect_err("expected an error")
}

/// Left half red, right half blue, `w`×`h`.
fn halves(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, _| if x < w / 2 { Rgb([255, 0, 0]) } else { Rgb([0, 0, 255]) })
}

fn near(a: [u8; 4], b: [u8; 4], tolerance: u8) -> bool {
    a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= tolerance)
}

fn pixel(rgba: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * w + x) * 4) as usize;
    [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

fn jpeg_bytes(img: &RgbImage) -> Vec<u8> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 95).encode_image(img).unwrap();
    out
}

/// A JPEG with an EXIF APP1 segment right after SOI carrying `Orientation = orientation`.
fn jpeg_with_orientation(img: &RgbImage, orientation: u16) -> Vec<u8> {
    let jpeg = jpeg_bytes(img);
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II*\0");
    tiff.extend_from_slice(&8u32.to_le_bytes()); // first IFD
    tiff.extend_from_slice(&1u16.to_le_bytes()); // one entry
    tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation
    tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
    tiff.extend_from_slice(&1u32.to_le_bytes()); // count
    tiff.extend_from_slice(&orientation.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]); // value padding
    tiff.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let mut out = jpeg[..2].to_vec(); // SOI
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn asset_file(project: &Path, id: &str) -> PathBuf {
    project.join(ASSETS_DIR).join(format!("{id}.png"))
}

#[test]
fn asset_ids_are_exactly_the_library_id_format() {
    for _ in 0..3 {
        let id = new_id_with("img");
        assert!(is_asset_id(&id), "{id}");
    }
    assert!(is_asset_id("img-186f3a2b9c0d1e2f-0"));
    assert!(is_asset_id("img-0-12"));
    for bad in [
        "",
        "img",
        "img-",
        "img--0",
        "img-abc-",
        "img-ABC-1",
        "img-0abc-1",
        "img-abc-01",
        "img-abc-1-2",
        "p-abc-1",
        "IMG-abc-1",
        "img-xyz-1",
        "img-abc-1.png",
        "img-abc-1/..",
        "img-abc-+1",
        "img-123456789012345678901234567890123-1",
        "img-abc-123456789012345678901",
        "img-abc- 1",
    ] {
        assert!(!is_asset_id(bad), "{bad:?}");
    }
}

#[test]
fn imports_png_jpeg_and_webp_as_rgba_png_assets() {
    let dir = TempDir::new("formats");
    let project = dir.path().join("project");
    fs::create_dir_all(&project).unwrap();

    let png = dir.path().join("pic.png");
    let src = RgbaImage::from_fn(6, 4, |x, _| if x < 3 { Rgba([255, 0, 0, 255]) } else { Rgba([0, 0, 255, 128]) });
    src.save_with_format(&png, ImageFormat::Png).unwrap();
    let jpg = dir.path().join("pic.JPG");
    fs::write(&jpg, jpeg_bytes(&halves(16, 8))).unwrap();
    let webp = dir.path().join("pic.webp");
    let mut bytes = Vec::new();
    WebPEncoder::new_lossless(&mut bytes).encode(src.as_raw(), 6, 4, image::ExtendedColorType::Rgba8).unwrap();
    fs::write(&webp, bytes).unwrap();

    let a = import(&project, &png).unwrap();
    assert_eq!((a.width, a.height), (6, 4));
    assert!(is_asset_id(&a.id));
    assert!(asset_file(&project, &a.id).is_file());
    let (w, h, rgba) = read_rgba(&project, &a.id).unwrap();
    assert_eq!((w, h), (6, 4));
    assert_eq!(rgba, src.as_raw().as_slice());

    let b = import(&project, &jpg).unwrap();
    assert_eq!((b.width, b.height), (16, 8));
    let (w, _, rgba) = read_rgba(&project, &b.id).unwrap();
    assert!(near(pixel(&rgba, w, 1, 4), [255, 0, 0, 255], 12));
    assert!(near(pixel(&rgba, w, 14, 4), [0, 0, 255, 255], 12));

    let c = import(&project, &webp).unwrap();
    let (_, _, rgba) = read_rgba(&project, &c.id).unwrap();
    assert_eq!(rgba, src.as_raw().as_slice());
    assert_ne!(a.id, c.id);
}

#[test]
fn a_jpeg_with_exif_orientation_is_turned_upright() {
    let dir = TempDir::new("exif");
    let project = dir.path().join("project");
    // Orientation 6: the stored picture must be turned 90° clockwise, so its left (red) goes on top.
    let path = dir.path().join("rotated.jpeg");
    fs::write(&path, jpeg_with_orientation(&halves(16, 8), 6)).unwrap();
    let asset = import(&project, &path).unwrap();
    assert_eq!((asset.width, asset.height), (8, 16));
    let (w, _, rgba) = read_rgba(&project, &asset.id).unwrap();
    assert!(near(pixel(&rgba, w, 4, 1), [255, 0, 0, 255], 12), "{:?}", pixel(&rgba, w, 4, 1));
    assert!(near(pixel(&rgba, w, 4, 14), [0, 0, 255, 255], 12), "{:?}", pixel(&rgba, w, 4, 14));
}

#[test]
fn large_pictures_are_scaled_down_to_the_asset_limit() {
    let dir = TempDir::new("downscale");
    let project = dir.path().join("project");
    // Above 2× the limit too, so both the integer shrink and Lanczos3 run.
    let path = dir.path().join("wide.png");
    GrayImage::from_pixel(MAX_ASSET_SIDE * 2 + 100, 4, image::Luma([200])).save(&path).unwrap();
    let asset = import(&project, &path).unwrap();
    assert_eq!(asset.width, MAX_ASSET_SIDE);
    assert_eq!(asset.height, 2);
    let (_, _, rgba) = read_rgba(&project, &asset.id).unwrap();
    assert!(near(pixel(&rgba, MAX_ASSET_SIDE, 10, 0), [200, 200, 200, 255], 2));
}

#[test]
fn oversized_and_unreadable_pictures_are_refused() {
    let dir = TempDir::new("limits");
    let project = dir.path().join("project");

    // Only the header is read before refusing: 16385 px wide is too large.
    let wide = dir.path().join("wide.png");
    GrayImage::new(16385, 1).save(&wide).unwrap();
    let e = err(import(&project, &wide));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, IMAGE_TOO_LARGE));

    // More than 64 MiB on disk.
    let big = dir.path().join("big.png");
    let file = fs::File::create(&big).unwrap();
    file.set_len(64 * 1024 * 1024 + 1).unwrap();
    drop(file);
    let e = err(import(&project, &big));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, IMAGE_TOO_LARGE));

    let junk = dir.path().join("junk.png");
    fs::write(&junk, b"not a picture at all").unwrap();
    let e = err(import(&project, &junk));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Parse, IMAGE_UNREADABLE));

    let missing = dir.path().join("missing.png");
    let e = err(import(&project, &missing));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, IMAGE_UNREADABLE));

    let folder = dir.path().join("folder.png");
    fs::create_dir_all(&folder).unwrap();
    let e = err(import(&project, &folder));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, IMAGE_UNREADABLE));

    let gif = dir.path().join("pic.gif");
    fs::write(&gif, b"GIF89a").unwrap();
    let e = err(import(&project, &gif));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, IMAGE_UNREADABLE));

    // Nothing was written.
    assert!(!project.join(ASSETS_DIR).exists());
}

#[test]
fn relative_unc_and_device_paths_are_refused() {
    let dir = TempDir::new("paths");
    let project = dir.path().join("project");
    let mut paths = vec![PathBuf::from("pic.png"), PathBuf::from("..").join("pic.png")];
    if cfg!(windows) {
        let real = dir.path().join("pic.png");
        RgbaImage::new(2, 2).save(&real).unwrap();
        let text = real.to_string_lossy().into_owned();
        paths.extend([
            PathBuf::from(r"\\server\share\pic.png"),
            PathBuf::from(format!(r"\\?\{text}")),
            PathBuf::from(format!(r"\\.\{text}")),
            PathBuf::from(r"\\?\UNC\server\share\pic.png"),
            PathBuf::from("//server/share/pic.png"),
            PathBuf::from(r"\pic.png"),
            PathBuf::from(r"C:pic.png"),
        ]);
        // The same file through a plain drive path is fine.
        assert!(import(&project, &real).is_ok());
    }
    for path in paths {
        let e = err(import(&project, &path));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, IMAGE_UNREADABLE), "{path:?}");
    }
}

#[test]
fn raw_rgba_round_trip_keeps_colour_under_alpha_zero() {
    let dir = TempDir::new("raw");
    let project = dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let (w, h) = (5u32, 3u32);
    let rgba: Vec<u8> =
        (0..w * h).flat_map(|i| [i as u8 * 10, 200 - i as u8, 77, if i % 2 == 0 { 0 } else { 255 }]).collect();
    let asset = write_rgba(&project, w, h, &rgba).unwrap();
    assert_eq!((asset.width, asset.height), (w, h));
    let png = fs::read(asset_file(&project, &asset.id)).unwrap();
    assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
    assert_eq!(read_rgba(&project, &asset.id).unwrap(), (w, h, rgba));
}

#[test]
fn raw_rgba_writes_check_the_size() {
    let dir = TempDir::new("raw-size");
    let project = dir.path().join("project");
    for (w, h, len) in
        [(0, 4, 0), (4, 0, 0), (2, 2, 15), (2, 2, 17), (MAX_ASSET_SIDE + 1, 1, (MAX_ASSET_SIDE as usize + 1) * 4)]
    {
        let e = err(write_rgba(&project, w, h, &vec![0; len]));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, ASSET_INVALID), "{w}x{h} {len}");
    }
    assert!(!project.join(ASSETS_DIR).exists());
}

#[test]
fn reading_needs_a_valid_existing_asset() {
    let dir = TempDir::new("read");
    let project = dir.path().join("project");
    fs::create_dir_all(project.join(ASSETS_DIR)).unwrap();
    let e = err(read_rgba(&project, "img-abc-1"));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, ASSET_NOT_FOUND));
    for bad in ["../project", "img-abc-1.png", "thumb", ""] {
        let e = err(read_rgba(&project, bad));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, ASSET_INVALID), "{bad:?}");
    }
    fs::write(asset_file(&project, "img-abc-2"), b"broken").unwrap();
    let e = err(read_rgba(&project, "img-abc-2"));
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Parse, ASSET_INVALID));
}

#[test]
fn referenced_ids_are_every_asset_id_string_in_the_project() {
    let layers = json!([
        { "kind": "base", "id": "l-1", "assetId": "img-a-1" },
        { "kind": "image", "assetId": "img-b-2", "sourceAssetId": "img-c-3", "decal": { "note": "img-d-4" } },
        { "kind": "text", "text": "not an id", "list": ["img-e-5", 7, null, { "deep": ["img-f-6"] }] },
        { "img-g-7": "key, not a value", "other": "img-XYZ-1" }
    ]);
    let ids = referenced_ids(&layers);
    let expected: HashSet<String> =
        ["img-a-1", "img-b-2", "img-c-3", "img-d-4", "img-e-5", "img-f-6"].into_iter().map(String::from).collect();
    assert_eq!(ids, expected);
}

#[test]
fn gc_keeps_referenced_and_session_ids_and_removes_the_rest() {
    let dir = TempDir::new("gc");
    let project = dir.path().join("project");
    let assets = project.join(ASSETS_DIR);
    fs::create_dir_all(&assets).unwrap();
    for id in ["img-a-1", "img-b-2", "img-c-3", "img-d-4"] {
        fs::write(asset_file(&project, id), b"png").unwrap();
    }
    fs::write(assets.join("img-e-5.png.tmp"), b"leftover").unwrap();
    fs::write(assets.join("notes.txt"), b"not ours").unwrap();
    fs::write(assets.join("other.png"), b"not an asset name").unwrap();

    let layers = json!([{ "kind": "image", "assetId": "img-a-1", "sourceAssetId": "img-b-2" }]);
    let referenced = referenced_ids(&layers);
    let session: HashSet<String> = ["img-c-3".to_owned()].into();
    assert_eq!(gc(&project, &referenced, &session), 2);
    let mut left: Vec<String> =
        fs::read_dir(&assets).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    left.sort();
    assert_eq!(left, ["img-a-1.png", "img-b-2.png", "img-c-3.png", "notes.txt", "other.png"]);

    // No assets folder: nothing to do.
    assert_eq!(gc(&dir.path().join("none"), &referenced, &session), 0);
}

#[test]
fn opening_a_project_keeps_saved_and_session_pictures() {
    let dir = TempDir::new("state");
    let state = AtelierState::new(&dir.path().join("atelier"));
    let slots = vec![AtelierSlotChoice { texture: "body_c".into(), enabled: true }];
    let project = state.projects().create("Test", "us_m4a3e2_sherman_jumbo", slots, SystemTime::now()).unwrap();
    let project_dir = state.projects().project_dir(&project.id).unwrap();

    // Made in this process through the state: kept although no layer uses it yet.
    let session = state.put_asset(&project.id, 1, 1, &[1, 2, 3, 4]).unwrap();
    // Left by an earlier session: one a saved layer uses (as its source), one nothing uses.
    let saved = write_rgba(&project_dir, 1, 1, &[5, 6, 7, 8]).unwrap();
    let stale = write_rgba(&project_dir, 1, 1, &[9, 9, 9, 9]).unwrap();
    let layers = json!([{ "kind": "image", "assetId": "img-ffff-1", "sourceAssetId": saved.id }]);
    state.projects().save(&AtelierProject { layers, ..project.clone() }, SystemTime::now()).unwrap();

    assert_eq!(state.collect_assets(&project.id).unwrap(), 1);
    assert!(asset_file(&project_dir, &session.id).is_file());
    assert!(asset_file(&project_dir, &saved.id).is_file());
    assert!(!asset_file(&project_dir, &stale.id).exists());
    assert_eq!(state.asset(&project.id, &session.id).unwrap(), (1, 1, vec![1, 2, 3, 4]));

    let e = err(state.collect_assets("p-0-0"));
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = err(state.put_asset("p-0-0", 1, 1, &[0; 4]));
    assert_eq!(e.code, ErrorCode::NotFound);
}
