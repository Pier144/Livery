//! Launch: the `LIVERY_DATA_DIR` override and the app data dir (as pure functions of the
//! variable's value, so no test touches the process environment), and the startup clock.

use livery_lib::error::{AppError, ErrorCode};
use livery_lib::startup::{data_dir_override, resolve_data_dir, StartupClock, DATA_DIR_ENV};
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-startup-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn os(text: &str) -> Option<OsString> {
    Some(OsString::from(text))
}

fn never() -> Result<PathBuf, AppError> {
    panic!("the default app data dir is not asked for when LIVERY_DATA_DIR is set")
}

#[test]
fn the_variable_is_livery_data_dir() {
    assert_eq!(DATA_DIR_ENV, "LIVERY_DATA_DIR");
}

#[test]
fn unset_or_blank_is_no_override() {
    assert_eq!(data_dir_override(None), None);
    assert_eq!(data_dir_override(os("")), None);
    assert_eq!(data_dir_override(os("   ")), None);
    assert_eq!(data_dir_override(os("\"\"")), None);
    assert_eq!(data_dir_override(os(" \" \" ")), None);
}

#[test]
fn an_absolute_value_is_used_trimmed_of_spaces_and_quotes() {
    let tmp = TempDir::new("abs");
    let dir = tmp.0.join("Livery data");
    let text = dir.to_str().unwrap();
    assert_eq!(data_dir_override(os(text)), Some(dir.clone()));
    assert_eq!(data_dir_override(os(&format!("  \"{text}\"  "))), Some(dir));
}

#[test]
fn a_relative_value_is_made_absolute() {
    let got = data_dir_override(os("livery-dev-data")).unwrap();
    assert!(got.is_absolute(), "{}", got.display());
    assert!(got.ends_with("livery-dev-data"));
    assert_eq!(got, std::env::current_dir().unwrap().join("livery-dev-data"));
}

#[test]
fn the_override_wins_and_is_created() {
    let tmp = TempDir::new("override");
    let dir = tmp.0.join("nested").join("data");
    let resolved = resolve_data_dir(Some(dir.clone().into_os_string()), never).unwrap();
    assert_eq!(resolved.path, dir);
    assert!(resolved.from_env);
    assert!(dir.is_dir(), "created when missing");
    // Already there: still fine.
    assert!(resolve_data_dir(Some(dir.clone().into_os_string()), never).is_ok());
}

#[test]
fn without_the_override_the_default_is_used_and_created() {
    let tmp = TempDir::new("default");
    let dir = tmp.0.join("app.livery.desktop");
    let resolved = resolve_data_dir(os(" "), || Ok(dir.clone())).unwrap();
    assert_eq!(resolved.path, dir);
    assert!(!resolved.from_env);
    assert!(dir.is_dir());
}

#[test]
fn a_default_that_cant_be_found_is_the_error() {
    let err = resolve_data_dir(None, || Err(AppError::new(ErrorCode::Internal, "no home"))).unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    assert_eq!(err.message, "no home");
}

#[test]
fn an_override_that_cant_be_created_is_an_io_error() {
    let tmp = TempDir::new("blocked");
    let file = tmp.0.join("a file");
    fs::write(&file, "not a folder").unwrap();
    let err = resolve_data_dir(Some(file.join("data").into_os_string()), never).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(err.message, "The LIVERY_DATA_DIR folder can't be created");
    assert!(err.detail.is_some());
}

#[test]
fn the_clock_measures_the_first_ready_and_keeps_it() {
    let Some(start) = Instant::now().checked_sub(Duration::from_millis(250)) else { return };
    let clock = StartupClock::starting_at(start);
    let (ms, first) = clock.ready();
    assert!(first);
    assert!((250..60_000).contains(&ms), "{ms}");
    std::thread::sleep(Duration::from_millis(5));
    assert_eq!(clock.ready(), (ms, false), "later calls return the same value, not first");
    assert_eq!(clock.ready(), (ms, false));
}

#[test]
fn a_new_clock_starts_now() {
    let (ms, first) = StartupClock::new().ready();
    assert!(first);
    assert!(ms < 5_000, "{ms}");
}
