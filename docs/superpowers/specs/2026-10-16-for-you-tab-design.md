# For you: skins for the vehicles in your lineups

Status: design approved by the author on 2026-10-16. Next step: implementation plan.
Visual reference: [2026-10-16-for-you-mockup.html](2026-10-16-for-you-mockup.html) (mockup B is
the approved one; mockup A, the filter chip, is out of scope).

## Goal

A third tab in Explore, **For you** (it: "Per te"), that suggests WT Live skins for the vehicles
the player actually uses: the vehicles in their War Thunder lineups (slotbar presets), with the
active lineup of each nation first. Each vehicle shows its 3 most downloaded skins and how many
skins were posted since the user last looked at the tab.

Out of scope: the "I miei veicoli" filter chip in the Explore grid (possible later, it can reuse
the same lineup data), vehicles from `unitsSettings` (458 entries on the author's profile,
test drives included: too broad and too many to preview), any server-side source of owned
vehicles (Gaijin account, third-party stats sites).

## Where the data comes from

War Thunder keeps a local copy of the player's profile settings in a **text** BLK:

```
<Documents>\My Games\WarThunder\Saves\<uid>\production\global.blk
<Documents>\My Games\WarThunder\Saves\last\lastUid          (the uid of the last account)
<Documents>\My Games\WarThunder\Saves\last\production\global.blk   (copy for the last account)
```

Two blocks matter, each appearing once, nested under `content{ profile{ … } }` at some depth
(find them by name, not by a fixed path):

```
slotbar_presets{
  presetsVersion:i=1
  country_usa{
    preset:t="<crew>|<crew ids>|<unit codes>|<preset name>|<game mode>|<more crew ids>"
    preset:t="…"
    selected:i=1            // index into this country's preset list; missing = 0
  }
  …
}

selectedAir{
  current_model:t="us_m4_t26"   // the vehicle selected in the hangar right now
  usa:t="us_m4_t26"             // last selected vehicle per nation (bare nation names)
  …
}
```

`<unit codes>` is a comma-separated list of vehicle codes (aircraft codes have no nation prefix,
for example `d_371`, `yak-7b`). The last field may be empty. The preset name is the player's own
text (localized defaults such as "Preselezione #1"). Observed on the author's profile (game
2.59.0.13): 10 nations, 25 presets (1 to 4 per nation), about 70 distinct vehicles in all
presets, about 30 in the active ones. The file is about 190 KB and the game rewrites it when the
profile changes.

## 1. Reading the lineups (Rust, new module `game::profile`)

**Locating the file.**
- Documents folder: `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders\Personal`
  read with `winreg` (already approved, Windows only), environment variables expanded
  (`%USERPROFILE%`), which also covers a Documents folder redirected to OneDrive. Fallback:
  `%USERPROFILE%\Documents`. The registry read is passed in as a function argument so tests use
  a fake. Off Windows (Rust stays OS-agnostic where cheap): only the fallback.
- Profile: `Saves\last\lastUid` (trimmed text, digits only) → `Saves\<uid>\production\global.blk`.
  If that file is missing, `Saves\last\production\global.blk`. If neither exists: no profile.

**Block scanner, privacy first.** The rest of `global.blk` holds unrelated personal settings.
Livery never parses or keeps the whole file. A small lexer walks the text with the same lexical
rules as `library::blk`: `"…"`, `'…'` and tripled `"""…"""` strings with `~` escapes, `//` line
and `/* */` block comments, any whitespace between a name and `{`. Outside strings and comments
it looks for the identifiers `slotbar_presets` and `selectedAir` followed by `{` (a whole token,
so `xselectedAir` doesn't match), and cuts each block out by brace matching, with a cap of 64 KB
per block. Only those two slices go through `library::blk::parse`. Nothing else from the file is
stored, sent to the UI or logged; the log gets counts and the error kind only, and
`AppError.detail` never contains file content (the path is allowed: paths are hidden in the UI).

**Model** (`model.rs`, serialized camelCase, mirrored in `src/types`):

```rust
pub enum LineupsStatus { Ok, Off, NoProfile, NoLineups }

pub struct Lineups {
    pub status: LineupsStatus,
    pub saved_at: Option<String>,         // RFC 3339, the file's modification time
    pub current: Option<String>,          // selectedAir.current_model
    pub current_nation: Option<Nation>,   // see below
    pub nations: Vec<NationLineups>,      // game nation order; nations without presets left out
}

pub struct NationLineups {
    pub nation: Nation,                   // `country_<name>` via catalog::nation_of
    pub presets: Vec<Preset>,             // file order
}

pub struct Preset {
    pub name: String,                     // player's text, trimmed; empty → UI shows "Preset N"
    pub active: bool,                     // index == selected
    pub vehicles: Vec<String>,            // codes, file order, empty and duplicate codes dropped
}
```

Parsing rules:
- A `preset:t` string is split on `|`. Fields 0 to 2 are crew, crew ids, unit codes; the last two
  are game mode and extra crew ids; the name is everything between, joined back with `|` (so a
  name containing `|` survives). Fewer than 6 fields: the preset is skipped (counted in the log).
- `selected` missing, malformed or out of range: 0.
- Unknown `country_*` names are skipped. Codes are not checked against the catalog: the UI
  resolves names and types and shows unknown codes as they are.
- `current_nation`: the `selectedAir` key (other than `current_model`) whose value equals
  `current`, mapped with `nation_of("country_" + key)`; otherwise the nation of the first preset,
  in game nation order and file order, that contains `current`; otherwise none.
- A usable preset has at least one vehicle code. `selectedAir` that doesn't parse is treated as
  missing (the lineups are still usable).

**Command** `game_lineups() -> Result<Lineups, AppError>`:

| Situation | Result |
|---|---|
| `readGameData` off | `status: off`, no disk access |
| no profile file | `status: noProfile` |
| file can't be read (sharing violation, permissions) | `AppError { code: io }`, message `lineupsUnreadable` |
| `slotbar_presets` missing, or present with no usable preset | `status: noLineups` (a fresh profile) |
| `selectedAir` missing | `status: ok`, `current` and `current_nation` none |
| `slotbar_presets` found but unterminated (end of file before its `}`, the usual mid-write case), `blk::parse` fails on it, or it hits the 64 KB cap | after one retry (the game may be mid-write), `AppError { code: parse }`, message `lineupsUnparsable` |

Both messages are new and localized in the nine languages like the other backend errors. The
result is cached in memory keyed by the resolved path, size and modification time, so a call
re-reads only when one changed (an account switch changes the path). The UI calls the command
when the tab opens and when the window regains focus while the tab is open.

**The `readGameData` switch** (Settings → Game) governs this too. Its label and helper change to
cover both uses, in the nine languages: label "Read data from the game", helper "Livery reads
vehicle names from the game's files and your lineups from your War Thunder profile, without
changing them. Off: a smaller built-in vehicle list and no suggestions in For you." The About
privacy text gains the same fact.

## 2. WT Live requests

Both requests are new methods on the `WtLiveClient` trait (`wtlive/client.rs`), so `LiveClient`,
the disabled client (kill switch / WT Live off → its usual disabled error) and the test fake all
implement them. They use the existing queue (1 request/second with backoff), feed-page cache
(`LISTING_TTL`, 30 minutes), robots.txt and hidden posts. Nothing is fetched at startup or in the
background: only while the For you tab is open (the user's action).

**Top skins of one vehicle.** `vehicle_top(code) -> Vec<WtLiveSkin>`, command
`wtlive_vehicle_top`: `Feed::Regular { sort: "downloads", tags: api::vehicle_tags(code) }`,
page 0 only, posts kept when `api::is_for_vehicle(post, code)` and not hidden, first 3 returned.
One request per vehicle; the cache key is the feed's, so Explore filtered by the same vehicle and
sorted by downloads reuses the page.

**New skins of the lineups.** `for_you_new(vehicles: &[String], since) -> ForYouNew`, command
`wtlive_for_you_new(vehicles)` with `since` read from the For you store:

```rust
pub struct ForYouSkin { pub vehicle: String, pub skin: WtLiveSkin }  // vehicle = the lineup code it matched
pub struct ForYouNew { pub items: Vec<ForYouSkin>, pub checked: u32 } // checked = how many vehicles,
                                                                      // from the start of the list, were covered
```

- `vehicles` is one flat list in display order (§3), so the active presets come first.
- Walking the list, tags (`vehicle_tags` of each vehicle) are packed into chunks of at most
  `MAX_TAGS_PER_REQUEST = 40`; a vehicle's tags never straddle two chunks. One
  `Feed::Regular { sort: "created", tags }` request per chunk, page 0 only, at most
  `MAX_FOR_YOU_REQUESTS = 10` requests. About 70 vehicles × ~4 tags fit in about 7.
- A post counts when `created > since`, it isn't hidden, and `is_for_vehicle` matches a vehicle
  of its chunk (the first match in list order wins). Duplicates are dropped.
- If a chunk's request fails after the first one succeeded, the call returns what it has, with
  `checked` stopping before that chunk; a failure of the first request is the call's error.
- Counts are a lower bound (page 0 of a feed shared by up to 40 tags), as with Following.
- The OR semantics of several hashtags in one `searchString` is what `Feed::Regular` already
  relies on for one vehicle's tags. The fake-client tests cover chunking and assignment; the plan
  includes one ignored real-site check in `wtlive_real` with a two-vehicle chunk.

**Seen state.** New store `<appData>/for_you.json`: `{ "version": 1, "lastSeenAt": "<RFC 3339>" }`,
written atomically and loaded tolerantly like `following.json` (corrupt → set aside as `.bad`,
unreadable → read-only for the session). A missing file reads as 7 days ago (not written), so the
first visit already shows the past week as new. Commands `for_you_seen()` and
`for_you_mark_seen()`; the UI marks it whenever the user leaves the tab after a visit, with the
same delayed mark Following uses (StrictMode-safe).

## 3. Interface

**Tab.** `ExploreTab` gains `'forYou'`; the header shows Explore · Following · For you. The For
you tab carries an "N new" pill like Following's, computed only from a `wtlive_for_you_new`
answer already in the query cache (no request to draw the pill).

**Layout** (mockup B): a line at the top with the profile's save time in mono ("PROFILE SAVED
08:34", from `saved_at`). Then one section per nation: `current_nation` first, then the game's
nation order. Inside a nation, the active preset first, labelled ACTIVE, then the other presets
in file order. Section title: "<Nation> · <preset name>"; on the right, in mono, "ACTIVE · N
VEHICLES" or "N VEHICLES", counted after deduplication.

**Vehicle rows.** Name in the UI language (`useVehicleName`), "● selected now" when it is
`current`, "N new" (amber) from `ForYouNew.items` when the vehicle is within `checked`, the 3 top
skins as small cards (reuse `SkinImage` and the card install states; click → Skin detail), and
"All →" which calls `applyVehicle(code)` (Explore filtered by that vehicle). Unknown codes show
the code itself.

**Deduplication.** A vehicle appears once, in the first place it would appear in the order above
(so the active preset wins). A preset left with no vehicles is not shown. Ordering,
deduplication, the flat vehicle list for `wtlive_for_you_new` and the per-vehicle and total new
counts live in a pure module `src/screens/Explore/forYouModel.ts`.

**Loading order.** The list is virtualized (TanStack Virtual); each visible row runs its own
`wtlive_vehicle_top` query, so requests follow the scroll and the top rows (active lineups) load
first. `wtlive_for_you_new` starts when no `wtlive_vehicle_top` query of a visible row is still
pending, or 15 seconds after the tab opened, whichever comes first, so it doesn't hold the rows up
in the shared queue and the pill is never postponed indefinitely. Rows not yet loaded show skeleton cards (no spinners).

**States.**

| Situation | What the tab shows |
|---|---|
| `status: off` | Empty state: suggestions need the game's data; button to Settings → Game. |
| `status: noProfile` | Empty state: "Start War Thunder once on this PC, then come back." |
| `status: noLineups` | Empty state: "No lineups found in your War Thunder profile." |
| `game_lineups` error | Empty state with the localized message and Retry. |
| WT Live off or offline | Lineups still listed (local data); rows show the offline note Following uses; no pill. |
| Vehicle with no skins | "No skins on WT Live for this vehicle" and "Search in Explore". |

**Strings.** Keys under `explore.forYou.*` (plus the Settings and About changes in §1) in all
nine languages, no em dashes, checked by `pnpm i18n:check`.

## 4. Tests

Rust (fixtures in `src-tauri/tests/fixtures/profile/`, trimmed and anonymized from the author's
file: uid replaced, unrelated blocks reduced to a few lines):
- block scanner: both blocks found at any depth; braces and the block names inside `"…"`, `'…'`,
  `"""…"""`, `~` escapes and both comment kinds are ignored; whitespace before `{`; whole-token
  match; the 64 KB cap; a missing block;
- lineups parser: several presets, `selected` present, missing, malformed and out of range;
  short `preset` strings skipped; a name containing `|`; unknown countries skipped; duplicate and
  empty codes dropped; aircraft codes without a prefix kept; `current_nation` from a preset and
  from the `selectedAir` key;
- path resolution with a fake registry and a temp folder: `lastUid` → uid folder, fallback to
  `last\production`, nothing found → `noProfile`;
- `readGameData` off → `off` without disk access; the cache re-reads on a size, mtime or path
  change only; the status table above, one test per row;
- `for_you_new` with the fake client: chunking at 40 tags without splitting a vehicle, the
  10-request cap and `checked`, a later chunk failing (partial answer) and the first failing (error), the `since` filter, hidden posts, assignment to the right vehicle,
  duplicates dropped; `vehicle_top` keeps 3 and filters by vehicle; the disabled client refuses
  both;
- `for_you.json` store: the same cases as the Following store tests.

Frontend (Vitest + RTL):
- `forYouModel`: nation order with `current_nation` first, active preset first, deduplication,
  empty presets hidden, the flat list order, new counts per vehicle (only within `checked`) and
  in total;
- tab smoke tests on the mock backend: each state in the table above, "All →" applies the vehicle
  filter, marking seen on leaving the tab;
- mock data for `pnpm dev:mock` (the author's lineups, anonymized) for the visual check against
  the mockup.

## Files touched (expected)

- Rust: `game/profile.rs` (new), `game/mod.rs`, `wtlive/client.rs` (trait, disabled client),
  `wtlive/live.rs`, `wtlive/for_you.rs` (new store), the test fake client, `lib.rs` (commands,
  state), `model.rs` (types), `error.rs` messages, fixtures.
- Frontend: `src/types`, `store/explore.ts`, `screens/Explore/ExploreHeader.tsx`,
  `screens/Explore.tsx`, `screens/Explore/ForYou.tsx` (new), `screens/Explore/forYouModel.ts`
  (new), `queries/wtlive.ts`, a `useLineups` query next to the other game queries,
  `dev/mockData.ts`, `src/i18n/*.json`, `screens/Settings/GameSection.tsx` (strings only).
- Docs: `DESIGN_NOTES.md` (a "For you" row), `README.md` features, `docs/wtlive-terms.md` §7 and
  §10 (the new request patterns stay within the posture) and §8 (reading the game's files gains
  the profile read).

No new dependencies.
