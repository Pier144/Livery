//! Livery backend. One module per domain; commands return `Result<T, AppError>` and long
//! operations emit events (see design_handoff_livery/DATA_MODEL.md).
//!
//! Commands that touch the disk are `async` and do their work on a blocking thread
//! (`tauri::async_runtime::spawn_blocking`) so the UI thread never waits on I/O.

pub mod archive;
pub mod backup;
pub mod error;
pub mod game;
pub mod library;
pub mod logging;
pub mod model;
pub mod settings;
pub mod startup;
pub mod textures;
pub mod watch;
pub mod wtlive;

pub use error::{AppError, AppResult, ErrorCode};

/// Runs disk work off the async runtime so the UI thread never waits on I/O.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::new(ErrorCode::Internal, "Background task failed").with_detail(e.to_string()))?
}

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First thing: `app_ready` measures the first screen from here.
    let clock = startup::StartupClock::new();
    // stdout (debug builds) now; the log file joins once the app data dir is known.
    logging::init();
    tauri::Builder::default()
        .manage(clock)
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            let data_dir = data_dir.path;
            let settings = settings::SettingsStore::load(data_dir.join("settings.json"));
            // One library index per game folder; the saved folder's is loaded now, which also
            // migrates a library.json from before per-folder indexes to it.
            let libraries = library::Libraries::new(&data_dir);
            libraries.for_settings(&settings.get());
            app.manage(settings);
            app.manage(libraries);
            app.manage(archive::QueueStore::default());
            app.manage(wtlive::WtLive::load(&data_dir));
            // Expired and ephemeral backups go away at launch, not only on the first library command.
            backup::purge_on_startup(app.handle());
            // Stale install staging (.livery/partial) from a crash or a closed window goes too.
            archive::purge_on_startup(app.handle());
            watch::start(app.handle());
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "Livery started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::set_settings,
            game::detect_game,
            game::set_game_path,
            library::scan_user_skins,
            library::import_skins,
            library::get_hangar,
            library::set_skin_active,
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
            wtlive::install_from_wtlive,
            wtlive::finalize_try,
            wtlive::following_list,
            wtlive::following_set,
            wtlive::following_mark_seen,
            backup::clear_backups,
            startup::app_ready,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Livery");
}
