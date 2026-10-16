//! The player's lineups, read from War Thunder's local profile file (read-only).
//!
//! `<Documents>\My Games\WarThunder\Saves\<uid>\production\global.blk` is a text BLK holding
//! the profile's settings (`Saves\last\lastUid` names the last account; `Saves\last\production`
//! keeps a copy of its file). Livery needs two blocks of it, `slotbar_presets` (the lineups of
//! each nation) and `selectedAir` (the vehicle selected in the hangar). The rest is personal and
//! unrelated, so it is never parsed, kept, sent to the UI or logged: [`find_block`] walks the
//! text with BLK's lexical rules and cuts out just those two blocks for `library::blk::parse`.
//! Logs get counts only, and errors carry the file's path, never its content.

/// Largest block [`find_block`] cuts out (the author's `slotbar_presets` is about 4 KB).
pub const MAX_BLOCK_BYTES: usize = 64 * 1024;

/// Why [`find_block`] couldn't cut a block out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanError {
    /// A string, comment or the block itself runs to the end of the text (a file mid-write).
    Unterminated,
    /// The block is larger than [`MAX_BLOCK_BYTES`].
    TooBig,
}

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')
}

/// Where the string or comment starting at `i` ends (the index after it), `Ok(None)` when none
/// starts at `i`. Strings: `"…"` and `'…'` (single-line: a newline ends them), `"""…"""` and
/// `'''…'''` (multi-line); `~` escapes the next character.
fn skip_trivia(b: &[u8], i: usize) -> Result<Option<usize>, ScanError> {
    let rest = &b[i..];
    if rest.starts_with(b"//") {
        let end = rest.iter().position(|&c| c == b'\n').map_or(b.len(), |p| i + p + 1);
        return Ok(Some(end));
    }
    if rest.starts_with(b"/*") {
        return rest[2..]
            .windows(2)
            .position(|w| w == b"*/")
            .map(|p| Some(i + 2 + p + 2))
            .ok_or(ScanError::Unterminated);
    }
    for triple in [&b"\"\"\""[..], &b"'''"[..]] {
        if rest.starts_with(triple) {
            return rest[3..]
                .windows(3)
                .position(|w| w == triple)
                .map(|p| Some(i + 3 + p + 3))
                .ok_or(ScanError::Unterminated);
        }
    }
    if let Some(&quote) = rest.first().filter(|&&c| c == b'"' || c == b'\'') {
        let mut j = i + 1;
        while j < b.len() {
            match b[j] {
                b'~' => j += 2,
                b'\n' => return Ok(Some(j)),
                c if c == quote => return Ok(Some(j + 1)),
                _ => j += 1,
            }
        }
        return Err(ScanError::Unterminated);
    }
    Ok(None)
}

/// The index of the `}` closing the `{` at `open`; the block starts at `start` (its name).
fn closing_brace(b: &[u8], open: usize, start: usize) -> Result<usize, ScanError> {
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        if i - start >= MAX_BLOCK_BYTES {
            return Err(ScanError::TooBig);
        }
        if let Some(next) = skip_trivia(b, i)? {
            i = next;
            continue;
        }
        match b[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(ScanError::Unterminated)
}

/// The text of the first block called `name` (from its name to its closing brace), wherever it
/// is nested. Names inside strings and comments don't count; `name` must be a whole token
/// followed by `{` (whitespace between them is allowed).
pub fn find_block<'a>(text: &'a str, name: &str) -> Result<Option<&'a str>, ScanError> {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if let Some(next) = skip_trivia(b, i)? {
            i = next;
            continue;
        }
        if !is_name_byte(b[i]) {
            i += 1;
            continue;
        }
        // Name bytes are ASCII, so both ends of the token are char boundaries.
        let start = i;
        while i < b.len() && is_name_byte(b[i]) {
            i += 1;
        }
        if &text[start..i] != name {
            continue;
        }
        let mut j = i;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if b.get(j) == Some(&b'{') {
            let end = closing_brace(b, j, start)?;
            return Ok(Some(&text[start..=end]));
        }
    }
    Ok(None)
}
