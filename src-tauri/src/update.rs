//! Livery's own updates (Settings → Updates), through `tauri-plugin-updater`.
//!
//! The feed is the signed `latest.json` the release workflow attaches to every release; the
//! endpoint in tauri.conf.json is the **latest published** GitHub release, so a draft is never
//! offered. Every installer is checked against the public key in tauri.conf.json before it runs.
//!
//! - `check_update` asks the feed now. `install_update` downloads (`update://progress`), verifies
//!   and runs the NSIS installer in passive mode: it closes Livery, installs over it and opens the
//!   new version.
//! - With "Install updates automatically" on, a background thread checks shortly after launch and
//!   every 6 hours, downloads a newer version quietly and announces it (`update://ready`). That
//!   version is installed when Livery closes, without opening it again. Debug builds never do
//!   this, so `pnpm tauri dev` can't replace the installed app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult, ErrorCode};
use crate::settings::SettingsStore;

/// `{ downloaded, total? }` while an update downloads.
pub const PROGRESS_EVENT: &str = "update://progress";
/// `{ version }` once a background download is verified and waiting for the app to close.
pub const READY_EVENT: &str = "update://ready";

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// At most this many progress events a second, plus the first and the last.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

pub const CHECK_FAILED: &str = "Livery couldn't check for updates";
pub const DOWNLOAD_FAILED: &str = "The update couldn't be downloaded";
pub const BAD_SIGNATURE: &str = "The update isn't signed by Livery, so it wasn't installed";
pub const INSTALL_FAILED: &str = "The update couldn't be installed";
pub const UP_TO_DATE: &str = "Livery is already up to date";
pub const BUSY: &str = "The update is already downloading";

/// What `check_update` answers: `{ current, latest?, notes?, ready }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    /// The newer version the feed offers; absent when Livery is up to date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// The release notes, as written on the release.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// `latest` is already downloaded and verified: installing needs no network.
    pub ready: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReady {
    pub version: String,
}

struct Pending {
    update: Update,
    /// The verified installer, once downloaded.
    bytes: Option<Vec<u8>>,
}

/// The newest update the feed announced this session, and whether a download is running.
#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Pending>>,
    downloading: AtomicBool,
}

impl UpdateState {
    /// Keeps what the feed just said. The same version keeps its download; anything else drops it.
    fn remember(&self, current: &str, found: Option<Update>) -> UpdateInfo {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        match found {
            None => {
                *pending = None;
                info(current, None, false)
            }
            Some(update) => {
                let bytes = pending.take().filter(|p| p.update.version == update.version).and_then(|p| p.bytes);
                let result = info(current, Some((&update.version, update.body.as_deref())), bytes.is_some());
                *pending = Some(Pending { update, bytes });
                result
            }
        }
    }

    fn ready(&self) -> Option<(Update, Vec<u8>)> {
        let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.as_ref().and_then(|p| Some((p.update.clone(), p.bytes.clone()?)))
    }

    fn store_download(&self, version: &str, bytes: Vec<u8>) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = pending.as_mut().filter(|p| p.update.version == version) {
            p.bytes = Some(bytes);
        }
    }

    fn pending_update(&self) -> Option<Update> {
        let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.as_ref().map(|p| p.update.clone())
    }
}

/// Releases the download flag however the download ends.
struct DownloadClaim<'a>(&'a AtomicBool);

impl<'a> DownloadClaim<'a> {
    fn take(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).ok().map(|_| Self(flag))
    }
}

impl Drop for DownloadClaim<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(crate) fn info(current: &str, latest: Option<(&str, Option<&str>)>, ready: bool) -> UpdateInfo {
    let notes = latest.and_then(|(_, notes)| notes).map(str::trim).filter(|n| !n.is_empty()).map(str::to_owned);
    UpdateInfo {
        current: current.to_owned(),
        latest: latest.map(|(v, _)| v.to_owned()),
        notes,
        ready: ready && latest.is_some(),
    }
}

/// The error code an updater failure gets: the network ones are `network` (the UI treats them as
/// offline), a bad signature and everything else are `internal`.
pub(crate) fn error_code(e: &tauri_plugin_updater::Error) -> ErrorCode {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Reqwest(_) | E::Network(_) | E::ReleaseNotFound => ErrorCode::Network,
        _ => ErrorCode::Internal,
    }
}

fn is_signature_error(e: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error as E;
    matches!(e, E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_))
}

/// `base` with the code and detail `e` calls for; a bad signature always says so instead.
fn updater_error(base: AppError, e: tauri_plugin_updater::Error) -> AppError {
    if is_signature_error(&e) {
        return AppError::new(ErrorCode::Internal, BAD_SIGNATURE).with_detail(e.to_string());
    }
    AppError { code: error_code(&e), ..base }.with_detail(e.to_string())
}

fn check_error(e: tauri_plugin_updater::Error) -> AppError {
    updater_error(AppError::new(ErrorCode::Network, CHECK_FAILED), e)
}

fn download_error(e: tauri_plugin_updater::Error) -> AppError {
    updater_error(AppError::new(ErrorCode::Network, DOWNLOAD_FAILED), e)
}

fn install_error(e: tauri_plugin_updater::Error) -> AppError {
    updater_error(AppError::new(ErrorCode::Internal, INSTALL_FAILED), e)
}

fn current_version<R: Runtime>(app: &AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

async fn fetch<R: Runtime>(app: &AppHandle<R>) -> AppResult<Option<Update>> {
    let updater = app.updater().map_err(check_error)?;
    updater.check().await.map_err(check_error)
}

/// Downloads and verifies `update`, emitting `update://progress`, and keeps the installer.
async fn download<R: Runtime>(app: &AppHandle<R>, state: &UpdateState, update: &Update) -> AppResult<Vec<u8>> {
    let Some(_claim) = DownloadClaim::take(&state.downloading) else {
        return Err(AppError::new(ErrorCode::Conflict, BUSY));
    };
    let mut downloaded: u64 = 0;
    let mut last_emit: Option<std::time::Instant> = None;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let now = std::time::Instant::now();
                if matches!(last_emit, Some(t) if now.duration_since(t) < PROGRESS_EVERY) {
                    return;
                }
                last_emit = Some(now);
                let _ = app.emit(PROGRESS_EVENT, UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(download_error)?;
    let size = bytes.len() as u64;
    let _ = app.emit(PROGRESS_EVENT, UpdateProgress { downloaded: size, total: Some(size) });
    state.store_download(&update.version, bytes.clone());
    Ok(bytes)
}

/// Runs the installer. On Windows it closes Livery (`std::process::exit`) and only returns on
/// failure; elsewhere Livery restarts itself when `restart` is set.
fn install<R: Runtime>(app: &AppHandle<R>, update: Update, bytes: &[u8], restart: bool) -> AppResult<()> {
    tracing::info!(version = %update.version, restart, "installing update");
    update.restart_after_install(restart).install(bytes).map_err(install_error)?;
    if restart {
        app.restart();
    }
    Ok(())
}

#[tauri::command]
pub async fn check_update(app: AppHandle, state: State<'_, UpdateState>) -> AppResult<UpdateInfo> {
    let found = fetch(&app).await?;
    Ok(state.remember(&current_version(&app), found))
}

/// Installs the newest version now: the one already downloaded, else the one the last check
/// found (downloaded now), else whatever the feed offers. Livery closes and reopens on success.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> AppResult<()> {
    if let Some((update, bytes)) = state.ready() {
        return install(&app, update, &bytes, true);
    }
    let update = match state.pending_update() {
        Some(update) => update,
        None => {
            let found = fetch(&app).await?;
            state.remember(&current_version(&app), found.clone());
            found.ok_or_else(|| AppError::new(ErrorCode::InvalidInput, UP_TO_DATE))?
        }
    };
    let bytes = download(&app, &state, &update).await?;
    install(&app, update, &bytes, true)
}

/// One background round: check, and download a newer version if there is one.
async fn auto_round<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    if !app.state::<SettingsStore>().get().auto_update {
        return Ok(());
    }
    let state = app.state::<UpdateState>();
    let Some(update) = fetch(app).await? else {
        state.remember(&current_version(app), None);
        return Ok(());
    };
    let version = update.version.clone();
    if state.remember(&current_version(app), Some(update.clone())).ready {
        return Ok(());
    }
    download(app, &state, &update).await?;
    tracing::info!(%version, "update downloaded; it installs when Livery closes");
    let _ = app.emit(READY_EVENT, UpdateReady { version });
    Ok(())
}

/// Starts the background checks (release builds only).
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("livery-updates".into()).spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            if let Err(e) = tauri::async_runtime::block_on(auto_round(&app)) {
                tracing::warn!(error = %e, "background update check failed");
            }
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "the update thread couldn't start");
    }
}

/// On exit: installs a version the background check downloaded, if updates are automatic
/// (release builds only). Livery isn't opened again afterwards.
pub fn install_on_exit<R: Runtime>(app: &AppHandle<R>) {
    if cfg!(debug_assertions) || !app.state::<SettingsStore>().get().auto_update {
        return;
    }
    if let Some((update, bytes)) = app.state::<UpdateState>().ready() {
        if let Err(e) = install(app, update, &bytes, false) {
            tracing::warn!(error = %e, "the downloaded update couldn't be installed on exit");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_without_an_update_is_up_to_date() {
        let i = info("0.1.0", None, true);
        assert_eq!(i, UpdateInfo { current: "0.1.0".into(), latest: None, notes: None, ready: false });
        let json = serde_json::to_value(&i).unwrap();
        assert_eq!(json, serde_json::json!({ "current": "0.1.0", "ready": false }));
    }

    #[test]
    fn info_with_an_update_keeps_trimmed_notes() {
        let i = info("0.1.0", Some(("0.2.0", Some("  Uninstall from the Hangar.\n"))), false);
        assert_eq!(i.latest.as_deref(), Some("0.2.0"));
        assert_eq!(i.notes.as_deref(), Some("Uninstall from the Hangar."));
        assert!(!i.ready);
        assert!(info("0.1.0", Some(("0.2.0", Some("  "))), true).notes.is_none());
        assert!(info("0.1.0", Some(("0.2.0", None)), true).ready);
    }

    #[test]
    fn network_failures_are_network_errors() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(error_code(&E::ReleaseNotFound), ErrorCode::Network);
        assert_eq!(error_code(&E::Network("timed out".into())), ErrorCode::Network);
        assert_eq!(error_code(&E::EmptyEndpoints), ErrorCode::Internal);
        let e = download_error(E::Network("reset".into()));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Network, DOWNLOAD_FAILED));
    }

    #[test]
    fn a_bad_signature_says_so() {
        let e = install_error(tauri_plugin_updater::Error::SignatureUtf8("x".into()));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Internal, BAD_SIGNATURE));
    }

    #[test]
    fn one_download_at_a_time() {
        let flag = AtomicBool::new(false);
        let first = DownloadClaim::take(&flag).expect("free");
        assert!(DownloadClaim::take(&flag).is_none());
        drop(first);
        assert!(DownloadClaim::take(&flag).is_some());
    }
}
