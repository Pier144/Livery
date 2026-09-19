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
