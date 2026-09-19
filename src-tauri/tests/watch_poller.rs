//! The watcher's pure decisions, driven poll by poll with a fake clock: new arrivals (baseline
//! ignored, size stability across two polls and the settle time, empty and still-downloading
//! files, names that leave and come back, what isn't a candidate), `UserSkins` changes
//! (debounce by one poll, bursts capped by the max delay, a new folder is a new baseline), and
//! which queued items the watcher installs by itself.

use livery_lib::model::{ConflictPolicy, QueueItem, QueueStatus};
use livery_lib::watch::poll::{
    is_candidate, ArrivalPoller, HangarPoller, HangarSnapshot, Kind, Listed, Probe, Size, DOWNLOAD_IN_PROGRESS,
};
use livery_lib::watch::should_auto_install;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const SETTLE: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_secs(2);

/// A watched folder in memory: entries with their current size (`None` = can't be measured).
#[derive(Default)]
struct Folder {
    entries: Vec<(Listed, Option<Probe>)>,
    measured: Vec<String>,
}

impl Folder {
    fn with(entries: &[(Listed, u64)]) -> Self {
        let mut folder = Self::default();
        for (entry, bytes) in entries {
            folder.put(entry.clone(), *bytes);
        }
        folder
    }

    fn put(&mut self, entry: Listed, bytes: u64) {
        self.set(entry, Probe::Size(Size { files: 1, bytes }));
    }

    fn set(&mut self, entry: Listed, probe: Probe) {
        self.entries.retain(|(e, _)| e.name != entry.name);
        self.entries.push((entry, Some(probe)));
    }

    fn remove(&mut self, name: &str) {
        self.entries.retain(|(e, _)| e.name != name);
    }

    fn listing(&self) -> Vec<Listed> {
        self.entries.iter().map(|(e, _)| e.clone()).collect()
    }

    /// One poll; returns the names that finished arriving.
    fn poll(&mut self, poller: &mut ArrivalPoller, now: Instant) -> Vec<String> {
        let listing = self.listing();
        let sizes: HashMap<String, Probe> =
            self.entries.iter().filter_map(|(e, p)| p.map(|p| (e.name.clone(), p))).collect();
        let measured = &mut self.measured;
        poller
            .poll(now, Some(&listing), &mut |entry| {
                measured.push(entry.name.clone());
                sizes.get(&entry.name).copied().unwrap_or(Probe::Retry)
            })
            .into_iter()
            .map(|e| e.name)
            .collect()
    }
}

/// `n` polls after `t0`.
fn at(t0: Instant, n: u32) -> Instant {
    t0 + POLL * n
}

// ── Arrivals ────────────────────────────────────────────────────────────────

#[test]
fn candidates_are_skin_archives_and_visible_folders() {
    for name in ["Tiger.zip", "pack.RAR", "b.7z", "x.Zip"] {
        assert!(is_candidate(&Listed::file(name)), "{name}");
    }
    for name in ["Tiger.zip.crdownload", "notes.txt", "setup.exe", ".zip", "archive.tar.gz"] {
        assert!(!is_candidate(&Listed::file(name)), "{name}");
    }
    for name in ["Winter Tiger", "su-27 desert"] {
        assert!(is_candidate(&Listed::dir(name)), "{name}");
    }
    for name in [".hidden", "$RECYCLE.BIN", "__MACOSX", "System Volume Information"] {
        assert!(!is_candidate(&Listed::dir(name)), "{name}");
    }
    assert!(DOWNLOAD_IN_PROGRESS.contains(&"part") && DOWNLOAD_IN_PROGRESS.contains(&"crdownload"));
}

#[test]
fn files_present_at_the_first_listing_are_ignored() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    let mut folder = Folder::with(&[(Listed::file("old.zip"), 100), (Listed::dir("Old Skin"), 10)]);
    assert!(!poller.has_baseline());
    assert!(folder.poll(&mut poller, t0).is_empty());
    assert!(poller.has_baseline());
    for n in 1..5 {
        assert!(folder.poll(&mut poller, at(t0, n)).is_empty());
    }
    assert!(folder.measured.is_empty(), "old entries are never measured");
    assert!(poller.pending().is_empty());
}

#[test]
fn a_new_file_is_ready_once_its_size_is_stable_across_two_polls() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    let mut folder = Folder::default();
    folder.poll(&mut poller, t0);

    folder.put(Listed::file("Tiger.zip"), 1_000);
    assert!(folder.poll(&mut poller, at(t0, 1)).is_empty(), "first sighting: not yet");
    assert_eq!(poller.pending(), ["Tiger.zip"]);
    folder.put(Listed::file("Tiger.zip"), 5_000);
    assert!(folder.poll(&mut poller, at(t0, 2)).is_empty(), "still growing");
    assert_eq!(folder.poll(&mut poller, at(t0, 3)), ["Tiger.zip"], "same size at two polls");
    assert!(poller.pending().is_empty());
    for n in 4..7 {
        assert!(folder.poll(&mut poller, at(t0, n)).is_empty(), "reported once");
    }
}

#[test]
fn the_settle_time_applies_even_when_polls_come_quickly() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    let mut folder = Folder::default();
    folder.poll(&mut poller, t0);
    folder.put(Listed::file("Tiger.zip"), 1_000);
    folder.poll(&mut poller, t0 + Duration::from_millis(100));
    assert!(folder.poll(&mut poller, t0 + Duration::from_millis(600)).is_empty(), "same size, but only 0.5s");
    assert_eq!(folder.poll(&mut poller, t0 + Duration::from_millis(1_100)), ["Tiger.zip"]);
}

#[test]
fn empty_files_and_downloads_in_progress_wait() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    let mut folder = Folder::default();
    folder.poll(&mut poller, t0);

    // Firefox: an empty placeholder with the final name, the data in `<name>.part`.
    folder.put(Listed::file("Tiger.zip"), 0);
    folder.put(Listed::file("Tiger.zip.part"), 4_000);
    // Chrome: the data in `<name>.crdownload` (not a candidate itself); an old stable file
    // next to a new partial download with the same name waits too.
    folder.put(Listed::file("Pack.zip"), 7_000);
    folder.put(Listed::file("PACK.ZIP.crdownload"), 1_000);
    for n in 1..5 {
        assert!(folder.poll(&mut poller, at(t0, n)).is_empty(), "poll {n}");
    }
    assert_eq!(poller.pending(), ["Pack.zip", "Tiger.zip"]);

    // Downloads finish: the part file is renamed over the placeholder.
    folder.remove("Tiger.zip.part");
    folder.put(Listed::file("Tiger.zip"), 4_000);
    folder.remove("PACK.ZIP.crdownload");
    assert!(folder.poll(&mut poller, at(t0, 5)).is_empty());
    assert_eq!(folder.poll(&mut poller, at(t0, 6)), ["Pack.zip", "Tiger.zip"]);
}

#[test]
fn an_empty_folder_waits_for_its_files() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    let mut folder = Folder::default();
    folder.poll(&mut poller, t0);
    folder.set(Listed::dir("Winter Tiger"), Probe::Size(Size { files: 0, bytes: 0 }));
    for n in 1..4 {
        assert!(folder.poll(&mut poller, at(t0, n)).is_empty());
    }
    folder.set(Listed::dir("Winter Tiger"), Probe::Size(Size { files: 3, bytes: 900 }));
    assert!(folder.poll(&mut poller, at(t0, 4)).is_empty());
    folder.set(Listed::dir("Winter Tiger"), Probe::Size(Size { files: 4, bytes: 900 }));
    assert!(folder.poll(&mut poller, at(t0, 5)).is_empty(), "a new empty file is a change too");
    assert_eq!(folder.poll(&mut poller, at(t0, 6)), ["Winter Tiger"]);
}

#[test]
fn retry_keeps_waiting_and_ignore_drops_the_candidate() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    let mut folder = Folder::default();
    folder.poll(&mut poller, t0);
    folder.set(Listed::file("Locked.zip"), Probe::Retry);
    folder.set(Listed::dir("Huge Folder"), Probe::Ignore);
    assert!(folder.poll(&mut poller, at(t0, 1)).is_empty());
    assert_eq!(poller.pending(), ["Locked.zip"], "ignored for good");
    assert!(folder.poll(&mut poller, at(t0, 2)).is_empty());
    folder.measured.clear();
    folder.poll(&mut poller, at(t0, 3));
    assert_eq!(folder.measured, ["Locked.zip"], "the ignored folder is not measured again");

    // The lock goes away.
    folder.put(Listed::file("Locked.zip"), 50);
    folder.poll(&mut poller, at(t0, 4));
    assert_eq!(folder.poll(&mut poller, at(t0, 5)), ["Locked.zip"]);
}

#[test]
fn a_name_that_leaves_and_comes_back_is_new_again() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    let mut folder = Folder::with(&[(Listed::file("Tiger.zip"), 10)]);
    folder.poll(&mut poller, t0);
    folder.remove("Tiger.zip");
    folder.poll(&mut poller, at(t0, 1));
    folder.put(Listed::file("Tiger.zip"), 10);
    folder.poll(&mut poller, at(t0, 2));
    assert_eq!(folder.poll(&mut poller, at(t0, 3)), ["Tiger.zip"], "downloaded again");

    // A pending arrival that disappears is forgotten.
    folder.put(Listed::file("Gone.zip"), 10);
    folder.poll(&mut poller, at(t0, 4));
    folder.remove("Gone.zip");
    folder.poll(&mut poller, at(t0, 5));
    assert!(poller.pending().is_empty());
}

#[test]
fn a_new_entry_replaced_by_another_kind_starts_over() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    let mut folder = Folder::default();
    folder.poll(&mut poller, t0);
    folder.put(Listed::file("Tiger"), 10);
    folder.poll(&mut poller, at(t0, 1));
    assert!(poller.pending().is_empty(), "a file without an archive extension is not a candidate");

    // A folder that happens to be named like an archive, replaced by the archive itself.
    folder.set(Listed::dir("Skin.zip"), Probe::Size(Size { files: 1, bytes: 20 }));
    folder.poll(&mut poller, at(t0, 2));
    folder.put(Listed::file("Skin.zip"), 20);
    assert!(folder.poll(&mut poller, at(t0, 3)).is_empty(), "kind changed: measured afresh");
    assert_eq!(folder.poll(&mut poller, at(t0, 4)), ["Skin.zip"]);
}

#[test]
fn an_unreadable_folder_changes_nothing_and_defers_the_baseline() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    assert!(poller.poll(t0, None, &mut |_| Probe::Retry).is_empty());
    assert!(!poller.has_baseline(), "the baseline is the first listing that could be read");

    let mut folder = Folder::with(&[(Listed::file("already.zip"), 10)]);
    folder.poll(&mut poller, at(t0, 1));
    folder.put(Listed::file("new.zip"), 10);
    folder.poll(&mut poller, at(t0, 2));
    assert!(poller.poll(at(t0, 3), None, &mut |_| Probe::Retry).is_empty(), "read error: skipped");
    assert_eq!(folder.poll(&mut poller, at(t0, 4)), ["new.zip"]);
}

#[test]
fn non_candidates_are_never_measured() {
    let t0 = Instant::now();
    let mut poller = ArrivalPoller::new(SETTLE);
    let mut folder = Folder::default();
    folder.poll(&mut poller, t0);
    folder.put(Listed::file("movie.mkv"), 10);
    folder.put(Listed::file("Tiger.zip.crdownload"), 10);
    folder.put(Listed::dir(".cache"), 10);
    for n in 1..4 {
        assert!(folder.poll(&mut poller, at(t0, n)).is_empty());
    }
    assert!(folder.measured.is_empty());
    assert_eq!(Listed::file("a").kind, Kind::File);
}

// ── UserSkins changes ───────────────────────────────────────────────────────

fn look(key: &str, signature: u64) -> Option<HangarSnapshot> {
    Some(HangarSnapshot { key: key.to_owned(), signature })
}

#[test]
fn the_first_look_is_a_baseline_and_a_change_is_reported_once_it_holds_still() {
    let t0 = Instant::now();
    let mut poller = HangarPoller::new(Duration::from_secs(10));
    assert!(!poller.poll(t0, look("us", 1)), "baseline");
    assert!(!poller.poll(at(t0, 1), look("us", 1)));
    assert!(!poller.poll(at(t0, 2), look("us", 2)), "debounced one poll");
    assert!(poller.poll(at(t0, 3), look("us", 2)), "held still: changed");
    assert!(!poller.poll(at(t0, 4), look("us", 2)), "reported once");
}

#[test]
fn a_burst_of_changes_gives_one_event() {
    let t0 = Instant::now();
    let mut poller = HangarPoller::new(Duration::from_secs(10));
    poller.poll(t0, look("us", 1));
    let mut events = 0;
    for (n, signature) in [2, 3, 4, 4, 4].into_iter().enumerate() {
        events += u32::from(poller.poll(at(t0, n as u32 + 1), look("us", signature)));
    }
    assert_eq!(events, 1);
}

#[test]
fn a_change_that_keeps_going_is_reported_after_the_max_delay() {
    let t0 = Instant::now();
    let mut poller = HangarPoller::new(Duration::from_secs(10));
    poller.poll(t0, look("us", 0));
    let fired: Vec<u32> = (1..=12).filter(|&n| poller.poll(at(t0, n), look("us", u64::from(n)))).collect();
    // Changing since poll 1 (t=2s): due at t >= 12s, i.e. poll 6; a new burst from poll 7 (t=14s)
    // is due at t >= 24s, i.e. poll 12.
    assert_eq!(fired, [6, 12]);
}

#[test]
fn a_change_undone_before_the_next_poll_is_not_reported() {
    let t0 = Instant::now();
    let mut poller = HangarPoller::new(Duration::from_secs(10));
    poller.poll(t0, look("us", 1));
    assert!(!poller.poll(at(t0, 1), look("us", 2)));
    assert!(!poller.poll(at(t0, 2), look("us", 1)));
    assert!(!poller.poll(at(t0, 3), look("us", 1)));
}

#[test]
fn another_user_skins_folder_or_none_is_a_new_baseline() {
    let t0 = Instant::now();
    let mut poller = HangarPoller::new(Duration::from_secs(10));
    poller.poll(t0, look("a", 1));
    assert!(!poller.poll(at(t0, 1), look("b", 7)), "game folder changed: new baseline");
    assert!(!poller.poll(at(t0, 2), look("b", 7)));
    assert!(!poller.poll(at(t0, 3), None), "no game folder");
    assert!(!poller.poll(at(t0, 4), look("b", 9)), "baseline again");
    assert!(!poller.poll(at(t0, 5), look("b", 9)));
}

// ── Auto-install ────────────────────────────────────────────────────────────

fn item(status: QueueStatus, conflict_with: Option<&str>) -> QueueItem {
    QueueItem {
        id: "q-1".into(),
        path: "C:\\Downloads\\Tiger".into(),
        file_name: "Tiger".into(),
        size_bytes: 10,
        status,
        vehicle: None,
        candidates: Vec::new(),
        conflict_with: conflict_with.map(str::to_owned),
        target_folder: Some("Tiger".into()),
        files: Vec::new(),
        texture_count: None,
        blk_ok: None,
        note: None,
        error: None,
    }
}

#[test]
fn ready_items_install_and_conflicts_follow_the_policy_but_never_ask() {
    use ConflictPolicy::*;
    for policy in [Ask, Replace, Copy, Skip] {
        assert!(should_auto_install(&item(QueueStatus::Ready, None), policy), "{policy:?}");
        let installed = item(QueueStatus::Conflict, Some("s-123"));
        assert_eq!(should_auto_install(&installed, policy), policy != Ask, "{policy:?}");
        let on_disk = item(QueueStatus::Conflict, Some("disk:Tiger"));
        assert_eq!(should_auto_install(&on_disk, policy), policy != Ask, "{policy:?}");
        let queued = item(QueueStatus::Conflict, Some("queue:q-0"));
        assert!(!should_auto_install(&queued, policy), "waits for the other queued item ({policy:?})");
        for status in [QueueStatus::NeedsLook, QueueStatus::Error, QueueStatus::Installing, QueueStatus::Done] {
            assert!(!should_auto_install(&item(status, None), policy), "{status:?} {policy:?}");
        }
    }
}
