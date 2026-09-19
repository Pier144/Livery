# Build plan

Each milestone ends with the acceptance list green and a visual check against `Livery Prototype.dc.html` (tweak "window size" to 1100×700 and 1920×1080 too).

## M0 · Scaffold (½ day)
- `pnpm create tauri-app` (React-TS), Tailwind with `tokens/tailwind.tokens.cjs`, fonts self-hosted, Lucide, Zustand, TanStack Query/Virtual, react-i18next, Vitest.
- Frameless window (`decorations: false`, `transparent: false`), min 1100×700, default 1440×900; `tauri.conf.json` capabilities: fs (app data + game root scoped at runtime), dialog, shell-open (WT Live links), updater, os.
- Rust modules created empty with `AppError`, logging (`tracing`), settings load/save.
- ✅ App opens frameless, title bar drag/min/max/close work, Tailwind tokens render, `t()` works in EN/IT.

## M1 · Global chrome (1 day)
- Title bar, sidebar (expanded/collapsed, badge, status card, `[`/`]`), ruled background, command palette (Ctrl+K, ↑↓↵, actions + vehicles), toasts with Undo (`aria-live`), skeleton, empty-state, window-level drag&drop overlay, keyboard 1–5 / Esc, reduced-motion.
- ✅ Every element in README §Global chrome exists and matches; focus ring visible everywhere; axe has no serious issues.

## M2 · Game detection + First run (1 day)
- Rust `game`: Steam vdf, standalone paths, custom picker, version from `version` file if present, count existing skins.
- First run: Detect → Confirm (found / not found) → Import, with technical animation (SVG dimension lines, CSS 3D box, scanline, atlas tiles — port from prototype; `motion-safe` only).
- ✅ Detects a real Steam install; manual folder works; existing skins imported into the index with attention flags.

## M3 · Library + My Hangar + Collections (2 days)
- Rust `library`: SQLite, `scan_user_skins` with attention rules (missing texture referenced in blk, unknown blk block, no blk, partial extract marker), active/inactive, delete with backup, restore, export.
- Hangar screen (grid/list, groups by vehicle, search, filters, bulk bar with undoable Delete), Collections (CRUD, activate).
- ✅ Toggle/delete/undo round-trip on disk; activating a collection updates game folder state; 1,000 skins scroll at 60 fps (virtualized).

## M4 · Archives + Install queue (2 days)
- Rust `archive`: list entries for zip/rar/7z, locate blk(s), detect vehicle, conflict check, extract to temp → move into UserSkins atomically, progress events.
- `textures`: DDS/TGA header parse + warnings (>4096² heavy, referenced-but-missing).
- Queue screen: drop zone, rows per status, Pick vehicle, Conflict dialog (Replace w/ backup default, Copy, Skip; policy from settings), Watch Downloads folder toggle.
- ✅ Drop three fixture archives (ready / conflict / multi-blk) → correct states; Replace is undoable; watcher auto-installs when enabled.

## M5 · WT Live: Explore + Detail (3 days)
- Rust `wtlive`: search/listing parser, post parser (images, download, files, stats), cache, rate limit, online/offline events. Fixtures = saved HTML pages; tests must pass against them.
- Explore (tabs, chips, segmented, vehicle autocomplete from local vehicle list `src/data/vehicles.json`, sort, active-filters line, result count + ms, virtual grid, card states idle/installing/installed/error, loading/empty/offline).
- Following (vehicles/authors, "N new").
- Detail (Gallery + zoom + compare, Textures table, Try in game keep/discard, side panel, Add to collection).
- ✅ Install from a card ends in Hangar with toast; offline mode degrades exactly as spec; Try → Keep / Discard leave disk in the right state.

## M6 · Settings, updater, polish (1½ days)
- Settings sections (General, Game, Conflicts, Backups, Language, Updates, About), `tauri-plugin-updater`, start-with-windows (`tauri-plugin-autostart`), backups expiry job (30 days).
- Accessibility pass (keyboard, contrast table), perf pass (cold start < 1.5 s, first paint with skeletons), i18n completeness (en/it; de/ru/fr keys present, English fallback).
- Packaging: NSIS installer, code signing placeholder, icon set (amber dot on graphite — see design system), release workflow (GitHub Actions, windows-latest).
- ✅ Installer runs on a clean Windows 11 VM; first run to first installed skin < 2 min.

## Out of scope for v0.1
Skin editing, uploading to WT Live, multi-game support, cloud sync, macOS/Linux builds.

## Open decisions (pick and document in DESIGN_NOTES.md)
1. Inactive-skin mechanism: rename folder with `_` prefix (fast, visible in Explorer) vs. move to app data (cleaner UserSkins). Prototype assumes instant toggle either way.
2. Whether Explore fetches all pages up front (for the "1,284 results · 24 ms" local filter feel) or paginates on scroll. Recommended: fetch first 5 pages, background-prefetch the rest, filter locally.
3. Vehicle list source: ship `vehicles.json` (code, name, nation, type, class) built from a public datamine; update with the app.
