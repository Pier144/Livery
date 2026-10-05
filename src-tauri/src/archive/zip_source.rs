//! ZIP archives (the `zip` crate: stored, deflate, deflate64, bzip2, zstd, lzma).
//!
//! The central directory is read once when the archive opens and every entry is checked then
//! (see [`super::unpack`]): a name that isn't a safe relative path, a symbolic link, an encrypted
//! entry or a compression method the crate can't decode refuses the whole archive, before
//! anything is written. Files are found again by their index, so reading one never scans.

use super::source::{ExtractTick, SkinSource, SourceEntry, SOURCE_GONE};
use super::unpack::{self, Limits, Listing, Staged, Wanted};
use crate::error::{AppError, AppResult, ErrorCode};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use zip::result::ZipError;
use zip::{CompressionMethod, ZipArchive};

/// A `.zip` file holding one or more skins.
pub struct ZipSource {
    archive: Mutex<ZipArchive<BufReader<File>>>,
    entries: Vec<SourceEntry>,
    /// Listed file path → its index in the archive.
    index: HashMap<String, usize>,
    limits: Limits,
}

impl ZipSource {
    /// Opens and checks the archive at `path` (see the module docs).
    pub fn open(path: &Path, limits: Limits) -> AppResult<Self> {
        let file = File::open(path).map_err(open_error)?;
        let mut archive = ZipArchive::new(BufReader::new(file)).map_err(zip_error)?;
        let mut listing = Listing::new(limits);
        let mut index = HashMap::new();
        for i in 0..archive.len() {
            let entry = archive.by_index_raw(i).map_err(zip_error)?;
            let name = entry.name().to_owned();
            if entry.encrypted() {
                return Err(unpack::encrypted(name));
            }
            if entry.is_symlink() {
                return Err(unpack::link_entry(&name));
            }
            if entry.is_dir() {
                listing.dir(&name)?;
                continue;
            }
            if !decodable(entry.compression()) {
                return Err(unpack::method(format!("{name}: {}", entry.compression())));
            }
            if let Some(listed) = listing.file(&name, entry.size())? {
                index.insert(listed, i);
            }
        }
        Ok(Self { archive: Mutex::new(archive), entries: listing.finish(), index, limits })
    }

    fn lock(&self) -> MutexGuard<'_, ZipArchive<BufReader<File>>> {
        self.archive.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Whether the crate (with the features Livery builds it with) decodes `method`.
#[allow(deprecated)] // `Unsupported(_)` is how the crate reports an unknown method id.
fn decodable(method: CompressionMethod) -> bool {
    !matches!(method, CompressionMethod::Unsupported(_))
}

impl SkinSource for ZipSource {
    fn entries(&self) -> AppResult<Vec<SourceEntry>> {
        Ok(self.entries.clone())
    }

    fn read(&self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        let i = *self
            .index
            .get(path)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, SOURCE_GONE).with_detail(path.to_owned()))?;
        let mut archive = self.lock();
        let mut file = archive.by_index(i).map_err(zip_error)?;
        unpack::read_limited(&mut file, limit)
    }

    fn read_many(&self, paths: &[(String, u64)]) -> AppResult<HashMap<String, Vec<u8>>> {
        let mut wanted = Wanted::new(paths);
        for (path, limit) in paths {
            if wanted.limit(path).is_some() && self.index.contains_key(path) {
                let bytes = self.read(path, *limit)?;
                wanted.found.insert(path.clone(), bytes);
            }
        }
        Ok(wanted.found)
    }

    fn extract(
        &self,
        root: &str,
        dest: &Path,
        progress: &mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<ExtractTick> {
        let mut staged = Staged::new(&self.entries, root, dest, self.limits, progress)?;
        // Archive order: the reads move forward through the file.
        let mut files: Vec<(usize, &str)> = self
            .index
            .iter()
            .filter(|(path, _)| staged.wanted(path).is_some())
            .map(|(p, i)| (*i, p.as_str()))
            .collect();
        files.sort_unstable();
        let mut archive = self.lock();
        for (i, path) in files {
            let mut file = archive.by_index(i).map_err(zip_error)?;
            staged.write(path, &mut file)?;
        }
        staged.finish()
    }
}

fn open_error(e: io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not open the file or folder").with_detail(e.to_string())
}

/// The crate's errors in Livery's words.
fn zip_error(e: ZipError) -> AppError {
    match e {
        ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) => unpack::encrypted(e.to_string()),
        ZipError::UnsupportedArchive(_) => unpack::method(e.to_string()),
        ZipError::InvalidPassword => unpack::encrypted(e.to_string()),
        ZipError::Io(io) => unpack::damaged(io.to_string()),
        other => unpack::damaged(other.to_string()),
    }
}
