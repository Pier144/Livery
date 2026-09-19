// Shared shapes — keep in sync with src-tauri/src/model.rs (see design_handoff_livery/DATA_MODEL.md).

/** `UNK`: a vehicle code missing from the local catalog whose nation can't be inferred (see DESIGN_NOTES). */
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
}
export interface FileEntry {
  path: string;
  sizeBytes: number;
}
export interface TextureInfo {
  file: string;
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
  /** HangarSkin.id */
  conflictWith?: string;
  files?: FileEntry[];
  textureCount?: number;
  blkOk?: boolean;
  note?: string;
  error?: string;
}

export type InstallStep = 'download' | 'extract' | 'verify' | 'done' | 'error';
export interface InstallProgress {
  installId: string;
  step: InstallStep;
  pct: number;
  message?: string;
}
export type ConflictPolicy = 'ask' | 'replace' | 'copy' | 'skip';
export type GameSource = 'steam' | 'standalone' | 'custom';
export type Language = 'en' | 'it' | 'de' | 'ru' | 'fr';

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
  /** First run finished or skipped; the app then opens on Explore. (Not in DATA_MODEL; see DESIGN_NOTES.) */
  onboarded: boolean;
}
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

/** Serialized form of the Rust `AppError`. */
export interface AppError {
  code: string;
  message: string;
  detail?: string;
}

/** Top-level sections reachable from the sidebar (keys 1–5). */
export type Section = 'explore' | 'hangar' | 'collections' | 'queue' | 'settings';
/** Everything the main area can show. First run hides the sidebar and disables section keys. */
export type Screen = Section | 'firstRun';
