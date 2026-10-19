//! The CLI commands Rust answers by itself (no page, no GPU), and the checks that run before a
//! page job starts. Not there yet: every such command answers `unsupported`.

use super::args::CliCommand;
use super::output::CliError;
use tauri::AppHandle;

/// Runs a command that needs no page (`CliCommand::page_job` is `None`).
pub async fn run_rust(_app: &AppHandle, _command: &CliCommand) -> Result<serde_json::Value, CliError> {
    Err(CliError::new("unsupported", "Not in the agent CLI yet"))
}

/// What a page job needs from Rust before the window opens.
pub async fn before_page(_app: &AppHandle, _command: &CliCommand) -> Result<(), CliError> {
    Ok(())
}
