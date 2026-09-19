//! DAGOR BLK text parser (the format of skin `.blk` files; reused by the archive module in M4).
//!
//! Syntax: params `name:type=value`, blocks `name { … }`, statements separated by newlines, `;`
//! or plain whitespace, `//` and `/* */` comments. Names and string values may be quoted with
//! `"…"` or `'…'` (or tripled, `"""…"""`, for multi-line text). Inside quotes `~` is the escape
//! character, as in DAGOR: `~n`, `~t`, `~r`, and `~x` for a literal `x` (so `~"` and `~~`).
//! Backslashes are literal, because Windows paths are common in hand-written files.
//!
//! Order is preserved and nothing is followed: `include "x.blk"` directives are kept as written.
//! Known value types are converted (a malformed value is an error, since the game would reject
//! it too); unknown type tags, and params written without a type, keep their raw text.
//! The parser never panics and never recurses, and nesting is capped (`MAX_NESTING`), so
//! hostile input only yields a `BlkError`.

use crate::error::{AppError, ErrorCode};
use std::fmt;

/// A block: params and child blocks, each in file order. The file itself is the root block.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Block {
    pub params: Vec<(String, Value)>,
    pub blocks: Vec<(String, Block)>,
    /// Targets of `include` directives in this block, as written. Never followed.
    pub includes: Vec<String>,
}

impl Block {
    /// First param called `name`.
    pub fn param(&self, name: &str) -> Option<&Value> {
        self.params.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    /// Every param called `name`, in order (names may repeat).
    pub fn params_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
        self.params.iter().filter(move |(n, _)| n == name).map(|(_, v)| v)
    }

    /// Text of the first param called `name` (see `Value::as_str`).
    pub fn str_param(&self, name: &str) -> Option<&str> {
        self.param(name).and_then(Value::as_str)
    }

    /// First child block called `name`.
    pub fn block(&self, name: &str) -> Option<&Block> {
        self.blocks.iter().find(|(n, _)| n == name).map(|(_, b)| b)
    }

    /// Every child block called `name`, in order.
    pub fn blocks_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Block> + 'a {
        self.blocks.iter().filter(move |(n, _)| n == name).map(|(_, b)| b)
    }

    pub fn is_empty(&self) -> bool {
        self.params.is_empty() && self.blocks.is_empty() && self.includes.is_empty()
    }
}

/// A param value. Type tags: `t` string, `i` int, `i64`, `r` real, `b` bool, `p2`/`p3`/`p4`
/// points, `ip2`/`ip3` int points, `c` color, `m` matrix.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Str(String),
    Int(i32),
    Int64(i64),
    Real(f64),
    Bool(bool),
    Point2([f64; 2]),
    Point3([f64; 3]),
    Point4([f64; 4]),
    IPoint2([i32; 2]),
    IPoint3([i32; 3]),
    /// r, g, b, a (alpha defaults to 255 when only three components are written).
    Color([u8; 4]),
    /// Matrix text as written, e.g. `[[1, 0, 0] [0, 1, 0] [0, 0, 1] [0, 0, 0]]`.
    Matrix(String),
    /// Unknown type tag, or none (`ty` is empty), with the value text as written.
    Raw {
        ty: String,
        text: String,
    },
}

impl Value {
    /// The text of a string value, or of a raw one (an untyped `name="x"` still reads as text).
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) | Value::Raw { text: s, .. } => Some(s),
            _ => None,
        }
    }

    /// The type tag the value was written with (`""` for an untyped param).
    pub fn type_tag(&self) -> &str {
        match self {
            Value::Str(_) => "t",
            Value::Int(_) => "i",
            Value::Int64(_) => "i64",
            Value::Real(_) => "r",
            Value::Bool(_) => "b",
            Value::Point2(_) => "p2",
            Value::Point3(_) => "p3",
            Value::Point4(_) => "p4",
            Value::IPoint2(_) => "ip2",
            Value::IPoint3(_) => "ip3",
            Value::Color(_) => "c",
            Value::Matrix(_) => "m",
            Value::Raw { ty, .. } => ty,
        }
    }
}

/// A syntax error with its 1-based position (column counted in characters).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlkError {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

impl fmt::Display for BlkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}, column {}: {}", self.line, self.column, self.message)
    }
}

impl std::error::Error for BlkError {}

impl From<BlkError> for AppError {
    fn from(e: BlkError) -> Self {
        AppError::new(ErrorCode::Parse, "Could not read a .blk file").with_detail(e.to_string())
    }
}

/// Parses BLK text. A leading UTF-8 BOM is ignored.
pub fn parse(text: &str) -> Result<Block, BlkError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    Parser { text, bytes: text.as_bytes(), pos: 0 }.parse()
}

/// Parses a file's bytes: rejects binary and UTF-16 files, then decodes as UTF-8, replacing
/// invalid sequences (legacy code-page comments are common in hand-written files).
pub fn parse_bytes(bytes: &[u8]) -> Result<Block, BlkError> {
    let at_start = |message: &str| BlkError { line: 1, column: 1, message: message.to_owned() };
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        return Err(at_start("the file is saved as UTF-16; BLK text must be UTF-8"));
    }
    if bytes.contains(&0) {
        return Err(at_start("this looks like a binary BLK, which is not supported"));
    }
    parse(&String::from_utf8_lossy(bytes))
}

// ── Parser ──────────────────────────────────────────────────────────────────

/// An open block while parsing: the parent to restore on `}` and where the block started.
struct Frame {
    parent: Block,
    name: String,
    start: usize,
}

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    /// Byte offset. Only ever moved past ASCII bytes or whole slices, so it stays on a char
    /// boundary whenever the text is sliced.
    pos: usize,
}

/// Bytes that end a bare name (besides whitespace and comment starts).
fn ends_name(b: u8) -> bool {
    matches!(b, b'{' | b'}' | b':' | b'=' | b';' | b'"' | b'\'')
}

/// Deepest block nesting accepted. Real files stay within a dozen levels; the limit keeps a
/// hostile `a{a{a{…` from building a tree whose (recursive) drop would overflow the stack.
pub const MAX_NESTING: usize = 256;

/// DAGOR directive prefixes written as `@override:name` (the colon belongs to the name).
const DIRECTIVE_PREFIXES: [&str; 3] = ["@override", "@delete", "@clone-last"];

impl<'a> Parser<'a> {
    fn parse(mut self) -> Result<Block, BlkError> {
        let mut current = Block::default();
        let mut stack: Vec<Frame> = Vec::new();
        loop {
            self.skip_separators()?;
            let Some(b) = self.peek() else {
                return match stack.pop() {
                    Some(frame) => Err(self.error_at(frame.start, format!("block '{}' is never closed", frame.name))),
                    None => Ok(current),
                };
            };
            if b == b'}' {
                let Some(frame) = stack.pop() else {
                    return Err(self.error("unexpected '}' with no open block"));
                };
                self.pos += 1;
                let child = std::mem::replace(&mut current, frame.parent);
                current.blocks.push((frame.name, child));
                continue;
            }

            let start = self.pos;
            let (name, quoted) = self.name()?;
            if !quoted && name == "include" && self.starts_include_target() {
                self.skip_inline();
                let target = self.value_text()?;
                current.includes.push(target.text);
                continue;
            }

            self.skip_separators_in_statement()?;
            match self.peek() {
                Some(b'{') => {
                    if stack.len() >= MAX_NESTING {
                        return Err(self.error_at(start, format!("blocks are nested more than {MAX_NESTING} deep")));
                    }
                    self.pos += 1;
                    stack.push(Frame { parent: std::mem::take(&mut current), name, start });
                }
                Some(b':') => {
                    self.pos += 1;
                    self.skip_inline();
                    let ty = self.type_tag()?;
                    self.skip_inline();
                    self.expect_equals(&name)?;
                    let value = self.typed_value(&ty)?;
                    current.params.push((name, value));
                }
                Some(b'=') => {
                    self.pos += 1;
                    let raw = self.value_text()?;
                    current.params.push((name, Value::Raw { ty: String::new(), text: raw.text }));
                }
                _ => return Err(self.error(format!("expected '{{', ':' or '=' after '{name}'"))),
            }
        }
    }

    // ── Lexing helpers ──

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<u8> {
        self.bytes.get(self.pos + offset).copied()
    }

    fn at_comment(&self) -> bool {
        self.peek() == Some(b'/') && matches!(self.peek_at(1), Some(b'/') | Some(b'*'))
    }

    /// Skips whitespace, newlines, `;` and comments between statements.
    fn skip_separators(&mut self) -> Result<(), BlkError> {
        loop {
            match self.peek() {
                Some(b) if b.is_ascii_whitespace() || b == b';' => self.pos += 1,
                Some(b'/') if self.at_comment() => self.skip_comment()?,
                _ => return Ok(()),
            }
        }
    }

    /// Skips whitespace, newlines and comments between a name and its `{`, `:` or `=`.
    fn skip_separators_in_statement(&mut self) -> Result<(), BlkError> {
        loop {
            match self.peek() {
                Some(b) if b.is_ascii_whitespace() => self.pos += 1,
                Some(b'/') if self.at_comment() => self.skip_comment()?,
                _ => return Ok(()),
            }
        }
    }

    /// Skips spaces and tabs only (a newline ends a value).
    fn skip_inline(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.pos += 1;
        }
    }

    fn skip_comment(&mut self) -> Result<(), BlkError> {
        let start = self.pos;
        if self.peek_at(1) == Some(b'/') {
            while !matches!(self.peek(), None | Some(b'\n')) {
                self.pos += 1;
            }
            return Ok(());
        }
        self.pos += 2;
        loop {
            match self.peek() {
                None => return Err(self.error_at(start, "comment '/*' is never closed")),
                Some(b'*') if self.peek_at(1) == Some(b'/') => {
                    self.pos += 2;
                    return Ok(());
                }
                Some(_) => self.pos += 1,
            }
        }
    }

    /// A param or block name, bare or quoted. Returns whether it was quoted.
    fn name(&mut self) -> Result<(String, bool), BlkError> {
        if matches!(self.peek(), Some(b'"' | b'\'')) {
            return Ok((self.quoted()?, true));
        }
        let start = self.pos;
        self.bare_name_chars();
        if self.pos == start {
            return Err(self.error("expected a name"));
        }
        // `@override:name` keeps its colon: the directive is part of the name.
        let head = &self.text[start..self.pos];
        if DIRECTIVE_PREFIXES.contains(&head) && self.peek() == Some(b':') {
            let colon = self.pos;
            self.pos += 1;
            let rest = self.pos;
            self.bare_name_chars();
            if self.pos == rest {
                self.pos = colon;
            }
        }
        Ok((self.text[start..self.pos].to_owned(), false))
    }

    fn bare_name_chars(&mut self) {
        while let Some(b) = self.peek() {
            if b.is_ascii_whitespace() || ends_name(b) || self.at_comment() {
                break;
            }
            self.pos += 1;
        }
    }

    /// After a bare `include`: is the next thing on the line a target (not `:`, `{` or `=`)?
    fn starts_include_target(&self) -> bool {
        let mut i = self.pos;
        while matches!(self.bytes.get(i), Some(b' ' | b'\t')) {
            i += 1;
        }
        // At least one space must separate the keyword from its target.
        i > self.pos
            && match self.bytes.get(i) {
                Some(b'"' | b'\'') => true,
                Some(&b) => !(b.is_ascii_whitespace() || ends_name(b) || b == b'/'),
                None => false,
            }
    }

    fn type_tag(&mut self) -> Result<String, BlkError> {
        let start = self.pos;
        while matches!(self.peek(), Some(b) if b.is_ascii_alphanumeric() || b == b'_') {
            self.pos += 1;
        }
        if self.pos == start {
            return Err(self.error("expected a type after ':'"));
        }
        Ok(self.text[start..self.pos].to_owned())
    }

    fn expect_equals(&mut self, name: &str) -> Result<(), BlkError> {
        if self.peek() == Some(b'=') {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.error(format!("expected '=' after the type of '{name}'")))
        }
    }

    /// The text of a value: a quoted string, or bare text up to the end of the line, `;`, `}`
    /// or a comment (trimmed).
    fn value_text(&mut self) -> Result<RawValue, BlkError> {
        self.skip_inline();
        let start = self.pos;
        if matches!(self.peek(), Some(b'"' | b'\'')) {
            return Ok(RawValue { text: self.quoted()?, start, quoted: true });
        }
        while let Some(b) = self.peek() {
            if matches!(b, b'\n' | b'\r' | b';' | b'}') || self.at_comment() {
                break;
            }
            self.pos += 1;
        }
        Ok(RawValue { text: self.text[start..self.pos].trim().to_owned(), start, quoted: false })
    }

    /// A quoted string starting at the current quote. `~` escapes the next character.
    fn quoted(&mut self) -> Result<String, BlkError> {
        let start = self.pos;
        let Some(quote) = self.peek() else { return Err(self.error("expected a string")) };
        if self.peek_at(1) == Some(quote) && self.peek_at(2) == Some(quote) {
            return self.triple_quoted(quote);
        }
        self.pos += 1;
        let mut out = String::new();
        let mut run = self.pos;
        loop {
            match self.peek() {
                None | Some(b'\n' | b'\r') => return Err(self.error_at(start, "string is never closed")),
                Some(b) if b == quote => {
                    out.push_str(&self.text[run..self.pos]);
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'~') => {
                    out.push_str(&self.text[run..self.pos]);
                    self.pos += 1;
                    match self.peek() {
                        Some(b'n') => out.push('\n'),
                        Some(b't') => out.push('\t'),
                        Some(b'r') => out.push('\r'),
                        // A non-ASCII char after `~` is kept as is (from the next run).
                        Some(b) if b.is_ascii() && b != b'\n' && b != b'\r' => out.push(char::from(b)),
                        _ => {
                            run = self.pos;
                            continue;
                        }
                    }
                    self.pos += 1;
                    run = self.pos;
                }
                Some(_) => self.pos += 1,
            }
        }
    }

    /// `"""…"""` / `'''…'''`: may span lines, no escapes; a newline right after the opening
    /// quotes is dropped.
    fn triple_quoted(&mut self, quote: u8) -> Result<String, BlkError> {
        let start = self.pos;
        self.pos += 3;
        if self.peek() == Some(b'\r') && self.peek_at(1) == Some(b'\n') {
            self.pos += 2;
        } else if self.peek() == Some(b'\n') {
            self.pos += 1;
        }
        let body = self.pos;
        while self.pos < self.bytes.len() {
            if self.bytes[self.pos..].starts_with(&[quote, quote, quote]) {
                let text = self.text[body..self.pos].to_owned();
                self.pos += 3;
                return Ok(text);
            }
            self.pos += 1;
        }
        Err(self.error_at(start, "string is never closed"))
    }

    fn typed_value(&mut self, ty: &str) -> Result<Value, BlkError> {
        let raw = self.value_text()?;
        let text = raw.text.as_str();
        let bad = |this: &Self, what: &str| this.error_at(raw.start, format!("'{text}' is not a valid {what}"));
        let value = match ty {
            "t" => Value::Str(raw.text.clone()),
            "i" => Value::Int(parse_int(text).ok_or_else(|| bad(self, "int"))?),
            "i64" => Value::Int64(parse_int(text).ok_or_else(|| bad(self, "64-bit int"))?),
            "r" => Value::Real(parse_real(text).ok_or_else(|| bad(self, "real number"))?),
            "b" => Value::Bool(parse_bool(text).ok_or_else(|| bad(self, "bool"))?),
            "p2" => Value::Point2(components(text, parse_real).ok_or_else(|| bad(self, "p2"))?),
            "p3" => Value::Point3(components(text, parse_real).ok_or_else(|| bad(self, "p3"))?),
            "p4" => Value::Point4(components(text, parse_real).ok_or_else(|| bad(self, "p4"))?),
            "ip2" => Value::IPoint2(components(text, parse_int).ok_or_else(|| bad(self, "ip2"))?),
            "ip3" => Value::IPoint3(components(text, parse_int).ok_or_else(|| bad(self, "ip3"))?),
            "c" => Value::Color(parse_color(text).ok_or_else(|| bad(self, "color"))?),
            "m" => {
                let bracketed = text.starts_with('[') && text.ends_with(']');
                if !(raw.quoted || bracketed) {
                    return Err(bad(self, "matrix"));
                }
                Value::Matrix(raw.text.clone())
            }
            _ => Value::Raw { ty: ty.to_owned(), text: raw.text.clone() },
        };
        Ok(value)
    }

    // ── Errors ──

    fn error(&self, message: impl Into<String>) -> BlkError {
        self.error_at(self.pos, message)
    }

    fn error_at(&self, offset: usize, message: impl Into<String>) -> BlkError {
        let offset = offset.min(self.bytes.len());
        let before = &self.bytes[..offset];
        let line_start = before.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
        let line = 1 + before.iter().filter(|&&b| b == b'\n').count();
        // Count characters, not bytes: skip UTF-8 continuation bytes.
        let column = 1 + before[line_start..].iter().filter(|&&b| b & 0xC0 != 0x80).count();
        BlkError { line, column, message: message.into() }
    }
}

struct RawValue {
    text: String,
    /// Where the value starts, for error positions.
    start: usize,
    quoted: bool,
}

// ── Value conversion ────────────────────────────────────────────────────────

/// Decimal or `0x` hex, with an optional sign.
fn parse_int<T: TryFrom<i128>>(text: &str) -> Option<T> {
    let text = text.trim();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let magnitude = match digits.strip_prefix("0x").or_else(|| digits.strip_prefix("0X")) {
        Some(hex) if !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()) => {
            i128::from_str_radix(hex, 16).ok()?
        }
        Some(_) => return None,
        None if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => digits.parse::<i128>().ok()?,
        None => return None,
    };
    T::try_from(if negative { -magnitude } else { magnitude }).ok()
}

fn parse_real(text: &str) -> Option<f64> {
    let text = text.trim();
    // Rust also accepts "inf"/"NaN"; a BLK number is digits, sign, dot and exponent only.
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+' | b'e' | b'E')) {
        return None;
    }
    text.parse().ok()
}

fn parse_bool(text: &str) -> Option<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "yes" | "true" | "on" | "1" => Some(true),
        "no" | "false" | "off" | "0" => Some(false),
        _ => None,
    }
}

/// Exactly `N` comma-separated components.
fn components<T: Copy + Default, const N: usize>(text: &str, parse: impl Fn(&str) -> Option<T>) -> Option<[T; N]> {
    let mut out = [T::default(); N];
    let mut parts = text.split(',');
    for slot in &mut out {
        *slot = parse(parts.next()?)?;
    }
    parts.next().is_none().then_some(out)
}

/// `r, g, b` or `r, g, b, a`, each 0–255.
fn parse_color(text: &str) -> Option<[u8; 4]> {
    let parts: Vec<u8> = text.split(',').map(parse_int::<u8>).collect::<Option<_>>()?;
    match parts[..] {
        [r, g, b] => Some([r, g, b, 255]),
        [r, g, b, a] => Some([r, g, b, a]),
        _ => None,
    }
}
