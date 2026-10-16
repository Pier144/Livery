//! Apply to game: the frontend bakes each enabled slot and sends it here; each one is encoded to a
//! DXT5 `.dds` in Livery's install staging (`UserSkins/.livery/partial/<applyId>/<folder>`) at
//! once, so at most one painted texture is held in memory. Commit writes `<vehicle>.blk` and
//! installs the folder through `archive::generated::install_generated` (a new skin, or over the
//! project's skin keeping its id). Cancel, and every failed commit, removes the staging.

use crate::archive::analyze::sanitize_folder_name;
use crate::archive::generated::{install_generated, Generated, Target};
use crate::archive::{partial_dir, QueueStore};
use crate::atelier::project::{is_slot_name, PROJECT_INVALID};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::index::{new_id_with, LibraryStore};
use crate::model::{ApplyStep, AtelierProject};
use crate::textures::bc::APPLY_BAD_TEXTURE;
use crate::textures::dds;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::SystemTime;

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
fn check_size(rgba: &[u8], w: u32, h: u32) -> AppResult<()> {
    let side_ok = |s: u32| s > 0 && s <= MAX_APPLY_SIDE && s % 4 == 0;
    let expected = (w as usize).checked_mul(h as usize).and_then(|n| n.checked_mul(4));
    if !side_ok(w) || !side_ok(h) || expected != Some(rgba.len()) {
        return Err(AppError::new(ErrorCode::InvalidInput, APPLY_BAD_TEXTURE)
            .with_detail(format!("{w}x{h} image in {} bytes", rgba.len())));
    }
    Ok(())
}

/// DXT5 blocks of a painted texture (`w`×`h` RGBA8, both multiples of 4 up to
/// [`MAX_APPLY_SIDE`]; else `invalidInput` [`APPLY_BAD_TEXTURE`]): ClusterFit up to
/// [`CLUSTER_FIT_MAX_SIDE`], RangeFit above, in horizontal strips of whole block rows on every
/// core. Blocks are stored row by row, so each strip's output is a contiguous part of the whole.
pub fn encode_painted(rgba: &[u8], w: u32, h: u32) -> AppResult<Vec<u8>> {
    check_size(rgba, w, h)?;
    let algorithm = if w.max(h) <= CLUSTER_FIT_MAX_SIDE {
        texpresso::Algorithm::ClusterFit
    } else {
        texpresso::Algorithm::RangeFit
    };
    let params = texpresso::Params { algorithm, ..Default::default() };
    let (w, h) = (w as usize, h as usize);
    let block_rows = h / 4;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).clamp(1, block_rows);
    // A few strips per thread, so threads that finish early take more.
    let rows_per_strip = (block_rows / (threads * 4)).max(1);
    // DXT5: 16 bytes per 4×4 block, one byte per pixel.
    let mut out = vec![0u8; w * h];
    let strips: Mutex<Vec<(&[u8], &mut [u8])>> =
        Mutex::new(rgba.chunks(rows_per_strip * 4 * w * 4).zip(out.chunks_mut(rows_per_strip * 4 * w)).collect());
    let work = || loop {
        let next = strips.lock().unwrap_or_else(|e| e.into_inner()).pop();
        let Some((src, dst)) = next else { break };
        texpresso::Format::Bc3.compress(src, w, src.len() / (w * 4), params, dst);
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
    Ok(out)
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
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-');
    if project.vehicle.is_empty() || !project.vehicle.chars().all(plain) {
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
    report(ApplyStep::Encode, pct(2 * at));
    let blocks = encode_painted(rgba, w, h)?;
    report(ApplyStep::Write, pct(2 * at + 1));
    let file = dds::write_dxt5(w, h, &blocks);
    drop(blocks);
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

/// Writes the `.blk` for the slots written (in the apply's order) and installs the skin
/// (`keep_backup` and `backup_days` are Settings → Backups). The staging goes whatever happens.
pub fn commit(
    job: ApplyJob,
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
        install_generated(user_skins, store, &job.dir, target, keep_backup, backup_days, now)
    })();
    cancel(job);
    result
}

/// Removes the apply's staging.
pub fn cancel(job: ApplyJob) {
    if let Err(e) = fs::remove_dir_all(&job.root) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %e, "Atelier apply staging not removed");
        }
    }
}

/// A job in the registry: waiting for the next call, or taken by a texture call.
#[derive(Debug)]
enum Entry {
    Idle(ApplyJob),
    /// `cancelled`: a cancel came while the texture was being encoded; the texture call removes
    /// the staging when it returns.
    Busy {
        cancelled: bool,
    },
}

/// The applies in progress, by id. A texture call checks its job out for the encode (the lock is
/// never held while encoding) and checks it back in.
#[derive(Debug, Default)]
pub struct Applies {
    jobs: Mutex<HashMap<String, Entry>>,
}

fn not_found(id: &str) -> AppError {
    AppError::new(ErrorCode::NotFound, APPLY_NOT_FOUND).with_detail(id.to_owned())
}

impl Applies {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn insert(&self, id: String, job: ApplyJob) {
        self.lock().insert(id, Entry::Idle(job));
    }

    /// Takes the job for a texture call; `notFound` when unknown or busy.
    pub fn checkout(&self, id: &str) -> AppResult<ApplyJob> {
        let mut jobs = self.lock();
        match jobs.get_mut(id) {
            Some(entry @ Entry::Idle(_)) => match std::mem::replace(entry, Entry::Busy { cancelled: false }) {
                Entry::Idle(job) => Ok(job),
                Entry::Busy { .. } => Err(not_found(id)),
            },
            _ => Err(not_found(id)),
        }
    }

    /// Gives a checked-out job back. Cancelled meanwhile: its staging goes and the call is
    /// `notFound`.
    pub fn checkin(&self, id: &str, job: ApplyJob) -> AppResult<()> {
        let mut jobs = self.lock();
        match jobs.get(id) {
            Some(Entry::Busy { cancelled: false }) => {
                jobs.insert(id.to_owned(), Entry::Idle(job));
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
            Some(Entry::Idle(job)) => Ok(job),
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
        match jobs.remove(id) {
            Some(Entry::Idle(job)) => {
                drop(jobs);
                cancel(job);
            }
            Some(Entry::Busy { .. }) => {
                jobs.insert(id.to_owned(), Entry::Busy { cancelled: true });
            }
            None => {}
        }
    }
}
