// Shared shapes — keep in sync with src-tauri/src/model.rs.

/** `UNK`: a vehicle code missing from the local catalog whose nation can't be inferred. */
export type Nation = 'USA' | 'GER' | 'USSR' | 'GBR' | 'JPN' | 'CHN' | 'ITA' | 'FRA' | 'SWE' | 'ISR' | 'UNK';
export type VehicleType = 'ground' | 'air' | 'heli' | 'naval';
export type Category = 'Historical' | 'Semi-historical' | 'Fictional' | 'Camouflage' | 'Other';
export type Origin = 'wtlive' | 'imported' | 'mine';

export interface Vehicle {
  code: string;
  name: string;
  nation: Nation;
  type: VehicleType;
  class: string;
  rank?: number;
}
export interface Author {
  id: string;
  name: string;
  url: string;
  skinCount?: number;
}

/** From Explore / WT Live. */
export interface WtLiveSkin {
  id: string;
  name: string;
  vehicle: Vehicle;
  author: Author;
  category: Category;
  downloads: number;
  likes: number;
  postedAt: string;
  sizeBytes: number;
  images: string[];
  postUrl: string;
  downloadUrl: string;
  files?: FileEntry[];
  isNew?: boolean;
  /** The author's text and the pictures embedded in it (`wtlive_post` only, never the feed). */
  description?: PostDescription;
}
/** A post's description as plain data (never HTML): paragraphs of runs, hashtags taken out. */
export interface PostDescription {
  paragraphs: PostRun[][];
  /** Hashtags, lower-cased, in order. */
  tags: string[];
  /** Pictures embedded in the text (https, WT Live's image hosts). */
  images: string[];
}
export type PostRun =
  | { kind: 'text'; text: string; bold?: boolean; italic?: boolean }
  /** A WT Live page (links to other sites go through WT Live's `/away/` page). */
  | { kind: 'link'; text: string; url: string }
  | { kind: 'break' };
export interface FileEntry {
  path: string;
  sizeBytes: number;
}
/** Localizable warning kind (the backend also sends English text in `warning`). */
export type TextureWarningKind = 'unreadable' | 'notSquarePow2' | 'heavy' | 'missing';
export interface TextureInfo {
  file: string;
  warningKind?: TextureWarningKind;
  width?: number;
  height?: number;
  format?: string;
  sizeBytes?: number;
  warning?: string;
  missing?: boolean;
}

export type Attention = 'missingTexture' | 'unknownBlkBlock' | 'partialExtract' | 'noBlk' | 'unreadableBlk';
/** Installed, indexed by the library. */
export interface HangarSkin {
  id: string;
  folder: string;
  name: string;
  vehicle: Vehicle;
  origin: Origin;
  author?: Author;
  sizeBytes: number;
  active: boolean;
  installedAt: string;
  /** WtLiveSkin.id */
  sourceId?: string;
  attention?: { kind: Attention; message: string; file?: string }[];
  /** Try in game */
  temporary?: boolean;
  /** The WT Live post's picture (https), stored at install; the Hangar card shows it. */
  preview?: string;
}
export interface Collection {
  id: string;
  name: string;
  description?: string;
  skinIds: string[];
  createdAt: string;
}

export type QueueStatus = 'analyzing' | 'ready' | 'conflict' | 'needsLook' | 'installing' | 'done' | 'error';
export interface QueueItem {
  id: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  status: QueueStatus;
  vehicle?: Vehicle;
  /** needsLook */
  candidates?: Vehicle[];
  /**
   * Who already uses the target folder: a HangarSkin.id, `disk:<folder>` (on disk, not in the library)
   * or `queue:<queueId>` (another queued item installs under the same name).
   */
  conflictWith?: string;
  /** Folder name it will be installed as inside UserSkins. */
  targetFolder?: string;
  files?: FileEntry[];
  textureCount?: number;
  blkOk?: boolean;
  note?: string;
  error?: string;
}

export type InstallStep = 'download' | 'extract' | 'verify' | 'done' | 'error';
export interface InstallProgress {
  installId: string;
  queueId?: string;
  step: InstallStep;
  pct: number;
  message?: string;
  /** done: the installed skin. */
  skinId?: string;
  /** done after a Replace: backup of the previous version (drives Undo). */
  backupId?: string;
}
export interface InstallStarted {
  installId: string;
}
/** `net://status`: whether WT Live can be reached (the backend emits it when that changes). */
export interface NetStatus {
  online: boolean;
}

/** Backend events (`listen`). */
export const EVENTS = {
  installProgress: 'install://progress',
  queueAdded: 'queue://added',
  hangarChanged: 'hangar://changed',
  netStatus: 'net://status',
} as const;
export type ConflictPolicy = 'ask' | 'replace' | 'copy' | 'skip';
export type GameSource = 'steam' | 'standalone' | 'custom';
export type Language = 'en' | 'it' | 'de' | 'ru' | 'fr' | 'es' | 'pl' | 'pt-BR' | 'zh-CN';

export interface Settings {
  gamePath?: string;
  gameSource?: GameSource;
  gameVersion?: string;
  watchFolder?: string;
  autoInstall: boolean;
  conflictPolicy: ConflictPolicy;
  backups: boolean;
  backupDays: 30;
  language: Language;
  autoUpdate: boolean;
  startWithWindows: boolean;
  /** First run finished or skipped; the app then opens on Explore. */
  onboarded: boolean;
  /** Settings → General → Reduce motion; `system` follows Windows. */
  reduceMotion: ReduceMotion;
  /**
   * Settings → WT Live → Browse WT Live (default true). Off: Explore, Following, the WT Live Skin
   * detail and installs from WT Live send no request at all.
   */
  wtliveEnabled: boolean;
  /** Settings → Game: read the vehicle list from the game's data archives (off: built-in list). */
  readGameData: boolean;
}
/** `set_settings({ patch })`: the fields to change. */
export type SettingsPatch = Partial<Settings>;
export type ReduceMotion = 'system' | 'on' | 'off';
export interface GameDetection {
  found: boolean;
  source?: GameSource;
  /** Game root (holds `launcher.exe` / `UserSkins`). Hidden in the UI unless "Show path". */
  path?: string;
  /** Full version from `content/pkg_main.ver`, e.g. "2.59.0.13". */
  version?: string;
  existingSkins: number;
}
/** `game://detect` payload: one event per source and state change while `detect_game` runs. */
export type DetectState = 'checking' | 'found' | 'notFound' | 'skipped';
export interface DetectEvent {
  source: GameSource;
  state: DetectState;
}
export const DETECT_EVENT = 'game://detect';
export interface Backup {
  id: string;
  skinId: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  reason: 'replace' | 'delete';
}

export interface CollectionsState {
  collections: Collection[];
  /** The collection activated last (its skins are the active ones), if any. */
  activeCollectionId?: string;
}
export interface DeleteResult {
  /** One per deleted skin; `restore_backups` undoes the delete. */
  backupIds: string[];
}
export interface ExportResult {
  exported: number;
  dest: string;
}

/** Serialized form of the Rust `AppError`. */
export interface AppError {
  code: string;
  message: string;
  detail?: string;
}

/** Top-level sections reachable from the sidebar (keys 1–5). */
export type Section = 'explore' | 'hangar' | 'collections' | 'queue' | 'settings';
/** Everything the main area can show. First run hides the sidebar and disables section keys. */
export type Screen = Section | 'firstRun' | 'detail';

// ── WT Live (M5) ─────────────────────────────────────────────────────────────

export type SortOrder = 'downloads' | 'likes' | 'newest' | 'name';
export interface SearchParams {
  q?: string;
  nation?: Nation;
  type?: VehicleType;
  class?: string;
  /** Vehicle code. */
  vehicle?: string;
  category?: Category;
  sort: SortOrder;
  page: number;
}
export interface SearchResult {
  items: WtLiveSkin[];
  /**
   * With `totalExact`, every result of the search. Otherwise a lower bound: the results up to and
   * including this page (it grows as pages load), shown as "75+ results".
   */
  total: number;
  /** Server + parse time, shown as "1,284 results · 24 ms". */
  tookMs: number;
  /** Another page exists (WT Live's feed has no total count, so paging follows this). */
  hasMore: boolean;
  /** `total` is the full count rather than a lower bound. */
  totalExact: boolean;
}
export type FollowKind = 'vehicle' | 'author';
export interface FollowEntry {
  kind: FollowKind;
  /** Vehicle code or author id. */
  id: string;
  name: string;
  /** RFC 3339; skins posted after it count as new. */
  lastSeenAt: string;
}
export type InstallMode = 'normal' | 'temporary';
/** `wtlive_storage` and friends: what Livery keeps from WT Live on this PC (local, works offline). */
export interface WtLiveStorage {
  /** Pages and archives fetched from WT Live (kept up to 24 hours). */
  cacheBytes: number;
  /** WT Live skins hidden from Explore and Following. */
  hiddenCount: number;
}

/** `check_update`: `{ current, latest?, notes? }`, plus `ready` (already downloaded). */
export interface UpdateInfo {
  current: string;
  /** The newer version on offer; absent when Livery is up to date. */
  latest?: string;
  notes?: string;
  ready: boolean;
}

/** `update://progress` while a new version downloads. */
export interface UpdateProgress {
  downloaded: number;
  total?: number;
}

/** `update://ready`: a background download is verified and installs when Livery closes. */
export interface UpdateReady {
  version: string;
}

/** Settings → About → Send feedback: what the page on GitHub is about. */
export type FeedbackKind = 'bug' | 'idea' | 'other';

/** `feedback_diagnostics`: what the user may attach. The log lines are already anonymised. */
export interface FeedbackDiagnostics {
  appVersion: string;
  /** "Windows 11 24H2 (build 26100.2894)". */
  os: string;
  /** The last lines of livery.log, oldest first. */
  logTail: string[];
}

// ── For you (lineups from the War Thunder profile) ───────────────────────────

/**
 * `game_lineups`: `off` (Settings → Game → Read data from the game is off: nothing read),
 * `noProfile` (no War Thunder profile on this PC), `noLineups` (a profile without a usable lineup).
 */
export type LineupsStatus = 'ok' | 'off' | 'noProfile' | 'noLineups';
/** The player's lineups (slotbar presets), read from War Thunder's profile file. */
export interface Lineups {
  status: LineupsStatus;
  /** RFC 3339: when the game last wrote the profile file (serde sends `null` for none). */
  savedAt?: string | null;
  /** The vehicle selected in the hangar right now. */
  current?: string | null;
  currentNation?: Nation | null;
  /** Game nation order; nations without a usable preset are left out. */
  nations: NationLineups[];
}
export interface NationLineups {
  nation: Nation;
  /** File order. */
  presets: Preset[];
}
/** One lineup (slotbar preset) of a nation. */
export interface Preset {
  /** The player's text, trimmed; empty → the UI shows "Preset N". */
  name: string;
  active: boolean;
  /** Vehicle codes, file order, no empty or duplicate codes. */
  vehicles: string[];
}
/** A new skin for For you, with the lineup vehicle it was matched to. */
export interface ForYouSkin {
  vehicle: string;
  skin: WtLiveSkin;
}
/**
 * `wtlive_for_you_new`: new skins, and how many vehicles from the start of the asked list were
 * covered (the rest weren't checked: request cap or a failed later request).
 */
export interface ForYouNew {
  items: ForYouSkin[];
  checked: number;
}
