//! The background-removal files: Microsoft's ONNX Runtime (only `onnxruntime.dll`, extracted from
//! the official release zip) and the isnet-anime model, downloaded on the user's click into
//! `<models>` (`app_local_data_dir()/models`, or `<data>/models` with `LIVERY_DATA_DIR`), with
//! pinned URLs, sizes and SHA-256s.
//!
//! Remove deletes what it can; a runtime this process loaded can't be deleted on Windows (the DLL
//! is mapped), so the folder is marked ([`REMOVE_MARKER`]) and the next launch purges it before
//! anything loads it. Downloads are refused while the mark is there.

use crate::atelier::download::{
    part_path, Downloader, Expected, Flight, MODEL_DOWNLOAD_CORRUPT, MODEL_DOWNLOAD_FAILED,
};
use crate::atelier::sha256::{hex, Sha256};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{CutoutStatus, DownloadItem};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// `conflict`: a download or a background removal is running.
pub const CUTOUT_BUSY: &str = "Background removal is busy, try again when it finishes";
/// `conflict`: a remove is waiting for a restart (see the module doc).
pub const CUTOUT_RESTART_NEEDED: &str = "Restart Livery to finish removing the background-removal files";

/// Sub-folder of the local app data folder.
pub const MODELS_DIR: &str = "models";
/// File in the models folder that marks it for removal at the next launch.
pub const REMOVE_MARKER: &str = ".remove";
/// Where the runtime zip is downloaded to (deleted once the DLL is out).
pub const RUNTIME_ZIP_FILE: &str = "onnxruntime-win-x64.zip";
pub const DLL_FILE: &str = "onnxruntime.dll";
pub const MODEL_FILE: &str = "isnet-anime.onnx";

// Pinned on 2026-10-16 from the files downloaded then (the author approved the one-off download).
//
// ONNX Runtime 1.30.0 (published 2026-09-10): the newest Microsoft release at least two weeks old
// with an `onnxruntime-win-x64-<ver>.zip`; `ort` 2.0.0-rc.13 needs ORT API 17 (1.17) or newer.
// Source: https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0 (MIT). The zip's
// `lib/onnxruntime_providers_shared.dll` is only for non-CPU execution providers and is not
// extracted. `onnxruntime.dll` (x64) imports, besides Windows' own DLLs (KERNEL32, ADVAPI32,
// SETUPAPI, dbghelp, dxgi, SHELL32 delay-loaded, api-ms-win-crt-*/api-ms-win-core-path), the
// Visual C++ 2015-2022 runtime: VCRUNTIME140.dll, VCRUNTIME140_1.dll (Livery itself needs these
// two), MSVCP140.dll and MSVCP140_1.dll (Livery doesn't: missing on a PC without the VC++
// Redistributable, which makes loading fail with error 126).
pub const ORT_VERSION: &str = "1.30.0";
pub const RUNTIME_ZIP_URL: &str =
    "https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-win-x64-1.30.0.zip";
pub const RUNTIME_ZIP_SIZE: u64 = 82_645_522;
pub const RUNTIME_ZIP_SHA256: &str = "c6ba983baf5681af108599675d2a89c2d145512d02de28aed0bff177cd0ba949";
pub const RUNTIME_DLL_ENTRY: &str = "onnxruntime-win-x64-1.30.0/lib/onnxruntime.dll";
pub const RUNTIME_DLL_SIZE: u64 = 16_462_648;
pub const RUNTIME_DLL_SHA256: &str = "7e39e2bdbba836d98071ef28620735ba36a47c554cf794585269aecc50fab0da";
/// Sub-folder of the models folder that holds the runtime's DLL.
pub const RUNTIME_DIR: &str = "ort-1.30.0";
// isnet-anime (SkyTNT anime-segmentation, Apache-2.0) as distributed by rembg. Same bytes as the
// author's reference copy (C:\Users\piera\.u2net\isnet-anime.onnx).
// Source: https://github.com/danielgatis/rembg/releases/tag/v0.0.0
pub const MODEL_URL: &str = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx";
pub const MODEL_SIZE: u64 = 176_069_933;
pub const MODEL_SHA256: &str = "f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99";

/// A size and a SHA-256 (lowercase hex).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileHash {
    pub size: u64,
    pub sha256: String,
}

/// A file to download: its URL, size and hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub url: String,
    pub hash: FileHash,
}

impl Pin {
    pub fn expected(&self) -> Expected<'_> {
        Expected { url: &self.url, size: self.hash.size, sha256: &self.hash.sha256 }
    }
}

/// Everything the install checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pins {
    pub runtime_zip: Pin,
    /// The DLL's path inside the zip.
    pub dll_entry: String,
    pub dll: FileHash,
    /// Folder (inside the models folder) the DLL goes to.
    pub runtime_dir: String,
    pub model: Pin,
}

/// The pinned files above.
pub fn pinned() -> Pins {
    Pins {
        runtime_zip: Pin {
            url: RUNTIME_ZIP_URL.to_owned(),
            hash: FileHash { size: RUNTIME_ZIP_SIZE, sha256: RUNTIME_ZIP_SHA256.to_owned() },
        },
        dll_entry: RUNTIME_DLL_ENTRY.to_owned(),
        dll: FileHash { size: RUNTIME_DLL_SIZE, sha256: RUNTIME_DLL_SHA256.to_owned() },
        runtime_dir: RUNTIME_DIR.to_owned(),
        model: Pin { url: MODEL_URL.to_owned(), hash: FileHash { size: MODEL_SIZE, sha256: MODEL_SHA256.to_owned() } },
    }
}

fn corrupt(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Parse, MODEL_DOWNLOAD_CORRUPT).with_detail(detail.into())
}

fn io_failed(e: io::Error) -> AppError {
    AppError::new(ErrorCode::Io, MODEL_DOWNLOAD_FAILED).with_detail(e.to_string())
}

/// SHA-256 of a file of exactly `expected.size` bytes; `false` for any other size.
fn file_matches(path: &Path, expected: &FileHash) -> io::Result<bool> {
    if fs::metadata(path)?.len() != expected.size {
        return Ok(false);
    }
    Ok(crate::atelier::sha256::file_hex(path)?.eq_ignore_ascii_case(&expected.sha256))
}

/// Extracts the runtime's DLL: checks the zip's size and hash first, then copies only the entry
/// `entry` to `dest` (through `<dest>.part`) and checks its size and hash. `parse`
/// ([`MODEL_DOWNLOAD_CORRUPT`]) for anything that doesn't match; `dest` is left untouched then.
pub fn extract_runtime(zip: &Path, zip_hash: &FileHash, entry: &str, dll: &FileHash, dest: &Path) -> AppResult<()> {
    if !file_matches(zip, zip_hash).map_err(io_failed)? {
        return Err(corrupt("runtime zip hash"));
    }
    let mut archive = zip::ZipArchive::new(io::BufReader::new(File::open(zip).map_err(io_failed)?))
        .map_err(|e| corrupt(e.to_string()))?;
    let mut file = archive.by_name(entry).map_err(|e| corrupt(format!("{entry}: {e}")))?;
    if file.size() != dll.size {
        return Err(corrupt(format!("{entry}: {} bytes", file.size())));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(io_failed)?;
    }
    let part = part_path(dest);
    let written = (|| {
        let mut out = File::create(&part).map_err(io_failed)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut total = 0u64;
        loop {
            let n = file.read(&mut buf).map_err(|e| corrupt(format!("{entry}: {e}")))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > dll.size {
                return Err(corrupt(format!("{entry}: more than {} bytes", dll.size)));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(io_failed)?;
        }
        out.sync_all().map_err(io_failed)?;
        let actual = hex(&hasher.finalize());
        if total != dll.size || !actual.eq_ignore_ascii_case(&dll.sha256) {
            return Err(corrupt(format!("{entry}: {total} bytes, sha256 {actual}")));
        }
        drop(out);
        crate::atelier::project::rename_retrying(&part, dest).map_err(io_failed)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&part);
    }
    written
}

/// The models folder and what it should hold.
pub struct ModelFiles {
    dir: PathBuf,
    pins: Pins,
}

impl ModelFiles {
    /// The pinned files in `dir` (nothing is created until a download).
    pub fn new(dir: &Path) -> Self {
        Self::with_pins(dir, pinned())
    }

    /// Other pins (tests serve their own files).
    #[doc(hidden)]
    pub fn with_pins(dir: &Path, pins: Pins) -> Self {
        Self { dir: dir.to_path_buf(), pins }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn runtime_dll(&self) -> PathBuf {
        self.dir.join(&self.pins.runtime_dir).join(DLL_FILE)
    }

    pub fn model_path(&self) -> PathBuf {
        self.dir.join(MODEL_FILE)
    }

    pub fn pins(&self) -> &Pins {
        &self.pins
    }

    fn has(path: &Path, size: u64) -> bool {
        fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == size)
    }

    /// The runtime's DLL is there with its pinned size (its hash is checked when it's loaded).
    pub fn has_runtime(&self) -> bool {
        Self::has(&self.runtime_dll(), self.pins.dll.size)
    }

    /// The model is there with its pinned size.
    pub fn has_model(&self) -> bool {
        Self::has(&self.model_path(), self.pins.model.hash.size)
    }

    pub fn pending_removal(&self) -> bool {
        self.dir.join(REMOVE_MARKER).exists()
    }

    pub fn status(&self) -> CutoutStatus {
        let pending = self.pending_removal();
        let runtime = !pending && self.has_runtime();
        let model = !pending && self.has_model();
        let download_bytes = if runtime { 0 } else { self.pins.runtime_zip.hash.size }
            + if model { 0 } else { self.pins.model.hash.size };
        CutoutStatus { runtime, model, bytes: folder_bytes(&self.dir), download_bytes, pending_removal: pending }
    }

    /// Downloads and installs what's missing: the runtime (zip, then only its DLL) and the model.
    /// `progress(item, received, total)` follows each download. `conflict`
    /// ([`CUTOUT_RESTART_NEEDED`]) while a remove waits for a restart.
    pub fn install(
        &self,
        downloader: &Downloader,
        flight: &Flight<'_>,
        progress: &mut dyn FnMut(DownloadItem, u64, u64),
    ) -> AppResult<()> {
        if self.pending_removal() {
            return Err(AppError::new(ErrorCode::Conflict, CUTOUT_RESTART_NEEDED));
        }
        fs::create_dir_all(&self.dir).map_err(io_failed)?;
        if !self.has_runtime() {
            let zip = self.dir.join(RUNTIME_ZIP_FILE);
            downloader.download(flight, self.pins.runtime_zip.expected(), &zip, &mut |received, total| {
                progress(DownloadItem::Runtime, received, total)
            })?;
            let pins = &self.pins;
            let extracted =
                extract_runtime(&zip, &pins.runtime_zip.hash, &pins.dll_entry, &pins.dll, &self.runtime_dll());
            let _ = fs::remove_file(&zip);
            extracted?;
        }
        if !self.has_model() {
            downloader.download(flight, self.pins.model.expected(), &self.model_path(), &mut |received, total| {
                progress(DownloadItem::Model, received, total)
            })?;
        }
        Ok(())
    }

    /// Deletes every file of the models folder. What can't go (a loaded runtime) stays, and the
    /// folder is marked for the next launch ([`Self::purge_pending`]); it is marked too when
    /// `runtime_loaded` (this process loaded the runtime, which stays mapped until it ends). The
    /// caller makes sure no download or background removal runs.
    pub fn remove(&self, runtime_loaded: bool) -> CutoutStatus {
        let left = match fs::read_dir(&self.dir) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .filter(|e| e.file_name() != REMOVE_MARKER)
                .filter(|e| {
                    let path = e.path();
                    let removed = if e.file_type().is_ok_and(|t| t.is_dir()) {
                        fs::remove_dir_all(&path)
                    } else {
                        fs::remove_file(&path)
                    };
                    if let Err(err) = &removed {
                        tracing::info!(error = %err, file = %e.file_name().to_string_lossy(), "kept until the next launch");
                    }
                    removed.is_err()
                })
                .count(),
            Err(_) => 0,
        };
        if left > 0 || (runtime_loaded && self.dir.is_dir()) {
            if let Err(e) = fs::write(self.dir.join(REMOVE_MARKER), b"") {
                tracing::warn!(error = %e, "the background-removal files can't be marked for removal");
            }
        }
        self.status()
    }

    /// At launch: unfinished downloads (`*.part`, anywhere in the folder) and a runtime zip left
    /// by an interrupted install go. Returns how many files went.
    pub fn clean_leftovers(&self) -> usize {
        fn clean(dir: &Path) -> usize {
            let Ok(entries) = fs::read_dir(dir) else { return 0 };
            entries
                .filter_map(Result::ok)
                .map(|e| {
                    let Ok(kind) = e.file_type() else { return 0 };
                    if kind.is_dir() {
                        return clean(&e.path());
                    }
                    if kind.is_file() && is_leftover(&e.file_name().to_string_lossy()) {
                        return usize::from(fs::remove_file(e.path()).is_ok());
                    }
                    0
                })
                .sum()
        }
        clean(&self.dir)
    }

    /// At launch, before anything loads the runtime: a folder marked by [`Self::remove`] goes
    /// whole (links inside it are removed, never followed). Returns whether it went.
    pub fn purge_pending(&self) -> bool {
        if !self.pending_removal() {
            return false;
        }
        match fs::remove_dir_all(&self.dir) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(error = %e, "the background-removal files marked for removal are still there");
                false
            }
        }
    }
}

/// A file of the models folder that an unfinished download or install left behind.
fn is_leftover(name: &str) -> bool {
    name.ends_with(".part") || name == RUNTIME_ZIP_FILE
}

/// Bytes of the files under `dir` (0 when it's missing), without download leftovers.
fn folder_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .filter_map(Result::ok)
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => folder_bytes(&e.path()),
            Ok(t) if t.is_file() && !is_leftover(&e.file_name().to_string_lossy()) => {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
            _ => 0,
        })
        .sum()
}
