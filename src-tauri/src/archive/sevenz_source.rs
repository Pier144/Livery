//! 7z archives (the `sevenz-rust2` crate: LZMA, LZMA2, PPMd, BZip2, Deflate, BCJ filters…).
//!
//! The header is read once when the archive opens and every entry is checked then (see
//! [`super::unpack`]): an encrypted header or encrypted data, a link, a name that isn't a safe
//! relative path, or a dictionary too big to allocate refuses the whole archive. Data is decoded
//! in one forward pass per call (a solid archive can't jump to a file); the crate checks each
//! file's CRC and the writer checks its length.
//!
//! The crate decodes a compressed ("encoded") header into memory before Livery sees any entry,
//! so [`check_header`] reads that header's description first and refuses one that would unpack
//! to more than [`MAX_HEADER_BYTES`] or needs too big a dictionary (a header bomb).

use super::source::{ExtractTick, SkinSource, SourceEntry, SOURCE_GONE};
use super::unpack::{self, Limits, Listing, Staged, Wanted, MAX_DICTIONARY_BYTES, REPARSE_POINT};
use crate::error::{AppError, AppResult, ErrorCode};
use sevenz_rust2::{Archive, ArchiveEntry, BlockDecoder, EncoderMethod, Error as SevenZError, Password};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 7-Zip's marker that the high 16 bits of the Windows attributes hold a Unix mode.
const UNIX_EXTENSION: u32 = 0x8000;

/// Most a compressed 7z header may unpack to. A header holds a few dozen bytes per entry, so even
/// [`super::source::MAX_ENTRIES`] entries with long names stay far below this.
pub const MAX_HEADER_BYTES: u64 = 64 * 1024 * 1024;

/// Memory the dictionaries of one block's decoding threads may take together: a multi-threaded
/// LZMA2 decoder gives every thread its own dictionary.
const THREAD_DICTIONARY_BUDGET: u64 = 512 * 1024 * 1024;

/// A `.7z` file holding one or more skins.
pub struct SevenZSource {
    path: PathBuf,
    archive: Archive,
    entries: Vec<SourceEntry>,
    /// Name as the archive spells it → listed file path (first entry of that name only).
    listed: HashMap<String, String>,
    limits: Limits,
}

impl SevenZSource {
    /// Opens and checks the archive at `path` (see the module docs).
    pub fn open(path: &Path, limits: Limits) -> AppResult<Self> {
        let mut file = BufReader::new(File::open(path).map_err(open_error)?);
        check_header(&mut file)?;
        let archive = Archive::read(&mut file, &Password::empty()).map_err(sevenz_error)?;
        check_coders(&archive)?;
        let mut listing = Listing::new(limits);
        let mut listed = HashMap::new();
        for entry in &archive.files {
            if entry.is_anti_item {
                continue;
            }
            if is_link(entry.has_windows_attributes, entry.windows_attributes) {
                return Err(unpack::link_entry(&entry.name));
            }
            if entry.is_directory {
                listing.dir(&entry.name)?;
                continue;
            }
            if let Some(path) = listing.file(&entry.name, entry.size)? {
                listed.entry(entry.name.clone()).or_insert(path);
            }
        }
        Ok(Self { path: path.to_path_buf(), archive, entries: listing.finish(), listed, limits })
    }

    /// Decodes the archive from the start, block by block, handing `each` every file entry with
    /// its listed path (entries that aren't listed are skipped). `each` returns whether to go on;
    /// once it says stop, no further block is even opened.
    fn for_each_file(&self, each: &mut dyn FnMut(&str, &mut dyn Read) -> AppResult<bool>) -> AppResult<()> {
        let mut file = BufReader::new(File::open(&self.path).map_err(open_error)?);
        let password = Password::empty();
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get()).min(8) as u64;
        let mut stopped: Option<AppError> = None;
        let mut visit = |entry: &ArchiveEntry, data: &mut dyn Read| -> Result<bool, SevenZError> {
            let path = (!entry.is_directory && !entry.is_anti_item).then(|| self.listed.get(&entry.name)).flatten();
            let go_on = match path.map(|path| each(path, data)) {
                None | Some(Ok(true)) => true,
                Some(Ok(false)) => false,
                Some(Err(e)) => {
                    stopped = Some(e);
                    return Err(SevenZError::Other("stopped".into()));
                }
            };
            // In a solid block the next file's data follows this one's in the same stream: what
            // wasn't read must be read past (the crate checks its CRC on the way).
            if go_on {
                io::copy(data, &mut io::sink())?;
            }
            Ok(go_on)
        };
        let mut result = Ok(true);
        for block in 0..self.archive.blocks.len() {
            let dictionary = self.archive.blocks[block]
                .coders
                .iter()
                .filter_map(|c| dictionary_size(c.encoder_method_id(), c.properties()))
                .max()
                .unwrap_or(0);
            let threads = (THREAD_DICTIONARY_BUDGET / dictionary.max(1)).clamp(1, cores) as u32;
            result =
                BlockDecoder::new(threads, block, &self.archive, &password, &mut file).for_each_entries(&mut visit);
            if !matches!(result, Ok(true)) {
                break;
            }
        }
        // Empty files have no data, so no block.
        if matches!(result, Ok(true)) {
            for entry in self.archive.files.iter().filter(|e| !e.has_stream && !e.is_directory) {
                result = visit(entry, &mut io::empty());
                if !matches!(result, Ok(true)) {
                    break;
                }
            }
        }
        match (stopped, result) {
            (Some(e), _) => Err(e),
            (None, Err(e)) => Err(sevenz_error(e)),
            (None, Ok(_)) => Ok(()),
        }
    }
}

/// A link: Windows' reparse-point attribute, or a Unix mode of type link behind 7-Zip's marker.
fn is_link(has_attributes: bool, attributes: u32) -> bool {
    has_attributes
        && (attributes & REPARSE_POINT != 0
            || (attributes & UNIX_EXTENSION != 0 && unpack::is_link_mode(attributes >> 16)))
}

/// Refuses encrypted data (the header was readable) and coders that would allocate more than
/// [`MAX_DICTIONARY_BYTES`] before decoding a byte.
fn check_coders(archive: &Archive) -> AppResult<()> {
    for coder in archive.blocks.iter().flat_map(|b| b.coders.iter()) {
        let id = coder.encoder_method_id();
        if id == EncoderMethod::ID_AES256_SHA256 {
            return Err(unpack::encrypted("AES-256 encrypted data"));
        }
        check_dictionary(id, coder.properties())?;
    }
    Ok(())
}

/// [`ARCHIVE_METHOD`](unpack::ARCHIVE_METHOD) when the coder `id` with `props` needs more than
/// [`MAX_DICTIONARY_BYTES`].
fn check_dictionary(id: &[u8], props: &[u8]) -> AppResult<()> {
    match dictionary_size(id, props) {
        Some(bytes) if bytes > MAX_DICTIONARY_BYTES => Err(unpack::method(format!("needs a {bytes}-byte dictionary"))),
        _ => Ok(()),
    }
}

/// The dictionary (or PPMd model) a coder allocates before decoding, when it has one.
fn dictionary_size(id: &[u8], props: &[u8]) -> Option<u64> {
    if id == EncoderMethod::ID_LZMA2 {
        props.first().map(|&bits| lzma2_dictionary(bits))
    } else if id == EncoderMethod::ID_LZMA || id == EncoderMethod::ID_PPMD {
        props.get(1..5).map(|b| u64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])))
    } else {
        None
    }
}

/// 7z signature.
const SIGNATURE: &[u8] = b"7z\xBC\xAF\x27\x1C";
/// Property ids of the 7z header (7-Zip's `7zFormat.txt`).
const K_END: u8 = 0x00;
const K_PACK_INFO: u8 = 0x06;
const K_UNPACK_INFO: u8 = 0x07;
const K_SIZE: u8 = 0x09;
const K_CRC: u8 = 0x0A;
const K_FOLDER: u8 = 0x0B;
const K_CODERS_UNPACK_SIZE: u8 = 0x0C;
const K_ENCODED_HEADER: u8 = 0x17;
/// An encoded header's description is a few dozen bytes.
const MAX_DESCRIPTION_BYTES: u64 = 64 * 1024;

/// Reads the description of a compressed 7z header (where it is packed, its coders, the size it
/// unpacks to) and refuses it when it would unpack to more than [`MAX_HEADER_BYTES`]
/// ([`ARCHIVE_TOO_BIG`](unpack::ARCHIVE_TOO_BIG)) or needs a dictionary above
/// [`MAX_DICTIONARY_BYTES`]. An unfinished archive (its start header all zeros, which makes the
/// crate guess where the header is) is [`ARCHIVE_DAMAGED`](unpack::ARCHIVE_DAMAGED). Anything else
/// the crate refuses itself (bad signature, offsets beyond the file, checksums), so it is let
/// through. Leaves `file` at an unspecified position.
pub fn check_header<R: Read + Seek>(file: &mut R) -> AppResult<()> {
    let damaged = |e: io::Error| unpack::damaged(e.to_string());
    let len = file.seek(SeekFrom::End(0)).map_err(damaged)?;
    file.seek(SeekFrom::Start(0)).map_err(damaged)?;
    let mut start = [0u8; 32];
    if len < start.len() as u64 {
        return Ok(());
    }
    file.read_exact(&mut start).map_err(damaged)?;
    if &start[..6] != SIGNATURE {
        return Ok(());
    }
    if start[8..].iter().all(|&b| b == 0) {
        return Err(unpack::damaged("unfinished 7z archive (no start header)"));
    }
    let le = |b: &[u8]| u64::from_le_bytes(b.try_into().unwrap_or_default());
    let (offset, size) = (le(&start[12..20]), le(&start[20..28]));
    let Some(at) = offset.checked_add(start.len() as u64).filter(|&at| at < len) else { return Ok(()) };
    let mut description = Vec::new();
    file.seek(SeekFrom::Start(at)).map_err(damaged)?;
    file.take(size.min(MAX_DESCRIPTION_BYTES)).read_to_end(&mut description).map_err(damaged)?;
    if description.first() != Some(&K_ENCODED_HEADER) {
        return Ok(());
    }
    let mut header = HeaderBytes { bytes: &description, at: 1 };
    let folders = header.streams_info().ok_or_else(|| unpack::damaged("unreadable 7z header description"))?;
    for folder in &folders {
        for (id, props) in &folder.coders {
            check_dictionary(id, props)?;
        }
        if let Some(&bytes) = folder.unpack_sizes.iter().max().filter(|&&n| n > MAX_HEADER_BYTES) {
            return Err(unpack::too_big(format!("a {bytes}-byte 7z header")));
        }
    }
    Ok(())
}

/// One folder (block) of a 7z streams description: its coders (`id`, properties) and the sizes
/// of their outputs.
struct Folder<'a> {
    coders: Vec<(&'a [u8], &'a [u8])>,
    unpack_sizes: Vec<u64>,
}

/// A cursor over 7z header bytes, read as the crate reads them; `None` when they run out or don't
/// follow the format.
struct HeaderBytes<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> HeaderBytes<'a> {
    fn byte(&mut self) -> Option<u8> {
        let b = *self.bytes.get(self.at)?;
        self.at += 1;
        Some(b)
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let bytes = self.bytes.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(bytes)
    }

    /// 7z's variable-length number: the high bits of the first byte say how many follow.
    fn number(&mut self) -> Option<u64> {
        let first = u64::from(self.byte()?);
        let mut mask = 0x80u64;
        let mut value = 0u64;
        for i in 0..8 {
            if first & mask == 0 {
                return Some(value | ((first & (mask - 1)) << (8 * i)));
            }
            value |= u64::from(self.byte()?) << (8 * i);
            mask >>= 1;
        }
        Some(value)
    }

    /// A count; each counted item takes at least a byte, so more than the bytes left is wrong.
    fn count(&mut self) -> Option<usize> {
        usize::try_from(self.number()?).ok().filter(|&n| n <= self.bytes.len())
    }

    /// "All defined" byte, else a bit field of `n` bits; returns how many are set.
    fn defined(&mut self, n: usize) -> Option<usize> {
        if self.byte()? != 0 {
            return Some(n);
        }
        let bits = self.take(n.div_ceil(8))?;
        Some(bits.iter().map(|b| b.count_ones() as usize).sum::<usize>().min(n))
    }

    /// `PackInfo`, then `UnpackInfo` (whatever follows isn't needed).
    fn streams_info(&mut self) -> Option<Vec<Folder<'a>>> {
        let mut id = self.byte()?;
        if id == K_PACK_INFO {
            let _pack_pos = self.number()?;
            let streams = self.count()?;
            id = self.byte()?;
            if id == K_SIZE {
                for _ in 0..streams {
                    self.number()?;
                }
                id = self.byte()?;
            }
            if id == K_CRC {
                let defined = self.defined(streams)?;
                self.take(defined.checked_mul(4)?)?;
                id = self.byte()?;
            }
            if id != K_END {
                return None;
            }
            id = self.byte()?;
        }
        if id != K_UNPACK_INFO {
            return Some(Vec::new());
        }
        if self.byte()? != K_FOLDER {
            return None;
        }
        let count = self.count()?;
        if self.byte()? != 0 {
            return None; // "external" folders: the crate refuses them too
        }
        let mut folders = Vec::with_capacity(count);
        let mut outputs = Vec::with_capacity(count);
        for _ in 0..count {
            let (folder, total_out) = self.folder()?;
            folders.push(folder);
            outputs.push(total_out);
        }
        if self.byte()? != K_CODERS_UNPACK_SIZE {
            return None;
        }
        for (folder, total_out) in folders.iter_mut().zip(outputs) {
            for _ in 0..total_out {
                folder.unpack_sizes.push(self.number()?);
            }
        }
        Some(folders)
    }

    /// One folder: its coders, then bind pairs and packed streams; returns the folder and the
    /// number of outputs of its coders.
    fn folder(&mut self) -> Option<(Folder<'a>, usize)> {
        let count = self.count()?;
        let mut coders = Vec::with_capacity(count);
        let (mut total_in, mut total_out) = (0usize, 0usize);
        for _ in 0..count {
            let flags = self.byte()?;
            if flags & 0x80 != 0 {
                return None; // alternative methods: the crate refuses them too
            }
            let id = self.take(usize::from(flags & 0x0f))?;
            let (ins, outs) = if flags & 0x10 == 0 { (1, 1) } else { (self.count()?, self.count()?) };
            total_in = total_in.checked_add(ins).filter(|&n| n <= self.bytes.len())?;
            total_out = total_out.checked_add(outs).filter(|&n| n <= self.bytes.len())?;
            let props = if flags & 0x20 != 0 {
                let n = self.count()?;
                self.take(n)?
            } else {
                &[]
            };
            coders.push((id, props));
        }
        let bind_pairs = total_out.checked_sub(1)?;
        for _ in 0..bind_pairs {
            self.number()?;
            self.number()?;
        }
        let packed = total_in.checked_sub(bind_pairs)?;
        if packed > 1 {
            for _ in 0..packed {
                self.number()?;
            }
        }
        Some((Folder { coders, unpack_sizes: Vec::new() }, total_out))
    }
}

/// LZMA2's one-byte dictionary size (7-Zip's encoding; 40 = 4 GiB − 1, above is invalid).
fn lzma2_dictionary(bits: u8) -> u64 {
    match bits {
        0..=39 => u64::from(2 | (bits & 1)) << (bits / 2 + 11),
        _ => u64::from(u32::MAX),
    }
}

impl SkinSource for SevenZSource {
    fn entries(&self) -> AppResult<Vec<SourceEntry>> {
        Ok(self.entries.clone())
    }

    fn read(&self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        let mut found = self.read_many(&[(path.to_owned(), limit)])?;
        found.remove(path).ok_or_else(|| AppError::new(ErrorCode::NotFound, SOURCE_GONE).with_detail(path.to_owned()))
    }

    fn read_many(&self, paths: &[(String, u64)]) -> AppResult<HashMap<String, Vec<u8>>> {
        let mut wanted = Wanted::new(paths);
        if paths.is_empty() {
            return Ok(wanted.found);
        }
        self.for_each_file(&mut |path, data| {
            if let Some(limit) = wanted.limit(path) {
                let bytes = unpack::read_limited(data, limit)?;
                wanted.found.insert(path.to_owned(), bytes);
            }
            Ok(!wanted.done())
        })?;
        Ok(wanted.found)
    }

    fn extract(
        &self,
        root: &str,
        dest: &Path,
        progress: &mut dyn FnMut(ExtractTick) -> AppResult<()>,
    ) -> AppResult<ExtractTick> {
        let mut staged = Staged::new(&self.entries, root, dest, self.limits, progress)?;
        if !staged.done() {
            self.for_each_file(&mut |path, data| {
                staged.write(path, data)?;
                Ok(!staged.done())
            })?;
        }
        staged.finish()
    }
}

fn open_error(e: io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not open the file or folder").with_detail(e.to_string())
}

/// The crate's errors in Livery's words.
fn sevenz_error(e: SevenZError) -> AppError {
    let detail = e.to_string();
    match e {
        SevenZError::PasswordRequired | SevenZError::MaybeBadPassword(_) => unpack::encrypted(detail),
        SevenZError::BadSignature(_) => unpack::not_an_archive(detail),
        SevenZError::UnsupportedCompressionMethod(_)
        | SevenZError::ExternalUnsupported
        | SevenZError::Unsupported(_)
        | SevenZError::MaxMemLimited { .. } => unpack::method(detail),
        _ => unpack::damaged(detail),
    }
}
