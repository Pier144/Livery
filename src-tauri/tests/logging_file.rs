//! The log file (`<appData>/logs/livery.log`) on temp folders: rotation at launch, opening for
//! appending, what reaches the file, and panic messages.

use livery_lib::logging::{
    open_log_file, panic_message, rotate, subscriber, LOG_DIR, LOG_FILE, MAX_LOG_BYTES, OLD_LOG_FILE,
};
use std::any::Any;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use tracing_subscriber::filter::LevelFilter;

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-log-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    /// `<tmp>/data/logs`, which doesn't exist yet.
    fn logs(&self) -> PathBuf {
        self.0.join("data").join(LOG_DIR)
    }

    fn write(&self, name: &str, text: &str) {
        fs::create_dir_all(self.logs()).unwrap();
        fs::write(self.logs().join(name), text).unwrap();
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.logs().join(name)).unwrap()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn append(path: &Path, text: &str) {
    let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

#[test]
fn the_limit_is_one_megabyte() {
    assert_eq!(MAX_LOG_BYTES, 1024 * 1024);
    assert_eq!(LOG_FILE, "livery.log");
    assert_eq!(OLD_LOG_FILE, "livery.log.1");
}

#[test]
fn first_launch_creates_the_folder_and_an_empty_log() {
    let tmp = TempDir::new("first");
    let opened = open_log_file(&tmp.logs(), MAX_LOG_BYTES).unwrap();
    assert_eq!(opened.path, tmp.logs().join(LOG_FILE));
    assert!(!opened.rotated);
    assert!(opened.rotate_error.is_none());
    assert_eq!(tmp.read(LOG_FILE), "");
    assert!(!tmp.logs().join(OLD_LOG_FILE).exists());
}

#[test]
fn missing_log_is_not_rotated() {
    let tmp = TempDir::new("missing");
    fs::create_dir_all(tmp.logs()).unwrap();
    assert!(!rotate(&tmp.logs(), 10).unwrap());
    assert!(!rotate(&tmp.0.join("nowhere"), 10).unwrap(), "a missing folder is fine too");
}

#[test]
fn a_log_within_the_limit_is_appended_to() {
    let tmp = TempDir::new("small");
    tmp.write(LOG_FILE, "0123456789");
    let opened = open_log_file(&tmp.logs(), 10).unwrap();
    assert!(!opened.rotated, "exactly the limit is not over it");
    append(&opened.path, "+new");
    assert_eq!(tmp.read(LOG_FILE), "0123456789+new");
    assert!(!tmp.logs().join(OLD_LOG_FILE).exists());
}

#[test]
fn a_log_over_the_limit_becomes_log_1_replacing_the_older_one() {
    let tmp = TempDir::new("big");
    tmp.write(OLD_LOG_FILE, "the session before last");
    tmp.write(LOG_FILE, "01234567890");
    let opened = open_log_file(&tmp.logs(), 10).unwrap();
    assert!(opened.rotated);
    assert!(opened.rotate_error.is_none());
    assert_eq!(tmp.read(OLD_LOG_FILE), "01234567890");
    assert_eq!(tmp.read(LOG_FILE), "", "a fresh log");
    append(&opened.path, "next");
    assert_eq!(tmp.read(LOG_FILE), "next");
}

#[test]
fn a_rotation_that_fails_appends_to_the_old_log() {
    let tmp = TempDir::new("stuck");
    tmp.write(LOG_FILE, "01234567890");
    // livery.log.1 is a folder with something in it: the rename can't replace it.
    fs::create_dir_all(tmp.logs().join(OLD_LOG_FILE)).unwrap();
    tmp.write(&format!("{OLD_LOG_FILE}/keep.txt"), "x");
    let opened = open_log_file(&tmp.logs(), 10).unwrap();
    assert!(!opened.rotated);
    assert!(opened.rotate_error.is_some());
    append(&opened.path, "+more");
    assert_eq!(tmp.read(LOG_FILE), "01234567890+more");
    assert!(tmp.logs().join(OLD_LOG_FILE).join("keep.txt").is_file());
}

#[test]
fn a_log_that_cant_be_opened_is_an_error() {
    let tmp = TempDir::new("folder");
    // A folder where the log should be.
    fs::create_dir_all(tmp.logs().join(LOG_FILE)).unwrap();
    assert!(open_log_file(&tmp.logs(), MAX_LOG_BYTES).is_err());

    // A file where the logs folder should be.
    let blocked = tmp.0.join("blocked");
    fs::write(&blocked, "not a folder").unwrap();
    assert!(open_log_file(&blocked, MAX_LOG_BYTES).is_err());
}

#[test]
fn events_reach_the_file_once_it_is_open_at_the_level_without_colours() {
    let tmp = TempDir::new("events");
    let opened = open_log_file(&tmp.logs(), MAX_LOG_BYTES).unwrap();
    let slot: &'static OnceLock<File> = Box::leak(Box::new(OnceLock::new()));
    tracing::subscriber::with_default(subscriber(slot, LevelFilter::INFO, false), || {
        tracing::info!("before the file is open");
        slot.set(opened.file).unwrap();
        tracing::info!(answer = 42, "into the file");
        tracing::warn!("a warning");
        tracing::debug!("below the level");
    });
    let text = tmp.read(LOG_FILE);
    assert!(!text.contains("before the file is open"), "{text}");
    assert!(text.contains("into the file") && text.contains("answer=42"), "{text}");
    assert!(text.contains("WARN") && text.contains("a warning"), "{text}");
    assert!(!text.contains("below the level"), "{text}");
    assert!(!text.contains('\u{1b}'), "no ANSI colours in the file: {text:?}");
    assert_eq!(text.lines().count(), 2, "one line per event: {text}");
}

#[test]
fn panic_messages_come_from_str_and_string_payloads() {
    let from_str: Box<dyn Any + Send> = Box::new("boom");
    let from_string: Box<dyn Any + Send> = Box::new(String::from("called `Option::unwrap()` on a `None` value"));
    let other: Box<dyn Any + Send> = Box::new(7_u32);
    assert_eq!(panic_message(&*from_str), "boom");
    assert_eq!(panic_message(&*from_string), "called `Option::unwrap()` on a `None` value");
    assert_eq!(panic_message(&*other), "(no message)");
}
