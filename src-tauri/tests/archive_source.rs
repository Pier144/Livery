//! Skin sources: `open_source` (folders, archives until their crates are approved, anything
//! else), and `FolderSource` listing, reading and copying with progress. Temp folders and the
//! committed `fixtures/sources`.

use livery_lib::archive::source::{is_archive_name, join_rel, MAX_DEPTH, NOT_A_SOURCE, SOURCE_GONE};
use livery_lib::archive::{open_source, ExtractTick, FolderSource, SkinSource, UNSUPPORTED_ARCHIVES};
use livery_lib::error::{AppError, ErrorCode};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// Unique temp folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("livery-source-{name}-{}-{n}", std::process::id()));
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("sources").join(name)
}

fn err<T>(result: Result<T, AppError>) -> AppError {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

// ── open_source ─────────────────────────────────────────────────────────────

#[test]
fn a_folder_opens_as_a_folder_source() {
    let source = open_source(&fixture("Winter Tiger")).unwrap();
    let paths: Vec<String> = source.entries().unwrap().into_iter().map(|e| e.path).collect();
    assert!(paths.contains(&"germ_pzkpfw_VI_ausf_b_tiger_IIH.blk".to_owned()));
    assert_eq!(source.local_dir("").as_deref(), Some(fixture("Winter Tiger").as_path()));
}

#[test]
fn archives_are_unsupported_until_their_crates_are_approved() {
    let tmp = TempDir::new("archives");
    for name in ["skin.zip", "Pack.RAR", "camo.7Z", "two.dots.Zip"] {
        let path = tmp.write(name, b"PK\x03\x04 not really");
        let e = err(open_source(&path));
        assert_eq!(e.code, ErrorCode::Unsupported, "{name}");
        assert_eq!(e.message, UNSUPPORTED_ARCHIVES);
    }
    assert!(UNSUPPORTED_ARCHIVES.len() < 160, "short enough for a queue row");
}

#[test]
fn anything_else_is_not_a_source() {
    let tmp = TempDir::new("other");
    for name in ["skin.blk", "readme.txt", ".zip", "zip"] {
        let path = tmp.write(name, b"x");
        let e = err(open_source(&path));
        assert_eq!(e.code, ErrorCode::InvalidInput, "{name}");
        assert_eq!(e.message, NOT_A_SOURCE);
    }
    let e = err(open_source(Path::new("")));
    assert_eq!(e.code, ErrorCode::InvalidInput);
}

#[test]
fn a_missing_path_is_not_found() {
    let tmp = TempDir::new("missing");
    let e = err(open_source(&tmp.path().join("gone")));
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(e.message, SOURCE_GONE);
    // Even with an archive name: the file must exist first.
    assert_eq!(err(open_source(&tmp.path().join("gone.zip"))).code, ErrorCode::NotFound);
}

#[test]
fn archive_names_are_recognised_case_insensitively() {
    assert!(
        is_archive_name("a.zip") && is_archive_name("a.ZIP") && is_archive_name("a.b.7z") && is_archive_name("x.Rar")
    );
    assert!(
        !is_archive_name("zip") && !is_archive_name(".zip") && !is_archive_name("a.zipx") && !is_archive_name("a.tar")
    );
}

// ── FolderSource ────────────────────────────────────────────────────────────

#[test]
fn entries_list_parents_first_sorted_with_sizes_and_skip_livery_files() {
    let tmp = TempDir::new("entries");
    tmp.write("b.dds", b"12345");
    tmp.write("A/inner.txt", b"abc");
    tmp.write("A/Deeper/z.tga", b"zz");
    tmp.write(".livery/inactive/Old/x.blk", b"ignored");
    tmp.write(".livery-partial", b"");
    tmp.write("c/.livery-partial", b"");
    let entries = FolderSource::new(tmp.path()).entries().unwrap();
    let listed: Vec<(&str, u64, bool)> = entries.iter().map(|e| (e.path.as_str(), e.size_bytes, e.is_dir)).collect();
    assert_eq!(
        listed,
        [
            ("A", 0, true),
            ("A/Deeper", 0, true),
            ("A/Deeper/z.tga", 2, false),
            ("A/inner.txt", 3, false),
            ("b.dds", 5, false),
            ("c", 0, true),
        ]
    );
}

#[test]
fn entries_stop_at_the_depth_limit() {
    let tmp = TempDir::new("depth");
    let deep: Vec<String> = (0..MAX_DEPTH + 2).map(|n| format!("d{n}")).collect();
    tmp.write(&format!("{}/file.txt", deep.join("/")), b"x");
    let entries = FolderSource::new(tmp.path()).entries().unwrap();
    let dirs = entries.iter().filter(|e| e.is_dir).count();
    assert_eq!(dirs, MAX_DEPTH, "folders deeper than the limit are left out (as in the library scan)");
    assert!(entries.iter().all(|e| !e.path.ends_with("file.txt")));
}

#[test]
fn read_stops_at_the_limit_and_refuses_paths_outside() {
    let tmp = TempDir::new("read");
    tmp.write("skin/a.blk", b"0123456789");
    tmp.write("secret.txt", b"outside");
    let source = FolderSource::new(tmp.path().join("skin"));
    assert_eq!(source.read("a.blk", 4).unwrap(), b"0123");
    assert_eq!(source.read("a.blk", 100).unwrap(), b"0123456789");
    for bad in ["../secret.txt", "./a.blk", "a//b", "C:/x", "..\\secret.txt"] {
        assert_eq!(err(source.read(bad, 10)).code, ErrorCode::InvalidInput, "{bad}");
    }
    assert_eq!(err(source.read("missing.blk", 10)).code, ErrorCode::NotFound);
}

#[test]
fn entry_paths_never_join_outside_their_base() {
    let base = Path::new("stage");
    assert_eq!(join_rel(base, "").unwrap(), base);
    assert_eq!(join_rel(base, "a/b.dds").unwrap(), base.join("a").join("b.dds"));
    for bad in [
        "..",
        "../x",
        "a/../../x",
        "/x",
        "a/",
        "./x",
        "C:",
        "C:/x",
        "a/C:x",
        "..\\x",
        "a\\..\\..\\x",
        "x:stream",
        "a\u{0}b",
    ] {
        assert_eq!(err(join_rel(base, bad)).code, ErrorCode::InvalidInput, "{bad:?}");
    }
}

#[test]
fn extract_copies_a_sub_folder_with_running_totals() {
    let tmp = TempDir::new("extract");
    tmp.write("src/Pack/Skin/su_27.blk", b"replace_tex{}");
    tmp.write("src/Pack/Skin/body_c.dds", &vec![7u8; 3 * 1024 * 1024 + 5]);
    tmp.write("src/Pack/Skin/extras/readme.txt", b"hello");
    tmp.write("src/Pack/Other/f_4e.blk", b"not copied");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let source = FolderSource::new(tmp.path().join("src"));
    let mut ticks = Vec::new();
    let total = source
        .extract("Pack/Skin", &dest, &mut |t| {
            ticks.push(t);
            Ok(())
        })
        .unwrap();

    let bytes = 13 + 3 * 1024 * 1024 + 5 + 5;
    assert_eq!(total, ExtractTick { files_done: 3, files_total: 3, bytes_done: bytes, bytes_total: bytes });
    assert_eq!(ticks.first().unwrap().bytes_done, 0, "starts with the totals");
    assert!(ticks.windows(2).all(|w| w[0].bytes_done <= w[1].bytes_done && w[0].files_done <= w[1].files_done));
    assert!(ticks.len() >= 6, "several ticks inside the big file, one per file: {}", ticks.len());
    assert_eq!(*ticks.last().unwrap(), total);
    assert_eq!(fs::read(dest.join("body_c.dds")).unwrap().len() as u64, 3 * 1024 * 1024 + 5);
    assert_eq!(fs::read_to_string(dest.join("extras").join("readme.txt")).unwrap(), "hello");
    assert!(!dest.join("f_4e.blk").exists() && !dest.join("Other").exists(), "only the chosen sub-folder");
}

#[test]
fn a_progress_error_stops_the_copy() {
    let tmp = TempDir::new("stop");
    tmp.write("src/a.dds", b"a");
    tmp.write("src/b.dds", b"b");
    tmp.write("src/c.dds", b"c");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let e = err(FolderSource::new(tmp.path().join("src")).extract("", &dest, &mut |t| {
        if t.files_done == 1 {
            Err(AppError::new(ErrorCode::Io, "stop here"))
        } else {
            Ok(())
        }
    }));
    assert_eq!(e.message, "stop here");
    assert!(dest.join("a.dds").exists());
    assert!(!dest.join("c.dds").exists(), "nothing copied after the stop");
}

#[test]
fn extract_of_a_missing_sub_folder_is_not_found() {
    let tmp = TempDir::new("nosub");
    tmp.write("src/a.blk", b"x");
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let e = err(FolderSource::new(tmp.path().join("src")).extract("gone", &dest, &mut |_| Ok(())));
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(FolderSource::new(tmp.path().join("src")).local_dir("gone").is_none());
}
