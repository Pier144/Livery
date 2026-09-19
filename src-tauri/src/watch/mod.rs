//! Folder watching (M4), by polling (no file-system notification crate yet): one background
//! thread looks every [`POLL_INTERVAL`] at
//!
//! - the watched folder (Settings `watchFolder`, else the user's Downloads folder), only while
//!   `autoInstall` is on: a new `*.zip` / `*.rar` / `*.7z`, or a new top-level folder that holds
//!   a skin, whose size held still between two polls is analysed into the install queue
//!   (`queue://added`) and, when it can go in, installed with Settings → Conflicts. Under "Ask",
//!   a folder name that is taken is left as a conflict row for the user. What was in the folder
//!   when watching started is ignored;
//! - `UserSkins`, when a game folder is set: a change to its listing (or to the inactive folder)
//!   by anything, Explorer included, emits `hangar://changed` once it held still for a poll.
//!
//! The decisions are pure ([`poll`]); the disk reads are in [`snapshot`]; [`Watcher`] ties them
//! together behind a [`Host`] (the app, or a test double), and [`WatchState`] owns the thread:
//! each start bumps a generation counter, which stops the previous thread before its next poll.

pub mod poll;
pub mod snapshot;

use crate::archive::analyze::QUEUE_PREFIX;
use crate::archive::{self, QueueStore};
use crate::blocking;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::root;
use crate::library;
use crate::model::{ConflictPolicy, QueueItem, QueueStatus, Settings, SettingsPatch};
use crate::settings::SettingsStore;
use poll::{ArrivalPoller, HangarPoller, HangarSnapshot, Kind};
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const HANGAR_CHANGED_EVENT: &str = "hangar://changed";

/// Time between two polls.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// How long a new arrival's size must hold still, on top of being the same at two polls.
pub const SETTLE: Duration = Duration::from_secs(1);

/// Longest a continuous burst of `UserSkins` changes can hold `hangar://changed` back.
pub const HANGAR_MAX_DELAY: Duration = Duration::from_secs(10);

/// `invalidInput` message for a watched folder that doesn't exist (or isn't a folder).
pub const WATCH_FOLDER_GONE: &str = "The watched folder can't be found";

/// `invalidInput` message for a watched folder inside `UserSkins` (installs would be picked up
/// again as new arrivals).
pub const WATCH_INSIDE_USER_SKINS: &str = "The watched folder can't be inside UserSkins";

/// `invalidInput` message when no folder is given, none is saved and Downloads can't be found.
pub const NO_DOWNLOADS_FOLDER: &str = "Can't find the Downloads folder. Pick a folder to watch.";

// ── Thread ownership ────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct Shared {
    generation: Mutex<u64>,
    superseded: Condvar,
}

impl Shared {
    fn generation(&self) -> MutexGuard<'_, u64> {
        self.generation.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Owns the watcher's polling thread (managed by the app). Each [`WatchState::start`] or
/// [`WatchState::stop`] bumps the generation; a thread polls only while its generation is the
/// current one and wakes up at once when it is superseded.
#[derive(Debug, Default)]
pub struct WatchState {
    shared: Arc<Shared>,
}

/// A polling thread's claim, valid until the next start or stop.
#[derive(Debug, Clone)]
pub struct Ticket {
    shared: Arc<Shared>,
    generation: u64,
}

impl Ticket {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn is_current(&self) -> bool {
        *self.shared.generation() == self.generation
    }

    /// Waits `timeout`. Returns true when the time is up and the ticket is still current, false
    /// as soon as it is superseded.
    pub fn sleep(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut current = self.shared.generation();
        loop {
            if *current != self.generation {
                return false;
            }
            let now = Instant::now();
            if now >= deadline {
                return true;
            }
            current = self.shared.superseded.wait_timeout(current, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
}

impl WatchState {
    /// The current generation (0 before the first start).
    pub fn generation(&self) -> u64 {
        *self.shared.generation()
    }

    /// Supersedes the running thread (it stops before its next poll) and returns the claim of
    /// the next one.
    fn supersede(&self) -> Ticket {
        let mut generation = self.shared.generation();
        *generation += 1;
        let ticket = Ticket { shared: Arc::clone(&self.shared), generation: *generation };
        drop(generation);
        self.shared.superseded.notify_all();
        ticket
    }

    /// Stops polling.
    pub fn stop(&self) {
        self.supersede();
    }

    /// Starts a thread that runs `tick` at once and then every `interval`, until the next
    /// `start` or `stop`; the thread running before stops. `tick` gets the thread's ticket so a
    /// long poll can stop early.
    pub fn start<F>(&self, interval: Duration, mut tick: F) -> io::Result<Ticket>
    where
        F: FnMut(&Ticket) + Send + 'static,
    {
        let ticket = self.supersede();
        let mine = ticket.clone();
        let spawned = thread::Builder::new().name("livery-watch".into()).spawn(move || {
            while mine.is_current() {
                tick(&mine);
                if !mine.sleep(interval) {
                    break;
                }
            }
            tracing::debug!(generation = mine.generation, "watcher thread stopped");
        });
        if let Err(e) = spawned {
            // Nothing polls under this ticket.
            self.stop();
            return Err(e);
        }
        Ok(ticket)
    }
}

// ── Polling ─────────────────────────────────────────────────────────────────

/// What a poll needs from the outside world, and where its findings go.
pub trait Host: Send + 'static {
    /// The current settings (read at every poll, so changes apply without a restart).
    fn settings(&self) -> Settings;
    /// The folder watched when the settings name none: the user's Downloads folder.
    fn default_folder(&self) -> Option<PathBuf>;
    /// A new skin archive or skin folder finished arriving in the watched folder.
    fn arrived(&mut self, path: &Path, settings: &Settings);
    /// `UserSkins` changed.
    fn hangar_changed(&mut self);
}

/// Timings of a [`Watcher`] (the defaults are the app's; tests shorten them).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    pub settle: Duration,
    pub hangar_max_delay: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { settle: SETTLE, hangar_max_delay: HANGAR_MAX_DELAY }
    }
}

/// One watcher: its pollers and its host. [`Watcher::tick`] is one poll.
pub struct Watcher<H: Host> {
    host: H,
    timing: Timing,
    arrivals: ArrivalPoller,
    /// Path key of the folder `arrivals` watches (`None` while not watching).
    watching: Option<String>,
    hangar: HangarPoller,
}

impl<H: Host> Watcher<H> {
    pub fn new(host: H) -> Self {
        Self::with_timing(host, Timing::default())
    }

    pub fn with_timing(host: H, timing: Timing) -> Self {
        Self {
            host,
            timing,
            arrivals: ArrivalPoller::new(timing.settle),
            watching: None,
            hangar: HangarPoller::new(timing.hangar_max_delay),
        }
    }

    /// The folder new arrivals are watched in right now (`None` while `autoInstall` is off).
    pub fn watching(&self) -> Option<&str> {
        self.watching.as_deref()
    }

    /// One poll at `now`. `still_current` is asked before each arrival is handed over, so a
    /// superseded watcher stops early.
    pub fn tick(&mut self, now: Instant, still_current: &dyn Fn() -> bool) {
        let settings = self.host.settings();
        let user_skins = library::user_skins_dir(&settings).ok();
        self.poll_arrivals(now, &settings, user_skins.as_deref(), still_current);
        if still_current() {
            self.poll_hangar(now, user_skins.as_deref());
        }
    }

    fn poll_arrivals(
        &mut self,
        now: Instant,
        settings: &Settings,
        user_skins: Option<&Path>,
        still_current: &dyn Fn() -> bool,
    ) {
        let folder = settings
            .auto_install
            .then(|| watched_folder(settings, || self.host.default_folder()))
            .flatten()
            .filter(|folder| !user_skins.is_some_and(|us| is_within(folder, us)));
        let Some(folder) = folder else {
            // Not watching: the next start takes a fresh look at what is already there.
            if self.watching.take().is_some() {
                self.arrivals = ArrivalPoller::new(self.timing.settle);
            }
            return;
        };
        let key = root::path_key(&folder);
        if self.watching.as_deref() != Some(key.as_str()) {
            self.arrivals = ArrivalPoller::new(self.timing.settle);
            self.watching = Some(key);
        }
        let listing = match snapshot::list_folder(&folder) {
            Ok(listing) => Some(listing),
            Err(e) => {
                tracing::debug!(error = %e, "watched folder can't be read");
                None
            }
        };
        let ready = self.arrivals.poll(now, listing.as_deref(), &mut |entry| snapshot::measure(&folder, entry));
        for entry in ready {
            if !still_current() {
                return;
            }
            let path = folder.join(&entry.name);
            if entry.kind == Kind::Dir && !snapshot::holds_skin(&path) {
                tracing::debug!("new folder in the watched folder holds no skin");
                continue;
            }
            tracing::info!(kind = ?entry.kind, "new skin download found");
            self.host.arrived(&path, settings);
        }
    }

    fn poll_hangar(&mut self, now: Instant, user_skins: Option<&Path>) {
        let snapshot = match user_skins {
            None => None,
            Some(user_skins) => match snapshot::hangar_signature(user_skins) {
                Ok(signature) => Some(HangarSnapshot { key: root::path_key(user_skins), signature }),
                Err(e) => {
                    // Skip this poll rather than report a change that may not be one.
                    tracing::debug!(error = %e, "UserSkins can't be read");
                    return;
                }
            },
        };
        if self.hangar.poll(now, snapshot) {
            tracing::debug!("UserSkins changed");
            self.host.hangar_changed();
        }
    }
}

/// The folder to watch: Settings `watchFolder`, else `default` (the Downloads folder).
pub fn watched_folder(settings: &Settings, default: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    match settings.watch_folder.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(saved) => Some(root::native_path(saved)),
        None => default(),
    }
}

/// Whether `path` is `dir` or inside it (compared as `root::path_key` does).
pub fn is_within(path: &Path, dir: &Path) -> bool {
    let (path, dir) = (root::path_key(path), root::path_key(dir));
    let sep = if cfg!(windows) { '\\' } else { '/' };
    path == dir || path.strip_prefix(dir.as_str()).is_some_and(|rest| rest.starts_with(sep) || dir.ends_with(sep))
}

/// Whether the watcher installs a freshly queued item by itself: a ready one, or one whose
/// folder name is taken on disk when Settings → Conflicts isn't "Ask" (that policy then
/// decides). Never under "Ask", never an item that waits for another queued one with the same
/// folder name, and never one that needs a pick or can't install.
pub fn should_auto_install(item: &QueueItem, policy: ConflictPolicy) -> bool {
    match item.status {
        QueueStatus::Ready => true,
        QueueStatus::Conflict => {
            policy != ConflictPolicy::Ask && !item.conflict_with.as_deref().is_some_and(|w| w.starts_with(QUEUE_PREFIX))
        }
        _ => false,
    }
}

/// The folder `watch_folder` saves: `path` when given, else the one already saved, else
/// `default` (Downloads). Turning watching on, or naming a folder, needs an existing folder
/// outside `user_skins` (`invalidInput` otherwise); turning it off with the saved folder accepts
/// it as it is (it may be gone). `Ok(None)`: turning off with no folder known at all.
pub fn choose_folder(
    settings: &Settings,
    path: Option<&str>,
    enabled: bool,
    default: Option<PathBuf>,
    user_skins: Option<&Path>,
) -> AppResult<Option<PathBuf>> {
    let explicit = path.map(|p| p.trim().trim_matches('"').trim());
    if explicit == Some("") {
        return Err(AppError::new(ErrorCode::InvalidInput, WATCH_FOLDER_GONE));
    }
    let folder = match explicit {
        Some(p) => Some(root::native_path(p)),
        None => watched_folder(settings, || default),
    };
    let Some(folder) = folder else {
        return if enabled { Err(AppError::new(ErrorCode::InvalidInput, NO_DOWNLOADS_FOLDER)) } else { Ok(None) };
    };
    if enabled || explicit.is_some() {
        let shown = root::display_path(&folder);
        if !folder.is_dir() {
            return Err(AppError::new(ErrorCode::InvalidInput, WATCH_FOLDER_GONE).with_detail(shown));
        }
        if user_skins.is_some_and(|us| is_within(&folder, us)) {
            return Err(AppError::new(ErrorCode::InvalidInput, WATCH_INSIDE_USER_SKINS).with_detail(shown));
        }
    }
    Ok(Some(folder))
}

// ── App glue ────────────────────────────────────────────────────────────────

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(error = %e, "could not emit {event}");
    }
}

/// The app as a watcher [`Host`].
struct AppHost {
    app: AppHandle,
}

impl Host for AppHost {
    fn settings(&self) -> Settings {
        self.app.state::<SettingsStore>().get()
    }

    fn default_folder(&self) -> Option<PathBuf> {
        self.app.path().download_dir().ok()
    }

    fn arrived(&mut self, path: &Path, settings: &Settings) {
        queue_arrival(&self.app, path, settings);
    }

    fn hangar_changed(&mut self) {
        emit(&self.app, HANGAR_CHANGED_EVENT, ());
    }
}

/// Queues a new arrival (`queue://added`, plus the items whose status changed), then installs it
/// when it can go in (see [`should_auto_install`]).
fn queue_arrival(app: &AppHandle, path: &Path, settings: &Settings) {
    let queued = match archive::queue_path(app, &root::display_path(path)) {
        Ok(queued) => queued,
        Err(e) => {
            tracing::info!(error = %e, "a new download could not be queued");
            return;
        }
    };
    emit(app, archive::QUEUE_ADDED_EVENT, &queued.item);
    for item in &queued.changed {
        emit(app, archive::QUEUE_ADDED_EVENT, item);
    }
    if !should_auto_install(&queued.item, settings.conflict_policy) {
        return;
    }
    // `None`: Settings → Conflicts, read again by the install.
    if let Err(e) = archive::start_install(app, &queued.item.id, None, None) {
        tracing::info!(error = %e, "a new download could not be installed automatically");
        // Under "Ask", a folder name taken meanwhile turned the item into a conflict row.
        if let Some(item) = app.state::<QueueStore>().get(&queued.item.id).filter(|i| *i != queued.item) {
            emit(app, archive::QUEUE_ADDED_EVENT, &item);
        }
    }
}

/// The managed [`WatchState`] (managed on first use if the app setup didn't).
fn watch_state(app: &AppHandle) -> tauri::State<'_, WatchState> {
    if app.try_state::<WatchState>().is_none() {
        app.manage(WatchState::default());
    }
    app.state::<WatchState>()
}

/// (Re)starts the polling thread with fresh pollers: what is in the watched folder now is old.
fn restart(app: &AppHandle) -> AppResult<()> {
    let mut watcher = Watcher::new(AppHost { app: app.clone() });
    watch_state(app)
        .start(POLL_INTERVAL, move |ticket| watcher.tick(Instant::now(), &|| ticket.is_current()))
        .map(|_| ())
        .map_err(|e| AppError::new(ErrorCode::Internal, "Could not start watching folders").with_detail(e.to_string()))
}

/// Starts the watcher; call once from the app setup, after the settings, library and queue
/// stores are managed. Failures are logged (the app works without it).
pub fn start(app: &AppHandle) {
    if let Err(e) = restart(app) {
        tracing::error!(error = %e, "folder watcher not started");
    }
}

/// Turns watching on or off (`autoInstall`) for `path`; without one, the folder already saved,
/// else the user's Downloads folder. Saves `watchFolder` and `autoInstall`, restarts polling
/// (what is in the folder now is ignored; only new arrivals count) and returns the settings.
#[tauri::command]
pub async fn watch_folder(app: AppHandle, path: Option<String>, enabled: bool) -> AppResult<Settings> {
    blocking(move || {
        let store = app.state::<SettingsStore>();
        let current = store.get();
        let user_skins = library::user_skins_dir(&current).ok();
        let default = app.path().download_dir().ok();
        let folder = choose_folder(&current, path.as_deref(), enabled, default, user_skins.as_deref())?;
        let settings = store.update(SettingsPatch {
            watch_folder: folder.as_deref().map(root::display_path),
            auto_install: Some(enabled),
            ..SettingsPatch::default()
        })?;
        restart(&app)?;
        tracing::info!(enabled, "folder watching updated");
        Ok(settings)
    })
    .await
}
