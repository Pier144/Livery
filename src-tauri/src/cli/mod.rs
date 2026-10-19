//! The agent CLI (`livery.exe --livery-cli <command>`, debug builds only). The parser and the
//! output formatting are plain code with their own tests; the rest of the CLI joins them later.
//! This module itself exists in every build; its debug-only parts are gated one by one.

#[cfg(debug_assertions)]
pub mod args;
#[cfg(debug_assertions)]
pub mod output;
