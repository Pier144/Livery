//! What the CLI prints and how it exits. Pure: the whole of stdout is one JSON document, the
//! result on success or a [`CliError`], and the exit code says which kind of failure it was.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::process::ExitCode;

/// What the CLI prints on failure: an `AppError`'s code as serialized, or one of the CLI-only codes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CliError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
}

/// Another Livery process holds the data folder lock.
pub const APP_RUNNING: &str = "appRunning";
/// The run took longer than the command's limit.
pub const TIMEOUT: &str = "timeout";
/// A `place` ray hit nothing.
pub const NO_HIT: &str = "noHit";

impl From<AppError> for CliError {
    /// Goes through the serialized form so the code string is exactly what the frontend sees.
    fn from(e: AppError) -> Self {
        let value = serde_json::to_value(&e).unwrap_or_default();
        let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_owned);
        CliError {
            code: text("code").unwrap_or_else(|| "internal".to_owned()),
            message: text("message").unwrap_or_default(),
            detail: text("detail"),
        }
    }
}

impl CliError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        CliError { code: code.to_owned(), message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// 1 usage/input, 2 internal, 3 app running, 4 timeout (spec §3).
    pub fn exit_code(&self) -> u8 {
        match self.code.as_str() {
            "invalidInput" | "notFound" | "unsupported" | NO_HIT => 1,
            APP_RUNNING => 3,
            TIMEOUT => 4,
            _ => 2,
        }
    }
}

/// The CLI's whole stdout: pretty JSON of `Ok` or of the `CliError`, then a newline.
pub fn render(result: &Result<serde_json::Value, CliError>) -> (String, ExitCode) {
    let (json, code) = match result {
        Ok(value) => (serde_json::to_string_pretty(value), 0),
        Err(e) => (serde_json::to_string_pretty(e), e.exit_code()),
    };
    // Both are plain JSON trees; a failure to print them would be a bug, and the exit code still tells.
    let mut text = json.unwrap_or_else(|_| "null".to_owned());
    text.push('\n');
    (text, ExitCode::from(code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use serde_json::json;

    /// `ExitCode` can't be compared; its `Debug` form can.
    fn same_exit(actual: ExitCode, expected: u8) -> bool {
        format!("{actual:?}") == format!("{:?}", ExitCode::from(expected))
    }

    #[test]
    fn an_app_error_keeps_code_message_and_detail() {
        let e: CliError = AppError::new(ErrorCode::InvalidInput, "Bad arguments").with_detail("--at").into();
        assert_eq!(
            e,
            CliError { code: "invalidInput".into(), message: "Bad arguments".into(), detail: Some("--at".into()) }
        );
        let e: CliError = AppError::new(ErrorCode::NotFound, "No such project").into();
        assert_eq!(e.code, "notFound");
        assert_eq!(e.detail, None);
    }

    #[test]
    fn exit_codes_by_class() {
        for (code, exit) in [
            ("invalidInput", 1),
            ("notFound", 1),
            ("unsupported", 1),
            (NO_HIT, 1),
            ("internal", 2),
            ("io", 2),
            ("parse", 2),
            ("network", 2),
            ("conflict", 2),
            ("somethingNew", 2),
            (APP_RUNNING, 3),
            (TIMEOUT, 4),
        ] {
            assert_eq!(CliError::new(code, "m").exit_code(), exit, "{code}");
        }
    }

    #[test]
    fn every_real_error_code_maps_to_a_class() {
        // The wire strings of `ErrorCode` through `From<AppError>`: none may fall outside 1 or 2.
        for (code, exit) in [
            (ErrorCode::Io, 2),
            (ErrorCode::NotFound, 1),
            (ErrorCode::Parse, 2),
            (ErrorCode::InvalidInput, 1),
            (ErrorCode::Conflict, 2),
            (ErrorCode::Unsupported, 1),
            (ErrorCode::Network, 2),
            (ErrorCode::Internal, 2),
        ] {
            let e: CliError = AppError::new(code, "m").into();
            assert_eq!(e.exit_code(), exit, "{code:?}");
        }
    }

    #[test]
    fn success_is_pretty_json_and_exit_zero() {
        let (text, exit) = render(&Ok(json!({"a": 1})));
        assert_eq!(text, "{\n  \"a\": 1\n}\n");
        assert!(same_exit(exit, 0));
    }

    #[test]
    fn failure_prints_the_error_and_its_exit_code() {
        let (text, exit) = render(&Err(CliError::new(TIMEOUT, "Took too long")));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            json!({"code":"timeout","message":"Took too long"})
        );
        assert!(!text.contains("detail"));
        assert!(text.ends_with("}\n"));
        assert!(same_exit(exit, 4));

        let (text, exit) = render(&Err(CliError::new(NO_HIT, "Nothing there").with_detail("front 0.5,0.5")));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            json!({"code":"noHit","message":"Nothing there","detail":"front 0.5,0.5"})
        );
        assert!(same_exit(exit, 1));
    }
}
