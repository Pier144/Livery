# Data model, commands and events

Shared shapes for TS (`src/types.ts`) and Rust (`src-tauri/src/model.rs`, `serde` with `rename_all = "camelCase"`). Keep both in sync; generate TS from Rust with `ts-rs` if preferred.

## Domain facts (War Thunder user skins)
- Skins live in `<gameRoot>/UserSkins/<folder>/`. One folder = one skin.
- Inside: exactly one `<vehicleCode>.blk` (the file *name* is the vehicle's internal code, e.g. `us_m1a2_abrams.blk`, `bf-109f-4.blk`) plus textures (`.dds`, rarely `.tga`). The blk lists which texture files replace which game textures.
- **Vehicle detection** = the blk filename. If an archive contains several blk files in different folders → status `needsLook` ("Pick one").
- In game: Hangar → vehicle → Customisation → user skins list → refresh button rescans `UserSkins`. Livery cannot trigger this; the UI instructs the user (Try in game step 02).
- Game roots: Steam appid `236390` (read `libraryfolders.vdf`); standalone launcher (typically `%LOCALAPPDATA%\\WarThunder` or `C:\\Program Files (x86)\\WarThunder`); custom. Valid root = contains `UserSkins/` or `aces.exe`/`launcher.exe`. Create `UserSkins/` if missing.
- WT Live (`live.warthunder.com`) has **no public API**. `wtlive` module fetches listing/post HTML, parses (`scraper` crate), caches to SQLite for 24 h and respects a 1 req/s limit with a Livery user-agent. Parsing lives behind a trait so it can be swapped when the site changes; failures surface as `online = false`, never as a crash.

## TypeScript types
```ts
export type Nation = 'USA'|'GER'|'USSR'|'GBR'|'JPN'|'CHN'|'ITA'|'FRA'|'SWE'|'ISR';
export type VehicleType = 'ground'|'air'|'heli'|'naval';
export type Category = 'Historical'|'Semi-historical'|'Fictional'|'Camouflage'|'Other';
export type Origin = 'wtlive'|'imported'|'mine';

export interface Vehicle { code: string; name: string; nation: Nation; type: VehicleType; class: string; rank?: number }
export interface Author { id: string; name: string; url: string; skinCount?: number }

export interface WtLiveSkin {           // from Explore / WT Live
  id: string; name: string; vehicle: Vehicle; author: Author; category: Category;
  downloads: number; likes: number; postedAt: string; sizeBytes: number;
  images: string[]; postUrl: string; downloadUrl: string; files?: FileEntry[]; isNew?: boolean;
}
export interface FileEntry { path: string; sizeBytes: number }
export interface TextureInfo { file: string; width?: number; height?: number; format?: string; sizeBytes?: number; warning?: string; missing?: boolean }

export type Attention = 'missingTexture'|'unknownBlkBlock'|'partialExtract'|'noBlk';
export interface HangarSkin {           // installed, indexed by library
  id: string; folder: string; name: string; vehicle: Vehicle; origin: Origin; author?: Author;
  sizeBytes: number; active: boolean; installedAt: string; sourceId?: string;      // WtLiveSkin.id
  attention?: { kind: Attention; message: string; file?: string }[];
  temporary?: boolean;                  // Try in game
}
export interface Collection { id: string; name: string; description?: string; skinIds: string[]; createdAt: string }

export type QueueStatus = 'analyzing'|'ready'|'conflict'|'needsLook'|'installing'|'done'|'error';
export interface QueueItem {
  id: string; path: string; fileName: string; sizeBytes: number; status: QueueStatus;
  vehicle?: Vehicle; candidates?: Vehicle[];       // needsLook
  conflictWith?: string;                           // HangarSkin.id
  files?: FileEntry[]; textureCount?: number; blkOk?: boolean; note?: string; error?: string;
}

export type InstallStep = 'download'|'extract'|'verify'|'done'|'error';
export interface InstallProgress { installId: string; step: InstallStep; pct: number; message?: string }
export type ConflictPolicy = 'ask'|'replace'|'copy'|'skip';

export interface Settings {
  gamePath?: string; gameSource?: 'steam'|'standalone'|'custom'; gameVersion?: string;
  watchFolder?: string; autoInstall: boolean; conflictPolicy: ConflictPolicy;
  backups: boolean; backupDays: 30; language: 'en'|'it'|'de'|'ru'|'fr'; autoUpdate: boolean; startWithWindows: boolean;
}
export interface GameDetection { found: boolean; source?: Settings['gameSource']; path?: string; version?: string; existingSkins: number }
export interface Backup { id: string; skinId: string; name: string; sizeBytes: number; createdAt: string; reason: 'replace'|'delete' }
```

## Tauri commands (`invoke`)
| command | args | returns | notes |
|---|---|---|---|
| `detect_game` | — | `GameDetection` | emits `game://detect` `{source, state: 'checking'|'found'|'notFound'}` per source so First run can animate rows |
| `set_game_path` | `{path}` | `GameDetection` | validates; creates UserSkins |
| `scan_user_skins` | — | `HangarSkin[]` | full rescan + attention checks; also used by "Re-check" |
| `get_hangar` | — | `HangarSkin[]` | from index |
| `set_skin_active` | `{ids, active}` | `HangarSkin[]` | inactive = folder renamed to `_<folder>` … or moved to `<appData>/inactive/` (choose one; document it) |
| `delete_skins` | `{ids}` | `{backupIds}` | backup first if `settings.backups` |
| `restore_backup` | `{backupId}` | `HangarSkin` | drives Undo |
| `list_backups` / `clear_backups` | — | `Backup[]` / `void` | |
| `export_skins` | `{ids, dest}` | `void` | zip per skin |
| `analyze_archive` | `{path}` | `QueueItem` | zip/rar/7z via `zip`, `unrar`, `sevenz-rust`; never extracts yet |
| `install_from_archive` | `{queueId, vehicleCode?, conflict?: ConflictPolicy}` | `{installId}` | emits `install://progress` |
| `install_from_wtlive` | `{skinId, mode: 'normal'|'temporary', conflict?}` | `{installId}` | download → analyze → install; emits progress |
| `finalize_try` | `{skinId, keep}` | `HangarSkin | null` | keep → clears `temporary`; discard → removes folder |
| `read_textures` | `{skinId | queueId | wtliveId}` | `TextureInfo[]` | DDS/TGA header parse only (first 128 B) |
| `collections_*` | CRUD | `Collection[]` | `activate_collection({id})` sets active per skin, returns hangar |
| `watch_folder` | `{path, enabled}` | `void` | `notify` crate; new `*.zip|rar|7z` → `queue://added` |
| `wtlive_search` | `{q?, nation?, type?, class?, vehicle?, category?, sort, page}` | `{items: WtLiveSkin[], total, tookMs}` | `tookMs` shown in UI |
| `wtlive_post` | `{id}` | `WtLiveSkin` | full post incl. files/images |
| `wtlive_following_new` | `{vehicles: string[], authors: string[]}` | `WtLiveSkin[]` | since last visit |
| `get_settings` / `set_settings` | — / `Partial<Settings>` | `Settings` | JSON in app data dir |
| `check_update` | — | `{current, latest?, notes?}` | `tauri-plugin-updater` |

## Events (`listen`)
- `install://progress` → `InstallProgress` (throttle UI to ~30 fps).
- `queue://added` → `QueueItem` (from watcher or drop).
- `game://detect` → `{source, state}`.
- `net://status` → `{online: boolean}` (from wtlive failures/successes).
- `hangar://changed` → `void` (external changes seen by the watcher on UserSkins → refetch).

## SQLite (`<appData>/livery.db`, `rusqlite` bundled)
```
skins(id TEXT PK, folder, name, vehicle_code, origin, author_json, size_bytes INT, active INT, installed_at, source_id, temporary INT, attention_json)
collections(id PK, name, description, created_at) · collection_skins(collection_id, skin_id)
backups(id PK, skin_id, name, size_bytes, created_at, reason, path)
wtlive_cache(key PK, json, fetched_at) · following(kind, id, name, last_seen_at)
```

## Frontend store (Zustand slices)
`ui` {screen, sidebarOpen, palette, toasts, online} · `explore` {tab, filters, sort, page} · `installs` Record<installId, InstallProgress> + skinId↔installId map · `detail` {skinId, tab, galleryIndex, zoom, compareWith, tryState} · `hangar` {view, q, filters, selection} · `collections` · `queue` {items, conflictDialogId} · `settings`. Server data (hangar, collections, wtlive) lives in TanStack Query; the store holds only UI state and optimistic overlays.
