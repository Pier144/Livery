//! Locating and reading the profile: `%VAR%` expansion, the Documents folder, `lastUid` and the
//! `last` fallback, and `read_lineups` on the committed `fixtures/profile` files (a full profile,
//! one without lineups, files cut mid-write). Errors never carry the file's content.

use livery_lib::error::ErrorCode;
use livery_lib::game::profile::{
    documents_dir, expand_env, profile_file, read_lineups, LINEUPS_UNPARSABLE, LINEUPS_UNREADABLE,
};
use livery_lib::library::time::parse_rfc3339;
use livery_lib::model::{LineupsStatus, Nation};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-profile-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("profile").join(name)
}

fn fake_env(name: &str) -> Option<OsString> {
    match name {
        "USERPROFILE" => Some(OsString::from(r"C:\Users\x")),
        "ONEDRIVE" => Some(OsString::from(r"C:\Users\x\OneDrive")),
        _ => None,
    }
}

fn no_env(_: &str) -> Option<OsString> {
    None
}

const SAVES: &str = "My Games/WarThunder/Saves";

// ── Locating the file ───────────────────────────────────────────────────────

#[test]
fn expands_environment_variables() {
    assert_eq!(expand_env(r"%USERPROFILE%\OneDrive\Documenti", &fake_env), r"C:\Users\x\OneDrive\Documenti");
    assert_eq!(expand_env(r"%ONEDRIVE%\Docs\%USERPROFILE%", &fake_env), r"C:\Users\x\OneDrive\Docs\C:\Users\x");
    assert_eq!(expand_env(r"%NOPE%\Docs", &fake_env), r"%NOPE%\Docs", "unknown variables are kept as written");
    assert_eq!(expand_env(r"D:\100%\Docs", &fake_env), r"D:\100%\Docs", "a lone % is kept");
    assert_eq!(expand_env(r"D:\%%\Docs", &fake_env), r"D:\%%\Docs");
    assert_eq!(expand_env(r"D:\Docs", &fake_env), r"D:\Docs");
}

#[test]
fn documents_come_from_the_registry_value_then_the_user_profile() {
    assert_eq!(documents_dir(Some(r"%USERPROFILE%\Docs"), &fake_env), Some(PathBuf::from(r"C:\Users\x\Docs")));
    assert_eq!(documents_dir(Some(r"D:\Documenti"), &fake_env), Some(PathBuf::from(r"D:\Documenti")));
    assert_eq!(documents_dir(None, &fake_env), Some(PathBuf::from(r"C:\Users\x").join("Documents")));
    assert_eq!(documents_dir(Some("  "), &fake_env), Some(PathBuf::from(r"C:\Users\x").join("Documents")));
    assert_eq!(documents_dir(None, &no_env), None);
}

#[test]
fn the_profile_of_the_last_account_comes_first() {
    let docs = TempDir::new("uid");
    docs.write(&format!("{SAVES}/last/lastUid"), b"123\r\n");
    let own = docs.write(&format!("{SAVES}/123/production/global.blk"), b"a:i=1");
    docs.write(&format!("{SAVES}/last/production/global.blk"), b"a:i=2");
    assert_eq!(profile_file(docs.path()), Some(own));
}

#[test]
fn the_last_copy_is_the_fallback() {
    let docs = TempDir::new("last");
    docs.write(&format!("{SAVES}/last/lastUid"), b"123");
    let last = docs.write(&format!("{SAVES}/last/production/global.blk"), b"a:i=2");
    assert_eq!(profile_file(docs.path()), Some(last.clone()), "the uid folder is missing");

    docs.write(&format!("{SAVES}/last/lastUid"), b"../x");
    docs.write(&format!("{SAVES}/x/production/global.blk"), b"a:i=3");
    assert_eq!(profile_file(docs.path()), Some(last.clone()), "a uid that isn't digits is ignored");

    fs::remove_file(docs.path().join(SAVES).join("last").join("lastUid")).unwrap();
    assert_eq!(profile_file(docs.path()), Some(last), "no lastUid at all");
}

#[test]
fn no_profile_is_none() {
    let docs = TempDir::new("none");
    assert_eq!(profile_file(docs.path()), None);
    docs.write(&format!("{SAVES}/last/lastUid"), b"123");
    fs::create_dir_all(docs.path().join(SAVES).join("123").join("production").join("global.blk")).unwrap();
    assert_eq!(profile_file(docs.path()), None, "a folder called global.blk is not the file");
}

// ── Reading it ──────────────────────────────────────────────────────────────

#[test]
fn reads_the_lineups_of_a_profile() {
    let lineups = read_lineups(&fixture("global.blk")).unwrap();
    assert_eq!(lineups.status, LineupsStatus::Ok);
    assert!(lineups.saved_at.as_deref().and_then(parse_rfc3339).is_some(), "{:?}", lineups.saved_at);
    assert_eq!(lineups.current.as_deref(), Some("us_m4_t26"));
    assert_eq!(lineups.current_nation, Some(Nation::Usa));
    let nations: Vec<Nation> = lineups.nations.iter().map(|n| n.nation).collect();
    assert_eq!(nations, [Nation::Usa, Nation::Ussr, Nation::Gbr]);

    let usa = &lineups.nations[0].presets;
    assert_eq!(usa.len(), 3);
    assert!(usa[1].active && !usa[0].active && !usa[2].active);
    assert_eq!(usa[1].name, "Preselezione #2");
    assert_eq!(usa[1].vehicles, ["us_m4_t26", "us_m18_hellcat", "us_m4a3e2_sherman_jumbo", "us_t1e1_90"]);
    let gbr = &lineups.nations[2].presets;
    assert_eq!(gbr[1].name, "Heavy | slow");
    assert!(gbr[0].active);
}

#[test]
fn a_profile_without_lineups_is_no_lineups() {
    let lineups = read_lineups(&fixture("global_no_presets.blk")).unwrap();
    assert_eq!(lineups.status, LineupsStatus::NoLineups);
    assert!(lineups.nations.is_empty());
    assert_eq!(lineups.current, None, "nothing else is reported without lineups");
}

#[test]
fn lineups_without_a_usable_preset_are_no_lineups() {
    let dir = TempDir::new("empty");
    let path = dir.write("global.blk", b"content{ slotbar_presets{ country_usa{ preset:t=\"0|1||Empty|m|\" } } }");
    assert_eq!(read_lineups(&path).unwrap().status, LineupsStatus::NoLineups);
}

#[test]
fn a_file_cut_inside_the_lineups_is_unparsable_without_its_content_in_the_error() {
    let e = read_lineups(&fixture("global_torn.blk")).unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse);
    assert_eq!(e.message, LINEUPS_UNPARSABLE);
    let detail = e.detail.unwrap_or_default();
    assert!(detail.contains("global_torn.blk"), "the path: {detail}");
    for text in ["us_m4_t26", "Preselezione", "slotbar_presets", "line "] {
        assert!(!detail.contains(text), "no file content in the detail: {detail}");
    }
}

#[test]
fn lineups_that_dont_parse_are_unparsable_without_their_content_in_the_error() {
    let dir = TempDir::new("bad");
    let path = dir.write("global.blk", b"slotbar_presets{ country_usa{ preset:i=secret_text } }");
    let e = read_lineups(&path).unwrap_err();
    assert_eq!(e.code, ErrorCode::Parse);
    assert_eq!(e.message, LINEUPS_UNPARSABLE);
    assert!(!e.detail.unwrap_or_default().contains("secret_text"));
}

#[test]
fn lineups_over_the_cap_are_unparsable() {
    let dir = TempDir::new("big");
    let preset = "preset:t=\"0|1|us_m4_t26|N|m|\"\n".repeat(3000);
    let path = dir.write("global.blk", format!("slotbar_presets{{ country_usa{{ {preset} }} }}").as_bytes());
    assert_eq!(read_lineups(&path).unwrap_err().message, LINEUPS_UNPARSABLE);
}

#[test]
fn a_missing_file_is_unreadable() {
    let dir = TempDir::new("missing");
    let e = read_lineups(&dir.path().join("global.blk")).unwrap_err();
    assert_eq!(e.code, ErrorCode::Io);
    assert_eq!(e.message, LINEUPS_UNREADABLE);
}

#[test]
fn a_selected_air_cut_mid_write_is_left_out() {
    let lineups = read_lineups(&fixture("global_torn_selected_air.blk")).unwrap();
    assert_eq!(lineups.status, LineupsStatus::Ok);
    assert_eq!((lineups.current, lineups.current_nation), (None, None));
    assert_eq!(lineups.nations.len(), 3);
}
