//! Runs one CLI command inside a Tauri app in CLI mode (`crate::run_cli`): the same data dir,
//! managed state and commands as the app. Commands Rust answers by itself run in a task; the
//! others (`CliCommand::page_job`) open a hidden window on `cli.html` whose script runs the job
//! with the editor's own scene and Baker and answers through `cli::page`. Whatever answers first
//! (the command, the page, the timeout, a setup failure) is printed; the rest is ignored.

use super::args::{self, CliCommand};
use super::output::{self, CliError, APP_RUNNING, TIMEOUT};
use super::page::{is_file_name, PageError, PageJob};
use super::rust_cmds;
use serde_json::Value;
use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use tauri::{AppHandle, Manager};

/// The page window's label (`capabilities/cli.json` grants it `core:default`).
pub const WINDOW: &str = "cli";

/// What [`main`] prints once the app is gone, and the exit code.
struct Answer {
    text: String,
    code: u8,
}

/// CLI mode's managed state: the command and the slot its answer goes to. `main` keeps its own
/// handle on the slot so it never reads managed state after the app has ended.
pub struct CliState {
    command: CliCommand,
    answer: Arc<Mutex<Option<Answer>>>,
    done: AtomicBool,
}

/// `args`: everything after `--livery-cli`. Prints one JSON document on stdout and returns the
/// exit code (`output::CliError::exit_code`).
pub fn main(args: Vec<OsString>) -> ExitCode {
    let command = match args::parse(&args, &mut std::io::stdin()) {
        Ok(command) => command,
        Err(e) => return print(&Err(e.into())),
    };
    let answer = Arc::new(Mutex::new(None));
    let state = CliState { command, answer: answer.clone(), done: AtomicBool::new(false) };
    // The code `run_return` gives back is only what `finish` asked for, or 0 when the loop ended
    // some other way: the stored answer is what counts.
    let _ = crate::run_cli(state);
    let stored = answer.lock().unwrap_or_else(PoisonError::into_inner).take();
    match stored {
        Some(answer) => {
            write_stdout(&answer.text);
            ExitCode::from(answer.code)
        }
        None => print(&Err(CliError::new("internal", "The agent CLI ended without an answer"))),
    }
}

fn print(result: &Result<Value, CliError>) -> ExitCode {
    let (text, code) = output::render(result);
    write_stdout(&text);
    code
}

fn write_stdout(text: &str) {
    let mut out = std::io::stdout().lock();
    // Nothing better to do when stdout is gone: the exit code still tells.
    let _ = out.write_all(text.as_bytes()).and_then(|()| out.flush());
}

/// Ends the run with `result`: the first call wins, later ones (a late page answer after the
/// timeout, say) are dropped. Stores the printed text, then stops the event loop; any window
/// still open closes with it.
pub fn finish(app: &AppHandle, result: Result<Value, CliError>) {
    let state = app.state::<CliState>();
    if state.done.swap(true, Ordering::SeqCst) {
        return;
    }
    let code = match &result {
        Ok(_) => 0,
        Err(e) => e.exit_code(),
    };
    if let Err(e) = &result {
        tracing::info!(code = %e.code, message = %e.message, "agent CLI: failed");
    }
    let (text, _) = output::render(&result);
    *state.answer.lock().unwrap_or_else(PoisonError::into_inner) = Some(Answer { text, code });
    app.exit(i32::from(code));
}

/// The data lock refused in CLI setup: busy means the app (or another CLI run) has the folder.
pub fn lock_error(e: crate::lock::LockError) -> CliError {
    match e {
        crate::lock::LockError::Busy => {
            CliError::new(APP_RUNNING, "Livery is open on this data folder: close it first")
        }
        crate::lock::LockError::Io(e) => {
            CliError::new("io", "The data folder lock can't be taken").with_detail(e.to_string())
        }
    }
}

/// Starts the command (end of CLI setup, once the managed state exists). Setup stays
/// synchronous: the work runs in one async task, the timeout on its own thread (no tokio
/// dependency for a timer).
pub fn start(app: &AppHandle) {
    let command = app.state::<CliState>().command.clone();
    let timeout = command.timeout();
    let message = if command.page_job().is_some() {
        "The agent CLI page didn't answer in time"
    } else {
        "The command didn't finish in time"
    };
    let timer = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        finish(&timer, Err(CliError::new(TIMEOUT, message)));
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        match command.page_job() {
            None => {
                let result = rust_cmds::run_rust(&app, &command).await;
                finish(&app, result);
            }
            Some(job) => {
                if let Err(e) = rust_cmds::before_page(&app, &command).await {
                    finish(&app, Err(e));
                    return;
                }
                let out_dir = match &command {
                    CliCommand::Render { out, .. } => Some(out.clone()),
                    _ => None,
                };
                let handle = app.clone();
                let files_in = out_dir.clone();
                app.manage(PageJob {
                    job,
                    out_dir,
                    finish: Box::new(move |result: Result<Value, PageError>| {
                        tracing::debug!(ms = started.elapsed().as_millis() as u64, "agent CLI: page answered");
                        let result = result
                            .map(|mut value| {
                                if let Some(dir) = &files_in {
                                    absolute_files(&mut value, dir);
                                }
                                value
                            })
                            .map_err(|e| CliError { code: e.code, message: e.message, detail: e.detail });
                        finish(&handle, result);
                    }),
                    loaded: AtomicBool::new(false),
                });
                if let Err(e) = open_page(&app) {
                    finish(
                        &app,
                        Err(CliError::new("internal", "The agent CLI page can't open").with_detail(e.to_string())),
                    );
                    return;
                }
                watch_page_load(&app);
            }
        }
    });
}

/// How long the page may take to ask for its job. A page that never loads (a `tauri dev` build
/// pointing at a dev server that isn't running, a broken bundle) fails here instead of after
/// the full timeout, which stays for a page that did load and is working.
const PAGE_LOAD_LIMIT: std::time::Duration = std::time::Duration::from_secs(20);

/// Ends the run with `internal` when the page hasn't called `cli_job` within [`PAGE_LOAD_LIMIT`].
fn watch_page_load(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PAGE_LOAD_LIMIT);
        let loaded = app.try_state::<PageJob>().is_some_and(|page| page.loaded.load(Ordering::SeqCst));
        if !loaded {
            finish(
                &app,
                Err(CliError::new(
                    "internal",
                    "The agent CLI page didn't load (is target/debug/livery.exe a `tauri dev` build? \
                     Rebuild with pnpm tauri build --debug --no-bundle)",
                )),
            );
        }
    });
}

/// The hidden page window. Small and never shown: the page draws into its own render targets,
/// so the window's size doesn't matter.
fn open_page(app: &AppHandle) -> tauri::Result<()> {
    let builder = tauri::WebviewWindowBuilder::new(app, WINDOW, tauri::WebviewUrl::App("cli.html".into()))
        .visible(false)
        .decorations(false)
        .skip_taskbar(true)
        .inner_size(64.0, 64.0);
    builder.build()?;
    Ok(())
}

/// `render`'s answer names its files bare (the page never sees `--out`): each `views[].file` and
/// `flat[].file` becomes the absolute path in `dir` before printing.
fn absolute_files(value: &mut Value, dir: &Path) {
    for list in ["views", "flat"] {
        let Some(items) = value.get_mut(list).and_then(Value::as_array_mut) else { continue };
        for item in items {
            let Some(file) = item.get_mut("file") else { continue };
            if let Some(name) = file.as_str().filter(|n| is_file_name(n)) {
                *file = Value::String(dir.join(name).display().to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::absolute_files;
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn render_files_get_the_out_folder() {
        let dir = Path::new("C:\\out");
        let mut value = json!({
            "views": [{ "view": "front", "file": "front.png", "width": 512, "height": 512 }],
            "flat": [{ "slot": "body_c", "file": "flat_body_c.png" }, { "slot": "x", "file": "../x" }],
        });
        absolute_files(&mut value, dir);
        assert_eq!(value["views"][0]["file"], json!(dir.join("front.png").display().to_string()));
        assert_eq!(value["flat"][0]["file"], json!(dir.join("flat_body_c.png").display().to_string()));
        // Never a name the page could not have written.
        assert_eq!(value["flat"][1]["file"], json!("../x"));
    }

    #[test]
    fn other_answers_are_left_alone() {
        let mut value = json!({ "ms": 12, "views": "front" });
        absolute_files(&mut value, Path::new("C:\\out"));
        assert_eq!(value, json!({ "ms": 12, "views": "front" }));
    }
}
