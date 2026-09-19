//! Livery backend. One module per domain; commands return `Result<T, AppError>` and long
//! operations emit events (see design_handoff_livery/DATA_MODEL.md).

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
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(settings::SettingsStore::load(data_dir.join("settings.json")));
            tracing::info!(data_dir = %data_dir.display(), version = env!("CARGO_PKG_VERSION"), "Livery started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![settings::get_settings, settings::set_settings])
        .run(tauri::generate_context!())
        .expect("error while running Livery");
}
