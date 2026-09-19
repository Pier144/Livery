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
pub mod model;
pub mod settings;
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

fn init_tracing() {
    let level = if cfg!(debug_assertions) { tracing::Level::DEBUG } else { tracing::Level::INFO };
    // `try_init` so a second initialisation (tests, hot restarts) is harmless.
    let _ = tracing_subscriber::fmt().with_max_level(level).with_target(false).try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(settings::SettingsStore::load(data_dir.join("settings.json")));
            app.manage(library::LibraryStore::load(data_dir.join("library.json")));
            app.manage(archive::QueueStore::default());
            // Expired and ephemeral backups go away at launch, not only on the first library command.
            backup::purge_on_startup(app.handle());
            // Stale install staging (.livery/partial) from a crash or a closed window goes too.
            archive::purge_on_startup(app.handle());
            watch::start(app.handle());
            tracing::info!(data_dir = %data_dir.display(), version = env!("CARGO_PKG_VERSION"), "Livery started");
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
            backup::clear_backups,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Livery");
}
