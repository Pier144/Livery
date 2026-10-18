//! The background-removal files: the pinned table, the runtime's library extracted alone from a
//! verified zip (Windows) or tarball (Linux), the whole install against a local server, status,
//! remove with a pending marker and the launch purge. Synthetic archives and "models" only;
//! nothing is downloaded from the network.

mod common;

use common::http::{Route, Server};
use livery_lib::atelier::download::{Downloader, MODEL_DOWNLOAD_CORRUPT};
use livery_lib::atelier::models::{
    extract_runtime, pinned, ArchiveFormat, FileHash, ModelFiles, Pin, Pins, DLL_FILE, MODEL_FILE, REMOVE_MARKER,
    RUNTIME_ARCHIVE_FILE,
};
use livery_lib::atelier::sha256::{digest, hex};
use livery_lib::error::ErrorCode;
use livery_lib::model::DownloadItem;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const DLL_ENTRY: &str = "onnxruntime-win-x64-9.9.9/lib/onnxruntime.dll";
const SO_ENTRY: &str = "onnxruntime-linux-x64-9.9.9/lib/libonnxruntime.so.9.9.9";

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("livery-models-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn hash_of(bytes: &[u8]) -> FileHash {
    FileHash { size: bytes.len() as u64, sha256: hex(&digest(bytes)) }
}

/// A zip like Microsoft's: headers, the DLL, its providers DLL, a licence.
fn runtime_zip(dll: &[u8]) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut out);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in [
        ("onnxruntime-win-x64-9.9.9/include/onnxruntime_c_api.h", b"header".as_slice()),
        (DLL_ENTRY, dll),
        ("onnxruntime-win-x64-9.9.9/lib/onnxruntime_providers_shared.dll", b"providers".as_slice()),
        ("onnxruntime-win-x64-9.9.9/LICENSE", b"MIT".as_slice()),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap();
    out.into_inner()
}

/// A tarball like Microsoft's: folders, a header, the two symlinks to the real library, the
/// library, its providers library, a licence.
fn runtime_tgz(so: &[u8]) -> Vec<u8> {
    tgz(|tar| {
        dir(tar, "onnxruntime-linux-x64-9.9.9/");
        dir(tar, "onnxruntime-linux-x64-9.9.9/lib/");
        file(tar, "onnxruntime-linux-x64-9.9.9/include/onnxruntime_c_api.h", b"header");
        link(tar, tar::EntryType::Symlink, "onnxruntime-linux-x64-9.9.9/lib/libonnxruntime.so", "libonnxruntime.so.9");
        file(tar, SO_ENTRY, so);
        link(
            tar,
            tar::EntryType::Symlink,
            "onnxruntime-linux-x64-9.9.9/lib/libonnxruntime.so.9",
            "libonnxruntime.so.9.9.9",
        );
        file(tar, "onnxruntime-linux-x64-9.9.9/lib/libonnxruntime_providers_shared.so", b"providers");
        file(tar, "onnxruntime-linux-x64-9.9.9/LICENSE", b"MIT");
    })
}

fn tgz(fill: impl FnOnce(&mut tar::Builder<flate2::write::GzEncoder<Vec<u8>>>)) -> Vec<u8> {
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
    fill(&mut tar);
    tar.into_inner().unwrap().finish().unwrap()
}

fn header(kind: tar::EntryType, size: u64) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(kind);
    header.set_size(size);
    header.set_mode(0o755);
    header
}

fn dir<W: Write>(tar: &mut tar::Builder<W>, path: &str) {
    tar.append_data(&mut header(tar::EntryType::Directory, 0), path, std::io::empty()).unwrap();
}

fn file<W: Write>(tar: &mut tar::Builder<W>, path: &str, data: &[u8]) {
    tar.append_data(&mut header(tar::EntryType::Regular, data.len() as u64), path, data).unwrap();
}

fn link<W: Write>(tar: &mut tar::Builder<W>, kind: tar::EntryType, path: &str, target: &str) {
    tar.append_link(&mut header(kind, 0), path, target).unwrap();
}

fn dll_bytes() -> Vec<u8> {
    (0..300_000u32).map(|i| (i % 253) as u8).collect()
}

#[test]
fn the_pinned_table_is_complete() {
    let pins = pinned();
    for pin in [&pins.runtime_archive, &pins.model] {
        assert!(pin.url.starts_with("https://github.com/"), "{}", pin.url);
        assert_eq!(pin.hash.sha256.len(), 64);
        assert!(pin.hash.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert!(pin.hash.size > 0);
    }
    assert_eq!(pins.model.hash.sha256, "f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99");
    assert_eq!(pins.model.hash.size, 176_069_933);
    assert_eq!(pins.dll.sha256.len(), 64);
    let version = &pins.runtime_dir["ort-".len()..];
    if cfg!(windows) {
        assert_eq!(pins.runtime_format, ArchiveFormat::Zip);
        assert!(pins.dll_entry.ends_with("/lib/onnxruntime.dll"));
        assert!(pins.runtime_archive.url.ends_with(&format!("/onnxruntime-win-x64-{version}.zip")));
    } else {
        assert_eq!(pins.runtime_format, ArchiveFormat::TarGz);
        assert_eq!(pins.dll_entry, format!("onnxruntime-linux-x64-{version}/lib/{DLL_FILE}"));
        assert_eq!(DLL_FILE, format!("libonnxruntime.so.{version}"));
        assert!(pins.runtime_archive.url.ends_with(&format!("/onnxruntime-linux-x64-{version}.tgz")));
    }
}

#[test]
fn extraction_takes_only_the_dll_and_checks_it() {
    let dir = temp("extract");
    let dll = dll_bytes();
    let zip = runtime_zip(&dll);
    let zip_path = dir.join("rt.zip");
    fs::write(&zip_path, &zip).unwrap();
    let dest = dir.join("ort").join(DLL_FILE);

    let zip_format = ArchiveFormat::Zip;
    extract_runtime(&zip_path, zip_format, &hash_of(&zip), DLL_ENTRY, &hash_of(&dll), &dest).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), dll);
    let files: Vec<String> = fs::read_dir(dest.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, [DLL_FILE]);

    let fresh = dir.join("fresh").join(DLL_FILE);
    let corrupt = |e: livery_lib::error::AppError| {
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Parse, MODEL_DOWNLOAD_CORRUPT))
    };
    // The zip isn't the pinned one: nothing is extracted.
    let other_zip = hash_of(b"other zip");
    corrupt(extract_runtime(&zip_path, zip_format, &other_zip, DLL_ENTRY, &hash_of(&dll), &fresh).unwrap_err());
    // The DLL inside isn't the pinned one.
    corrupt(
        extract_runtime(&zip_path, zip_format, &hash_of(&zip), DLL_ENTRY, &hash_of(&dll[1..]), &fresh).unwrap_err(),
    );
    let mut other = dll.clone();
    other[10] ^= 1;
    corrupt(extract_runtime(&zip_path, zip_format, &hash_of(&zip), DLL_ENTRY, &hash_of(&other), &fresh).unwrap_err());
    // No such entry.
    let short = "lib/onnxruntime.dll";
    corrupt(extract_runtime(&zip_path, zip_format, &hash_of(&zip), short, &hash_of(&dll), &fresh).unwrap_err());
    // A zip read as a tarball.
    let as_tgz = ArchiveFormat::TarGz;
    corrupt(extract_runtime(&zip_path, as_tgz, &hash_of(&zip), DLL_ENTRY, &hash_of(&dll), &fresh).unwrap_err());
    assert!(!fresh.exists());
    assert!(fresh.parent().is_none_or(|p| fs::read_dir(p).map_or(true, |mut e| e.next().is_none())));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn tarball_extraction_takes_only_the_library_and_checks_it() {
    let dir = temp("extract-tgz");
    let so = dll_bytes();
    let tgz = runtime_tgz(&so);
    let tgz_path = dir.join("rt.tgz");
    fs::write(&tgz_path, &tgz).unwrap();
    let dest = dir.join("ort").join("libonnxruntime.so.9.9.9");
    let format = ArchiveFormat::TarGz;

    extract_runtime(&tgz_path, format, &hash_of(&tgz), SO_ENTRY, &hash_of(&so), &dest).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), so);
    let files: Vec<String> = fs::read_dir(dest.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, ["libonnxruntime.so.9.9.9"]);

    let fresh = dir.join("fresh").join("libonnxruntime.so.9.9.9");
    let corrupt = |e: livery_lib::error::AppError| {
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Parse, MODEL_DOWNLOAD_CORRUPT))
    };
    // The tarball isn't the pinned one: nothing is extracted.
    let other_tgz = hash_of(b"other tgz");
    corrupt(extract_runtime(&tgz_path, format, &other_tgz, SO_ENTRY, &hash_of(&so), &fresh).unwrap_err());
    // The library inside isn't the pinned one: shorter, or one byte off.
    corrupt(extract_runtime(&tgz_path, format, &hash_of(&tgz), SO_ENTRY, &hash_of(&so[1..]), &fresh).unwrap_err());
    let mut other = so.clone();
    other[10] ^= 1;
    corrupt(extract_runtime(&tgz_path, format, &hash_of(&tgz), SO_ENTRY, &hash_of(&other), &fresh).unwrap_err());
    // No such entry (paths match whole, not by suffix).
    let short = "lib/libonnxruntime.so.9.9.9";
    corrupt(extract_runtime(&tgz_path, format, &hash_of(&tgz), short, &hash_of(&so), &fresh).unwrap_err());
    // The symlinks are never followed: asking for one is refused.
    let symlink = "onnxruntime-linux-x64-9.9.9/lib/libonnxruntime.so";
    corrupt(extract_runtime(&tgz_path, format, &hash_of(&tgz), symlink, &hash_of(&so), &fresh).unwrap_err());
    // A tarball read as a zip.
    let as_zip = ArchiveFormat::Zip;
    corrupt(extract_runtime(&tgz_path, as_zip, &hash_of(&tgz), SO_ENTRY, &hash_of(&so), &fresh).unwrap_err());
    assert!(!fresh.exists());
    assert!(fresh.parent().is_none_or(|p| fs::read_dir(p).map_or(true, |mut e| e.next().is_none())));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn tarball_extraction_refuses_links_and_reads_long_names() {
    let dir = temp("extract-tgz-links");
    let so = dll_bytes();
    let format = ArchiveFormat::TarGz;
    // The pinned path is a symlink or a hard link (to a real file earlier in the tarball).
    for kind in [tar::EntryType::Symlink, tar::EntryType::Link] {
        let tgz = tgz(|tar| {
            file(tar, "elsewhere/libonnxruntime.so.9.9.9", &so);
            link(tar, kind, SO_ENTRY, "elsewhere/libonnxruntime.so.9.9.9");
        });
        let path = dir.join("links.tgz");
        fs::write(&path, &tgz).unwrap();
        let dest = dir.join("out").join("lib.so");
        let e = extract_runtime(&path, format, &hash_of(&tgz), SO_ENTRY, &hash_of(&so), &dest).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Parse, MODEL_DOWNLOAD_CORRUPT), "{kind:?}");
        assert!(!dest.exists());
    }
    // A pinned path longer than the 100 bytes of a plain tar header (GNU long name).
    let long = format!("{}/lib/libonnxruntime.so.9.9.9", "d".repeat(120));
    let tgz = tgz(|tar| file(tar, &long, &so));
    let path = dir.join("long.tgz");
    fs::write(&path, &tgz).unwrap();
    let dest = dir.join("long").join("lib.so");
    extract_runtime(&path, format, &hash_of(&tgz), &long, &hash_of(&so), &dest).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), so);
    let _ = fs::remove_dir_all(&dir);
}

struct Served {
    _server: Server,
    files: ModelFiles,
    dll: Vec<u8>,
    model: Vec<u8>,
}

/// The files served with this platform's kind of runtime archive.
fn served(dir: &Path) -> Served {
    served_as(dir, if cfg!(windows) { ArchiveFormat::Zip } else { ArchiveFormat::TarGz })
}

fn served_as(dir: &Path, format: ArchiveFormat) -> Served {
    let server = Server::start();
    let dll = dll_bytes();
    let (archive, entry) = match format {
        ArchiveFormat::Zip => (runtime_zip(&dll), DLL_ENTRY),
        ArchiveFormat::TarGz => (runtime_tgz(&dll), SO_ENTRY),
    };
    let model: Vec<u8> = (0..123_456u32).map(|i| (i * 7 % 256) as u8).collect();
    server.route("/rt", Route::Bytes(archive.clone()));
    server.route("/model.onnx", Route::Bytes(model.clone()));
    let pins = Pins {
        runtime_archive: Pin { url: server.url("/rt"), hash: hash_of(&archive) },
        runtime_format: format,
        dll_entry: entry.to_owned(),
        dll: hash_of(&dll),
        runtime_dir: "ort-9.9.9".to_owned(),
        model: Pin { url: server.url("/model.onnx"), hash: hash_of(&model) },
    };
    Served { files: ModelFiles::with_pins(&dir.join("models"), pins), _server: server, dll, model }
}

#[test]
fn install_downloads_the_runtime_and_the_model_then_reports_ready() {
    install_then_ready(ArchiveFormat::Zip, "install-zip");
    install_then_ready(ArchiveFormat::TarGz, "install-tgz");
}

fn install_then_ready(format: ArchiveFormat, name: &str) {
    let dir = temp(name);
    let s = served_as(&dir, format);
    let status = s.files.status();
    assert!(!status.runtime && !status.model && !status.pending_removal);
    assert_eq!(status.bytes, 0);
    assert_eq!(status.download_bytes, s.files.pins().runtime_archive.hash.size + s.model.len() as u64);

    let downloader = Downloader::for_tests(vec!["127.0.0.1".to_owned()]);
    let flight = downloader.begin().unwrap();
    let mut items = Vec::new();
    s.files.install(&downloader, &flight, &mut |item, received, total| items.push((item, received, total))).unwrap();
    drop(flight);
    assert_eq!(items.first().map(|i| i.0), Some(DownloadItem::Runtime));
    assert_eq!(items.last(), Some(&(DownloadItem::Model, s.model.len() as u64, s.model.len() as u64)));

    assert_eq!(fs::read(s.files.runtime_dll()).unwrap(), s.dll);
    assert_eq!(fs::read(s.files.model_path()).unwrap(), s.model);
    assert!(s.files.runtime_dll().ends_with(Path::new("ort-9.9.9").join(DLL_FILE)));
    assert!(s.files.model_path().ends_with(MODEL_FILE));
    // The archive went once the library was out.
    assert!(!s.files.dir().join(RUNTIME_ARCHIVE_FILE).exists());
    let status = s.files.status();
    assert!(status.runtime && status.model);
    assert_eq!(status.download_bytes, 0);
    assert_eq!(status.bytes, (s.dll.len() + s.model.len()) as u64);

    // Nothing missing: nothing downloaded.
    let flight = downloader.begin().unwrap();
    let mut calls = 0;
    s.files.install(&downloader, &flight, &mut |_, _, _| calls += 1).unwrap();
    assert_eq!(calls, 0);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn remove_deletes_the_files() {
    let dir = temp("remove");
    let s = served(&dir);
    let downloader = Downloader::for_tests(vec!["127.0.0.1".to_owned()]);
    let flight = downloader.begin().unwrap();
    s.files.install(&downloader, &flight, &mut |_, _, _| {}).unwrap();
    drop(flight);
    let status = s.files.remove(false);
    assert!(!status.runtime && !status.model && !status.pending_removal);
    assert_eq!(status.bytes, 0);
    assert!(!s.files.runtime_dll().exists());
    assert!(!s.files.model_path().exists());
    // Removing again (or with no folder at all) is fine.
    assert!(!s.files.remove(false).pending_removal);

    // After this process loaded the runtime, the folder is marked even when everything went.
    let status = s.files.remove(true);
    assert!(status.pending_removal);
    assert!(s.files.dir().join(REMOVE_MARKER).exists());
    assert!(s.files.purge_pending());
    let _ = fs::remove_dir_all(&dir);
}

#[cfg(windows)]
#[test]
fn a_runtime_in_use_is_removed_at_the_next_launch() {
    use livery_lib::atelier::models::CUTOUT_RESTART_NEEDED;
    use std::os::windows::fs::OpenOptionsExt;
    let dir = temp("pending");
    let s = served(&dir);
    let downloader = Downloader::for_tests(vec!["127.0.0.1".to_owned()]);
    let flight = downloader.begin().unwrap();
    s.files.install(&downloader, &flight, &mut |_, _, _| {}).unwrap();
    drop(flight);

    // Like a loaded DLL: open without sharing delete.
    let held = fs::OpenOptions::new().read(true).share_mode(0).open(s.files.runtime_dll()).unwrap();
    let status = s.files.remove(false);
    assert!(status.pending_removal);
    assert!(!status.runtime && !status.model);
    assert!(s.files.dir().join(REMOVE_MARKER).exists());
    assert!(!s.files.model_path().exists());

    // Downloads wait for the restart.
    let flight = downloader.begin().unwrap();
    let e = s.files.install(&downloader, &flight, &mut |_, _, _| {}).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Conflict, CUTOUT_RESTART_NEEDED));
    drop(flight);

    // Next launch: the process that held the DLL is gone; the marked folder goes whole.
    drop(held);
    assert!(s.files.purge_pending());
    assert!(!s.files.dir().exists());
    assert!(!s.files.status().pending_removal);
    let _ = fs::remove_dir_all(&dir);
}

/// The real pinned files, when copies are at hand (`LIVERY_ORT_ARCHIVE`: this platform's runtime
/// archive, `LIVERY_ISNET_MODEL`): the archive passes the pins and gives the pinned library; the
/// model hashes to its pin.
#[test]
#[ignore = "needs local copies of the pinned files"]
fn the_real_pinned_files_check_out() {
    let pins = pinned();
    if let Some(archive) = std::env::var_os("LIVERY_ORT_ARCHIVE") {
        let dir = temp("real");
        let dest = dir.join(DLL_FILE);
        let (format, hash) = (pins.runtime_format, &pins.runtime_archive.hash);
        extract_runtime(Path::new(&archive), format, hash, &pins.dll_entry, &pins.dll, &dest).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
    if let Some(model) = std::env::var_os("LIVERY_ISNET_MODEL") {
        let model = Path::new(&model);
        assert_eq!(fs::metadata(model).unwrap().len(), pins.model.hash.size);
        assert_eq!(livery_lib::atelier::sha256::file_hex(model).unwrap(), pins.model.hash.sha256);
    }
}

#[test]
fn the_launch_purge_only_touches_a_marked_folder() {
    let dir = temp("purge");
    let models = dir.join("models");
    fs::create_dir_all(models.join("ort-1")).unwrap();
    fs::write(models.join("ort-1").join(DLL_FILE), b"dll").unwrap();
    let files = ModelFiles::new(&models);
    assert!(!files.purge_pending());
    assert!(models.join("ort-1").join(DLL_FILE).exists());

    fs::write(models.join(REMOVE_MARKER), b"").unwrap();
    // Next to the folder, and (Windows) behind a junction inside it: never touched.
    fs::write(dir.join("sibling.txt"), b"keep").unwrap();
    let outside = dir.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep.txt"), b"keep").unwrap();
    if cfg!(windows) {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(models.join("link"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
    }
    assert!(files.status().pending_removal);
    assert!(files.purge_pending());
    assert!(!models.exists());
    assert!(dir.join("sibling.txt").exists());
    assert!(outside.join("keep.txt").exists());
    // Nothing there: nothing to do.
    assert!(!ModelFiles::new(&dir.join("none")).purge_pending());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn launch_cleans_unfinished_downloads_and_status_ignores_them() {
    let dir = temp("leftovers");
    let models = dir.join("models");
    let runtime = models.join("ort-1");
    fs::create_dir_all(&runtime).unwrap();
    fs::write(models.join(format!("{MODEL_FILE}.part")), vec![0u8; 1000]).unwrap();
    fs::write(models.join(RUNTIME_ARCHIVE_FILE), vec![0u8; 2000]).unwrap();
    fs::write(runtime.join(format!("{DLL_FILE}.part")), vec![0u8; 300]).unwrap();
    fs::write(runtime.join(DLL_FILE), vec![0u8; 40]).unwrap();
    let files = ModelFiles::new(&models);
    assert_eq!(files.status().bytes, 40);
    assert_eq!(files.clean_leftovers(), 3);
    assert_eq!(files.clean_leftovers(), 0);
    assert!(runtime.join(DLL_FILE).exists());
    assert!(!models.join(RUNTIME_ARCHIVE_FILE).exists());
    assert_eq!(files.status().bytes, 40);
    let _ = fs::remove_dir_all(&dir);
}
