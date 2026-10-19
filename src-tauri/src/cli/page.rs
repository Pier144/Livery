//! The three commands the agent CLI's hidden page (`cli.html`) calls: `cli_job` (what to do),
//! `cli_file` (one output file) and `cli_finish` (the result). They are registered in every build
//! so the app keeps a single handler list, but they answer `unsupported` unless a [`PageJob`] is
//! managed, which only a debug build's `--livery-cli` run creates (see `cli::runtime`).

use crate::atelier::{header, raw_body};
use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Request;
use tauri::{AppHandle, Manager};

/// What the page talks to; only a debug build's CLI mode manages one.
pub struct PageJob {
    /// The job as JSON (`CliCommand::page_job`, read by `src/cli/job.ts`).
    pub job: serde_json::Value,
    /// Where `cli_file` writes (`render --out`); `None` for the commands that write no files.
    pub out_dir: Option<PathBuf>,
    /// Ends the run with the page's answer (the first answer wins; see `cli::runtime::finish`).
    pub finish: Box<dyn Fn(Result<serde_json::Value, PageError>) + Send + Sync>,
    /// Set by the first `cli_job`: the page loaded and its script runs (the CLI's load check).
    pub loaded: AtomicBool,
}

/// A failure the page reports: an `AppError` it caught or one of the CLI-only codes (`noHit`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub detail: Option<String>,
}

fn job(app: &AppHandle) -> AppResult<tauri::State<'_, PageJob>> {
    app.try_state::<PageJob>().ok_or_else(|| AppError::new(ErrorCode::Unsupported, "Not in agent CLI mode"))
}

/// A bare output file name the page may write: `^[A-Za-z0-9._-]{1,64}$`, not `.` or `..`. No
/// separators, drive letters or colons can get through, so the file always lands in `--out`.
pub fn is_file_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name != "."
        && name != ".."
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The job the page runs.
#[tauri::command]
pub fn cli_job(app: AppHandle) -> AppResult<serde_json::Value> {
    let page = job(&app)?;
    page.loaded.store(true, Ordering::SeqCst);
    Ok(page.job.clone())
}

/// One output file: the raw body written to `--out`/`x-name` (created or replaced).
#[tauri::command]
pub async fn cli_file(app: AppHandle, request: Request<'_>) -> AppResult<()> {
    let out_dir = job(&app)?.out_dir.clone();
    let name = header(&request, "x-name").unwrap_or_default().to_owned();
    if !is_file_name(&name) {
        return Err(AppError::new(ErrorCode::InvalidInput, "Not a valid output file name").with_detail(name));
    }
    let out_dir = out_dir.ok_or_else(|| {
        AppError::new(ErrorCode::InvalidInput, "This command writes no files").with_detail(name.clone())
    })?;
    let body = raw_body(&request)
        .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "Not a raw request body").with_detail(name.clone()))?;
    blocking(move || {
        std::fs::write(out_dir.join(&name), body).map_err(|e| {
            AppError::new(ErrorCode::Io, "The output file can't be written").with_detail(format!("{name}: {e}"))
        })
    })
    .await
}

/// The page's answer: exactly one of `ok` and `error`. Both or neither is a page bug, reported
/// as an internal error so the run still ends.
#[tauri::command]
pub fn cli_finish(app: AppHandle, ok: Option<serde_json::Value>, error: Option<PageError>) -> AppResult<()> {
    let page = job(&app)?;
    let result = match (ok, error) {
        (Some(value), None) => Ok(value),
        (None, Some(e)) => Err(e),
        (ok, error) => Err(PageError {
            code: "internal".to_owned(),
            message: "The agent CLI page answered badly".to_owned(),
            detail: Some(format!("ok: {}, error: {}", ok.is_some(), error.is_some())),
        }),
    };
    (page.finish)(result);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_file_name;

    #[test]
    fn plain_names_are_accepted() {
        for name in ["front.png", "slot_body_c.png", "orbit_0.50_1.20_1.00.png", "a", &"x".repeat(64)] {
            assert!(is_file_name(name), "{name}");
        }
    }

    #[test]
    fn paths_and_odd_names_are_refused() {
        for name in ["../x", "a/b", "a\\b", "", ".", "..", &"x".repeat(65), "con:", "C:x", "a b", "é.png"] {
            assert!(!is_file_name(name), "{name:?}");
        }
    }
}
