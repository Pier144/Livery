//! The background-removal files: the pinned table, the runtime's DLL extracted alone from a
//! verified zip, the whole install against a local server, status, remove with a pending marker
//! and the launch purge. Synthetic zips and "models" only; nothing is downloaded from the network.

mod common;

use common::http::{Route, Server};
use livery_lib::atelier::download::{Downloader, MODEL_DOWNLOAD_CORRUPT};
use livery_lib::atelier::models::{
    extract_runtime, pinned, FileHash, ModelFiles, Pin, Pins, CUTOUT_RESTART_NEEDED, DLL_FILE, MODEL_FILE,
    REMOVE_MARKER, RUNTIME_ZIP_FILE,
};
use livery_lib::atelier::sha256::{digest, hex};
use livery_lib::error::ErrorCode;
use livery_lib::model::DownloadItem;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const DLL_ENTRY: &str = "onnxruntime-win-x64-9.9.9/lib/onnxruntime.dll";

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

fn dll_bytes() -> Vec<u8> {
    (0..300_000u32).map(|i| (i % 253) as u8).collect()
}

#[test]
fn the_pinned_table_is_complete() {
    let pins = pinned();
    for pin in [&pins.runtime_zip, &pins.model] {
        assert!(pin.url.starts_with("https://github.com/"), "{}", pin.url);
        assert_eq!(pin.hash.sha256.len(), 64);
        assert!(pin.hash.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert!(pin.hash.size > 0);
    }
    assert_eq!(pins.model.hash.sha256, "f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99");
    assert_eq!(pins.model.hash.size, 176_069_933);
    assert!(pins.dll_entry.ends_with("/lib/onnxruntime.dll"));
    assert_eq!(pins.dll.sha256.len(), 64);
    assert!(pins.runtime_zip.url.contains(&format!("onnxruntime-win-x64-{}.zip", &pins.runtime_dir["ort-".len()..])));
}

#[test]
fn extraction_takes_only_the_dll_and_checks_it() {
    let dir = temp("extract");
    let dll = dll_bytes();
    let zip = runtime_zip(&dll);
    let zip_path = dir.join("rt.zip");
    fs::write(&zip_path, &zip).unwrap();
    let dest = dir.join("ort").join(DLL_FILE);

    extract_runtime(&zip_path, &hash_of(&zip), DLL_ENTRY, &hash_of(&dll), &dest).unwrap();
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
    corrupt(extract_runtime(&zip_path, &hash_of(b"other zip"), DLL_ENTRY, &hash_of(&dll), &fresh).unwrap_err());
    // The DLL inside isn't the pinned one.
    corrupt(extract_runtime(&zip_path, &hash_of(&zip), DLL_ENTRY, &hash_of(&dll[1..]), &fresh).unwrap_err());
    let mut other = dll.clone();
    other[10] ^= 1;
    corrupt(extract_runtime(&zip_path, &hash_of(&zip), DLL_ENTRY, &hash_of(&other), &fresh).unwrap_err());
    // No such entry.
    corrupt(extract_runtime(&zip_path, &hash_of(&zip), "lib/onnxruntime.dll", &hash_of(&dll), &fresh).unwrap_err());
    assert!(!fresh.exists());
    assert!(fresh.parent().is_none_or(|p| fs::read_dir(p).map_or(true, |mut e| e.next().is_none())));
    let _ = fs::remove_dir_all(&dir);
}

struct Served {
    _server: Server,
    files: ModelFiles,
    dll: Vec<u8>,
    model: Vec<u8>,
}

fn served(dir: &Path) -> Served {
    let server = Server::start();
    let dll = dll_bytes();
    let zip = runtime_zip(&dll);
    let model: Vec<u8> = (0..123_456u32).map(|i| (i * 7 % 256) as u8).collect();
    server.route("/rt.zip", Route::Bytes(zip.clone()));
    server.route("/model.onnx", Route::Bytes(model.clone()));
    let pins = Pins {
        runtime_zip: Pin { url: server.url("/rt.zip"), hash: hash_of(&zip) },
        dll_entry: DLL_ENTRY.to_owned(),
        dll: hash_of(&dll),
        runtime_dir: "ort-9.9.9".to_owned(),
        model: Pin { url: server.url("/model.onnx"), hash: hash_of(&model) },
    };
    Served { files: ModelFiles::with_pins(&dir.join("models"), pins), _server: server, dll, model }
}

#[test]
fn install_downloads_the_runtime_and_the_model_then_reports_ready() {
    let dir = temp("install");
    let s = served(&dir);
    let status = s.files.status();
    assert!(!status.runtime && !status.model && !status.pending_removal);
    assert_eq!(status.bytes, 0);
    assert_eq!(status.download_bytes, s.files.pins().runtime_zip.hash.size + s.model.len() as u64);

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
    // The zip went once the DLL was out.
    assert!(!s.files.dir().join(RUNTIME_ZIP_FILE).exists());
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

/// The real pinned files, when copies are at hand (`LIVERY_ORT_ZIP`, `LIVERY_ISNET_MODEL`): the
/// zip passes the pins and gives the pinned DLL; the model hashes to its pin.
#[test]
#[ignore = "needs local copies of the pinned files"]
fn the_real_pinned_files_check_out() {
    let pins = pinned();
    if let Some(zip) = std::env::var_os("LIVERY_ORT_ZIP") {
        let dir = temp("real");
        let dest = dir.join(DLL_FILE);
        extract_runtime(Path::new(&zip), &pins.runtime_zip.hash, &pins.dll_entry, &pins.dll, &dest).unwrap();
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
    assert!(files.status().pending_removal);
    assert!(files.purge_pending());
    assert!(!models.exists());
    // Nothing there: nothing to do.
    assert!(!ModelFiles::new(&dir.join("none")).purge_pending());
    let _ = fs::remove_dir_all(&dir);
}
