//! Atelier projects on disk: `<data>/atelier/projects/<id>/project.json` (+ `thumb.png`), deleted
//! ones in `<data>/atelier/.trash/<id>` until Undo brings them back, the toast closes
//! ([`ProjectStore::forget_deleted`]) or the next launch purges them.
//!
//! Rust checks the envelope (schema version, id, name, vehicle, slots, installed skin id) and
//! keeps `layers` as opaque JSON: the frontend owns the layer schema. A file that fails the
//! checks is never served or overwritten by a list; writes are atomic (temp file + rename).

use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::index::new_id_with;
use crate::library::{layout, time};
use crate::model::{AtelierOutput, AtelierProject, AtelierProjectSummary, AtelierSlotChoice};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// `notFound`: the project's folder is gone (deleted, or an id this store never made).
pub const PROJECT_NOT_FOUND: &str = "This Atelier project no longer exists";
/// A project whose file can't be read (damaged, from a newer Livery) or whose envelope doesn't
/// check out.
pub const PROJECT_INVALID: &str = "This Atelier project can't be read";
/// `invalidInput`: the name is empty or longer than [`MAX_NAME_CHARS`].
pub const PROJECT_NAME_INVALID: &str = "A project name must be 1 to 80 characters long";
/// `invalidInput`: a thumbnail that isn't a PNG or is larger than [`MAX_THUMB_BYTES`].
pub const PROJECT_THUMB_INVALID: &str = "The project's picture can't be saved";
/// `io`: writing the project's files failed.
pub const PROJECT_SAVE_FAILED: &str = "Could not save the Atelier project";

/// Schema version of `project.json`.
pub const PROJECT_VERSION: u32 = 1;
pub const PROJECT_FILE: &str = "project.json";
pub const THUMB_FILE: &str = "thumb.png";
pub const PROJECTS_DIR: &str = "projects";
pub const TRASH_DIR: &str = ".trash";

pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_LAYERS: usize = 500;
/// `layers` serialised must stay below this.
pub const MAX_LAYERS_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_THUMB_BYTES: usize = 2 * 1024 * 1024;
const MAX_SLOTS: usize = 64;
const MAX_SLOT_CHARS: usize = 128;
const MAX_VEHICLE_CHARS: usize = 128;
const MAX_SKIN_ID_CHARS: usize = 128;
/// `project.json` files larger than this aren't read.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const RENAME_ATTEMPTS: u32 = 5;

/// A `_c` texture name safe to use as a file name and inside a `.blk` string: ASCII letters,
/// digits, `_`, `-` and `.`, not starting with `.`, ending in `_c` (any case), at most
/// 128 characters.
pub fn is_slot_name(name: &str) -> bool {
    name.len() > 2
        && name.len() <= MAX_SLOT_CHARS
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && name[name.len() - 2..].eq_ignore_ascii_case("_c")
}

/// A vehicle code as the game names its `.blk` files: ASCII letters, digits, `_` and `-`.
pub(crate) fn is_vehicle_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= MAX_VEHICLE_CHARS
        && code.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn not_found(id: &str) -> AppError {
    AppError::new(ErrorCode::NotFound, PROJECT_NOT_FOUND).with_detail(id.to_owned())
}

fn invalid(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, PROJECT_INVALID).with_detail(detail.into())
}

fn save_failed(e: io::Error) -> AppError {
    AppError::new(ErrorCode::Io, PROJECT_SAVE_FAILED).with_detail(e.to_string())
}

/// The name trimmed, or `invalidInput` ([`PROJECT_NAME_INVALID`]).
fn checked_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    let chars = name.chars().count();
    if chars == 0 || chars > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(
            AppError::new(ErrorCode::InvalidInput, PROJECT_NAME_INVALID).with_detail(format!("{chars} characters"))
        );
    }
    Ok(name.to_owned())
}

/// What `create` checks before anything else: a name ([`PROJECT_NAME_INVALID`]) and a plain
/// vehicle code ([`PROJECT_INVALID`]). Commands call it before reading the vehicle's model.
pub(crate) fn check_new(name: &str, vehicle: &str) -> AppResult<()> {
    checked_name(name)?;
    if !is_vehicle_code(vehicle) {
        return Err(invalid(format!("vehicle {vehicle:?}")));
    }
    Ok(())
}

/// Checks everything but the id (see the module doc); `invalidInput` with the reason as detail.
fn check_envelope(project: &AtelierProject) -> AppResult<()> {
    if project.version != PROJECT_VERSION {
        return Err(invalid(format!("version {}", project.version)));
    }
    checked_name(&project.name)?;
    if !is_vehicle_code(&project.vehicle) {
        return Err(invalid(format!("vehicle {:?}", project.vehicle)));
    }
    if project.slots.len() > MAX_SLOTS {
        return Err(invalid(format!("{} slots", project.slots.len())));
    }
    for (i, slot) in project.slots.iter().enumerate() {
        if !is_slot_name(&slot.texture) {
            return Err(invalid(format!("slot {:?}", slot.texture)));
        }
        if project.slots[..i].iter().any(|s| s.texture.eq_ignore_ascii_case(&slot.texture)) {
            return Err(invalid(format!("slot {:?} twice", slot.texture)));
        }
    }
    if let Some(id) = &project.installed_skin_id {
        if id.is_empty() || id.chars().count() > MAX_SKIN_ID_CHARS || id.chars().any(char::is_control) {
            return Err(invalid("installed skin id"));
        }
    }
    let Some(layers) = project.layers.as_array() else {
        return Err(invalid("layers is not an array"));
    };
    if layers.len() > MAX_LAYERS {
        return Err(invalid(format!("{} layers", layers.len())));
    }
    let size = serde_json::to_vec(&project.layers).map(|v| v.len()).unwrap_or(usize::MAX);
    if size >= MAX_LAYERS_BYTES {
        return Err(invalid(format!("layers of {size} bytes")));
    }
    Ok(())
}

/// Moves `from` to `to`, retrying while Windows reports the target busy (an antivirus scan, an
/// open preview).
fn rename_retrying(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied && attempt < RENAME_ATTEMPTS => {
                std::thread::sleep(Duration::from_millis(100 * u64::from(attempt)));
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// Writes `bytes` to a temp file next to `path`, flushes it, then renames it over `path`.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let written = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        rename_retrying(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// The projects of one app data folder.
pub struct ProjectStore {
    /// `<data>/atelier/projects`.
    root: PathBuf,
    /// `<data>/atelier/.trash`.
    trash: PathBuf,
    /// Held by every write, so a save's read-modify-write can't interleave with another's.
    writing: Mutex<()>,
}

impl ProjectStore {
    /// The store under `atelier_dir` (`<data>/atelier`). Nothing is created until a write.
    pub fn new(atelier_dir: &Path) -> Self {
        Self { root: atelier_dir.join(PROJECTS_DIR), trash: atelier_dir.join(TRASH_DIR), writing: Mutex::new(()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.writing.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `<root>/<id>` for an id that can name a folder of this store (not checked to exist).
    fn dir_of(&self, id: &str) -> AppResult<PathBuf> {
        if !layout::is_folder_name(id) {
            return Err(not_found(id));
        }
        Ok(self.root.join(id))
    }

    /// The folder of an existing project.
    fn existing_dir(&self, id: &str) -> AppResult<PathBuf> {
        let dir = self.dir_of(id)?;
        if !dir.is_dir() {
            return Err(not_found(id));
        }
        Ok(dir)
    }

    /// Reads and checks `<dir>/project.json`: `notFound` when it's missing, else `parse`
    /// ([`PROJECT_INVALID`]) for anything that doesn't check out.
    fn read(dir: &Path, id: &str) -> AppResult<AtelierProject> {
        let path = dir.join(PROJECT_FILE);
        let unreadable = |detail: String| AppError::new(ErrorCode::Parse, PROJECT_INVALID).with_detail(detail);
        let size = match fs::metadata(&path) {
            Ok(meta) => meta.len(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(not_found(id)),
            Err(e) => return Err(AppError::new(ErrorCode::Io, PROJECT_INVALID).with_detail(format!("{id}: {e}"))),
        };
        if size > MAX_FILE_BYTES {
            return Err(unreadable(format!("{id}: {size} bytes")));
        }
        let bytes = fs::read(&path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => not_found(id),
            _ => AppError::new(ErrorCode::Io, PROJECT_INVALID).with_detail(format!("{id}: {e}")),
        })?;
        let project: AtelierProject = serde_json::from_slice(&bytes).map_err(|e| unreadable(format!("{id}: {e}")))?;
        if project.id != id {
            return Err(unreadable(format!("{id}: id {:?}", project.id)));
        }
        check_envelope(&project).map_err(|e| unreadable(format!("{id}: {}", e.detail.unwrap_or(e.message))))?;
        Ok(project)
    }

    /// Writes `project.json` compact (pretty-printing deep layer arrays multiplies their size), and
    /// never a file [`Self::read`] would refuse.
    fn write(dir: &Path, project: &AtelierProject) -> AppResult<()> {
        let bytes = serde_json::to_vec(project)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid(format!("{} bytes", bytes.len())));
        }
        write_atomic(&dir.join(PROJECT_FILE), &bytes).map_err(save_failed)
    }

    /// Every readable project, most recently saved first. Folders whose project can't be read are
    /// skipped with a warning.
    pub fn list(&self) -> AppResult<Vec<AtelierProjectSummary>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(AppError::new(ErrorCode::Io, PROJECT_INVALID).with_detail(e.to_string())),
        };
        let mut list: Vec<AtelierProjectSummary> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| {
                let id = e.file_name().to_string_lossy().into_owned();
                if !layout::is_folder_name(&id) {
                    return None;
                }
                match Self::read(&e.path(), &id) {
                    Ok(p) => Some(AtelierProjectSummary {
                        has_thumb: e.path().join(THUMB_FILE).is_file(),
                        id: p.id,
                        name: p.name,
                        vehicle: p.vehicle,
                        updated_at: p.updated_at,
                    }),
                    Err(err) => {
                        tracing::warn!(error = %err, "Atelier project skipped");
                        None
                    }
                }
            })
            .collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.name.cmp(&b.name)));
        Ok(list)
    }

    /// A new project with no layers (the frontend adds the Base on load).
    pub fn create(
        &self,
        name: &str,
        vehicle: &str,
        slots: Vec<AtelierSlotChoice>,
        now: SystemTime,
    ) -> AppResult<AtelierProject> {
        let stamp = time::rfc3339_utc(now);
        let project = AtelierProject {
            version: PROJECT_VERSION,
            id: new_id_with("p"),
            name: checked_name(name)?,
            vehicle: vehicle.to_owned(),
            created_at: stamp.clone(),
            updated_at: stamp,
            slots,
            output: AtelierOutput::default(),
            installed_skin_id: None,
            layers: serde_json::Value::Array(Vec::new()),
        };
        check_envelope(&project)?;
        let _writing = self.lock();
        let dir = self.dir_of(&project.id)?;
        fs::create_dir_all(&dir).map_err(save_failed)?;
        if let Err(e) = Self::write(&dir, &project) {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
        Ok(project)
    }

    pub fn get(&self, id: &str) -> AppResult<AtelierProject> {
        let dir = self.dir_of(id)?;
        Self::read(&dir, id)
    }

    /// Saves `project` over its file: the envelope is checked, the name trimmed, `updated_at`
    /// set to `now`; `created_at` stays the stored one, and so does the installed skin id when
    /// `project` has none (an autosave that started before an apply finished must not drop it).
    /// A deleted project is `notFound` (an autosave can't bring it back).
    pub fn save(&self, project: &AtelierProject, now: SystemTime) -> AppResult<AtelierProject> {
        let _writing = self.lock();
        self.save_locked(project.clone(), now)
    }

    fn save_locked(&self, mut project: AtelierProject, now: SystemTime) -> AppResult<AtelierProject> {
        let dir = self.existing_dir(&project.id)?;
        check_envelope(&project)?;
        project.name = checked_name(&project.name)?;
        project.updated_at = time::rfc3339_utc(now);
        if let Ok(stored) = Self::read(&dir, &project.id) {
            project.created_at = stored.created_at;
            if project.installed_skin_id.is_none() {
                project.installed_skin_id = stored.installed_skin_id;
            }
        }
        Self::write(&dir, &project)?;
        Ok(project)
    }

    /// Records the skin an apply installed.
    pub fn set_installed_skin(&self, id: &str, skin_id: &str, now: SystemTime) -> AppResult<AtelierProject> {
        let _writing = self.lock();
        let dir = self.existing_dir(id)?;
        let project = Self::read(&dir, id)?;
        self.save_locked(AtelierProject { installed_skin_id: Some(skin_id.to_owned()), ..project }, now)
    }

    /// A copy (layers, slots, thumbnail and any other file of the folder) under a free name
    /// (`<name> (2)`, `(3)`…, the name shortened when the number wouldn't fit), without the
    /// installed skin: the copy's first apply installs a new one.
    pub fn duplicate(&self, id: &str, now: SystemTime) -> AppResult<AtelierProject> {
        let _writing = self.lock();
        let from = self.existing_dir(id)?;
        let source = Self::read(&from, id)?;
        let names: Vec<String> = self.list()?.into_iter().map(|p| p.name).collect();
        let stamp = time::rfc3339_utc(now);
        let copy = AtelierProject {
            id: new_id_with("p"),
            name: free_copy_name(&source.name, |n| names.iter().any(|t| t == n)),
            created_at: stamp.clone(),
            updated_at: stamp,
            installed_skin_id: None,
            ..source
        };
        let to = self.dir_of(&copy.id)?;
        layout::copy_dir(&from, &to).map_err(save_failed)?;
        if let Err(e) = Self::write(&to, &copy) {
            let _ = fs::remove_dir_all(&to);
            return Err(e);
        }
        Ok(copy)
    }

    /// Moves the project to the trash (a previous trash entry with its id is replaced).
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let _writing = self.lock();
        let dir = self.existing_dir(id)?;
        let parked = self.trash.join(id);
        if layout::occupied(&parked) {
            fs::remove_dir_all(&parked).map_err(save_failed)?;
        }
        fs::create_dir_all(&self.trash).map_err(save_failed)?;
        rename_retrying(&dir, &parked).map_err(save_failed)
    }

    /// Brings a deleted project back from the trash.
    pub fn undo_delete(&self, id: &str) -> AppResult<()> {
        let _writing = self.lock();
        let dir = self.dir_of(id)?;
        let parked = self.trash.join(id);
        if !parked.is_dir() {
            return Err(not_found(id));
        }
        if layout::occupied(&dir) {
            return Err(AppError::new(ErrorCode::Conflict, PROJECT_SAVE_FAILED).with_detail(format!("{id} exists")));
        }
        fs::create_dir_all(&self.root).map_err(save_failed)?;
        rename_retrying(&parked, &dir).map_err(save_failed)
    }

    /// Removes a deleted project's trash entry for good (missing is fine).
    pub fn forget_deleted(&self, id: &str) -> AppResult<()> {
        let _writing = self.lock();
        self.dir_of(id)?;
        match fs::remove_dir_all(self.trash.join(id)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(save_failed(e)),
            _ => Ok(()),
        }
    }

    /// Empties the trash (at launch); returns how many entries went.
    pub fn purge_trash(&self) -> usize {
        let _writing = self.lock();
        let Ok(entries) = fs::read_dir(&self.trash) else { return 0 };
        entries
            .filter_map(Result::ok)
            .filter(|e| {
                let path = e.path();
                let removed = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
                if let Err(err) = &removed {
                    tracing::warn!(error = %err, "Atelier trash entry not removed");
                }
                removed.is_ok()
            })
            .count()
    }

    /// Stores the project's thumbnail: a PNG of at most [`MAX_THUMB_BYTES`].
    pub fn set_thumb(&self, id: &str, png: &[u8]) -> AppResult<()> {
        let _writing = self.lock();
        let dir = self.existing_dir(id)?;
        if !png.starts_with(&PNG_SIGNATURE) || png.len() > MAX_THUMB_BYTES {
            return Err(AppError::new(ErrorCode::InvalidInput, PROJECT_THUMB_INVALID)
                .with_detail(format!("{} bytes", png.len())));
        }
        write_atomic(&dir.join(THUMB_FILE), png).map_err(save_failed)
    }

    /// The project's thumbnail, empty when it has none.
    pub fn thumb(&self, id: &str) -> AppResult<Vec<u8>> {
        let dir = self.existing_dir(id)?;
        match fs::read(dir.join(THUMB_FILE)) {
            Ok(bytes) => Ok(bytes),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(AppError::new(ErrorCode::Io, PROJECT_INVALID).with_detail(e.to_string())),
        }
    }
}

/// `name (2)`, `name (3)`… the first `taken` refuses not, with `name` cut so the result stays
/// within [`MAX_NAME_CHARS`].
fn free_copy_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    (2u64..)
        .map(|n| {
            let suffix = format!(" ({n})");
            let room = MAX_NAME_CHARS.saturating_sub(suffix.chars().count());
            let base: String = name.chars().take(room).collect();
            format!("{}{suffix}", base.trim_end())
        })
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| name.to_owned())
}
