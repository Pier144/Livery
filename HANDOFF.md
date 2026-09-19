# Handoff — Livery (updated 2026-09-19, after the handoff audit)

Read this first in a new session. Then read `CLAUDE.md`, `DESIGN_NOTES.md` (every decision so far, including the "M5 ·" contract rows) and the handoff spec in `design_handoff_livery/` (README → DATA_MODEL → BUILD_PLAN).

## Where things stand

| Milestone | State | Commit |
|---|---|---|
| M0 scaffold | done | `993bb8e` |
| M1 global chrome | done | `9194854` |
| M2 game detection + First run | done. Detects the author's real Steam install: `D:\SteamLibrary\steamapps\common\War Thunder`, 2.59.0.13 (DESIGN_NOTES "M2 · Real-world facts"). | `85623c1` |
| M3 library, My Hangar, Collections | done. Uses a JSON index, not SQLite (see "Pending approvals"). The 30-day backup expiry job (BUILD_PLAN M6) is already here: it purges at launch and before every library command. | `3503850` |
| M4 install queue | done **for skin folders**. ZIP/RAR/7z wait for crate approval; the acceptance test "drop three fixture archives" needs those crates plus archive fixtures. | `2c86010` |
| M5 WT Live | **foundation only**: types, queries (incl. paged search), installs store with the install-finished toast, net-status listener, Rust stubs, Detail route. No UI yet. | `5afb17b` + `chore(m5-m6): foundation fixes after the handoff audit` |
| M6 Settings/polish | **not started**. Foundation: `reduceMotion` setting, `startFirstRun` entry; the backup expiry job is done (M3). | same |

Checks at the latest commit: `pnpm typecheck` clean · `pnpm test` 405 passing · `cargo test` 296 passing (2 ignored real-install tests) · `cargo clippy --all-targets -D warnings` clean · `pnpm build` has no mock chunk or mock strings in `dist/`.

### What the app does today (HEAD), before the M5/M6 workflow runs
- Every `wtlive_*` **and** `following_*` command is still a stub that returns `internal` ("not implemented yet"). The real app doesn't show the designed offline state, Following errors out, and the sidebar says "WT Live online" because `ui.online` defaults to true. The workflow's RUST part fixes this: `unsupported` plus `net://status { online: false }`, and Following as real local data.
- Explore, Settings and Skin detail are placeholders or stubs. The "Status today" column below describes both the current code and what the workflow adds.

## Next steps (in order)

1. **Run the M5 UI + M6 Settings workflow.** Call `Workflow({ scriptPath: "docs/agent-specs/m5-m6.workflow.js" })`. It is self-contained and assumes the foundation commits above. Order: Rust, Mock and Settings start together; Explore and Detail start once Mock and its review are done, so they can check themselves under `pnpm dev:mock`. Every part is implement → skeptical review, with disjoint file ownership.
2. **Integrate** (main session). Apply every agent's `outOfScope` items, plus these known ones:
   - Hangar cards of WT Live skins (`sourceId`) should open the Skin detail. Today a click toggles selection "until the skin detail exists (M5)" (DESIGN_NOTES "M3 · Hangar interaction"). Needs a decision on how selection works then.
   - Sidebar "WT Live online · N skins" count (`Sidebar.liveSkinCount`, DESIGN_NOTES "M1 · WT Live status").
   - Detail's vehicle card → `useExplore.applyVehicle` (Explore owns that store; Detail may fall back to `go('explore')`).
   - `TODO(M5)` in the Collections `MemberCard`: WT Live screenshot for WT Live skins. `HangarSkin` has no image field yet.
   - Turn every agent's `decisions` into DESIGN_NOTES rows.

   Then run the full checks, `pnpm build` plus a grep of `dist/` for mock strings, and a visual comparison with the mock (`pnpm dev:mock`) and the prototype (`pnpm handoff`). Commit M5 and M6 separately if the diff allows it.
3. **M6 polish:**
   - A11y pass: axe on every screen, keyboard, contrast table.
   - i18n completeness. BUILD_PLAN wants de/ru/fr **keys present** with English fallback, and there are no de/ru/fr files today. Also localize backend errors by `code`: about 12 toasts and the queue rows show the backend's English `AppError.message` in the Italian UI (Collections, Hangar, Queue, watch folder).
   - Cold start < 1.5 s with skeletons.
   - A log file in app data: release builds have no console, and tracing writes only to stdout. Do it with a `tracing_subscriber` writer, not a new crate, unless approved.
   - Packaging: NSIS config (the icon set is already generated), a code-signing placeholder, and a GitHub Actions release workflow on windows-latest (needs a GitHub repo, see below).
   - A root `README.md` for developers.
   - The M6 acceptance run: installer on a clean Windows 11 VM, first run to first installed skin in < 2 min. Without archive or WT Live support a typical user can only install a skin **folder**, so this depends on the approvals.
4. When the author approves dependencies (below), implement what they unlock.

## Pending dependency approvals (ask the author; CLAUDE.md requires it)

| Dependency | Unlocks | Status today → after the workflow |
|---|---|---|
| HTTP client (`reqwest` + rustls) + `scraper` (or WT Live's JSON endpoints) | M5 backend: search, post, following-new, download for install / Try in game; parser tests against saved-HTML fixtures (BUILD_PLAN M5), which someone must capture online | Stubs answer `internal` → `unsupported` + `net://status` offline; the UI shows the designed offline state. Check WT Live's terms of use before scraping. |
| `zip`, `unrar`, `sevenz-rust` | Installing .zip/.rar/.7z (M4), and ZIP export ("zip per skin", DESIGN_NOTES "M3 · Export"). Add `ZipSource` etc. implementing `archive::SkinSource`, flip `ARCHIVES_SUPPORTED` in `src/screens/Queue/queueModel.ts`, add the three archive fixtures | Archives become `unsupported` error rows; skin folders install; export copies folders |
| `tauri-plugin-opener` | "Open original post", About links, "Show in Explorer" | No link UI yet → Detail copies the post URL to the clipboard; About links are disabled |
| `tauri-plugin-autostart` | Settings → Start with Windows | No Settings UI yet → switch disabled with a helper |
| `tauri-plugin-updater` + signing key + a public release endpoint | Settings → Updates | No Settings UI yet → controls disabled |
| `tauri-plugin-os` / `tauri-plugin-fs` | Listed in BUILD_PLAN M0 capabilities | Probably **not needed** (Rust does all disk I/O; nothing needs OS info in JS). Confirm with the author and record it. |
| `rusqlite` (optional) | SQLite index as DATA_MODEL suggests | JSON `library.json` v2 works well (README allows JSON) |
| `notify` (optional) | Event-based watcher | Polling watcher (2 s) works |

Already approved and in use: `tauri-plugin-dialog`, `winreg`, jsdom/testing-library/axe-core (dev), fonts copied from npm.

## Decisions the author needs to make (not dependencies)

- **Vehicle list source (BUILD_PLAN open decision 3).** `src/data/vehicles.json` is still the 9-vehicle placeholder seed. It feeds the Explore autocomplete and class chips, the palette and the Rust nation/type fallback. Which public datamine should we use, and is its licence OK to ship?
- **GitHub repo / remote.** There is no git remote. The release workflow and the updater endpoint need one.
- **WT Live.** Is scraping allowed by its terms? Who captures the saved-HTML fixtures (needs network access)?
- **Following a vehicle.** The README only designs the author Follow button. The spec adds a small Follow toggle next to the vehicle card in the Skin detail side panel (recorded as a decision). Is that OK?

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
pnpm dev:mock           # browser + in-memory mock backend; ?onboarded=1, ?empty=1, ?notfound=1, ?many=1 (1,000 skins), ?watch=1; ?offline=1 once the Mock part lands
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
- Dev and release builds share the same app data (identifier `app.livery.desktop`): `settings.json`, `library.json`. Rename those files to start over.

## Working method that worked

- **Foundation first, done by the main session:** shared types (Rust `model.rs` ↔ `src/types.ts`), command stubs registered in `lib.rs`, query hooks, i18n keys, tokens and stub components, all green before any agent starts.
- **Then a Workflow:** one implement → skeptical-review chain per part, with **disjoint file ownership**. Rust agents run sequentially (same crate); frontend parts run in parallel, after the mock they depend on. Agents may add i18n keys only with small Edits in their own namespace. The reviewers found real bugs every time.
- **Audit before launching:** a read-only audit of this handoff (5 auditors + 1 skeptic) found wrong status claims, a mock chunk shipping in `dist/`, a mojibake message and gaps in the spec, all fixed in the foundation-fixes commit. Worth repeating before big runs.
- **Integration by the main session:** apply every agent's `outOfScope` items, run the full checks, compare visually (mock + prototype, measured with JS), record the decisions in DESIGN_NOTES, and make one commit per milestone.

## Gotchas

- Agents sometimes write CRLF files. `.gitattributes` enforces LF on commit, but multi-line Edit anchors fail on CRLF files, so normalize first.
- On Windows, write commit messages with a Bash heredoc (`git commit -F - <<'EOF'`). PowerShell here-strings don't pipe. For multi-line Python edits that contain curly quotes, write the script to a file first: inline heredocs with “ ” broke in the Bash tool.
- Tests that mock `@/lib/tauri` must override `isTauri`, `hasBackend` and `call`. Mock `@/lib/events` too when a component listens to backend events. `resetStores()` also resets `useInstalls`.
- `install://progress` is consumed by two hooks: `useInstallEvents` (queue, keyed by queue id) and `useWtLiveInstallEvents` (`src/store/installs.ts`, keyed by install id → WT Live skin id).
- Never write to the real game folder during development. Rust tests use temp dirs; the ignored `detects_real_install` / `scans_real_install` tests only read.
- The mock backend must never ship. Every dynamic `import('@/dev/mockBackend')` must sit behind an **inline** `import.meta.env.VITE_MOCK_BACKEND === '1'` check, not the imported `MOCK_BACKEND` constant. With the constant, Rollup still emitted an orphan `mockBackend-*.js` chunk into `dist/`. Check with `pnpm build` and grep `dist/`.
- `DATA_MODEL.md` belongs to the handoff spec and isn't edited. Contract additions (e.g. `skipped`, `unreadableBlk`, `UNK`, `onboarded`, `reduceMotion`, `following_*`) are recorded in DESIGN_NOTES instead.
