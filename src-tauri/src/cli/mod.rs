//! The agent CLI (`livery.exe --livery-cli <command>`, debug builds only): see
//! `docs/superpowers/specs/2026-10-19-atelier-cli-design.md`. The parser and the output
//! formatting are plain code with their own tests; `runtime` runs a command inside a Tauri app in
//! CLI mode. This module itself exists in every build: `page` holds the commands the hidden page
//! calls, registered everywhere so the app keeps one handler list (they refuse outside CLI mode).

#[cfg(debug_assertions)]
pub mod args;
#[cfg(debug_assertions)]
pub mod output;
pub mod page;
#[cfg(debug_assertions)]
pub mod runtime;
#[cfg(debug_assertions)]
mod rust_cmds;
