# Livery — instructions for Claude Code

Livery is an unofficial Windows desktop skin manager for War Thunder. The **design handoff** lives in `design_handoff_livery/`: the `.dc.html` files are hi-fi interactive design references (not code to copy); `README.md` is the screen-by-screen spec; `DATA_MODEL.md` the types/commands/events; `BUILD_PLAN.md` the milestones. Read them in that order before writing code. `tokens/` and `DESIGN_NOTES.md` stay at the repo root because the app uses and updates them.

## Stack (fixed)
- Tauri 2 (Rust 1.80+) · React 18 · TypeScript strict · Vite · Tailwind 3.4 · Zustand · TanStack Query + TanStack Virtual · react-i18next · Lucide React · Vitest + React Testing Library · cargo test.
- Frameless window, min 1100×700, default 1440×900. Windows is the only release target; keep the Rust side OS-agnostic where cheap.

## Conventions
- Tailwind only, tokens from `tokens/tailwind.tokens.cjs` (spread into `tailwind.config`). No ad-hoc hex values in components; if a value is missing, add a token and note it in `DESIGN_NOTES.md`.
- Fonts self-hosted in `src/assets/fonts` (Geist 400/500/600, IBM Plex Mono 400/500 woff2). Never load from Google Fonts at runtime.
- All user-visible strings via `t('key')`; English source in `src/i18n/en.json`; keys namespaced per screen (`explore.*`, `hangar.*`, `queue.*`, `settings.*`, `common.*`). Add `it.json` with the same keys (Italian) — the author is Italian.
- Icons: Lucide only, `size={14}` in controls, `16` in nav, `strokeWidth={1.75}`.
- No spinners. Loading = skeleton (`Skeleton` component, shimmer 1.4s). `prefers-reduced-motion` disables all animation via the `motion-safe:` variant.
- Every state change the user can regret (delete, replace, discard) goes through `toast.undoable()` and a backend backup.
- Paths are hidden by default in the UI ("Show path" reveals). Never show Gaijin/War Thunder logos. Footer of About: "Unofficial tool, not affiliated with Gaijin Entertainment."
- Rust: one module per domain (`game`, `archive`, `textures`, `library`, `wtlive`, `watch`, `backup`). Commands return `Result<T, AppError>`; `AppError` serializes to `{ code, message, detail? }`. Long operations emit events (see DATA_MODEL.md) instead of blocking.
- Tests: every Rust parser (blk, archive layout, DDS/TGA header) has fixture-based unit tests in `src-tauri/tests/fixtures`. Frontend: store logic and reducers under Vitest; components smoke-tested.

## Workflow
- Work milestone by milestone from `design_handoff_livery/BUILD_PLAN.md`; finish a milestone's acceptance list before starting the next.
- After each milestone run `pnpm tauri dev` and compare with the corresponding screen in `design_handoff_livery/Livery Prototype.dc.html` (serve the folder over http; `support.js` must sit next to it). Match spacing/color/type 1:1.
- Commit per milestone with a short conventional-commit message.
- Ask before adding dependencies not listed above.
