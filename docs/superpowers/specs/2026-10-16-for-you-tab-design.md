# For you: skins for the vehicles in your lineups

Status: design approved by the author on 2026-10-16. Next step: implementation plan.

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

Two blocks matter, both under `content{ profile{ … } }` at some depth (find them by name, not
by a fixed path):

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
  usa:t="us_m4_t26"             // last selected vehicle per nation
  …
}
```

`<unit codes>` is a comma-separated list of vehicle codes (aircraft codes have no nation prefix,
for example `d_371`, `yak-7b`). The preset name is the player's own text (localized defaults such
as "Preselezione #1"). Observed on the author's profile (game 2.59.0.13): 10 nations, 1 to 4
presets each, about 70 distinct vehicles in all presets, about 30 in the active ones. The file is
about 190 KB and the game rewrites it when the profile changes.

## 1. Reading the lineups (Rust, new module `game::profile`)

**Locating the file.**
- Documents folder: `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders\Personal`
  read with `winreg` (already approved), environment variables expanded (`%USERPROFILE%`), which
  also covers a Documents folder redirected to OneDrive. Fallback: `%USERPROFILE%\Documents`.
  The registry read sits behind a function argument so tests pass a fake.
- Profile: `Saves\last\lastUid` (trimmed text, digits only) → `Saves\<uid>\production\global.blk`.
  If that file is missing, `Saves\last\production\global.blk`. If neither exists: no profile.
- Off Windows (Rust stays OS-agnostic where cheap): no registry, only the fallback path.

**Parsing, privacy first.** The rest of `global.blk` holds unrelated personal settings. Livery
never parses or keeps the whole file: a small scanner finds the `slotbar_presets{` and
`selectedAir{` blocks by name, cuts each one out by brace matching (quotes and `~` escapes
respected, a size cap per block of 64 KB), and only those two slices go through the existing
text BLK parser (`library::blk::parse`). Nothing else from the file is stored, sent to the UI or
written to the log (the log gets only counts and the error kind).

**Model.**

```rust
pub enum LineupsStatus { Ok, Off, NoProfile }   // serialized camelCase

pub struct Lineups {
    pub status: LineupsStatus,
    pub read_at: Option<String>,          // RFC 3339, file modification time
    pub current: Option<String>,          // selectedAir.current_model
    pub nations: Vec<NationLineups>,      // game nation order; nations without presets left out
}

pub struct NationLineups {
    pub nation: Nation,                   // from `country_<name>` via catalog::nation_of
    pub selected: Option<String>,         // selectedAir.<nation>
    pub presets: Vec<Preset>,             // file order
}

pub struct Preset {
    pub name: String,                     // player's text, trimmed; empty → UI shows "Preset N"
    pub active: bool,                     // index == selected (default 0)
    pub vehicles: Vec<String>,            // codes, file order, empty and duplicate codes dropped
}
```

A `preset:t` string with fewer than 3 `|` fields is skipped (logged as a count). Unknown
`country_*` names are skipped. A malformed `selected` falls back to 0. Codes are not checked
against the catalog here: the UI resolves names and types and shows unknown codes as they are.

**Command** `game_lineups() -> Result<Lineups, AppError>`.
- `readGameData` off → `{ status: off }` without touching the disk.
- No profile file → `{ status: noProfile }`.
- File present but unreadable (sharing violation, permissions) → `AppError { code: io }`;
  neither block found or a block that doesn't parse → `AppError { code: parse }`. Both use new
  localized messages (`lineupsUnreadable`, `lineupsUnparsable`) in the nine languages.
- The result is cached in memory with the file's size and modification time; a call re-reads
  only when they changed. The UI calls it when the tab opens and when the window regains focus
  while the tab is open.

**The `readGameData` switch** (Settings → Game) governs this too. Its label and helper change
to cover both uses, in the nine languages: label "Read data from the game", helper "Livery reads
vehicle names from the game's files and your lineups from your War Thunder profile, without
changing them. Off: a smaller built-in vehicle list and no For you tab suggestions." The About
privacy text gains the same fact.

## 2. WT Live requests

Both requests go through the existing `LiveClient`: the 1 request/second queue with backoff,
the 24 h cache, robots.txt, the kill switch, hidden posts. Nothing is fetched at startup or in
the background: only while the For you tab is open (the user's action).

**Top skins of one vehicle.** New command `wtlive_vehicle_top(code) -> Vec<WtLiveSkin>`:
`Feed::Regular { sort: "downloads", tags: api::vehicle_tags(code) }`, page 0 only, posts kept
when `api::is_for_vehicle(post, code)` and not hidden, first 3 returned. One request per vehicle,
and the cache key is the feed's, so Explore filtered by the same vehicle and sort reuses it.

**New skins of the lineups.** New command
`wtlive_for_you_new(groups: Vec<Vec<String>>) -> Vec<WtLiveSkin>`, one group per preset (the
vehicles the UI shows in it, see §3), `since` read from the For you store (below):
- per group, the union of `vehicle_tags` of its vehicles, split into chunks of at most
  `MAX_TAGS_PER_REQUEST = 40` tags; one `Feed::Regular { sort: "created", tags }` request per
  chunk, page 0 only;
- at most `MAX_FOR_YOU_REQUESTS = 20` requests per call, groups in the order given (the UI sends
  active presets first);
- a post counts when `created > since`, it isn't hidden, and `is_for_vehicle` matches one of the
  group's vehicles; the returned skin carries that vehicle's code. Duplicates across chunks and
  groups are dropped.
The OR semantics of several hashtags in one `searchString` is what `Feed::Regular` already relies
on for one vehicle's tags; a test with the fake client covers the assignment, and the plan
includes one ignored real-site check (`wtlive_real`) with a two-vehicle group.

**Seen state.** New store `<appData>/for_you.json`: `{ "version": 1, "lastSeenAt": "<RFC 3339>" }`,
written atomically and loaded tolerantly exactly like `following.json` (missing → now, corrupt →
set aside as `.bad`, unreadable → read-only for the session). Commands `for_you_seen()` (read)
and `for_you_mark_seen()`; the UI marks it when the user leaves the tab, with the same delayed
mark Following uses (StrictMode-safe).

## 3. Interface

**Tab.** `ExploreTab` gains `'forYou'`; the header shows Explore · Following · For you. The For
you tab carries an "N new" pill like Following, computed only from the `wtlive_for_you_new`
answer already in the query cache (no request to draw the pill).

**Layout** (see the approved mockup B): a line at the top with the read time in mono
("READ AT 08:34"). Then one section per nation: the nation of `current` first, then the game's
nation order. Inside a nation, the active preset first, labelled ACTIVE, then the other presets
in file order. Section title: "<Nation> · <preset name>".

**Vehicle rows.** Name in the UI language (`useVehicleName`), "● selected now" when it is
`current`, "N new" (amber) from the new-skins answer, the 3 top skins as small cards (reuse
`SkinImage` and the card install states; click → Skin detail), and "All →" which calls
`applyVehicle(code)` (Explore filtered by that vehicle). Unknown codes show the code itself.

**Deduplication.** A vehicle appears once, in the first place it would appear in the order above
(so the active preset wins). A preset left with no vehicles is not shown. This ordering and
deduplication live in a pure module `src/screens/Explore/forYouModel.ts`.

**Loading.** The list is virtualized (TanStack Virtual); each visible row runs its own
`wtlive_vehicle_top` query, so requests follow the scroll and the active lineups, at the top,
load first. Rows not yet loaded show skeleton cards (no spinners). `wtlive_for_you_new` runs once
per tab visit with all groups.

**States.**
| Situation | What the tab shows |
|---|---|
| `status: off` | Empty state: suggestions need the game's data; button to Settings → Game. |
| `status: noProfile` | Empty state: "Start War Thunder once on this PC, then come back." |
| `game_lineups` error | Empty state with the localized message and Retry. |
| No presets at all | Empty state: "No lineups found in your War Thunder profile." |
| WT Live off or offline | Lineups still listed (local data); rows show the offline note Following uses; no pill. |
| Vehicle with no skins | "No skins on WT Live for this vehicle" and "Search in Explore". |

**Strings.** Keys under `explore.forYou.*` (plus the Settings and About changes in §1) in all
nine languages, no em dashes, via the existing i18n check.

## 4. Tests

Rust (fixtures in `src-tauri/tests/fixtures/profile/`, trimmed and anonymized from the author's
file: uid replaced, unrelated blocks reduced to a few lines):
- block scanner: finds both blocks at any depth, ignores braces inside quoted strings and `~`
  escapes, respects the size cap, reports a missing block;
- lineups parser: several presets, `selected` present, missing and malformed, short `preset`
  strings skipped, unknown countries skipped, duplicate and empty codes dropped, aircraft codes
  without a prefix kept;
- path resolution with a fake registry and a temp folder: `lastUid` → uid folder, fallback to
  `last\production`, nothing found → `noProfile`;
- `readGameData` off → `off` without disk access; mtime cache re-reads only on change;
- `wtlive_for_you_new` with the fake client: tag chunking, request cap, `since` filter, hidden
  posts, assignment to the right vehicle, duplicates dropped; `wtlive_vehicle_top` keeps 3 and
  filters by vehicle;
- `for_you.json` store: same cases as the Following store tests.

Frontend (Vitest + RTL):
- `forYouModel`: nation order with `current` first, active preset first, deduplication, empty
  presets hidden, new counts per vehicle and in total;
- tab smoke tests on the mock backend: each state in the table above, "All →" applies the vehicle
  filter, marking seen on leaving the tab;
- mock data for `pnpm dev:mock` (the author's lineups, anonymized) for the visual check against
  the mockup.

## Files touched (expected)

- Rust: `game/profile.rs` (new), `game/mod.rs`, `wtlive/live.rs`, `wtlive/for_you.rs` (new
  store), `lib.rs` (commands, state), `model.rs` (types), `error.rs` messages, fixtures.
- Frontend: `store/explore.ts`, `screens/Explore/ExploreHeader.tsx`, `screens/Explore.tsx`,
  `screens/Explore/ForYou.tsx` (new), `screens/Explore/forYouModel.ts` (new),
  `queries/wtlive.ts`, `queries/game.ts` or equivalent, `types`, `dev/mockData.ts`,
  `src/i18n/*.json`, `screens/Settings/GameSection.tsx` (strings only).
- Docs: `DESIGN_NOTES.md` (a "For you" row), `README.md` features, `docs/wtlive-terms.md` §7/§10
  (the new request patterns stay within the posture).

No new dependencies.
