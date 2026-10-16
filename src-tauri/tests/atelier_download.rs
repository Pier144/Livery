//! The background-removal downloader against a local HTTP server: a file is kept only whole and
//! with the pinned hash; the partial file goes on every failure; redirects and URLs outside the
//! allowlist are refused; one download at a time; cancel stops between chunks.

mod common;

use common::http::{Route, Server};
use livery_lib::atelier::download::{
    part_path, Downloader, Expected, ALLOWED_HOSTS, MODEL_DOWNLOAD_BUSY, MODEL_DOWNLOAD_CANCELLED,
    MODEL_DOWNLOAD_CORRUPT, MODEL_DOWNLOAD_FAILED,
};
use livery_lib::atelier::sha256::{digest, hex};
use livery_lib::error::{AppError, ErrorCode};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("livery-download-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn body(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

fn local() -> Downloader {
    Downloader::for_tests(vec!["127.0.0.1".to_owned()])
}

/// Downloads `url` expecting `bytes`' size and hash; returns the result and the progress reports.
fn fetch(
    downloader: &Downloader,
    url: &str,
    size: u64,
    sha: &str,
    dest: &Path,
) -> (Result<(), AppError>, Vec<(u64, u64)>) {
    let flight = downloader.begin().unwrap();
    let mut reports = Vec::new();
    let result =
        downloader.download(&flight, Expected { url, size, sha256: sha }, dest, &mut |r, t| reports.push((r, t)));
    (result, reports)
}

fn check(e: AppError, code: ErrorCode, message: &str) {
    assert_eq!((e.code, e.message.as_str()), (code, message), "{e}");
}

#[test]
fn a_whole_file_with_the_pinned_hash_is_kept() {
    let dir = temp("ok");
    let server = Server::start();
    let data = body(700_000);
    server.route("/file", Route::Bytes(data.clone()));
    let dest = dir.join("file.bin");
    let (result, reports) = fetch(&local(), &server.url("/file"), data.len() as u64, &hex(&digest(&data)), &dest);
    result.unwrap();
    assert_eq!(fs::read(&dest).unwrap(), data);
    assert!(!part_path(&dest).exists());
    assert_eq!(reports.first(), Some(&(0, data.len() as u64)));
    assert_eq!(reports.last(), Some(&(data.len() as u64, data.len() as u64)));
    // Replaces an older file.
    let (result, _) = fetch(&local(), &server.url("/file"), data.len() as u64, &hex(&digest(&data)), &dest);
    result.unwrap();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_hash_mismatch_deletes_the_partial_file_and_keeps_the_old_one() {
    let dir = temp("corrupt");
    let server = Server::start();
    let data = body(1000);
    server.route("/file", Route::Bytes(data.clone()));
    let dest = dir.join("file.bin");
    fs::write(&dest, b"old").unwrap();
    let (result, _) = fetch(&local(), &server.url("/file"), 1000, &hex(&digest(b"other")), &dest);
    check(result.unwrap_err(), ErrorCode::Parse, MODEL_DOWNLOAD_CORRUPT);
    assert!(!part_path(&dest).exists());
    assert_eq!(fs::read(&dest).unwrap(), b"old");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn more_or_fewer_bytes_than_pinned_fail() {
    let dir = temp("sizes");
    let server = Server::start();
    let data = body(5000);
    let sha = hex(&digest(&data));
    let dest = dir.join("file.bin");

    // Announced size differs.
    server.route("/announced", Route::Bytes(data.clone()));
    let (result, _) = fetch(&local(), &server.url("/announced"), 4000, &sha, &dest);
    check(result.unwrap_err(), ErrorCode::Network, MODEL_DOWNLOAD_FAILED);

    // No size announced: the cap at the pinned size stops it.
    server.route("/long", Route::Unsized(data.clone()));
    let (result, _) = fetch(&local(), &server.url("/long"), 4000, &sha, &dest);
    check(result.unwrap_err(), ErrorCode::Network, MODEL_DOWNLOAD_FAILED);
    assert!(!part_path(&dest).exists());

    // Short body.
    server.route("/short", Route::Unsized(data[..3000].to_vec()));
    let (result, _) = fetch(&local(), &server.url("/short"), 5000, &sha, &dest);
    check(result.unwrap_err(), ErrorCode::Network, MODEL_DOWNLOAD_FAILED);
    assert!(!part_path(&dest).exists());
    assert!(!dest.exists());

    // HTTP errors.
    let (result, _) = fetch(&local(), &server.url("/missing"), 5000, &sha, &dest);
    check(result.unwrap_err(), ErrorCode::Network, MODEL_DOWNLOAD_FAILED);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn redirects_only_to_allowed_hosts() {
    let dir = temp("redirect");
    let server = Server::start();
    let data = body(100);
    let sha = hex(&digest(&data));
    server.route("/file", Route::Bytes(data.clone()));
    server.route("/good", Route::Redirect(server.url("/file")));
    server.route("/bad", Route::Redirect(format!("http://localhost:{}/file", server.port)));
    let dest = dir.join("file.bin");

    let (result, _) = fetch(&local(), &server.url("/good"), 100, &sha, &dest);
    result.unwrap();
    fs::remove_file(&dest).unwrap();

    let (result, _) = fetch(&local(), &server.url("/bad"), 100, &sha, &dest);
    check(result.unwrap_err(), ErrorCode::Network, MODEL_DOWNLOAD_FAILED);
    assert!(!dest.exists());

    // A URL outside the allowlist isn't even requested.
    let (result, _) = fetch(&local(), &format!("http://localhost:{}/file", server.port), 100, &sha, &dest);
    check(result.unwrap_err(), ErrorCode::InvalidInput, MODEL_DOWNLOAD_FAILED);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_real_downloader_wants_https_to_github_only() {
    let downloader = Downloader::new();
    let url = |s: &str| reqwest::Url::parse(s).unwrap();
    for host in ALLOWED_HOSTS {
        assert!(downloader.allows(&url(&format!("https://{host}/x"))), "{host}");
        assert!(!downloader.allows(&url(&format!("http://{host}/x"))), "{host}");
    }
    for bad in
        ["https://example.com/x", "https://github.com.evil.example/x", "https://127.0.0.1/x", "ftp://github.com/x"]
    {
        assert!(!downloader.allows(&url(bad)), "{bad}");
    }
    let dir = temp("https");
    let (result, _) = fetch(&downloader, "http://github.com/x", 1, &hex(&digest(b"x")), &dir.join("x"));
    check(result.unwrap_err(), ErrorCode::InvalidInput, MODEL_DOWNLOAD_FAILED);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn one_download_at_a_time() {
    let downloader = local();
    let flight = downloader.begin().unwrap();
    assert!(downloader.is_busy());
    let e = downloader.begin().err().expect("busy");
    check(e, ErrorCode::Conflict, MODEL_DOWNLOAD_BUSY);
    drop(flight);
    assert!(!downloader.is_busy());
    // A cancel with nothing running doesn't stop the next download.
    downloader.cancel();
    let dir = temp("flight");
    let server = Server::start();
    server.route("/file", Route::Bytes(b"abc".to_vec()));
    let (result, _) = fetch(&downloader, &server.url("/file"), 3, &hex(&digest(b"abc")), &dir.join("f"));
    result.unwrap();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cancel_stops_between_chunks() {
    let dir = temp("cancel");
    let server = Server::start();
    let data = body(200_000);
    server.route("/slow", Route::Slow(data.clone(), 50_000, Duration::from_millis(600)));
    let downloader = Arc::new(local());
    let canceller = Arc::clone(&downloader);
    let dest = dir.join("file.bin");
    let flight = downloader.begin().unwrap();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        canceller.cancel();
    });
    let url = server.url("/slow");
    let result = downloader.download(
        &flight,
        Expected { url: &url, size: data.len() as u64, sha256: &hex(&digest(&data)) },
        &dest,
        &mut |_, _| {},
    );
    handle.join().unwrap();
    check(result.unwrap_err(), ErrorCode::Network, MODEL_DOWNLOAD_CANCELLED);
    assert!(!dest.exists());
    assert!(!part_path(&dest).exists());
    let _ = fs::remove_dir_all(&dir);
}
