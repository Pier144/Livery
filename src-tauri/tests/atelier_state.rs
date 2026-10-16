//! Atelier's gate on Settings → Game → Read data from the game, and its state on a folder that
//! isn't a game (temp folders only; the real install is read by `atelier_real.rs`).

use livery_lib::atelier::{
    atelier_game_root, require_enabled, AtelierState, ATELIER_DISABLED, ATELIER_NEEDS_GAME_DATA, INDEX_CACHE,
};
use livery_lib::error::ErrorCode;
use livery_lib::library::NO_GAME_FOLDER;
use livery_lib::model::Settings;
use std::fs;
use std::path::PathBuf;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("livery-atelier-state-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn atelier_needs_the_game_data_switch_and_a_game_folder() {
    let dir = temp("gate");
    let on =
        Settings { game_path: Some(dir.to_string_lossy().into_owned()), atelier_enabled: true, ..Settings::default() };
    assert_eq!(atelier_game_root(&on).unwrap(), dir);

    // Atelier itself off: every command that reads the game refuses first.
    let disabled = Settings { atelier_enabled: false, ..on.clone() };
    let e = atelier_game_root(&disabled).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, ATELIER_DISABLED));
    let e = require_enabled(&disabled).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, ATELIER_DISABLED));
    assert!(require_enabled(&on).is_ok());

    let off = Settings { read_game_data: false, ..on.clone() };
    let e = atelier_game_root(&off).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, ATELIER_NEEDS_GAME_DATA));

    let no_folder = Settings { atelier_enabled: true, ..Settings::default() };
    let e = atelier_game_root(&no_folder).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidInput, NO_GAME_FOLDER));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_folder_without_the_games_packs_has_no_model_and_writes_nothing() {
    let dir = temp("empty");
    let game = dir.join("game");
    fs::create_dir_all(&game).unwrap();
    let data = dir.join("data").join("atelier");
    let state = AtelierState::new(&data);
    let e = state.model(&game, "us_m4a3e2_sherman_jumbo").unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound, "{e}");
    assert!(state.template(&game, "us_m4a3e2_sherman_jumbo", "x_body_c").is_err());
    assert!(!data.join(INDEX_CACHE).exists());
    assert_eq!(fs::read_dir(&game).unwrap().count(), 0, "the game folder is only read");
    let _ = fs::remove_dir_all(&dir);
}
