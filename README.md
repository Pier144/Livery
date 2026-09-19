# Livery

Livery is a Windows desktop skin manager for War Thunder: it finds the game folder, keeps a library of the user skins in `UserSkins`, installs skin folders through a queue with conflict handling and undo, organises skins into collections, and browses WT Live (the screens are built; the network client waits for approval, so the real app shows the offline state, see [HANDOFF.md](HANDOFF.md)).

**Unofficial tool, not affiliated with Gaijin Entertainment.**

This README is for developers. The product spec is the design handoff in [`design_handoff_livery/`](design_handoff_livery/): `README.md` (screens), `DATA_MODEL.md` (types, commands, events), `BUILD_PLAN.md` (milestones). The `.dc.html` files are interactive design references, not code to copy.

## Stack

- **Desktop shell:** Tauri 2 (Rust 1.80+), frameless window, NSIS installer. Windows is the only release target.
- **Frontend:** React 18, TypeScript (strict), Vite, Tailwind 3.4 with the tokens in `tokens/`, Zustand, TanStack Query + TanStack Virtual, react-i18next (English and Italian), Lucide icons.
- **Tests:** Vitest + React Testing Library (+ axe-core) for the frontend, `cargo test` for the backend.

## Prerequisites

- **Node.js LTS** (CI uses Node 24) and **pnpm 10** through corepack:
  ```bash
  corepack enable
  corepack install --global pnpm@10.32.1   # the version CI pins
  ```
- **Rust stable** via [rustup](https://rustup.rs), with the MSVC toolchain and the Visual Studio C++ Build Tools ("Desktop development with C++"), as Tauri requires on Windows. Add the components CI uses: `rustup component add clippy rustfmt`.
- **Microsoft Edge WebView2 Runtime**. It ships with Windows 11; on Windows 10 install it if it's missing.

## Setup

```bash
pnpm install
pnpm tauri dev      # the real app (read "Dev safety" first)
pnpm dev:mock       # or: the UI in a browser against the mock backend
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server on port 1420 (`strictPort`). `pnpm tauri dev` starts it for you; opened in a plain browser it has no backend. |
| `pnpm dev:mock` | Vite in `mock` mode (`.env.mock` sets `VITE_MOCK_BACKEND=1`) on port 1420: the UI runs in a browser against the in-memory mock backend in `src/dev/`. State resets on reload. Start-up switches (query string, combinable): `?onboarded=1` (game folder already set, skips First run), `?empty=1` (empty library, no collections, backups or follows), `?notfound=1` (First run detection finds no game), `?many=1` (1,000 hangar skins and 1,284 WT Live posts), `?watch=1` (watched Downloads folder with auto-install; a new skin arrives a few seconds after load), `?offline=1` (WT Live unreachable). Each switch can also be set in localStorage as `livery.mock.<name>` = `1`. |
| `pnpm handoff` | Serves `design_handoff_livery/` on http://localhost:4599 so the `.dc.html` prototypes can load `support.js`. |
| `pnpm tauri dev` | Builds the Rust backend in debug mode and opens the app on the Vite dev server. |
| `pnpm tauri build` | Release build and NSIS installer in `src-tauri/target/release/bundle/nsis/` (runs `pnpm build` first). See [docs/release.md](docs/release.md). |
| `pnpm build` | Typecheck and production frontend build into `dist/`. The mock backend must not ship: `dist/` must not contain `mockCall`, `mockListen`, `livery.mock` or `mockDetectGame` (CI checks it). |
| `pnpm preview` | Serves the built `dist/`. |
| `pnpm test` / `pnpm test:watch` | Vitest, once or in watch mode. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm i18n:check` | Checks `src/i18n/` against `en.json`, the source: `it.json` must have exactly its keys (translated by hand); `de`/`ru`/`fr` are English copies with the same keys and the plural forms each language uses; placeholders and tags must match, no text may be empty. Exits 1 with a list. CI runs it. |
| `pnpm i18n:sync` | Fixes what doesn't need a translator: orders keys like `en.json`, removes stale keys, fills `de`/`ru`/`fr` with English. Missing Italian keys are only listed. `--dry-run` writes nothing. |

Rust commands (from the repo root; or run them inside `src-tauri/` without `--manifest-path`):

```bash
cargo test   --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt    --manifest-path src-tauri/Cargo.toml -- --check      # style: src-tauri/rustfmt.toml
```

`pnpm dev`, `pnpm dev:mock` and `pnpm tauri dev` all bind port 1420, so run one at a time.

## Dev safety

The dev app works on real folders: never point it at your real game folder while developing.

- **Separate app data.** Set `LIVERY_DATA_DIR` to an empty folder to run the app with its own settings and library. Without it, dev and release builds share the app data of the identifier `app.livery.desktop` (`%APPDATA%\app.livery.desktop`: `settings.json`, `following.json`, `library/<key>.json`).
- **A fake game folder.** First run starts by *reading* the usual Steam and standalone locations, but confirming a folder creates `UserSkins\` in it, and from then on the app installs, toggles and deletes skins there. So in First run choose the custom folder and pick an empty folder that contains an empty `launcher.exe` (a valid game root has `UserSkins\`, `launcher.exe`, `aces.exe` or `win64\aces.exe`).
  ```powershell
  New-Item -ItemType Directory C:\LiveryDev\FakeGame | Out-Null
  New-Item -ItemType File C:\LiveryDev\FakeGame\launcher.exe | Out-Null
  $env:LIVERY_DATA_DIR = 'C:\LiveryDev\AppData'; pnpm tauri dev
  ```
- Rust tests only use temp dirs and fixtures. The two ignored tests (`detects_real_install`, `scans_real_install`) only read a real install; run them by hand with `cargo test -- --ignored`.

## Project layout

```
src/                     React app
  screens/               Explore, Detail, Hangar, Collections, Queue, Settings, FirstRun
  components/chrome/     title bar, sidebar, command palette, toasts, drop overlay
  components/ui/         shared controls (Button, Switch, Menu, Skeleton, …)
  store/                 Zustand stores (UI state, toasts with undo, queue, explore, …)
  queries/               TanStack Query hooks, one file per backend domain
  hooks/                 shortcuts, file drop, backend events, language, reduce motion
  lib/                   the Tauri bridge (tauri.ts: call, isTauri), event listening, formatting
  i18n/                  en.json (source), it.json, de/ru/fr (English copies); keys namespaced per screen
  dev/                   mock backend for `pnpm dev:mock` (never shipped)
  data/vehicles.json     local vehicle list (placeholder seed for now)
  types.ts               shared types, mirrored by src-tauri/src/model.rs
  test/                  Vitest setup, render helper (resetStores), axe helper
src-tauri/               Tauri app (crate `livery`, lib `livery_lib`)
  src/                   one module per domain: game, library, archive, textures, watch,
                         wtlive, backup, settings; plus error.rs (AppError), model.rs and
                         lib.rs (command registration and setup)
  tests/                 integration tests; fixtures in tests/fixtures
  capabilities/  icons/  tauri.conf.json
tokens/                  design tokens (tailwind.tokens.cjs, spread into tailwind.config.cjs)
design_handoff_livery/   the design handoff (spec + prototypes)
docs/                    release.md; agent-specs/ (saved agent workflow specs)
scripts/                 serve-handoff.mjs (pnpm handoff), i18n-check.mjs / i18n-sync.mjs,
                         capture-window.ps1 (screenshots of the native window)
.github/workflows/       ci.yml, release.yml
```

## Conventions and testing

The full list is in [`CLAUDE.md`](CLAUDE.md). The short version:

- Tailwind classes built from the tokens only, no ad-hoc hex values; a missing value becomes a new token, noted in `DESIGN_NOTES.md`.
- Every user-visible string goes through `t('key')`, with English in `src/i18n/en.json` and Italian in `it.json`.
- No spinners (skeletons instead); animation only under `motion-safe:`. Anything a user can regret goes through `toast.undoable()` backed by a backend backup.
- Rust commands return `Result<T, AppError>` (serialized as `{ code, message, detail? }`); disk work runs off the UI thread; long operations emit events.
- **Frontend tests** sit next to the code as `*.test.ts(x)` and run in jsdom. Test store logic and reducers; smoke-test components with the helpers in `src/test/` (`resetStores()` in `beforeEach`).
- **Rust tests** live in `src-tauri/tests/` (plus unit tests in modules). Every parser (blk, archive layout, DDS/TGA headers, Steam VDF) has fixture-based tests over `src-tauri/tests/fixtures/`; anything that writes uses a temp dir.
- CI ([`ci.yml`](.github/workflows/ci.yml), windows-latest, on every push and pull request) runs typecheck, Vitest, `i18n:check`, the frontend build with the mock check, `cargo fmt --check`, clippy with `-D warnings` and `cargo test`.

## Releases

NSIS installer, per user, English and Italian; code signing is prepared but off. How to build, sign and publish: [docs/release.md](docs/release.md).

## Where decisions live

- [`DESIGN_NOTES.md`](DESIGN_NOTES.md): every decision taken during implementation that the handoff left open, plus tokens and copy added.
- [`HANDOFF.md`](HANDOFF.md): current status, next steps, pending dependency approvals and gotchas. Read it first when you pick the project up.
- [`CLAUDE.md`](CLAUDE.md): stack and conventions.
