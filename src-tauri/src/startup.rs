//! Launch: where the app data lives ([`resolve_data_dir`], with the `LIVERY_DATA_DIR`
//! override) and how long the first screen took ([`StartupClock`], the `app_ready` command).

use crate::error::{AppError, AppResult, ErrorCode};
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::State;

/// Environment variable that moves the app data (settings, Following, library indexes, logs)
/// to another folder, in every build: the way to run Livery without touching the real data.
pub const DATA_DIR_ENV: &str = "LIVERY_DATA_DIR";

/// The app data dir in use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDir {
    pub path: PathBuf,
    /// Whether it comes from [`DATA_DIR_ENV`].
    pub from_env: bool,
}

/// The [`DATA_DIR_ENV`] override in `value` (the variable's value, if set): `None` when unset or
/// blank. Surrounding spaces and double quotes are trimmed (`set X="C:\dir"` in cmd keeps the
/// quotes, and a Windows path can't hold them), and a relative path is made absolute against the
/// current directory.
pub fn data_dir_override(value: Option<OsString>) -> Option<PathBuf> {
    let value = value?;
    let path = match value.to_str() {
        Some(text) => PathBuf::from(text.trim().trim_matches('"').trim()),
        None => PathBuf::from(value),
    };
    if path.as_os_str().is_empty() {
        return None;
    }
    Some(std::path::absolute(&path).unwrap_or(path))
}

/// The app data dir: the [`DATA_DIR_ENV`] override in `env_value` when there is one, else
/// `default()` (Tauri's app data dir, not asked for when the override is set). The folder is
/// created when missing.
pub fn resolve_data_dir(
    env_value: Option<OsString>,
    default: impl FnOnce() -> AppResult<PathBuf>,
) -> AppResult<DataDir> {
    let dir = match data_dir_override(env_value) {
        Some(path) => DataDir { path, from_env: true },
        None => DataDir { path: default()?, from_env: false },
    };
    if let Err(e) = fs::create_dir_all(&dir.path) {
        let message = if dir.from_env {
            "The LIVERY_DATA_DIR folder can't be created"
        } else {
            "The app data folder can't be created"
        };
        return Err(AppError::new(ErrorCode::Io, message).with_detail(e.to_string()));
    }
    Ok(dir)
}

/// When the app started, and how long its first screen took.
#[derive(Debug)]
pub struct StartupClock {
    start: Instant,
    ready_ms: OnceLock<u64>,
}

impl Default for StartupClock {
    fn default() -> Self {
        Self::new()
    }
}

impl StartupClock {
    /// A clock started now. Create it first thing in `run()`.
    pub fn new() -> Self {
        Self::starting_at(Instant::now())
    }

    pub fn starting_at(start: Instant) -> Self {
        Self { start, ready_ms: OnceLock::new() }
    }

    /// Milliseconds from the start to the first call, and whether this is that first call.
    /// Later calls return the same milliseconds.
    pub fn ready(&self) -> (u64, bool) {
        let mut first = false;
        let ms = *self.ready_ms.get_or_init(|| {
            first = true;
            u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
        });
        (ms, first)
    }
}

/// The frontend painted its first screen: returns the milliseconds since launch, and logs them
/// the first time only (later calls return the same value).
#[tauri::command]
pub fn app_ready(clock: State<'_, StartupClock>) -> AppResult<u64> {
    let (ms, first) = clock.ready();
    if first {
        tracing::info!("startup: first screen after {ms} ms");
    }
    Ok(ms)
}
