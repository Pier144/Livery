//! Shared shapes — keep in sync with `src/types.ts` (see design_handoff_livery/DATA_MODEL.md).
//! Types are added here as the milestones that use them land.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GameSource {
    Steam,
    Standalone,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    #[default]
    Ask,
    Replace,
    Copy,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Language {
    #[default]
    En,
    It,
    De,
    Ru,
    Fr,
}

/// Persisted as JSON in the app data dir. Unknown fields are ignored and missing ones take
/// their defaults, so older and newer settings files both load.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_source: Option<GameSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watch_folder: Option<String>,
    pub auto_install: bool,
    pub conflict_policy: ConflictPolicy,
    pub backups: bool,
    pub backup_days: u32,
    pub language: Language,
    pub auto_update: bool,
    pub start_with_windows: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            game_path: None,
            game_source: None,
            game_version: None,
            watch_folder: None,
            auto_install: false,
            conflict_policy: ConflictPolicy::Ask,
            backups: true,
            backup_days: 30,
            language: Language::En,
            auto_update: true,
            start_with_windows: false,
        }
    }
}

/// `Partial<Settings>` from the frontend: only the fields present are changed.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub game_path: Option<String>,
    pub game_source: Option<GameSource>,
    pub game_version: Option<String>,
    pub watch_folder: Option<String>,
    pub auto_install: Option<bool>,
    pub conflict_policy: Option<ConflictPolicy>,
    pub backups: Option<bool>,
    pub language: Option<Language>,
    pub auto_update: Option<bool>,
    pub start_with_windows: Option<bool>,
}

impl Settings {
    pub fn apply(&mut self, patch: SettingsPatch) {
        if let Some(v) = patch.game_path {
            self.game_path = Some(v);
        }
        if let Some(v) = patch.game_source {
            self.game_source = Some(v);
        }
        if let Some(v) = patch.game_version {
            self.game_version = Some(v);
        }
        if let Some(v) = patch.watch_folder {
            self.watch_folder = Some(v);
        }
        if let Some(v) = patch.auto_install {
            self.auto_install = v;
        }
        if let Some(v) = patch.conflict_policy {
            self.conflict_policy = v;
        }
        if let Some(v) = patch.backups {
            self.backups = v;
        }
        if let Some(v) = patch.language {
            self.language = v;
        }
        if let Some(v) = patch.auto_update {
            self.auto_update = v;
        }
        if let Some(v) = patch.start_with_windows {
            self.start_with_windows = v;
        }
    }
}
