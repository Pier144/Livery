# For you tab Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third Explore tab, For you, that suggests WT Live skins for the vehicles in the player's War Thunder lineups, read from the local profile file `global.blk`.

**Architecture:** Rust reads two blocks (`slotbar_presets`, `selectedAir`) out of `Documents\My Games\WarThunder\Saves\<uid>\production\global.blk` with a lexer that never parses the rest, and answers `game_lineups`. Two new `WtLiveClient` methods fetch the top 3 skins of one vehicle and the new skins of a flat vehicle list (tags packed 40 per request). The frontend groups and deduplicates lineups in a pure model and renders a virtualized list whose rows each query their own top skins.

**Tech Stack:** Rust (Tauri 2 commands, `winreg` on Windows, existing `library::blk` parser), React 18 + TypeScript, TanStack Query + Virtual, Zustand, react-i18next, Vitest + RTL, cargo test.

**Spec:** [docs/superpowers/specs/2026-10-16-for-you-tab-design.md](../specs/2026-10-16-for-you-tab-design.md). Read it first. Mockup: [2026-10-16-for-you-mockup.html](../specs/2026-10-16-for-you-mockup.html).

**Repo conventions (CLAUDE.md, binding):** Tailwind tokens only (no hex in components), all strings via `t()` in nine languages (en, it, de, ru, fr, es, pl, pt-BR, zh-CN; no em dashes anywhere in app text), Lucide icons `size={14}`/`strokeWidth={1.75}`, no spinners (Skeleton), `motion-safe:` for animation, commands return `Result<T, AppError>`, no new dependencies. Backend error messages are localized by adding their exact English text under `common.errors.backend` in `src/i18n/en.json` (`src/lib/errors.test.ts` enforces it).

**Commands to know:**
- Rust tests: `cd src-tauri && cargo test --test <file>` (one file) or `cargo test` (all). Clippy: `cargo clippy --all-targets -- -D warnings`. Format: `cargo fmt`.
- Frontend: `pnpm test -- <path>` (Vitest), `pnpm typecheck`, `pnpm i18n:check`, `pnpm build`, `pnpm dev:mock` (browser UI with the mock backend).

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/game/profile.rs` (new) | Locate `global.blk`, cut the two blocks out (lexer), parse lineups, `ProfileStore` cache, `game_lineups` plain function. |
| `src-tauri/src/game/mod.rs` | `pub mod profile;` and the `game_lineups` Tauri command. |
| `src-tauri/src/model.rs` | `LineupsStatus`, `Lineups`, `NationLineups`, `Preset`, `ForYouSkin`, `ForYouNew`. |
| `src-tauri/src/wtlive/client.rs` | Trait methods `vehicle_top`, `for_you_new`; `DisabledClient` refuses them. |
| `src-tauri/src/wtlive/live.rs` | `LiveClient` implementations, `MAX_TAGS_PER_REQUEST`, `MAX_FOR_YOU_REQUESTS`, `pack_tag_chunks`. |
| `src-tauri/src/wtlive/for_you.rs` (new) | `for_you.json` store (`lastSeenAt`). |
| `src-tauri/src/wtlive/mod.rs` | State gains the store; commands `wtlive_vehicle_top`, `wtlive_for_you_new`, `for_you_seen`, `for_you_mark_seen`. |
| `src-tauri/src/lib.rs` | Manage `ProfileStore`, register the commands. |
| `src-tauri/tests/profile_*.rs`, `tests/for_you_store.rs`, additions to `wtlive_live.rs`, `wtlive_offline.rs`, `wtlive_install.rs`, `wtlive_real.rs` | Tests. |
| `src-tauri/tests/fixtures/profile/` | Anonymized `global.blk` fixtures. |
| `src/types.ts` | Mirrored types. |
| `src/queries/game.ts` | `useLineups`. |
| `src/queries/wtlive.ts` | `useVehicleTop`, `useForYouNew`, `useMarkForYouSeen`. |
| `src/screens/Explore/forYouModel.ts` (new) | Pure ordering, dedup, flat list, counts. |
| `src/screens/Explore/ForYou.tsx` (new) | The tab body. |
| `src/store/explore.ts`, `ExploreHeader.tsx`, `src/screens/Explore.tsx` | Third tab and its pill. |
| `src/dev/mockBackend.ts`, `src/dev/mockData.ts` | Mock commands and lineups. |
| `src/i18n/*.json` | Strings. |
| `DESIGN_NOTES.md`, `README.md`, `docs/wtlive-terms.md` | Docs. |

---

## Chunk 1: Reading the lineups (Rust)

### Task 1: Types in `model.rs`

**Files:** Modify `src-tauri/src/model.rs` (append after the WT Live types).

- [ ] **Step 1: Add the types**

```rust
// ── For you (lineups from the player's profile) ─────────────────────────────

/// What `game_lineups` found. `Off`: reading the game's data is off. `NoProfile`: no
/// `global.blk`. `NoLineups`: the profile has no usable preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineupsStatus {
    Ok,
    Off,
    NoProfile,
    NoLineups,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lineups {
    pub status: LineupsStatus,
    /// RFC 3339: when the game last wrote the profile file.
    pub saved_at: Option<String>,
    /// The vehicle selected in the hangar right now (`selectedAir.current_model`).
    pub current: Option<String>,
    pub current_nation: Option<Nation>,
    /// Game nation order; nations without a usable preset are left out.
    pub nations: Vec<NationLineups>,
}

impl Lineups {
    pub fn empty(status: LineupsStatus) -> Self {
        Self { status, saved_at: None, current: None, current_nation: None, nations: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NationLineups {
    pub nation: Nation,
    /// File order.
    pub presets: Vec<Preset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    /// The player's text, trimmed (may be empty: the UI shows "Preset N").
    pub name: String,
    pub active: bool,
    /// Vehicle codes, file order, no empty or duplicate codes.
    pub vehicles: Vec<String>,
}

/// A new skin for For you, with the lineup vehicle it was matched to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForYouSkin {
    pub vehicle: String,
    pub skin: WtLiveSkin,
}

/// `wtlive_for_you_new`: new skins, and how many vehicles from the start of the asked list
/// were covered (the rest weren't checked: request cap or a failed later request).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForYouNew {
    pub items: Vec<ForYouSkin>,
    pub checked: u32,
}
```

- [ ] **Step 2:** `cd src-tauri && cargo build` → compiles (check `WtLiveSkin` derives `PartialEq` and `Deserialize`; if not, drop those derives from `ForYouSkin`/`ForYouNew` and adjust).
- [ ] **Step 3: Commit** `git commit -am "feat(for-you): lineup and new-skin types"`

### Task 2: Block scanner

**Files:** Create `src-tauri/src/game/profile.rs`; modify `src-tauri/src/game/mod.rs` (`pub mod profile;`); test `src-tauri/tests/profile_scan.rs`.

- [ ] **Step 1: Write the failing tests** (`tests/profile_scan.rs`)

```rust
use livery_lib::game::profile::{find_block, ScanError, MAX_BLOCK_BYTES};

#[test]
fn finds_a_block_at_any_depth() {
    let text = "content{\n profile{\n  selectedAir{\n   current_model:t=\"us_m4_t26\"\n  }\n }\n}";
    assert_eq!(find_block(text, "selectedAir").unwrap(), Some("selectedAir{\n   current_model:t=\"us_m4_t26\"\n  }"));
}

#[test]
fn allows_whitespace_before_the_brace() {
    assert_eq!(find_block("a{ selectedAir \n { x:i=1 } }", "selectedAir").unwrap(), Some("selectedAir \n { x:i=1 }"));
}

#[test]
fn matches_whole_tokens_only() {
    assert_eq!(find_block("xselectedAir{a:i=1}", "selectedAir").unwrap(), None);
    assert_eq!(find_block("selectedAir:t=\"x\"", "selectedAir").unwrap(), None, "a param, not a block");
}

#[test]
fn ignores_names_and_braces_in_strings_and_comments() {
    let text = concat!(
        "a:t=\"selectedAir{\"\n",
        "b:t='} selectedAir{'\n",
        "c:t=\"\"\"selectedAir{ }\"\"\"\n",
        "c2:t='''selectedAir{ '''\n",
        "e:t=it's selectedAir-free\n",
        "d:t=\"~\" selectedAir{\"\n",
        "// selectedAir{\n",
        "/* selectedAir{ } */\n",
        "selectedAir{ name:t=\"}{\" // }\n /* } */ }",
    );
    assert_eq!(
        find_block(text, "selectedAir").unwrap(),
        Some("selectedAir{ name:t=\"}{\" // }\n /* } */ }")
    );
}

#[test]
fn reports_an_unterminated_block() {
    assert_eq!(find_block("slotbar_presets{ a{ }", "slotbar_presets"), Err(ScanError::Unterminated));
    assert_eq!(find_block("slotbar_presets{ a:t=\"x", "slotbar_presets"), Err(ScanError::Unterminated));
}

#[test]
fn caps_the_block_size() {
    let big = format!("slotbar_presets{{ a:t=\"{}\" }}", "x".repeat(MAX_BLOCK_BYTES));
    assert_eq!(find_block(&big, "slotbar_presets"), Err(ScanError::TooBig));
}

#[test]
fn a_missing_block_is_none() {
    assert_eq!(find_block("a{ b{ } }", "slotbar_presets").unwrap(), None);
}
```

- [ ] **Step 2:** `cargo test --test profile_scan` → FAIL (module missing).
- [ ] **Step 3: Implement** in `profile.rs` (module doc: what the file is, the privacy rule from spec §1, the path layout).

```rust
//! The player's lineups, read from War Thunder's local profile file (read-only).
//!
//! `<Documents>\My Games\WarThunder\Saves\<uid>\production\global.blk` is a text BLK holding
//! the profile's settings. Livery needs two blocks of it, `slotbar_presets` (the lineups of each
//! nation) and `selectedAir` (the vehicle selected in the hangar). The rest is personal and
//! unrelated, so it is never parsed, kept, sent to the UI or logged: [`find_block`] walks the
//! text with BLK's lexical rules and cuts out just those two blocks for `library::blk::parse`.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::library::blk;
use crate::model::{Lineups, LineupsStatus, Nation, NationLineups, Preset};

/// Largest block [`find_block`] cuts out (the author's `slotbar_presets` is about 4 KB).
pub const MAX_BLOCK_BYTES: usize = 64 * 1024;

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
/// starts at `i`. Strings: `"…"` and `'…'` (single-line, as in `library::blk`: a newline ends
/// them), `"""…"""` and `'''…'''` (multi-line); `~` escapes the next character.
fn skip_trivia(b: &[u8], i: usize) -> Result<Option<usize>, ScanError> {
    let rest = &b[i..];
    if rest.starts_with(b"//") {
        let end = rest.iter().position(|&c| c == b'\n').map_or(b.len(), |p| i + p + 1);
        return Ok(Some(end));
    }
    if rest.starts_with(b"/*") {
        return rest[2..].windows(2).position(|w| w == b"*/").map(|p| Some(i + 2 + p + 2)).ok_or(ScanError::Unterminated);
    }
    for triple in [&b"\"\"\""[..], &b"'''"[..]] {
        if rest.starts_with(triple) {
            return rest[3..].windows(3).position(|w| w == triple).map(|p| Some(i + 3 + p + 3)).ok_or(ScanError::Unterminated);
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

/// The index of the `}` closing the `{` at `open`.
fn closing_brace(b: &[u8], open: usize, start: usize) -> Result<usize, ScanError> {
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        if i - start > MAX_BLOCK_BYTES {
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
/// is nested. Names inside strings and comments don't count; `name` must be a whole token.
pub fn find_block<'a>(text: &'a str, name: &str) -> Result<Option<&'a str>, ScanError> {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if let Some(next) = skip_trivia(b, i)? {
            i = next;
            continue;
        }
        if is_name_byte(b[i]) {
            let start = i;
            while i < b.len() && is_name_byte(b[i]) {
                i += 1;
            }
            if &text[start..i] == name {
                let mut j = i;
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if b.get(j) == Some(&b'{') {
                    let end = closing_brace(b, j, start)?;
                    if end + 1 - start > MAX_BLOCK_BYTES {
                        return Err(ScanError::TooBig);
                    }
                    return Ok(Some(&text[start..=end]));
                }
            }
            continue;
        }
        i += 1;
    }
    Ok(None)
}
```

Note: the unterminated-string test inside a block (`slotbar_presets{ a:t="x`) returns `Unterminated` through `closing_brace` → `skip_trivia`. A `~` as the last byte makes `j` jump past the end, the loop exits and the string is `Unterminated`: fine.

- [ ] **Step 4:** `cargo test --test profile_scan` → PASS. Fix any slice-index panic (`text[start..i]` is safe because the boundaries are ASCII bytes).
- [ ] **Step 5: Commit** `git add -A src-tauri && git commit -m "feat(for-you): cut lineup blocks out of global.blk"`

### Task 3: Lineups parser

**Files:** Modify `profile.rs`; test `src-tauri/tests/profile_parse.rs`.

- [ ] **Step 1: Failing tests** — use inline BLK text (the real format, from the spec). Cases, one `#[test]` each:
  1. Two nations (`country_usa` with 3 presets and `selected:i=1`; `country_britain` with 1 preset, no `selected`) → `nations` in game order (USA before GBR even if Britain comes first in the text), `active` on index 1 for USA and 0 for Britain, vehicles split on `,`.
  2. `selected:i=7` (out of range) and `selected:t="x"` (malformed) → index 0 active.
  3. A `preset:t` with fewer than 6 `|` fields → skipped, and a short preset *before* the selected one doesn't shift which one is active; a nation left with no usable preset (only empty vehicle lists or skipped strings) → left out.
  4. A name containing `|`: `"5|5,6|a,b|My | lineup|tank_mode|"` → name `"My | lineup"`, vehicles `["a","b"]`.
  5. `"5|5|a,,a, b |N|m|"` → vehicles `["a","b"]` (trimmed, empty and duplicate dropped).
  6. `country_atlantis{…}` → skipped.
  7. Aircraft codes without prefix (`d_371`, `yak-7b`) kept as is.
  8. `current_nation` from `selectedAir`: `current_model:t="d_371"`, `france:t="d_371"` → `Fra` even if `d_371` is in no preset.
  9. `current_nation` fallback: `current_model:t="us_m4_t26"` and no nation key equal to it → the nation of the first preset (game order) containing it.
  10. No `selectedAir` → `current` and `current_nation` none.

Signature to test:

```rust
pub fn parse_lineups(presets: &blk::Block, selected_air: Option<&blk::Block>) -> (Option<String>, Option<Nation>, Vec<NationLineups>)
```

where `presets` is the `slotbar_presets` block itself (callers take it from `blk::parse(slice)?.block("slotbar_presets")`). Tests build blocks with `livery_lib::library::blk::parse(text).unwrap().block("slotbar_presets").unwrap().clone()`.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**

```rust
/// Nations in the game's order (the same as the UI's `NATION_ORDER`).
const NATION_ORDER: [Nation; 10] = [
    Nation::Usa, Nation::Ger, Nation::Ussr, Nation::Gbr, Nation::Jpn,
    Nation::Chn, Nation::Ita, Nation::Fra, Nation::Swe, Nation::Isr,
];

fn order_of(nation: Nation) -> usize {
    NATION_ORDER.iter().position(|&n| n == nation).unwrap_or(usize::MAX)
}

/// One `preset:t` string: `crew|crew ids|units|name…|mode|more crew ids`. `None` when it has
/// fewer than 6 fields.
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

pub fn parse_lineups(
    presets: &blk::Block,
    selected_air: Option<&blk::Block>,
) -> (Option<String>, Option<Nation>, Vec<NationLineups>) {
    let mut nations: Vec<NationLineups> = Vec::new();
    for (country, block) in &presets.blocks {
        let Some(nation) = crate::game::catalog::nation_of(country) else { continue };
        // `selected` indexes the file's list, short strings included: number them first.
        let raw: Vec<Option<(String, Vec<String>)>> =
            block.params_named("preset").map(|v| v.as_str().and_then(parse_preset)).collect();
        let skipped = raw.iter().filter(|p| p.is_none()).count();
        if skipped > 0 {
            tracing::debug!(skipped, "lineups: presets that don't parse were skipped");
        }
        let selected = match block.param("selected") {
            Some(blk::Value::Int(i)) if *i >= 0 && (*i as usize) < raw.len() => *i as usize,
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
    nations.sort_by_key(|n| order_of(n.nation));
    let current = selected_air.and_then(|b| b.str_param("current_model")).map(str::trim).filter(|c| !c.is_empty()).map(str::to_owned);
    let current_nation = current.as_deref().and_then(|code| {
        let by_key = selected_air.and_then(|b| {
            b.params
                .iter()
                .filter(|(k, _)| k != "current_model" && k != "current_skin")
                .filter(|(_, v)| v.as_str().map(str::trim) == Some(code))
                .find_map(|(k, _)| crate::game::catalog::nation_of(&format!("country_{k}")))
        });
        by_key.or_else(|| {
            nations.iter().find(|n| n.presets.iter().any(|p| p.vehicles.iter().any(|v| v == code))).map(|n| n.nation)
        })
    });
    (current, current_nation, nations)
}
```

Note: when the selected preset is filtered out for having no vehicles, no preset is active in that nation; that's acceptable (the UI orders presets with `active` first, and none being active simply keeps file order).

- [ ] **Step 4:** run → PASS. **Step 5: Commit** `feat(for-you): parse lineups from the profile blocks`.

### Task 4: Locating the profile and `read_lineups`

**Files:** Modify `profile.rs`; tests `src-tauri/tests/profile_read.rs`; fixtures `src-tauri/tests/fixtures/profile/`.

- [ ] **Step 1: Fixtures.** Create `fixtures/profile/global.blk`: copy the structure of the real file but anonymized: `version:i=1`, `content{ profile{ … } }` with a few unrelated params (`scoutTargetSuccess:i=0`, a `skins{ it_ab_41:t="x" }` block, a param containing `"selectedAir{"` inside a string), a `slotbar_presets` block with 3 nations (usa: 3 presets, selected 1; ussr: 1 preset; britain: 2 presets) using the author's vehicle codes (`us_m4_t26,us_m18_hellcat,us_m4a3e2_sherman_jumbo,us_t1e1_90`, etc.), and a `selectedAir` block with `current_model:t="us_m4_t26"`, `usa:t="us_m4_t26"`. Write it with CRLF line endings like the game. Also `global_no_presets.blk` (no `slotbar_presets`) and `global_torn.blk` (ends in the middle of `slotbar_presets`).
- [ ] **Step 2: Failing tests** for:

```rust
pub fn expand_env(raw: &str, env: &dyn Fn(&str) -> Option<std::ffi::OsString>) -> String;
pub fn documents_dir(personal: Option<&str>, env: &dyn Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf>;
pub fn profile_file(documents: &Path) -> Option<PathBuf>;
pub fn read_lineups(path: &Path) -> AppResult<Lineups>;
```

  - `expand_env("%USERPROFILE%\\OneDrive\\Documenti", env)` → `C:\Users\x\OneDrive\Documenti`; unknown `%NOPE%` kept as written.
  - `documents_dir(Some("%USERPROFILE%\\Docs"), env)` uses it; `documents_dir(None, env)` → `%USERPROFILE%\Documents`; neither registry nor `USERPROFILE` → `None`.
  - `profile_file`: temp `Documents/My Games/WarThunder/Saves/last/lastUid` = `"123\r\n"` and `Saves/123/production/global.blk` → that file; uid folder missing but `Saves/last/production/global.blk` present → that one; `lastUid` = `"../x"` (not digits) → falls back to `last`; nothing → `None`.
  - `read_lineups(fixture)` → `status: ok`, `saved_at` is `Some(rfc3339)`, three nations in order USA, USSR, GBR, `current_nation: Some(Usa)`.
  - `read_lineups(global_no_presets.blk)` → `status: noLineups`.
  - `read_lineups(global_torn.blk)` → `Err` with `code: parse`, message `LINEUPS_UNPARSABLE`, and `detail` not containing any text from the file (assert it doesn't contain `"us_m4_t26"`).
  - `read_lineups(missing path)` → `Err` code `io`, message `LINEUPS_UNREADABLE`.
  - A file whose `selectedAir` block is unterminated but `slotbar_presets` is fine → `ok`, `current: None`.
- [ ] **Step 3: Implement**

```rust
pub const GLOBAL_BLK: &str = "global.blk";
/// `io` message: the profile file exists but can't be read.
pub const LINEUPS_UNREADABLE: &str = "Livery couldn't read your War Thunder profile";
/// `parse` message: the lineups block of the profile can't be read.
pub const LINEUPS_UNPARSABLE: &str = "The lineups in your War Thunder profile can't be read";

pub fn expand_env(raw: &str, env: &dyn Fn(&str) -> Option<OsString>) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else { break };
        let name = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        match env(name).filter(|_| !name.is_empty()) {
            Some(value) => out.push_str(&value.to_string_lossy()),
            None => out.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

pub fn documents_dir(personal: Option<&str>, env: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    if let Some(raw) = personal.map(str::trim).filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(expand_env(raw, env)));
    }
    env("USERPROFILE").map(|home| PathBuf::from(home).join("Documents"))
}

pub fn profile_file(documents: &Path) -> Option<PathBuf> {
    let saves = documents.join("My Games").join("WarThunder").join("Saves");
    let uid = std::fs::read_to_string(saves.join("last").join("lastUid")).ok();
    let uid = uid.as_deref().map(str::trim).filter(|u| !u.is_empty() && u.bytes().all(|b| b.is_ascii_digit()));
    let candidates = uid
        .map(|u| saves.join(u).join("production").join(GLOBAL_BLK))
        .into_iter()
        .chain(std::iter::once(saves.join("last").join("production").join(GLOBAL_BLK)));
    candidates.into_iter().find(|p| p.is_file())
}

/// The real Documents folder: the registry's `Personal` shell folder on Windows.
pub fn system_documents_dir() -> Option<PathBuf> {
    let env = |name: &str| std::env::var_os(name);
    documents_dir(registry_personal().as_deref(), &env)
}

#[cfg(windows)]
fn registry_personal() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
        .and_then(|k| k.get_value::<String, _>("Personal"))
        .ok()
}

#[cfg(not(windows))]
fn registry_personal() -> Option<String> {
    None
}

fn unparsable(path: &Path) -> AppError {
    AppError::new(ErrorCode::Parse, LINEUPS_UNPARSABLE).with_detail(path.display().to_string())
}

/// Reads the lineups of the profile at `path`. Never puts file content in an error.
pub fn read_lineups(path: &Path) -> AppResult<Lineups> {
    let unreadable = |e: std::io::Error| {
        AppError::new(ErrorCode::Io, LINEUPS_UNREADABLE).with_detail(format!("{}: {}", path.display(), e.kind()))
    };
    let meta = std::fs::metadata(path).map_err(unreadable)?;
    let bytes = std::fs::read(path).map_err(unreadable)?;
    let text = String::from_utf8_lossy(&bytes);
    let presets = match find_block(&text, "slotbar_presets") {
        Ok(Some(slice)) => blk::parse(slice).ok().and_then(|root| root.block("slotbar_presets").cloned()).ok_or_else(|| unparsable(path))?,
        Ok(None) => return Ok(Lineups::empty(LineupsStatus::NoLineups)),
        Err(_) => return Err(unparsable(path)),
    };
    let selected_air = match find_block(&text, "selectedAir") {
        Ok(Some(slice)) => blk::parse(slice).ok().and_then(|root| root.block("selectedAir").cloned()),
        _ => None,
    };
    let (current, current_nation, nations) = parse_lineups(&presets, selected_air.as_ref());
    tracing::info!(nations = nations.len(), presets = nations.iter().map(|n| n.presets.len()).sum::<usize>(), "lineups read from the profile");
    if nations.is_empty() {
        return Ok(Lineups::empty(LineupsStatus::NoLineups));
    }
    let saved_at = meta.modified().ok().map(crate::library::time::rfc3339_utc);
    Ok(Lineups { status: LineupsStatus::Ok, saved_at, current, current_nation, nations })
}
```

(`OsString`, `Path`, `PathBuf` imports at the top. If `blk::parse` errors expose text in their message, it is discarded here: only the path goes into `detail`.)

- [ ] **Step 4:** run → PASS. **Step 5: Commit** `feat(for-you): locate and read the profile's lineups`.

### Task 5: `ProfileStore`, retry, the command

**Files:** Modify `profile.rs`, `game/mod.rs`, `lib.rs`; test `src-tauri/tests/profile_store.rs`.

- [ ] **Step 1: Failing tests** for

```rust
pub struct ProfileStore { /* Mutex<Option<Cached>> */ }
impl ProfileStore {
    pub fn new() -> Self;
    /// `read_game_data` false → `off` (no disk access). Otherwise resolve with `locate`, read
    /// (cached by path, size and mtime), retry once after 150 ms on a `parse` error.
    pub fn lineups(&self, read_game_data: bool, locate: impl FnOnce() -> Option<PathBuf>) -> AppResult<Lineups>;
}
```

  - `read_game_data = false` → `status: off`, and the `locate` closure is never called (use a closure that panics).
  - `locate` → `None` → `noProfile`.
  - Expose `#[doc(hidden)] pub fn reads(&self) -> u32` (actual file reads). Two calls on an unchanged file → `reads() == 1`.
  - Changing the file (write more bytes) → re-read (`reads() == 2`); changing only the mtime (`File::set_modified`) → re-read.
  - A different path → re-read.
  - The torn fixture → `Err(parse)` after `reads() == 2` (the retry).
- [ ] **Step 2:** run → FAIL. **Step 3: Implement** (`#[derive(Default)]` on `ProfileStore`, or clippy's `new_without_default` fails) with `std::sync::Mutex<Option<(PathBuf, u64, Option<SystemTime>, Lineups)>>` and an `AtomicU32` read counter; on a `parse` error sleep 150 ms and read once more. Command in `game/mod.rs`:

```rust
/// For you: the lineups in the player's War Thunder profile (see [`profile`]). Local.
#[tauri::command]
pub async fn game_lineups(app: AppHandle) -> AppResult<crate::model::Lineups> {
    blocking(move || {
        let on = app.state::<SettingsStore>().get().read_game_data;
        app.state::<profile::ProfileStore>().lineups(on, || profile::system_documents_dir().and_then(|d| profile::profile_file(&d)))
    })
    .await
}
```

  In `lib.rs`: `app.manage(game::profile::ProfileStore::new());` next to the `CatalogStore`, and `game::game_lineups,` in `generate_handler!`.
- [ ] **Step 4:** `cargo test --test profile_store` → PASS; `cargo test` all green; `cargo clippy --all-targets -- -D warnings` clean.
- [ ] **Step 5: Commit** `feat(for-you): game_lineups command`.

---

## Chunk 2: WT Live (Rust)

### Task 6: Trait methods and the disabled client

**Files:** Modify `src-tauri/src/wtlive/client.rs`, `tests/wtlive_install.rs` (two fakes), `tests/wtlive_offline.rs` (Recorder).

- [ ] **Step 1:** Add to `WtLiveClient`:

```rust
    /// The 3 most downloaded skins for vehicle `code` (first feed page only, hidden posts left out).
    fn vehicle_top(&self, code: &str) -> AppResult<Vec<WtLiveSkin>>;

    /// Skins posted after `since` (unix seconds) for `vehicles`, each matched to one of them.
    /// `vehicles` is in display order; see `live::LiveClient` for chunking and the request cap.
    /// A working client answers an empty result to an empty list without a request.
    fn for_you_new(&self, vehicles: &[String], since: i64) -> AppResult<ForYouNew>;
```

  `DisabledClient`: `Self::refuse("vehicle_top")`, `Self::refuse("for_you_new")`. Test fakes: `unreachable!()` in `wtlive_install.rs`'s first fake, delegate in its wrapper, and in `wtlive_offline.rs`'s `Recorder` record the call (vehicles and `since`) and return `Ok(vec![])` / `Ok(ForYouNew { items: vec![], checked: vehicles.len() as u32 })`.
- [ ] **Step 2:** In `tests/wtlive_offline.rs` add a test that `DisabledClient` answers `unsupported` to both.
- [ ] **Step 3:** `cargo test` compiles only after Task 7 adds the `LiveClient` impls; stub them with `todo!()` now and run `cargo test --test wtlive_offline` → PASS.
- [ ] **Step 4: Commit** `feat(for-you): WT Live client methods for For you`.

### Task 7: `LiveClient::vehicle_top` and `for_you_new`

**Files:** Modify `src-tauri/src/wtlive/live.rs`; tests in `src-tauri/tests/wtlive_live.rs` (new section "For you", reusing `FakeTransport`, `fake`, `feed_json`, `Env`).

- [ ] **Step 1: Failing tests**
  - `vehicle_top_keeps_three_for_the_vehicle`: feed answers 5 posts tagged `t_34_85` and 1 tagged `tiger`; result has 3 ids, all for `ussr_t_34_85`; the request has `sort=downloads`, `page=0`, `searchString` containing `#t_34_85`. Hide one → the next one fills in.
  - `pack_tag_chunks_never_splits_a_vehicle`: pure function test: `pack_tag_chunks(&[("a", 30 tags), ("b", 15 tags), ("c", 5 tags)], 40)` → `[[a], [b, c]]` (as index groups) and a single vehicle with 45 tags gets a chunk of its own, truncated to 40.
  - `for_you_new_matches_each_post_to_a_vehicle`: two vehicles in one chunk; feed (`sort=created`) answers posts for each, one older than `since`, one hidden, one duplicate; result items carry the right `vehicle`, newest first, `checked == 2`.
  - `for_you_new_caps_requests`: 150 vehicles (codes like `zz_a{n}` whose tag count you assert first with `api::vehicle_tags`) → exactly `MAX_FOR_YOU_REQUESTS` feed requests in the transport log, and `checked` equals the vehicles in those chunks (less than 150).
  - A blank code in the list gets no tags, opens no chunk (never a request without `searchString`, which would be the global feed) and still counts in `checked` with the chunk it rides along with, so indices stay aligned with the UI's list.
  - `for_you_new_keeps_what_it_has_when_a_later_chunk_fails`: second chunk's request returns `Err(network)` → `Ok` with first chunk's items and `checked` = first chunk's vehicle count; if the first request fails → `Err(network)`.
  - `for_you_new_of_nothing_asks_nothing`.
  - Browsing off: extend `browsing_off_sends_nothing` with both calls.
- [ ] **Step 2:** run `cargo test --test wtlive_live` → FAIL.
- [ ] **Step 3: Implement**

```rust
/// Hashtags per `for_you_new` request (one `searchString`).
pub const MAX_TAGS_PER_REQUEST: usize = 40;
/// Requests per `for_you_new` call (one a second).
pub const MAX_FOR_YOU_REQUESTS: usize = 10;
/// Skins `vehicle_top` returns.
pub const VEHICLE_TOP: usize = 3;

/// Groups consecutive vehicles (index, tags) into chunks of at most `max` tags without splitting
/// a vehicle; a vehicle with more than `max` tags gets a chunk of its own, cut to `max`.
pub fn pack_tag_chunks(tags: &[Vec<String>], max: usize) -> Vec<(Vec<usize>, Vec<String>)> {
    let mut chunks: Vec<(Vec<usize>, Vec<String>)> = Vec::new();
    for (i, own) in tags.iter().enumerate() {
        if own.is_empty() {
            // No tags (a blank code): it can't match anything; it rides along with the current chunk.
            if let Some((members, _)) = chunks.last_mut() {
                members.push(i);
            }
            continue;
        }
        let fits = chunks.last().is_some_and(|(_, t)| t.len() + own.len() <= max);
        if !fits {
            chunks.push((Vec::new(), Vec::new()));
        }
        let (members, all) = chunks.last_mut().expect("pushed above");
        members.push(i);
        for tag in own.iter().take(max - all.len().min(max)) {
            if !all.contains(tag) {
                all.push(tag.clone());
            }
        }
    }
    chunks
}
```

  (Test expectations above use this signature: `pack_tag_chunks(&[vec![..30], vec![..15], vec![..5]], 40)` → member groups `[[0], [1, 2]]`.)

  In `impl WtLiveClient for LiveClient`:

```rust
    fn vehicle_top(&self, code: &str) -> AppResult<Vec<WtLiveSkin>> {
        self.check_enabled()?;
        let code = code.trim();
        if code.is_empty() {
            return Ok(Vec::new());
        }
        let feed = Feed::Regular { sort: "downloads", tags: api::vehicle_tags(code) };
        let (posts, _) = self.feed_page(&feed, 0)?;
        Ok(posts
            .into_iter()
            .filter(|p| api::is_for_vehicle(p, code) && !self.hidden.contains(&p.skin.id))
            .take(VEHICLE_TOP)
            .map(|p| p.skin)
            .collect())
    }

    fn for_you_new(&self, vehicles: &[String], since: i64) -> AppResult<ForYouNew> {
        self.check_enabled()?;
        let tags: Vec<Vec<String>> =
            vehicles.iter().map(|v| if v.trim().is_empty() { Vec::new() } else { api::vehicle_tags(v) }).collect();
        let mut found: Vec<(i64, ForYouSkin)> = Vec::new();
        let mut checked = 0usize;
        for (n, (members, chunk_tags)) in pack_tag_chunks(&tags, MAX_TAGS_PER_REQUEST).into_iter().enumerate() {
            if n == MAX_FOR_YOU_REQUESTS {
                break;
            }
            let feed = Feed::Regular { sort: "created", tags: chunk_tags };
            let posts = match self.feed_page(&feed, 0) {
                Ok((posts, _)) => posts,
                Err(e) if n == 0 => return Err(e),
                Err(e) => {
                    tracing::debug!(code = ?e.code, "For you: a later request failed, keeping what was found");
                    break;
                }
            };
            for post in posts {
                if post.created <= since || self.hidden.contains(&post.skin.id) || found.iter().any(|(_, f)| f.skin.id == post.skin.id) {
                    continue;
                }
                if let Some(&i) = members.iter().find(|&&i| !tags[i].is_empty() && api::is_for_vehicle(&post, &vehicles[i])) {
                    found.push((post.created, ForYouSkin { vehicle: vehicles[i].clone(), skin: WtLiveSkin { is_new: Some(true), ..post.skin } }));
                }
            }
            checked += members.len();
        }
        found.sort_by_key(|(created, _)| std::cmp::Reverse(*created));
        Ok(ForYouNew { items: found.into_iter().map(|(_, s)| s).collect(), checked: checked as u32 })
    }
```

  Check `Post.created`'s type (it's compared with `since` from `time::parse_rfc3339`, an `i64` in `following_new`); adapt if it differs.
- [ ] **Step 4:** run → PASS; `cargo clippy` clean. **Step 5: Commit** `feat(for-you): top skins per vehicle and new skins per lineup`.

### Task 8: `for_you.json` store

**Files:** Create `src-tauri/src/wtlive/for_you.rs`; modify `src-tauri/src/wtlive/mod.rs` (`pub mod for_you;` and `pub use for_you::{ForYouStore, FOR_YOU_FILE};`); test `src-tauri/tests/for_you_store.rs`.

- [ ] **Step 1: Read** `src-tauri/src/wtlive/following.rs` fully and `tests/following_store.rs`: the new store copies its loading, atomic write, `.bad` handling and read-only-when-unreadable behaviour (reuse `crate::error::UnreadableFile` and the same helpers; extract a shared helper only if it is a straight move).
- [ ] **Step 2: Failing tests** mirroring the Following store tests that apply: missing file → `last_seen_at()` is **7 days before load** (so the first visit already shows the past week as new) and nothing is written; `mark_seen_at(now)` writes `{ "version": 1, "lastSeenAt": … }` atomically and a new load reads it; corrupt file → set aside as `for_you.json.bad`, value is now; unreadable file (a directory at the path) → value now and `mark_seen` refuses with the unreadable-at-launch error.
- [ ] **Step 3: Implement**

```rust
pub const FOR_YOU_FILE: &str = "for_you.json";
pub const FOR_YOU_VERSION: u32 = 1;

pub struct ForYouStore { path: PathBuf, last_seen_at: Mutex<String>, unreadable: Option<UnreadableFile> }
impl ForYouStore {
    pub fn load(path: PathBuf) -> Self;
    pub fn last_seen_at(&self) -> String;
    pub fn mark_seen(&self) -> AppResult<String>;   // mark_seen_at(&now_rfc3339())
    pub fn mark_seen_at(&self, at: &str) -> AppResult<String>;   // validated RFC 3339, written first, then kept
}
```
- [ ] **Step 4:** run → PASS. **Step 5: Commit** `feat(for-you): remember when For you was last seen`.

### Task 9: Commands and wiring

**Files:** Modify `src-tauri/src/wtlive/mod.rs`, `src-tauri/src/lib.rs`; tests `tests/wtlive_offline.rs`.

- [ ] **Step 1:** `WtLive` gains `for_you: ForYouStore` (loaded in `with_parts` from the folder of `following_path`, `FOR_YOU_FILE`), accessor `for_you()`. `WtLiveCall` gains `VehicleTop`, `ForYouNew` (both reach WT Live).
- [ ] **Step 2:** Plain function (testable without Tauri):

```rust
/// `wtlive_for_you_new`: new skins for the lineup vehicles since For you was last seen.
pub fn for_you_new(client: &dyn WtLiveClient, store: &ForYouStore, vehicles: &[String]) -> AppResult<ForYouNew> {
    let since = crate::library::time::parse_rfc3339(&store.last_seen_at()).unwrap_or(i64::MAX);
    // Blanks stay in place (they get no tags): `checked` counts positions in the UI's own list.
    let vehicles: Vec<String> = vehicles.iter().map(|v| v.trim().to_owned()).collect();
    client.for_you_new(&vehicles, since)
}
```

  Test in `wtlive_offline.rs` with the `Recorder`: codes trimmed, blanks kept in place, `since` equals the store's value.
- [ ] **Step 3:** Commands, following the existing ones (`crate::game::current_vehicles(&handle)` first so tags match the game list, then `reported`):
  - `wtlive_vehicle_top(app, code: String) -> AppResult<Vec<WtLiveSkin>>`
  - `wtlive_for_you_new(app, vehicles: Vec<String>) -> AppResult<ForYouNew>`
  - `for_you_seen(app) -> AppResult<String>` (local)
  - `for_you_mark_seen(app) -> AppResult<String>` (local, `blocking`)

  Register the four in `lib.rs`.
- [ ] **Step 4:** `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` → clean.
- [ ] **Step 5:** Ignored real-site check in `tests/wtlive_real.rs` (same style as the others there): `for_you_new(&["us_m18_hellcat", "ussr_t_34_85"], now - 30 days)` answers `Ok` and every item's `vehicle` is one of the two. Don't run it in CI. Run once by hand: `cargo test --test wtlive_real -- --ignored --nocapture for_you`.
- [ ] **Step 6: Commit** `feat(for-you): For you commands`.

---

## Chunk 3: Frontend

### Task 10: Types, queries, mock backend

**Files:** `src/types.ts`, `src/queries/game.ts`, `src/queries/wtlive.ts`, `src/dev/mockBackend.ts`, `src/dev/mockData.ts`, tests `src/dev/mockBackend.test.ts`, `src/queries/wtlive.test.tsx`.

- [ ] **Step 1: Types** (mirror Task 1): `LineupsStatus = 'ok' | 'off' | 'noProfile' | 'noLineups'`, `Lineups`, `NationLineups`, `Preset`, `ForYouSkin { vehicle: string; skin: WtLiveSkin }`, `ForYouNew { items: ForYouSkin[]; checked: number }`.
- [ ] **Step 2: Queries**
  - `game.ts`: `export const LINEUPS_KEY = ['lineups'] as const; export function useLineups({ enabled })` → `useQuery({ queryKey: [...LINEUPS_KEY, readGameData], queryFn: () => call<Lineups>('game_lineups'), enabled, refetchOnWindowFocus: true, staleTime: 0 })`, with `readGameData` from the settings query in the key (the pattern `useVehicles` uses with `fromGame`), so switching it re-reads. `enabled` is true only while the For you tab is open (spec: read on opening the tab and on focus while it is open); elsewhere the hook only reads what is cached. Rust caches by path and mtime, so a refetch is cheap.
  - `wtlive.ts`: `useVehicleTop(code, { enabled })` → key `[...WTLIVE_KEY, 'vehicle-top', code]`, `tracked(() => call('wtlive_vehicle_top', { code }))`, `staleTime: 30 * 60_000`, enabled only with `useWtLiveEnabled()`; `useForYouNew(vehicles, { fetch })` → key `[...WTLIVE_KEY, 'for-you-new', vehicles]`, `staleTime: 5 * 60_000`, like `useFollowingNew`; `useMarkForYouSeen()` → `call('for_you_mark_seen')`, on success `setQueriesData` for `'for-you-new'` to `{ items: [], checked: old.checked }` then invalidate (same pattern as `useMarkFollowingSeen`).
- [ ] **Step 3: Mock backend.** Add handlers `game_lineups`, `wtlive_vehicle_top`, `wtlive_for_you_new`, `for_you_seen`, `for_you_mark_seen` with the same semantics as Rust (read the header comment of `mockBackend.ts` and extend it with a "For you" paragraph). Mock lineups in `mockData.ts`: USA (active "Army": `us_m1a2_sep`, `us_m4_t26`; "Air": `f_4e`), USSR (active: `ussr_t_34_85`, `su_27`), GER (active: `germ_leopard_2a6`, `bf-109g-6`), GBR (`spitfire_mk9c`), ITA (`it_c1_ariete`); `current: 'us_m1a2_sep'`, `currentNation: 'USA'`. `game_lineups` answers `off` when `settings.readGameData` is false, `noProfile` without a game folder (`hasGameFolder()`). `wtlive_vehicle_top` = `visible` catalog skins for that code by downloads, first 3; `wtlive_for_you_new` = visible catalog skins whose `vehicle.code` is in the list and posted after `forYouSeenAt` (initial value: one day before the newest seeded post, so a couple show as new), `checked = vehicles.length`; both go through `reported(() => { reachWtLive(); … })` like `followingNew`.
- [ ] **Step 4: Tests** in `mockBackend.test.ts`: each handler, off/noProfile, mark seen empties new. Run `pnpm test -- src/dev/mockBackend.test.ts src/queries` → PASS.
- [ ] **Step 5: Commit** `feat(for-you): types, queries and mock backend`.

### Task 11: `forYouModel`

**Files:** Create `src/screens/Explore/forYouModel.ts`, test `forYouModel.test.ts`.

- [ ] **Step 1: Failing tests**
  - `forYouSections(lineups)`: `currentNation` first, then `NATION_ORDER`; inside a nation the active preset first, then file order; a vehicle appears once (first place wins, so an active preset keeps it); presets left empty are dropped; each section has `{ nation, presetName, presetIndex, active, vehicles: string[] }`.
  - `forYouVehicles(sections)` → flat list in section order.
  - `newCounts(answer, vehicles)` → `Map<code, number>` only for vehicles at index `< answer.checked`; `totalNew(answer)` = `answer.items.length`.
  - `forYouRows(sections)` → the virtual list's row model: `{ kind: 'header', section }` then `{ kind: 'vehicle', code, section }` per vehicle (one header per section).
- [ ] **Step 2:** run `pnpm test -- src/screens/Explore/forYouModel.test.ts` → FAIL. **Step 3:** implement (pure, no React, no i18n; import `NATION_ORDER` from `@/screens/Hangar/hangarModel`). **Step 4:** PASS. **Step 5: Commit** `feat(for-you): section model`.

### Task 12: Third tab and its pill

**Files:** `src/store/explore.ts`, `src/screens/Explore/ExploreHeader.tsx`, `src/screens/Explore.tsx`, tests `Explore.test.tsx`.

- [ ] **Step 1:** `ExploreTab = 'explore' | 'following' | 'forYou'`; `TABS` gains `'forYou'`; label `t('explore.forYou.tab')`. The pill: generalize the Following pill so the header takes `newCounts: Partial<Record<ExploreTab, number>>` (keep the `freshNews` pulse logic per tab). In `Explore.tsx`: `const forYouNew = useForYouNew(forYouVehicles(sections), { fetch: false })` read from cache only (sections from `useLineups()` data, memoized), count `enabled ? (forYouNew.data?.items.length ?? 0) : 0`; the panel renders `<ForYou />` for `'forYou'` (a stub component returning `null` until Task 13). **Order matters:** For you is checked before `!enabled`, so with WT Live off the tab still shows the lineups (local data) instead of `<WtLiveOff />`. Use `useLineups({ enabled: tab === 'forYou' })` in `Explore.tsx`, so the other tabs never read the profile.
- [ ] **Step 2:** Tests: three tabs, arrow keys cycle through three, pill shows the cached For you count, For you renders (not the WT Live off state) with WT Live off, `game_lineups` isn't called while on the Explore tab. Run → PASS. **Step 3: Commit** `feat(for-you): third Explore tab`.

### Task 13: `ForYou` tab body

**Files:** Create `src/screens/Explore/ForYou.tsx`, test `ForYou.test.tsx`. Read first: `Following.tsx` (mark-seen effect, empty states, skeletons), `SkinCard.tsx` (`SkinImage`, card install states), `SkinGrid.tsx` (how TanStack Virtual is used here), the mockup.

- [ ] **Step 1: Failing smoke tests** (mock backend, as `Following.test.tsx` does): each row of the spec's states table (`off` shows the Settings button that calls `openSettingsAt('game')`; `noProfile`; `noLineups`; error with Retry; WT Live offline shows lineups with the offline note; a vehicle with no skins shows "Search in Explore"); "All →" calls `applyVehicle(code)`; "● selected now" on `current`; leaving the tab calls `for_you_mark_seen` once, whether or not anything was new (the visit itself is what's seen).
- [ ] **Step 2: Implement.**
  - Top line: right-aligned `font-mono text-mono-sm tracking-[.04em] text-ink-4` "PROFILE SAVED {time}" from `savedAt` (format with the existing `@/lib/format` helpers).
  - Virtual list over `forYouRows(sections)`: header rows (`text-card text-ink-1` "{Nation} · {preset}", right side mono `t('explore.forYou.count', { count })` with ACTIVE prefix when active), vehicle rows (grid `130px minmax(0,1fr)`, border-top `border-line-1`): name via `useVehicleName()` resolving the code against `useVehicles()` (fallback: the code), sub-line "● selected now" or `t('explore.forYou.new', { count })` in `text-amber`, then 3 `SkinImage` thumbnails as buttons (`openSkin(id)`) carrying `SkinCard`'s install states (reuse its helper, don't copy it), skeleton thumbnails while `useVehicleTop` is pending, and an "All →" ghost link with Lucide `ArrowRight size={14} strokeWidth={1.75}`.
  - Each vehicle row calls `useVehicleTop(code)` itself, so only mounted (visible) rows fetch.
  - `useForYouNew(vehicles, { fetch: started })` where `started` turns true when no visible row's top query is pending, or 15 s after mount (`setTimeout`), whichever first.
  - Mark seen on leaving: copy Following's `pendingMark` pattern with its own module-level timer, without the "only if shown" guard.
  - No hex values; tokens only. All text through `t()`.
- [ ] **Step 3:** `pnpm test -- src/screens/Explore` → PASS; `pnpm typecheck` clean.
- [ ] **Step 4: Commit** `feat(for-you): For you tab`.

---

## Chunk 4: Strings, docs, checks

### Task 14: Strings in nine languages

**Files:** `src/i18n/{en,it,de,ru,fr,es,pl,pt-BR,zh-CN}.json`.

- [ ] **Step 1:** Add `explore.forYou.*` keys used in Tasks 12–13 (tab, savedAt, active, count with plural forms, selectedNow, new with plural forms, all, noSkins, searchInExplore, offline note reuse, the four empty states with the `off` state's "Open Settings" button, retry, and `presetFallback` "Preset {{n}}" for an empty preset name), `common.errors.backend.lineupsUnreadable` / `lineupsUnparsable` (English text exactly equal to the Rust constants), and change `settings.game.readGameData` / `readGameDataHelper` and the About `privacy` text as in spec §1. Translate by hand in every language following the existing tone and the game's own terms (Italian: "Per te", "Preselezione", "Formazione attiva"). No em dashes.
- [ ] **Step 2:** `pnpm i18n:check` and `pnpm test -- src/lib/errors.test.ts` → clean.
- [ ] **Step 3: Commit** `feat(for-you): strings in nine languages`.

### Task 15: Docs

- [ ] `DESIGN_NOTES.md`: a "For you (2026-10-16)" row: the profile file, the two blocks only, the request patterns and caps, the seen store, the reuse of `readGameData`.
- [ ] `README.md`: one feature bullet.
- [ ] `docs/wtlive-terms.md`: §7 (requests stay on user action, 1 req/s, caps), §8 (reading the player's profile file, read-only, two blocks), §10 code map (new methods and files).
- [ ] Commit `docs(for-you): design notes, README, WT Live terms`.

### Task 16: Full checks and visual comparison

- [ ] `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- [ ] `pnpm typecheck && pnpm test && pnpm i18n:check && pnpm build` (no mock chunk or strings in `dist/`, as before)
- [ ] `pnpm dev:mock`, open Explore → For you at 1440×900 and 1100×700, compare with mockup B (spacing, colors, type), check the states (toggle Settings → Game → Read data, Settings → WT Live off).
- [ ] `pnpm tauri dev` on the author's machine: For you shows the real lineups (USA Army first with M4 T26 selected), top skins load row by row, the pill appears after a visit.
- [ ] Commit any fixes `fix(for-you): …`.
