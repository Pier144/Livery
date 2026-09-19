# Design notes (living document)

Record here every decision taken during implementation that the handoff left open, plus any token or copy added.

| date | topic | decision | why |
|---|---|---|---|
| 2026-09-19 | Repo layout | Handoff docs moved to `design_handoff_livery/`; `CLAUDE.md`, `DESIGN_NOTES.md` and `tokens/` stay at the root (the app reads/updates them). App scaffolded at the root. | Kickoff assumed this layout; keeps design refs apart from code. |
| 2026-09-19 | Tooling versions | React 18.3, TypeScript 5.9 (not 7), Vite 8, Vitest 5, Tailwind 3.4, Tauri 2.11, Zustand 5, TanStack Query 5 / Virtual 3, react-i18next 17, lucide-react 1.x. | Stack fixed by CLAUDE.md; TS 5.9 chosen over the new native TS 7 for ecosystem compatibility. |
| 2026-09-19 | Dependencies approved beyond the stack | jsdom, @testing-library/jest-dom, @testing-library/user-event, axe-core (dev). Fonts copied from `geist@1.7.2` and `@fontsource/ibm-plex-mono@5.3.0` (not kept as deps). Rust: serde/serde_json (Tauri template), tracing + tracing-subscriber (BUILD_PLAN M0). | Approved by the author on 2026-09-19. |
| 2026-09-19 | Tauri plugins deferred | dialog, opener (shell-open), os, fs and updater are **not** added in M0. M1 uses only core window/webview APIs. Each plugin will be proposed in the milestone that needs it (dialog/opener → M2, updater → M6, which also needs a signing key). | Author did not approve the plugin group yet. |
| 2026-09-19 | Fonts | Geist 400/500/600 (static woff2); IBM Plex Mono 400/500 in latin, latin-ext and cyrillic subsets with `unicode-range`. `↵` (U+21B5) is not in Plex Mono's latin subset and falls back to the system mono. | Cyrillic needed for the Русский language option. |
| 2026-09-19 | Tokens added | `bg.scrim` rgba(19,20,22,.85) (drop overlay), `bg.skel` #222327 (skeleton title bar, from prototype), `backgroundSize.shimmer` 200% 100%, `backgroundPosition.grid` -1px -1px, `fontSize.heading-lg` 18px/1.3 500 (empty-state and dialog titles). | Values used by the prototype but missing from the token file. |
| 2026-09-19 | Ruled grid utility | `bg-grid` emits image + 28px size + -1px position in one class (three token groups share the key). | One class per content area. |
| 2026-09-19 | Settings shortcut | Keys 1–5 switch sections (5 = Settings) and `,` also opens Settings, matching the sidebar hint. `[` and `]` both toggle the sidebar (prototype behaviour). | README lists "1–5" but the sidebar shows `,` for Settings. |
| 2026-09-19 | Sidebar preference | `sidebarOpen` is persisted in localStorage (`livery.ui`); nothing else in the UI store persists. | Per-user convenience; not worth a backend setting. |
| 2026-09-19 | Settings file | `<appData>/settings.json`, written atomically (temp + rename). Unknown fields ignored, missing fields defaulted; a corrupt file is renamed to `settings.json.bad` and defaults are used. | Never crash on a bad settings file. |
| 2026-09-19 | App identifier | `app.livery.desktop`. | Neutral reverse-DNS id; change before the first public release if a domain is registered. |
| 2026-09-19 | Vehicle list | `src/data/vehicles.json` holds a 9-vehicle placeholder seed (the prototype's sample vehicles) for the palette until M5 ships the datamined list. | BUILD_PLAN open decision 3 is taken in M5. |
| 2026-09-19 | App icon | Amber dot (#F7A224 ≈ oklch(0.78 0.16 70)) with glow on a graphite tile with a faint ruled grid; source `src-tauri/icons/app-icon.svg`. | Design system names the concept but has no asset. |
