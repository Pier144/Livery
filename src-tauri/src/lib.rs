//! Livery backend. One module per domain; commands return `Result<T, AppError>` and long
//! operations emit events.
//!
//! Commands that touch the disk are `async` and do their work on a blocking thread
//! (`tauri::async_runtime::spawn_blocking`) so the UI thread never waits on I/O.

pub mod archive;
pub mod atelier;
pub mod backup;
pub mod cli;
pub mod error;
pub mod feedback;
pub mod game;
pub mod library;
pub mod lock;
pub mod logging;
pub mod model;
pub mod settings;
pub mod startup;
pub mod textures;
pub mod update;
pub mod watch;
pub mod wtlive;

pub use error::{AppError, AppResult, ErrorCode};

/// Keeps the data folder lock for as long as the process runs (see [`lock`]).
struct AppLock {
    _held: lock::DataLock,
}

/// Runs disk work off the async runtime so the UI thread never waits on I/O.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::new(ErrorCode::Internal, "Background task failed").with_detail(e.to_string()))?
}

use std::path::Path;
use tauri::Manager;

/// How the process runs: the app, or (debug builds) the agent CLI with its command.
pub(crate) enum Mode {
    App(startup::StartupClock),
    #[cfg(debug_assertions)]
    Cli(cli::runtime::CliState),
}

/// The one expansion of `generate_context!` (it embeds the frontend): both modes call this, so
/// the assets are in the binary once.
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First thing: `app_ready` measures the first screen from here.
    let clock = startup::StartupClock::new();
    // stdout (debug builds) now; the log file joins once the app data dir is known.
    logging::init();
    build_app(context(), Mode::App(clock)).run(|app, event| {
        // A version downloaded in the background installs as Livery closes.
        if let tauri::RunEvent::Exit = event {
            update::install_on_exit(app);
        }
    });
}

/// The agent CLI's Tauri run (see [`cli::runtime`]): no configured window. The answer and its
/// exit code stay in `state`'s shared slot, which `cli::runtime::main` reads after this returns.
#[cfg(debug_assertions)]
pub fn run_cli(state: cli::runtime::CliState) -> i32 {
    // Logs on stderr: stdout is the JSON answer.
    logging::init_cli();
    let mut ctx = context();
    ctx.config_mut().app.windows.clear();
    // `finish` stores the answer (with its exit code) and calls `app.exit`, which ends this loop.
    // The code returned here is not used: the stored answer carries it.
    build_app(ctx, Mode::Cli(state)).run_return(|_, _| {})
}

/// The data dir (`LIVERY_DATA_DIR` or the platform default) with the log file attached.
fn open_data_dir(app: &tauri::App) -> AppResult<startup::DataDir> {
    let data_dir = startup::resolve_data_dir(std::env::var_os(startup::DATA_DIR_ENV), || {
        app.path().app_data_dir().map_err(|e| {
            AppError::new(ErrorCode::Internal, "The app data folder can't be found").with_detail(e.to_string())
        })
    })?;
    if let Err(e) = logging::attach(&data_dir.path) {
        tracing::warn!(error = %e, "the log file can't be opened; logging to stdout only");
    }
    if data_dir.from_env {
        tracing::info!("using LIVERY_DATA_DIR");
    }
    tracing::debug!(data_dir = %data_dir.path.display(), "app data");
    Ok(data_dir)
}

/// The managed state both modes share: settings, libraries, queue, catalog, profile, WT Live,
/// Atelier and background removal. Nothing here starts background work.
fn manage_state(app: &tauri::App, data_dir: &Path, data_dir_from_env: bool) {
    app.manage(feedback::DataDir(data_dir.to_path_buf()));
    let settings = settings::SettingsStore::load(data_dir.join("settings.json"));
    // One library index per game folder; the saved folder's is loaded now, which also
    // migrates a library.json from before per-folder indexes to it.
    let libraries = library::Libraries::new(data_dir);
    libraries.for_settings(&settings.get());
    app.manage(settings);
    app.manage(libraries);
    app.manage(archive::QueueStore::default());
    app.manage(game::catalog::CatalogStore::new(data_dir.join(game::catalog::CATALOG_FILE)));
    // For you: the lineups read from the player's profile, cached in memory.
    app.manage(game::profile::ProfileStore::new());
    // Settings → WT Live → Browse WT Live, read on every WT Live call.
    let handle = app.handle().clone();
    let enabled: wtlive::EnabledFn =
        std::sync::Arc::new(move || handle.state::<settings::SettingsStore>().get().wtlive_enabled);
    app.manage(wtlive::WtLive::load(data_dir, enabled));
    // Atelier: projects and the game-resource index cache under <data>/atelier.
    app.manage(atelier::AtelierState::new(&data_dir.join(atelier::ATELIER_DIR)));
    // Background-removal files under the local app data folder.
    app.manage(atelier::CutoutState::new(&atelier::models_dir(app.handle(), data_dir, data_dir_from_env)));
}

/// The app's setup: the lock, the shared state, the startup purges and the background work.
fn setup_app(app: &tauri::App) -> AppResult<()> {
    let data_dir = open_data_dir(app)?;
    let data_dir_from_env = data_dir.from_env;
    let data_dir = data_dir.path;
    // One writer per data folder: an agent CLI run (debug builds) holds it while it works.
    // The app starts anyway when it can't have it: a blocked launch would be worse than a
    // CLI run overlapping for a moment.
    match lock::DataLock::acquire(&data_dir) {
        Ok(held) => {
            app.manage(AppLock { _held: held });
        }
        Err(lock::LockError::Busy) => {
            tracing::warn!("the data folder is in use by another Livery process (another app window or the agent CLI); starting anyway")
        }
        Err(lock::LockError::Io(e)) => tracing::warn!(error = %e, "the data folder lock can't be taken"),
    }
    manage_state(app, &data_dir, data_dir_from_env);
    // A background-removal folder a remove marked goes now, before anything can load its runtime.
    let cutout = app.state::<atelier::CutoutState>();
    if cutout.files.purge_pending() {
        tracing::info!("background-removal files removed");
    }
    let leftovers = cutout.files.clean_leftovers();
    if leftovers > 0 {
        tracing::info!(leftovers, "unfinished background-removal downloads removed");
    }
    atelier::start_idle_ticker(app.handle());
    // Expired and ephemeral backups go away at launch, not only on the first library command.
    backup::purge_on_startup(app.handle());
    // Stale install staging (.livery/partial) from a crash or a closed window goes too.
    archive::purge_on_startup(app.handle());
    // WT Live cache older than a day, and Try in game installs left by the last session.
    wtlive::purge_on_startup(app.handle());
    // Atelier projects deleted last session (their toast closed with the app).
    atelier::purge_on_startup(app.handle());
    // The game's vehicle list (cached in vehicles.json; read from the game when it changed).
    game::load_vehicles_in_background(app.handle());
    watch::start(app.handle());
    // Settings → Updates → Install updates automatically (release builds only).
    update::start(app.handle());
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "Livery started");
    Ok(())
}

/// The agent CLI's setup: the same data dir and state, its own lock (busy = the app is open),
/// none of the app's startup purges or background work (the app does them when it next starts),
/// then the command.
#[cfg(debug_assertions)]
fn setup_cli(app: &tauri::App) -> Result<(), cli::output::CliError> {
    let data_dir = open_data_dir(app)?;
    let held = lock::DataLock::acquire(&data_dir.path).map_err(cli::runtime::lock_error)?;
    app.manage(AppLock { _held: held });
    manage_state(app, &data_dir.path, data_dir.from_env);
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "Livery agent CLI started");
    cli::runtime::start(app.handle());
    Ok(())
}

/// The builder both modes share: plugins, managed state and commands. The app adds the updater
/// and Start with Windows; the CLI leaves them out.
fn build_app(context: tauri::Context<tauri::Wry>, mode: Mode) -> tauri::App {
    let app_mode = matches!(mode, Mode::App(_));
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Links in the default browser and folders in the file manager. The capability allows only
        // WT Live and Livery's own repository (src-tauri/capabilities/default.json).
        .plugin(tauri_plugin_opener::init())
        .manage(update::UpdateState::default());
    let builder = if app_mode {
        // Livery's own updates: the signed feed and public key are in tauri.conf.json (`plugins.updater`).
        let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        // Start with Windows. The plugin crate is desktop-only, and Livery registers the app with **no
        // launch arguments**, so a Livery started by Windows opens exactly like one started by hand.
        #[cfg(desktop)]
        let builder =
            builder.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None));
        builder
    } else {
        builder
    };
    builder
        .setup(move |app| {
            match mode {
                Mode::App(clock) => {
                    app.manage(clock);
                    setup_app(app)?;
                }
                #[cfg(debug_assertions)]
                Mode::Cli(state) => {
                    // First: every way out of the setup below answers through it.
                    app.manage(state);
                    if let Err(e) = setup_cli(app) {
                        cli::runtime::finish(app.handle(), Err(e));
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::set_settings,
            game::detect_game,
            game::set_game_path,
            game::game_vehicles,
            game::game_vehicle_names,
            game::game_lineups,
            feedback::feedback_diagnostics,
            library::scan_user_skins,
            library::import_skins,
            library::get_hangar,
            library::set_skin_active,
            library::rename_skin,
            library::skin_preview,
            library::delete_skins,
            library::restore_backups,
            library::export_skins,
            library::collections::collections_list,
            library::collections::collections_create,
            library::collections::collections_update,
            library::collections::collections_delete,
            library::collections::collections_restore,
            library::collections::collections_set_skins,
            library::collections::activate_collection,
            backup::list_backups,
            archive::analyze_archive,
            archive::install_from_archive,
            archive::list_queue,
            archive::remove_queue_item,
            archive::undo_replace,
            textures::read_textures,
            watch::watch_folder,
            wtlive::wtlive_search,
            wtlive::wtlive_post,
            wtlive::wtlive_following_new,
            wtlive::wtlive_vehicle_top,
            wtlive::wtlive_for_you_new,
            wtlive::install_from_wtlive,
            wtlive::finalize_try,
            wtlive::following_list,
            wtlive::following_set,
            wtlive::following_mark_seen,
            wtlive::for_you_seen,
            wtlive::for_you_mark_seen,
            wtlive::wtlive_storage,
            wtlive::wtlive_clear_cache,
            wtlive::wtlive_set_hidden,
            wtlive::wtlive_unhide_all,
            backup::clear_backups,
            update::check_update,
            update::install_update,
            startup::app_ready,
            atelier::atelier_model,
            atelier::atelier_template_texture,
            atelier::atelier_projects,
            atelier::atelier_project_create,
            atelier::atelier_project_get,
            atelier::atelier_project_save,
            atelier::atelier_project_duplicate,
            atelier::atelier_project_delete,
            atelier::atelier_project_undo_delete,
            atelier::atelier_project_forget_deleted,
            atelier::atelier_project_thumb,
            atelier::atelier_project_thumb_get,
            atelier::atelier_project_open,
            atelier::atelier_import_image,
            atelier::atelier_asset,
            atelier::atelier_asset_put,
            atelier::atelier_fonts,
            atelier::atelier_font_file,
            atelier::atelier_cutout_status,
            atelier::atelier_cutout_download,
            atelier::atelier_cutout_cancel,
            atelier::atelier_cutout_remove,
            atelier::atelier_cutout,
            atelier::atelier_apply_begin,
            atelier::atelier_apply_texture,
            atelier::atelier_apply_commit,
            atelier::atelier_apply_cancel,
            cli::page::cli_job,
            cli::page::cli_file,
            cli::page::cli_finish,
        ])
        .build(context)
        .expect("error while running Livery")
}

/// A fresh empty folder under the system temp dir, removed on drop (tests only: no `tempfile`
/// dependency).
#[cfg(test)]
pub(crate) mod test_dir {
    pub(crate) struct TestDir(std::path::PathBuf);

    impl TestDir {
        pub(crate) fn new(tag: &str) -> Self {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!("livery-test-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            TestDir(p)
        }

        pub(crate) fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
