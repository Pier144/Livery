//! One bounded zstd frame, shared by the binary BLK reader and the pack block codec.

use std::io::{self, Read};

/// Unpacks the first zstd frame of `data` (bytes after it are ignored), at most `max` bytes out,
/// with an optional dictionary. The output is read incrementally, so a frame that claims more
/// than `max` is cut off after `max + 1` bytes instead of being allocated.
pub(crate) fn read_frame(data: &[u8], dict: Option<&[u8]>, max: u64) -> io::Result<Vec<u8>> {
    let decoder = match dict {
        Some(dict) => zstd::stream::read::Decoder::with_dictionary(data, dict)?,
        None => zstd::stream::read::Decoder::with_buffer(data)?,
    };
    let mut out = Vec::new();
    decoder.single_frame().take(max.saturating_add(1)).read_to_end(&mut out)?;
    if out.len() as u64 > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unpacks to more than {max} bytes")));
    }
    Ok(out)
}
