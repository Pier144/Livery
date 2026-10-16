//! Livery backend. One module per domain; commands return `Result<T, AppError>` and long
//! operations emit events.
//!
//! Commands that touch the disk are `async` and do their work on a blocking thread
//! (`tauri::async_runtime::spawn_blocking`) so the UI thread never waits on I/O.

pub mod archive;
pub mod atelier;
pub mod backup;
pub mod error;
pub mod feedback;
pub mod game;
pub mod library;
pub mod logging;
pub mod model;
pub mod settings;
pub mod startup;
pub mod textures;
pub mod update;
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
    let builder = tauri::Builder::default()
        .manage(clock)
        .plugin(tauri_plugin_dialog::init())
        // Links in the default browser and folders in the file manager. The capability allows only
        // WT Live and Livery's own repository (src-tauri/capabilities/default.json).
        .plugin(tauri_plugin_opener::init())
        // Livery's own updates: the signed feed and public key are in tauri.conf.json (`plugins.updater`).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::UpdateState::default());
    // Start with Windows. The plugin crate is desktop-only, and Livery registers the app with **no
    // launch arguments**, so a Livery started by Windows opens exactly like one started by hand.
    #[cfg(desktop)]
    let builder =
        builder.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None));
    builder
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
            app.manage(feedback::DataDir(data_dir.clone()));
            let settings = settings::SettingsStore::load(data_dir.join("settings.json"));
            // One library index per game folder; the saved folder's is loaded now, which also
            // migrates a library.json from before per-folder indexes to it.
            let libraries = library::Libraries::new(&data_dir);
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
            app.manage(wtlive::WtLive::load(&data_dir, enabled));
            // Atelier: the game-resource index cache (and, later, projects) under <data>/atelier.
            app.manage(atelier::AtelierState::new(&data_dir.join(atelier::ATELIER_DIR)));
            // Expired and ephemeral backups go away at launch, not only on the first library command.
            backup::purge_on_startup(app.handle());
            // Stale install staging (.livery/partial) from a crash or a closed window goes too.
            archive::purge_on_startup(app.handle());
            // WT Live cache older than a day, and Try in game installs left by the last session.
            wtlive::purge_on_startup(app.handle());
            // The game's vehicle list (cached in vehicles.json; read from the game when it changed).
            game::load_vehicles_in_background(app.handle());
            watch::start(app.handle());
            // Settings → Updates → Install updates automatically (release builds only).
            update::start(app.handle());
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "Livery started");
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
        ])
        .build(tauri::generate_context!())
        .expect("error while running Livery")
        .run(|app, event| {
            // A version downloaded in the background installs as Livery closes.
            if let tauri::RunEvent::Exit = event {
                update::install_on_exit(app);
            }
        });
}
