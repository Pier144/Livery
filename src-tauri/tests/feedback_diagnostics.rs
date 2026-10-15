//! Feedback details: the log tail is anonymised before the user sees it (and maybe attaches it).

use livery_lib::feedback::{log_tail, os_description, Anonymizer};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("feedback")
}

fn anonymizer() -> Anonymizer {
    Anonymizer::new(
        Some(Path::new(r"C:\Users\Mario.Rossi")),
        Some(Path::new(r"D:\SteamLibrary\steamapps\common\War Thunder\")),
        Some(Path::new(r"C:\Users\Mario.Rossi\AppData\Roaming\app.livery.desktop")),
        Some("Mario.Rossi"),
    )
}

#[test]
fn the_log_tail_hides_folders_and_the_user_name() {
    let lines = log_tail(&fixture_dir(), 40, &anonymizer());
    assert_eq!(lines.len(), 7, "blank lines are skipped: {lines:#?}");
    assert_eq!(lines[1], "2026-10-15T10:00:01Z DEBUG livery: app data data_dir=<data>");
    assert_eq!(
        lines[2],
        r"2026-10-15T10:00:02Z  WARN livery::archive: archive refused path=%USERPROFILE%\Downloads\My Camo Pack.zip",
        "the profile matches whatever the case"
    );
    assert_eq!(lines[3], r"2026-10-15T10:00:03Z  INFO livery::library: scanned root=<game>\UserSkins skins=12");
    assert_eq!(
        lines[4], r#"2026-10-15T10:00:04Z  WARN livery::watch: can't read folder="<path>\tiger_desert" error="denied""#,
        "other paths keep only their last part"
    );
    assert_eq!(
        lines[5],
        r"2026-10-15T10:00:05Z ERROR livery::library: rename failed for <user>_tiger (owner <user>, share <path>\camo.zip)"
    );
    assert!(lines[6].ends_with("user=Mario.Rossiano"), "a longer name isn't the user's: {}", lines[6]);
    let all = lines.join("\n");
    assert!(!all.contains(r"Users\Mario") && !all.contains("SteamLibrary") && !all.contains(r"E:\"), "{all}");
}

#[test]
fn the_tail_is_the_last_lines_and_reaches_into_the_previous_session() {
    let dir = std::env::temp_dir().join(format!("livery-feedback-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("livery.log.1"), "old 1\nold 2\nold 3\n").unwrap();
    fs::write(dir.join("livery.log"), "new 1\nnew 2\n").unwrap();
    let none = Anonymizer::default();
    assert_eq!(log_tail(&dir, 3, &none), ["old 3", "new 1", "new 2"]);
    assert_eq!(log_tail(&dir, 1, &none), ["new 2"]);
    let long = "x".repeat(500);
    fs::write(dir.join("livery.log"), format!("{long}\n")).unwrap();
    let cut = log_tail(&dir, 1, &none);
    assert_eq!(cut[0].chars().count(), 301, "cut at 300 characters plus an ellipsis");
    fs::remove_dir_all(&dir).unwrap();
    assert!(log_tail(&dir, 5, &none).is_empty(), "no log, no lines");
}

#[test]
fn the_os_is_described() {
    let os = os_description();
    println!("{os}");
    #[cfg(windows)]
    assert!(os.starts_with("Windows 1") && os.contains("build "), "{os}");
}
