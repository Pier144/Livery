//! Settings files written by other versions must keep loading.

use livery_lib::model::{ConflictPolicy, GameSource, Language, Settings};
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("settings").join(name)
}

#[test]
fn partial_file_fills_defaults_and_ignores_unknown_fields() {
    let text = std::fs::read_to_string(fixture("partial.json")).unwrap();
    let s: Settings = serde_json::from_str(&text).unwrap();
    assert_eq!(s.game_source, Some(GameSource::Steam));
    assert_eq!(s.language, Language::It);
    assert_eq!(s.conflict_policy, ConflictPolicy::Ask);
    assert!(s.backups);
    assert_eq!(s.backup_days, 30);
}

#[test]
fn serializes_camel_case_without_empty_optionals() {
    let json = serde_json::to_value(Settings::default()).unwrap();
    let obj = json.as_object().unwrap();
    assert!(obj.contains_key("conflictPolicy"));
    assert!(obj.contains_key("startWithWindows"));
    assert!(!obj.contains_key("gamePath"));
    assert_eq!(json["language"], "en");
}

#[test]
fn language_codes_match_the_ui() {
    let codes: Vec<String> =
        Language::ALL.iter().map(|l| serde_json::to_value(l).unwrap().as_str().unwrap().to_owned()).collect();
    assert_eq!(codes, ["en", "it", "de", "ru", "fr", "es", "pl", "pt-BR", "zh-CN"]);
    for code in &codes {
        let s: Settings = serde_json::from_str(&format!(r#"{{ "language": "{code}" }}"#)).unwrap();
        assert_eq!(&serde_json::to_value(s.language).unwrap(), code);
    }
    // A code this version doesn't know (a newer Livery's) reads as English; the rest of the file stays.
    let newer: Settings = serde_json::from_str(r#"{ "language": "ja", "backups": false }"#).unwrap();
    assert_eq!((newer.language, newer.backups), (Language::En, false));
}

#[test]
fn atelier_is_on_by_default_and_old_files_migrate_to_on_once() {
    assert!(Settings::default().atelier_enabled);
    assert_eq!(serde_json::to_value(Settings::default()).unwrap()["atelierEnabled"], true);
    assert_eq!(Settings::default().settings_version, livery_lib::model::SETTINGS_VERSION);
    // A file from before the switch existed reads with it on.
    let text = std::fs::read_to_string(fixture("partial.json")).unwrap();
    let old_file: Settings = serde_json::from_str(&text).unwrap();
    assert!(old_file.atelier_enabled);
    // 0.4.0 wrote its old default (off) and no settings version: the migration turns it on, once.
    let mut from_0_4: Settings = serde_json::from_str(r#"{ "atelierEnabled": false }"#).unwrap();
    assert_eq!(from_0_4.settings_version, 0);
    assert!(from_0_4.migrate());
    assert!(from_0_4.atelier_enabled);
    assert!(!from_0_4.migrate(), "the migration runs once");
    // Turned off after it: it stays off.
    let mut chosen: Settings = serde_json::from_str(r#"{ "atelierEnabled": false, "settingsVersion": 1 }"#).unwrap();
    assert!(!chosen.migrate());
    assert!(!chosen.atelier_enabled);
    let mut settings = Settings::default();
    settings.apply(serde_json::from_str(r#"{ "atelierEnabled": false }"#).unwrap());
    assert!(!settings.atelier_enabled);
    settings.apply(serde_json::from_str(r#"{ "language": "en" }"#).unwrap());
    assert!(!settings.atelier_enabled, "a patch without it leaves it");
}
