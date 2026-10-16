//! The player's lineups, read from War Thunder's local profile file (read-only).
//!
//! `<Documents>\My Games\WarThunder\Saves\<uid>\production\global.blk` is a text BLK holding
//! the profile's settings (`Saves\last\lastUid` names the last account; `Saves\last\production`
//! keeps a copy of its file). Livery needs two blocks of it, `slotbar_presets` (the lineups of
//! each nation) and `selectedAir` (the vehicle selected in the hangar). The rest is personal and
//! unrelated, so it is never parsed, kept, sent to the UI or logged: [`find_block`] walks the
//! text with BLK's lexical rules and cuts out just those two blocks for `library::blk::parse`.
//! Logs get counts only, and errors carry the file's path, never its content.

use crate::game::catalog::nation_of;
use crate::library::blk;
use crate::model::{Nation, NationLineups, Preset};

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

// ── Lineups ─────────────────────────────────────────────────────────────────

/// Nations in the game's order (the same as the UI's `NATION_ORDER`).
const NATION_ORDER: [Nation; 10] = [
    Nation::Usa,
    Nation::Ger,
    Nation::Ussr,
    Nation::Gbr,
    Nation::Jpn,
    Nation::Chn,
    Nation::Ita,
    Nation::Fra,
    Nation::Swe,
    Nation::Isr,
];

fn order_of(nation: Nation) -> usize {
    NATION_ORDER.iter().position(|&n| n == nation).unwrap_or(usize::MAX)
}

/// One `preset:t` string: `crew|crew ids|units|name…|mode|more crew ids` (the name may itself
/// contain `|`). The name, trimmed, and the unit codes, trimmed, without empty or duplicate
/// ones. `None` when it has fewer than 6 fields.
fn parse_preset(raw: &str) -> Option<(String, Vec<String>)> {
    let fields: Vec<&str> = raw.split('|').collect();
    if fields.len() < 6 {
        return None;
    }
    let name = fields[3..fields.len() - 2].join("|").trim().to_owned();
    let mut vehicles: Vec<String> = Vec::new();
    for code in fields[2].split(',').map(str::trim).filter(|c| !c.is_empty()) {
        if !vehicles.iter().any(|v| v == code) {
            vehicles.push(code.to_owned());
        }
    }
    Some((name, vehicles))
}

/// The lineups in `presets` (the `slotbar_presets` block itself), with the current vehicle and
/// its nation from `selected_air` (the `selectedAir` block, when there is one): `(current,
/// current_nation, nations)`.
///
/// Nations come in game order and only with a usable preset (one with a vehicle); unknown
/// `country_*` blocks are skipped. In each nation the preset at `selected` (missing, malformed or
/// out of range: 0) is active. The current vehicle's nation is the `selectedAir` key holding the
/// same code, else the nation of the first preset holding it.
pub fn parse_lineups(
    presets: &blk::Block,
    selected_air: Option<&blk::Block>,
) -> (Option<String>, Option<Nation>, Vec<NationLineups>) {
    let mut nations: Vec<NationLineups> = Vec::new();
    for (country, block) in &presets.blocks {
        let Some(nation) = nation_of(country) else { continue };
        // `selected` indexes the file's list, short strings included: number them first.
        let raw: Vec<Option<(String, Vec<String>)>> =
            block.params_named("preset").map(|v| v.as_str().and_then(parse_preset)).collect();
        let skipped = raw.iter().filter(|p| p.is_none()).count();
        if skipped > 0 {
            tracing::debug!(skipped, "lineups: presets that don't parse were skipped");
        }
        let selected = match block.param("selected") {
            Some(blk::Value::Int(i)) => usize::try_from(*i).ok().filter(|&i| i < raw.len()).unwrap_or(0),
            _ => 0,
        };
        let presets: Vec<Preset> = raw
            .into_iter()
            .enumerate()
            .filter_map(|(i, p)| p.map(|(name, vehicles)| Preset { name, active: i == selected, vehicles }))
            .filter(|p| !p.vehicles.is_empty())
            .collect();
        if !presets.is_empty() {
            nations.push(NationLineups { nation, presets });
        }
    }
    // Stable: two blocks of the same country (not seen in real files) keep their file order.
    nations.sort_by_key(|n| order_of(n.nation));

    let current = selected_air
        .and_then(|b| b.str_param("current_model"))
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    let current_nation = current.as_deref().and_then(|code| {
        let by_key = selected_air.and_then(|b| {
            b.params
                .iter()
                .filter(|(k, _)| k != "current_model" && k != "current_skin")
                .filter(|(_, v)| v.as_str().map(str::trim) == Some(code))
                .find_map(|(k, _)| nation_of(&format!("country_{k}")))
        });
        by_key.or_else(|| {
            nations.iter().find(|n| n.presets.iter().any(|p| p.vehicles.iter().any(|v| v == code))).map(|n| n.nation)
        })
    });
    (current, current_nation, nations)
}
