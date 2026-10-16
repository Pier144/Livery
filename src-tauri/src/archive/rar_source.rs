//! RAR archives (RAR 1.5–7), listed and checked by Livery ([`super::rar_headers`]) and decoded by
//! the 7-Zip or WinRAR installed on the PC ([`super::rar_tool`]).
//!
//! The archive is listed once when it opens and every entry is checked then (see
//! [`super::unpack`] and the header reader): one volume of a split archive, encrypted headers or
//! files, a link, a dictionary above the cap, or a name that isn't a safe relative path refuses
//! the whole archive, with or without a decoder installed. Without one, opening fails with
//! [`RAR_NEEDS_TOOL`].
//!
//! Data comes in one forward pass per call: the decoder prints every file in archive order, and
//! Livery cuts that stream by the sizes it listed, so the decoder never creates a path or a link
//! on disk. An install reads to the end and then requires the stream to stop exactly there and
//! the decoder to report sound data; a read of a few header bytes (analysis) stops the decoder as
//! soon as it has them.

use super::rar_headers::{self, RarFormat};
use super::rar_tool::{RarTool, RAR_NEEDS_TOOL};
use super::source::{ExtractTick, SkinSource, SourceEntry, SOURCE_GONE};
use super::unpack::{self, Limits, Listing, Staged, Wanted};
use crate::error::{AppError, AppResult, ErrorCode};
use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// A `.rar` file holding one or more skins.
pub struct RarSource {
    path: PathBuf,
    format: RarFormat,
    tool: RarTool,
    entries: Vec<SourceEntry>,
    /// Every file header in archive order (the order of the decoder's output): its size and the
    /// path it takes in the listing (`None` for files left out: Livery's own, repeats, too deep).
    order: Vec<(Option<String>, u64)>,
    limits: Limits,
}

impl RarSource {
    /// Opens and checks the archive at `path` (see the module docs), decoding with the installed
    /// 7-Zip or WinRAR.
    pub fn open(path: &Path, limits: Limits) -> AppResult<Self> {
        Self::open_with(path, limits, RarTool::find())
    }

    /// [`Self::open`] with a given decoder (`None`: as if neither program were installed).
    pub fn open_with(path: &Path, limits: Limits, tool: Option<RarTool>) -> AppResult<Self> {
        let headers = rar_headers::read_headers(path, limits)?;
        let mut listing = Listing::new(limits);
        let mut order = Vec::new();
        for item in headers.items {
            if item.is_dir {
                listing.dir(&item.name)?;
            } else {
                order.push((listing.file(&item.name, item.size)?, item.size));
            }
        }
        let tool = tool.ok_or_else(|| AppError::new(ErrorCode::Unsupported, RAR_NEEDS_TOOL))?;
        Ok(Self { path: path.to_path_buf(), format: headers.format, tool, entries: listing.finish(), order, limits })
    }

    /// The decoder this source uses.
    pub fn tool(&self) -> &RarTool {
        &self.tool
    }

    /// Decodes the archive from the start, handing `each` every listed file `want` accepts with a
    /// reader of exactly its bytes; the rest is read past. `each` returns whether to go on. With
    /// `to_end`, the whole archive is decoded and checked ([`super::rar_tool::Decoder::finish`])
    /// even after `each` has what it needs.
    fn for_each_file(
        &self,
        want: &dyn Fn(&str) -> bool,
        each: &mut dyn FnMut(&str, &mut dyn Read) -> AppResult<bool>,
        to_end: bool,
    ) -> AppResult<()> {
        let mut decoder = self.tool.decode(&self.path, self.format)?;
        let mut going = true;
        for (listed, size) in &self.order {
            let mut part = (&mut decoder).take(*size);
            if let Some(path) = listed.as_deref().filter(|p| going && want(p)) {
                going = each(path, &mut part)?;
            }
            io::copy(&mut part, &mut io::sink()).map_err(|e| unpack::damaged(e.to_string()))?;
            let missing = part.limit();
            if missing != 0 {
                // The output ended early: the decoder's exit code says why.
                decoder.wait_ok()?;
                let name = self.tool.name();
                return Err(unpack::damaged(format!(
                    "{name} stopped {} bytes into a {size}-byte file",
                    size - missing
                )));
            }
            if !going && !to_end {
                return Ok(());
            }
        }
        decoder.finish()
    }
}

impl SkinSource for RarSource {
    fn entries(&self) -> AppResult<Vec<SourceEntry>> {
        Ok(self.entries.clone())
    }

    fn read(&self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        let mut found = self.read_many(&[(path.to_owned(), limit)])?;
        found.remove(path).ok_or_else(|| AppError::new(ErrorCode::NotFound, SOURCE_GONE).with_detail(path.to_owned()))
    }

    fn read_many(&self, paths: &[(String, u64)]) -> AppResult<HashMap<String, Vec<u8>>> {
        let wanted = std::cell::RefCell::new(Wanted::new(paths));
        if paths.is_empty() {
            return Ok(wanted.into_inner().found);
        }
        self.for_each_file(
            &|path| wanted.borrow().limit(path).is_some(),
            &mut |path, reader| {
                let mut wanted = wanted.borrow_mut();
                if let Some(limit) = wanted.limit(path) {
                    let bytes = unpack::read_limited(reader, limit)?;
                    wanted.found.insert(path.to_owned(), bytes);
                }
                Ok(!wanted.done())
            },
            false,
        )?;
        Ok(wanted.into_inner().found)
    }

    fn extract(
        &self,
        root: &str,
        dest: &Path,
        progress: &mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<ExtractTick> {
        let staged = std::cell::RefCell::new(Staged::new(&self.entries, root, dest, self.limits, progress)?);
        if !staged.borrow().done() {
            self.for_each_file(
                &|path| staged.borrow().wanted(path).is_some(),
                &mut |path, reader| {
                    let mut staged = staged.borrow_mut();
                    staged.write(path, reader)?;
                    Ok(!staged.done())
                },
                true,
            )?;
        }
        staged.into_inner().finish()
    }
}
