# Atelier CLI: a command line for agents

Status: design approved by the author on 2026-10-19 (brainstorming, section by section; the
author then said to go on to development autonomously). Next step: implementation plan.

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
| v1 scope | The minimum (project new/list/get/put, render, apply) plus `place`, `vehicle-info`, `import-image` with background removal. |
| Where the bake runs | Approach A: the same `livery.exe` with a hidden window that runs the existing `Baker`/`EditorScene`. |
| App open at the same time | Refused: the CLI exits with `appRunning` while Livery is open. |

Out of scope: an MCP server (a later wrapper over the same commands), a live link to a running
Livery, delete commands (the author deletes projects and skins in the app), custom `--game-root`
(tests point `LIVERY_DATA_DIR` at a scratch data dir whose settings name a scratch game root, as
in every real-app run so far), release builds.

Approaches rejected: a Node runner with headless GL (two runtimes, new dependencies, a GL that can
differ from WebView2's); a Rust port of the bake on wgpu (about 2000 lines of shaders and logic to
rewrite, would drift from the editor, new dependency).

## 1. Shape of the CLI

**Executable.** The debug build with the frontend embedded:
`pnpm tauri build --debug --no-bundle` → `src-tauri/target/debug/livery.exe`. Debug builds use the
console subsystem (`main.rs`'s `windows_subsystem` attribute is release-only), so stdout works.
Everything the CLI adds on the Rust side is behind `#[cfg(debug_assertions)]`: release builds
neither parse `--livery-cli` nor register its commands. `cli.html` and `src/cli/` end up in
`dist/` too; without the Rust side they are inert (they only call `cli_job`, which a release build
doesn't have). `pnpm build`'s "no mock in dist" check is unaffected.

**Invocation.** `livery.exe --livery-cli <command> [args]`. Like the Oodle worker argument, it is
checked first in `main.rs` and must be `args_os().nth(1)`.

**Commands.** Output: one JSON document on stdout (pretty-printed, UTF-8). Paths in and out are
absolute. Ids are the existing project and asset ids.

| Command | Does | Output |
|---|---|---|
| `vehicles [--query <text>]` | The game's vehicle list (from `game::load_vehicles` / the cache), filtered by code or name, ground vehicles only (what Atelier supports). | `[{code, name, country, kind}]` |
| `vehicle-info <code>` | Model summary: parts (name, part group, bounding box in model space, triangle count), paintable slots (`_c` texture, size, body or not), overall bounds and the mirror plane, and per slot whether texels are shared between mirrored sides (the existing shared-texel check, which decides whether Mirror is offered). Refuses the vehicles Atelier refuses (own textures on a shared model). | object |
| `project new <name> <vehicle>` | `ProjectStore::create`. | the `AtelierProject` |
| `project list` | `ProjectStore::list`. | `[AtelierProjectSummary]` |
| `project get <id>` | `ProjectStore::get`. | the `AtelierProject` |
| `project put <file\|->` | Reads an `AtelierProject` (file or stdin), checks the layers with `projectCheck.ts` (the same check the editor uses when it opens a project), saves with `ProjectStore::save` and renders a thumbnail. Unknown layer kinds and fields are kept, as in the editor. | the saved project + `warnings` (layers the check dropped or fixed) |
| `import-image <id> <file> [--cutout]` | `assets` import (as `atelier_import_image`); with `--cutout` also background removal (as `atelier_cutout`), which needs the background-removal files already downloaded (else `cutoutNotReady`; the CLI never downloads). | `{asset, cutout?}` (`AssetRef`s with sizes) |
| `place <id> --view <view> --at <x>,<y> [--part hull\|turret\|gun] [--size <px>]` | Casts a ray through the point of the given view and returns the decal frame at the hit. | `{center, normal, up, part, distance}` or error `noHit` |
| `render <id> --out <dir> [--views <list>] [--size <px>] [--grid] [--flat]` | 3D pictures of the baked project; `--flat` also writes each enabled slot's baked texture. | `{views: [{view, file, width, height}], flat: [{slot, file, width, height}]}` |
| `apply <id>` | Bakes at export size and installs: `atelier_apply_begin`, one `atelier_apply_texture` per enabled slot, `atelier_apply_commit`, as the editor's Apply to game. | the `ApplyResult` |

**Views.** `front`, `side`, `rear`, `top` (the editor's `QUICK_VIEWS`, framed by
`quickViewOrbit`), or an orbit `orbit:<theta>,<phi>,<zoom>` (radians, radians, the editor's zoom
factor). `--views` takes a comma list, default `front,side,rear,top`. `--size` is the square
picture size, default 1024, 256 to 2048. `place` uses the same view definitions and size, so a
point read on a render maps to the same ray.

**`--at`.** Fractions of the picture, `0,0` top left, `1,1` bottom right (both in 0..1). The
frame: `center` = the hit point, `normal` = the hit face's normal (the same one the editor's click
placement uses), `up` = the view's camera up projected on the surface plane and normalised; when
that is degenerate (looking along the normal's perpendicular) the editor's own rule for a fresh
placement is used. `--part` limits the ray to that part group, as the editor's "Only this part".

**`--grid`.** Draws on the render a grid every 10 % with labels (`0.1` … `0.9`) along the top and
left edges, in a colour with an outline so it reads on any paint. Only the PNG gets it.

**Data.** The normal Livery data dir (or `LIVERY_DATA_DIR`): same settings, same Atelier store,
same library. The CLI honours the same switches as the editor: Settings → Game → Read data from
the game off → `ATELIER_NEEDS_GAME_DATA`; Settings → Atelier → Show Atelier off →
`ATELIER_DISABLED` (for every command that touches Atelier).

## 2. Architecture and data flow

### Rust: `src-tauri/src/cli/` (debug only)

- **`args.rs`** — hand-written parser (no new dependency) from `&[OsString]` to a `CliCommand`
  enum; every flag above, with ranges checked. Errors are `invalidInput` with the usage line in
  `detail`. Pure, unit-tested.
- **`lock.rs`** — the single-writer rule. `DataLock::acquire(data_dir) -> Result<DataLock, Busy>`
  opens `<data>/livery.lock` and calls `std::fs::File::try_lock` (stable since Rust 1.89; the
  crate is on 1.92). Held until drop. The **app** (debug and release) takes it in `setup` and keeps
  it in managed state; if it is busy (a CLI is running) the app logs a warning and starts anyway.
  The **CLI** takes it before anything else touches the data dir; busy → `appRunning`. The lock
  file is never deleted (an empty file; locking, not existence, is the signal), so a crash leaves
  nothing stuck.
- **`output.rs`** — prints the success JSON or the `AppError` JSON and maps to the exit code
  (below).
- **`mod.rs`** — `cli::main(args) -> ExitCode`, called from `main.rs`. It resolves the data dir
  the way `run()` does (`startup::resolve_data_dir`, `LIVERY_DATA_DIR`), takes the lock, then:
  - **Rust-only commands** (`vehicles`, `project new|list|get`, `import-image`) run without Tauri:
    they build the stores they need (`SettingsStore`, `ProjectStore`, the game root and vehicle
    list, `CutoutState`) and call the same functions the Tauri commands call. Where a command's
    body is inside the `#[tauri::command]` function today, it moves into a plain function both
    use (no behaviour change for the app).
  - **Webview commands** (`project put`, `vehicle-info`, `place`, `render`, `apply`) start Tauri in
    CLI mode: `run_cli(job)` builds the same managed state as `run()` minus the updater, autostart,
    folder watcher, idle ticker and the startup purges (the app does those when it next starts),
    removes the configured `main` window from the context before building, and creates one window
    `cli` on `cli.html`: hidden, no decorations, not in the taskbar, 1×1. The job sits in managed
    state; two commands exist only in CLI mode:
    - `cli_job() -> CliJob` — the command and its arguments (and the page's output dir).
    - `cli_finish(result)` — the page's JSON result (or `AppError`); files the page produced are
      written by Rust from raw bodies sent with `cli_file` (header `x-name`, a plain file name
      checked against `[A-Za-z0-9._-]+`, joined to the job's `--out` dir), so the page never gets
      a path. After `cli_finish` Rust prints, closes the window and exits with the mapped code.
    A timeout (120 s, `apply` 300 s) ends the run with `timeout`. A webview that never calls
    `cli_job` (failed to load) hits the same timeout.
  - The `cli` window needs IPC access to the Atelier commands and `cli_*`. App commands are
    allowed for any window a capability lists, so `capabilities/cli.json` lists `windows: ["cli"]`
    with `core:default` only. The file ships in release builds too, where no `cli` window is ever
    created, so it grants nothing there.

### Frontend: `cli.html` + `src/cli/` (no React)

`cli.html` is a second Vite input that loads `src/cli/main.ts`. It renders into an offscreen
`<canvas>` sized to the job (`--size`), not into the hidden window's viewport, so the window's
size doesn't matter.

- **`job.ts`** — types of `CliJob` and results, `parseView` (`front` … / `orbit:t,p,z`) and range
  checks shared with the tests.
- **`runner.ts`** — `runJob(job, deps)`: loads the project (`atelier_project_get`), the model
  (`atelier_model`) and templates (`atelier_template_texture`), creates the engine through the
  existing `createEngine` (`src/screens/Atelier/engine.ts`: `EditorScene` + `Baker` on one
  renderer), sets the layers, waits for `whenReady`, then dispatches:
  - `put`: `projectCheck` on the incoming project, `atelier_project_save`, thumbnail as the editor
    makes it (`atelier_project_thumb`), warnings from the check.
  - `vehicle-info`: model data from `modelBuffer` plus the Baker's shared-texel result per slot.
  - `place`: `setView`, `raycast` at the fraction converted to the canvas's pixel space, the frame
    built as above (`frame.ts`).
  - `render`: per view `setView`, render, read back (`toStraightTopDown`), optional grid
    (`grid.ts`), `encodePng`, `cli_file`; `--flat`: `bakeForExport` per enabled slot at preview
    size (≤ 2048), PNG, `cli_file`.
  - `apply`: the shared apply core (below).
  `deps` holds `invoke`/`invokeRaw` and the engine factory, so Vitest runs it with stubs.
- **`frame.ts`** — `decalFrameFromHit(hit, cameraUp)`: the `up` projection and fallback. Pure.
- **`grid.ts`** — draws the 10 % grid and labels on RGBA pixels (a tiny built-in digit font, so it
  needs no canvas text). Pure.

**Apply core, shared.** `useApply.ts` (233 lines) mixes the React state, toasts and query
invalidation with the apply sequence. The sequence (begin → bake per slot → texture → thumbnail →
commit, cancel on any error) moves into `src/atelier/applyRun.ts` as
`runApply(projectId, enabledSlots, engine, model, hooks)`; `hooks` carry progress and the
"aborted" check. `useApply` keeps the UI part and calls it; the CLI calls it with no-op hooks.
Behaviour of the editor's Apply is unchanged and its tests stay green.

### Spike first

The first task of the plan proves the risky part: in a hidden WebView2 window, create the WebGL2
context, bake the Jumbo (scratch game root) and read back a render. If the hidden window throttles
or loses the context, the fallback is a visible 1×1 window at a far-off-screen position, no
decorations, `skip_taskbar`. The spike's result is noted in DESIGN_NOTES before the rest is built.

## 3. Errors, safety, tests, docs

**Errors and exit codes.** Every failure prints the `AppError` JSON (`{code, message, detail?}`)
on stdout; nothing else goes to stdout (logs go to the log file and, in debug, stderr).

| Exit | Meaning |
|---|---|
| 0 | ok |
| 1 | usage or input error (`invalidInput`, `notFound`, `noHit`, an unsupported vehicle, an invalid project, `cutoutNotReady`, the Atelier switches) |
| 2 | internal error (any other `AppError` code, a webview that failed) |
| 3 | `appRunning` (the data lock is held) |
| 4 | `timeout` |

`appRunning`, `timeout` and `noHit` are CLI-only codes. They are not added to `ErrorCode` (the
frontend union stays untouched): the CLI's output type is `CliError { code: String, message,
detail? }`, built from an `AppError` (its serialized code) or directly for these three. `noHit`
comes from the page as a `cli_finish` result with that code. Messages are English and not translated:
the CLI is not user interface (DESIGN_NOTES row, since CLAUDE.md asks for `t()` for visible text).

**Safety.**
- `apply` is the editor's path: replacing an installed skin goes through the backend backup, and
  the author can restore it from Livery like any other.
- No delete commands. `project put` only writes the project named by the document's `id`, which
  must exist (create with `project new` first); a different `vehicle` than the stored one is
  refused (`invalidInput`).
- `cli_file` names are checked; all output files land in `--out`, which must exist and be a
  directory.
- Test runs use `LIVERY_DATA_DIR` pointing at a scratch data dir and a scratch game root, never the
  real UserSkins, until the author asks for a real skin.

**Tests.**
- Rust (`cargo test`): `args` (every command, bad flags, ranges, `--at` bounds), `lock` (second
  holder refused, released on drop, file left in place), `output` (JSON shape, exit codes), the
  Rust-only commands against a fixture data dir (project new/list/get, import-image without
  cutout), `cli_file` name check.
- Vitest: `job.ts` (view parsing), `frame.ts` (up projection, degenerate case), `grid.ts` (lines
  and labels at known pixels), `runner.ts` per command with stub `invoke` and a stub engine,
  `applyRun.ts` (sequence, cancel on error, aborted), and `useApply` still passing.
- Real acceptance (dev build, scratch game root with junctions to `content`/`content.hq`, scratch
  `LIVERY_DATA_DIR`): on the M4A3E2 Jumbo, from the CLI only — `project new`, a camo Base by
  `project put`, `import-image --cutout` of a picture, `render --grid`, `place` on the glacis, the
  image and a text layer put, `render` again, `apply`. Check: the CLI's renders match the editor
  showing the same project (opened in the dev app afterwards), the decoded body DDS shows the
  decals, the project appears in the Atelier list, and the CLI exits 3 while the dev app is open.

**Docs.**
- `docs/cli.md`, written for an agent: build command, every command with an example and its JSON,
  the working loop, known pitfalls (shared texels and Mirror, raising Depth to 50-75 cm on domed
  roofs and sloped noses, the Jumbo's hull side being a ~0.8 m strip so big pictures go on the
  glacis, decals placed on brackets landing in front of the plate).
- DESIGN_NOTES row "Atelier CLI", HANDOFF section, and a memory entry pointing to `docs/cli.md`.
