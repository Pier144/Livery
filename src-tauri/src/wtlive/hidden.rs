//! WT Live posts the user hid from Explore and Following (a way to
//! take a single entry out, for the day an author asks). Persisted as
//! `<appData>/wtlive-hidden.json` = `{ "version": 1, "ids": ["1191507", …] }`.
//!
//! Like the Following list: writes are atomic and memory changes only after the file is
//! written; a corrupt file is set aside as `.bad` and the list starts empty; a file that exists
//! but can't be read leaves the store read-only for the session. Skins already installed are
//! not touched: hiding only filters what WT Live lists.

use crate::error::{AppError, AppResult, ErrorCode, UnreadableFile};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const HIDDEN_FILE: &str = "wtlive-hidden.json";
pub const HIDDEN_VERSION: u32 = 1;

pub struct HiddenStore {
    path: PathBuf,
    ids: Mutex<BTreeSet<String>>,
    unreadable: Option<UnreadableFile>,
}

#[derive(Serialize)]
struct FileOut<'a> {
    version: u32,
    ids: Vec<&'a str>,
}

#[derive(Deserialize)]
struct FileIn {
    #[serde(default)]
    ids: Vec<serde_json::Value>,
}

impl HiddenStore {
    pub fn load(path: PathBuf) -> Self {
        let (ids, unreadable) = match read_file(&path) {
            Ok(ids) => (ids, None),
            Err(unreadable) => (BTreeSet::new(), Some(unreadable)),
        };
        Self { path, ids: Mutex::new(ids), unreadable }
    }

    fn lock(&self) -> MutexGuard<'_, BTreeSet<String>> {
        self.ids.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn contains(&self, id: &str) -> bool {
        self.lock().contains(id)
    }

    pub fn count(&self) -> u32 {
        u32::try_from(self.lock().len()).unwrap_or(u32::MAX)
    }

    /// Hides (`true`) or shows again (`false`) one post. A blank id is `invalidInput`.
    pub fn set(&self, id: &str, hidden: bool) -> AppResult<()> {
        let id = id.trim();
        if id.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, super::MISSING_SKIN_ID));
        }
        self.change(|ids| if hidden { ids.insert(id.to_owned()) } else { ids.remove(id) })
    }

    /// Shows every hidden post again.
    pub fn clear(&self) -> AppResult<()> {
        self.change(|ids| {
            let had = !ids.is_empty();
            ids.clear();
            had
        })
    }

    /// Runs `change` on a copy; writes it when `change` says something changed.
    fn change(&self, change: impl FnOnce(&mut BTreeSet<String>) -> bool) -> AppResult<()> {
        if let Some(unreadable) = &self.unreadable {
            return Err(unreadable.error());
        }
        let mut guard = self.lock();
        let mut next = guard.clone();
        if !change(&mut next) {
            return Ok(());
        }
        write_atomic(&self.path, &next)?;
        *guard = next;
        Ok(())
    }
}

fn read_file(path: &Path) -> Result<BTreeSet<String>, UnreadableFile> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(e) => {
            tracing::warn!(error = %e, "cannot read the hidden WT Live posts; read-only this session");
            return Err(UnreadableFile::new(path, &e));
        }
    };
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    match serde_json::from_slice::<FileIn>(text) {
        Ok(file) => Ok(file
            .ids
            .iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) => Some(s.trim().to_owned()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .filter(|s| !s.is_empty())
            .collect()),
        Err(e) => {
            tracing::warn!(error = %e, "hidden WT Live posts file is corrupt; set aside");
            let _ = fs::rename(path, path.with_extension("json.bad"));
            Ok(BTreeSet::new())
        }
    }
}

fn write_atomic(path: &Path, ids: &BTreeSet<String>) -> AppResult<()> {
    let save =
        |e: std::io::Error| AppError::new(ErrorCode::Io, "Could not save the hidden skins").with_detail(e.to_string());
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(save)?;
    }
    let body =
        serde_json::to_vec_pretty(&FileOut { version: HIDDEN_VERSION, ids: ids.iter().map(String::as_str).collect() })
            .map_err(|e| {
                AppError::new(ErrorCode::Internal, "Could not save the hidden skins").with_detail(e.to_string())
            })?;
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(save)?;
    file.write_all(&body).map_err(save)?;
    file.sync_all().map_err(save)?;
    drop(file);
    fs::rename(&tmp, path).map_err(save)
}
