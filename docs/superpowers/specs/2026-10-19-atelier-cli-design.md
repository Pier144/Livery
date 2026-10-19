# Atelier CLI: a command line for agents

Status: design approved by the author on 2026-10-19 (brainstorming, section by section; the
author then said to go on to development autonomously). Revised after the spec review (all
commands inside Tauri, scene render target, asset loader, lock outside the CLI module, the
editor's `frameFromHit` for `place`, an own apply sequence instead of refactoring `useApply`). Next
step: implementation plan.

## Goal

The author wants Claude to make War Thunder skins with Livery. Driving the Atelier window by
screenshots (as for the Auto-Meg skin, 2026-10-17) is slow, fragile (colour picker in its own
WebView2 window, missed handles orbit the camera, keyboard quirks) and imprecise (decals placed by
dragging). A command line gives exact numbers in, rendered pictures out, and a repeatable loop:

1. create a project, 2. `render --grid` and look at the PNGs, 3. `place` to find surface points,
4. write the layers with `project put`, 5. `render` again and correct, 6. `apply`.

Decisions taken with the author:

| Question | Choice |
|---|---|
| Who uses it | Only Claude (an agent tool on this machine). No i18n, no UI, not in release builds. |
| Install | `apply` really installs, through the same path as Apply to game (backup, library entry). |
| Projects | The normal Atelier store: the author sees CLI projects in the app and can open and touch them up. |
| v1 scope | The minimum (project new/list/get/put, render, apply) plus `place`, `vehicle-info`, `import-image` with background removal, and `vehicles` to find a code. |
| Where the bake runs | Approach A: the same `livery.exe` with a hidden window that runs the existing `Baker`/`EditorScene`. |
| App open at the same time | Refused: the CLI exits with `appRunning` while Livery is open. |

Out of scope: an MCP server (a later wrapper over the same commands), a live link to a running
Livery, delete commands (the author deletes projects and skins in the app), custom `--game-root`
(tests point `LIVERY_DATA_DIR` at a scratch data dir whose settings name a scratch game root, as
in every real-app run so far), release builds, per-layer repair reports.

Approaches rejected: a Node runner with headless GL (two runtimes, new dependencies, a GL that can
differ from WebView2's); a Rust port of the bake on wgpu (about 2000 lines of shaders and logic to
rewrite, would drift from the editor, new dependency).

## 1. Shape of the CLI

**Executable.** The debug build with the frontend embedded:
`pnpm tauri build --debug --no-bundle` → `src-tauri/target/debug/livery.exe`. Debug builds use the
console subsystem (`main.rs`'s `windows_subsystem` attribute is release-only), so stdout works.
Everything the CLI adds on the Rust side, except the data lock (§2), is behind
`#[cfg(debug_assertions)]`: release builds neither parse `--livery-cli` nor register its commands.
`cli.html` and `src/cli/` end up in `dist/` too; without the Rust side they are inert (they only
call `cli_job`, which a release build doesn't have). `pnpm build`'s "no mock in dist" check is
unaffected.

**Invocation.** `livery.exe --livery-cli <command> [args]`. `main.rs` order: the Oodle worker
check first (unchanged), then `startup::webview_data_into_data_dir()` (so a CLI run with
`LIVERY_DATA_DIR` keeps WebView2's data in the scratch dir too), then, if `args_os().nth(1)` is
`--livery-cli`, `cli::main(args)` instead of `run()`.

**Commands.** Output: one JSON document on stdout (pretty-printed, UTF-8). Paths in and out are
absolute. Ids are the existing project and asset ids.

| Command | Does | Output |
|---|---|---|
| `vehicles [--query <text>]` | The game's vehicle list (`game::current_vehicles`), filtered by a case-insensitive substring of code or name. | `[Vehicle]` as serialized today (`code, name, nation, type, class, rank?`) |
| `vehicle-info <code>` | Model summary: parts (name, part group, bounding box in model space, triangle count), paintable slots (`_c` texture, template size, body or not), overall bounds, centre and bounding radius. Refuses the vehicles Atelier refuses (same error as `atelier_model`). | object |
| `project new <name> <vehicle>` | As `atelier_project_create`. | the `AtelierProject` |
| `project list` | As `atelier_projects`. | `[AtelierProjectSummary]` |
| `project get <id>` | As `atelier_project_get`. | the `AtelierProject` |
| `project put <file\|->` | Rust reads the document (file or stdin) and parses it as `AtelierProject`; the stored project with that `id` must exist and have the same `vehicle` (else `invalidInput`). The page checks the layers with `checkLayers` (the editor's check), saves the checked project (`atelier_project_save`) and stores a thumbnail (`atelier_project_thumb`). | `{project, repaired, sharedTexels}`: `repaired` is `checkLayers`'s flag; `sharedTexels` lists the ids of placed layers with Mirror on whose decal touches shared texels (`Baker.decalTouchesSharedTexels`; the editor disables Mirror for those) |
| `import-image <id> <file> [--cutout]` | As `atelier_import_image`; with `--cutout` then as `atelier_cutout` on the new asset. Background removal needs its files already downloaded (else the existing not-ready error); the CLI never downloads. | `{asset, cutout?}` |
| `place <id> --view <view> --at <x>,<y> [--part hull\|turret\|gun] [--width <m>] [--height <m>] [--depth <m>]` | Casts a ray through the point of the given view and returns a ready `Decal` at the hit, built by the editor's own `frameFromHit` (`src/atelier/decal.ts`). Size default 1 × 1 m, depth `defaultDepth(width)`, clamped as in the editor. | `{decal, group, node}` or error `noHit` |
| `render <id> --out <dir> [--views <list>] [--size <px>] [--grid] [--flat]` | 3D pictures of the baked project; `--flat` also writes each enabled slot's baked texture. | `{views: [{view, file, width, height}], flat: [{slot, file, width, height}]}` |
| `apply <id>` | As the editor's Apply to game: bake at export size, `atelier_apply_begin`, one `atelier_apply_texture` per enabled slot, thumbnail, `atelier_apply_commit`; cancel on any error. | the `ApplyResult` |

**Views.** `front`, `side`, `rear`, `top` (the editor's `QUICK_VIEWS`, framed by
`quickViewOrbit`), or `orbit:<theta>,<phi>,<zoom>`: theta and phi in radians as in `OrbitState`
(phi clamped to `PHI_MIN..PHI_MAX`), zoom in `ZOOM_MIN..ZOOM_MAX` (0.15 to 6), camera distance =
framing distance × zoom, looking at the model centre. `--views` takes a comma list, default
`front,side,rear,top`. `--size` is the square picture size, default 1024, 256 to 2048. `place`
uses the same view definitions with aspect 1, so a point read on any render of that view maps to
the same ray regardless of its size.

**`--at`.** Fractions of the picture, `0,0` top left, `1,1` bottom right (both in 0..1), turned
into NDC directly (`x*2-1`, `1-y*2`). The decal comes from `frameFromHit(point, normal,
cameraMatrixWorld, size, part)`, exactly as a click in the editor places one: centre at the hit,
facing out along the face normal, up = the camera's screen-up on the surface plane (with
`upOnPlane`'s fallbacks). `--part` limits the ray to that group and is written as the decal's
`part`, as the editor's "Only this part"; without it the decal's part is `all`.

**`--grid`.** Draws on the render a grid every 10 % with labels (`1` … `9`, tenths) along the top
and left edges, light lines with a dark outline so they read on any paint. Only the PNG gets it.

**Data.** The normal Livery data dir (or `LIVERY_DATA_DIR`): same settings, same Atelier store,
same library. The CLI goes through the same checks as the Tauri commands (`atelier_on`,
`atelier_game_root`), so Settings → Game → Read data from the game off or Settings → Atelier → Show
Atelier off give the same errors as in the editor.

## 2. Architecture and data flow

All commands run inside a Tauri app in CLI mode, so they have the same `AppHandle`, paths
(`app_data_dir`, `app_local_data_dir`), managed state and events as the real app. Commands that
need no GPU create no window.

### Rust

- **`src-tauri/src/lock.rs`** (not cfg-gated: the app uses it in release too) — the
  single-writer rule. `DataLock::acquire(data_dir) -> Result<DataLock, LockBusy>` opens (creating)
  `<data>/livery.lock` and calls `std::fs::File::try_lock` (stable since Rust 1.89; the crate is on
  1.92). Held until drop. The file is never deleted (an empty file; the OS lock, not the file, is
  the signal), so a crash leaves nothing stuck.
  - **App** (`run()` setup, debug and release): takes it right after resolving the data dir and
    keeps it in managed state; busy (a CLI is running) → log a warning and start anyway.
  - **CLI**: takes it in its own setup at the same point; busy → `appRunning`. CLI mode doesn't
    run the app's own acquire, so there is one handle per process.
- **`src-tauri/src/cli/args.rs`** — hand-written parser (no new dependency) from `&[OsString]` to
  `CliCommand` (one variant per command, typed fields; `project put` carries the parsed
  `AtelierProject`, read by Rust from the file or stdin). Ranges checked. Errors are `invalidInput`
  with the usage line in `detail`. Pure, unit-tested.
- **`src-tauri/src/cli/output.rs`** — `CliError { code: String, message, detail? }`, built from an
  `AppError` (its serialized code) or directly for the CLI-only codes; prints success or error
  JSON and maps to the exit code (§3).
- **`src-tauri/src/cli/mod.rs`** — `cli::main(args) -> ExitCode`: parse, then `run_cli(command)`.
- **Shared builder.** `run()` is split so both modes use one `tauri::generate_context!()` (called
  once) and one function that registers the plugins and managed state: `build_app(context, mode)`.
  CLI mode leaves out the updater and autostart plugins, `watch::start`, `update::start`, the idle
  ticker and the startup purges (the app does those when it next starts), and the app's lock
  acquire; before building it clears the configured windows
  (`context.config_mut().app.windows.clear()`). Normal mode is exactly today's `run()` plus the
  lock.
- **Run and exit.** CLI mode uses `build()` and `run_return`, and `cli::main` returns the exit
  code that `cli_finish` (or the no-GPU path, or the timeout) stored in managed state; `app.exit`
  only stops the event loop. `main` turns it into the process `ExitCode`.
- **Dispatch** (from `setup`, after the managed state exists; `setup` stays synchronous and
  spawns the work with `tauri::async_runtime::spawn`):
  - **No-GPU commands** (`vehicles`, `project new|list|get`, `import-image`) run in
    `crate::blocking` against the `AppHandle`. The Tauri command bodies they share move into plain
    functions taking `&AppHandle` (for example `atelier::project_create(&app, name, vehicle)`), the
    `#[tauri::command]` wrappers call them; no behaviour change for the app. Then
    `app.exit(code)`.
  - **GPU commands** (`project put`, `vehicle-info`, `place`, `render`, `apply`) store the job in
    managed state and create one window `cli` on `cli.html`: hidden, no decorations,
    `skip_taskbar`. Three commands serve the page. They are registered in every build (one handler
    list, no duplicated `generate_handler!`) but answer `unsupported` unless CLI mode's state is
    managed (`try_state`), which only a debug build's `--livery-cli` creates:
    - `cli_job() -> CliJob` — the command and its arguments (never the `--out` path).
    - `cli_file(raw body; header x-name)` — one output file; the name is checked against
      `^[A-Za-z0-9._-]{1,64}$` and joined to `--out` by Rust.
    - `cli_finish(result: Result<Value, CliError>)` — prints, then `app.exit(code)` (before any
      window closes, so the exit code isn't replaced by the last-window-closed exit).
    A timeout (120 s; `apply` 300 s) prints `timeout` and exits; a page that fails to load hits the
    same timeout.
- **Capability.** `capabilities/cli.json`, `windows: ["cli"]`, `core:default` (the page needs
  `listenEvent` for apply progress). It ships in release builds too, where no `cli` window exists.

### Frontend: `cli.html` + `src/cli/`

`cli.html` is a second Vite input that loads `src/cli/main.ts`, which renders no UI. It imports
the editor modules it reuses (`engine.ts` pulls in React's `createContext`, which is harmless).

**Changes to shared modules (no behaviour change in the editor):**
- **`EditorScene.renderPixels(orbit, size): Uint8ClampedArray`** — renders the given orbit into a
  `size × size` render target (as `thumbnailPng` does today, which becomes a caller of it) and
  returns straight top-down RGBA. Independent of the canvas size and `devicePixelRatio`; draws
  synchronously, no `requestAnimationFrame`.
- **`EditorScene.raycastView(orbit, ndcX, ndcY, group)`** — the existing raycast, but from the
  given orbit at aspect 1 instead of the on-screen camera; also returns that camera's
  `matrixWorld` (column-major) for `frameFromHit`. The on-screen camera is put back after.
- **`createEngine` takes an optional `loadAsset`** in `EngineInput` (default: today's
  `loadProjectAsset`, which reads the project id from the editor store). The CLI passes a loader
  bound to the job's project id.
- **`useApply.ts` is not refactored.** Its sequence is interleaved with the editor's needs (view
  lost mid-export, leaving the editor, progress per step, store updates). The CLI has its own
  short sequence in `src/cli/apply.ts` with the same calls in the same order (begin → `setLayers`
  → `whenReady` → `prepareExport(highQuality)` → per enabled slot `bakeForExport` + texture →
  thumbnail → commit; `atelier_apply_cancel` on any error before the commit; `endExport` in
  `finally`), slots from the editor's `enabledSlots(project, model)`. A comment in both files
  names the other, so a change to one is made to both (DESIGN_NOTES row too).

**New, in `src/cli/`:**
- **`job.ts`** — `CliJob`/result types, `parseView` and range checks.
- **`runner.ts`** — `runJob(job, deps)`: loads the project (`atelier_project_get`, or the job's
  document for `put`), the model (`atelier_model` → `parseModelBuffer`) and the templates
  (`atelier_template_texture` per slot), creates an engine on an offscreen canvas through
  `createEngine` with the CLI `loadAsset`, sets the layers, waits for `whenReady`, then:
  - `put`: `checkLayers`, `sharedTexels` from `decalTouchesSharedTexels` for each placed layer with
    Mirror on, `atelier_project_save`, thumbnail as the editor makes it.
  - `vehicle-info`: the summary from `parseModelBuffer` alone (no engine, no WebGL).
  - `place`: `raycastView`, then `frameFromHit` with the view's camera matrix; no hit → `noHit`.
  - `render`: per view `renderPixels`, optional `grid.ts`, `encodePng`, `cli_file`; `--flat`:
    `prepareExport(false)`, `bakeForExport` per enabled slot at the template size, PNG, `cli_file`, `endExport()`.
  - `apply`: `apply.ts` (above).
  `deps` holds `invoke`/`invokeRaw`, the engine factory and the canvas, so Vitest runs it with
  stubs. Every exception ends as a `cli_finish` error (`AppError` from `toAppError`).
- **`grid.ts`** — draws the 10 % grid and digit labels on RGBA pixels (a built-in 3×5 digit font,
  no canvas text).

### Spike first

The first task proves the risky part: in a hidden WebView2 window, create the WebGL2 context, load
the Jumbo (scratch game root), wait for `whenReady` (the Baker's upgrade uses a 300 ms timer that a
hidden page may throttle), bake for export and read back `renderPixels`. Fallbacks in order:
WebView2 browser arguments that turn off background throttling
(`--disable-background-timer-throttling --disable-renderer-backgrounding`, via the window
builder's `additional_browser_args`, which replaces Tauri's defaults, so
`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` is passed again); a visible window at a far-off-screen position, no
decorations, `skip_taskbar`. The outcome goes in DESIGN_NOTES before the rest is built.

## 3. Errors, safety, tests, docs

**Errors and exit codes.** Every failure prints the `CliError` JSON (`{code, message, detail?}`)
on stdout; nothing else goes to stdout (logs go to the log file and, in debug, stderr).

| Exit | Codes |
|---|---|
| 0 | success |
| 1 | `invalidInput`, `notFound`, `unsupported`, `noHit` (usage errors, bad projects, unknown ids, refused vehicles, background-removal files missing, the Atelier switches) |
| 2 | every other `AppError` code, and a page that failed (`internal`) |
| 3 | `appRunning` |
| 4 | `timeout` |

`appRunning`, `timeout` and `noHit` are CLI-only codes in `CliError`; `ErrorCode` and the
frontend union are untouched. Messages are English and not translated: the CLI is not user
interface (DESIGN_NOTES row, since CLAUDE.md asks for `t()` for visible text).

**Safety.**
- `apply` is the editor's path: replacing an installed skin goes through the backend backup, and
  the author can restore it from Livery like any other.
- No delete commands. `project put` only overwrites an existing project with the same id and
  vehicle (checked in Rust before the page runs).
- Output files only through `cli_file` into `--out`, which must be an existing directory.
- Test runs use `LIVERY_DATA_DIR` with a scratch data dir and a scratch game root, never the real
  UserSkins, until the author asks for a real skin.

**Tests.**
- Rust (`cargo test`): `args` (every command, bad flags, ranges, `--at` bounds, `put` from a file),
  `lock` (second holder refused, released on drop, file left in place), `output` (JSON shape,
  code → exit), `cli_file` name check, the extracted Atelier functions still covered by the
  existing tests.
- Vitest: `job.ts`, `grid.ts` (lines and digits at known pixels), `runner.ts` per command with
  stub `invoke` and a stub engine, `apply.ts` (order, cancel on error, `endExport` always), the
  `loadAsset` option of `createEngine`, and the existing scene/engine/`useApply`/`Editor` tests
  still passing.
- Real acceptance (debug build, scratch game root with junctions to `content`/`content.hq`, scratch
  `LIVERY_DATA_DIR`): on the M4A3E2 Jumbo, from the CLI only — `vehicles --query jumbo`,
  `vehicle-info`, `project new`, a camo Base by `project put`, `import-image --cutout`,
  `render --grid`, `place` on the glacis, the image and a text layer put, `render` again, `apply`.
  Check: the CLI's renders match the dev app's editor showing the same project, the decoded body
  DDS shows the decals, the project is in the Atelier list, and the CLI exits 3 while the dev app
  is open.

**Docs.**
- `docs/cli.md`, written for an agent: build command, every command with an example and its JSON,
  the layer JSON essentials (pointing to `src/atelier/project.ts`), the working loop, known
  pitfalls (shared texels and Mirror, raising Depth to 50-75 cm on domed roofs and sloped noses,
  the Jumbo's hull side being a ~0.8 m strip so big pictures go on the glacis, decals placed on
  brackets landing in front of the plate).
- DESIGN_NOTES row "Atelier CLI", HANDOFF section, and a memory entry pointing to `docs/cli.md`.
