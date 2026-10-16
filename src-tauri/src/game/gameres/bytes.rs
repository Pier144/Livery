//! Bounds-checked little-endian reads over a byte slice. Every read that would run past the end
//! (or overflow `usize`) is a `parse` error, so a damaged pack can never panic the reader.

use super::bad;
use crate::error::AppResult;

/// Longest NUL-terminated string [`Reader::cstr`] accepts, terminator excluded.
pub const MAX_CSTR: usize = 4096;

/// A cursor over a byte slice: absolute reads (`*_at`) leave the position alone, sequential
/// reads (`u32`, `take`…) advance it.
#[derive(Debug, Clone, Copy)]
pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// The current position.
    pub fn pos(&self) -> usize {
        self.pos
    }

    /// Bytes left after the current position.
    pub fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }

    /// Moves to `at`, which may be the end of the data but not beyond it.
    pub fn seek(&mut self, at: usize) -> AppResult<()> {
        if at > self.data.len() {
            return Err(bad(format!("seek to {at} past the end ({})", self.data.len())));
        }
        self.pos = at;
        Ok(())
    }

    /// Moves forward by `len` bytes.
    pub fn skip(&mut self, len: usize) -> AppResult<()> {
        self.take(len).map(|_| ())
    }

    /// `len` bytes at `at`.
    pub fn slice(&self, at: usize, len: usize) -> AppResult<&'a [u8]> {
        at.checked_add(len)
            .and_then(|end| self.data.get(at..end))
            .ok_or_else(|| bad(format!("{len} bytes at {at} run past the end ({})", self.data.len())))
    }

    fn array<const N: usize>(&self, at: usize) -> AppResult<[u8; N]> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.slice(at, N)?);
        Ok(out)
    }

    pub fn u8_at(&self, at: usize) -> AppResult<u8> {
        self.array::<1>(at).map(|b| b[0])
    }

    pub fn u16_at(&self, at: usize) -> AppResult<u16> {
        self.array(at).map(u16::from_le_bytes)
    }

    pub fn u32_at(&self, at: usize) -> AppResult<u32> {
        self.array(at).map(u32::from_le_bytes)
    }

    pub fn i32_at(&self, at: usize) -> AppResult<i32> {
        self.array(at).map(i32::from_le_bytes)
    }

    pub fn u64_at(&self, at: usize) -> AppResult<u64> {
        self.array(at).map(u64::from_le_bytes)
    }

    pub fn f32_at(&self, at: usize) -> AppResult<f32> {
        self.array(at).map(f32::from_le_bytes)
    }

    /// The NUL-terminated string at `at` (lossy UTF-8), at most [`MAX_CSTR`] bytes long.
    pub fn cstr(&self, at: usize) -> AppResult<String> {
        let tail =
            self.data.get(at..).ok_or_else(|| bad(format!("string at {at} past the end ({})", self.data.len())))?;
        let window = &tail[..tail.len().min(MAX_CSTR + 1)];
        let end = window.iter().position(|&b| b == 0).ok_or_else(|| bad(format!("string at {at} has no end")))?;
        Ok(String::from_utf8_lossy(&window[..end]).into_owned())
    }

    /// A 16-byte PatchableTab at `at`: `(offset, count)`. The offset is relative to the base the
    /// structure names; the caller bounds-checks the range it implies.
    pub fn tab(&self, at: usize) -> AppResult<(u32, u32)> {
        Ok((self.u32_at(at)?, self.u32_at(at.checked_add(4).ok_or_else(|| bad("tab offset overflows"))?)?))
    }

    /// `len` bytes at the current position.
    pub fn take(&mut self, len: usize) -> AppResult<&'a [u8]> {
        let out = self.slice(self.pos, len)?;
        self.pos += len;
        Ok(out)
    }

    pub fn u8(&mut self) -> AppResult<u8> {
        self.take(1).map(|b| b[0])
    }

    pub fn u16(&mut self) -> AppResult<u16> {
        let v = self.u16_at(self.pos)?;
        self.pos += 2;
        Ok(v)
    }

    pub fn u32(&mut self) -> AppResult<u32> {
        let v = self.u32_at(self.pos)?;
        self.pos += 4;
        Ok(v)
    }

    pub fn i32(&mut self) -> AppResult<i32> {
        let v = self.i32_at(self.pos)?;
        self.pos += 4;
        Ok(v)
    }

    pub fn u64(&mut self) -> AppResult<u64> {
        let v = self.u64_at(self.pos)?;
        self.pos += 8;
        Ok(v)
    }

    pub fn f32(&mut self) -> AppResult<f32> {
        let v = self.f32_at(self.pos)?;
        self.pos += 4;
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn is_parse<T: std::fmt::Debug>(r: AppResult<T>) -> bool {
        r.is_err_and(|e| e.code == ErrorCode::Parse)
    }

    #[test]
    fn reads_every_width_little_endian() {
        let mut data = vec![0xAB, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0xFF, 0xFF, 0xFF, 0xFF];
        data.extend_from_slice(&0x0123_4567_89AB_CDEFu64.to_le_bytes());
        data.extend_from_slice(&1.5f32.to_le_bytes());
        let mut r = Reader::new(&data);
        assert_eq!(r.u8().unwrap(), 0xAB);
        assert_eq!(r.u16().unwrap(), 0x1234);
        assert_eq!(r.u32().unwrap(), 0x1234_5678);
        assert_eq!(r.i32().unwrap(), -1);
        assert_eq!(r.u64().unwrap(), 0x0123_4567_89AB_CDEF);
        assert_eq!(r.f32().unwrap(), 1.5);
        assert_eq!((r.pos(), r.remaining()), (data.len(), 0));
        assert_eq!(r.u8_at(0).unwrap(), 0xAB);
        assert_eq!(r.u16_at(1).unwrap(), 0x1234);
        assert_eq!(r.u32_at(3).unwrap(), 0x1234_5678);
        assert_eq!(r.i32_at(7).unwrap(), -1);
        assert_eq!(r.u64_at(11).unwrap(), 0x0123_4567_89AB_CDEF);
        assert_eq!(r.f32_at(19).unwrap(), 1.5);
        assert_eq!(r.pos(), data.len(), "absolute reads leave the position alone");
    }

    #[test]
    fn a_read_ending_exactly_at_the_end_works_one_byte_further_fails() {
        let data = [1u8, 2, 3, 4];
        let mut r = Reader::new(&data);
        assert_eq!(r.u32_at(0).unwrap(), 0x0403_0201);
        assert!(is_parse(r.u32_at(1)), "one byte past the end");
        assert!(is_parse(r.u32_at(4)));
        assert_eq!(r.slice(4, 0).unwrap(), &[] as &[u8], "an empty slice at the end is fine");
        assert!(is_parse(r.slice(5, 0)));
        assert_eq!(r.u8_at(3).unwrap(), 4);
        assert!(is_parse(r.u8_at(4)));
        // A failed sequential read leaves the position where it was.
        r.seek(2).unwrap();
        assert!(is_parse(r.u32()));
        assert_eq!(r.pos(), 2);
        assert_eq!(r.u16().unwrap(), 0x0403);
        assert!(is_parse(r.u8()));
    }

    #[test]
    fn offsets_that_overflow_are_errors_not_panics() {
        let data = [0u8; 16];
        let mut r = Reader::new(&data);
        assert!(is_parse(r.slice(usize::MAX, 2)));
        assert!(is_parse(r.slice(2, usize::MAX)));
        assert!(is_parse(r.u32_at(usize::MAX)));
        assert!(is_parse(r.u64_at(usize::MAX - 3)));
        assert!(is_parse(r.cstr(usize::MAX)));
        assert!(is_parse(r.tab(usize::MAX)));
        assert!(is_parse(r.tab(usize::MAX - 2)));
        assert!(is_parse(r.take(usize::MAX)));
        assert!(is_parse(r.skip(17)));
        assert!(is_parse(r.seek(17)));
        r.seek(16).unwrap();
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn cstr_stops_at_the_nul_and_is_lossy() {
        let data = b"abc\0d\xFFe\0tail";
        let r = Reader::new(data);
        assert_eq!(r.cstr(0).unwrap(), "abc");
        assert_eq!(r.cstr(4).unwrap(), "d\u{FFFD}e");
        assert_eq!(r.cstr(3).unwrap(), "", "an empty string");
        assert!(is_parse(r.cstr(8)), "no terminator before the end");
        assert!(is_parse(r.cstr(data.len())));
        assert!(is_parse(r.cstr(data.len() + 1)));
    }

    #[test]
    fn cstr_is_capped_at_4096_bytes() {
        let mut data = vec![b'a'; MAX_CSTR];
        data.push(0);
        assert_eq!(Reader::new(&data).cstr(0).unwrap().len(), MAX_CSTR);
        let mut long = vec![b'a'; MAX_CSTR + 1];
        long.push(0);
        assert!(is_parse(Reader::new(&long).cstr(0)));
    }

    #[test]
    fn tab_reads_offset_and_count() {
        let mut data = Vec::new();
        data.extend_from_slice(&0x40u32.to_le_bytes());
        data.extend_from_slice(&7u32.to_le_bytes());
        data.extend_from_slice(&[0u8; 8]);
        let r = Reader::new(&data);
        assert_eq!(r.tab(0).unwrap(), (0x40, 7));
        assert!(is_parse(r.tab(9)), "the count runs past the end");
        assert!(is_parse(Reader::new(&data[..7]).tab(0)));
    }
}
