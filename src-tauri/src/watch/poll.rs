//! The watcher's decisions, without any I/O: the caller feeds listings, measurements and the
//! time, so tests can drive them poll by poll without sleeping.
//!
//! - [`ArrivalPoller`]: which new entries of the watched folder (skin archives and folders) have
//!   finished arriving. Whatever is there at the first listing is old; a new candidate is ready
//!   once its size is the same at two polls at least [`ArrivalPoller::settle`] apart, is not
//!   empty, and no browser download file (`<name>.part`, `<name>.crdownload`…) sits next to it.
//! - [`HangarPoller`]: whether `UserSkins` changed, from a fingerprint per poll, debounced by one
//!   poll (a burst of changes gives one event) but never held back longer than `max_delay`.

use crate::archive::source::is_archive_name;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// Extensions browsers give a download in progress, next to (or instead of) its final name:
/// Firefox writes `x.zip.part` beside an empty `x.zip`; Chrome and Edge write `x.zip.crdownload`.
pub const DOWNLOAD_IN_PROGRESS: [&str; 5] = ["part", "crdownload", "download", "partial", "opdownload"];

/// What a top-level entry of the watched folder is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
}

/// One top-level entry of the watched folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub name: String,
    pub kind: Kind,
}

impl Listed {
    pub fn file(name: &str) -> Self {
        Self { name: name.to_owned(), kind: Kind::File }
    }

    pub fn dir(name: &str) -> Self {
        Self { name: name.to_owned(), kind: Kind::Dir }
    }
}

/// How big a candidate is: its files and bytes (a file is one file of its length).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Size {
    pub files: u64,
    pub bytes: u64,
}

/// What measuring a candidate found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    Size(Size),
    /// Can't be measured right now (locked by the program writing it, gone mid-walk): try again
    /// at the next poll.
    Retry,
    /// Never a candidate (e.g. a folder with far too many files to be a skin).
    Ignore,
}

/// Whether a new entry may be a skin: a `.zip` / `.rar` / `.7z` file, or a folder that isn't
/// hidden or a system folder (whether it really holds a skin is checked once it is ready).
pub fn is_candidate(entry: &Listed) -> bool {
    match entry.kind {
        Kind::File => is_archive_name(&entry.name),
        Kind::Dir => {
            !entry.name.starts_with(['.', '$'])
                && !entry.name.eq_ignore_ascii_case("__MACOSX")
                && !entry.name.eq_ignore_ascii_case("System Volume Information")
        }
    }
}

/// A new candidate waiting for its size to hold still.
#[derive(Debug, Clone)]
struct Pending {
    kind: Kind,
    /// Size at the last measurement.
    last: Option<Size>,
    /// When `last` was first seen.
    since: Instant,
}

impl Pending {
    fn new(kind: Kind, now: Instant) -> Self {
        Self { kind, last: None, since: now }
    }
}

/// New arrivals in the watched folder (see the module docs).
#[derive(Debug, Clone)]
pub struct ArrivalPoller {
    settle: Duration,
    /// Names present at the previous listing; `None` until a first listing is taken.
    present: Option<HashSet<String>>,
    /// New candidates not ready yet, by name.
    pending: HashMap<String, Pending>,
}

impl ArrivalPoller {
    /// `settle`: how long a candidate's size must stay the same (on top of being the same at two
    /// polls).
    pub fn new(settle: Duration) -> Self {
        Self { settle, present: None, pending: HashMap::new() }
    }

    pub fn settle(&self) -> Duration {
        self.settle
    }

    /// Whether the first listing (what counts as already there) was taken.
    pub fn has_baseline(&self) -> bool {
        self.present.is_some()
    }

    /// Names of the new candidates still waiting, sorted.
    pub fn pending(&self) -> Vec<String> {
        let mut names: Vec<String> = self.pending.keys().cloned().collect();
        names.sort();
        names
    }

    /// Feeds one listing of the watched folder (`None` when it can't be read: nothing changes)
    /// and returns the candidates that finished arriving, in listing order. Each is returned
    /// once; a name that disappears and comes back is new again. `measure` runs only for new
    /// candidates, at most once per poll each.
    pub fn poll(
        &mut self,
        now: Instant,
        listing: Option<&[Listed]>,
        measure: &mut dyn FnMut(&Listed) -> Probe,
    ) -> Vec<Listed> {
        let Some(listing) = listing else { return Vec::new() };
        let names: HashSet<String> = listing.iter().map(|e| e.name.clone()).collect();
        let Some(present) = self.present.replace(names.clone()) else {
            // First listing: everything already there is old.
            return Vec::new();
        };
        self.pending.retain(|name, _| names.contains(name));
        let lower: HashSet<String> = names.iter().map(|n| n.to_lowercase()).collect();
        let downloading = |name: &str| {
            let name = name.to_lowercase();
            DOWNLOAD_IN_PROGRESS.iter().any(|ext| lower.contains(&format!("{name}.{ext}")))
        };

        let mut ready = Vec::new();
        for entry in listing {
            if !present.contains(&entry.name) && is_candidate(entry) {
                self.pending.insert(entry.name.clone(), Pending::new(entry.kind, now));
            }
            let Some(pending) = self.pending.get_mut(&entry.name) else { continue };
            if pending.kind != entry.kind {
                // Replaced by something else under the same name: start over.
                if !is_candidate(entry) {
                    self.pending.remove(&entry.name);
                    continue;
                }
                *pending = Pending::new(entry.kind, now);
            }
            if entry.kind == Kind::File && downloading(&entry.name) {
                pending.last = None;
                continue;
            }
            match measure(entry) {
                Probe::Ignore => {
                    self.pending.remove(&entry.name);
                }
                Probe::Retry => {}
                Probe::Size(size) if pending.last == Some(size) => {
                    if size.bytes > 0 && now.saturating_duration_since(pending.since) >= self.settle {
                        self.pending.remove(&entry.name);
                        ready.push(entry.clone());
                    }
                }
                Probe::Size(size) => {
                    pending.last = Some(size);
                    pending.since = now;
                }
            }
        }
        ready
    }
}

/// One look at `UserSkins`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HangarSnapshot {
    /// Which `UserSkins` (its path key): a different one is a new baseline, not a change.
    pub key: String,
    /// Fingerprint of what is in it.
    pub signature: u64,
}

#[derive(Debug, Clone)]
struct HangarState {
    key: String,
    /// Fingerprint last reported (or the baseline).
    reported: u64,
    /// A different fingerprint seen at the last poll, and when the burst of changes began.
    changing: Option<(u64, Instant)>,
}

/// Changes to `UserSkins` (see the module docs).
#[derive(Debug, Clone)]
pub struct HangarPoller {
    max_delay: Duration,
    state: Option<HangarState>,
}

impl HangarPoller {
    /// `max_delay`: longest a continuous burst of changes can hold the event back.
    pub fn new(max_delay: Duration) -> Self {
        Self { max_delay, state: None }
    }

    /// Feeds one look at `UserSkins` (`None`: no game folder, which forgets the baseline).
    /// Returns true when `hangar://changed` is due: the fingerprint differs from the one last
    /// reported and held still since the previous poll, or has kept changing for `max_delay`.
    pub fn poll(&mut self, now: Instant, snapshot: Option<HangarSnapshot>) -> bool {
        let Some(snapshot) = snapshot else {
            self.state = None;
            return false;
        };
        let state = match &mut self.state {
            Some(state) if state.key == snapshot.key => state,
            _ => {
                self.state = Some(HangarState { key: snapshot.key, reported: snapshot.signature, changing: None });
                return false;
            }
        };
        if snapshot.signature == state.reported {
            // Changed and changed back: nothing to report.
            state.changing = None;
            return false;
        }
        match state.changing {
            Some((last, began))
                if last == snapshot.signature || now.saturating_duration_since(began) >= self.max_delay =>
            {
                state.reported = snapshot.signature;
                state.changing = None;
                true
            }
            Some((_, began)) => {
                state.changing = Some((snapshot.signature, began));
                false
            }
            None => {
                state.changing = Some((snapshot.signature, now));
                false
            }
        }
    }
}
