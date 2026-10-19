//! One writer per data folder: the app and the agent CLI (`cli`) never run on the same data at
//! once. An exclusive OS lock on `<data>/livery.lock`, held for the process's life. The file is
//! never deleted: the lock, not the file, is the signal, so a crash leaves nothing stuck.

use std::fs::{File, OpenOptions};
use std::path::Path;

pub const LOCK_FILE: &str = "livery.lock";

/// Held while alive; dropping it (or the process ending) releases the lock.
#[derive(Debug)]
pub struct DataLock {
    _file: File,
}

/// Why the lock wasn't taken.
#[derive(Debug)]
pub enum LockError {
    /// Another process holds it.
    Busy,
    /// The folder or the file can't be opened.
    Io(std::io::Error),
}

impl DataLock {
    pub fn acquire(data_dir: &Path) -> Result<DataLock, LockError> {
        std::fs::create_dir_all(data_dir).map_err(LockError::Io)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(data_dir.join(LOCK_FILE))
            .map_err(LockError::Io)?;
        match file.try_lock() {
            Ok(()) => Ok(DataLock { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(LockError::Busy),
            Err(std::fs::TryLockError::Error(e)) => Err(LockError::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    #[test]
    fn second_holder_is_refused_until_the_first_drops() {
        let dir = TestDir::new("lock-busy");
        let first = DataLock::acquire(dir.path()).unwrap();
        assert!(matches!(DataLock::acquire(dir.path()), Err(LockError::Busy)));
        drop(first);
        assert!(DataLock::acquire(dir.path()).is_ok());
    }

    #[test]
    fn the_file_stays_after_release() {
        let dir = TestDir::new("lock-file");
        drop(DataLock::acquire(dir.path()).unwrap());
        assert!(dir.path().join(LOCK_FILE).is_file());
    }

    #[test]
    fn creates_a_missing_data_dir() {
        let dir = TestDir::new("lock-nested");
        let nested = dir.path().join("a").join("b");
        assert!(DataLock::acquire(&nested).is_ok());
    }
}
