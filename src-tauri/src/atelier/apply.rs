//! Apply to game: the frontend bakes each enabled slot and sends it here; each one is encoded to a
//! DXT5 `.dds` in Livery's install staging (`UserSkins/.livery/partial/<applyId>/<folder>`) at
//! once, so at most one painted texture is held in memory. Commit writes `<vehicle>.blk` and
//! installs the folder through `archive::generated::install_generated` (a new skin, or over the
//! project's skin keeping its id). Cancel, and every failed commit, removes the staging.

use crate::archive::analyze::sanitize_folder_name;
use crate::archive::generated::{install_generated, Generated, Target};
use crate::archive::{partial_dir, QueueStore};
use crate::atelier::project::{is_slot_name, is_vehicle_code, MAX_THUMB_BYTES, PNG_SIGNATURE, PROJECT_INVALID};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::index::{new_id_with, LibraryStore};
use crate::model::{ApplyStep, AtelierProject};
use crate::textures::bc::APPLY_BAD_TEXTURE;
use crate::textures::dds;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

/// `notFound`: an apply id that was committed, cancelled, never started, or is busy with a texture.
pub const APPLY_NOT_FOUND: &str = "This apply is no longer running";
/// `invalidInput`: nothing to apply (no slot on, or none sent before commit).
pub const APPLY_NOTHING: &str = "Turn on at least one part to apply";
/// `invalidInput`: a slot that isn't one of the apply's (or not a `_c` texture of the project).
pub const APPLY_BAD_SLOT: &str = "This part isn't turned on for this apply";
/// `io`: the staging files couldn't be written.
pub const APPLY_FAILED: &str = "The skin couldn't be applied to the game";

/// Largest side of a painted texture.
pub const MAX_APPLY_SIDE: u32 = 4096;
/// `pct` of Rust's part of an apply reached when every texture is written; install takes the rest.
pub const TEXTURES_PCT: u8 = 90;
/// Largest side encoded with texpresso's ClusterFit; larger textures use RangeFit. Measured on
/// 2026-10-16 (release, opt-level "s", one thread): ClusterFit 4.2 s at 2048², 15.3 s at 4096²;
/// RangeFit 0.15 s and 0.6 s. Strips are encoded in parallel on top of that.
pub const CLUSTER_FIT_MAX_SIDE: u32 = 2048;

/// One apply in progress.
#[derive(Debug)]
pub struct ApplyJob {
    pub project_id: String,
    pub vehicle: String,
    /// `partial/<applyId>/<folder>`: the skin folder being built.
    pub dir: PathBuf,
    /// `partial/<applyId>`.
    pub root: PathBuf,
    /// Slots this apply may write, as the project spells them (from `begin`).
    pub enabled: Vec<String>,
    /// Slots written so far.
    pub written: Vec<String>,
    /// The project's installed skin when the apply began (commit's target if the project can't
    /// be read again then).
    pub installed_skin_id: Option<String>,
    /// The last `pct` reported (an error event repeats it).
    pub last_pct: u8,
}

fn bad_slot(slot: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, APPLY_BAD_SLOT).with_detail(slot.to_owned())
}

fn failed(e: std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, APPLY_FAILED).with_detail(e.to_string())
}

/// The folder a project's skin installs under when it is new: `<vehicle>_<project name>`, made
/// safe by `sanitize_folder_name`.
pub fn folder_name(project: &AtelierProject) -> String {
    sanitize_folder_name(&format!("{}_{}", project.vehicle, project.name), &project.vehicle)
}

/// `w`×`h` RGBA8 in `rgba`, both sides multiples of 4 up to [`MAX_APPLY_SIDE`].
pub(crate) fn check_size(rgba: &[u8], w: u32, h: u32) -> AppResult<()> {
    let side_ok = |s: u32| s > 0 && s <= MAX_APPLY_SIDE && s.is_multiple_of(4);
    let expected = (w as usize).checked_mul(h as usize).and_then(|n| n.checked_mul(4));
    if !side_ok(w) || !side_ok(h) || expected != Some(rgba.len()) {
        return Err(AppError::new(ErrorCode::InvalidInput, APPLY_BAD_TEXTURE)
            .with_detail(format!("{w}x{h} image in {} bytes", rgba.len())));
    }
    Ok(())
}

/// DXT5 blocks of a painted texture (`w`×`h` RGBA8, both multiples of 4 up to
/// [`MAX_APPLY_SIDE`]; else `invalidInput` [`APPLY_BAD_TEXTURE`]); see [`encode_level`].
pub fn encode_painted(rgba: &[u8], w: u32, h: u32) -> AppResult<Vec<u8>> {
    check_size(rgba, w, h)?;
    Ok(encode_level(rgba, w as usize, h as usize))
}

/// Levels with fewer block rows than this are encoded on the calling thread.
const MIN_PARALLEL_BLOCK_ROWS: usize = 64;

/// DXT5 blocks of `w`×`h` RGBA8 (`rgba` exactly that size; sides that aren't multiples of 4 are
/// padded inside their last blocks, as texpresso does): ClusterFit up to
/// [`CLUSTER_FIT_MAX_SIDE`], RangeFit above, in horizontal strips of whole block rows on every
/// core. Blocks are stored row by row, so each strip's output is a contiguous part of the whole.
fn encode_level(rgba: &[u8], w: usize, h: usize) -> Vec<u8> {
    let algorithm = if w.max(h) <= CLUSTER_FIT_MAX_SIDE as usize {
        texpresso::Algorithm::ClusterFit
    } else {
        texpresso::Algorithm::RangeFit
    };
    let params = texpresso::Params { algorithm, ..Default::default() };
    let format = texpresso::Format::Bc3;
    let blocks_wide = w.div_ceil(4);
    let block_rows = h.div_ceil(4);
    let mut out = vec![0u8; format.compressed_size(w, h)];
    let threads = if block_rows < MIN_PARALLEL_BLOCK_ROWS {
        1
    } else {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).clamp(1, block_rows)
    };
    if threads == 1 {
        format.compress(rgba, w, h, params, &mut out);
        return out;
    }
    // A few strips per thread, so threads that finish early take more.
    let rows_per_strip = (block_rows / (threads * 4)).max(1);
    let strips: Mutex<Vec<(&[u8], &mut [u8])>> = Mutex::new(
        rgba.chunks(rows_per_strip * 4 * w * 4).zip(out.chunks_mut(rows_per_strip * blocks_wide * 16)).collect(),
    );
    let work = || loop {
        let next = strips.lock().unwrap_or_else(|e| e.into_inner()).pop();
        let Some((src, dst)) = next else { break };
        format.compress(src, w, src.len() / (w * 4), params, dst);
    };
    std::thread::scope(|scope| {
        for _ in 1..threads {
            // No thread to spare: the calling thread does the rest.
            if std::thread::Builder::new().name("livery-dxt5".into()).spawn_scoped(scope, work).is_err() {
                break;
            }
        }
        work();
    });
    drop(strips);
    out
}

/// The next mip level of `w`×`h` RGBA8: each side halved (never below 1), each pixel the plain
/// average of the 2×2 pixels under it (one of them repeated at an odd edge), alpha included.
fn half(rgba: &[u8], w: usize, h: usize) -> (Vec<u8>, usize, usize) {
    let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
    let mut out = Vec::with_capacity(nw * nh * 4);
    for y in 0..nh {
        let (y0, y1) = ((2 * y).min(h - 1), (2 * y + 1).min(h - 1));
        for x in 0..nw {
            let (x0, x1) = ((2 * x).min(w - 1), (2 * x + 1).min(w - 1));
            for c in 0..4 {
                let at = |px: usize, py: usize| u32::from(rgba[4 * (py * w + px) + c]);
                let sum = at(x0, y0) + at(x1, y0) + at(x0, y1) + at(x1, y1);
                out.push(((sum + 2) / 4) as u8);
            }
        }
    }
    (out, nw, nh)
}

/// The DXT5 blocks of every level of a painted texture's mip chain (sizes from
/// `dds::mip_sizes`), largest first; level 0 checked like [`encode_painted`]. Each level is
/// box-filtered from the one before and encoded by [`encode_level`]'s rule for its own size.
pub fn encode_mips(rgba: &[u8], w: u32, h: u32) -> AppResult<Vec<Vec<u8>>> {
    let mut levels = vec![encode_painted(rgba, w, h)?];
    let sizes = dds::mip_sizes(w, h);
    let mut previous: Option<(Vec<u8>, usize, usize)> = None;
    for _ in 1..sizes.len() {
        let (img, lw, lh) = match &previous {
            None => half(rgba, w as usize, h as usize),
            Some((img, pw, ph)) => half(img, *pw, *ph),
        };
        levels.push(encode_level(&img, lw, lh));
        previous = Some((img, lw, lh));
    }
    Ok(levels)
}

/// The file base of a slot: its name without the trailing `_c`.
fn base_of(slot: &str) -> &str {
    slot.get(..slot.len().saturating_sub(2)).unwrap_or(slot)
}

/// Starts an apply of `project`'s `enabled` slots (the frontend's current choice, which may not
/// be saved yet; each must be one of the project's slots, any case). Stale staging is purged
/// first (once per session, see `QueueStore::ensure_partials_purged`), so a later queue or
/// WT Live action can't purge this one. Returns the apply id and the job.
pub fn begin(
    user_skins: &Path,
    queue: &QueueStore,
    project: &AtelierProject,
    enabled: Vec<String>,
) -> AppResult<(String, ApplyJob)> {
    if enabled.is_empty() {
        return Err(AppError::new(ErrorCode::InvalidInput, APPLY_NOTHING));
    }
    // The vehicle code names the `.blk`: it must be a plain code (the project store checks it too).
    if !is_vehicle_code(&project.vehicle) {
        return Err(AppError::new(ErrorCode::InvalidInput, PROJECT_INVALID).with_detail(project.vehicle.clone()));
    }
    let mut slots: Vec<String> = Vec::new();
    for slot in &enabled {
        let known = project.slots.iter().find(|s| s.texture.eq_ignore_ascii_case(slot));
        match known {
            Some(s) if is_slot_name(&s.texture) => {
                if !slots.iter().any(|t| t.eq_ignore_ascii_case(&s.texture)) {
                    slots.push(s.texture.clone());
                }
            }
            _ => return Err(bad_slot(slot)),
        }
    }
    queue.ensure_partials_purged(user_skins);
    let id = new_id_with("a");
    let root = partial_dir(user_skins).join(&id);
    let dir = root.join(folder_name(project));
    if let Err(e) = fs::create_dir_all(&dir) {
        let _ = fs::remove_dir_all(&root);
        return Err(failed(e));
    }
    let job = ApplyJob {
        project_id: project.id.clone(),
        vehicle: project.vehicle.clone(),
        dir,
        root,
        enabled: slots,
        written: Vec::new(),
        installed_skin_id: project.installed_skin_id.clone(),
        last_pct: 0,
    };
    Ok((id, job))
}

/// Encodes one painted slot (`w`×`h` RGBA8, both multiples of 4 up to [`MAX_APPLY_SIDE`]) and
/// writes `<base>.dds` (a slot sent again is overwritten). `report` gets the encode and write
/// steps with their `pct`.
pub fn texture(
    job: &mut ApplyJob,
    slot: &str,
    w: u32,
    h: u32,
    rgba: &[u8],
    report: &mut dyn FnMut(ApplyStep, u8),
) -> AppResult<()> {
    let at = job.enabled.iter().position(|s| s.eq_ignore_ascii_case(slot)).ok_or_else(|| bad_slot(slot))?;
    check_size(rgba, w, h)?;
    let slot = job.enabled[at].clone();
    let n = job.enabled.len();
    let pct = |half: usize| (usize::from(TEXTURES_PCT) * half / (2 * n)) as u8;
    job.last_pct = pct(2 * at);
    report(ApplyStep::Encode, job.last_pct);
    let levels = encode_mips(rgba, w, h)?;
    job.last_pct = pct(2 * at + 1);
    report(ApplyStep::Write, job.last_pct);
    let file = dds::write_dxt5_mips(w, h, &levels);
    drop(levels);
    fs::write(job.dir.join(format!("{}.dds", base_of(&slot))), file).map_err(failed)?;
    if !job.written.contains(&slot) {
        job.written.push(slot);
    }
    Ok(())
}

/// The skin's `.blk`: `name:t="user"`, then one `set_tex` per slot pointing the game's
/// `<base>_c` texture at `<base>.dds`. LF line endings, a blank line between blocks.
pub fn blk_text(slots: &[String]) -> String {
    let mut text = String::from("name:t=\"user\"\n");
    for slot in slots {
        let base = base_of(slot);
        text.push_str(&format!(
            "\nset_tex{{\n  from:t=\"{base}_c*\"\n  to:t=\"{base}.dds\"\n  param:t=\"camo_skin_tex\"\n}}\n"
        ));
    }
    text
}

/// Name of the project's picture in the installed skin folder (the Hangar card shows a file whose
/// name contains "preview" first, see `library::preview`).
pub const PREVIEW_FILE: &str = "preview.png";

/// Writes the `.blk` for the slots written (in the apply's order), the project's picture
/// (`preview`, a PNG of at most `project::MAX_THUMB_BYTES`; others are left out) as
/// [`PREVIEW_FILE`], and installs the skin (`keep_backup` and `backup_days` are
/// Settings → Backups). The staging goes whatever happens.
#[allow(clippy::too_many_arguments)]
pub fn commit(
    job: ApplyJob,
    preview: Option<&[u8]>,
    user_skins: &Path,
    store: &LibraryStore,
    target: Target,
    keep_backup: bool,
    backup_days: u32,
    now: SystemTime,
) -> AppResult<Generated> {
    let result = (|| {
        let slots: Vec<String> = job.enabled.iter().filter(|s| job.written.contains(s)).cloned().collect();
        if slots.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, APPLY_NOTHING));
        }
        fs::write(job.dir.join(format!("{}.blk", job.vehicle)), blk_text(&slots)).map_err(failed)?;
        match preview {
            Some(png) if png.len() <= MAX_THUMB_BYTES && png.starts_with(&PNG_SIGNATURE) => {
                fs::write(job.dir.join(PREVIEW_FILE), png).map_err(failed)?;
            }
            Some(png) => tracing::warn!(bytes = png.len(), "project picture left out of the skin"),
            None => {}
        }
        install_generated(user_skins, store, &job.dir, target, keep_backup, backup_days, now)
    })();
    cancel(job);
    result
}

/// Removes the apply's staging.
pub fn cancel(job: ApplyJob) {
    remove_staging(&job.root);
}

fn remove_staging(root: &Path) {
    if let Err(e) = fs::remove_dir_all(root) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %e, "Atelier apply staging not removed");
        }
    }
}

/// An idle apply untouched for this long no longer blocks a new apply of its project (its
/// frontend went away mid-apply: a reload, an editor closed before it could cancel).
pub const STALE_APPLY: Duration = Duration::from_secs(10 * 60);

/// A job in the registry: waiting for the next call, or taken by a texture call.
#[derive(Debug)]
enum Entry {
    Idle {
        job: ApplyJob,
        /// When it was begun or last given back.
        since: Instant,
    },
    /// `cancelled`: a cancel came while the texture was being encoded; the texture call removes
    /// the staging when it returns.
    Busy { project_id: String, cancelled: bool },
}

impl Entry {
    fn project_id(&self) -> &str {
        match self {
            Entry::Idle { job, .. } => &job.project_id,
            Entry::Busy { project_id, .. } => project_id,
        }
    }
}

/// The applies in progress, by id; one per project. A texture call checks its job out for the
/// encode (the lock is never held while encoding) and checks it back in.
#[derive(Debug, Default)]
pub struct Applies {
    jobs: Mutex<HashMap<String, Entry>>,
}

fn not_found(id: &str) -> AppError {
    AppError::new(ErrorCode::NotFound, APPLY_NOT_FOUND).with_detail(id.to_owned())
}

/// A job checked out for a texture call. [`CheckedOut::checkin`] gives it back; dropped without
/// that (the encode unwound), the apply ends and its staging goes.
#[derive(Debug)]
pub struct CheckedOut<'a> {
    applies: &'a Applies,
    id: String,
    job: Option<ApplyJob>,
}

impl std::ops::Deref for CheckedOut<'_> {
    type Target = ApplyJob;
    fn deref(&self) -> &ApplyJob {
        match &self.job {
            Some(job) => job,
            None => unreachable!("the job is only taken by checkin and drop"),
        }
    }
}

impl std::ops::DerefMut for CheckedOut<'_> {
    fn deref_mut(&mut self) -> &mut ApplyJob {
        match &mut self.job {
            Some(job) => job,
            None => unreachable!("the job is only taken by checkin and drop"),
        }
    }
}

impl CheckedOut<'_> {
    /// Gives the job back. Cancelled meanwhile: its staging goes and the call is `notFound`.
    pub fn checkin(mut self) -> AppResult<()> {
        match self.job.take() {
            Some(job) => self.applies.checkin(&self.id, job),
            None => Err(not_found(&self.id)),
        }
    }
}

impl Drop for CheckedOut<'_> {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            tracing::warn!(apply_id = %self.id, "Atelier apply ended while a texture was being written");
            self.applies.lock().remove(&self.id);
            cancel(job);
        }
    }
}

impl Applies {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a job `begin` made. Another apply of the same project that is busy or was used
    /// within [`STALE_APPLY`] refuses this one (`conflict`, its staging removed); an older idle
    /// one is cancelled and replaced.
    pub fn insert(&self, id: String, job: ApplyJob) -> AppResult<()> {
        self.insert_at(id, job, Instant::now())
    }

    /// [`Self::insert`] at `now`.
    pub fn insert_at(&self, id: String, job: ApplyJob, now: Instant) -> AppResult<()> {
        let mut jobs = self.lock();
        let other = jobs.iter().find(|(_, e)| e.project_id() == job.project_id).map(|(k, _)| k.clone());
        let mut replaced = None;
        if let Some(other) = other {
            let stale = matches!(jobs.get(&other), Some(Entry::Idle { since, .. })
                if now.saturating_duration_since(*since) >= STALE_APPLY);
            if !stale {
                drop(jobs);
                cancel(job);
                return Err(AppError::new(ErrorCode::Conflict, APPLY_FAILED)
                    .with_detail(format!("another apply of this project is running ({other})")));
            }
            if let Some(Entry::Idle { job: old, .. }) = jobs.remove(&other) {
                replaced = Some(old);
            }
        }
        jobs.insert(id, Entry::Idle { job, since: now });
        drop(jobs);
        if let Some(old) = replaced {
            tracing::info!("a stale Atelier apply of the same project was cancelled");
            cancel(old);
        }
        Ok(())
    }

    /// Takes the job for a texture call; `notFound` when unknown or busy.
    pub fn checkout(&self, id: &str) -> AppResult<CheckedOut<'_>> {
        let mut jobs = self.lock();
        let Some(entry) = jobs.get_mut(id) else { return Err(not_found(id)) };
        let project_id = entry.project_id().to_owned();
        match std::mem::replace(entry, Entry::Busy { project_id, cancelled: false }) {
            Entry::Idle { job, .. } => Ok(CheckedOut { applies: self, id: id.to_owned(), job: Some(job) }),
            busy => {
                *entry = busy;
                Err(not_found(id))
            }
        }
    }

    fn checkin(&self, id: &str, job: ApplyJob) -> AppResult<()> {
        let mut jobs = self.lock();
        match jobs.get(id) {
            Some(Entry::Busy { cancelled: false, .. }) => {
                jobs.insert(id.to_owned(), Entry::Idle { job, since: Instant::now() });
                Ok(())
            }
            _ => {
                jobs.remove(id);
                drop(jobs);
                cancel(job);
                Err(not_found(id))
            }
        }
    }

    /// Takes the job out for good (commit); `notFound` when unknown or busy.
    pub fn remove(&self, id: &str) -> AppResult<ApplyJob> {
        let mut jobs = self.lock();
        match jobs.remove(id) {
            Some(Entry::Idle { job, .. }) => Ok(job),
            Some(busy) => {
                jobs.insert(id.to_owned(), busy);
                Err(not_found(id))
            }
            None => Err(not_found(id)),
        }
    }

    /// Cancels an apply: its staging goes now, or when the texture call working on it returns.
    /// Unknown ids are fine.
    pub fn cancel(&self, id: &str) {
        let mut jobs = self.lock();
        match jobs.get_mut(id) {
            Some(Entry::Busy { cancelled, .. }) => *cancelled = true,
            Some(Entry::Idle { .. }) => {
                if let Some(Entry::Idle { job, .. }) = jobs.remove(id) {
                    drop(jobs);
                    cancel(job);
                }
            }
            None => {}
        }
    }
}
