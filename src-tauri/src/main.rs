// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The same executable doubles as the Oodle worker (Atelier decodes the game's packs in a
    // child process, see `game::gameres::codec`). Nothing else may run first: no logging, no Tauri.
    // `args_os`: `args` panics on an argument that isn't Unicode.
    if std::env::args_os().nth(1).is_some_and(|arg| arg == livery_lib::game::gameres::codec::OODLE_WORKER_ARG) {
        livery_lib::game::gameres::codec::worker_main();
        return;
    }
    // Still single-threaded here: the only safe moment to change the environment.
    livery_lib::startup::webview_data_into_data_dir();
    livery_lib::run()
}
