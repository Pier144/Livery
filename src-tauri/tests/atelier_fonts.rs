//! Atelier's font list: registry names parsed into family and style, files resolved against the
//! fonts folder (bare names) or taken as local absolute paths (per-user installs), `.ttc` and odd
//! paths left out, and font bytes served only for a listed family and style. Temp folders and
//! fake font files only; one smoke test reads this PC's registry.

use livery_lib::atelier::fonts::{
    entries_from, entries_from_fc_list, font_bytes, parse_registry_name, system_fonts, FONT_NOT_FOUND,
};
use livery_lib::error::ErrorCode;
use std::fs;
use std::path::{Path, PathBuf};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("livery-fonts-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn parsed(name: &str) -> Option<(String, String)> {
    parse_registry_name(name)
}

fn pair(family: &str, style: &str) -> Option<(String, String)> {
    Some((family.to_owned(), style.to_owned()))
}

#[test]
fn registry_names_parse_into_family_and_style() {
    assert_eq!(parsed("Arial (TrueType)"), pair("Arial", "Regular"));
    assert_eq!(parsed("Arial Bold Italic (TrueType)"), pair("Arial", "Bold Italic"));
    assert_eq!(parsed("Segoe UI Semibold Italic (TrueType)"), pair("Segoe UI", "Semibold Italic"));
    assert_eq!(parsed("Bahnschrift Light (OpenType)"), pair("Bahnschrift", "Light"));
    assert_eq!(parsed("Arial Narrow (TrueType)"), pair("Arial Narrow", "Regular"));
    assert_eq!(parsed("Source Sans Pro Extra Light"), pair("Source Sans Pro", "Extra Light"));
    assert_eq!(parsed("  Consolas   Bold  (TrueType) "), pair("Consolas", "Bold"));
    // A one-word name that is a style word stays a family.
    assert_eq!(parsed("Black (TrueType)"), pair("Black", "Regular"));
    assert_eq!(parsed("Cambria & Cambria Math (TrueType)"), None);
    assert_eq!(parsed(" (TrueType)"), None);
    assert_eq!(parsed(""), None);
}

#[test]
fn entries_resolve_files_and_skip_collections_and_odd_paths() {
    let dir = temp("entries");
    let fonts = dir.join("Fonts");
    let user = dir.join("UserFonts");
    fs::create_dir_all(&fonts).unwrap();
    fs::create_dir_all(&user).unwrap();
    for name in ["arial.ttf", "arialbd.TTF", "cambria.ttc", "font.fon", "bahn.otf"] {
        fs::write(fonts.join(name), b"font").unwrap();
    }
    fs::write(user.join("mine.otf"), b"mine").unwrap();
    let mine = user.join("mine.otf").to_string_lossy().into_owned();
    let values = [
        ("Arial (TrueType)", "arial.ttf"),
        ("Arial Bold (TrueType)", "arialbd.TTF"),
        ("Cambria (TrueType)", "cambria.ttc"),
        ("Modern (All res)", "font.fon"),
        ("Gone (TrueType)", "gone.ttf"),
        ("Sneaky (TrueType)", r"..\Fonts\arial.ttf"),
        ("Remote (TrueType)", r"\\server\share\remote.ttf"),
        ("Mine Italic (OpenType)", mine.as_str()),
        ("Bahnschrift (OpenType)", "bahn.otf"),
        // The same family and style twice: the first wins.
        ("Arial (TrueType)", "arialbd.TTF"),
    ];
    let entries = entries_from(values.iter().map(|(n, d)| (n.to_string(), d.to_string())), &fonts);
    let listed: Vec<(&str, &str, &str)> =
        entries.iter().map(|e| (e.info.family.as_str(), e.info.style.as_str(), e.info.file.as_str())).collect();
    assert_eq!(
        listed,
        [
            ("Arial", "Regular", "arial.ttf"),
            ("Arial", "Bold", "arialbd.TTF"),
            ("Bahnschrift", "Regular", "bahn.otf"),
            ("Mine", "Italic", "mine.otf"),
        ]
    );
    assert_eq!(entries[0].path, fonts.join("arial.ttf"));
    assert_eq!(entries[3].path, Path::new(&mine));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn font_bytes_are_served_only_for_a_listed_family_and_style() {
    let dir = temp("bytes");
    fs::write(dir.join("arial.ttf"), b"arial bytes").unwrap();
    fs::write(dir.join("secret.ttf"), b"secret").unwrap();
    let entries = entries_from([("Arial (TrueType)".to_owned(), "arial.ttf".to_owned())], &dir);
    assert_eq!(font_bytes(&entries, "arial", "REGULAR").unwrap(), b"arial bytes");

    let secret = dir.join("secret.ttf").to_string_lossy().into_owned();
    for (family, style) in
        [("Arial", "Bold"), ("Secret", "Regular"), (secret.as_str(), "Regular"), ("secret.ttf", ""), ("", "")]
    {
        let e = font_bytes(&entries, family, style).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, FONT_NOT_FOUND), "{family:?} {style:?}");
    }

    // Listed, but the file went away since.
    fs::remove_file(dir.join("arial.ttf")).unwrap();
    let e = font_bytes(&entries, "Arial", "Regular").unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, FONT_NOT_FOUND));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn this_pc_lists_its_fonts() {
    let fonts = system_fonts();
    if cfg!(windows) {
        assert!(!fonts.is_empty(), "no font found in the registry");
        assert!(fonts.iter().all(|f| {
            let ext = f.info.file.to_ascii_lowercase();
            (ext.ends_with(".ttf") || ext.ends_with(".otf")) && !f.info.file.contains(['\\', '/'])
        }));
    } else {
        // Whatever fontconfig lists (maybe nothing on a bare machine): only usable files.
        assert!(fonts.iter().all(|f| {
            let ext = f.info.file.to_ascii_lowercase();
            (ext.ends_with(".ttf") || ext.ends_with(".otf")) && f.path.is_absolute()
        }));
    }
}

#[test]
fn fc_list_lines_become_entries() {
    let dir = temp("fclist");
    for file in ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "Noto.otf", "Cjk.ttc", "Old.pfb"] {
        fs::write(dir.join(file), b"font").unwrap();
    }
    let line = |file: &str, family: &str, style: &str| format!("{}\t{family}\t{style}\n", dir.join(file).display());
    let text = [
        line("DejaVuSans-Bold.ttf", "DejaVu Sans", "Bold"),
        line("DejaVuSans.ttf", "DejaVu Sans", "Book"),
        line("Noto.otf", "Noto Sans", "Regular"),
        line("Noto.otf", "noto sans", "regular"),
        line("Cjk.ttc", "Noto Sans CJK", "Regular"),
        line("Old.pfb", "Old", "Regular"),
        line("Gone.ttf", "Gone", "Regular"),
        line("DejaVuSans.ttf", "", "Regular"),
        "relative.ttf\tRelative\tRegular\n".to_owned(),
        "no tabs at all\n".to_owned(),
    ]
    .concat();
    let got: Vec<(String, String, String)> =
        entries_from_fc_list(&text).into_iter().map(|e| (e.info.family, e.info.style, e.info.file)).collect();
    let want = [
        ("DejaVu Sans", "Bold", "DejaVuSans-Bold.ttf"),
        ("DejaVu Sans", "Book", "DejaVuSans.ttf"),
        ("Noto Sans", "Regular", "Noto.otf"),
    ]
    .map(|(a, b, c)| (a.to_owned(), b.to_owned(), c.to_owned()));
    assert_eq!(got, want, "collections, Type 1, missing files, blank names and relative paths are left out");
    let _ = fs::remove_dir_all(&dir);
}
