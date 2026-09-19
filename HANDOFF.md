# Handoff — Livery (updated 2026-09-19, after the M5/M6 integration)

Read this first in a new session. Then read `CLAUDE.md`, `DESIGN_NOTES.md` (every decision so far, including the "M5 ·" and "M6 ·" rows) and the handoff spec in `design_handoff_livery/` (README → DATA_MODEL → BUILD_PLAN).

## Where things stand

| Milestone | State | Commit |
|---|---|---|
| M0 scaffold | done | `993bb8e` |
| M1 global chrome | done | `9194854` |
| M2 game detection + First run | done. Detects the author's real Steam install: `D:\SteamLibrary\steamapps\common\War Thunder`, 2.59.0.13 (DESIGN_NOTES "M2 · Real-world facts"). | `85623c1` |
| M3 library, My Hangar, Collections | done. Uses a JSON index, not SQLite (see "Pending approvals"). The 30-day backup expiry job (BUILD_PLAN M6) is already here: it purges at launch and before every library command. | `3503850` |
| M4 install queue | done **for skin folders**. ZIP/RAR/7z wait for crate approval; the acceptance test "drop three fixture archives" needs those crates plus archive fixtures. | `2c86010` |
| M5 WT Live | **UI done on the mock; network pending approval.** Explore (filters, vehicle autocomplete, sort, paged virtual grid, card install states, offline/empty states), Following (vehicles and authors, "N new"), Skin detail (Gallery with zoom and compare, Textures, Try in game with Keep/Discard, side panel with Follow and Add to collection), palette skins and vehicles, sidebar count, Hangar cards opening the detail. Rust: `WtLiveClient` seam with a disabled client (`unsupported` + `net://status` offline), real Following store (`following.json`). | `feat(m5): …` (see git log) |
| M6 Settings/polish | **Settings done** (7 sections, reduce motion with a real 'off' override, deferred Clear backups by ids, game folder change through First run 'choose', licenses dialog). The library is now **one index per game folder**. Still to do: the polish list below and packaging. | `feat(m6): …` (see git log) |

Checks at the latest commit: `pnpm typecheck` clean · `pnpm test` 607 passing · `cargo test` 350 passing (2 ignored real-install tests) · `cargo clippy --all-targets -D warnings` clean · `cargo fmt --check` clean (`src-tauri/rustfmt.toml`) · `pnpm build` has no mock chunk or mock strings in `dist/`. Visual check at 1440×900 against the prototype (Explore, Skin detail, Settings) matched; the deltas are the ones recorded in DESIGN_NOTES.

### What still depends on the author
- WT Live can't be reached from the app until an HTTP client is approved. The real app shows the designed offline state everywhere WT Live is involved; the full UI can be seen with `pnpm dev:mock`.
- Archives (ZIP/RAR/7z), opening links, Start with Windows and updates are shown as unavailable, with a reason, until their crates/plugins are approved.

## Next steps (in order)

1. **M6 polish:**
   - A11y pass: axe on every screen, keyboard, contrast table.
   - i18n completeness. BUILD_PLAN wants de/ru/fr **keys present** with English fallback; there are no de/ru/fr files yet (`useLanguageSync` already falls back to English, and `<html lang>` follows what's shown). Also localize backend errors by `code`: about 12 toasts, the queue rows and the watch-folder row show the backend's English `AppError.message` in the Italian UI.
   - Cold start < 1.5 s with skeletons.
   - A log file in app data: release builds have no console, and tracing writes only to stdout. Do it with a `tracing_subscriber` writer, not a new crate, unless approved.
   - Packaging: NSIS config (the icon set is already generated), a code-signing placeholder, and a GitHub Actions release workflow on windows-latest (needs a GitHub repo, see below).
   - A root `README.md` for developers.
   - The M6 acceptance run: installer on a clean Windows 11 VM, first run to first installed skin in < 2 min. Without archive or WT Live support a typical user can only install a skin **folder**, so this depends on the approvals.
2. **Small leftovers** (found by the reviewers, low severity):
   - `following.json` and `settings.json` that can't be read for a reason other than "not found" (a sharing violation, permissions) load as empty and are overwritten on the next change. Decide whether to refuse writes until a successful reload.
   - Skin detail's "← Explore" always goes to Explore, also when the detail was opened from My Hangar or the palette (prototype behaviour). Returning to the opener would be nicer.
   - Mock data: "Blue Angels Tribute" in the hangar looks like a WT Live skin but has no `sourceId`, so it behaves as a local skin.
   - `TODO(M5)` in `src/screens/Collections/MemberCard.tsx`: the WT Live screenshot for WT Live skins. `HangarSkin` has no image field, and posts have no images until HTTP lands.
   - When remote screenshots arrive, the Tauri CSP needs an `img-src` entry for the WT Live image host.
3. When the author approves dependencies (below), implement what they unlock. The seams are ready: `WtLiveClient` + `Parser` (module doc in `src-tauri/src/wtlive/mod.rs`), `archive::SkinSource`, and the unavailable controls in Settings.

## Pending dependency approvals (ask the author; CLAUDE.md requires it)

| Dependency | Unlocks | Status today |
|---|---|---|
| HTTP client (`reqwest` + rustls) + `scraper` (or WT Live's JSON endpoints) | M5 backend: search, post, following-new, download for install / Try in game; parser tests against saved-HTML fixtures (BUILD_PLAN M5), which someone must capture online | `DisabledClient` answers `unsupported` + `net://status` offline; the UI shows the designed offline state. Check WT Live's terms of use before scraping. |
| `zip`, `unrar`, `sevenz-rust` | Installing .zip/.rar/.7z (M4), and ZIP export ("zip per skin", DESIGN_NOTES "M3 · Export"). Add `ZipSource` etc. implementing `archive::SkinSource`, flip `ARCHIVES_SUPPORTED` in `src/screens/Queue/queueModel.ts`, add the three archive fixtures | Archives become `unsupported` error rows; skin folders install; export copies folders |
| `tauri-plugin-opener` | "Open original post", About links, "Show in Explorer" | Detail copies the post URL to the clipboard; About links are unavailable |
| `tauri-plugin-autostart` | Settings → Start with Windows | Switch unavailable, with a helper |
| `tauri-plugin-updater` + signing key + a public release endpoint | Settings → Updates | Controls unavailable, with a helper |
| `tauri-plugin-os` / `tauri-plugin-fs` | Listed in BUILD_PLAN M0 capabilities | Probably **not needed** (Rust does all disk I/O; nothing needs OS info in JS). Confirm with the author and record it. |
| `rusqlite` (optional) | SQLite index as DATA_MODEL suggests | JSON `library.json` v2 works well (README allows JSON) |
| `notify` (optional) | Event-based watcher | Polling watcher (2 s) works |

Already approved and in use: `tauri-plugin-dialog`, `winreg`, jsdom/testing-library/axe-core (dev), fonts copied from npm.

## Decisions the author needs to make (not dependencies)

- **Vehicle list source (BUILD_PLAN open decision 3).** `src/data/vehicles.json` is still the 9-vehicle placeholder seed. It feeds the Explore autocomplete and class chips, the palette and the Rust nation/type fallback. Which public datamine should we use, and is its licence OK to ship?
- **GitHub repo / remote.** There is no git remote. The release workflow and the updater endpoint need one.
- **WT Live.** Is scraping allowed by its terms? Who captures the saved-HTML fixtures (needs network access)?
- **Following a vehicle.** The README only designs the author Follow button. The Skin detail now has a small Follow toggle on the VEHICLE row of the side panel (DESIGN_NOTES "M5 · Skin detail · side panel"). Is that OK?
- **Two WT Live posts in the same folder.** Folders are named `<code>_<author>`, so two different posts by one author for one vehicle clash. The mock installs the second into `<folder> (2)`; the Rust plan applies the conflict policy as in the queue. Which rule should the real pipeline use?
- **Hangar clicks.** WT Live skins open their Skin detail on click/Enter (prototype); local skins still select on click, because there is no texture viewer (DESIGN_NOTES "M3 · Hangar interaction"). OK?

## Open questions for the author (already in DESIGN_NOTES)

- The Italian sidebar label is "Da installare", because "Coda di installazione" truncates next to the badge. Is that OK?
- Activating a collection isn't undoable. `activeCollectionId` stays set after manual toggles, and undoing the delete of the active collection doesn't re-activate it.
- `undo_replace` deletes the new copy without a backup (its source still exists).
- A pack with two skins for the same vehicle installs only the first (the command picks by vehicle code; it needs a `targetFolder` argument).
- Contrast: `ink-5` (≈3.6:1) stays on supplementary hints **and** on First run's future-step labels, which the README mandates. `ink-4` was nudged to #80828a for AA.

## How to run

```bash
pnpm install
pnpm tauri dev          # real app, see "Dev safety" below
pnpm dev:mock           # browser + in-memory mock backend; ?onboarded=1, ?empty=1, ?notfound=1, ?many=1 (1,000 hangar skins, 1,284 WT Live posts), ?watch=1, ?offline=1
pnpm handoff            # serves the .dc.html prototypes on http://localhost:4599
pnpm test && pnpm typecheck
pnpm build              # then grep dist/ for mockCall|mockListen|livery.mock: must find nothing
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

- `pnpm dev:mock` and `pnpm tauri dev` both bind port 1420 with `strictPort`, so run one at a time. The preview configs in `.claude/launch.json` use `prototype`, `web` (1430) and `mock` (1431).
- The browser pane can't click inside the native Tauri window. `scripts/capture-window.ps1 -Out <png>` captures it with PrintWindow without stealing focus. Always pass `-Out` to a scratch path, because the default `scripts/livery.png` lands in the repo.

### Dev safety (real game folder)
- First run **detection reads** the real Steam/standalone locations (read-only) as soon as it starts. Confirming a folder creates `UserSkins\`, and from then on the dev app installs, toggles and deletes skins there.
- To try the real app without touching the game: in First run choose the custom folder and pick an empty folder that contains an empty `launcher.exe` (a valid root has `UserSkins\`, `launcher.exe`, `aces.exe` or `win64\aces.exe`).
- Dev and release builds share the same app data (identifier `app.livery.desktop`): `settings.json`, `following.json` and `library/<key>.json` (one index per game folder; an old `library.json` is migrated once). Rename those to start over.

## Working method that worked

- **Foundation first, done by the main session:** shared types (Rust `model.rs` ↔ `src/types.ts`), command stubs registered in `lib.rs`, query hooks, i18n keys, tokens and stub components, all green before any agent starts.
- **Then a Workflow:** one implement → skeptical-review chain per part, with **disjoint file ownership**. Rust agents run sequentially (same crate); frontend parts run in parallel, after the mock they depend on. Agents may add i18n keys only with small Edits in their own namespace. The reviewers found real bugs every time.
- **Integration as a second small workflow:** after the main run, the agents' out-of-scope items went to two parallel implement → review chains with disjoint files (backend/mock/query contracts vs screens), with the shared contracts written into both prompts. The main session then did the cross-cutting bits (shared date format, DESIGN_NOTES, visual check).
- **Audit before launching:** a read-only audit of this handoff (5 auditors + 1 skeptic) found wrong status claims, a mock chunk shipping in `dist/`, a mojibake message and gaps in the spec, all fixed in the foundation-fixes commit. Worth repeating before big runs.
- **Integration by the main session:** apply every agent's `outOfScope` items, run the full checks, compare visually (mock + prototype, measured with JS), record the decisions in DESIGN_NOTES, and make one commit per milestone.

## Gotchas

- Agents sometimes write CRLF files. `.gitattributes` enforces LF on commit, but multi-line Edit anchors fail on CRLF files, so normalize first.
- On Windows, write commit messages with a Bash heredoc (`git commit -F - <<'EOF'`). PowerShell here-strings don't pipe. For multi-line Python edits that contain curly quotes, write the script to a file first: inline heredocs with “ ” broke in the Bash tool.
- Tests that mock `@/lib/tauri` must override `isTauri`, `hasBackend` and `call`. Mock `@/lib/events` too when a component listens to backend events. `resetStores()` also resets `useInstalls`, the Explore store and the Skin detail store (Settings has its own `resetSettingsUi()`).
- `install://progress` is consumed by two hooks: `useInstallEvents` (queue, keyed by queue id) and `useWtLiveInstallEvents` (`src/store/installs.ts`, keyed by install id → WT Live skin id).
- Never write to the real game folder during development. Rust tests use temp dirs; the ignored `detects_real_install` / `scans_real_install` tests only read.
- The mock backend must never ship. Every dynamic `import('@/dev/mockBackend')` must sit behind an **inline** `import.meta.env.VITE_MOCK_BACKEND === '1'` check, not the imported `MOCK_BACKEND` constant. With the constant, Rollup still emitted an orphan `mockBackend-*.js` chunk into `dist/`. Check with `pnpm build` and grep `dist/`.
- `DATA_MODEL.md` belongs to the handoff spec and isn't edited. Contract additions (e.g. `skipped`, `unreadableBlk`, `UNK`, `onboarded`, `reduceMotion`, `following_*`) are recorded in DESIGN_NOTES instead.
