//! The player's lineups, read from War Thunder's local profile file (read-only).
//!
//! `<Documents>\My Games\WarThunder\Saves\<uid>\production\global.blk` is a text BLK holding
//! the profile's settings (`Saves\last\lastUid` names the last account; `Saves\last\production`
//! keeps a copy of its file). Livery needs two blocks of it, `slotbar_presets` (the lineups of
//! each nation) and `selectedAir` (the vehicle selected in the hangar). The rest is personal and
//! unrelated, so it is never parsed, kept, sent to the UI or logged: [`find_block`] walks the
//! text with BLK's lexical rules and cuts out just those two blocks for `library::blk::parse`.
//! Logs get counts only, and errors carry the file's path, never its content.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::game::catalog::nation_of;
use crate::library::blk;
use crate::model::{Lineups, LineupsStatus, Nation, NationLineups, Preset};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

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

// ── Locating and reading the profile ───────────────────────────────────────

/// The profile file's name, in `Saves\<uid>\production` and `Saves\last\production`.
pub const GLOBAL_BLK: &str = "global.blk";

/// `io` message: the profile file exists but can't be read.
pub const LINEUPS_UNREADABLE: &str = "Livery couldn't read your War Thunder profile";

/// `parse` message: the lineups block of the profile can't be read.
pub const LINEUPS_UNPARSABLE: &str = "The lineups in your War Thunder profile can't be read";

/// `raw` with every `%NAME%` that `env` knows replaced by its value, as Windows expands a
/// `REG_EXPAND_SZ` value. Unknown names and a lone `%` are kept as written.
pub fn expand_env(raw: &str, env: &dyn Fn(&str) -> Option<OsString>) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else { break };
        let name = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        match if name.is_empty() { None } else { env(name) } {
            Some(value) => out.push_str(&value.to_string_lossy()),
            None => out.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

/// The Documents folder: `personal` (the registry's `Personal` shell folder, which follows a
/// folder moved to OneDrive) with its variables expanded, else `%USERPROFILE%\Documents`.
pub fn documents_dir(personal: Option<&str>, env: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    if let Some(raw) = personal.map(str::trim).filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(expand_env(raw, env)));
    }
    env("USERPROFILE").filter(|home| !home.is_empty()).map(|home| PathBuf::from(home).join("Documents"))
}

/// The last account's `global.blk` under `documents`: `Saves\<lastUid>\production`, else the
/// copy in `Saves\last\production`. `None` when neither file exists.
pub fn profile_file(documents: &Path) -> Option<PathBuf> {
    let saves = documents.join("My Games").join("WarThunder").join("Saves");
    let uid = std::fs::read_to_string(saves.join("last").join("lastUid")).ok();
    // Digits only: the uid becomes a folder name.
    let uid = uid.as_deref().map(str::trim).filter(|u| !u.is_empty() && u.bytes().all(|b| b.is_ascii_digit()));
    uid.map(|u| saves.join(u).join("production").join(GLOBAL_BLK))
        .into_iter()
        .chain(std::iter::once(saves.join("last").join("production").join(GLOBAL_BLK)))
        .find(|p| p.is_file())
}

/// The real Documents folder: the registry's `Personal` shell folder on Windows.
pub fn system_documents_dir() -> Option<PathBuf> {
    let env = |name: &str| std::env::var_os(name);
    documents_dir(registry_personal().as_deref(), &env)
}

/// `HKCU\…\User Shell Folders\Personal`, unexpanded (a `REG_EXPAND_SZ`).
#[cfg(windows)]
fn registry_personal() -> Option<String> {
    winreg::HKCU
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
        .and_then(|k| k.get_value::<String, _>("Personal"))
        .ok()
}

#[cfg(not(windows))]
fn registry_personal() -> Option<String> {
    None
}

/// The block called `name` out of `slice` (the text [`find_block`] cut out), `None` when it
/// doesn't parse. The parser's error is dropped: its message may quote the file.
fn parse_block(slice: &str, name: &str) -> Option<blk::Block> {
    blk::parse(slice).ok()?.blocks.into_iter().find(|(n, _)| n == name).map(|(_, b)| b)
}

/// Reads the lineups of the profile at `path`: `ok`, or `noLineups` when the profile has no
/// usable preset. A file that can't be read is an `io` error; lineups cut mid-write, too big
/// or malformed are a `parse` error. Errors carry the path, never file content.
pub fn read_lineups(path: &Path) -> AppResult<Lineups> {
    let unreadable = |e: std::io::Error| {
        AppError::new(ErrorCode::Io, LINEUPS_UNREADABLE).with_detail(format!("{}: {}", path.display(), e.kind()))
    };
    let unparsable = || AppError::new(ErrorCode::Parse, LINEUPS_UNPARSABLE).with_detail(path.display().to_string());
    let meta = std::fs::metadata(path).map_err(unreadable)?;
    let bytes = std::fs::read(path).map_err(unreadable)?;
    let text = String::from_utf8_lossy(&bytes);

    let presets = match find_block(&text, "slotbar_presets") {
        Ok(Some(slice)) => parse_block(slice, "slotbar_presets").ok_or_else(|| {
            tracing::warn!("lineups: the slotbar_presets block doesn't parse");
            unparsable()
        })?,
        Ok(None) => {
            tracing::info!("lineups: the profile has no slotbar_presets block");
            return Ok(Lineups::empty(LineupsStatus::NoLineups));
        }
        Err(e) => {
            tracing::warn!(error = ?e, "lineups: the slotbar_presets block can't be cut out");
            return Err(unparsable());
        }
    };
    // Optional: without it (or cut mid-write) the lineups are still usable.
    let selected_air = match find_block(&text, "selectedAir") {
        Ok(Some(slice)) => parse_block(slice, "selectedAir"),
        _ => None,
    };

    let (current, current_nation, nations) = parse_lineups(&presets, selected_air.as_ref());
    tracing::info!(
        nations = nations.len(),
        presets = nations.iter().map(|n| n.presets.len()).sum::<usize>(),
        current = current.is_some(),
        "lineups read from the profile"
    );
    if nations.is_empty() {
        return Ok(Lineups::empty(LineupsStatus::NoLineups));
    }
    let saved_at = meta.modified().ok().map(crate::library::time::rfc3339_utc);
    Ok(Lineups { status: LineupsStatus::Ok, saved_at, current, current_nation, nations })
}
