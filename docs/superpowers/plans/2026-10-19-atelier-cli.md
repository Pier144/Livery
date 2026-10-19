# Atelier CLI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `livery.exe --livery-cli <command>` (debug builds) lets an agent create, inspect, render, place decals on and apply Atelier projects with JSON in and out.

**Architecture:** The CLI runs inside a Tauri app in CLI mode (same managed state, paths and commands as the app). No-GPU commands call the existing `#[tauri::command]` functions directly (they are plain `async fn`s); GPU commands open a hidden `cli` window on `cli.html`, whose script asks for the job (`cli_job`), runs it with the editor's own `EditorScene`/`Baker` and answers with `cli_file`/`cli_finish`. A data-dir lock keeps the CLI and the app from running at once.

**Tech Stack:** Rust (Tauri 2, std `File::try_lock`), TypeScript (three.js through the existing engine), Vite multi-page, Vitest, cargo test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-atelier-cli-design.md` (read it first).

**Conventions to keep** (CLAUDE.md, HANDOFF.md): one module per domain; `AppResult<T>`; comments explain *why*; English identifiers; `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `pnpm typecheck`, `pnpm test`, `pnpm i18n:check` clean before each commit. Never write to the real game folder or the real data dir in tests or runs: use `LIVERY_DATA_DIR` + a scratch game root.

**Commands used throughout** (run from the repo root `D:\Dev\Progetti\Livery`):
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml <filter>`
- Clippy: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- TS: `pnpm vitest run <path>`, `pnpm typecheck`
- CLI build: `pnpm tauri build --debug --no-bundle` → `src-tauri/target/debug/livery.exe`

---

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/lock.rs` (new) | `DataLock`: exclusive lock on `<data>/livery.lock`. Used by the app and the CLI. |
| `src-tauri/src/cli/mod.rs` (new, debug only) | `main(args) -> ExitCode`, `CliState`, dispatch, timeout, window creation. |
| `src-tauri/src/cli/args.rs` (new, debug only) | Argument parser → `CliCommand`. Pure. |
| `src-tauri/src/cli/output.rs` (new, debug only) | `CliError`, JSON printing, code → exit code. Pure. |
| `src-tauri/src/cli/page.rs` (new) | The three page commands `cli_job`, `cli_file`, `cli_finish` (registered in every build; refuse without `CliState`). |
| `src-tauri/src/lib.rs` | `run()` split into `build_app(mode)` shared by app and CLI; app takes the lock. |
| `src-tauri/src/main.rs` | `--livery-cli` branch (debug only), after `webview_data_into_data_dir`. |
| `src-tauri/capabilities/cli.json` (new) | `core:default` for the `cli` window. |
| `cli.html` (new), `vite.config.ts` | Second Vite input. |
| `src/cli/main.ts` (new) | Page bootstrap: `cli_job` → `runJob` → `cli_finish`. |
| `src/cli/job.ts` (new) | `CliJob`/result types, `parseView`, `viewOrbit`. Pure. |
| `src/cli/grid.ts` (new) | 10 % grid with digit labels drawn on RGBA. Pure. |
| `src/cli/runner.ts` (new) | `runJob(job, deps)`: put, vehicle-info, place, render. |
| `src/cli/apply.ts` (new) | The CLI's apply sequence (mirrors `useApply.ts`). |
| `src/atelier/gl/scene.ts` | `renderPixels(orbit, size)`, `raycastView(orbit, ndcX, ndcY, group)`; `thumbnailPng` uses `renderPixels`. Export `framingFor`. |
| `src/screens/Atelier/engine.ts` | `EngineInput.loadAsset?`; `EngineScene` gains the two methods. |
| `docs/cli.md` (new) | Agent-facing manual. |
| `DESIGN_NOTES.md`, `HANDOFF.md` | Rows/section. |

---

## Chunk 1: Rust foundations (lock, args, output)

### Task 1: Data lock

**Files:**
- Create: `src-tauri/src/lock.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod lock;`, take the lock in `setup`)
- Test: inline `#[cfg(test)] mod tests` in `lock.rs`

- [ ] **Step 1: Write the failing tests** in `src-tauri/src/lock.rs`:

```rust
//! One writer per data folder: the app and the agent CLI (`cli`) never run on the same data at
//! once. An exclusive OS lock on `<data>/livery.lock`, held for the process's life. The file is
//! never deleted: the lock, not the file, is the signal, so a crash leaves nothing stuck.

use std::fs::{File, OpenOptions};
use std::path::Path;

pub const LOCK_FILE: &str = "livery.lock";

/// Held while alive; dropping it (or the process ending) releases the lock.
#[derive(Debug)]
pub struct DataLock {
    _file: File,
}

/// Another process holds the lock (or the file can't be opened: `Err(io)`).
#[derive(Debug)]
pub enum LockError {
    Busy,
    Io(std::io::Error),
}

impl DataLock {
    pub fn acquire(data_dir: &Path) -> Result<DataLock, LockError> {
        std::fs::create_dir_all(data_dir).map_err(LockError::Io)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(data_dir.join(LOCK_FILE))
            .map_err(LockError::Io)?;
        match file.try_lock() {
            Ok(()) => Ok(DataLock { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(LockError::Busy),
            Err(std::fs::TryLockError::Error(e)) => Err(LockError::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_holder_is_refused_until_the_first_drops() {
        let dir = tempfile::tempdir().unwrap();
        let first = DataLock::acquire(dir.path()).unwrap();
        assert!(matches!(DataLock::acquire(dir.path()), Err(LockError::Busy)));
        drop(first);
        assert!(DataLock::acquire(dir.path()).is_ok());
    }

    #[test]
    fn the_file_stays_after_release() {
        let dir = tempfile::tempdir().unwrap();
        drop(DataLock::acquire(dir.path()).unwrap());
        assert!(dir.path().join(LOCK_FILE).is_file());
    }

    #[test]
    fn creates_a_missing_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        assert!(DataLock::acquire(&nested).is_ok());
    }
}
```

Check first that `tempfile` is a dev-dependency (`grep tempfile src-tauri/Cargo.toml`); if not, use the helper the other tests in `src-tauri/src` use for temp dirs (grep `tempdir` / `scratch_dir`) instead. Do **not** add a dependency.

Note: on Windows `try_lock` locks per handle, so two `acquire` calls in one process conflict. That's what the first test relies on.

- [ ] **Step 2: Add `pub mod lock;` to `lib.rs` and run.**
Run: `cargo test --manifest-path src-tauri/Cargo.toml lock::`
Expected: 3 passed.

- [ ] **Step 3: The app takes the lock.** In `run()`'s `setup`, right after `let data_dir = data_dir.path;`:

```rust
            // One writer per data folder: an agent CLI run (debug builds) holds it while it works.
            match lock::DataLock::acquire(&data_dir) {
                Ok(held) => {
                    app.manage(AppLock(held));
                }
                Err(lock::LockError::Busy) => {
                    tracing::warn!("the data folder is in use by another Livery process (agent CLI); starting anyway")
                }
                Err(lock::LockError::Io(e)) => tracing::warn!(error = %e, "the data folder lock can't be taken"),
            }
```

with `struct AppLock(#[allow(dead_code)] lock::DataLock);` declared near `run()` (kept in managed state so it lives as long as the app). Task 5 moves this into `build_app`'s normal-mode branch.

- [ ] **Step 4:** `cargo test --manifest-path src-tauri/Cargo.toml` (all green), clippy, fmt.
- [ ] **Step 5: Commit** `feat(cli): data folder lock held by the app`

### Task 2: Argument parser

**Files:**
- Create: `src-tauri/src/cli/mod.rs` (for now only `pub mod args; pub mod output;`), `src-tauri/src/cli/args.rs`
- Modify: `src-tauri/src/lib.rs`: `#[cfg(debug_assertions)] pub mod cli;`

Types (put in `args.rs`):

```rust
use crate::model::AtelierProject;
use std::ffi::OsString;
use std::path::PathBuf;

pub const CLI_ARG: &str = "--livery-cli";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PartGroupArg { Hull, Turret, Gun }

/// A view as typed: a quick view name or an orbit. Checked here, turned into a camera by the page.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ViewArg {
    Quick { name: String },              // front | side | rear | top
    Orbit { theta: f64, phi: f64, zoom: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum CliCommand {
    Vehicles { query: Option<String> },
    VehicleInfo { vehicle: String },
    ProjectNew { name: String, vehicle: String },
    ProjectList,
    ProjectGet { id: String },
    ProjectPut { project: AtelierProject },
    ImportImage { id: String, file: PathBuf, cutout: bool },
    Place { id: String, view: ViewArg, at: (f64, f64), part: Option<PartGroupArg>, width: Option<f64>, height: Option<f64>, depth: Option<f64> },
    Render { id: String, out: PathBuf, views: Vec<ViewArg>, size: u32, grid: bool, flat: bool },
    Apply { id: String },
}

/// `args`: everything after `--livery-cli`. `stdin`: read only for `project put -`.
pub fn parse(args: &[OsString], stdin: &mut dyn std::io::Read) -> crate::error::AppResult<CliCommand>
```

Rules:
- Every value must be valid UTF-8 (`invalidInput`, detail names the argument).
- Unknown command or flag, a missing value or a repeated flag → `AppError::new(ErrorCode::InvalidInput, "Bad arguments").with_detail(format!("{why}\n{USAGE}"))`, where `USAGE` is a `const &str` listing every command line exactly as in the spec's table.
- `--views`: comma list, default `front,side,rear,top`; quick names `front|side|rear|top`; `orbit:<theta>,<phi>,<zoom>` (all finite; zoom 0.15..=6; phi 0.01..=π−0.01). Inside `--views` an orbit's own commas are fine because each orbit starts with `orbit:` and always has exactly 3 numbers: split the list on `,`, then rejoin `orbit:` items with the next two items.
- `--size` 256..=2048, default 1024. `--at x,y` both finite in 0..=1. `--part hull|turret|gun`. `--width/--height/--depth` finite, > 0 (the page clamps to the editor's limits).
- `render --out`: required, must be an existing directory (`is_dir()`), stored canonicalized (`std::fs::canonicalize`).
- `import-image <file>`: must be an existing file, stored canonicalized.
- `project put <file|->`: read the whole file (or `stdin` for `-`), `serde_json::from_slice::<AtelierProject>`; parse error → `invalidInput` "Not an Atelier project" with the serde message in detail.

- [ ] **Step 1: Write the failing tests** (inline in `args.rs`), one per rule, e.g.:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn os(v: &[&str]) -> Vec<OsString> { v.iter().map(OsString::from).collect() }
    fn p(v: &[&str]) -> crate::error::AppResult<CliCommand> { parse(&os(v), &mut std::io::empty()) }

    #[test]
    fn render_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().to_str().unwrap();
        let CliCommand::Render { views, size, grid, flat, .. } = p(&["render", "abc", "--out", out]).unwrap() else { panic!() };
        assert_eq!(views.len(), 4);
        assert_eq!(size, 1024);
        assert!(!grid && !flat);
    }

    #[test]
    fn orbit_views_keep_their_commas() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().to_str().unwrap();
        let CliCommand::Render { views, .. } = p(&["render", "a", "--out", out, "--views", "front,orbit:0.5,1.2,1,top"]).unwrap() else { panic!() };
        assert_eq!(views, vec![
            ViewArg::Quick { name: "front".into() },
            ViewArg::Orbit { theta: 0.5, phi: 1.2, zoom: 1.0 },
            ViewArg::Quick { name: "top".into() },
        ]);
    }

    #[test]
    fn at_out_of_range_is_refused() {
        assert!(p(&["place", "a", "--view", "front", "--at", "1.2,0.5"]).is_err());
    }

    #[test]
    fn put_reads_stdin() {
        let json = br#"{"version":1,"id":"p1","name":"n","vehicle":"v","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","slots":[],"layers":[]}"#;
        let cmd = parse(&os(&["project", "put", "-"]), &mut &json[..]).unwrap();
        assert!(matches!(cmd, CliCommand::ProjectPut { project } if project.id == "p1"));
    }
    // + unknown command, unknown flag, repeated flag, size bounds, zoom bounds,
    //   missing --out dir, import-image missing file, vehicles --query, project new needs 2 args.
}
```

Check `AtelierProject`'s exact JSON fields in `src-tauri/src/model.rs` (the `layers` field name and type) and adjust the fixture.

- [ ] **Step 2:** run `cargo test --manifest-path src-tauri/Cargo.toml cli::args` → fail (no `parse`).
- [ ] **Step 3:** implement `parse`.
- [ ] **Step 4:** tests pass; clippy; fmt.
- [ ] **Step 5: Commit** `feat(cli): argument parser`

### Task 3: Output and exit codes

**Files:** Create `src-tauri/src/cli/output.rs`.

```rust
use crate::error::AppError;
use serde::Serialize;
use std::process::ExitCode;

/// What the CLI prints on failure: an `AppError`'s code as serialized, or one of the CLI-only codes.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct CliError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
}

pub const APP_RUNNING: &str = "appRunning";
pub const TIMEOUT: &str = "timeout";
pub const NO_HIT: &str = "noHit";

impl From<AppError> for CliError { /* serde_json::to_value(&e) → read "code","message","detail" */ }

impl CliError {
    pub fn new(code: &str, message: impl Into<String>) -> Self { ... }
    /// 1 usage/input, 2 internal, 3 app running, 4 timeout (spec §3).
    pub fn exit_code(&self) -> u8 {
        match self.code.as_str() {
            "invalidInput" | "notFound" | "unsupported" | NO_HIT => 1,
            APP_RUNNING => 3,
            TIMEOUT => 4,
            _ => 2,
        }
    }
}

/// The CLI's whole stdout: pretty JSON of `Ok` or of the `CliError`, then a newline.
pub fn render(result: &Result<serde_json::Value, CliError>) -> (String, ExitCode)
```

Check `AppError`'s `Serialize` in `src-tauri/src/error.rs` (field names, how `ErrorCode` serializes) and build `From<AppError>` from the serialized value so the code string is exactly what the frontend sees.

- [ ] **Step 1: failing tests:** `From<AppError>` keeps code/message/detail; `exit_code` for each code class (`invalidInput`→1, `notFound`→1, `unsupported`→1, `noHit`→1, `internal`→2, `io` or any other real code→2, `appRunning`→3, `timeout`→4); `render(Ok(json!({"a":1})))` is pretty JSON ending in `\n` with exit 0; `render(Err(..))` prints `{code,message}` without `detail` when `None`.
- [ ] **Step 2–4:** fail → implement → pass; clippy; fmt.
- [ ] **Step 5: Commit** `feat(cli): JSON output and exit codes`

---

## Chunk 2: Scene and engine additions (TypeScript)

### Task 4: `renderPixels`, `raycastView`, `loadAsset` option

**Files:**
- Modify: `src/atelier/gl/scene.ts`, `src/screens/Atelier/engine.ts`
- Test: `src/atelier/gl/scene.test.ts` (existing; add cases that run without WebGL), `src/screens/Atelier/engine.test.ts` if it exists (else a small new test for the `loadAsset` plumbing with a mocked `Baker`; check how the existing tests stub `three`).

Changes:
1. In `scene.ts` add an exported pure helper so the CLI and tests share the camera maths:

```ts
/** The camera of an orbit at aspect 1 (CLI pictures and picks): position, target and up. */
export function orbitCamera(o: OrbitState): { position: Vec3; target: Vec3 } {
  return { position: orbitPosition(o), target: o.target };
}
```
(only if `placeCamera` doesn't already expose this; read `placeCamera` and `orbitPosition` first and reuse them.)

2. `EditorScene.renderPixels(orbit: OrbitState, size: number): Uint8ClampedArray` — the body of today's `thumbnailPng` up to the readback, with `orbit` instead of `defaultOrbit(...)` and returning `toStraightTopDown(pixels, size, size)`. `thumbnailPng(size)` becomes `encodePng(this.renderPixels(defaultOrbit(this.center, framingDistance(this.boundingRadius, FOV, 1)), size), size, size)`. Keep the camera restore in `finally` exactly as today. Read the current `thumbnailPng` tail (lines ~399-410) to keep the same straight-alpha conversion.

3. `EditorScene.quickOrbit(view: QuickView): OrbitState` → `quickViewOrbit(view, this.center, framingDistance(this.boundingRadius, FOV, 1))`, and `EditorScene.orbitFor(theta, phi, zoom): OrbitState` → `{ theta, phi: clamp(phi, PHI_MIN, PHI_MAX), radius: framingDistance(this.boundingRadius, FOV, 1) * clamp(zoom, ZOOM_MIN, ZOOM_MAX), target: [...this.center] }`. Check `OrbitState`'s field names (lines 22-29) and use them.

4. `EditorScene.raycastView(orbit, ndcX, ndcY, group = null): { hit: SceneHit | null; cameraMatrixWorld: number[] }` — saves `this.orbit` and the aspect, places the camera at `orbit` with aspect 1, `updateMatrixWorld(true)`, raycasts with `this.ndc.set(ndcX, ndcY)` using the same part filtering and hit building as `raycast` (factor the shared part into a private `hitFrom(intersections)`), copies `camera.matrixWorld.elements`, then restores the camera in `finally`.

5. `engine.ts`: `EngineInput` gets `loadAsset?: (assetId: string) => Promise<DecalImage>`; `createEngine` passes `loadAsset ?? loadProjectAsset` to the Baker. `EngineScene` interface gains `renderPixels`, `raycastView`, `quickOrbit`, `orbitFor`. Update any test stub implementing `EngineScene` (grep `EngineScene` in `src/**/*.test.tsx`) with `vi.fn()` members.

- [ ] **Step 1:** failing tests for whatever runs without WebGL (`orbitFor` clamping and target = centre, `quickOrbit` equals `quickViewOrbit` with aspect-1 framing; `createEngine` passes a given `loadAsset` — if `createEngine` can't run without WebGL in jsdom, test it by mocking `@/atelier/gl/baker`'s `Baker` constructor with `vi.mock` and asserting the option). Look at how `scene.test.ts` already tests without a renderer.
- [ ] **Step 2–4:** fail → implement → pass; `pnpm typecheck`; `pnpm vitest run src/atelier src/screens/Atelier`.
- [ ] **Step 5: Commit** `feat(atelier): scene pictures and picks from any orbit; engine asset loader option`

---

## Chunk 3: CLI runtime and the spike

### Task 5: CLI mode in Tauri, page commands, `cli.html`, and the spike

**Files:**
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/src/cli/mod.rs`
- Create: `src-tauri/src/cli/page.rs`, `src-tauri/capabilities/cli.json`, `cli.html`, `src/cli/main.ts`, `src/cli/job.ts` (types only for now)
- Modify: `vite.config.ts`

**5a. `build_app`.** Split `run()`:

```rust
pub enum Mode {
    App,
    #[cfg(debug_assertions)]
    Cli(cli::CliState),
}

/// The builder both modes share: plugins, managed state and commands. `generate_context!` is
/// expanded once, in `run`/`cli::main`'s caller (it embeds the frontend).
fn build_app(context: tauri::Context<tauri::Wry>, mode: Mode) -> tauri::App { ... }

pub fn run() {
    let clock = startup::StartupClock::new();
    logging::init();
    build_app(tauri::generate_context!(), Mode::App).run(|app, event| { /* unchanged */ });
}

#[cfg(debug_assertions)]
pub fn run_cli(state: cli::CliState) -> u8 {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let mut app = build_app(context, Mode::Cli(state));
    let code = app.run_return(|_, _| {});
    // `run_return`'s own code is the event loop's; the CLI's is what `cli_finish`/the timeout stored.
    let _ = code;
    cli::exit_code(&app.handle())
}
```

Careful: `generate_context!()` must appear **once per binary build path** — two expansions in two functions of the same crate embed the assets twice. Put the single expansion in a private `fn context() -> tauri::Context<tauri::Wry> { tauri::generate_context!() }` and call it from both `run()` and `run_cli()`.

In `build_app`, the parts that differ by mode:
- `Mode::App`: everything `run()` does today (updater + autostart plugins, all `setup` work, lock from Task 1).
- `Mode::Cli`: no updater or autostart plugin; in `setup` the same data dir/logging/managed state (settings, libraries, queue, catalog, profile, wtlive, atelier, cutout), **no** lock acquire (the CLI took it), **no** `purge_on_startup`s, `start_idle_ticker`, `load_vehicles_in_background`, `watch::start`, `update::start`; `app.manage(state)` then `cli::start(app.handle())`.
- `RunEvent::Exit`'s `update::install_on_exit` only in App mode.
- Data dir: `run_cli` needs the data dir **before** setup to take the lock. `cli::main` resolves it with `startup::resolve_data_dir(env, || ...)`; the fallback closure has no `AppHandle` yet, so for the CLI require `LIVERY_DATA_DIR` **or** compute the default with `dirs`-free std: `std::env::var_os("APPDATA")` + the bundle identifier `app.livery.desktop` (that is what Tauri's `app_data_dir()` returns on Windows; confirm by logging `app.path().app_data_dir()` once in the app). Store the resolved dir in `CliState` and in setup use it instead of resolving again (assert it equals `app.path().app_data_dir()` when `LIVERY_DATA_DIR` is unset, warn if not).

The invoke handler list stays one list; add `cli::page::cli_job, cli::page::cli_file, cli::page::cli_finish` to it. `page.rs` is **not** cfg-gated (so the list compiles in release); in release `CliState` doesn't exist, so the commands look it up through a small non-gated type:

```rust
// page.rs (every build)
/// What the page talks to; only a debug build's CLI mode manages one.
pub struct PageJob {
    pub job: serde_json::Value,           // CliJob as JSON (see src/cli/job.ts)
    pub out_dir: Option<std::path::PathBuf>,
    pub finish: Box<dyn Fn(Result<serde_json::Value, PageError>) + Send + Sync>,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PageError { pub code: String, pub message: String, #[serde(default)] pub detail: Option<String> }

fn job(app: &AppHandle) -> AppResult<tauri::State<'_, PageJob>> {
    app.try_state::<PageJob>().ok_or_else(|| AppError::new(ErrorCode::Unsupported, "Not in agent CLI mode"))
}

#[tauri::command] pub fn cli_job(app: AppHandle) -> AppResult<serde_json::Value>
#[tauri::command] pub async fn cli_file(app: AppHandle, request: Request<'_>) -> AppResult<()>
    // header x-name, checked by `is_file_name` (^[A-Za-z0-9._-]{1,64}$, not "." or ".."),
    // raw body written to out_dir/name (create or replace); no out_dir → invalidInput
#[tauri::command] pub fn cli_finish(app: AppHandle, result: Result<serde_json::Value, PageError>) -> AppResult<()>
```

Check how Tauri 2 deserializes a `Result` argument; if awkward, use `cli_finish(app, ok: Option<Value>, error: Option<PageError>)` instead and mirror it in `main.ts`. Reuse `atelier`'s `header`/`raw_body` helpers (make them `pub(crate)`).

**5b. `cli::main` and `cli::start`** (`cli/mod.rs`):

```rust
pub fn main(args: Vec<OsString>) -> ExitCode {
    // 1. parse (stdin for `put -`); error → print, exit
    // 2. resolve data dir; DataLock::acquire → Busy → CliError APP_RUNNING
    // 3. CliState { command, data_dir, lock, result: Mutex<Option<(String, u8)>> }
    // 4. crate::run_cli(state) → exit code; print the stored output
}
```

`CliState` holds the result **text** and code; printing happens in `main` after `run_cli` returns (so nothing else interleaves). `cli::start(app)`:
- no-GPU command → `tauri::async_runtime::spawn(async move { let r = run_rust(&app, cmd).await; finish(&app, r) })` (Task 6 fills `run_rust`; for now return `unsupported` for everything but the spike).
- GPU command → `app.manage(PageJob { job, out_dir, finish })`, create the window:

```rust
tauri::WebviewWindowBuilder::new(app, "cli", tauri::WebviewUrl::App("cli.html".into()))
    .visible(false)
    .decorations(false)
    .skip_taskbar(true)
    .inner_size(64.0, 64.0)
    .build()?;
```

- timeout: `spawn(async { sleep(120 s or 300 s for apply); finish(&app, Err(CliError::new(TIMEOUT, ...))) })`. `finish` stores the result only the first time (later calls ignored) and calls `app.exit(0)`.
- `cli::exit_code(handle)` reads the stored code.

**5c. `main.rs`:**

```rust
    livery_lib::startup::webview_data_into_data_dir();
    #[cfg(debug_assertions)]
    if std::env::args_os().nth(1).is_some_and(|a| a == livery_lib::cli::args::CLI_ARG) {
        let args: Vec<_> = std::env::args_os().skip(2).collect();
        return livery_lib::cli::main(args); // main must then return ExitCode
    }
    livery_lib::run();
    ExitCode::SUCCESS
```

(`fn main() -> std::process::ExitCode`; the Oodle worker branch returns `ExitCode::SUCCESS` after `worker_main()`.)

**5d. Capability** `src-tauri/capabilities/cli.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "cli",
  "description": "The hidden agent-CLI window (debug builds only create it): core IPC and events.",
  "windows": ["cli"],
  "permissions": ["core:default"]
}
```

**5e. Page.** `cli.html` at the repo root (copy `index.html`'s `<head>` essentials, no fonts/CSS needed):

```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Livery CLI</title></head>
  <body><script type="module" src="/src/cli/main.ts"></script></body>
</html>
```

`vite.config.ts` `build.rollupOptions.input = { main: fileURLToPath(new URL('./index.html', import.meta.url)), cli: fileURLToPath(new URL('./cli.html', import.meta.url)) }`. Check that `pnpm build` still produces `dist/index.html` and the licence notices, and add `cli.html` to the existing "no mock in dist" check if that check lists entry files (grep for it in `scripts/` or HANDOFF).

`src/cli/main.ts` (spike version): `const job = await call('cli_job')`; for `{ command: 'spike' }`… Instead of a throwaway command, the spike **is** a minimal `render`: implement in `main.ts` a temporary path that loads project/model/templates, `createEngine` on `document.createElement('canvas')`, `setLayers(project.layers via checkLayers, enabledSlots)`, `await baker.whenReady()`, `renderPixels(quickOrbit('front'), 512)`, `encodePng`, `callRaw('cli_file', png, {'x-name': 'spike.png'})`, `cli_finish({ ok: { ms } })`. Task 8 replaces it with `runJob`.

**5f. Spike run** (needs the scratch game root, see Task 11 "Scratch setup"; do that setup now):
- `pnpm tauri build --debug --no-bundle`
- `LIVERY_DATA_DIR=<scratch>/data src-tauri/target/debug/livery.exe --livery-cli render <projectId> --out <scratch>/out --views front --size 512` (create the project once with the dev app on the scratch data, or with Task 6's `project new` if done first: Task 6 may be done before 5f).
- Expect exit 0, `spike.png` showing the Jumbo, time under ~15 s.
- If it times out or the PNG is empty: try (1) `.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding")` on the builder, then (2) `.visible(true).position(-32000.0, -32000.0)`. Keep the first that works.
- Write the outcome as a DESIGN_NOTES row "Atelier CLI: hidden window" (what was tried, what works, timings).

- [ ] **Step 1:** Rust tests in `page.rs` for `is_file_name` (ok: `front.png`, `slot_body_c.png`; refused: `../x`, `a/b`, `a\\b`, ``, `.`, `..`, 65 chars, `con:`).
- [ ] **Step 2:** 5a–5e; `cargo test`, clippy (both `--all-targets` and `--release` check: `cargo check --manifest-path src-tauri/Cargo.toml --release`), `pnpm typecheck`, `pnpm build`.
- [ ] **Step 3:** App unchanged: `pnpm tauri dev` starts, Atelier opens a project (on scratch data), Apply still works. (Or `cargo test` + the existing `Editor.test.tsx` if the dev run is done once at the end of Task 9.)
- [ ] **Step 4:** 5f spike; DESIGN_NOTES row.
- [ ] **Step 5: Commit** `feat(cli): CLI mode with a hidden page window` (+ the DESIGN_NOTES row).

---

## Chunk 4: Commands

### Task 6: No-GPU commands and the `put` pre-check

**Files:** `src-tauri/src/cli/mod.rs` (new fn `run_rust`), maybe `src-tauri/src/cli/rust_cmds.rs` if `mod.rs` passes ~300 lines.

`run_rust(app: &AppHandle, cmd: &CliCommand) -> Result<serde_json::Value, CliError>` calls the command functions directly (they are `pub async fn`):
- `Vehicles { query }` → `crate::game::game_vehicles(app.clone()).await`, filter `code`/`name` by lowercase substring, `serde_json::to_value`.
- `ProjectNew` → `crate::atelier::atelier_project_create(app.clone(), name, vehicle).await`.
- `ProjectList` → `atelier_projects`. `ProjectGet` → `atelier_project_get`.
- `ImportImage { id, file, cutout }` → `atelier_import_image(app, id, file.to_string_lossy())`; if `cutout`, `atelier_cutout(app, id, asset.id)`; output `{ "asset": AssetRef, "cutout": CutoutResult? }`.

Before a GPU job starts, `ProjectPut` is checked in Rust: `atelier_project_get(app, project.id)` must succeed (`notFound` passes through) and `stored.vehicle == project.vehicle` (else `invalidInput` "The project's vehicle can't change"). Then the page job carries the project.

`game_vehicles` returns the built-in list when reading the game is off; that's fine (documented in cli.md).

- [ ] **Step 1:** Tests: `run_rust` needs an `AppHandle`. Use `tauri::test::mock_builder()` if the crate enables Tauri's `test` feature (grep `features` for tauri in Cargo.toml and look for `mock_builder` in existing tests). If not available, test the pure pieces only (the vehicle filter as `fn filter_vehicles(list, query)`, the vehicle check as `fn check_put(stored, incoming)`), and cover the rest in the Task 11 real run. Do not add the feature without asking.
- [ ] **Step 2–4:** implement, tests, clippy, fmt. Real check on scratch data: `vehicles --query jumbo`, `project new Test us_m4a3e2_sherman_jumbo`, `project list`, `project get <id>`, `import-image <id> <png>` (and `--cutout` if the scratch models dir has the files; otherwise expect the not-ready error, exit 1).
- [ ] **Step 5: Commit** `feat(cli): vehicles, project new/list/get, import-image`

### Task 7: `job.ts` and `grid.ts`

**Files:** `src/cli/job.ts`, `src/cli/grid.ts`, tests `src/cli/job.test.ts`, `src/cli/grid.test.ts`.

`job.ts` mirrors the Rust job JSON. Decide the shape in Task 5 and keep it here, e.g.:

```ts
export type ViewArg = { kind: 'quick'; name: QuickView } | { kind: 'orbit'; theta: number; phi: number; zoom: number };
export type CliJob =
  | { command: 'put'; project: AtelierProject }
  | { command: 'vehicleInfo'; vehicle: string }
  | { command: 'place'; id: string; view: ViewArg; at: [number, number]; part: PartGroup | null; width?: number; height?: number; depth?: number }
  | { command: 'render'; id: string; views: ViewArg[]; size: number; grid: boolean; flat: boolean }
  | { command: 'apply'; id: string };
export function viewName(v: ViewArg): string  // 'front' | 'orbit_0.50_1.20_1.00' (file-name safe)
export function viewOrbit(v: ViewArg, scene: Pick<EngineScene, 'quickOrbit' | 'orbitFor'>): OrbitState
export function atToNdc([x, y]: [number, number]): [number, number]  // [x*2-1, 1-y*2]
```

`grid.ts`: `drawGrid(rgba: Uint8ClampedArray, size: number): void` draws vertical/horizontal lines at `round(size*k/10)`, k = 1..9, 1 px light (`#f2f2f2`) with a 1 px dark (`#101010`) outline on both sides; digit `k` near the top of each vertical line and the left of each horizontal line, from a 3×5 bitmap font scaled ×2 (light on a dark box). These are picture pixels, not UI colours, so CLAUDE.md's token rule doesn't apply (a comment says so).

- [ ] **Step 1:** tests: `atToNdc([0,0]) → [-1,1]`, `([1,1]) → [1,-1]`; `viewName` is file-safe; `viewOrbit` calls the right scene method; `drawGrid` sets the light colour at `(round(size*0.5), 3)`'s column, leaves a pixel far from lines untouched, draws digit pixels inside the label box for `5`.
- [ ] **Step 2–4:** fail → implement → pass; typecheck.
- [ ] **Step 5: Commit** `feat(cli): job types, views and the picture grid`

### Task 8: `runner.ts`: put, vehicle-info, place, render

**Files:** `src/cli/runner.ts`, `src/cli/runner.test.ts`, `src/cli/main.ts` (replace the spike).

```ts
export interface RunnerDeps {
  call: typeof call;
  callRaw: typeof callRaw;
  createEngine: EngineFactory;
  canvas: () => HTMLCanvasElement;
}
export async function runJob(job: CliJob, deps: RunnerDeps): Promise<unknown>  // the `ok` JSON
```

Shared loading (`loadWorkspace(projectId | project)`): project (`atelier_project_get`, or the job's for `put`), model `parseModelBuffer(toArrayBuffer(await call('atelier_model', { vehicle })))`, templates as in `Editor.tsx` lines 134-143 (one `atelier_template_texture` per slot; a failed one is left out, like the editor), `{ layers } = checkLayers(project.layers)`, `slots = enabledSlots(project, model)`, engine via `deps.createEngine({ canvas, model, templates, loadAsset })` where `loadAsset(assetId)` = `fetchAsset(project.id, assetId)` mapped to `{ rgba, w, h }` (as `loadProjectAsset` does, without the UI flags). `baker.setLayers(layers, slots)`; `await baker.whenReady()`. Always `engine.dispose()` in `finally`.

- `vehicleInfo`: no engine. From the parsed model: `{ vehicle, model, mirrorAxis, slots: header.slots, parts: header.parts.map(p => ({ node, group, slot: slots[p.slot].texture, triangles: p.indexCount/3, bounds: {min,max} })), bounds, center, radius }`. Bounds from `positions` over each part's vertex range (same loop as `scene.setModel`); centre/radius from the overall box (document that the editor uses the bounding *sphere*; give both: `box` and `sphere` computed like three's `computeBoundingSphere` — simplest: centre of the box, radius = max distance of any vertex from it).
- `put`: `checked = checkLayers(job.project.layers)`; build the engine with `checked.layers`; for each placed layer (image/text/shape/merged; reuse the editor's predicate — grep `isPlaced` or how `LayerRows`/Mirror toggle decides) with `decal.mirror === true`, `await baker.decalTouchesSharedTexels(decal)` → collect ids; `saved = await call('atelier_project_save', { project: { ...job.project, layers: checked.layers } })`; thumbnail: `baker.upgrade(); png = await scene.thumbnailPng(512); await callRaw('atelier_project_thumb', png, { 'x-project-id': saved.id })` (failure only warns, like the editor); return `{ project: saved, repaired: checked.repaired, sharedTexels }`.
- `place`: `{ hit, cameraMatrixWorld } = scene.raycastView(viewOrbit(job.view, scene), ...atToNdc(job.at), job.part)`; no hit → throw `{ code: 'noHit', message: 'Nothing of the vehicle at that point' }`; `size = { width: job.width ?? 1, height: job.height ?? 1, depth: job.depth }`; `decal = frameFromHit(hit.point, hit.normal, cameraMatrixWorld, size, job.part ?? 'all')`; null → `noHit` too; return `{ decal, group: hit.group, node: hit.node }`.
- `render`: `baker.upgrade()` (full preview quality before pictures); per view: `px = scene.renderPixels(viewOrbit(v, scene), job.size)`; `if (job.grid) drawGrid(px, job.size)`; `png = await encodePng(px, size, size)`; `name = `${viewName(v)}.png``; `callRaw('cli_file', png, { 'x-name': name })`; collect `{ view: viewName(v), file: name, width, height }`. `flat`: per slot `r = baker.bakeForExport(slot, false)` — check whether `bakeForExport` requires `prepareExport` first (`EXPORT_PICTURE_NOT_READY`); if so call `prepareExport(false)` before and `endExport()` after. Encode `r.rgba` (`r.w × r.h`) as PNG named `flat_${slot}.png`. Return `{ views, flat }`. The page sends file names only; Rust adds the directory, and `main.ts`... the result's `file` field is the bare name; Rust's `finish` for `render` rewrites each `file` to the absolute path in `out_dir` before printing (do this in `cli::start`'s finish for the render job; keeps paths out of the page).

`main.ts`:

```ts
import { call, callRaw, toAppError } from '@/lib/tauri';
import { createEngine } from '@/screens/Atelier/engine';
import { runJob } from './runner';
import type { CliJob } from './job';

async function main() {
  try {
    const job = await call<CliJob>('cli_job');
    const ok = await runJob(job, { call, callRaw, createEngine, canvas: () => document.createElement('canvas') });
    await call('cli_finish', { ok, error: null });
  } catch (e) {
    const err = isCliError(e) ? e : toAppError(e);
    await call('cli_finish', { ok: null, error: { code: err.code, message: err.message, detail: err.detail ?? null } });
  }
}
void main();
```

(Adapt to the `cli_finish` signature chosen in Task 5. `isCliError` = has string `code` and `message`.) Check that importing `engine.ts` doesn't pull `i18n` side effects that fail without the app's setup; if it does, import `Baker`/`EditorScene` directly and build the engine in `runner.ts` the same way `createEngine` does (then `deps.createEngine` defaults to that local factory).

- [ ] **Step 1:** runner tests with a stub `call` (returns a tiny model built with `src/dev/mockAtelier.ts`'s `encodeMockModel` and `mockTemplate`, and a fixed project) and a stub engine recording calls: `place` returns the frame of the stub hit and `noHit` when the stub returns null; `render` sends one `cli_file` per view with the expected names and `grid` modifies pixels; `put` saves `checkLayers`' layers and lists only mirrored decals the stub reports as shared; `vehicleInfo` bounds on the mock cube; engine disposed after an error.
- [ ] **Step 2–4:** fail → implement → pass; typecheck; `pnpm build`.
- [ ] **Step 5:** Real check on scratch data: `render --grid` (4 PNGs), `place --view front --at 0.5,0.5`, `vehicle-info us_m4a3e2_sherman_jumbo`, `project put` of the fetched project with a camo base.
- [ ] **Step 6: Commit** `feat(cli): render, place, vehicle-info and project put`

### Task 9: `apply`

**Files:** `src/cli/apply.ts`, `src/cli/apply.test.ts`, `src/cli/runner.ts` (dispatch), a one-line comment in `src/screens/Atelier/useApply.ts` pointing to `src/cli/apply.ts`.

```ts
/**
 * The CLI's Apply to game: the same calls in the same order as the editor's `useApply.ts` (keep
 * the two in step): begin → layers → pictures at full size → per slot bake + texture →
 * thumbnail → commit; cancel on any error before the commit.
 */
export async function applyProject(w: Workspace, deps: Pick<RunnerDeps, 'call' | 'callRaw'>): Promise<ApplyResult> {
  const { project, model, engine, layers, slots } = w;
  const highQuality = project.output.highQuality;
  const { applyId } = await deps.call<ApplyStarted>('atelier_apply_begin', { projectId: project.id, enabled: slots });
  let committing = false;
  let exporting = false;
  try {
    engine.baker.setLayers(layers, slots);
    await engine.baker.whenReady();
    await engine.baker.prepareExport(highQuality);
    exporting = true;
    for (const slot of slots) {
      engine.baker.setLayers(layers, slots);
      const r = engine.baker.bakeForExport(slot, highQuality);
      await deps.callRaw('atelier_apply_texture', r.rgba, { 'x-apply-id': applyId, 'x-slot': slot, 'x-width': String(r.w), 'x-height': String(r.h) });
    }
    await sendThumb(w, deps);           // shared with `put`; a failure only warns
    committing = true;
    return await deps.call<ApplyResult>('atelier_apply_commit', { applyId });
  } catch (e) {
    if (!committing) await deps.call('atelier_apply_cancel', { applyId }).catch(() => {});
    throw e;
  } finally {
    if (exporting) engine.baker.endExport();
  }
}
```

Output: the `ApplyResult` plus `downscaled` (OR of the slots' `r.downscaled`) so the agent knows when a texture was reduced.

- [ ] **Step 1:** tests with stub deps/engine: call order (begin, texture per slot in order, thumb, commit); an error in the second texture → `atelier_apply_cancel` called, error rethrown, `endExport` called; error after `commit` started → no cancel.
- [ ] **Step 2–4:** fail → implement → pass; typecheck.
- [ ] **Step 5:** Real check on scratch data: `apply <id>` → exit 0, `UserSkins/<folder>` in the scratch game root has DDS + blk + preview.png; the dev app (same scratch data, CLI not running) shows the skin in My Hangar and the project in the Atelier list.
- [ ] **Step 6: Commit** `feat(cli): apply`

---

## Chunk 5: Docs and acceptance

### Task 10: Docs

**Files:** `docs/cli.md` (new), `DESIGN_NOTES.md`, `HANDOFF.md`.

`docs/cli.md` sections: What it is (agent tool, debug builds, not in releases) · Build (`pnpm tauri build --debug --no-bundle`) · Rules (Livery must be closed → exit 3; scratch runs with `LIVERY_DATA_DIR`; real installs only when the author asks) · Commands (each with one real example and its JSON, taken from the Task 6–9 runs) · Exit codes · Layer JSON essentials (Base fields, image/text/shape layers and `Decal` fields with units in metres, `mirror`, `part`; pointer to `src/atelier/project.ts` as the source of truth; a minimal complete project example) · Working loop (render --grid → read fractions → place → put → render → apply) · Pitfalls (shared texels: Mirror on such a decal is listed by `put`'s `sharedTexels` and the editor turns Mirror off there; Depth 0.5–0.75 m for domed roofs and sloped noses; Jumbo hull side is a ~0.8 m strip, big pictures on the glacis; a hit on a bracket puts the decal in front of the plate: place on the plate itself; cutout needs the files downloaded from the app first).

DESIGN_NOTES rows (dated 2026-10-19): "Atelier CLI" (decision summary: approach A, debug only, lock, codes, English messages not via `t()` because not UI, own apply sequence mirroring `useApply`), plus the spike row from Task 5.

HANDOFF: new top section "Atelier CLI (2026-10-19)": what's in, how to build/run, checks, open points.

- [ ] Write, proofread, commit `docs(cli): agent manual, design notes, handoff`

### Task 11: Real acceptance run

**Scratch setup** (in the session scratchpad, never the real game folder):
- Game root: a folder with the same layout the game root detection needs. Look at `src-tauri/src/game/root.rs` for what makes a folder a valid game root, and at HANDOFF's earlier runs ("junctions to `content`/`content.hq`, copied archives, empty `UserSkins`"). Make directory junctions (`cmd /c mklink /J`) for the big pack folders from `D:\SteamLibrary\steamapps\common\War Thunder`, copy the small files the detection reads, create an empty `UserSkins`.
- Data dir: `<scratch>/data` with `settings.json` naming the scratch game root and `readGameData: true` (start the dev app once with `LIVERY_DATA_DIR` set and pick the folder, or write the file by hand from `Settings`' serde shape).

**Run** with `LIVERY_DATA_DIR=<scratch>/data`, from the CLI only, on `us_m4a3e2_sherman_jumbo`:
1. `vehicles --query jumbo`; `vehicle-info`.
2. `project new "CLI test" us_m4a3e2_sherman_jumbo`.
3. `project get` → set a camo Base (e.g. digital, 3 colours) → `project put`.
4. `import-image <id> <a test picture> --cutout` (if the cutout files aren't in the scratch models dir, use a PNG with transparency and no `--cutout`, and note it).
5. `render --grid --out <scratch>/r1`; look at the PNGs; `place --view front --at <x,y on the glacis>`.
6. Add an image layer with that decal and a text layer; `project put`; `render --out <scratch>/r2`; check the pictures.
7. `apply`.
8. Checks: decode the body DDS from the scratch `UserSkins` folder (the existing test helper or a short script in the scratchpad) and confirm the decals are there; open the dev app on the same scratch data: the project is in the Atelier list and the editor shows the same thing as `r2`; with the dev app open, any CLI command exits 3 with `appRunning`.
9. Full checks: `cargo test`, clippy (debug and `--release` check), fmt, `pnpm test`, `pnpm typecheck`, `pnpm i18n:check`, `pnpm build` (no mock in dist).

- [ ] Run, fix what breaks (each fix its own commit), record results in HANDOFF.
- [ ] Commit `test(cli): acceptance run notes` if HANDOFF changed.
