// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The same executable doubles as the Oodle worker (Atelier decodes the game's packs in a
    // child process, see `game::gameres::codec`). Nothing else may run first: no logging, no Tauri.
    if std::env::args().nth(1).as_deref() == Some(livery_lib::game::gameres::codec::OODLE_WORKER_ARG) {
        livery_lib::game::gameres::codec::worker_main();
        return;
    }
    livery_lib::run()
}
