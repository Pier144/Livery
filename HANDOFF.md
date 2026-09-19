# Handoff — Livery (session of 2026-09-19)

Read this first in a new session, then `CLAUDE.md`, `DESIGN_NOTES.md` (every decision taken so far) and the handoff spec in `design_handoff_livery/` (README → DATA_MODEL → BUILD_PLAN).

## Where things stand

| Milestone | State | Commit |
|---|---|---|
| M0 scaffold | done | `993bb8e` |
| M1 global chrome | done | `9194854` |
| M2 game detection + First run | done (detects the author's real Steam install: `D:\SteamLibrary\steamapps\common\War Thunder`, 2.59.0.13) | `85623c1` |
| M3 library, My Hangar, Collections | done (JSON index, not SQLite: see "Pending approvals") | `3503850` |
| M4 install queue | done **for skin folders** (ZIP/RAR/7z wait for crate approval) | `2c86010` |
| M5 WT Live | **foundation only** (types, queries, installs store, Rust stubs, Detail route); UI not built yet | this commit |
| M6 Settings/polish | **not started** (foundation: `reduceMotion` setting, `startFirstRun` entry) | this commit |

Checks at handoff: `pnpm typecheck` clean · `pnpm test` 398 passing · `cargo test` 296 passing (2 ignored real-install tests) · `cargo clippy --all-targets -D warnings` clean.

## Next steps (in order)

1. **M5 UI + M6 Settings.** The full, reviewed specs for 5 parallel parts are in `docs/agent-specs/m5-m6.workflow.js`: Rust WT Live stubs + following store, mock backend extension, Explore + Following, Skin detail, Settings. The workflow was stopped right after launch, before any agent wrote code. Re-run it as a Workflow with `scriptPath` pointing at that file. It is self-contained and assumes the foundation in this commit.
2. Integrate the results. Every agent reports `outOfScope` items that the main session must apply. Then run the full checks, do a visual comparison with the mock (`pnpm dev:mock`) and the prototype (`pnpm handoff`), add DESIGN_NOTES rows, and commit.
3. **M6 polish.** Run an a11y pass (axe on every screen, keyboard, contrast table), an i18n completeness check (de/ru/fr fall back to English), a cold-start check (< 1.5 s with skeletons), and packaging (NSIS config, icon set already generated, a GitHub Actions release workflow on windows-latest, code-signing placeholder). Also write a root README for developers.
4. When the author approves dependencies (below), implement the parts they unlock.

## Pending dependency approvals (ask the author; CLAUDE.md requires it)

| Dependency | Unlocks | Status today |
|---|---|---|
| HTTP client (`reqwest` + rustls) + `scraper` (or WT Live's JSON endpoints) | M5 backend: search, post, following-new, download for install / Try in game | `src-tauri/src/wtlive.rs` stubs → UI shows the designed offline state. Also check WT Live's terms of use before scraping. |
| `zip`, `unrar`, `sevenz-rust` | Installing .zip/.rar/.7z (M4). Add `ZipSource` etc. implementing `archive::SkinSource`, flip `ARCHIVES_SUPPORTED` in `src/screens/Queue/queueModel.ts` | Archives become error rows (`unsupported`); skin folders install fine |
| `tauri-plugin-opener` | "Open original post", About links, "Show in Explorer" | Links copy the URL instead |
| `tauri-plugin-autostart` | Settings → Start with Windows | Switch disabled |
| `tauri-plugin-updater` + signing key | Settings → Updates | Disabled |
| `rusqlite` (optional) | SQLite index as DATA_MODEL suggests | JSON `library.json` v2 works well (README allows JSON) |
| `notify` (optional) | Event-based watcher | Polling watcher (2 s) works |

Already approved and in use: `tauri-plugin-dialog`, `winreg`, jsdom/testing-library/axe-core (dev), fonts copied from npm.

## Open questions for the author

- The Italian sidebar label is "Da installare", because "Coda di installazione" truncates next to the badge. Is that OK?
- Activating a collection isn't undoable, and `activeCollectionId` stays set after manual toggles.
- `undo_replace` deletes the new copy without a backup (its source still exists).
- A pack with two skins for the same vehicle installs only the first (the command picks by vehicle code).
- Contrast: supplementary hints stay ink-5 (≈3.6:1), and `ink-4` was nudged to #80828a for AA (see DESIGN_NOTES).

## How to run

```bash
pnpm install
pnpm tauri dev          # real app (reads the real game folder only when confirmed in First run)
pnpm dev:mock           # browser + in-memory mock backend; add ?onboarded=1, ?empty=1, ?notfound=1, ?many=1 (1,000 skins)
pnpm handoff            # serves the .dc.html prototypes on http://localhost:4599
pnpm test && pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The browser pane can't click inside the native Tauri window. To look at it, run `scripts/capture-window.ps1 -Out <png>`, which captures the Livery window with PrintWindow without stealing focus. `.claude/launch.json` has `prototype`, `web` (1430) and `mock` (1431) preview configs.

## Working method that worked

- **Foundation first, done by the main session:** shared types (Rust `model.rs` ↔ `src/types.ts`), command stubs registered in `lib.rs`, query hooks, i18n keys, tokens and stub components, all green before any agent starts.
- **Then a Workflow:** one implement → skeptical-review chain per part, with **disjoint file ownership**. Rust agents run sequentially (same crate); frontend parts run in parallel. Agents may add i18n keys only with small Edits in their own namespace. The reviewers found real bugs every time.
- **Integration by the main session:** apply every agent's `outOfScope` items, run the full checks, compare visually (mock + prototype, measured with JS), record the decisions in DESIGN_NOTES, and make one commit per milestone.

## Gotchas

- Agents sometimes write CRLF files. `.gitattributes` enforces LF on commit, but multi-line Edit anchors fail on CRLF files, so normalize first.
- On Windows, write commit messages with a Bash heredoc (`git commit -F - <<'EOF'`). PowerShell here-strings don't pipe.
- Tests that mock `@/lib/tauri` must override `isTauri`, `hasBackend` and `call`. Mock `@/lib/events` too when a component listens to backend events.
- `install://progress` is consumed by two hooks: `useInstallEvents` (queue, keyed by queue id) and `useWtLiveInstallEvents` (`src/store/installs.ts`, keyed by install id → WT Live skin id).
- Never write to the real game folder during development. Rust tests use temp dirs; the ignored `detects_real_install` / `scans_real_install` tests only read.
- The mock backend must never ship: it is reached only through dynamic imports behind `VITE_MOCK_BACKEND`. Check with `pnpm build` and grep `dist/` for mock strings.
