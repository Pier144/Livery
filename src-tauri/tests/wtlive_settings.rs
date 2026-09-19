//! M5 settings contract (DESIGN_NOTES "M5 · Foundation contracts"): Settings → General →
//! Reduce motion is `reduceMotion` (`system` / `on` / `off`, default `system`).

use livery_lib::model::{ReduceMotion, Settings, SettingsPatch};
use livery_lib::settings::SettingsStore;
use std::fs;

#[test]
fn reduce_motion_defaults_to_system() {
    assert_eq!(Settings::default().reduce_motion, ReduceMotion::System);
    assert_eq!(serde_json::to_value(Settings::default()).unwrap()["reduceMotion"], "system");
    let old_file: Settings = serde_json::from_str(r#"{ "language": "it" }"#).unwrap();
    assert_eq!(old_file.reduce_motion, ReduceMotion::System, "files from before M5 load with the default");
}

#[test]
fn reduce_motion_round_trips_through_a_patch() {
    let patch: SettingsPatch = serde_json::from_str(r#"{ "reduceMotion": "on" }"#).unwrap();
    assert_eq!(patch.reduce_motion, Some(ReduceMotion::On));
    let mut settings = Settings::default();
    settings.apply(patch);
    assert_eq!(settings.reduce_motion, ReduceMotion::On);
    let json = serde_json::to_value(&settings).unwrap();
    assert_eq!(json["reduceMotion"], "on");
    assert_eq!(serde_json::from_value::<Settings>(json).unwrap(), settings);

    let untouched: SettingsPatch = serde_json::from_str(r#"{ "language": "en" }"#).unwrap();
    settings.apply(untouched);
    assert_eq!(settings.reduce_motion, ReduceMotion::On, "a patch without it leaves it");
    settings.apply(serde_json::from_str(r#"{ "reduceMotion": "off" }"#).unwrap());
    assert_eq!(settings.reduce_motion, ReduceMotion::Off);
    assert!(serde_json::from_str::<SettingsPatch>(r#"{ "reduceMotion": "sometimes" }"#).is_err());
}

#[test]
fn reduce_motion_is_saved_and_reloaded() {
    let dir = std::env::temp_dir().join(format!("livery-wtlive-settings-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let path = dir.join("settings.json");
    let store = SettingsStore::load(path.clone());
    let saved = store.update(serde_json::from_str(r#"{ "reduceMotion": "on" }"#).unwrap()).unwrap();
    assert_eq!(saved.reduce_motion, ReduceMotion::On);
    assert_eq!(SettingsStore::load(path).get().reduce_motion, ReduceMotion::On);
    let _ = fs::remove_dir_all(&dir);
}
