//! Logging. `tracing` events go to `<appData>/logs/livery.log` and, in debug builds, to stdout
//! too. Release builds have no console (`windows_subsystem = "windows"`), so the file is where
//! their logs live; they write to stdout only while no log file is open (before the setup opens
//! it, or when it can't be opened), which a console-less build simply discards.
//!
//! - **Level**: debug in debug builds, info in release. Full paths are logged at debug only, so
//!   a release log holds no paths.
//! - **Rotation**: at launch, a `livery.log` over [`MAX_LOG_BYTES`] is renamed `livery.log.1`,
//!   replacing an older one. So the logs of a session or two stay, and at most about 2 MB.
//! - **Writer**: the file is opened in append mode and shared by reference (`&File` is
//!   `io::Write`), without a lock: the fmt layer formats each event into a buffer and hands it
//!   over in one `write_all`, which an append-mode file writes at the end in one piece. With no
//!   lock, the panic hook can't deadlock on one held by the panicking thread.
//! - **Panics**: [`install_panic_hook`] logs the message and location at error level, then runs
//!   the default hook (release builds then abort, `panic = "abort"`).
//!
//! No `tracing-appender`: this is plain `tracing-subscriber` (`fmt` + `registry`).

use std::any::Any;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing::Subscriber;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt::writer::{MakeWriter, OptionalWriter};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Folder inside the app data dir that holds the logs.
pub const LOG_DIR: &str = "logs";

/// The current log.
pub const LOG_FILE: &str = "livery.log";

/// The previous log, after a rotation.
pub const OLD_LOG_FILE: &str = "livery.log.1";

/// A log bigger than this at launch is rotated (1 MB).
pub const MAX_LOG_BYTES: u64 = 1024 * 1024;

/// The app's log file, once [`attach`] has opened it.
static LOG: OnceLock<File> = OnceLock::new();

/// The level for this build: debug in debug builds, info in release.
pub fn max_level() -> LevelFilter {
    if cfg!(debug_assertions) {
        LevelFilter::DEBUG
    } else {
        LevelFilter::INFO
    }
}

/// Installs the global subscriber (see the module doc) and the panic hook. Call first thing in
/// `run()`: until [`attach`] opens the log file, events only reach stdout. A second call keeps
/// the subscriber already installed.
pub fn init() {
    let _ = subscriber(&LOG, max_level(), cfg!(debug_assertions)).try_init();
    install_panic_hook();
}

/// The subscriber [`init`] installs, writing to the file in `slot` once it is set. `console`:
/// always write to stdout too; otherwise stdout only while `slot` is empty.
pub fn subscriber(slot: &'static OnceLock<File>, level: LevelFilter, console: bool) -> impl Subscriber + Send + Sync {
    let stdout = tracing_subscriber::fmt::layer().with_target(false).with_writer(Console { slot, always: console });
    let file = tracing_subscriber::fmt::layer().with_target(false).with_ansi(false).with_writer(LogFile { slot });
    tracing_subscriber::registry().with(level).with(stdout).with(file)
}

/// Opens `<data_dir>/logs/livery.log` (rotating it first, see [`open_log_file`]) and sends the
/// log there from now on. Returns where the log is. Only the first successful call counts.
pub fn attach(data_dir: &Path) -> io::Result<PathBuf> {
    let dir = data_dir.join(LOG_DIR);
    let opened = open_log_file(&dir, MAX_LOG_BYTES)?;
    let path = opened.path.clone();
    if LOG.set(opened.file).is_err() {
        return Ok(path);
    }
    if let Some(e) = &opened.rotate_error {
        tracing::warn!(error = %e, "the old log can't be rotated; appending to it");
    } else if opened.rotated {
        tracing::info!("log rotated to livery.log.1");
    }
    Ok(path)
}

/// A log file ready for writing.
#[derive(Debug)]
pub struct OpenedLog {
    pub file: File,
    pub path: PathBuf,
    /// The previous log was over the limit and became `livery.log.1`.
    pub rotated: bool,
    /// The previous log was over the limit but couldn't be renamed: it is appended to.
    pub rotate_error: Option<io::Error>,
}

/// Creates `dir`, rotates `dir/livery.log` when it is over `max_bytes` ([`rotate`]) and opens it
/// for appending (created when missing). A failed rotation isn't fatal: the old log is appended
/// to and the next launch tries again. Fails only when the file can't be opened.
pub fn open_log_file(dir: &Path, max_bytes: u64) -> io::Result<OpenedLog> {
    fs::create_dir_all(dir)?;
    let (rotated, rotate_error) = match rotate(dir, max_bytes) {
        Ok(rotated) => (rotated, None),
        Err(e) => (false, Some(e)),
    };
    let path = dir.join(LOG_FILE);
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok(OpenedLog { file, path, rotated, rotate_error })
}

/// Renames `dir/livery.log` to `livery.log.1` (replacing an older one) when it is bigger than
/// `max_bytes`. Returns whether it did. A missing log is not an error.
pub fn rotate(dir: &Path, max_bytes: u64) -> io::Result<bool> {
    let log = dir.join(LOG_FILE);
    match fs::metadata(&log) {
        Ok(meta) if meta.is_file() && meta.len() > max_bytes => {
            fs::rename(&log, dir.join(OLD_LOG_FILE))?;
            Ok(true)
        }
        Ok(_) => Ok(false),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Logs every panic (message and location) at error level, then runs the hook that was there
/// before (the default one prints to stderr).
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        tracing::error!(
            location = location.as_deref().unwrap_or("unknown"),
            "panic: {}",
            panic_message(info.payload())
        );
        previous(info);
    }));
}

/// The text a panic was raised with (`panic!("…")`, `expect("…")`, an `unwrap` on an error).
pub fn panic_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(text) = payload.downcast_ref::<&str>() {
        text
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text
    } else {
        "(no message)"
    }
}

/// The file layer's writer: the log file once it is open, nowhere before.
struct LogFile {
    slot: &'static OnceLock<File>,
}

impl<'a> MakeWriter<'a> for LogFile {
    type Writer = OptionalWriter<&'static File>;

    fn make_writer(&'a self) -> Self::Writer {
        self.slot.get().into()
    }
}

/// The stdout layer's writer: always when `always`, otherwise only while no log file is open.
struct Console {
    slot: &'static OnceLock<File>,
    always: bool,
}

impl<'a> MakeWriter<'a> for Console {
    type Writer = OptionalWriter<io::Stdout>;

    fn make_writer(&'a self) -> Self::Writer {
        (self.always || self.slot.get().is_none()).then(io::stdout).into()
    }
}
