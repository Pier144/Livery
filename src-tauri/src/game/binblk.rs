//! War Thunder's binary BLK files (inside the `.vromfs.bin` archives), read-only.
//!
//! Not published either; this follows the Dagor Engine sources (`blk_shared.h`, BSD-3), the
//! community tools and the 2.59 files:
//!
//! ```text
//! kind        u8: 1 fat, 2 fat+zstd, 3 slim, 4 slim+zstd, 5 slim+zstd with the archive's dictionary
//! [kind 2]    u24 packed size, then one zstd frame holding a whole kind 1 file
//! [zstd]      the rest is one zstd frame (kinds 4 and 5)
//! names       uleb count; fat: uleb size + NUL-terminated names; slim: the archive's shared
//!             name map ([`NameMap`], file `\xff?nm`)
//! blocks      uleb count        params  uleb count        data  uleb size + bytes
//! param info  8 bytes each: u32 name id (24 bits) | type (8 bits), u32 value or data offset
//! block info  per block: uleb name id (0 = root, else name + 1), uleb param count,
//!             uleb child count, [uleb first child when it has children]
//! ```
//!
//! Params are stored block after block, in block order. Strings are an offset into the data,
//! or a name id when the top bit is set. Only what Livery reads is decoded (strings, ints,
//! floats, bools); other types come back as [`Value::Other`].

use crate::error::{AppError, AppResult, ErrorCode};
use std::io::Read;
use std::sync::Arc;

/// `parse` message for a BLK file that can't be read.
pub const UNREADABLE_BLK: &str = "A War Thunder data file can't be read";

/// Largest unpacked BLK accepted.
pub const MAX_BLK: u64 = 256 * 1024 * 1024;

fn bad(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Parse, UNREADABLE_BLK).with_detail(detail.into())
}

/// One zstd frame, at most `max` bytes out, with an optional dictionary.
fn unzstd(data: &[u8], dict: Option<&[u8]>, max: u64) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    let read = match dict {
        Some(dict) => {
            zstd::stream::read::Decoder::with_dictionary(data, dict).and_then(|d| d.take(max + 1).read_to_end(&mut out))
        }
        None => zstd::stream::read::Decoder::new(data).and_then(|d| d.take(max + 1).read_to_end(&mut out)),
    };
    read.map_err(|e| bad(format!("zstd: {e}")))?;
    if out.len() as u64 > max {
        return Err(bad("unpacks to too much data"));
    }
    Ok(out)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn uleb(&mut self) -> AppResult<u64> {
        let mut value: u64 = 0;
        for shift in (0..64).step_by(7) {
            let byte = *self.bytes.get(self.at).ok_or_else(|| bad("truncated number"))?;
            self.at += 1;
            value |= u64::from(byte & 0x7F) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(bad("number too long"))
    }

    fn usize(&mut self, limit: usize, what: &str) -> AppResult<usize> {
        let value = self.uleb()?;
        usize::try_from(value).ok().filter(|v| *v <= limit).ok_or_else(|| bad(format!("{what}: {value}")))
    }

    fn take(&mut self, len: usize) -> AppResult<&'a [u8]> {
        let end = self.at.checked_add(len).filter(|e| *e <= self.bytes.len()).ok_or_else(|| bad("truncated"))?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }
}

fn names_from(raw: &[u8], count: usize) -> AppResult<Vec<String>> {
    let mut names: Vec<String> =
        raw.split(|&b| b == 0).take(count).map(|n| String::from_utf8_lossy(n).into_owned()).collect();
    if names.len() < count {
        return Err(bad(format!("{} names, {count} expected", names.len())));
    }
    names.truncate(count);
    Ok(names)
}

/// The names slim BLK files share (file `\xff?nm` of the archive).
#[derive(Debug, Clone)]
pub struct NameMap(Arc<Vec<String>>);

impl NameMap {
    /// `\xff?nm`: 8 bytes names digest, 32 bytes dictionary digest, then a zstd frame holding a
    /// uleb count, a uleb size and the NUL-terminated names.
    pub fn parse(file: &[u8], dict: Option<&[u8]>) -> AppResult<Self> {
        let frame = file.get(40..).ok_or_else(|| bad("name map too short"))?;
        let raw = unzstd(frame, dict, MAX_BLK)?;
        let mut cursor = Cursor { bytes: &raw, at: 0 };
        let count = cursor.usize(10_000_000, "names")?;
        let size = cursor.usize(raw.len(), "names size")?;
        Ok(Self(Arc::new(names_from(cursor.take(size)?, count)?)))
    }

    /// Whether the name map needs a zstd dictionary (its digest isn't all zeros).
    pub fn needs_dictionary(file: &[u8]) -> bool {
        file.get(8..40).is_some_and(|digest| digest.iter().any(|&b| b != 0))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// A parameter's value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value<'a> {
    Str(&'a str),
    Int(i32),
    Float(f32),
    Bool(bool),
    /// A type Livery doesn't decode (vectors, colors, matrices, longs).
    Other(u8),
}

impl Value<'_> {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Int(v) => Some(i64::from(*v)),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(v) => Some(*v),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Param {
    name: u32,
    ty: u8,
    raw: u32,
}

#[derive(Debug, Clone, Copy)]
struct BlockInfo {
    /// Name id + 1; 0 = no name (the root).
    name: usize,
    first_param: usize,
    params: usize,
    first_child: usize,
    children: usize,
}

/// A parsed BLK file.
pub struct Blk {
    names: Arc<Vec<String>>,
    data: Vec<u8>,
    params: Vec<Param>,
    blocks: Vec<BlockInfo>,
}

impl std::fmt::Debug for Blk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Blk").field("blocks", &self.blocks.len()).field("params", &self.params.len()).finish()
    }
}

impl Blk {
    /// Parses a binary BLK; slim files (kinds 3 to 5) need the archive's name map (`shared`),
    /// and kind 5 the archive's zstd dictionary.
    pub fn parse(file: &[u8], shared: Option<&NameMap>, dict: Option<&[u8]>) -> AppResult<Self> {
        let (&kind, rest) = file.split_first().ok_or_else(|| bad("empty"))?;
        let body: Vec<u8> = match kind {
            1 | 3 => rest.to_vec(),
            4 | 5 => unzstd(rest, if kind == 5 { dict } else { None }, MAX_BLK)?,
            2 => {
                // u24 packed size, then one zstd frame holding a kind 1 file.
                let size = rest
                    .get(..3)
                    .map(|b| u32::from_le_bytes([b[0], b[1], b[2], 0]) as usize)
                    .ok_or_else(|| bad("truncated"))?;
                let frame = rest.get(3..3 + size).ok_or_else(|| bad("truncated"))?;
                let inner = unzstd(frame, None, MAX_BLK)?;
                if inner.first() != Some(&1) {
                    return Err(bad("nested packed BLK"));
                }
                return Self::parse(&inner, shared, dict);
            }
            other => return Err(bad(format!("not a binary BLK (kind {other})"))),
        };
        let slim = kind >= 3;
        let mut cursor = Cursor { bytes: &body, at: 0 };
        let local = cursor.usize(10_000_000, "local names")?;
        let names = if slim {
            if local != 0 {
                return Err(bad("slim BLK with its own names"));
            }
            Arc::clone(&shared.ok_or_else(|| bad("slim BLK without the archive's name map"))?.0)
        } else {
            let size = cursor.usize(body.len(), "names size")?;
            Arc::new(names_from(cursor.take(size)?, local)?)
        };
        let block_count = cursor.usize(body.len(), "blocks")?;
        let param_count = cursor.usize(body.len() / 8, "params")?;
        let data_size = cursor.usize(body.len(), "params data")?;
        let data = cursor.take(data_size)?.to_vec();
        let info = cursor.take(param_count * 8)?;
        let params: Vec<Param> = info
            .chunks_exact(8)
            .map(|c| {
                let head = u32::from_le_bytes(c[..4].try_into().expect("4 bytes"));
                Param {
                    name: head & 0x00FF_FFFF,
                    ty: (head >> 24) as u8,
                    raw: u32::from_le_bytes(c[4..].try_into().expect("4 bytes")),
                }
            })
            .collect();
        if let Some(p) = params.iter().find(|p| p.name as usize >= names.len()) {
            return Err(bad(format!("param name {} of {}", p.name, names.len())));
        }
        let mut blocks = Vec::with_capacity(block_count);
        let mut next_param = 0;
        for _ in 0..block_count {
            let name = cursor.usize(names.len(), "block name")?;
            let params_here = cursor.usize(param_count, "block params")?;
            let children = cursor.usize(block_count, "block children")?;
            let first_child = if children > 0 { cursor.usize(block_count, "first child")? } else { 0 };
            if first_child + children > block_count || next_param + params_here > param_count {
                return Err(bad("block runs past the end"));
            }
            blocks.push(BlockInfo { name, first_param: next_param, params: params_here, first_child, children });
            next_param += params_here;
        }
        if blocks.is_empty() {
            return Err(bad("no root block"));
        }
        Ok(Self { names, data, params, blocks })
    }

    pub fn root(&self) -> Block<'_> {
        Block { blk: self, index: 0 }
    }

    fn value(&self, p: &Param) -> Value<'_> {
        match p.ty {
            1 if p.raw & 0x8000_0000 != 0 => {
                self.names.get((p.raw & 0x7FFF_FFFF) as usize).map_or(Value::Other(1), |s| Value::Str(s))
            }
            1 => {
                let start = p.raw as usize;
                let text = self.data.get(start..).and_then(|tail| {
                    let end = tail.iter().position(|&b| b == 0)?;
                    std::str::from_utf8(&tail[..end]).ok()
                });
                text.map_or(Value::Other(1), Value::Str)
            }
            2 => Value::Int(p.raw as i32),
            3 => Value::Float(f32::from_bits(p.raw)),
            9 => Value::Bool(p.raw != 0),
            other => Value::Other(other),
        }
    }
}

/// One block of a [`Blk`].
#[derive(Clone, Copy)]
pub struct Block<'a> {
    blk: &'a Blk,
    index: usize,
}

impl<'a> Block<'a> {
    fn info(&self) -> BlockInfo {
        self.blk.blocks[self.index]
    }

    /// `None` for the root.
    pub fn name(&self) -> Option<&'a str> {
        match self.info().name {
            0 => None,
            n => self.blk.names.get(n - 1).map(String::as_str),
        }
    }

    pub fn children(&self) -> impl Iterator<Item = Block<'a>> + 'a {
        let info = self.info();
        let blk = self.blk;
        (info.first_child..info.first_child + info.children).map(move |index| Block { blk, index })
    }

    /// The first child called `name`.
    pub fn child(&self, name: &str) -> Option<Block<'a>> {
        self.children().find(|b| b.name() == Some(name))
    }

    /// Every parameter, in order.
    pub fn params(&self) -> impl Iterator<Item = (&'a str, Value<'a>)> + 'a {
        let info = self.info();
        let blk = self.blk;
        blk.params[info.first_param..info.first_param + info.params]
            .iter()
            .map(move |p| (blk.names[p.name as usize].as_str(), blk.value(p)))
    }

    /// The first parameter called `name`.
    pub fn param(&self, name: &str) -> Option<Value<'a>> {
        self.params().find(|(n, _)| *n == name).map(|(_, v)| v)
    }
}
