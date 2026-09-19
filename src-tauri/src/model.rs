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
    /// First run finished or skipped; the app then opens on Explore.
    pub onboarded: bool,
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
            onboarded: false,
        }
    }
}

/// `Partial<Settings>` from the frontend: only the fields present are changed.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub game_path: Option<String>,
    pub game_source: Option<GameSource>,
    /// `Some(None)` clears it (a new game root without a readable version); a missing or
    /// null field leaves it unchanged.
    #[serde(default, deserialize_with = "present")]
    pub game_version: Option<Option<String>>,
    pub watch_folder: Option<String>,
    pub auto_install: Option<bool>,
    pub conflict_policy: Option<ConflictPolicy>,
    pub backups: Option<bool>,
    pub language: Option<Language>,
    pub auto_update: Option<bool>,
    pub start_with_windows: Option<bool>,
    pub onboarded: Option<bool>,
}

/// Deserializes a present field as `Some(value)`, so `Option<Option<T>>` can tell
/// "set to this" from "not sent" (the outer `None` comes from `#[serde(default)]`).
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(|v| v.map(Some))
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
            self.game_version = v;
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
        if let Some(v) = patch.onboarded {
            self.onboarded = v;
        }
    }
}

// ── Game detection (M2) ─────────────────────────────────────────────────────

/// Result of `detect_game` / `set_game_path`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDetection {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<GameSource>,
    /// Game root (the folder that holds `launcher.exe` / `UserSkins`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Full version from `content/pkg_main.ver`, e.g. "2.59.0.13".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Skin folders currently in `UserSkins`.
    pub existing_skins: u32,
}

impl GameDetection {
    pub fn not_found() -> Self {
        Self { found: false, source: None, path: None, version: None, existing_skins: 0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DetectState {
    Checking,
    Found,
    NotFound,
    /// Custom location when no custom path was ever set.
    Skipped,
}

/// Payload of the `game://detect` event, one per source and state change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectEvent {
    pub source: GameSource,
    pub state: DetectState,
}

// ── Library (M2 import, M3 hangar) ──────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Nation {
    #[serde(rename = "USA")]
    Usa,
    #[serde(rename = "GER")]
    Ger,
    #[serde(rename = "USSR")]
    Ussr,
    #[serde(rename = "GBR")]
    Gbr,
    #[serde(rename = "JPN")]
    Jpn,
    #[serde(rename = "CHN")]
    Chn,
    #[serde(rename = "ITA")]
    Ita,
    #[serde(rename = "FRA")]
    Fra,
    #[serde(rename = "SWE")]
    Swe,
    #[serde(rename = "ISR")]
    Isr,
    /// Code not in the local catalog and no recognisable nation prefix (aircraft, mostly).
    #[serde(rename = "UNK")]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VehicleType {
    Ground,
    Air,
    Heli,
    Naval,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    /// Internal code = the `.blk` file stem, e.g. `ussr_t_34_85`.
    pub code: String,
    pub name: String,
    pub nation: Nation,
    #[serde(rename = "type")]
    pub vehicle_type: VehicleType,
    pub class: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skin_count: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    Wtlive,
    Imported,
    Mine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttentionKind {
    MissingTexture,
    UnknownBlkBlock,
    PartialExtract,
    NoBlk,
    /// The blk exists but isn't valid BLK text; `message` carries the parser's line:col reason.
    UnreadableBlk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub kind: AttentionKind,
    /// English fallback; the UI renders its own localized text from `kind` + `file`.
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

/// An installed skin as the library indexes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HangarSkin {
    pub id: String,
    /// Folder name inside `UserSkins` (what the game shows as the skin name).
    pub folder: String,
    pub name: String,
    pub vehicle: Vehicle,
    pub origin: Origin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Author>,
    pub size_bytes: u64,
    pub active: bool,
    /// RFC 3339 UTC timestamp.
    pub installed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attention: Vec<Attention>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub temporary: bool,
}

// ── Backups & collections (M3) ──────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupReason {
    Replace,
    Delete,
}

/// A skin folder kept aside before a delete or replace; drives Undo and Settings → Backups.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    /// `HangarSkin.id` of the skin it came from.
    pub skin_id: String,
    pub name: String,
    pub size_bytes: u64,
    /// RFC 3339 UTC timestamp.
    pub created_at: String,
    pub reason: BackupReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub skin_ids: Vec<String>,
    /// RFC 3339 UTC timestamp.
    pub created_at: String,
}

/// `collections_list` and friends: every collection plus the one activated last.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionsState {
    pub collections: Vec<Collection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_collection_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    /// One backup per deleted skin, in the same order; pass them to `restore_backups` to undo.
    pub backup_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub exported: u32,
    pub dest: String,
}
