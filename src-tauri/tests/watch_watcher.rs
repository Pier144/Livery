//! The watcher end to end on temp folders, with a recording host instead of the app: polls
//! driven by hand with a fake clock (new skin folders and archives found once they hold still,
//! what was there at the start and folders without a skin ignored, nothing while `autoInstall`
//! is off, the Downloads default, a watched folder inside `UserSkins` refused, `UserSkins`
//! changes → one event), then the polling thread itself: generations, restart and stop, and one
//! run with a short interval.

use livery_lib::library::layout::copy_dir;
use livery_lib::model::Settings;
use livery_lib::watch::snapshot::hangar_signature;
use livery_lib::watch::{Host, Timing, WatchState, Watcher, POLL_INTERVAL};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-watcher-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("sources").join(name)
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

/// A game folder with `UserSkins`, and a Downloads folder, side by side.
struct Setup {
    tmp: TempDir,
}

impl Setup {
    fn new(name: &str) -> Self {
        let tmp = TempDir::new(name);
        fs::create_dir_all(tmp.path().join("War Thunder").join("UserSkins")).unwrap();
        fs::create_dir_all(tmp.path().join("Downloads")).unwrap();
        Self { tmp }
    }

    fn game(&self) -> PathBuf {
        self.tmp.path().join("War Thunder")
    }

    fn user_skins(&self) -> PathBuf {
        self.game().join("UserSkins")
    }

    fn downloads(&self) -> PathBuf {
        self.tmp.path().join("Downloads")
    }

    fn settings(&self, auto_install: bool) -> Settings {
        Settings {
            game_path: Some(self.game().display().to_string()),
            watch_folder: Some(self.downloads().display().to_string()),
            auto_install,
            ..Settings::default()
        }
    }

    /// Copies a committed skin source into Downloads under `name`.
    fn download_folder(&self, fixture_name: &str, name: &str) -> PathBuf {
        let to = self.downloads().join(name);
        copy_dir(&fixture(fixture_name), &to).unwrap();
        to
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Event {
    Arrived(String),
    HangarChanged,
}

/// Everything a host saw, shared with the test.
#[derive(Default)]
struct Log {
    events: Vec<Event>,
    polls: u32,
}

#[derive(Clone)]
struct TestHost {
    settings: Arc<Mutex<Settings>>,
    default: Option<PathBuf>,
    log: Arc<Mutex<Log>>,
}

impl TestHost {
    fn new(settings: Settings) -> Self {
        Self { settings: Arc::new(Mutex::new(settings)), default: None, log: Arc::default() }
    }

    fn set(&self, change: impl FnOnce(&mut Settings)) {
        change(&mut self.settings.lock().unwrap());
    }

    /// Events so far, cleared.
    fn take(&self) -> Vec<Event> {
        std::mem::take(&mut self.log.lock().unwrap().events)
    }

    fn polls(&self) -> u32 {
        self.log.lock().unwrap().polls
    }
}

impl Host for TestHost {
    fn settings(&self) -> Settings {
        self.log.lock().unwrap().polls += 1;
        self.settings.lock().unwrap().clone()
    }

    fn default_folder(&self) -> Option<PathBuf> {
        self.default.clone()
    }

    fn arrived(&mut self, path: &Path, _settings: &Settings) {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        self.log.lock().unwrap().events.push(Event::Arrived(name));
    }

    fn hangar_changed(&mut self) {
        self.log.lock().unwrap().events.push(Event::HangarChanged);
    }
}

fn arrived(names: &[&str]) -> Vec<Event> {
    names.iter().map(|n| Event::Arrived((*n).to_owned())).collect()
}

/// Waits until the `UserSkins` fingerprint held still for 50 ms: Windows can report a folder's
/// new time in its parent's listing a moment after files are written inside it, and the ticks
/// below run back to back.
fn quiet(us: &Path) {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut last = hangar_signature(us).unwrap();
    loop {
        thread::sleep(Duration::from_millis(50));
        let next = hangar_signature(us).unwrap();
        if next == last || Instant::now() > deadline {
            return;
        }
        last = next;
    }
}

/// A watcher over `host` whose clock the test moves by hand, one [`POLL_INTERVAL`] per tick.
struct Driven {
    watcher: Watcher<TestHost>,
    host: TestHost,
    now: Instant,
}

impl Driven {
    fn new(host: TestHost) -> Self {
        Self { watcher: Watcher::new(host.clone()), host, now: Instant::now() }
    }

    fn tick(&mut self) -> Vec<Event> {
        self.watcher.tick(self.now, &|| true);
        self.now += POLL_INTERVAL;
        self.host.take()
    }
}

// ── Watcher, polled by hand ─────────────────────────────────────────────────

#[test]
fn new_skin_folders_and_archives_arrive_once_they_hold_still() {
    let setup = Setup::new("arrivals");
    // Already there when watching starts.
    write(&setup.downloads().join("old.zip"), b"old");
    setup.download_folder("Winter Tiger", "Old Tiger");
    let host = TestHost::new(setup.settings(true));
    let mut driven = Driven::new(host);
    assert!(driven.tick().is_empty(), "baseline");
    assert!(driven.watcher.watching().is_some());

    setup.download_folder("Winter Tiger", "Winter Tiger");
    setup.download_folder("Desert Pack", "Desert Pack");
    setup.download_folder("Loose Textures", "Loose Textures");
    write(&setup.downloads().join("tiger.ZIP"), b"zip bytes");
    write(&setup.downloads().join("notes.txt"), b"not a skin");
    fs::create_dir(setup.downloads().join("Empty")).unwrap();
    assert!(driven.tick().is_empty(), "first sighting: sizes not known to be stable yet");
    // Sorted by name; the folder without a blk, the text file and the empty folder never arrive.
    assert_eq!(driven.tick(), arrived(&["Desert Pack", "Winter Tiger", "tiger.ZIP"]));
    for _ in 0..3 {
        assert!(driven.tick().is_empty(), "each arrival is handed over once");
    }
}

#[test]
fn a_folder_still_being_filled_waits() {
    let setup = Setup::new("filling");
    let mut driven = Driven::new(TestHost::new(setup.settings(true)));
    driven.tick();
    let skin = setup.downloads().join("Tiger");
    write(&skin.join("tiger.blk"), b"replace_tex{}");
    assert!(driven.tick().is_empty());
    write(&skin.join("tiger_c.dds"), b"more bytes");
    assert!(driven.tick().is_empty(), "it grew since the last poll");
    assert_eq!(driven.tick(), arrived(&["Tiger"]));
}

#[test]
fn nothing_is_watched_while_auto_install_is_off() {
    let setup = Setup::new("disabled");
    let host = TestHost::new(setup.settings(false));
    let mut driven = Driven::new(host.clone());
    driven.tick();
    setup.download_folder("Winter Tiger", "Winter Tiger");
    write(&setup.downloads().join("pack.zip"), b"zip");
    for _ in 0..4 {
        assert!(driven.tick().is_empty());
    }
    assert!(driven.watcher.watching().is_none());

    // Turned on: what arrived meanwhile is already there; only later arrivals count.
    host.set(|s| s.auto_install = true);
    assert!(driven.tick().is_empty(), "baseline");
    write(&setup.downloads().join("later.7z"), b"7z");
    driven.tick();
    assert_eq!(driven.tick(), arrived(&["later.7z"]));

    // Off again, then on: a fresh baseline again.
    host.set(|s| s.auto_install = false);
    write(&setup.downloads().join("while-off.zip"), b"zip");
    driven.tick();
    driven.tick();
    host.set(|s| s.auto_install = true);
    for _ in 0..3 {
        assert!(driven.tick().is_empty(), "while-off.zip arrived while watching was off");
    }
}

#[test]
fn the_downloads_folder_is_the_default_and_a_new_folder_is_a_new_baseline() {
    let setup = Setup::new("default");
    let other = setup.tmp.path().join("Other");
    fs::create_dir(&other).unwrap();
    write(&other.join("present.zip"), b"zip");
    let mut host = TestHost::new(Settings { watch_folder: None, ..setup.settings(true) });
    host.default = Some(setup.downloads());
    let mut driven = Driven::new(host.clone());
    driven.tick();
    write(&setup.downloads().join("a.zip"), b"zip");
    driven.tick();
    assert_eq!(driven.tick(), arrived(&["a.zip"]));

    // Another folder picked: its current content is old.
    host.set(|s| s.watch_folder = Some(other.display().to_string()));
    assert!(driven.tick().is_empty());
    assert!(driven.tick().is_empty(), "present.zip was there when watching it began");
}

#[test]
fn a_watched_folder_inside_user_skins_is_never_polled() {
    let setup = Setup::new("inside");
    let host = TestHost::new(Settings {
        watch_folder: Some(setup.user_skins().display().to_string()),
        ..setup.settings(true)
    });
    let mut driven = Driven::new(host);
    driven.tick();
    copy_dir(&fixture("Winter Tiger"), &setup.user_skins().join("Winter Tiger")).unwrap();
    quiet(&setup.user_skins());
    let events: Vec<Event> = (0..4).flat_map(|_| driven.tick()).collect();
    assert_eq!(events, [Event::HangarChanged], "only the hangar notices it");
    assert!(driven.watcher.watching().is_none());
}

#[test]
fn a_superseded_watcher_hands_nothing_over() {
    let setup = Setup::new("superseded");
    let host = TestHost::new(setup.settings(true));
    let mut watcher = Watcher::new(host.clone());
    let t0 = Instant::now();
    watcher.tick(t0, &|| true);
    write(&setup.downloads().join("a.zip"), b"zip");
    watcher.tick(t0 + POLL_INTERVAL, &|| true);
    watcher.tick(t0 + POLL_INTERVAL * 2, &|| false);
    assert!(host.take().is_empty());
}

#[test]
fn user_skins_changes_give_one_event_once_they_hold_still() {
    let setup = Setup::new("hangar");
    let host = TestHost::new(setup.settings(false));
    let mut driven = Driven::new(host.clone());
    assert!(driven.tick().is_empty(), "baseline");
    assert!(driven.tick().is_empty());

    copy_dir(&fixture("Winter Tiger"), &setup.user_skins().join("Winter Tiger")).unwrap();
    quiet(&setup.user_skins());
    assert!(driven.tick().is_empty(), "debounced one poll");
    assert_eq!(driven.tick(), [Event::HangarChanged]);
    assert!(driven.tick().is_empty());

    // An install staging in .livery/partial is invisible; its final rename is not.
    let staging = setup.user_skins().join(".livery").join("partial").join("i-1").join("Desert");
    fs::create_dir_all(staging.parent().unwrap()).unwrap();
    copy_dir(&fixture("Loose Textures"), &staging).unwrap();
    assert!(driven.tick().is_empty());
    assert!(driven.tick().is_empty());
    fs::rename(&staging, setup.user_skins().join("Desert")).unwrap();
    quiet(&setup.user_skins());
    driven.tick();
    assert_eq!(driven.tick(), [Event::HangarChanged]);

    // Deactivating (a move into .livery/inactive) is a change too.
    let inactive = setup.user_skins().join(".livery").join("inactive");
    fs::create_dir_all(&inactive).unwrap();
    fs::rename(setup.user_skins().join("Desert"), inactive.join("Desert")).unwrap();
    quiet(&setup.user_skins());
    driven.tick();
    assert_eq!(driven.tick(), [Event::HangarChanged]);

    // No game folder: nothing to look at, and no event for it.
    host.set(|s| s.game_path = None);
    assert!(driven.tick().is_empty());
    assert!(driven.tick().is_empty());
}

// ── The polling thread ──────────────────────────────────────────────────────

#[test]
fn each_start_supersedes_the_previous_ticket() {
    let state = WatchState::default();
    assert_eq!(state.generation(), 0);
    let first = state.start(Duration::from_secs(60), |_| {}).unwrap();
    assert!(first.is_current());
    let second = state.start(Duration::from_secs(60), |_| {}).unwrap();
    assert_eq!(second.generation(), first.generation() + 1);
    assert!(!first.is_current() && second.is_current());
    state.stop();
    assert!(!second.is_current());
    assert_eq!(state.generation(), 3);
}

#[test]
fn a_sleeping_thread_wakes_up_at_once_when_superseded() {
    let state = WatchState::default();
    let (tx, rx) = std::sync::mpsc::channel();
    let ticket = state.start(Duration::from_secs(3600), move |t| tx.send(t.generation()).unwrap()).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), ticket.generation(), "first tick at once");
    let sleeper = {
        let ticket = ticket.clone();
        thread::spawn(move || ticket.sleep(Duration::from_secs(3600)))
    };
    thread::sleep(Duration::from_millis(50));
    let stopped_at = Instant::now();
    state.stop();
    assert!(!sleeper.join().unwrap(), "superseded, not timed out");
    assert!(stopped_at.elapsed() < Duration::from_secs(5), "woke up at once");
    assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "the thread ticks no more");
    assert!(!ticket.sleep(Duration::ZERO));
}

#[test]
fn a_current_ticket_sleeps_the_full_time() {
    let state = WatchState::default();
    let ticket = state.start(Duration::from_secs(3600), |_| {}).unwrap();
    let started = Instant::now();
    assert!(ticket.sleep(Duration::from_millis(30)));
    assert!(started.elapsed() >= Duration::from_millis(30));
    state.stop();
}

/// Waits (up to 10 s) until `done` holds, polling every 10 ms.
fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn the_thread_polls_restarts_and_stops() {
    let setup = Setup::new("thread");
    let timing = Timing { settle: Duration::ZERO, hangar_max_delay: Duration::from_secs(10) };
    let interval = Duration::from_millis(20);
    let state = WatchState::default();

    let first = TestHost::new(setup.settings(true));
    write(&setup.downloads().join("before.zip"), b"zip");
    let mut watcher = Watcher::with_timing(first.clone(), timing);
    state.start(interval, move |t| watcher.tick(Instant::now(), &|| t.is_current())).unwrap();
    wait_for("the baseline poll", || first.polls() >= 2);

    setup.download_folder("Winter Tiger", "Winter Tiger");
    copy_dir(&fixture("Desert Pack"), &setup.user_skins().join("Desert Pack")).unwrap();
    let mut seen = Vec::new();
    wait_for("the arrival and the hangar change", || {
        seen.extend(first.take());
        seen.contains(&Event::Arrived("Winter Tiger".into())) && seen.contains(&Event::HangarChanged)
    });
    assert!(!seen.contains(&Event::Arrived("before.zip".into())));

    // Restart (watch_folder does this): the old thread stops, the new one takes a fresh look.
    let second = TestHost::new(setup.settings(true));
    let mut watcher = Watcher::with_timing(second.clone(), timing);
    state.start(interval, move |t| watcher.tick(Instant::now(), &|| t.is_current())).unwrap();
    wait_for("the new thread", || second.polls() >= 2);
    let frozen = first.polls();
    thread::sleep(interval * 5);
    assert!(first.polls() <= frozen + 1, "the superseded thread stopped (at most one poll in flight)");
    write(&setup.downloads().join("after.7z"), b"7z");
    wait_for("the new arrival", || second.take().contains(&Event::Arrived("after.7z".into())));
    assert!(first.take().is_empty(), "only the current thread reports");

    state.stop();
    thread::sleep(interval * 2);
    let stopped = second.polls();
    thread::sleep(interval * 5);
    assert_eq!(second.polls(), stopped, "stopped");
}
