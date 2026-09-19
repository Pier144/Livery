//! The one error type every command returns. Serializes to `{ code, message, detail? }`.

use serde::Serialize;
use std::fmt;

/// Stable, machine-readable error codes (camelCase on the wire). The UI branches on these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Io,
    NotFound,
    Parse,
    InvalidInput,
    /// The target already exists (e.g. a folder name clash when activating or restoring).
    Conflict,
    /// The feature needs something that isn't available yet (e.g. ZIP/RAR/7z unpacking).
    Unsupported,
    Network,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    /// Short, user-presentable summary.
    pub message: String,
    /// Technical detail (OS error, path, parser position). Shown only on demand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(detail) => write!(f, "{:?}: {} ({detail})", self.code, self.message),
            None => write!(f, "{:?}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for AppError {}

/// A store's file (settings, Following, a library index) that existed at launch but couldn't be
/// read: a sharing violation, missing permissions. The store keeps defaults (or an empty list) in
/// memory and refuses every write for the session, so the real file is never overwritten with
/// them. A missing file and a readable but corrupt one are not this: those start fresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableFile {
    /// The file's name only (no folders), for the message.
    file: String,
    /// Why it couldn't be read (the OS error; it holds no path), for the error's detail.
    reason: String,
}

impl UnreadableFile {
    pub fn new(path: &std::path::Path, error: &std::io::Error) -> Self {
        let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Self { file, reason: error.to_string() }
    }

    /// The file name the message names.
    pub fn file(&self) -> &str {
        &self.file
    }

    /// What every write to the store returns: `io`, [`unreadable_at_launch_message`], and the
    /// OS error as the detail.
    pub fn error(&self) -> AppError {
        AppError::new(ErrorCode::Io, unreadable_at_launch_message(&self.file)).with_detail(self.reason.clone())
    }
}

/// Message of the `io` error returned by every write to a store whose file `file` (a file name,
/// no path) couldn't be read at launch.
pub fn unreadable_at_launch_message(file: &str) -> String {
    format!(
        "Livery couldn't read {file} when it started, so it won't overwrite it. \
         Close other programs using it and restart Livery."
    )
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        let code = if e.kind() == std::io::ErrorKind::NotFound { ErrorCode::NotFound } else { ErrorCode::Io };
        AppError::new(code, "File system error").with_detail(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new(ErrorCode::Parse, "Could not read JSON").with_detail(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_code_message_detail() {
        let e = AppError::new(ErrorCode::InvalidInput, "Not a game folder").with_detail("C:\\x");
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "invalidInput", "message": "Not a game folder", "detail": "C:\\x" })
        );
    }

    #[test]
    fn omits_missing_detail() {
        let json = serde_json::to_value(AppError::new(ErrorCode::Network, "WT Live unreachable")).unwrap();
        assert_eq!(json, serde_json::json!({ "code": "network", "message": "WT Live unreachable" }));
    }

    #[test]
    fn unreadable_file_names_the_file_without_its_folders() {
        let os = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Access is denied. (os error 5)");
        let path = std::path::Path::new("Users").join("me").join("AppData").join("settings.json");
        let unreadable = UnreadableFile::new(&path, &os);
        assert_eq!(unreadable.file(), "settings.json");
        let e = unreadable.error();
        assert_eq!(e.code, ErrorCode::Io);
        assert_eq!(
            e.message,
            "Livery couldn't read settings.json when it started, so it won't overwrite it. \
             Close other programs using it and restart Livery."
        );
        assert!(!e.message.contains("AppData"), "no folders in the message");
        assert_eq!(e.detail.as_deref(), Some("Access is denied. (os error 5)"));
    }

    #[test]
    fn maps_io_not_found() {
        let e: AppError = std::io::Error::new(std::io::ErrorKind::NotFound, "gone").into();
        assert_eq!(e.code, ErrorCode::NotFound);
        assert_eq!(e.detail.as_deref(), Some("gone"));
    }
}
