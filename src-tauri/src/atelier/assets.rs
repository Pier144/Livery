//! Pictures of an Atelier project: `<project>/assets/<id>.png`, RGBA8 with straight alpha, at most
//! [`MAX_ASSET_SIDE`] on a side, ids from `new_id_with("img")`.
//!
//! Imports decode the user's file in Rust (`image`), turn it upright from its EXIF orientation and
//! scale it down; the frontend reads and writes assets as raw RGBA (never PNG through a canvas,
//! whose premultiplication would lose the colour under alpha 0). Pictures no saved layer
//! references go when the editor opens the project ([`gc`]), except those made in this process.

use crate::atelier::project::{write_atomic, PROJECT_SAVE_FAILED};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::index::new_id_with;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::{self, FilterType};
use image::metadata::Orientation;
use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageError, ImageFormat, ImageReader, Limits,
};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

pub use crate::model::AssetRef;

/// A picture that can't be imported: a refused path or extension (`invalidInput`), a missing
/// file (`notFound`), a file that doesn't decode (`parse`).
pub const IMAGE_UNREADABLE: &str = "This picture can't be read";
/// `invalidInput`: more than [`MAX_IMPORT_BYTES`] on disk or [`MAX_SOURCE_SIDE`] on a side, or
/// more memory to decode than [`MAX_DECODE_ALLOC`].
pub const IMAGE_TOO_LARGE: &str = "This picture is too large";
/// `notFound`: the project has no picture with this id.
pub const ASSET_NOT_FOUND: &str = "This picture is missing from the project";
/// `invalidInput`: not an asset id, or raw pixels whose size doesn't check out; `parse`: a stored
/// picture that doesn't decode.
pub const ASSET_INVALID: &str = "This picture can't be used";

/// Sub-folder of a project's folder that holds its pictures.
pub const ASSETS_DIR: &str = "assets";
/// Prefix of asset ids (`img-<hex nanoseconds>-<counter>`).
pub const ASSET_ID_PREFIX: &str = "img";
/// Largest picture file imported.
pub const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;
/// Largest side of a picture imported (checked from its header before decoding).
pub const MAX_SOURCE_SIDE: u32 = 16384;
/// Largest side of a stored picture; imports are scaled down to it.
pub const MAX_ASSET_SIDE: u32 = 4096;
/// Memory the decoder may allocate for one picture.
pub const MAX_DECODE_ALLOC: u64 = 1024 * 1024 * 1024;
/// Extensions an import accepts (any case).
pub const IMPORT_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "bmp", "tga"];
/// Imports decoding at the same time (each can take about 1 GiB at its peak).
pub const MAX_CONCURRENT_IMPORTS: usize = 2;
/// Stored PNGs larger than this aren't read (a 4096² RGBA picture stored raw is 64 MiB).
const MAX_STORED_BYTES: u64 = 128 * 1024 * 1024;

/// Exactly the format of `new_id_with("img")`: `img-`, lowercase hex without leading zeros (at
/// most 32 digits), `-`, decimal without leading zeros (at most 20 digits).
pub fn is_asset_id(id: &str) -> bool {
    fn canonical(s: &str, max: usize, digit: fn(u8) -> bool) -> bool {
        !s.is_empty() && s.len() <= max && s.bytes().all(digit) && (s == "0" || !s.starts_with('0'))
    }
    let Some(rest) = id.strip_prefix(ASSET_ID_PREFIX).and_then(|r| r.strip_prefix('-')) else { return false };
    let Some((nanos, counter)) = rest.split_once('-') else { return false };
    canonical(nanos, 32, |b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && canonical(counter, 20, |b| b.is_ascii_digit())
}

/// An absolute path on a local drive (`C:\…`): never relative, drive-relative (`C:x`), rooted
/// without a drive (`\x`), UNC (`\\server\…`) or a device/verbatim path (`\\?\…`, `\\.\…`).
pub fn is_local_absolute(path: &Path) -> bool {
    let text = path.as_os_str().to_string_lossy();
    if text.starts_with(r"\\") || text.starts_with("//") || text.starts_with(r"/\") || text.starts_with(r"\/") {
        return false;
    }
    path.is_absolute() && plain_drive(path)
}

#[cfg(windows)]
fn plain_drive(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
}

#[cfg(not(windows))]
fn plain_drive(_path: &Path) -> bool {
    true
}

fn unreadable(code: ErrorCode, detail: impl Into<String>) -> AppError {
    AppError::new(code, IMAGE_UNREADABLE).with_detail(detail.into())
}

fn too_large(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, IMAGE_TOO_LARGE).with_detail(detail.into())
}

fn invalid_asset(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, ASSET_INVALID).with_detail(detail.into())
}

fn decode_error(e: ImageError) -> AppError {
    match e {
        ImageError::Limits(e) => too_large(e.to_string()),
        e => unreadable(ErrorCode::Parse, e.to_string()),
    }
}

/// The format an import's extension names, or `invalidInput` ([`IMAGE_UNREADABLE`]) for a path
/// [`is_local_absolute`] refuses or an extension outside [`IMPORT_EXTENSIONS`].
fn checked_source(source: &Path) -> AppResult<ImageFormat> {
    if !is_local_absolute(source) {
        return Err(unreadable(ErrorCode::InvalidInput, "not a local absolute path"));
    }
    let ext = source.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !IMPORT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(unreadable(ErrorCode::InvalidInput, format!("extension {ext:?}")));
    }
    ImageFormat::from_extension(&ext).ok_or_else(|| unreadable(ErrorCode::InvalidInput, format!("extension {ext:?}")))
}

/// `path` with a `\\?\C:\` (verbatim drive) prefix written as `C:\`; other paths as they are.
#[cfg(windows)]
fn without_verbatim_drive(path: &Path) -> PathBuf {
    use std::path::{Component, Prefix};
    let mut components = path.components();
    match components.next() {
        Some(Component::Prefix(p)) => match p.kind() {
            Prefix::VerbatimDisk(letter) => {
                let mut plain = PathBuf::from(format!("{}:\\", char::from(letter)));
                plain.extend(components.filter(|c| matches!(c, Component::Normal(_))));
                plain
            }
            _ => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

#[cfg(not(windows))]
fn without_verbatim_drive(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/// The file `source` really is (links and junctions followed), which must still be on a local
/// drive ([`is_local_absolute`]): a link can't lead an import to a share.
pub fn canonical_source(source: &Path) -> AppResult<PathBuf> {
    let canonical = fs::canonicalize(source).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => unreadable(ErrorCode::NotFound, e.to_string()),
        _ => unreadable(ErrorCode::Io, e.to_string()),
    })?;
    let plain = without_verbatim_drive(&canonical);
    if !is_local_absolute(&plain) {
        // On purpose: a mapped network drive (`Z:\` resolves to `\\?\UNC\server\…`), a link to a
        // share and a UNC path are all refused alike; pictures are imported from local drives
        // only, so no import reaches out to another machine.
        return Err(unreadable(ErrorCode::InvalidInput, "network location"));
    }
    Ok(plain)
}

/// The file's bytes, at most [`MAX_IMPORT_BYTES`].
fn read_source(source: &Path) -> AppResult<Vec<u8>> {
    let meta = fs::metadata(source).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => unreadable(ErrorCode::NotFound, e.to_string()),
        _ => unreadable(ErrorCode::Io, e.to_string()),
    })?;
    if !meta.is_file() {
        return Err(unreadable(ErrorCode::InvalidInput, "not a file"));
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(too_large(format!("{} bytes", meta.len())));
    }
    let file = fs::File::open(source).map_err(|e| unreadable(ErrorCode::Io, e.to_string()))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_IMPORT_BYTES + 1).read_to_end(&mut bytes).map_err(|e| unreadable(ErrorCode::Io, e.to_string()))?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(too_large(format!("more than {MAX_IMPORT_BYTES} bytes")));
    }
    Ok(bytes)
}

/// `w`×`h` scaled to fit `max` on the long side (aspect kept, at least 1 px a side).
fn fit(w: u32, h: u32, max: u32) -> (u32, u32) {
    if w.max(h) <= max {
        return (w, h);
    }
    let scale = f64::from(max) / f64::from(w.max(h));
    let side = |s: u32| ((f64::from(s) * scale).round() as u32).clamp(1, max);
    (side(w), side(h))
}

/// Decodes a picture file's bytes (`format` from its extension, unless the content says
/// otherwise), with its EXIF orientation.
fn decode_picture(bytes: &[u8], format: ImageFormat) -> AppResult<(DynamicImage, Orientation)> {
    let reader = || {
        ImageReader::with_format(Cursor::new(bytes), format)
            .with_guessed_format()
            .map_err(|e| unreadable(ErrorCode::Io, e.to_string()))
    };
    let (w, h) = reader()?.into_dimensions().map_err(decode_error)?;
    if w > MAX_SOURCE_SIDE || h > MAX_SOURCE_SIDE {
        return Err(too_large(format!("{w}x{h}")));
    }
    if w == 0 || h == 0 {
        return Err(unreadable(ErrorCode::Parse, format!("{w}x{h}")));
    }
    let mut reader = reader()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_SIDE);
    limits.max_image_height = Some(MAX_SOURCE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(decode_error)?;
    // A damaged EXIF block leaves the picture as stored.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let picture = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    Ok((picture, orientation))
}

/// A decoded picture upright, RGBA8 with straight alpha, at most [`MAX_ASSET_SIDE`] on a side.
fn upright_rgba(mut picture: DynamicImage, orientation: Orientation) -> image::RgbaImage {
    // Integer averaging first, so Lanczos3's f32 intermediate stays small for huge pictures.
    let (tw, th) = fit(picture.width(), picture.height(), 2 * MAX_ASSET_SIDE);
    if (tw, th) != (picture.width(), picture.height()) {
        picture = picture.thumbnail_exact(tw, th);
    }
    picture.apply_orientation(orientation);
    let mut rgba = picture.into_rgba8();
    let (tw, th) = fit(rgba.width(), rgba.height(), MAX_ASSET_SIDE);
    if (tw, th) != (rgba.width(), rgba.height()) {
        rgba = imageops::resize(&rgba, tw, th, FilterType::Lanczos3);
    }
    rgba
}

/// Reads and decodes a picture the user picked (see [`import`] for the checks), without storing
/// it. Commands call this outside the project lock, then [`write_rgba`].
pub fn load_picture(source: &Path) -> AppResult<image::RgbaImage> {
    let format = checked_source(source)?;
    let bytes = read_source(&canonical_source(source)?)?;
    let (picture, orientation) = decode_picture(&bytes, format)?;
    // The file's bytes go before the scaling needs its memory.
    drop(bytes);
    Ok(upright_rgba(picture, orientation))
}

/// A counting semaphore: at most `max` holders at once, the others wait.
pub struct Slots {
    max: usize,
    used: Mutex<usize>,
    freed: Condvar,
}

/// One slot of [`Slots`], given back on drop.
pub struct Slot<'a>(&'a Slots);

impl Slots {
    pub fn new(max: usize) -> Self {
        Self { max: max.max(1), used: Mutex::new(0), freed: Condvar::new() }
    }

    /// Waits for a free slot.
    pub fn acquire(&self) -> Slot<'_> {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        while *used >= self.max {
            used = self.freed.wait(used).unwrap_or_else(|e| e.into_inner());
        }
        *used += 1;
        Slot(self)
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut used = self.0.used.lock().unwrap_or_else(|e| e.into_inner());
        *used -= 1;
        self.0.freed.notify_one();
    }
}

/// `w`×`h` RGBA8 in `rgba`, sides 1 to [`MAX_ASSET_SIDE`], else `invalidInput` ([`ASSET_INVALID`]).
pub fn check_rgba(w: u32, h: u32, rgba: &[u8]) -> AppResult<()> {
    let side_ok = |s: u32| s > 0 && s <= MAX_ASSET_SIDE;
    let expected = (w as usize).checked_mul(h as usize).and_then(|n| n.checked_mul(4));
    if !side_ok(w) || !side_ok(h) || expected != Some(rgba.len()) {
        return Err(invalid_asset(format!("{w}x{h} picture in {} bytes", rgba.len())));
    }
    Ok(())
}

/// RGBA8 pixels (`w`×`h`, see [`check_rgba`]) as a PNG.
pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> AppResult<Vec<u8>> {
    check_rgba(w, h, rgba)?;
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, PngFilter::Adaptive)
        .write_image(rgba, w, h, ExtendedColorType::Rgba8)
        .map_err(|e| AppError::new(ErrorCode::Internal, ASSET_INVALID).with_detail(e.to_string()))?;
    Ok(png)
}

/// Stores raw RGBA8 pixels (`w`×`h`, see [`check_rgba`]) as a new asset of the project in
/// `project_dir`.
pub fn write_rgba(project_dir: &Path, w: u32, h: u32, rgba: &[u8]) -> AppResult<AssetRef> {
    let png = encode_png(w, h, rgba)?;
    store_png(project_dir, w, h, &png)
}

/// Stores a PNG made by [`encode_png`] (`w`×`h`) as a new asset of the project in `project_dir`.
pub fn store_png(project_dir: &Path, w: u32, h: u32, png: &[u8]) -> AppResult<AssetRef> {
    let save_failed = |e: io::Error| AppError::new(ErrorCode::Io, PROJECT_SAVE_FAILED).with_detail(e.to_string());
    let dir = project_dir.join(ASSETS_DIR);
    fs::create_dir_all(&dir).map_err(save_failed)?;
    let id = new_id_with(ASSET_ID_PREFIX);
    write_atomic(&asset_path(project_dir, &id), png).map_err(save_failed)?;
    Ok(AssetRef { id, width: w, height: h })
}

fn asset_path(project_dir: &Path, id: &str) -> PathBuf {
    project_dir.join(ASSETS_DIR).join(format!("{id}.png"))
}

/// Imports a picture into the project in `project_dir`: `source` must be a local absolute path
/// ([`is_local_absolute`]) to a file of at most [`MAX_IMPORT_BYTES`] with an extension of
/// [`IMPORT_EXTENSIONS`] and at most [`MAX_SOURCE_SIDE`] on a side. Stored upright (EXIF
/// orientation), RGBA8 with straight alpha, scaled to at most [`MAX_ASSET_SIDE`].
pub fn import(project_dir: &Path, source: &Path) -> AppResult<AssetRef> {
    let picture = load_picture(source)?;
    write_rgba(project_dir, picture.width(), picture.height(), picture.as_raw())
}

/// An asset's size and RGBA8 pixels (straight alpha).
pub fn read_rgba(project_dir: &Path, id: &str) -> AppResult<(u32, u32, Vec<u8>)> {
    if !is_asset_id(id) {
        return Err(invalid_asset(format!("id {id:?}")));
    }
    let path = asset_path(project_dir, id);
    let file = fs::File::open(&path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => AppError::new(ErrorCode::NotFound, ASSET_NOT_FOUND).with_detail(id.to_owned()),
        _ => AppError::new(ErrorCode::Io, ASSET_INVALID).with_detail(format!("{id}: {e}")),
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_STORED_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::new(ErrorCode::Io, ASSET_INVALID).with_detail(format!("{id}: {e}")))?;
    let parse = |detail: String| AppError::new(ErrorCode::Parse, ASSET_INVALID).with_detail(format!("{id}: {detail}"));
    if bytes.len() as u64 > MAX_STORED_BYTES {
        return Err(parse(format!("{} bytes", bytes.len())));
    }
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_ASSET_SIDE);
    limits.max_image_height = Some(MAX_ASSET_SIDE);
    reader.limits(limits);
    let picture = reader.decode().map_err(|e| parse(e.to_string()))?.into_rgba8();
    Ok((picture.width(), picture.height(), picture.into_raw()))
}

/// Every string value anywhere in `value` that is an asset id (object keys aren't values).
pub fn referenced_ids(value: &serde_json::Value) -> HashSet<String> {
    fn walk(value: &serde_json::Value, ids: &mut HashSet<String>) {
        match value {
            serde_json::Value::String(s) if is_asset_id(s) => {
                ids.insert(s.clone());
            }
            serde_json::Value::Array(items) => items.iter().for_each(|v| walk(v, ids)),
            serde_json::Value::Object(map) => map.values().for_each(|v| walk(v, ids)),
            _ => {}
        }
    }
    let mut ids = HashSet::new();
    walk(value, &mut ids);
    ids
}

/// Removes the project's assets (`<id>.png`, and `<id>.png.tmp` left by an interrupted write)
/// whose id is neither in `referenced` nor in `created_this_session`. Other files stay. Returns
/// how many files went.
pub fn gc(project_dir: &Path, referenced: &HashSet<String>, created_this_session: &HashSet<String>) -> usize {
    let Ok(entries) = fs::read_dir(project_dir.join(ASSETS_DIR)) else { return 0 };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".png").or_else(|| name.strip_suffix(".png.tmp"));
            let unused =
                id.is_some_and(|id| is_asset_id(id) && !referenced.contains(id) && !created_this_session.contains(id));
            if !unused || !entry.file_type().is_ok_and(|t| t.is_file()) {
                return false;
            }
            match fs::remove_file(entry.path()) {
                Ok(()) => true,
                Err(e) => {
                    tracing::warn!(error = %e, file = %name, "unused Atelier picture not removed");
                    false
                }
            }
        })
        .count()
}
