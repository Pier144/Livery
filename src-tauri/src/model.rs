//! Shared shapes — keep in sync with `src/types.ts`.
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

/// The UI language. Codes are i18next's (`pt-BR`, `zh-CN` keep their region).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Language {
    #[default]
    En,
    It,
    De,
    Ru,
    Fr,
    Es,
    Pl,
    #[serde(rename = "pt-BR")]
    PtBr,
    #[serde(rename = "zh-CN")]
    ZhCn,
}

fn lenient_language<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Language, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(Language::deserialize(value).unwrap_or_default())
}

impl Language {
    pub const ALL: [Language; 9] = [
        Language::En,
        Language::It,
        Language::De,
        Language::Ru,
        Language::Fr,
        Language::Es,
        Language::Pl,
        Language::PtBr,
        Language::ZhCn,
    ];

    /// The column header of the game's `lang/*.csv` files for this language.
    pub fn game_column(self) -> &'static str {
        match self {
            Language::En => "<English>",
            Language::It => "<Italian>",
            Language::De => "<German>",
            Language::Ru => "<Russian>",
            Language::Fr => "<French>",
            Language::Es => "<Spanish>",
            Language::Pl => "<Polish>",
            Language::PtBr => "<Portuguese>",
            Language::ZhCn => "<Chinese>",
        }
    }
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
    /// A code this version doesn't know (written by a newer Livery) reads as English instead of
    /// making the whole file unreadable.
    #[serde(deserialize_with = "lenient_language")]
    pub language: Language,
    pub auto_update: bool,
    pub start_with_windows: bool,
    /// First run finished or skipped; the app then opens on Explore.
    pub onboarded: bool,
    /// Settings → General → Reduce motion (`system` follows Windows).
    pub reduce_motion: ReduceMotion,
    /// Settings → WT Live → Browse WT Live. Off: Livery sends no request to WT Live.
    pub wtlive_enabled: bool,
    /// Settings → Game → Read the vehicle list from the game. Off: Livery never opens the game's
    /// data archives (`char.vromfs.bin`, `lang.vromfs.bin`) and uses its built-in list.
    #[serde(default = "yes")]
    pub read_game_data: bool,
    /// Settings → Atelier → Show Atelier (the skin editor). On by default since 0.5.0, when it left
    /// Experimental; `migrate` turns it on once in files written before that.
    pub atelier_enabled: bool,
    /// Which one-time migrations the file has had (`migrate`). Missing in files from before 0.5.0,
    /// which read as 0.
    #[serde(default)]
    pub settings_version: u32,
}

/// The settings layout this version writes (see `Settings::migrate`).
pub const SETTINGS_VERSION: u32 = 1;

impl Settings {
    /// One-time changes to a file written by an older Livery; true when something changed (the
    /// caller saves it). Version 1 (0.5.0): Atelier left Experimental and is on for everyone, also
    /// where 0.4.0 wrote its old default (off).
    pub fn migrate(&mut self) -> bool {
        if self.settings_version >= SETTINGS_VERSION {
            return false;
        }
        if self.settings_version < 1 {
            self.atelier_enabled = true;
        }
        self.settings_version = SETTINGS_VERSION;
        true
    }
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReduceMotion {
    #[default]
    System,
    On,
    Off,
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
            reduce_motion: ReduceMotion::System,
            wtlive_enabled: true,
            read_game_data: true,
            atelier_enabled: true,
            settings_version: SETTINGS_VERSION,
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
    pub reduce_motion: Option<ReduceMotion>,
    pub wtlive_enabled: Option<bool>,
    pub read_game_data: Option<bool>,
    pub atelier_enabled: Option<bool>,
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
        if let Some(v) = patch.read_game_data {
            self.read_game_data = v;
        }
        if let Some(v) = patch.start_with_windows {
            self.start_with_windows = v;
        }
        if let Some(v) = patch.onboarded {
            self.onboarded = v;
        }
        if let Some(v) = patch.reduce_motion {
            self.reduce_motion = v;
        }
        if let Some(v) = patch.wtlive_enabled {
            self.wtlive_enabled = v;
        }
        if let Some(v) = patch.atelier_enabled {
            self.atelier_enabled = v;
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
    /// The picture of the WT Live post it came from (https URL), shown as the Hangar card image.
    /// A local skin's own picture is read on demand (`skin_preview`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
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

// ── Install queue & textures (M4) ───────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueueStatus {
    Analyzing,
    Ready,
    Conflict,
    NeedsLook,
    Installing,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Path inside the source, `/`-separated.
    pub path: String,
    pub size_bytes: u64,
}

/// One dropped/watched archive or skin folder in the install queue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    /// Where it came from (archive file or folder).
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub status: QueueStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vehicle: Option<Vehicle>,
    /// needsLook: one entry per skin root found inside.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<Vehicle>,
    /// conflict: `HangarSkin.id` of the installed skin using the same folder (or `disk:<folder>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_with: Option<String>,
    /// Folder name it will be installed as inside UserSkins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_folder: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<FileEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blk_ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallStep {
    Download,
    Extract,
    Verify,
    Done,
    Error,
}

/// Payload of `install://progress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub install_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_id: Option<String>,
    pub step: InstallStep,
    /// 0–100 within the whole install.
    pub pct: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// done: the installed skin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skin_id: Option<String>,
    /// done after a Replace: the backup of the previous version (drives Undo).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStarted {
    pub install_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureInfo {
    pub file: String,
    /// Localizable kind of `warning` (the UI translates it; `warning` stays as English fallback).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning_kind: Option<TextureWarningKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// e.g. "BC7", "BC5", "BC1", "RGBA8", "RGB8", "BLK".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextureWarningKind {
    Unreadable,
    NotSquarePow2,
    Heavy,
    Missing,
}

// ── WT Live (M5) ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Category {
    Historical,
    #[serde(rename = "Semi-historical")]
    SemiHistorical,
    Fictional,
    Camouflage,
    Other,
}

/// A skin post on WT Live (Explore, Following, Skin detail).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WtLiveSkin {
    pub id: String,
    pub name: String,
    pub vehicle: Vehicle,
    pub author: Author,
    pub category: Category,
    pub downloads: u64,
    pub likes: u64,
    /// RFC 3339.
    pub posted_at: String,
    pub size_bytes: u64,
    pub images: Vec<String>,
    pub post_url: String,
    pub download_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<FileEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_new: Option<bool>,
    /// The author's text and the pictures embedded in it (the post page only, not the feed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<PostDescription>,
}

/// A post's description as plain data (`wtlive::text`): never HTML.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostDescription {
    /// Paragraphs of runs; hashtags and embedded pictures are taken out.
    pub paragraphs: Vec<Vec<PostRun>>,
    /// Hashtags, lower-cased, in order (the ones taken out of the text).
    #[serde(default)]
    pub tags: Vec<String>,
    /// Pictures embedded in the text, in order (https, WT Live's image hosts only).
    pub images: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PostRun {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        bold: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        italic: bool,
    },
    /// A WT Live page (links to other sites go through WT Live's `/away/` page).
    Link {
        text: String,
        url: String,
    },
    Break,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortOrder {
    Downloads,
    Likes,
    Newest,
    Name,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub nation: Option<Nation>,
    #[serde(default, rename = "type")]
    pub vehicle_type: Option<VehicleType>,
    #[serde(default)]
    pub class: Option<String>,
    /// Vehicle code.
    #[serde(default)]
    pub vehicle: Option<String>,
    #[serde(default)]
    pub category: Option<Category>,
    pub sort: SortOrder,
    pub page: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub items: Vec<WtLiveSkin>,
    /// With `total_exact`, every result; otherwise the results up to and including this page (a
    /// lower bound: WT Live's feed doesn't say how many posts match).
    pub total: u64,
    pub took_ms: u64,
    /// Another page exists.
    pub has_more: bool,
    pub total_exact: bool,
}

/// What Livery keeps of WT Live on this computer (Settings → WT Live).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WtLiveStorage {
    /// Size of the response and archive cache.
    pub cache_bytes: u64,
    /// Posts hidden from Explore and Following.
    pub hidden_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FollowKind {
    Vehicle,
    Author,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowEntry {
    pub kind: FollowKind,
    /// Vehicle code or author id.
    pub id: String,
    pub name: String,
    /// RFC 3339; skins posted after it count as new.
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallMode {
    Normal,
    Temporary,
}

/// Settings → About → Send feedback: what the user may attach (`feedback_diagnostics`). Shown in
/// full before anything leaves the app; the log lines are already anonymised.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackDiagnostics {
    pub app_version: String,
    /// "Windows 11 24H2 (build 26100.2894)".
    pub os: String,
    /// The last lines of `livery.log`, oldest first.
    pub log_tail: Vec<String>,
}

// ── For you (lineups from the player's profile) ─────────────────────────────

/// What `game_lineups` found. `Off`: reading the game's data is off. `NoProfile`: no
/// `global.blk`. `NoLineups`: the profile has no usable preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineupsStatus {
    Ok,
    Off,
    NoProfile,
    NoLineups,
}

/// The player's lineups (slotbar presets), read from War Thunder's profile file (`game::profile`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lineups {
    pub status: LineupsStatus,
    /// RFC 3339: when the game last wrote the profile file.
    pub saved_at: Option<String>,
    /// The vehicle selected in the hangar right now (`selectedAir.current_model`).
    pub current: Option<String>,
    pub current_nation: Option<Nation>,
    /// Game nation order; nations without a usable preset are left out.
    pub nations: Vec<NationLineups>,
}

impl Lineups {
    /// No lineups, with `status` saying why.
    pub fn empty(status: LineupsStatus) -> Self {
        Self { status, saved_at: None, current: None, current_nation: None, nations: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NationLineups {
    pub nation: Nation,
    /// File order.
    pub presets: Vec<Preset>,
}

/// One lineup (slotbar preset) of a nation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    /// Position in the nation's preset list in the file, from 0, counting the ones Livery
    /// leaves out (strings that don't parse, presets without vehicles): "Preset N" is `index + 1`.
    pub index: u32,
    /// The player's text, trimmed (may be empty: the UI shows "Preset N").
    pub name: String,
    pub active: bool,
    /// Vehicle codes, file order, no empty or duplicate codes.
    pub vehicles: Vec<String>,
}

/// A new skin for For you, with the lineup vehicle it was matched to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForYouSkin {
    pub vehicle: String,
    pub skin: WtLiveSkin,
}

/// `wtlive_for_you_new`: new skins, and how many vehicles from the start of the asked list
/// were covered (the rest weren't checked: request cap or a failed later request).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForYouNew {
    pub items: Vec<ForYouSkin>,
    pub checked: u32,
}

// ── Atelier (skin editor) ───────────────────────────────────────────────────

/// A project as the Atelier home lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtelierProjectSummary {
    pub id: String,
    pub name: String,
    /// Vehicle code, e.g. `us_m4a3e2_sherman_jumbo`.
    pub vehicle: String,
    /// RFC 3339 UTC timestamp.
    pub updated_at: String,
    pub has_thumb: bool,
}

/// One paintable texture of the vehicle (`<base>_c`) and whether the user paints it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtelierSlotChoice {
    pub texture: String,
    pub enabled: bool,
}

/// Export options of a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AtelierOutput {
    /// The body slot goes to 4096 when its template is smaller.
    pub high_quality: bool,
}

/// `project.json` of an Atelier project. Rust checks the envelope; `layers` belongs to the
/// frontend (bottom to top, `layers[0]` the Base) and is stored as it comes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtelierProject {
    /// Schema version, 1.
    pub version: u32,
    pub id: String,
    pub name: String,
    pub vehicle: String,
    /// RFC 3339 UTC timestamps.
    pub created_at: String,
    pub updated_at: String,
    pub slots: Vec<AtelierSlotChoice>,
    #[serde(default)]
    pub output: AtelierOutput,
    /// The library id of the skin the last apply installed (never a path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_skin_id: Option<String>,
    pub layers: serde_json::Value,
}

/// A picture of a project (`assets/<id>.png`, RGBA8, at most 4096 on a side).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    pub id: String,
    pub width: u32,
    pub height: u32,
}

/// An installed font Atelier's text layers can use (`.ttf`/`.otf` listed in the Windows registry).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    /// e.g. `Segoe UI`.
    pub family: String,
    /// e.g. `Regular`, `Bold Italic`.
    pub style: String,
    /// The font's file name only (no folders).
    pub file: String,
}

/// The background-removal files on this PC (`atelier_cutout_status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoutStatus {
    /// ONNX Runtime is installed (false while a removal waits for a restart).
    pub runtime: bool,
    /// The isnet-anime model is downloaded (false while a removal waits for a restart).
    pub model: bool,
    /// Bytes the files take on disk now.
    pub bytes: u64,
    /// Bytes still to download before background removal can run (0 when ready).
    pub download_bytes: u64,
    /// A remove couldn't delete everything (the runtime was in use): it finishes at the next
    /// launch, and downloads are refused until then.
    pub pending_removal: bool,
}

/// Which file a download progress event is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadItem {
    Runtime,
    Model,
}

/// Payload of `atelier://download-progress` (at most 10 a second per download).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub item: DownloadItem,
    pub received: u64,
    pub total: u64,
}

/// Steps of a background removal (`atelier://cutout-progress`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CutoutStep {
    /// Loading the runtime and the model (the first time in a session, or after 5 idle minutes).
    Load,
    Run,
    Write,
}

/// Payload of `atelier://cutout-progress`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoutProgress {
    pub step: CutoutStep,
}

/// A rectangle in pixels of the source picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// `atelier_cutout`: the new picture (the original stays) and where it was cut from the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoutResult {
    pub asset: AssetRef,
    pub crop: PixelRect,
}

/// Rust's steps of an apply (`atelier://apply-progress`); the bake before them is the frontend's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplyStep {
    Encode,
    Write,
    Install,
    Done,
    Error,
}

/// Payload of `atelier://apply-progress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProgress {
    pub apply_id: String,
    pub step: ApplyStep,
    /// 0–100 within Rust's part of the apply (encode, write, install).
    pub pct: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// done: the installed skin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skin_id: Option<String>,
    /// done after a replace: the backup of the previous version (drives Undo).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_id: Option<String>,
}

/// `atelier_apply_begin`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyStarted {
    pub apply_id: String,
}

/// `atelier_apply_commit`: the installed skin and, after a replace, the backup Undo restores.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub skin: HangarSkin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_id: Option<String>,
}
