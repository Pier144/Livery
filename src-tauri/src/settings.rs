//! Settings load/save (`<appData>/settings.json`) and the `get_settings` / `set_settings` commands.

use crate::blocking;
use crate::error::AppResult;
use crate::model::{Settings, SettingsPatch};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// Loads settings, falling back to defaults when the file is missing or unreadable.
    /// A corrupt file is kept next to the original as `settings.json.bad` for inspection.
    pub fn load(path: PathBuf) -> Self {
        let settings = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Settings>(&text) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "settings file is corrupt; using defaults");
                    let _ = fs::rename(&path, path.with_extension("json.bad"));
                    Settings::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "cannot read settings; using defaults");
                Settings::default()
            }
        };
        Self { path, current: Mutex::new(settings) }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Applies a partial update and persists it. Memory is only updated once the file is written.
    pub fn update(&self, patch: SettingsPatch) -> AppResult<Settings> {
        let mut guard = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = guard.clone();
        next.apply(patch);
        write_atomic(&self.path, &next)?;
        *guard = next.clone();
        Ok(next)
    }
}

/// Write to a sibling temp file, then rename over the target (replaces on Windows too).
fn write_atomic(path: &Path, settings: &Settings) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// The settings in memory (read from disk at launch).
#[tauri::command]
pub async fn get_settings(app: AppHandle) -> AppResult<Settings> {
    Ok(app.state::<SettingsStore>().get())
}

/// Applies a partial update; the file is written on a blocking thread (`crate::blocking`).
#[tauri::command]
pub async fn set_settings(app: AppHandle, patch: SettingsPatch) -> AppResult<Settings> {
    let settings = blocking(move || app.state::<SettingsStore>().update(patch)).await?;
    tracing::debug!("settings saved");
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ConflictPolicy, Language};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("livery-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = temp_dir("missing");
        let store = SettingsStore::load(dir.join("settings.json"));
        assert_eq!(store.get(), Settings::default());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn update_persists_and_reloads() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("nested").join("settings.json");
        let store = SettingsStore::load(path.clone());
        let saved = store
            .update(SettingsPatch {
                language: Some(Language::It),
                conflict_policy: Some(ConflictPolicy::Replace),
                game_path: Some("D:\\Games\\War Thunder".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(saved.language, Language::It);
        assert!(saved.backups, "untouched fields keep their value");
        assert!(!path.with_extension("json.tmp").exists(), "temp file is renamed away");

        let reloaded = SettingsStore::load(path);
        assert_eq!(reloaded.get(), saved);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn game_version_can_be_cleared_but_null_leaves_it() {
        let mut s = Settings { game_version: Some("2.59.0.13".into()), ..Settings::default() };
        let from_json: SettingsPatch = serde_json::from_str(r#"{ "gameVersion": null, "language": "it" }"#).unwrap();
        s.apply(from_json);
        assert_eq!(s.game_version.as_deref(), Some("2.59.0.13"), "null from the UI changes nothing");
        s.apply(SettingsPatch { game_version: Some(None), ..Default::default() });
        assert_eq!(s.game_version, None, "a new root without a version clears it");
        let set: SettingsPatch = serde_json::from_str(r#"{ "gameVersion": "2.60.0.1" }"#).unwrap();
        s.apply(set);
        assert_eq!(s.game_version.as_deref(), Some("2.60.0.1"));
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        let dir = temp_dir("corrupt");
        let path = dir.join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        let store = SettingsStore::load(path.clone());
        assert_eq!(store.get(), Settings::default());
        assert!(path.with_extension("json.bad").exists());
        fs::remove_dir_all(dir).ok();
    }
}
