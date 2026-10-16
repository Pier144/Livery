//! Background removal with isnet-anime through ONNX Runtime (`ort`, `load-dynamic`), on this PC
//! only: nothing here touches the network.
//!
//! **Integrity.** The model is hashed once per process before its first session (and again when
//! a session can't be made from it); a model that isn't the pinned one is deleted, so the next
//! download fetches it again. The runtime's DLL is opened sharing only reads (nobody can replace
//! it), hashed through that handle, and kept open until `ort` has loaded it.
//!
//! **Loading.** The runtime's DLL (downloaded by `models`) is hashed before its first load in a
//! process, then preloaded with `LoadLibraryExW(…, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
//! LOAD_LIBRARY_SEARCH_SYSTEM32)`, so its own imports resolve only from its folder and System32
//! (never the current folder or `PATH`); `ort::init_from` then loads the same full path, which
//! reuses that module. The environment is `livery` with telemetry off, set once per process: a
//! runtime at another path needs a restart. The module stays loaded until the process ends.
//!
//! **Pipeline** (as the author's `isnet.py`): Lanczos3 to 1024², `v/255 - mean` (std 1), NCHW;
//! the first output plane min-max normalised, Lanczos3 back to the source size, alpha = mask ×
//! source alpha with the source RGB untouched, cropped to the alpha > 20 box plus a 16 px margin.
//!
//! **Session.** Kept for [`SESSION_IDLE`] after its last use (checked on use and by
//! [`Cutout::drop_idle`]). One run at a time; [`Cutout::cancel`] terminates a run through its
//! `RunOptions`, held outside the session's lock.

use crate::atelier::models::FileHash;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{CutoutStep, PixelRect};
use image::imageops::{self, FilterType};
use image::{GrayImage, RgbaImage};
use ort::session::{RunOptions, Session};
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// `notFound`: the background-removal files aren't downloaded (or a removal waits for a restart,
/// or the runtime's DLL doesn't match its pinned hash and was deleted).
pub const CUTOUT_NOT_READY: &str = "Download the background-removal files first";
/// `internal`: the runtime or the model failed to load or run.
pub const CUTOUT_FAILED: &str = "The background couldn't be removed";
/// `unsupported`: the runtime's DLL needs a DLL Windows can't find (error 126), in practice the
/// Visual C++ runtime's `MSVCP140.dll`.
pub const CUTOUT_RUNTIME_MISSING_DEPS: &str =
    "Background removal needs the Microsoft Visual C++ Redistributable (x64): install it, then try again";
/// `internal`: the user cancelled the run (the frontend shows no error for it). Cancels share
/// the `internal` code with real failures: the message constant tells them apart (as
/// `download::MODEL_DOWNLOAD_CANCELLED` does for downloads).
pub const CUTOUT_CANCELLED: &str = "Background removal cancelled";

/// Side of the model's square input.
pub const SIDE: u32 = 1024;
/// Per-channel mean subtracted from `v / 255` (the std is 1).
pub const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// Alpha above which a pixel counts for the crop.
pub const ALPHA_THRESHOLD: u8 = 20;
/// Pixels kept around the alpha box (clamped to the picture).
pub const CROP_MARGIN: u32 = 16;
/// A session unused this long is dropped (its model takes ~200 MB of memory).
pub const SESSION_IDLE: Duration = Duration::from_secs(5 * 60);

fn failed(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Internal, CUTOUT_FAILED).with_detail(detail.into())
}

fn cancelled() -> AppError {
    AppError::new(ErrorCode::Internal, CUTOUT_CANCELLED)
}

// ── Pure pre- and post-processing ──────────────────────────────────────────

/// The model's input for `source`: its RGB scaled to [`SIDE`]² (Lanczos3), `v / 255 - MEAN[c]`,
/// as NCHW planes (R, then G, then B), row by row.
pub fn preprocess(source: &RgbaImage) -> Vec<f32> {
    let resized = imageops::resize(source, SIDE, SIDE, FilterType::Lanczos3);
    let plane = (SIDE * SIDE) as usize;
    let mut data = vec![0f32; 3 * plane];
    for (i, px) in resized.pixels().enumerate() {
        for c in 0..3 {
            data[c * plane + i] = f32::from(px[c]) / 255.0 - MEAN[c];
        }
    }
    data
}

/// A mask plane min-max normalised to 0–255 (all 0 when it is flat or not finite).
pub fn normalise_mask(plane: &[f32]) -> Vec<u8> {
    let (min, max) = plane
        .iter()
        .filter(|v| v.is_finite())
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let range = max - min;
    if !range.is_finite() || range <= f32::EPSILON {
        return vec![0; plane.len()];
    }
    plane
        .iter()
        .map(|&v| if v.is_finite() { ((v - min) / range * 255.0).round().clamp(0.0, 255.0) as u8 } else { 0 })
        .collect()
}

/// `source` with alpha = `mask` (`mask_side`² 0–255, scaled to the source with Lanczos3) × its
/// own alpha; RGB untouched.
pub fn apply_mask(source: &RgbaImage, mask: &[u8], mask_side: u32) -> RgbaImage {
    let mask = GrayImage::from_raw(mask_side, mask_side, mask.to_vec()).expect("mask of mask_side²");
    let mask = imageops::resize(&mask, source.width(), source.height(), FilterType::Lanczos3);
    let mut out = source.clone();
    for (px, m) in out.pixels_mut().zip(mask.pixels()) {
        px[3] = ((u16::from(px[3]) * u16::from(m[0]) + 127) / 255) as u8;
    }
    out
}

/// The smallest rectangle holding every pixel with alpha above `threshold`.
pub fn alpha_bbox(picture: &RgbaImage, threshold: u8) -> Option<PixelRect> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, px) in picture.enumerate_pixels() {
        if px[3] > threshold {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    (x0 != u32::MAX).then(|| PixelRect { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 })
}

/// `bbox` grown by `margin` on every side, clamped to a `w`×`h` picture.
pub fn with_margin(bbox: PixelRect, margin: u32, w: u32, h: u32) -> PixelRect {
    let x = bbox.x.saturating_sub(margin);
    let y = bbox.y.saturating_sub(margin);
    let right = (bbox.x + bbox.w).saturating_add(margin).min(w);
    let bottom = (bbox.y + bbox.h).saturating_add(margin).min(h);
    PixelRect { x, y, w: right - x, h: bottom - y }
}

/// The cut-out picture from the model's first output plane (`SIDE`²): masked, then cropped to
/// the alpha box plus [`CROP_MARGIN`]. `None` when nothing is above [`ALPHA_THRESHOLD`].
pub fn postprocess(source: &RgbaImage, plane: &[f32]) -> Option<(RgbaImage, PixelRect)> {
    let masked = apply_mask(source, &normalise_mask(plane), SIDE);
    let bbox = alpha_bbox(&masked, ALPHA_THRESHOLD)?;
    let crop = with_margin(bbox, CROP_MARGIN, masked.width(), masked.height());
    let cut = imageops::crop_imm(&masked, crop.x, crop.y, crop.w, crop.h).to_image();
    Some((cut, crop))
}

// ── Loading the runtime ────────────────────────────────────────────────────

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
    const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(file_name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn GetLastError() -> u32;
    }

    /// Loads the DLL at `path` (absolute) with its imports searched only in its own folder and
    /// System32. The module is never freed. `Err` holds the Windows error code.
    pub fn preload(path: &Path) -> Result<(), u32> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call; the reserved
        // handle argument must be null.
        let module = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if module.is_null() {
            // SAFETY: no other call in between can change this thread's last error.
            Err(unsafe { GetLastError() })
        } else {
            Ok(())
        }
    }
}

/// Windows' "the specified module could not be found" for a DLL a loaded DLL imports.
pub const ERROR_MOD_NOT_FOUND: u32 = 126;

/// What a failed preload means for the user.
pub fn preload_error(code: u32) -> AppError {
    if code == ERROR_MOD_NOT_FOUND {
        AppError::new(ErrorCode::Unsupported, CUTOUT_RUNTIME_MISSING_DEPS)
            .with_detail(format!("LoadLibraryExW error {code}"))
    } else {
        failed(format!("LoadLibraryExW error {code}"))
    }
}

/// Threads for one run: half the cores, 1 to 8.
fn intra_threads() -> usize {
    (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2) / 2).clamp(1, 8)
}

// ── Running ────────────────────────────────────────────────────────────────

/// The background remover of a process (see the module doc).
#[derive(Default)]
pub struct Cutout {
    /// The DLL this process loaded, once a load succeeded.
    loaded: Mutex<Option<PathBuf>>,
    /// The model file found to match its pin in this process (hashed once).
    model_verified: Mutex<Option<PathBuf>>,
    /// The model's session and when it was last used.
    session: Mutex<Option<(Session, Instant)>>,
    /// The running inference's options (for cancel), outside the session's lock.
    current: Mutex<Option<Arc<RunOptions>>>,
    running: AtomicBool,
    cancel: AtomicBool,
}

/// While held, a run is in progress.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Cutout {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Whether this process loaded the runtime (its DLL can't be deleted until the process ends).
    pub fn runtime_loaded(&self) -> bool {
        self.loaded.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    /// Stops the running inference (nothing when none runs); its `run` returns
    /// [`CUTOUT_CANCELLED`].
    pub fn cancel(&self) {
        if !self.is_running() {
            return;
        }
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(options) = self.current.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            if let Err(e) = options.terminate() {
                tracing::warn!(error = %e, "background removal can't be stopped");
            }
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Drops a session unused for [`SESSION_IDLE`] (skipped while a run holds it).
    pub fn drop_idle(&self) {
        if let Ok(mut session) = self.session.try_lock() {
            if session.as_ref().is_some_and(|(_, used)| used.elapsed() >= SESSION_IDLE) {
                *session = None;
                tracing::debug!("background-removal session dropped after idling");
            }
        }
    }

    /// Drops the session now (before the files are removed); the model is hashed again next time.
    pub fn unload(&self) {
        *self.session.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.model_verified.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Checks the model at `model` against `hash` (once per process unless `again`); a model that
    /// doesn't match is deleted and reads as `notFound` ([`CUTOUT_NOT_READY`]).
    fn verify_model(&self, model: &Path, hash: &FileHash, again: bool) -> AppResult<()> {
        let mut verified = self.model_verified.lock().unwrap_or_else(|e| e.into_inner());
        if !again && verified.as_deref() == Some(model) {
            return Ok(());
        }
        *verified = None;
        let not_ready = |detail: String| AppError::new(ErrorCode::NotFound, CUTOUT_NOT_READY).with_detail(detail);
        let size = std::fs::metadata(model).map_err(|e| not_ready(e.to_string()))?.len();
        let actual = if size == hash.size {
            crate::atelier::sha256::file_hex(model).map_err(|e| not_ready(e.to_string()))?
        } else {
            format!("{size} bytes")
        };
        if !actual.eq_ignore_ascii_case(&hash.sha256) {
            if let Err(e) = std::fs::remove_file(model) {
                tracing::warn!(error = %e, "a background-removal model that isn't the pinned one can't be deleted");
            }
            return Err(not_ready(format!("model {actual}")));
        }
        *verified = Some(model.to_path_buf());
        Ok(())
    }

    /// Loads the runtime at `dll` once per process (see the module doc).
    fn ensure_runtime(&self, dll: &Path, dll_hash: &FileHash) -> AppResult<()> {
        let mut loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(path) = loaded.as_ref() {
            if path == dll {
                return Ok(());
            }
            return Err(failed(format!(
                "a runtime from another folder is loaded: restart Livery ({})",
                path.display()
            )));
        }
        let not_ready =
            |e: std::io::Error| AppError::new(ErrorCode::NotFound, CUTOUT_NOT_READY).with_detail(e.to_string());
        // Held open (sharing reads only) from the hash until `ort` has loaded the DLL, so it
        // can't be swapped in between.
        let held = open_read_only_shared(dll).map_err(not_ready)?;
        let actual = crate::atelier::sha256::reader_hex(&held).map_err(not_ready)?;
        if !actual.eq_ignore_ascii_case(&dll_hash.sha256) {
            // Not the pinned DLL: never load it; the next download brings the right one.
            drop(held);
            let _ = std::fs::remove_file(dll);
            return Err(
                AppError::new(ErrorCode::NotFound, CUTOUT_NOT_READY).with_detail(format!("runtime sha256 {actual}"))
            );
        }
        #[cfg(windows)]
        win::preload(dll).map_err(preload_error)?;
        let builder = ort::init_from(dll).map_err(|e| failed(e.to_string()))?;
        if !builder.with_name("livery").with_telemetry(false).commit() {
            tracing::warn!("an ONNX Runtime environment was already configured");
        }
        drop(held);
        tracing::info!("ONNX Runtime loaded for background removal");
        *loaded = Some(dll.to_path_buf());
        Ok(())
    }

    /// The model's session (made now when there is none or it idled out).
    fn session(&self, model: &Path, hash: &FileHash) -> AppResult<MutexGuard<'_, Option<(Session, Instant)>>> {
        let mut session = self.session.lock().unwrap_or_else(|e| e.into_inner());
        if session.as_ref().is_some_and(|(_, used)| used.elapsed() >= SESSION_IDLE) {
            *session = None;
        }
        if session.is_none() {
            self.verify_model(model, hash, false)?;
            let started = Instant::now();
            let built = Session::builder()
                .map_err(|e| failed(e.to_string()))?
                .with_intra_threads(intra_threads())
                .map_err(|e| failed(e.to_string()))?
                .commit_from_file(model);
            let built = match built {
                Ok(built) => built,
                // Changed since it was checked? Then it goes, and the download fetches it again.
                Err(e) => {
                    self.verify_model(model, hash, true)?;
                    return Err(failed(e.to_string()));
                }
            };
            tracing::info!(ms = started.elapsed().as_millis() as u64, "background-removal model loaded");
            *session = Some((built, Instant::now()));
        }
        Ok(session)
    }

    /// Cuts the background out of `source` with `files` (each checked against its pin, see the
    /// module doc); `progress` hears Load and Run. `conflict`
    /// ([`crate::atelier::models::CUTOUT_BUSY`]) while another run is going.
    pub fn run(
        &self,
        files: &RuntimeFiles<'_>,
        source: &RgbaImage,
        progress: &mut dyn FnMut(CutoutStep),
    ) -> AppResult<(RgbaImage, PixelRect)> {
        if self.running.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(AppError::new(ErrorCode::Conflict, crate::atelier::models::CUTOUT_BUSY));
        }
        let _running = Running(&self.running);
        self.cancel.store(false, Ordering::SeqCst);
        progress(CutoutStep::Load);
        // The model first: checking it needs no runtime.
        self.verify_model(files.model, files.model_hash, false)?;
        self.ensure_runtime(files.dll, files.dll_hash)?;
        let mut guard = self.session(files.model, files.model_hash)?;
        if self.cancelled() {
            return Err(cancelled());
        }
        let input = Tensor::from_array(([1usize, 3, SIDE as usize, SIDE as usize], preprocess(source)))
            .map_err(|e| failed(e.to_string()))?;
        let options = Arc::new(RunOptions::new().map_err(|e| failed(e.to_string()))?);
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&options));
        let _clear = ClearOnDrop(&self.current);
        // A cancel that came before the options were visible.
        if self.cancelled() {
            return Err(cancelled());
        }
        progress(CutoutStep::Run);
        let started = Instant::now();
        let (session, used) = guard.as_mut().expect("session made above");
        let plane = {
            let outputs = session.run_with_options(ort::inputs![input], &*options).map_err(|e| {
                if self.cancelled() {
                    cancelled()
                } else {
                    failed(e.to_string())
                }
            })?;
            if outputs.len() == 0 {
                return Err(failed("the model gave no output"));
            }
            let (_, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| failed(e.to_string()))?;
            let plane = (SIDE * SIDE) as usize;
            if data.len() < plane {
                return Err(failed(format!("output of {} values", data.len())));
            }
            data[..plane].to_vec()
        };
        *used = Instant::now();
        drop(guard);
        tracing::info!(ms = started.elapsed().as_millis() as u64, "background removal ran");
        if self.cancelled() {
            return Err(cancelled());
        }
        postprocess(source, &plane).ok_or_else(|| failed("no subject found"))
    }
}

/// The files a run uses and the pins they must match.
pub struct RuntimeFiles<'a> {
    pub dll: &'a Path,
    pub dll_hash: &'a FileHash,
    pub model: &'a Path,
    pub model_hash: &'a FileHash,
}

/// `path` opened for reading while others may only read it too (Windows: no writing, renaming
/// or deleting while the handle is open).
fn open_read_only_shared(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(path)
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open(path)
    }
}

/// Clears the running inference's options when the run ends, however it ends.
struct ClearOnDrop<'a>(&'a Mutex<Option<Arc<RunOptions>>>);

impl Drop for ClearOnDrop<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}
