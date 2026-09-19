# Handoff: Livery — War Thunder user-skin manager (desktop)

## Overview
Livery (working title) is an unofficial Windows-first desktop app that browses community skins from WT Live, installs them with one click into the game's `UserSkins` folder, and manages the installed collection. Screens: First run, Explore (+ Following), Skin detail (Gallery / Textures / Try in game), My Hangar, Collections, Install queue, Settings (incl. About). Global: frameless title bar, collapsible sidebar, Ctrl+K command palette, toasts with Undo, skeletons, empty states, offline mode.

## About the design files
The `.dc.html` files in this bundle are **design references built in HTML** — interactive prototypes that show intended look and behavior. They are not production code. The task is to **recreate them in the target stack**: Tauri 2 (Rust backend) + React + TypeScript + Vite + Tailwind, icons from **Lucide**. Where the prototype uses text glyphs (▾ ✓ × ← ▦ ☰ — ☐ ✕), substitute the Lucide icon named in this document.

## Fidelity
**High-fidelity.** Colors, type, spacing, states and copy are final. Recreate 1:1 with Tailwind tokens from the "Design tokens" section. Sample data (vehicles, authors, numbers) is placeholder; skin screenshots are striped placeholders to be replaced with real images from WT Live posts.

## Stack notes (Tauri 2)
- Frameless window (`decorations: false`), custom title bar with `data-tauri-drag-region`; min size 1100×700; default 1440×900; must scale to 1920×1080 (content grids use `auto-fill, minmax(250px, 1fr)`).
- Rust side owns: game detection (Steam registry/library folders, standalone launcher, custom path), archive analysis & extraction (zip/rar/7z), texture header parsing (DDS/TGA: resolution, format, size), file watching (Downloads folder), backups, and a SQLite (or JSON) library index. Emit progress events (`download`, `extract`, `verify`, `done`) per install id.
- Frontend: React + TS, Tailwind with the tokens below, Zustand (or similar) store, TanStack Query for WT Live fetches with offline fallback, TanStack Virtual for the Explore/Hangar grids (thousands of items).
- Strings: all UI text goes through i18n (react-i18next), English source; keys listed under each screen.
- Accessibility: WCAG AA (see contrast table), visible focus ring on everything, full keyboard nav, `prefers-reduced-motion` disables all non-essential animation.

## Design tokens (Tailwind)

### Colors
| token | value | use |
|---|---|---|
| bg-0 | #0f1012 | title bar |
| bg-1 | #111214 | sidebar, detail side panel |
| bg-2 | #131416 | window canvas |
| bg-3 | #18191c | cards, menus, dialogs |
| bg-4 | #1f2024 | secondary buttons, controls |
| bg-5 | #26272c | pressed / selected segment |
| bg-hover | #1c1d21 | nav hover/active, list hover, toast |
| line-1 | #1f2024 | structural (sidebar edge) |
| line-2 | #26272c | card border |
| line-3 | #2e2f35 | control border, tag border |
| line-4 | #3a3b41 | hover border, dialog border, dashed drop zones |
| line-mark | #4a4c54 | corner marks on imagery |
| grid | #1c1d21 | 28px ruled background |
| ink-1 | #ececee | primary text |
| ink-2 | #c9cbd1 | emphasised meta (author, nation tag) |
| ink-3 | #9a9ca3 | secondary text |
| ink-4 | #7c7e86 | mono labels |
| ink-5 | #6b6d74 | hints, disabled |
| amber | oklch(0.78 0.16 70) | the one accent |
| amber-hover | oklch(0.85 0.14 75) | primary button hover |
| amber-10 | oklch(0.78 0.16 70 / .10) | installed fill, warning fill |
| amber-35 | oklch(0.78 0.16 70 / .35) | installed border |
| amber-60 | oklch(0.78 0.16 70 / .60) | active chip border |
| danger | oklch(0.75 0.15 25) | destructive text only (Delete) |
| on-amber | #131416 | text on amber |

Contrast (on #131416): ink-1 14.8:1, ink-3 6.6:1, ink-4 4.5:1 (only for ≥10px mono labels). on-amber on amber 9.6:1. Amber is used for state and action only; never for decoration.

### Typography
Fonts: **Geist** (UI), **IBM Plex Mono** (all technical data: IDs, sizes, resolutions, counts, shortcuts, labels in caps with `letter-spacing: .08em`). Bundle both as woff2.

| token | css |
|---|---|
| display | 500 30px/1.15 Geist, letter-spacing -.01em |
| title | 500 20px/1.2 Geist |
| heading | 500 16px/1.3 Geist |
| card-title | 500 14px/1.3 Geist |
| body | 400 13px/1.5 Geist |
| meta | 400 12px/1.4 Geist |
| label (buttons) | 500 12–13px Geist; primary 600 |
| mono-data | 400 12px/1.4 IBM Plex Mono |
| mono-small | 400 11px IBM Plex Mono |
| mono-label | 400 10px IBM Plex Mono, uppercase, letter-spacing .08em |
| brand | 600 12px Geist, letter-spacing .14em, "LIVERY" |

### Spacing (4px base)
4, 8, 12, 16, 20, 24, 28, 40. Card padding 12. Screen padding 18px top / 24px sides. Grid gap 16 (Explore), 12 (Hangar). Background grid cell 28px.

### Radius
3 tags · 4 menu items, image badges · 6 buttons, chips, inputs, nav items · 8 cards, dialogs' inner cards · 9 pill badges · 10 dialogs, palette.

### Elevation
0 card: `1px solid line-2`. 1 menu: `1px solid line-3; box-shadow 0 12px 32px rgba(0,0,0,.5)`. 2 dialog/palette: `1px solid line-4; box-shadow 0 30px 80px rgba(0,0,0,.7)`. Hover card: `0 8px 24px rgba(0,0,0,.45)`.

### Motion
Border/color 120ms; transforms 150–250ms ease-out; progress bars linear; toast enter 200ms fade+4px rise. First-run 3D box rotates 28s linear; scanline 7s; dimension lines draw in 1.6s; texture tiles fade in staggered 180ms. Under `prefers-reduced-motion` all of these are `animation: none`; state changes stay instant. Never use spinners — use skeletons (shimmer 1.4s linear, `linear-gradient(90deg,#1c1d21 25%,#232428 50%,#1c1d21 75%)`).

### Background
Content areas (not sidebar/title bar) carry a ruled grid: `linear-gradient(#1c1d21 1px, transparent 1px), linear-gradient(90deg, #1c1d21 1px, transparent 1px)`, size 28px, position -1px -1px.

## Global chrome

### Title bar (38px, bg-0, bottom border line-2)
Grid `1fr auto 1fr`, padding 0 12. Left: 8px amber dot with `0 0 8px amber/.6` glow + "LIVERY" (brand). When offline: mono tag "OFFLINE · library only" (10px, ink-3, border line-3, radius 3). Center: search button 420×26, bg #17181b, border line-2, radius 6, placeholder "Search skins, vehicles, authors", right kbd "Ctrl K" (10px mono, border line-3). Right: window controls 34×26 each — Lucide `minus`, `square`, `x`; hover bg-hover; close hover `oklch(0.55 0.18 25)` white icon. Whole bar is a drag region.

### Sidebar (216px expanded / 56px collapsed, bg-1, right border line-1)
Padding 14 10 12. Items 34px, radius 6, padding 0 10, 500 13px; active: bg-hover, ink-1, `border-left: 2px amber`; inactive ink-3; hover bg-hover. Each item: label, optional amber pill badge (Install queue count, 10px mono, on-amber), right kbd hint (1–5, ",") in 10px mono ink-5. Items: Explore (`compass`), My Hangar (`warehouse`), Collections (`layers`), Install queue (`download`), Settings (`settings`). Bottom status card: border line-1, radius 6, bg #141518: "War Thunder" + "STEAM" mono tag; dot + "WT Live online · 2,318 skins" (dot amber when online, ink-5 offline → "WT Live offline"); "Hangar 214 · 3.8 GB". "Collapse sidebar [" text button. Collapsed: 36×34 icon buttons, badge as 6px amber dot top-right, "]" to expand. Shortcut `[` / `]`.

### Command palette (Ctrl+K, Esc)
Overlay `rgba(11,11,12,.6)`; panel 560px, top 120px, bg-3, elevation 2, radius 10. Input row 46px: amber ">" prefix, placeholder "Jump to a vehicle, skin or action…", "Esc" kbd. Results (max 9): row 9px 10px, radius 6, columns: kind (10px mono ink-5, min 56px: "Skin" / "Vehicle" / "Action"), label 13px, hint mono 11px (vehicle code, or "vehicle · author"). Active row bg-hover; ↑↓ / ↵. Empty query shows 5 actions + 4 vehicles. Footer hints "↑↓ navigate · ↵ open · Ctrl K close".

### Toasts (bottom-right, 20px inset, 6s)
bg-hover, border line-4, elevation 1, radius 8, padding 10 12 10 14; amber 6px dot, 13px text, optional "Undo" button (26px, bg-5, border line-4; hover amber border), × dismiss. `aria-live="polite"`. Undo on: delete (Hangar bulk), replace (conflict). Copy examples: `Installed “{name}”`, `Deleted {n} skins`, `Replaced “{name}” · backup kept`, `Kept “{name}” — it’s in My Hangar`, `Discarded “{name}”. Game files restored.`

### Drag & drop
Any dragover of files on the window shows overlay inset 8px: `2px dashed amber`, radius 10, bg `rgba(19,20,22,.85)`, text "Drop to add to the install queue" (500 20px) + "ZIP · RAR · 7Z" mono. Drop → items added to queue with status "Analyzing archive…", then navigate to Install queue; analysis resolves to ready/conflict/verify.

## Screens

### 1. First run
Two-column grid, ruled background. Left column: max 620px, padding 0 72, vertical center, gap 28. Step tracker (10px mono, letter-spacing .08em): "01 DETECT · 02 CONFIRM · 03 IMPORT" — current step amber, past ink-3, future ink-5.
- **Detect**: display "Looking for War Thunder", body "Checking the usual places. This takes a second." Card (bg-3, border line-2, radius 8) rows 12 14 with 6px dot: "Steam library" → mono "checking…"/"found" (amber); "Standalone launcher" (pulsing dot 1.2s) → "queued"/"checking…"/"not installed"; "Custom location" → "skipped". 2px amber progress bar. Auto-advances at 100%.
- **Confirm (found)**: "Found War Thunder" / "Livery will install skins into this copy of the game." Card with amber-60 border: "War Thunder" + "STEAM" tag, "Version 2.49 · 9 skins already in UserSkins", "Show path"/"Hide path" link reveals mono path (paths hidden by default everywhere). Buttons: primary "Use this install", secondary "Choose another folder".
- **Confirm (not found)**: "Can't find War Thunder" / "Pick the folder where the game is installed. Livery looks for the UserSkins folder inside it." Dashed drop zone (border line-4 dashed, radius 8, padding 26): "Choose game folder" / "or drop it here". Links "Skip for now", "Back".
- **Import**: "Skins already on disk" / "Livery found skins in your UserSkins folder. Add them to My Hangar to manage them here." Stats card 3 columns (500 22px numbers: skins, vehicles, need attention — the last amber). Rows: 36×22 thumb, name, vehicle, right mono tag "ok" / "created by you" / "needs attention" (amber). "+ N more". Primary "Import and continue", secondary "Skip import".
Right column (border-left line-hover): the **technical animation** — 560×560 stage: SVG dimension lines that draw in (`stroke-dashoffset` 600→0, 1.6s, staggered), mono annotations ("HULL 200 × 120 × 110", "SHEET 00 · DETECTING INSTALL", "UNOFFICIAL TOOL") fading in, amber crosshair, a CSS 3D wireframe box pair (hull 200×110×120 + turret 96×52×80, amber 1px faces at .75 opacity, top face hatched) rotating `rotateX(-22deg) rotateY(360deg)` over 28s, an amber scanline sweeping 300px every 7s, and a 6-tile texture atlas (44px tiles: hull_c, hull_n, turret_c, turret_n, tracks_c, skin.blk) fading in staggered. All off under reduced motion (static frame remains).

### 2. Explore
Padding 18 24 0, gap 14. Header row (border-bottom line-2): tabs "Explore" / "Following" (500 14px, active ink-1 with 2px amber underline, inactive ink-3); Following carries pill "N new" (amber text, amber/.5 border). Right: mono "1,284 results · 24 ms" (result count + query time — the speed is a feature).
Filter row (28px controls, gap 8, wrap): 
- Chip dropdowns "Nation", "Class", "Category": bg #1b1c20, border line-3 (amber-60 when set), 12px; label + value (ink-3 "Any" / amber when set) + `chevron-down`. Menu: elevation 1, radius 6, padding 4; items 7 10, radius 4, hover bg-4, `check` amber on the active one.
- Type segmented control: "All types / Ground / Air / Helicopters / Naval", bg #1b1c20, border line-3, dividers line-3, selected segment bg-5 ink-1.
- Vehicle input 200×28 (bg #17181b, border line-3) with autocomplete menu (name + mono code) — matches name or internal code.
- Right: text "Sort **Most downloaded** ▾" (Most downloaded / Most liked / Newest / Name A–Z).
All filters combine (AND). Active-filters line: mono 11px "3 filters combined | Germany × Ground × Historical × Clear all" (each removable; Clear all amber).
Grid: `repeat(auto-fill, minmax(250px, 1fr))`, gap 16, `grid-auto-rows: max-content`, virtualized, bottom padding 24.
**Skin card** (bg-3, border line-2, radius 8; hover border amber + shadow; focus ring 2px amber offset 2): 16:9 image; top-left category tag (10px mono, `rgba(15,16,18,.85)` bg, radius 4); top-right "NEW" badge (amber bg) when new from a follow; bottom corners 9px L-marks in line-mark. Body padding 12, gap 7: name (card-title, ellipsis); nation tag (10px mono, border line-3, radius 3, e.g. "GER") + vehicle (12px ink-3); "by Author" (author ink-2) + mono "24.1k dl · 1.9k likes". Action row 30px:
- idle: "Install 48 MB" button (bg-4, border line-3; hover amber bg, on-amber text)
- installing: 3px progress bar + mono steps "Download ✓ | Extracting 56% (amber) | Verify · Done"
- installed: amber-10 fill, amber-35 border, "Installed ✓" + "in Hangar"
- error: `oklch(0.75 0.15 25 / .08)` fill, /.4 border, "Install failed" + "Retry" link; helper line below with reason.
Clicking the card opens detail; the Install button stops propagation.
States: loading → 8 skeleton cards; no results → "No skins match" / "Try fewer filters, or search by vehicle code instead." / "Clear all filters"; offline → "WT Live can't be reached" / "Your library works as usual. Browsing and installing from WT Live will resume when you're back online." / primary "Open My Hangar", secondary "Retry".
**Following tab**: grid `280px 1fr`. Left list "FOLLOWING · 4": cards (name, mono "Vehicle · code" / "Author · 14 skins on WT Live", amber pill "2 new"); click applies that vehicle/author as a filter on Explore. Right: "NEW FROM PEOPLE AND VEHICLES YOU FOLLOW" grid of new skins (card with NEW badge, name, "vehicle · by author · date").

### 3. Skin detail
Top bar (padding 12 24, border-bottom line-2): "← Explore" secondary button (Lucide `arrow-left`), name (500 16px) + mono code, right tabs Gallery / Textures / Try in game (2px amber underline).
Grid `1fr 320px`.
**Gallery**: main image (border line-2, radius 8, corner marks, counter "1 / 4" top-right mono); bottom-left buttons "Zoom in/out" (toggles `scale(1.6)`, 250ms) and "Compare"; thumbnails 120×68 (Front/Side/Rear/Detail), active border amber. **Compare mode**: two panes side by side, A (amber-60 border) labelled "A · name", B labelled "B · name · by author"; below, "COMPARE WITH · same vehicle" + buttons for other skins of the same vehicle (active amber text); "Exit compare".
**Textures**: heading "Textures in the archive" + mono "6 files · 111.7 MB". Optional warning banner (amber-10 fill, amber/.4 border): "{n} file(s) need attention. The skin still installs; the game may skip the affected part." Spec table (bg-3, radius 8): header mono-label "FILE | RESOLUTION | FORMAT | SIZE"; rows 12px mono with 28px swatch; warnings shown as an amber line under the row ("Very heavy texture (8192²). Load times may suffer.", "Referenced in skin.blk but not in the archive."); missing files render "—" and "missing" in amber.
**Try in game**: centered column max 560. Idle: title "Try it before you keep it", body "Livery installs the skin temporarily. Look at it in the game, then decide. Nothing is added to My Hangar until you press Keep."; steps card 01 "Livery copies the files into UserSkins", 02 "In War Thunder, open the vehicle’s Customisation and press the **refresh** button", 03 "Come back and choose Keep or Discard"; primary "Try in game · 48 MB". Installing: "Installing temporarily…" + indeterminate amber bar. Active: pulsing amber dot + "Skin is in the game", body "Open **{vehicle}** → Customisation → press **refresh**, then select “{name}”."; amber-tinted card "TEMPORARY · WILL BE REMOVED ON DISCARD" + mono folder `UserSkins/{code}_{author}/`; primary **Keep** (→ installs permanently, toast) / secondary **Discard** (→ toast "Game files restored").
**Side panel** (320px, bg-1, border-left line-2, padding 20, gap 18): AUTHOR block — 34px avatar circle with initial, name 500 14px, "on WT Live", "Follow" button; amber link "Open original post ↗" (`external-link`) — creators always visible. VEHICLE card (name + mono "code · nation · class", clickable → Explore filtered). 2×2 stat cells (DOWNLOADS, LIKES, CATEGORY, POSTED). FILES INCLUDED "6 · 48 MB" + mono list. Bottom: Install / progress / Installed (36px) and "Add to collection ▾" (menu of collections, toast `Added to “{collection}”`).

### 4. My Hangar
Header: "My Hangar" + mono "{n} skins · {active} active · {GB} on disk"; right amber dot + "{n} need attention" when any.
Toolbar: search input 260×28 "Search your skins…" (instant, matches name/vehicle/code); chip dropdowns Nation / Type / Origin (WT Live · Imported · Mine) — label turns amber when set; right: "Select all" ghost, grid/list segmented (`layout-grid` / `list`).
Groups by vehicle, gap 22: sticky header (vehicle 500 13px, mono code, right mono "3 skins").
Grid card (minmax 220px): image with 18px checkbox top-left (selected: amber fill, on-amber `check`), "NEEDS ATTENTION" amber badge top-right; body: name, origin (Mine in amber) + mono size, attention message in amber (e.g. "turret_c.dds is missing", "skin.blk has an unknown block", "archive was only partially extracted"), footer: "Active"/"Inactive" 24px toggle button (Active text amber) + "Re-check" link when attention. Selected card: border amber, bg bg-hover.
List row: grid `28px 44px 2fr 1fr 1fr 80px 80px` — checkbox, 44×26 thumb, name (+ attention line), origin, author, mono size, Active toggle.
**Bulk bar** (appears when selection > 0): centered bottom 20px, bg-3, border line-4, elevation, radius 8: "{n} skins selected" · Activate · Deactivate · "Move to collection ▾" · Export · **Delete** (danger text; hover danger border) · ×. Delete removes and toasts with **Undo** (restores). 
Empty: "Nothing here yet" / "Install a skin from Explore, or drop a ZIP anywhere in this window." / "Browse WT Live".

### 5. Collections
Grid `340px 1fr`. Left (border-right line-2, padding 18 20): "Collections" + "+ New"; helper "Activate a collection to use only its skins in the game. Others stay installed, just inactive."; collection cards (bg-3, border line-2 → amber when open): name, mono "Active" badge (amber) when in use, description, mono count, "In use". Right: title (500 20px), description, mono "{n} skins · {MB}"; "Active in game ✓" amber pill or primary "Activate"; grid of member cards (minmax 200px) with "Remove" link; dashed placeholder "Add skins from My Hangar (select → Move to collection)". Activating sets `active = collection.includes(skin)` for every hangar skin; nothing is deleted.

### 6. Install queue
Header: "Install queue" + mono "{n} archives · {ready} ready"; right "Clear installed" ghost (when any done) + primary "Install {n} ready".
Grid `1fr 300px`. Left: dashed drop zone "Drop ZIP, RAR or 7z archives anywhere in the window" / "or click to browse"; queue rows (bg-3, radius 8, grid `8px 1fr auto`): status dot; mono filename + mono size; line "**Status** · Vehicle · note". Status → dot/label color: Ready (ink-2) "6 files · 2 textures · skin.blk ok"; Conflict (amber) "Same folder name as “X” (installed)"; Needs a look (ink-5) "Can’t detect the vehicle: 3 folders inside. Pick one to continue."; Installed (amber). Row actions: Install (primary) / Resolve (amber outline) / Pick vehicle (secondary) / "Installed ✓" ; × remove.
Right: card "Watch Downloads folder" + toggle (34×18, knob 14, amber when on) "New skin archives install automatically." + "Show folder" link revealing mono path; legend card "WHAT THE STATES MEAN".
**Conflict dialog** (520px, elevation 2, radius 10, padding 22 24): amber dot + "This skin is already installed"; body "`file.zip` uses the same folder as “{installed}” on {vehicle}." Options as full-width option buttons: **Replace, keep a backup** (amber-tinted, default/Enter) "The old version goes to Backups. Undo available."; **Install as a copy** "Both versions stay. The new one gets “(2)” in its name."; **Skip** "Leave the installed version as it is." Footer: "Change the default in Settings → Conflicts" + Cancel. Replace toasts with Undo.

### 7. Settings
Grid `200px 1fr`; left nav items 32px (General, Game, Conflicts, Backups, Language, Updates, About); right column max 640, padding 24 32, title 500 20px, setting groups as bg-3 cards with rows (13px label + 11px ink-3 helper, right control).
- General: Start with Windows (toggle), Reduce motion (follows system), Keyboard shortcuts summary "Ctrl K search · 1–5 sections · [ ] sidebar · Esc close".
- Game: "War Thunder · Steam" + mono path + Change (→ folder picker flow); Watched folder + Change.
- Conflicts: radio cards — Ask every time / Replace and keep a backup / Install as a copy / Skip (selected border amber, 8px amber dot).
- Backups: "Keep a backup when replacing or deleting" toggle, "Lets you undo for 30 days."; "Backups on disk · 3 items · 148 MB" + Clear.
- Language: radio cards English / Italiano / Deutsch / Русский / Français.
- Updates: "Livery 0.1.0 · You're up to date." + Check now; "Install updates automatically" toggle.
- About: brand row + mono "0.1.0 · Windows x64"; "A user skin manager for War Thunder. Browse WT Live, install with a click, keep your hangar tidy."; boxed line **"Unofficial tool, not affiliated with Gaijin Entertainment."**; links Source code · Report a problem · Licenses. No Gaijin/War Thunder logos anywhere.

## Interactions & keyboard
- Ctrl/Cmd+K palette; Esc closes palette/menus/dialogs/zoom; 1–5 switch sections; `[`/`]` sidebar; ↑↓↵ inside palette; Tab order follows visual order; every card is `role=button tabindex=0` (Enter opens, Install button inside is separately focusable).
- Install: optimistic UI — the card switches to progress instantly on click; steps Download → Extract → Verify → Done from backend events; on Done, skin joins My Hangar and toasts.
- Filters apply synchronously (no debounce needed; virtualized grid); result count + ms shown.
- Delete/replace are always undoable via toast for 6s (backend keeps a backup per the Backups setting).
- Offline: WT Live queries fail → Explore shows offline state, title-bar tag appears, sidebar dot grey; Hangar/Collections/Queue/Settings unaffected.

## State (frontend store)
`screen`, `sidebarOpen`, `palette{open,query,index}`; explore `{tab, q, nation, type, class, vehicle, category, sort}`; `installs: Record<skinId, {step, pct}>`; `installed: Set<skinId>`; detail `{skinId, tab, galleryIndex, zoom, compare, compareWith, tryState: idle|installing|active}`; hangar `{view, q, nation, type, origin, selection: Set<id>}`; `collections[]`, `activeCollectionId`; `queue[]` items `{id, file, size, vehicle, code, status: analyzing|ready|conflict|verify|done, note}`; `conflictDialogId`; settings `{gamePath, gameSource, watchFolder, autoInstall, conflictPolicy, backups, language, autoUpdate}`; `toasts[]`; `online`.

## Tauri commands (suggested)
`detect_game() -> {found, source, path, version, existingSkins}`, `set_game_path(path)`, `scan_user_skins() -> HangarItem[]`, `analyze_archive(path) -> QueueItem`, `install_skin(source, mode: normal|temporary, conflict: replace|copy|skip)` (emits `install://progress`), `finalize_try(id, keep: bool)`, `set_skin_active(id, bool)`, `delete_skins(ids, backup: bool)`, `restore_backup(id)`, `export_skins(ids, dest)`, `read_textures(id) -> TextureInfo[]`, `watch_folder(path, enabled)`, `wtlive_search(params)`, `wtlive_post(id)`.

## Assets
- Fonts: Geist (400/500/600), IBM Plex Mono (400/500) — self-host.
- Icons: Lucide (`compass, warehouse, layers, download, settings, search, chevron-down, check, x, minus, square, arrow-left, external-link, layout-grid, list, zoom-in, zoom-out, columns-2, folder-open, refresh-cw, trash-2, upload`).
- Imagery: all screenshots are placeholders (`repeating-linear-gradient(135deg,#1e1f23 0 10px,#232428 10px 20px)`); real images come from WT Live post attachments. No Gaijin assets.

## Files in this bundle
Start with **`CLAUDE.md`** (conventions for Claude Code), then **`BUILD_PLAN.md`** (milestones M0–M6), **`DATA_MODEL.md`** (types, Tauri commands, events, SQLite), **`tokens/tailwind.tokens.cjs`** (ready Tailwind theme), **`KICKOFF_PROMPT.md`** (what to paste into Claude Code), `DESIGN_NOTES.md` (log of open decisions).

- `Livery Prototype.dc.html` — full clickable prototype (all screens + flows). Tweaks: window size 1100×700 / 1440×900 / 1920×1080, offline, reduce motion.
- `Livery Design System.dc.html` — tokens, type, spacing, card states, controls, feedback.
- `Livery Explore Directions.dc.html` — the three explored directions; the chosen one is **2a** (Cockpit forms + drawing-sheet grid).
- `support.js` — runtime needed to open the `.dc.html` files locally.
