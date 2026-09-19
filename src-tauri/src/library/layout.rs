//! Where Livery keeps skin folders inside `UserSkins`, and the file-system helpers the library
//! operations share.
//!
//! - active skin: `UserSkins/<folder>` (what the game loads);
//! - inactive skin: `UserSkins/.livery/inactive/<folder>`;
//! - backup: `UserSkins/.livery/backups/<backupId>/<folder>`.
//!
//! Everything stays on the game's volume, so activating, deactivating, deleting and restoring are
//! plain renames (instant and atomic). The game only reads `<vehicle>.blk` directly inside each
//! `UserSkins/<folder>`, so it ignores `.livery`; the library scan skips `.`-prefixed folders too.
//! Folder names are kept as they are, because the game shows the folder name as the skin name.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::HangarSkin;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Livery's own folder inside `UserSkins`.
pub const LIVERY_DIR: &str = ".livery";
/// Sub-folder of [`LIVERY_DIR`] holding inactive skins.
pub const INACTIVE_DIR: &str = "inactive";
/// Sub-folder of [`LIVERY_DIR`] holding backups, one folder per backup id.
pub const BACKUPS_DIR: &str = "backups";

/// How deep `copy_dir` follows sub-folders.
const MAX_COPY_DEPTH: usize = 64;

pub fn livery_dir(user_skins: &Path) -> PathBuf {
    user_skins.join(LIVERY_DIR)
}

/// `UserSkins/.livery/inactive`.
pub fn inactive_dir(user_skins: &Path) -> PathBuf {
    livery_dir(user_skins).join(INACTIVE_DIR)
}

/// `UserSkins/.livery/backups`.
pub fn backups_dir(user_skins: &Path) -> PathBuf {
    livery_dir(user_skins).join(BACKUPS_DIR)
}

/// The folder that holds skins in the given state.
pub fn base_dir(user_skins: &Path, active: bool) -> PathBuf {
    if active {
        user_skins.to_path_buf()
    } else {
        inactive_dir(user_skins)
    }
}

/// Where a skin folder lives in the given state; `None` for a name that isn't a single folder
/// (a tampered index must never make Livery touch anything outside `UserSkins`).
pub fn skin_path(user_skins: &Path, folder: &str, active: bool) -> Option<PathBuf> {
    is_folder_name(folder).then(|| base_dir(user_skins, active).join(folder))
}

/// Where the skin's folder is now, and whether that is the active place: the place its `active`
/// flag names, else the other one. `None` when the folder is in neither.
pub fn find_skin(user_skins: &Path, skin: &HangarSkin) -> Option<(PathBuf, bool)> {
    [skin.active, !skin.active]
        .into_iter()
        .find_map(|active| skin_path(user_skins, &skin.folder, active).filter(|p| p.is_dir()).map(|p| (p, active)))
}

/// A single, plain skin folder name: no separators, drive colon or control characters, not
/// hidden (`.`-prefixed: `.`, `..`, `...` and Livery's own `.livery` included) and no trailing
/// dot or space (Windows strips those, so `"..."` or `"a."` would name another folder).
pub fn is_folder_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control)
}

/// Whether anything (folder, file, broken link) sits at `path`.
pub fn occupied(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// `name`, or the first free of `name (2)`, `name (3)`… according to `taken`.
pub fn unique_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_owned();
    }
    (2u64..).map(|n| format!("{name} ({n})")).find(|candidate| !taken(candidate)).unwrap_or_else(|| name.to_owned())
}

/// Copies the folder `from` to the new folder `to`, recursively. Links are skipped. The file list
/// is read before anything is written, so copying a folder into itself terminates. On failure the
/// partial copy is removed.
pub fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    let mut entries = Vec::new();
    list_tree(from, Path::new(""), 0, &mut entries)?;
    // Only a folder this call created may be removed on failure: if `to` appeared meanwhile,
    // it belongs to someone else.
    fs::create_dir(to)?;
    let result = (|| {
        for (rel, is_dir) in &entries {
            if *is_dir {
                fs::create_dir(to.join(rel))?;
            } else {
                fs::copy(from.join(rel), to.join(rel))?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(to);
    }
    result
}

/// Every folder and file under `dir` (relative paths, parents first), without following links.
fn list_tree(dir: &Path, rel: &Path, depth: usize, out: &mut Vec<(PathBuf, bool)>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let child = rel.join(entry.file_name());
        if kind.is_dir() {
            if depth >= MAX_COPY_DEPTH {
                return Err(io::Error::other("folder nesting is too deep"));
            }
            out.push((child.clone(), true));
            list_tree(&entry.path(), &child, depth + 1, out)?;
        } else if kind.is_file() {
            out.push((child, false));
        }
    }
    Ok(())
}

/// Removes a folder and everything in it; a folder that is already gone is fine.
pub fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// One file-system change the journal can undo.
#[derive(Debug)]
enum Step {
    Renamed { from: PathBuf, to: PathBuf },
    CreatedDir(PathBuf),
}

/// Renames and folder creations made while a library change is prepared. If the change fails
/// (or its index can't be written) they are undone in reverse order, so the disk and the index
/// never disagree; once the index is written, the clean-ups queued with `after_commit` run.
#[derive(Debug, Default)]
pub struct Journal {
    steps: Vec<Step>,
    empty_dirs_to_remove: Vec<PathBuf>,
}

impl Journal {
    /// `fs::rename`, remembered for rollback.
    pub fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)?;
        self.steps.push(Step::Renamed { from: from.to_path_buf(), to: to.to_path_buf() });
        Ok(())
    }

    /// `fs::create_dir_all`, remembering each folder it created for rollback.
    pub fn create_dir_all(&mut self, dir: &Path) -> io::Result<()> {
        let mut missing = Vec::new();
        let mut cursor = Some(dir);
        while let Some(path) = cursor.filter(|p| !p.as_os_str().is_empty() && !occupied(p)) {
            missing.push(path.to_path_buf());
            cursor = path.parent();
        }
        fs::create_dir_all(dir)?;
        // Outermost first, so the reverse-order rollback removes the innermost first.
        self.steps.extend(missing.into_iter().rev().map(Step::CreatedDir));
        Ok(())
    }

    /// Removes `dir` once the change is committed, if it is empty by then.
    pub fn after_commit_remove_empty_dir(&mut self, dir: PathBuf) {
        self.empty_dirs_to_remove.push(dir);
    }

    /// The change was saved: run the queued clean-ups (best effort).
    pub fn commit(mut self) {
        self.steps.clear();
        for dir in std::mem::take(&mut self.empty_dirs_to_remove) {
            let _ = fs::remove_dir(&dir);
        }
    }

    /// The change was abandoned: undo every step, newest first (best effort, logged).
    pub fn rollback(mut self) {
        self.undo();
    }

    fn undo(&mut self) {
        for step in std::mem::take(&mut self.steps).into_iter().rev() {
            let result = match &step {
                Step::Renamed { from, to } => fs::rename(to, from),
                Step::CreatedDir(dir) => fs::remove_dir(dir),
            };
            if let Err(e) = result {
                tracing::error!(error = %e, "could not undo a library file change");
                tracing::debug!(?step, "undo failed");
            }
        }
    }
}

/// A journal dropped without `commit` (a panic while a change was prepared) is rolled back, so
/// the disk goes back to what the unchanged index describes.
impl Drop for Journal {
    fn drop(&mut self) {
        if !self.steps.is_empty() {
            self.undo();
        }
    }
}

/// Folder names joined for an error's `detail` (one per line: names can't contain line breaks).
pub fn names_detail(names: &[String]) -> String {
    names.join("\n")
}

/// What happened to the skins a batch tried to move, beyond the ones that moved.
#[derive(Debug, Default)]
pub struct MoveReport {
    /// Folders whose destination name is taken.
    pub clashes: Vec<String>,
    /// Folders found in neither place.
    pub missing: Vec<String>,
    /// Folders the file system refused to move, with the reason.
    pub failed: Vec<(String, String)>,
}

impl MoveReport {
    /// `Ok(value)` when every skin moved; otherwise the most important problem as the error
    /// (clash → `conflict`, then file-system failure → `io`, then missing → `notFound`), with
    /// the folders concerned in `detail`.
    pub fn into_result<T>(self, value: T) -> AppResult<T> {
        if !self.clashes.is_empty() {
            return Err(AppError::new(ErrorCode::Conflict, "Another skin folder already has this name")
                .with_detail(names_detail(&self.clashes)));
        }
        if !self.failed.is_empty() {
            let lines: Vec<String> = self.failed.iter().map(|(folder, why)| format!("{folder}: {why}")).collect();
            return Err(
                AppError::new(ErrorCode::Io, "Some skin folders could not be moved").with_detail(names_detail(&lines))
            );
        }
        if !self.missing.is_empty() {
            return Err(AppError::new(ErrorCode::NotFound, "Some skin folders are missing")
                .with_detail(names_detail(&self.missing)));
        }
        Ok(value)
    }
}
