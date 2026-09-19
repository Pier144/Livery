export const meta = {
  name: 'livery-m5ui-m6settings',
  description: 'M5 UI (Explore, Following, Skin detail) on the mock + M6 Settings screen; WT Live backend stubbed pending HTTP approval; each part reviewed',
  phases: [
    { title: 'Rust', detail: 'wtlive stubs (offline), following store, read_textures wtliveId → review' },
    { title: 'Mock', detail: 'mock backend: WT Live catalog, installs, try in game, following' },
    { title: 'Explore', detail: 'Explore + Following tabs → review' },
    { title: 'Detail', detail: 'Skin detail (Gallery, Textures, Try in game, side panel) → review' },
    { title: 'Settings', detail: 'Settings screen + reduce motion + change game → review' },
  ],
}

const COMMON = `
You are working on Livery, an unofficial War Thunder skin manager: Tauri 2 (Rust) + React 18 + TypeScript strict + Vite 8 + Tailwind 3.4 + Zustand 5 + TanStack Query 5 + TanStack Virtual 3 + react-i18next 17 + lucide-react + Vitest 5/RTL; cargo test. Repo root D:\\Dev\\Progetti\\Livery (Windows 11; PowerShell or Bash tool). M0–M4 are committed; the M5/M6 foundation is in the working tree. Other agents work on OTHER parts in parallel.

CONSTRAINTS: an HTTP client and HTML parser (reqwest/scraper), tauri-plugin-opener, tauri-plugin-autostart and tauri-plugin-updater are NOT approved dependencies yet (CLAUDE.md: ask before adding deps; the author is away). So: the real WT Live commands answer code 'unsupported' and the UI shows its designed OFFLINE state; the UI is built and verified against the in-browser mock backend (pnpm dev:mock). Links that need to open the browser can't open yet (copy the URL to the clipboard and say so); Start with Windows and auto-update controls are disabled with a short helper saying they arrive in a later build. Never add dependencies.

READ FIRST
- design_handoff_livery/README.md — Explore §2 lines 111-127, Skin detail §3 129-135, Settings §7 155-163, tokens 19-82, global chrome 84-99, interactions 165-171, state 172-173. README wins over the prototype.
- design_handoff_livery/DATA_MODEL.md; design_handoff_livery/BUILD_PLAN.md (M5 31-36, M6 38-42, open decisions 47-51).
- design_handoff_livery/Livery Prototype.dc.html — Explore markup 111-208 and logic 745-780 (+ card() 680-685, stepOf 677); Skin detail markup 209-321 and logic 781-803 (+ textures() 687-696); Settings markup 478-531 and logic 864-873; the CATALOG sample data 585-603.
- DESIGN_NOTES.md (every decision so far — follow them) and CLAUDE.md.
- Foundation to use (don't rewrite): src/types.ts (WtLiveSkin, SearchParams, SearchResult, SortOrder, FollowEntry, FollowKind, InstallMode, TextureInfo incl. warningKind, Settings incl. reduceMotion, Screen incl. 'detail', EVENTS), src/store/ui.ts (openSkin(id), detailSkinId, startFirstRun({step,returnTo}), firstRun entry, online), src/queries/wtlive.ts (useWtLiveSearch, useWtLivePost, useFollowing, useSetFollow, useMarkFollowingSeen, useFollowingNew, installFromWtLive, useFinalizeTry, isOfflineError, WTLIVE_KEY), src/store/installs.ts (useInstalls, useWtLiveInstall(skin) → {state: idle|installing{step,pct}|installed{temporary}|error{message,code}, install(conflict?)}, useWtLiveInstallEvents already mounted in App), src/queries/hangar.ts, src/queries/collections.ts, src/queries/settings.ts (useSettings, useUpdateSettings, SETTINGS_KEY), src/lib/tauri.ts (call, hasBackend, isTauri), src/lib/events.ts, src/data/vehicles.ts (local vehicle list for autocomplete), UI primitives src/components/ui (Button sizes 26-36, Menu, ChipDropdown labelValue/label, SegmentedControl, Checkbox, Switch, TextInput, Skeleton/SkeletonCard/SkeletonGrid, EmptyState, Kbd), the Hangar card pattern (src/screens/Hangar/SkinCard.tsx: full-card role=button hit area UNDER the inner controls to avoid nested-interactive), src/screens/ScreenHeader.tsx, toast/toast.undoable (src/store/toasts.ts).

RULES
- Tailwind token utilities only (no hex/rgb/oklch literals in components; inline style only for computed geometry). Add a missing color token with one small Edit to tokens/tailwind.tokens.cjs and report it.
- All strings via t('…'): EN + natural IT (plurals _one/_other) in BOTH src/i18n/en.json and it.json, small Edit calls inside your own namespace (explore.*, detail.*, settings.*) — never rewrite those files; re-Read and retry on conflict. Localize backend warnings by kind (TextureInfo.warningKind; hangar.attention.* for attention kinds).
- Lucide icons (14 controls, 16 nav, strokeWidth 1.75). Motion only via motion-safe:. No spinners — skeletons/progress bars.
- A11y WCAG AA (ink-4 minimum for small text; see DESIGN_NOTES contrast rows), roles/names/states, keyboard, visible focus, Escape closes only the topmost layer, focus restore, live regions.
- Regrettable changes go through toast.undoable().
- FILE OWNERSHIP: only your listed files (+ Edit-only i18n/token additions). Report out-of-scope needs in outOfScope.
- Frontend tests: Vitest + RTL + user-event; resetStores(); renderWithProviders(ui, { settings, client }); seed queries with the client; mock '@/lib/tauri' (override isTauri AND hasBackend AND call) and '@/lib/events' as needed; axe via seriousViolations → []. Run only your tests, then pnpm typecheck (fix your files).
- Rust: AppError everywhere, crate::blocking for disk work, fixture/temp-dir tests, cargo test + clippy -D warnings.
`

const RUST = `
YOUR TASK: the Rust side of M5 that doesn't need HTTP.
Owned files: src-tauri/src/wtlive.rs (you may turn it into src-tauri/src/wtlive/mod.rs + submodules), src-tauri/src/textures/mod.rs (only to add the wtliveId parameter), src-tauri/tests/wtlive_*.rs, src-tauri/tests/following_*.rs. You may add ONE managed-state line to src-tauri/src/lib.rs setup (report it).
- wtlive_search / wtlive_post / wtlive_following_new / install_from_wtlive / finalize_try: return AppError code Unsupported with a short user-safe message: "WT Live can't be reached from this build yet: it needs a network library the author hasn't approved." and emit net://status { online: false } (NET_STATUS_EVENT) — never panic. Keep a clean seam for the future implementation: a WtLiveClient trait (search/post/following_new/download) with a Disabled implementation used today, so the real HTTP client plugs in later without touching the commands; document the plan in the module doc (fetch listing/post pages, parse behind a Parser trait, 24 h cache in the app data dir, 1 req/s rate limit, Livery user agent, BUILD_PLAN open decision 2: fetch the first 5 pages, prefetch the rest, filter locally).
- Following (local data, works offline): store <appData>/following.json { version: 1, entries: FollowEntry[] } with atomic writes and tolerant load (like settings.rs / library index). following_list; following_set(kind, id, name, follow) → add (lastSeenAt = now, RFC 3339 via crate::library::time) or remove (idempotent), returns the list; following_mark_seen → every entry's lastSeenAt = now. Validate: id and name non-empty (InvalidInput).
- read_textures: add an optional wtlive_id argument (the frontend sends { wtliveId }) → Unsupported (same message) for now; keep skinId/queueId behaviour; exactly one of the three required (InvalidInput otherwise).
- Settings: model.rs already has reduce_motion; add a test in tests/wtlive_*.rs or a settings test proving { reduceMotion: 'on' } round-trips through SettingsPatch and defaults to 'system'.
- Tests: commands' core functions (pure, no AppHandle) for following CRUD/mark-seen/persistence/corrupt file, the Disabled client error, read_textures argument validation.
`

const MOCK = `
YOUR TASK: extend the in-browser mock backend for M5/M6 (read src/dev/mockBackend.ts and src/dev/mockData.ts fully first; keep every existing behaviour, latency, JSON-wire semantics and switches).
Owned files: src/dev/** only.
- WT Live catalog: the prototype's 16 CATALOG skins (lines 585-603) as WtLiveSkin: ids s1..s16, vehicles resolved to real-looking codes/nations/types/classes (use src/data/vehicles.json where they exist; add plausible ones otherwise), authors with ids/urls (https://live.warthunder.com/user/<id>/ style), category, downloads, likes, postedAt (from the prototype dates, year 2026), sizeBytes from MB, images: 4 placeholder entries (empty strings are NOT ok — use '' only if the UI treats them as placeholders; prefer an empty array and let the UI show 4 placeholder views), postUrl/downloadUrl plausible, isNew from the prototype flag, files (hull_c.dds … + <code>.blk) for posts.
- wtlive_search({params}) → filter (q matches name, vehicle name or author name, case-insensitive; nation; type; class; vehicle code; category — all AND), sort (downloads | likes | newest | name), page (pageSize 60; page 0 returns the first 60), total, tookMs = 12 + items (like the prototype). wtlive_post({id}) → full skin (unknown → notFound). wtlive_following_new({vehicles, authors}) → isNew skins matching those. following_list/following_set/following_mark_seen with the 4 prototype follows (lines 603) seeded as entries (lastSeenAt old enough that some skins count as new).
- install_from_wtlive({skinId, mode, conflict?}) → {installId}, then progress events over ~3 s (download 0→40, extract →75, verify →96, done 100 with skinId of the new hangar skin), adding a HangarSkin with origin 'wtlive', sourceId = WT Live id, author, vehicle, sizeBytes; mode 'temporary' → temporary: true (not counted as a normal install: Explore still shows it as not installed? The UI decides; just set temporary). Already installed (same sourceId, not temporary) → reject {code:'conflict'} unless conflict is given (replace/copy/skip like the queue). finalize_try({skinId, keep}) → keep: temporary=false and return the skin; discard: remove it and return null (skinId = the WT Live id).
- read_textures({wtliveId}) → the prototype's textures() list (lines 687-696) as TextureInfo with warningKind ('heavy' for s3's 8192 hull, 'missing' for s5's 4th texture) + the BLK entry; keep existing skinId/queueId behaviour.
- A ?offline=1 switch (and localStorage livery.mock.offline): every wtlive_* and install_from_wtlive rejects {code:'network', message:"WT Live can't be reached"}; following_* still works. Document it in the header.
- Settings: keep reduceMotion in the mock settings (default 'system') and accept it in set_settings.
- Tests: search filters/sort/tookMs, install → progress → hangar skin with sourceId, conflict, temporary + finalize keep/discard, offline switch.
`

const EXPLORE = `
YOUR TASK: build **Explore** (+ the Following tab), replacing the placeholder src/screens/Explore.tsx.
Owned files: src/screens/Explore.tsx (keep the named export Explore), src/screens/Explore/** (create: ExploreHeader, FilterRow, VehicleInput, ActiveFilters, SkinGrid (virtualized), SkinCard, CardAction, Following, exploreModel.ts + tests), src/store/explore.ts (+ test), src/components/chrome/paletteItems.ts and src/components/chrome/CommandPalette.tsx (+ their tests) ONLY for the two M5 TODOs: vehicle results apply the Explore vehicle filter, and skin results come from the cached WT Live search results (queryClient cache) and open the Skin detail (useUi.openSkin).
- Store (UI state only): tab 'explore'|'following', q, nation, type, class, vehicle (code), category, sort (default 'downloads'); actions set/clear each, clearAll, applyVehicle(code), applyAuthor(name) (sets q), setTab.
- Header (padding 18 24 0, gap 14; border-bottom line-2): tabs Explore / Following (500 14px, active ink-1 + 2px amber underline, inactive ink-3; role=tablist) — Following carries a pill "{n} new" (amber text, border amber-50, rounded-pill, mono 10px) with n = new skins from useFollowingNew; right: mono 11px ink-4 "{total} results · {tookMs} ms" (Intl number format).
- Filter row (28px controls, gap 8, wrap): ChipDropdown labelValue Nation / Class / Category (value amber when set, "Any" otherwise; nation labels full names — reuse hangar.nation.* keys; classes from the local vehicle list; categories Historical/Semi-historical/Fictional/Camouflage/Other); SegmentedControl Type "All types / Ground / Air / Helicopters / Naval"; VehicleInput 200x28 (bg-input border line-3) with an ARIA combobox autocomplete menu (name + mono code; matches name or code; from src/data/vehicles.ts; picking sets the vehicle code filter; Escape closes only the menu); right: text "Sort" + Menu button "Most downloaded ▾" (Most downloaded / Most liked / Newest / Name A–Z).
- Active-filters line (only when any): mono 11px ink-4 "{n} filters combined" (1 → "1 filter") | each filter as "Label ×" removable button | "Clear all" (amber).
- Grid: repeat(auto-fill, minmax(250px,1fr)), gap 16, virtualized with TanStack Virtual (rows of cards by container width, like src/screens/Hangar/HangarGrid.tsx), bottom padding 24.
- SkinCard (README line 120 + prototype card): bg-bg-3 border-line-2 rounded-card, hover border-amber + shadow-card, focus ring; 16:9 image (skin.images[0] when present, else bg-placeholder) with top-left category tag (10px mono, dark translucent bg — add token bg.tag = rgba(15,16,18,.85) if missing, rounded-menu px-1.5), top-right "NEW" badge (amber bg, onAmber, mono 10px) when isNew, bottom corners 9px L-marks in line-mark; body p-3 gap-[7px]: name (text-card, ellipsis); nation tag (10px mono, border line-3, rounded-tag, e.g. GER) + vehicle name 12px ink-3; "by {author}" (author ink-2) + mono "24.1k dl · 1.9k likes" (compact numbers). Action row 30px from useWtLiveInstall(skin): idle → "Install 48 MB" button (bg-bg-4 border-line-3; hover bg-amber text-onAmber); installing → 3px progress bar + mono steps "Download ✓ · Extracting 56% · Verify · Done" (current step amber) like the prototype stepOf; installed → amber-10 fill amber-35 border "Installed ✓" (lucide Check) + "in Hangar"; error → danger-8 fill danger-40 border "Install failed" + "Retry" link, and a helper line below with the reason; if the error code is 'conflict' offer "Install as a copy" instead of Retry (install('copy')). Clicking the card opens the detail (useUi.openSkin); the Install button stops propagation. Use the Hangar card's hit-area pattern (role=button full-card layer under the controls) — record the decision.
- States: loading → 8 SkeletonCards; no results → EmptyState "No skins match" / "Try fewer filters, or search by vehicle code instead." / "Clear all filters"; offline (isOfflineError) → EmptyState with grey dot "WT Live can't be reached" / "Your library works as usual. Browsing and installing from WT Live will resume when you're back online." / primary "Open My Hangar" (go hangar), secondary "Retry" (refetch; toast "Still offline. Your library is fully available." when it fails again).
- Following tab: grid 280px 1fr; left list with mono label "FOLLOWING · {n}" and follow cards (name, mono "Vehicle · code" or "Author · {n} skins on WT Live", amber pill "{n} new"; click → switch to the Explore tab with that vehicle filter / author query); an unfollow action per card (× with aria-label; undoable toast). Right: mono label "NEW FROM PEOPLE AND VEHICLES YOU FOLLOW" + grid of new skins (card with NEW badge, name, "vehicle · by author · date"), opening the detail on click. Empty follows → EmptyState explaining how to follow (from a skin's detail). Opening the Following tab calls useMarkFollowingSeen after it has shown the counts (don't zero them before the user sees them — e.g. on leaving the tab).
- The Sidebar status line can show the WT Live total: out of scope (report); don't edit Sidebar.
- i18n: explore.* keys EN+IT.
- Tests: exploreModel (filters → SearchParams, active-filter list, compact numbers, step text), store, filter interactions (chips, segmented, vehicle autocomplete keyboard, sort menu, remove filter, clear all), card states (idle → click Install → installing progress → installed via hangar sourceId; error + retry; conflict → copy), card click opens the detail but Install doesn't, offline and empty states, Following (counts, click applies filter, unfollow undo), palette vehicle → filter and skin → detail, virtualization bounded for 500 results, axe clean.
`

const DETAIL = `
YOUR TASK: build the **Skin detail** screen, replacing the stub src/screens/Detail/SkinDetail.tsx.
Owned files: src/screens/Detail/** (create: DetailTopBar, Gallery, Compare, TexturesTab, TryInGame, SidePanel, detailModel.ts + tests), src/store/detail.ts (+ test).
- Data: the skin id is useUi(s => s.detailSkinId); load with useWtLivePost(id) (skeletons while loading; offline → EmptyState like Explore's offline with a Back button). Installed state and actions via useWtLiveInstall(skin) and src/store/installs.ts; hangar skin = useHangar() entry with sourceId === id.
- Store (UI only): tab 'gallery'|'textures'|'try' (reset per skin), galleryIndex, zoom, compare, compareWith (skin id), tryState derived from installs/hangar (idle | installing | active).
- Top bar (px-6 py-3, border-b line-2): "← Explore" secondary 28px button (lucide ArrowLeft) → go('explore') (Explore keeps its filters); name 500 16px + mono code ink-4; right tabs Gallery / Textures / Try in game (role=tablist, 2px amber underline on the active one). Keys: Escape exits zoom/compare first (only that layer), otherwise does nothing special.
- Grid 1fr 320px (full height, each column scrolls).
- Gallery: main image (border line-2, rounded-card, 9px corner L-marks in line-mark, mono counter "1 / 4" top-right) — images from the post, else 4 placeholder views labelled Front/Side/Rear/Detail; bottom-left buttons "Zoom in"/"Zoom out" (lucide ZoomIn/ZoomOut; toggles scale(1.6) with a motion-safe 250ms transform transition) and "Compare" (lucide Columns2; only when other skins of the same vehicle are known — use the cached WT Live search results or useWtLiveSearch({ vehicle: code, sort: 'downloads', page: 0 })); thumbnails 120x68 (Front/Side/Rear/Detail), active border amber, arrow keys move between them (roving tabindex). Compare mode: two panes side by side, A (border-amber-60) labelled "A · {name}", B labelled "B · {name} · by {author}"; below, mono label "COMPARE WITH · same vehicle" + buttons for the other skins (active one amber text); "Exit compare".
- Textures tab: heading "Textures in the archive" + mono "{n} files · {size}"; data: call('read_textures', { skinId: hangarSkin.id }) when installed, else call('read_textures', { wtliveId: id }) (TanStack query; offline/unsupported → the offline empty state inside the tab). Optional warning banner (bg-amber-10 border amber/.4 → use amber-35 or add a token) "{n} file(s) need attention. The skin still installs; the game may skip the affected part."; spec table (bg-bg-3 rounded-card): header mono-label "FILE | RESOLUTION | FORMAT | SIZE"; rows 12px mono with a 28px swatch (bg-placeholder-thumb); warnings as an amber line under the row localized by warningKind (heavy with the size, notSquarePow2, unreadable, missing → "Referenced in skin.blk but not in the archive."); missing files render "—" and "missing" in amber; the BLK row last.
- Try in game (centred column max-w-[560px]): idle → title "Try it before you keep it", body "Livery installs the skin temporarily. Look at it in the game, then decide. Nothing is added to My Hangar until you press Keep.", steps card 01 "Livery copies the files into UserSkins", 02 "In War Thunder, open the vehicle’s Customisation and press the **refresh** button", 03 "Come back and choose Keep or Discard"; primary "Try in game · {size}" → useInstalls.start(id, 'temporary'). Installing → "Installing temporarily…" + an indeterminate amber bar (motion-safe animation; static bar under reduced motion — no spinner). Active (hangar skin temporary) → pulsing amber dot (motion-safe) + "Skin is in the game", body "Open **{vehicle}** → Customisation → press **refresh**, then select “{name}”."; amber-tinted card "TEMPORARY · WILL BE REMOVED ON DISCARD" + mono folder "UserSkins/{folder}/"; primary **Keep** (useFinalizeTry keep → toast "Kept “{name}” — it’s in My Hangar") / secondary **Discard** (keep false → toast "Discarded “{name}”. Game files restored." — this IS the undo of the temporary install, so no extra undo).
- Side panel (320px, bg-bg-1, border-l line-2, p-5, gap-[18px]): AUTHOR block — mono label, 34px avatar circle with the initial, name 500 14px, "on WT Live", Follow/Following toggle button (useSetFollow author; undoable unfollow); amber link-button "Open original post" + lucide ExternalLink → can't open the browser yet: copy postUrl to the clipboard (navigator.clipboard.writeText) and toast t('detail.linkCopied') explaining it; creators always visible. VEHICLE card (button: name + mono "code · nation · class") → Explore filtered by that vehicle (useExplore store applyVehicle if it exists — it's another agent's file; if not available, useUi.go('explore') and report). 2x2 stat cells (DOWNLOADS, LIKES, CATEGORY, POSTED — mono labels, values 13px; posted date localized with Intl.DateTimeFormat in the current language). FILES INCLUDED "{n} · {size}" + mono list of files. Bottom: Install / progress / Installed (36px, same states as the Explore card action row) and "Add to collection ▾" (Menu of useCollections; disabled with a title explaining "Install it first" until installed; picking → useSetCollectionSkins add the hangar skin id → toast "Added to “{collection}”").
- i18n: detail.* keys EN+IT.
- Tests: loading skeleton, gallery thumbnails keyboard + zoom toggle + Escape exits zoom, compare mode and switching B, textures table with warnings localized and missing rows, try in game idle → installing → active (hangar temporary) → keep/discard calls finalize_try and toasts, side panel follow toggle, open post copies the link, add to collection disabled until installed, offline state, axe clean on each tab.
`

const SETTINGS = `
YOUR TASK: build the **Settings** screen (README §7 lines 155-163, prototype 478-531 + 864-873), replacing the placeholder src/screens/Settings.tsx.
Owned files: src/screens/Settings.tsx (keep the named export Settings), src/screens/Settings/** (create one component per section + LicensesDialog + tests), src/hooks/useReduceMotion.ts (+ test; mount it in src/App.tsx with ONE added hook call — allowed), src/screens/FirstRun/FirstRun.tsx + firstRunMachine.ts (+ their tests) ONLY to honour useUi.firstRun { step: 'detect'|'choose', returnTo } (start directly in the not-found/choose view when step is 'choose'; when finished or skipped go to returnTo instead of 'explore'; onboarding behaviour unchanged), src/store/toasts.ts (+ test) ONLY to add an optional onExpire callback to toast.undoable (called once when the toast times out or is dismissed without Undo; keep the public API and all existing tests green).
- Layout: grid 200px 1fr; left nav (border-r line-2, px-3 py-4.5, gap 2px) items 32px rounded-ctl px-2.5 500 13px (active bg-hover ink-1, others ink-3, hover bg-hover ink-1; a nav with aria-current, or a vertical tablist — choose the right ARIA pattern and record it): General, Game, Conflicts, Backups, Language, Updates, About. Right: max-w 640, px-8 py-6, gap 20, overflow-auto; section title 500 20px; setting groups = bg-bg-3 border-line-2 rounded-card cards with rows (px-4 py-3.5, gap 16, border-b line-2 between rows): 13px label + 11px ink-3 helper, control on the right. Remember the open section in the UI (store or local state; persists while the app runs).
- General: "Start with Windows" Switch disabled + helper t('settings.general.autostartPending') (needs the autostart plugin; say it plainly); "Reduce motion" SegmentedControl System / On / Off bound to settings.reduceMotion (useUpdateSettings) with helper "Follows your Windows setting by default."; useReduceMotion (mounted in App) sets document.documentElement.dataset.reduceMotion = 'true' when 'on', removes it for 'system' (the CSS already honours prefers-reduced-motion through motion-safe:) and for 'off' sets it to 'false' — AND make 'off' actually override the OS preference only if feasible without touching every component; if not feasible, document that 'off' = follow the OS (and label the option accordingly). "Keyboard shortcuts" summary row "Ctrl K search · 1–5 sections · [ ] sidebar · Ctrl Z undo · Esc close" (mono keys via Kbd).
- Game: "War Thunder · {Steam|Standalone|Custom}" + mono path (hidden until "Show path"; data-selectable) + Change (secondary 28px) → useUi.startFirstRun({ step: 'choose', returnTo: 'settings' }); when no game folder: "No game folder set" + Choose (same action). "Watched folder" row: mono path (default Downloads — show t('settings.game.downloadsDefault') when unset) + Change → folder picker (dynamic import('@tauri-apps/plugin-dialog').open({ directory: true })) → call('watch_folder', { path, enabled: settings.autoInstall }) → setQueryData(SETTINGS_KEY, result); errors → toast.
- Conflicts: intro 13px ink-3 "What to do when an archive has the same folder as an installed skin."; radio cards (role=radiogroup, arrow keys) Ask every time / Replace and keep a backup / Install as a copy / Skip: bg-bg-3 border (line-3, amber when selected, hover line-mark) rounded-card px-3.5 py-3 gap-3 13px; 14px ring with an 8px amber dot when selected → conflictPolicy.
- Backups: Switch "Keep a backup when replacing or deleting" (settings.backups) helper "Lets you undo for 30 days."; "Backups on disk" + mono "{n} items · {size}" from call('list_backups') (query; refetch on focus of the section) + Clear (secondary 28px, disabled when 0) → deferred commit: immediately hide them in the UI (count 0) and show toast.undoable("Cleared {n} backups", undo = restore the UI count) with onExpire = call('clear_backups') then refetch — so Clear is undoable for 6 s even though clearing is permanent.
- Language: radio cards English / Italiano / Deutsch / Русский / Français → settings.language (the UI switches immediately via useLanguageSync); de/ru/fr get a small mono hint t('settings.language.englishForNow') since only EN and IT are translated.
- Updates: "Livery {version}" (getVersion() from '@tauri-apps/api/app' when isTauri, else package version '0.1.0') + helper t('settings.updates.pending') (the updater arrives in a later build) + "Check now" disabled; "Install updates automatically" Switch disabled (keeps settings.autoUpdate).
- About: brand row (10px amber dot with glow, "LIVERY" 600 14px tracking .14em, mono 11px ink-4 "{version} · Windows x64"); description 13px/1.6 ink-2 "A user skin manager for War Thunder. Browse WT Live, install with a click, keep your hangar tidy."; boxed line (bg-bg-3 border-line-2 rounded-card px-3.5 py-3 ink-3) t('common.unofficial') — "Unofficial tool, not affiliated with Gaijin Entertainment."; links row 12px: "Source code" and "Report a problem" (no public URL yet and no opener plugin → render as disabled link-styled buttons with a title explaining), "Licenses" → LicensesDialog (in-app, focus-trapped, Escape closes): Geist and IBM Plex Mono (SIL OFL 1.1 — the license texts ship in src/assets/fonts/*.txt; import them with ?raw), and a short list of the main open-source libraries with their licenses (React MIT, Tauri MIT/Apache-2.0, TanStack MIT, Zustand MIT, i18next MIT, Lucide ISC, Tailwind MIT). No Gaijin/War Thunder logos anywhere.
- i18n: settings.* keys EN+IT (Italian natural: "Avvia con Windows", "Riduci animazioni", …).
- Tests: navigation between sections (keyboard), reduce motion segmented → settings + html data attribute via the hook, Game change → startFirstRun({step:'choose', returnTo:'settings'}) and FirstRun honouring it (choose view first; finishing returns to settings), watch folder change → watch_folder, conflict radio keyboard + persistence, backups toggle, Clear → toast undo keeps backups (no clear_backups call) / expiry calls clear_backups (fake timers), language switch changes the UI language, licenses dialog focus trap + Escape, about text contains the unofficial line, axe clean per section.
`

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' } },
    i18nKeysAdded: { type: 'array', items: { type: 'string' } },
    tokensAdded: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    testsPassing: { type: 'boolean' },
    testSummary: { type: 'string' },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
  required: ['filesChanged', 'i18nKeysAdded', 'tokensAdded', 'decisions', 'testsPassing', 'testSummary', 'outOfScope'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: { area: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, description: { type: 'string' }, fixed: { type: 'boolean' } }, required: ['area', 'severity', 'description', 'fixed'] } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    i18nKeysAdded: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    testsPassing: { type: 'boolean' },
    testSummary: { type: 'string' },
    remainingIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'filesChanged', 'i18nKeysAdded', 'decisions', 'testsPassing', 'testSummary', 'remainingIssues'],
}

const safe = (p) => p.catch(() => null)

const reviewPrompt = (what, owned, spec, impl) => `${COMMON}

YOUR TASK: you are an independent, skeptical reviewer of **${what}** that another agent just implemented. Assume mistakes until proven otherwise. Compare line by line against the spec below, README, DATA_MODEL and the prototype (exact px, colors, type, spacing, states), behaviour, keyboard + focus + Escape layering, accessibility, i18n (EN+IT natural, plurals), reduced motion, performance, error/offline handling, and whether the tests assert the spec. Fix every real finding in the owned files; re-run the owned tests and typecheck. Don't churn working code for taste.

Owned files: ${owned}

SPEC GIVEN TO THE IMPLEMENTER
${spec}

IMPLEMENTER'S REPORT (verify, don't trust):
${JSON.stringify(impl ?? { note: 'no report — inspect the files' }, null, 2)}`

const chain = (key, phase, spec, owned) => safe((async () => {
  const impl = await agent(`${COMMON}\n${spec}`, { label: `${key}:implement`, phase, schema: IMPL_SCHEMA })
  const rev = await agent(reviewPrompt(key, owned, spec, impl), { label: `${key}:review`, phase, schema: REVIEW_SCHEMA, effort: 'high' })
  return { part: key, impl, review: rev }
})())

const results = await Promise.all([
  chain('rust-m5', 'Rust', RUST, 'src-tauri/src/wtlive*, src-tauri/src/textures/mod.rs, src-tauri/tests/wtlive_*.rs, src-tauri/tests/following_*.rs, one lib.rs setup line'),
  safe(agent(`${COMMON}\n${MOCK}`, { label: 'mock:m5', phase: 'Mock', schema: IMPL_SCHEMA }).then((impl) => ({ part: 'mock', impl }))),
  chain('explore', 'Explore', EXPLORE, 'src/screens/Explore.tsx, src/screens/Explore/**, src/store/explore.ts, src/components/chrome/paletteItems.ts, src/components/chrome/CommandPalette.tsx (+tests)'),
  chain('detail', 'Detail', DETAIL, 'src/screens/Detail/**, src/store/detail.ts (+tests)'),
  chain('settings', 'Settings', SETTINGS, 'src/screens/Settings.tsx, src/screens/Settings/**, src/hooks/useReduceMotion.ts, the App.tsx hook call, src/screens/FirstRun/FirstRun.tsx + firstRunMachine.ts, src/store/toasts.ts (onExpire only) (+tests)'),
])
return results.filter(Boolean)
