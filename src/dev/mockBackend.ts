// In-browser mock backend for `pnpm dev:mock` (vite --mode mock; `.env.mock` sets
// VITE_MOCK_BACKEND=1). `call()` in src/lib/tauri.ts routes every command here when the page runs
// outside Tauri, so the UI can be exercised and compared with the prototype in a plain browser.
//
// Dev only: this module is reached solely through the dynamic imports behind `MOCK_BACKEND`
// (src/lib/tauri.ts, src/queries/game.ts), which a production build folds away.
//
// It implements every command registered in src-tauri/src/lib.rs with the same argument names
// (camelCase, as Tauri 2 exposes them), result shapes (src/types.ts), error codes and messages,
// and follows the Rust semantics (library/ops.rs, library/collections.rs, backup.rs): unknown ids
// are ignored, a deleted skin keeps its collection memberships while its backup exists, backups
// made while "Keep a backup" is off are ephemeral (Undo only, gone after a minute), a restore whose
// folder name is taken comes back as "<folder> (2)". Arguments and results go through JSON like
// Tauri's IPC, so `undefined` fields are dropped exactly as they would be. Errors reject with
// `{ code, message, detail? }`. State lives in memory and resets on reload. Each command answers
// after 80–250 ms (`analyze_archive` takes three times as long, so "Analyzing…" shows).
//
// Install queue (M4). Only skin folders install for now; `analyze_archive` looks at the last
// segment of the path:
//   *.zip / *.rar / *.7z   an `error` item: unpacking needs a library that isn't approved yet
//                          (installing it rejects `unsupported` with the same message)
//   "notaskin"             rejects invalidInput "Not a skin folder or archive"
//   contains "pack"        `needsLook`: three skin folders inside (Su-27, F-4E, Bf 109 G-6)
//   an installed folder    `conflict` with that skin, e.g. "germ_leopard_2a6_Kessler_Wolf"
//   anything else          `ready`, installing as that folder; the vehicle is guessed from the name
// Items are kept newest first, like the Install queue lists them. `install_from_archive` answers
// `{ installId }` at once, then `install://progress` walks extract 0→80, verify →95 and `done`
// (with `skinId`) over ~2 s; the skin joins the index at `done`. Picking a vehicle narrows a
// needsLook item to that skin. A folder name already in use follows the `conflict` argument, or
// Settings → Conflicts when it's omitted: ask → rejects `conflict`; replace → the installed
// version goes to a backup (reason replace; the new version keeps its id, so collections stay)
// and `done` carries `backupId` for `undo_replace`; copy → "<folder> (2)"; skip → `done` with
// message "skipped", nothing installed, the item leaves the queue. `read_textures` lists headers
// like the prototype's Textures tab: h1 has an 8192² hull (heavy), h3 lacks turret_c.dds, the
// queued Spitfire lacks cockpit_c.tga. `watch_folder` saves watchFolder/autoInstall.
// Events (`mockListen` / `mockEmit`) arrive asynchronously, each listener with its own JSON copy.
// The queue starts with the prototype's three items: a conflict, a ready one, one to look at.
//
// Start-up switches — a query parameter, or a localStorage key set to "1" (then reload):
//   ?onboarded=1  livery.mock.onboarded  skip First run: onboarded, Steam game folder saved
//   ?empty=1      livery.mock.empty      empty library, no collections, no backups, empty queue
//   ?many=1       livery.mock.many       ~1,000 skins in the hangar (scroll performance check)
//   ?notfound=1   livery.mock.notfound   detection finds nothing ("Can't find War Thunder"); a
//                                        folder whose path contains "War Thunder" is accepted
//   ?watch=1      livery.mock.watch      "Watch Downloads folder" starts on, and 3 s after load a
//                                        new folder, tiger2_h_ambush_winter, arrives through
//                                        `queue://added` (unless watching was turned off by then)
// A query parameter wins over localStorage; `=0` turns a stored switch off for that load.
// Without switches the app opens on First run (onboarded: false, no game folder), which saves the
// Steam folder; until a folder is saved, commands that touch UserSkins fail like the real app
// ("No game folder set").

import { DEFAULT_SETTINGS } from '@/queries/settings';
import {
  EVENTS,
  type AppError,
  type Backup,
  type Collection,
  type CollectionsState,
  type ConflictPolicy,
  type DeleteResult,
  type DetectEvent,
  type DetectState,
  type ExportResult,
  type GameDetection,
  type GameSource,
  type HangarSkin,
  type InstallProgress,
  type InstallStarted,
  type InstallStep,
  type Language,
  type QueueItem,
  type Settings,
  type TextureInfo,
} from '@/types';
import {
  MOCK_DOWNLOADS,
  MOCK_GAME,
  WATCHED_FOLDER,
  hangarTextures,
  nameHash,
  seedBackups,
  seedCollections,
  seedDiskOnly,
  seedHangar,
  seedManyHangar,
  seedQueue,
  sourceRoots,
  type MockSkinRoot,
  type StoredBackup,
} from './mockData';

// ── Start-up switches ───────────────────────────────────────────────────────

type Flag = 'onboarded' | 'empty' | 'notfound' | 'many' | 'watch';

function readFlag(name: Flag): boolean {
  try {
    const value = new URLSearchParams(window.location.search).get(name);
    if (value !== null) return value !== '0' && value !== 'false';
  } catch {
    // No window: fall back to storage.
  }
  try {
    return localStorage.getItem(`livery.mock.${name}`) === '1';
  } catch {
    return false;
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

type Handler = (payload: unknown) => void;
/** One per `mockListen` call, so the same handler registered twice runs twice (like Tauri). */
interface Subscription {
  handler: Handler;
}
const subscriptions = new Map<string, Set<Subscription>>();

/**
 * Mock counterpart of Tauri's `listen`, used by src/lib/events.ts. Returns the unlisten
 * function; calling it more than once is harmless.
 */
export function mockListen<T>(name: string, handler: (payload: T) => void): () => void {
  const subscription: Subscription = { handler: handler as Handler };
  const set = subscriptions.get(name) ?? new Set<Subscription>();
  set.add(subscription);
  subscriptions.set(name, set);
  return () => {
    const current = subscriptions.get(name);
    if (!current?.delete(subscription)) return;
    if (current.size === 0) subscriptions.delete(name);
  };
}

/**
 * Emits a backend event like Tauri does: the payload is serialized now (`undefined` → `null`,
 * later changes to the object don't leak), every listener subscribed at this moment gets its own
 * parsed copy in a later microtask, in emit order, unless it unlistened in between. A throwing
 * listener is reported and doesn't stop the others.
 */
export function mockEmit(name: string, payload?: unknown): void {
  const listeners = [...(subscriptions.get(name) ?? [])];
  if (listeners.length === 0) return;
  const json = JSON.stringify(payload ?? null);
  queueMicrotask(() => {
    for (const subscription of listeners) {
      if (!subscriptions.get(name)?.has(subscription)) continue;
      try {
        subscription.handler(JSON.parse(json));
      } catch (error) {
        if (typeof reportError === 'function') reportError(error);
        else console.error(error);
      }
    }
  });
}

// ── Timers ──────────────────────────────────────────────────────────────────

/** Background work (install progress, the watcher) waiting to run; a reset cancels it. */
const timers = new Set<ReturnType<typeof setTimeout>>();
let timeScale = 1;
/** `?watch=1`: when the new folder shows up after load (declared here: start-up uses it). */
const WATCH_DELAY_MS = 3000;

/** Runs `task` after `ms` × the configured time scale, unless the mock was reset meanwhile. */
function later(ms: number, task: () => void): void {
  const owner = state;
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (state === owner) task();
  }, ms * timeScale);
  timers.add(timer);
}

// ── State ───────────────────────────────────────────────────────────────────

/** A queue item plus what the mock found inside it (the Rust `QueueStore` keeps the same). */
interface StoredQueueItem {
  item: QueueItem;
  /** Skin roots inside; several → needsLook. None for an archive it can't open. */
  roots: MockSkinRoot[];
}

interface MockState {
  settings: Settings;
  /** The library index (My Hangar), in index order. */
  index: HangarSkin[];
  /** Folders in UserSkins the index doesn't know (scan reports them as `disk:<folder>`). */
  diskOnly: HangarSkin[];
  collections: Collection[];
  activeCollectionId?: string;
  /** In the order they were made (oldest first), like the Rust index. */
  backups: StoredBackup[];
  /** The install queue, newest first. */
  queue: StoredQueueItem[];
  /** `read_textures` rows of skins the mock installed (the others are made up per vehicle). */
  textures: Map<string, TextureInfo[]>;
  detectNothing: boolean;
  nextId: number;
}

function createState(): MockState {
  const onboarded = readFlag('onboarded');
  const empty = readFlag('empty');
  const seeded = empty ? undefined : seedCollections();
  const created: MockState = {
    settings: {
      ...DEFAULT_SETTINGS,
      ...(onboarded
        ? { onboarded: true, gamePath: MOCK_GAME.path, gameSource: 'steam' as const, gameVersion: MOCK_GAME.version }
        : {}),
      ...(readFlag('watch') ? { watchFolder: MOCK_DOWNLOADS, autoInstall: true } : {}),
    },
    index: empty ? [] : readFlag('many') ? seedManyHangar() : seedHangar(),
    diskOnly: seedDiskOnly(),
    collections: seeded?.collections ?? [],
    activeCollectionId: seeded?.activeCollectionId,
    backups: empty ? [] : seedBackups(Date.now()).reverse(),
    queue: [],
    textures: new Map(),
    detectNothing: readFlag('notfound'),
    nextId: 1,
  };
  if (!empty) {
    created.queue = seedQueue().map(({ id, path, roots }) => ({ item: describeSource(created, id, path, roots), roots }));
  }
  return created;
}

let state = createState();
let latency: [number, number] = [80, 250];
startWatcher();

/** Back to the start-up state (switches are read again, pending work and listeners dropped). For tests. */
export function resetMockBackend(): void {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  subscriptions.clear();
  state = createState();
  startWatcher();
}

/**
 * Tests pass `{ latency: [0, 0] }` so round-trips don't wait, and `timeScale: 0` so installs and
 * the watcher run on the next tick instead of taking seconds.
 */
export function configureMockBackend(options: { latency?: [number, number]; timeScale?: number }): void {
  if (options.latency) latency = options.latency;
  if (options.timeScale !== undefined) timeScale = Math.max(0, options.timeScale);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Waits `scale` × a random latency in the configured range. */
function pause(scale = 1): Promise<void> {
  const [min, max] = latency;
  const ms = (min + Math.random() * Math.max(0, max - min)) * scale;
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Serialize like Tauri's IPC: a deep copy with `undefined` fields dropped. */
function wire<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function fail(code: string, message: string, detail?: string): never {
  const error: AppError = detail === undefined ? { code, message } : { code, message, detail };
  throw error;
}

/** What Tauri reports for a missing or mistyped argument (a string, which `toAppError` wraps). */
function badArg(cmd: string, key: string): never {
  return fail('internal', `invalid args \`${key}\` for command \`${cmd}\``);
}

type Args = Record<string, unknown>;

function str(cmd: string, args: Args, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : badArg(cmd, key);
}

function optStr(cmd: string, args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : badArg(cmd, key);
}

function strList(cmd: string, args: Args, key: string): string[] {
  const value: unknown = args[key];
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) return badArg(cmd, key);
  return value;
}

function bool(cmd: string, args: Args, key: string): boolean {
  const value = args[key];
  return typeof value === 'boolean' ? value : badArg(cmd, key);
}

/** RFC 3339 UTC without milliseconds, as `time::rfc3339_utc` writes it. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function newId(prefix: string): string {
  const id = `${prefix}-mock-${state.nextId}`;
  state.nextId += 1;
  return id;
}

/** Folder names compare case-insensitively, like the Windows file system. */
function folderKey(folder: string): string {
  return folder.toLowerCase();
}

/** `ids` without repeats, first occurrence first. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `name`, or `name (2)`, `(3)`… when taken (`layout::unique_name`). */
function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} (${n})`;
    if (!taken(candidate)) return candidate;
  }
}

// ── Settings & game ─────────────────────────────────────────────────────────

const GAME_SOURCES: readonly GameSource[] = ['steam', 'standalone', 'custom'];
const CONFLICT_POLICIES: readonly ConflictPolicy[] = ['ask', 'replace', 'copy', 'skip'];
const LANGUAGES: readonly Language[] = ['en', 'it', 'de', 'ru', 'fr'];

const isString = (v: unknown) => typeof v === 'string';
const isBool = (v: unknown) => typeof v === 'boolean';
const oneOf = (values: readonly string[]) => (v: unknown) => typeof v === 'string' && values.includes(v);

/** The fields `SettingsPatch` accepts (backupDays is not one); unknown keys are ignored. */
const PATCH_FIELDS: Partial<Record<keyof Settings, (v: unknown) => boolean>> = {
  gamePath: isString,
  gameSource: oneOf(GAME_SOURCES),
  gameVersion: isString,
  watchFolder: isString,
  autoInstall: isBool,
  conflictPolicy: oneOf(CONFLICT_POLICIES),
  backups: isBool,
  language: oneOf(LANGUAGES),
  autoUpdate: isBool,
  startWithWindows: isBool,
  onboarded: isBool,
};

/** `set_settings`: present fields change, `null` leaves a field as it is (serde `Option`). */
function setSettings(args: Args): Settings {
  const patch = args.patch;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return badArg('set_settings', 'patch');
  const next: Settings = { ...state.settings };
  for (const [key, value] of Object.entries(patch as Args)) {
    const valid = PATCH_FIELDS[key as keyof Settings];
    if (!valid || value === null || value === undefined) continue;
    if (!valid(value)) return badArg('set_settings', 'patch');
    (next as unknown as Args)[key] = value;
  }
  state.settings = next;
  return next;
}

function looksLikeGame(path: string): boolean {
  return path.toLowerCase().includes('war thunder');
}

/** Trims quotes and trailing separators, and a picked `UserSkins` resolves to the game root. */
function normalizeRoot(path: string): string {
  const cleaned = path.trim().replace(/^"+|"+$/g, '').trim().replace(/[\\/]+$/, '');
  return cleaned.replace(/[\\/]UserSkins$/i, '');
}

function describe(source: GameSource, path: string): GameDetection {
  return { found: true, source, path, version: MOCK_GAME.version, existingSkins: MOCK_GAME.existingSkins };
}

/**
 * `detect_game`: Steam, standalone, then the saved custom folder, each `checking` → `found` /
 * `notFound` (custom without a saved folder: `skipped`). Steam wins, then custom. Saves nothing.
 */
async function runDetect(onEvent?: (event: DetectEvent) => void): Promise<GameDetection> {
  const emit = async (source: GameSource, detectState: DetectState) => {
    if (!onEvent) return;
    await pause(0.4);
    onEvent({ source, state: detectState });
  };
  const steam = !state.detectNothing;
  await emit('steam', 'checking');
  await emit('steam', steam ? 'found' : 'notFound');
  await emit('standalone', 'checking');
  await emit('standalone', 'notFound');
  const saved = state.settings.gamePath?.trim();
  const custom = !!saved && looksLikeGame(saved);
  if (saved) {
    await emit('custom', 'checking');
    await emit('custom', custom ? 'found' : 'notFound');
  } else {
    await emit('custom', 'skipped');
  }
  if (steam) return describe('steam', MOCK_GAME.path);
  if (custom && saved) return describe('custom', normalizeRoot(saved));
  return { found: false, existingSkins: 0 };
}

/**
 * `detect_game` for First run under the mock: hands each `game://detect` event to `onEvent` as
 * the Tauri listener would receive it, then resolves with the detection.
 */
export async function mockDetectGame(onEvent: (event: DetectEvent) => void): Promise<GameDetection> {
  await pause(0.5);
  return wire(await runDetect(onEvent));
}

/** Validates and saves the game root with its source (default `custom`) and version. */
function setGamePath(args: Args): GameDetection {
  const path = str('set_game_path', args, 'path');
  const source = optStr('set_game_path', args, 'source');
  if (source !== undefined && !GAME_SOURCES.includes(source as GameSource)) return badArg('set_game_path', 'source');
  const root = normalizeRoot(path);
  if (!root || !looksLikeGame(root)) {
    return fail('invalidInput', "That folder doesn't look like a War Thunder install", path);
  }
  const detection = describe((source as GameSource | undefined) ?? 'custom', root);
  state.settings = { ...state.settings, gamePath: root, gameSource: detection.source, gameVersion: detection.version };
  return detection;
}

// ── Backups expiry ──────────────────────────────────────────────────────────

/** Seconds an ephemeral backup lives (`backup::EPHEMERAL_SECS`). */
const EPHEMERAL_MS = 60_000;
const DAY_MS = 86_400_000;

function hasGameFolder(): boolean {
  return !!state.settings.gamePath?.trim();
}

/** Drops collection members that are neither in the index nor in a backup. */
function dropDanglingMembers(): void {
  const known = new Set([...state.index.map((s) => s.id), ...state.backups.map((b) => b.skin.id)]);
  for (const c of state.collections) c.skinIds = c.skinIds.filter((id) => known.has(id));
}

/**
 * Every library command starts here (`purge_expired`): with a game folder set, backups past
 * their lifetime (ephemeral: a minute; kept: `backupDays`) are removed, except `keep`.
 */
function purgeExpired(keep: string[] = []): void {
  if (!hasGameFolder()) return;
  const now = Date.now();
  const expired = (b: StoredBackup) => {
    const created = Date.parse(b.backup.createdAt);
    if (Number.isNaN(created) || keep.includes(b.backup.id)) return false;
    return now - created > (b.ephemeral ? EPHEMERAL_MS : state.settings.backupDays * DAY_MS);
  };
  if (!state.backups.some(expired)) return;
  state.backups = state.backups.filter((b) => !expired(b));
  dropDanglingMembers();
}

/** `prepare`: purge, then the saved game folder is required. */
function prepare(keep: string[] = []): void {
  purgeExpired(keep);
  if (!hasGameFolder()) fail('invalidInput', 'No game folder set');
}

// ── Library ─────────────────────────────────────────────────────────────────

/** Every skin folder on disk (active and inactive): indexed skins as the index knows them. */
function scan(): HangarSkin[] {
  prepare();
  return [...state.index, ...state.diskOnly].sort(
    (a, b) =>
      compare(folderKey(a.folder), folderKey(b.folder)) ||
      compare(a.folder, b.folder) ||
      Number(b.active) - Number(a.active),
  );
}

function isFolderName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\:\0]/.test(name);
}

/** Adds scanned folders to the index (idempotent); folders that aren't on disk are skipped. */
function importSkins(args: Args): HangarSkin[] {
  const folders = strList('import_skins', args, 'folders');
  prepare();
  const bad = folders.find((f) => !isFolderName(f));
  if (bad !== undefined) fail('invalidInput', 'Not a skin folder name', bad);
  for (const folder of folders) {
    const at = state.diskOnly.findIndex((s) => folderKey(s.folder) === folderKey(folder));
    if (at < 0) continue; // already indexed (refreshing changes nothing here) or gone
    const [found] = state.diskOnly.splice(at, 1);
    if (found) state.index.push({ ...found, id: newId('s') });
  }
  return state.index;
}

/** Whether a folder named `folder` is in the place `active` says, apart from skin `except`. */
function occupied(folder: string, active: boolean, except?: HangarSkin): boolean {
  const key = folderKey(folder);
  return (
    state.index.some((s) => s !== except && s.active === active && folderKey(s.folder) === key) ||
    (active && state.diskOnly.some((s) => folderKey(s.folder) === key))
  );
}

/**
 * Moves the skins `want` picks to the place it says. A clash at the destination leaves that
 * skin where it is; the others move, then the clash is the error (`MoveReport::into_result`).
 */
function moveSkins(want: (skin: HangarSkin) => boolean | undefined): void {
  const clashes: string[] = [];
  for (const skin of state.index) {
    const active = want(skin);
    if (active === undefined || skin.active === active) continue;
    if (occupied(skin.folder, active, skin)) clashes.push(skin.folder);
    else skin.active = active;
  }
  if (clashes.length > 0) fail('conflict', 'Another skin folder already has this name', clashes.join('\n'));
}

function setSkinActive(args: Args): HangarSkin[] {
  const ids = new Set(strList('set_skin_active', args, 'ids'));
  const active = bool('set_skin_active', args, 'active');
  prepare();
  moveSkins((skin) => (ids.has(skin.id) ? active : undefined));
  return state.index;
}

/**
 * Each skin's folder goes to a backup (ephemeral while backups are off) and the skin leaves the
 * index; memberships stay so a restore brings them back. Unknown ids are ignored.
 */
function deleteSkins(args: Args): DeleteResult {
  const ids = strList('delete_skins', args, 'ids');
  prepare();
  const backupIds: string[] = [];
  for (const id of dedupe(ids)) {
    const at = state.index.findIndex((s) => s.id === id);
    const skin = state.index[at];
    if (!skin) continue;
    const backup: Backup = {
      id: newId('b'),
      skinId: skin.id,
      name: skin.name,
      sizeBytes: skin.sizeBytes,
      createdAt: stamp(Date.now()),
      reason: 'delete',
    };
    state.backups.push({ backup, skin: { ...skin }, wasActive: skin.active, ephemeral: !state.settings.backups });
    state.index.splice(at, 1);
    backupIds.push(backup.id);
  }
  dropDanglingMembers();
  return { backupIds };
}

/**
 * Undo: each backed-up skin comes back where it was (active or inactive) with its id, name and
 * memberships, appended to the index (or replacing the entry with its id). A taken folder name
 * gives `<folder> (2)`. Unknown or expired ids end in `notFound` after the others are restored.
 * Returns the restored skins in input order.
 */
function restoreBackups(args: Args): HangarSkin[] {
  const ids = strList('restore_backups', args, 'backupIds');
  prepare(ids);
  const restored: HangarSkin[] = [];
  const missing: string[] = [];
  for (const id of dedupe(ids)) {
    const record = state.backups.find((b) => b.backup.id === id);
    if (!record) {
      missing.push(id);
      continue;
    }
    // Every indexed folder is on disk (the entry with this id too: a replaced skin's new version).
    const taken = (name: string) =>
      [...state.index, ...state.diskOnly].some((s) => folderKey(s.folder) === folderKey(name));
    const folder = uniqueName(record.skin.folder, taken);
    const skin: HangarSkin = { ...record.skin, active: record.wasActive };
    if (folder !== skin.folder) {
      skin.name = `${skin.name}${folder.slice(skin.folder.length)}`;
      skin.folder = folder;
    }
    const existing = state.index.findIndex((s) => s.id === skin.id);
    const replaced = state.index[existing];
    if (replaced) {
      // The newer version's folder stays on disk, unknown to the index from now on.
      state.diskOnly.push({ ...replaced, id: `disk:${replaced.active ? '' : 'inactive/'}${replaced.folder}` });
      state.index[existing] = skin;
    } else {
      state.index.push(skin);
    }
    state.backups = state.backups.filter((b) => b !== record);
    restored.push(skin);
  }
  if (missing.length > 0) fail('notFound', 'Some backups are no longer available', missing.join('\n'));
  return restored;
}

/** Copies skin folders into `dest` (unknown ids are skipped). */
function exportSkins(args: Args): ExportResult {
  const ids = strList('export_skins', args, 'ids');
  const dest = str('export_skins', args, 'dest');
  prepare();
  if (!dest.trim()) fail('invalidInput', "The export folder can't be found", dest);
  const known = new Set(state.index.map((s) => s.id));
  return { exported: dedupe(ids).filter((id) => known.has(id)).length, dest: dest.trim() };
}

/** Kept backups (not the ephemeral Undo-only ones), newest first. */
function listBackups(): Backup[] {
  purgeExpired();
  return state.backups
    .filter((b) => !b.ephemeral)
    .map((b) => b.backup)
    .reverse()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function clearBackups(): null {
  if (!hasGameFolder()) fail('invalidInput', 'No game folder set');
  state.backups = [];
  dropDanglingMembers();
  return null;
}

// ── Collections ─────────────────────────────────────────────────────────────

function collectionsState(): CollectionsState {
  return { collections: state.collections, activeCollectionId: state.activeCollectionId };
}

function findCollection(id: string): Collection {
  return state.collections.find((c) => c.id === id) ?? fail('notFound', 'Collection not found', id);
}

/** Trimmed, not empty. */
function cleanName(name: string): string {
  const trimmed = name.trim();
  return trimmed || fail('invalidInput', 'A collection needs a name');
}

/** Trimmed; empty means none. */
function cleanDescription(description: string | undefined): string | undefined {
  return description?.trim() || undefined;
}

function createCollection(args: Args): Collection {
  const name = str('collections_create', args, 'name');
  const description = optStr('collections_create', args, 'description');
  purgeExpired();
  const collection: Collection = {
    id: newId('c'),
    name: cleanName(name),
    description: cleanDescription(description),
    skinIds: [],
    createdAt: stamp(Date.now()),
  };
  state.collections.push(collection);
  return collection;
}

/** `undefined` leaves a field as it is; an empty description clears it; a blank name fails. */
function updateCollection(args: Args): Collection {
  const id = str('collections_update', args, 'id');
  const name = optStr('collections_update', args, 'name');
  const description = optStr('collections_update', args, 'description');
  purgeExpired();
  const cleaned = name === undefined ? undefined : cleanName(name);
  const collection = findCollection(id);
  if (cleaned !== undefined) collection.name = cleaned;
  if (description !== undefined) collection.description = cleanDescription(description);
  return collection;
}

/** Its skins stay installed; clears the active collection if it was this one. */
function deleteCollection(args: Args): CollectionsState {
  const id = str('collections_delete', args, 'id');
  purgeExpired();
  const collection = findCollection(id);
  state.collections = state.collections.filter((c) => c !== collection);
  if (state.activeCollectionId === id) state.activeCollectionId = undefined;
  return collectionsState();
}

function isCollection(value: unknown): value is Collection {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.createdAt === 'string' &&
    (c.description === undefined || c.description === null || typeof c.description === 'string') &&
    Array.isArray(c.skinIds) &&
    c.skinIds.every((id) => typeof id === 'string')
  );
}

/** Undo for a delete: appends the collection as it was (same id); `conflict` if the id exists. */
function restoreCollection(args: Args): CollectionsState {
  const collection = args.collection;
  if (!isCollection(collection)) return badArg('collections_restore', 'collection');
  purgeExpired();
  if (!collection.id.trim()) fail('invalidInput', 'A collection needs an id');
  const restored: Collection = {
    ...collection,
    description: collection.description ?? undefined,
    name: cleanName(collection.name),
    skinIds: dedupe(collection.skinIds),
  };
  if (state.collections.some((c) => c.id === restored.id)) {
    fail('conflict', 'This collection already exists', restored.id);
  }
  state.collections.push(restored);
  return collectionsState();
}

/** `add` appends indexed skins not yet in it, in order; `remove` takes ids out and wins. */
function setCollectionSkins(args: Args): Collection {
  const id = str('collections_set_skins', args, 'id');
  const add = strList('collections_set_skins', args, 'add');
  const remove = new Set(strList('collections_set_skins', args, 'remove'));
  purgeExpired();
  const collection = findCollection(id);
  const indexed = new Set(state.index.map((s) => s.id));
  for (const skinId of dedupe(add)) {
    if (indexed.has(skinId) && !collection.skinIds.includes(skinId)) collection.skinIds.push(skinId);
  }
  collection.skinIds = collection.skinIds.filter((skinId) => !remove.has(skinId));
  return collection;
}

/**
 * Exactly the collection's skins become active and every other hangar skin inactive; the
 * collection is remembered as the active one even when some folders clash (`conflict`).
 */
function activateCollection(args: Args): HangarSkin[] {
  const id = str('activate_collection', args, 'id');
  prepare();
  const collection = findCollection(id);
  const members = new Set(collection.skinIds);
  state.activeCollectionId = id;
  moveSkins((skin) => members.has(skin.id));
  return state.index;
}

// ── Install queue (M4) ──────────────────────────────────────────────────────

/** `ErrorCode::Unsupported` for archives until the unpacking crates are approved. */
const UNSUPPORTED_ARCHIVES =
  "ZIP, RAR and 7z archives can't be unpacked yet — this needs the unpacking library the author hasn't approved. Skin folders work today.";

/** How long an install takes from `{ installId }` to `done` (× the time scale). */
const INSTALL_MS = 2000;
/** `install://progress` before `done`: [share of INSTALL_MS, step, pct]. */
const INSTALL_STEPS: [number, InstallStep, number][] = [
  [0, 'extract', 0],
  [0.12, 'extract', 16],
  [0.24, 'extract', 32],
  [0.36, 'extract', 48],
  [0.48, 'extract', 64],
  [0.6, 'extract', 80],
  [0.75, 'verify', 88],
  [0.9, 'verify', 95],
];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Last path segment, trailing separators ignored. */
function lastSegment(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

/**
 * The skin whose folder is `folder` (case-insensitive): an indexed one (active first, then
 * inactive, whose folder would clash on activation) or a folder the index doesn't know.
 */
function installedAt(st: MockState, folder: string): HangarSkin | undefined {
  const key = folderKey(folder);
  const same = (s: HangarSkin) => folderKey(s.folder) === key;
  return st.index.find((s) => s.active && same(s)) ?? st.index.find(same) ?? st.diskOnly.find(same);
}

/** The queue item for a folder holding `roots`, as the Rust analysis reports it. */
function describeSource(st: MockState, id: string, path: string, roots: MockSkinRoot[]): QueueItem {
  const files = roots.flatMap((r) => r.files);
  const textureCount = files.filter((f) => /\.(dds|tga)$/i.test(f.path)).length;
  const base: QueueItem = {
    id,
    path,
    fileName: lastSegment(path),
    sizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    status: 'ready',
    files,
    textureCount,
    blkOk: true,
  };
  const [root] = roots;
  if (!root || roots.length > 1) {
    return {
      ...base,
      status: 'needsLook',
      candidates: roots.map((r) => ({ ...r.vehicle })),
      note: `Can’t detect the vehicle: ${roots.length} folders inside. Pick one to continue.`,
    };
  }
  const single: QueueItem = { ...base, vehicle: { ...root.vehicle }, targetFolder: root.folder };
  const clash = installedAt(st, root.folder);
  if (clash) {
    return { ...single, status: 'conflict', conflictWith: clash.id, note: `Same folder name as “${clash.name}” (installed)` };
  }
  const blk = `${root.vehicle.code}.blk`;
  return { ...single, note: `${plural(files.length, 'file')} · ${plural(textureCount, 'texture')} · ${blk} ok` };
}

function findQueued(queueId: string): StoredQueueItem {
  return state.queue.find((q) => q.item.id === queueId) ?? fail('notFound', 'This item is no longer in the queue', queueId);
}

/** Looks inside a dropped or watched folder (rules in the header) and queues it, newest first. */
function analyze(path: string): StoredQueueItem {
  const name = lastSegment(path);
  if (!name || name.toLowerCase() === 'notaskin') fail('invalidInput', 'Not a skin folder or archive', path);
  const id = newId('q');
  let stored: StoredQueueItem;
  if (/\.(zip|rar|7z)$/i.test(name)) {
    // Only the file's size is known without unpacking it.
    const sizeBytes = (20 + (nameHash(name) % 120)) * 1024 * 1024;
    stored = { item: { id, path, fileName: name, sizeBytes, status: 'error', error: UNSUPPORTED_ARCHIVES }, roots: [] };
  } else {
    // A folder named like an installed skin holds a version of that skin (same vehicle).
    const roots = sourceRoots(name, installedAt(state, name)?.vehicle);
    stored = { item: describeSource(state, id, path, roots), roots };
  }
  state.queue.unshift(stored);
  return stored;
}

async function analyzeArchive(args: Args): Promise<QueueItem> {
  const path = str('analyze_archive', args, 'path').trim();
  await pause(2);
  return analyze(path).item;
}

/** A skin installed from `root` into UserSkins/<folder>. */
function installedSkin(root: MockSkinRoot, id: string, folder: string): HangarSkin {
  const skin: HangarSkin = {
    id,
    folder,
    name: folder,
    vehicle: { ...root.vehicle },
    origin: /^template_/i.test(folder) ? 'mine' : 'imported',
    sizeBytes: root.sizeBytes,
    active: true,
    installedAt: stamp(Date.now()),
  };
  if (root.missing.length > 0) {
    skin.attention = root.missing.map((file) => ({ kind: 'missingTexture', message: `${file} is missing`, file }));
  }
  state.textures.set(id, root.textures);
  return skin;
}

/**
 * Replace: the installed version goes to a backup (ephemeral while backups are off) and the new
 * one takes its place in the index under the same id, so collections keep it. A folder the
 * index didn't know is adopted first, as `import_skins` would.
 */
function replaceSkin(clash: HangarSkin, root: MockSkinRoot): { skin: HangarSkin; backupId: string } {
  let old = clash;
  if (old.id.startsWith('disk:')) {
    state.diskOnly = state.diskOnly.filter((s) => s !== clash);
    old = { ...clash, id: newId('s') };
    state.index.push(old);
  }
  const backup: Backup = {
    id: newId('b'),
    skinId: old.id,
    name: old.name,
    sizeBytes: old.sizeBytes,
    createdAt: stamp(Date.now()),
    reason: 'replace',
  };
  state.backups.push({ backup, skin: { ...old }, wasActive: old.active, ephemeral: !state.settings.backups });
  const skin = installedSkin(root, old.id, root.folder);
  state.index = state.index.map((s) => (s === old ? skin : s));
  return { skin, backupId: backup.id };
}

function emitProgress(progress: InstallProgress): void {
  mockEmit(EVENTS.installProgress, progress);
}

/** End of an install: the folder moves into UserSkins (atomically, in the real app). */
function finishInstall(stored: StoredQueueItem, root: MockSkinRoot, installId: string, policy?: 'replace' | 'copy'): void {
  const queueId = stored.item.id;
  const clash = installedAt(state, root.folder);
  if (clash && !policy) {
    // Another install took the folder meanwhile: nothing is installed, the item turns into a conflict.
    stored.item = describeSource(state, queueId, stored.item.path, stored.roots);
    emitProgress({ installId, queueId, step: 'error', pct: 95, message: 'Another skin folder already has this name' });
    return;
  }
  let skin: HangarSkin;
  let backupId: string | undefined;
  if (clash && policy === 'replace') {
    ({ skin, backupId } = replaceSkin(clash, root));
  } else {
    const taken = (name: string) => installedAt(state, name) !== undefined;
    skin = installedSkin(root, newId('s'), clash ? uniqueName(root.folder, taken) : root.folder);
    state.index.push(skin);
  }
  stored.item = { ...stored.item, status: 'done', targetFolder: skin.folder };
  emitProgress({ installId, queueId, step: 'done', pct: 100, skinId: skin.id, backupId });
}

/** The skin root to install: the only one, or the one for `vehicleCode` (needsLook). */
function pickRoot(stored: StoredQueueItem, vehicleCode: string | undefined): MockSkinRoot {
  const { roots, item } = stored;
  if (vehicleCode === undefined) {
    if (roots.length > 1) fail('invalidInput', 'Pick a vehicle first', item.id);
    return roots[0] ?? fail('invalidInput', 'Not a skin folder or archive', item.path);
  }
  return roots.find((r) => r.vehicle.code === vehicleCode) ?? fail('invalidInput', "That vehicle isn't in this folder", vehicleCode);
}

/**
 * `install_from_archive`: checks and starts the install, answers `{ installId }`, then reports
 * through `install://progress` (see the header for conflicts).
 */
function installFromArchive(args: Args): InstallStarted {
  const cmd = 'install_from_archive';
  const queueId = str(cmd, args, 'queueId');
  const vehicleCode = optStr(cmd, args, 'vehicleCode');
  const conflict = optStr(cmd, args, 'conflict');
  if (conflict !== undefined && !CONFLICT_POLICIES.includes(conflict as ConflictPolicy)) return badArg(cmd, 'conflict');
  prepare();
  const stored = findQueued(queueId);
  const { item } = stored;
  if (item.status === 'error') fail('unsupported', item.error ?? UNSUPPORTED_ARCHIVES, item.path);
  if (item.status === 'installing') fail('invalidInput', 'This item is already installing', queueId);
  if (item.status === 'done') fail('invalidInput', 'This item is already installed', queueId);
  const root = pickRoot(stored, vehicleCode);
  if (stored.roots.length > 1) {
    // The pick is final: the item becomes that one skin (ready, or a conflict).
    stored.roots = [root];
    stored.item = describeSource(state, queueId, item.path, stored.roots);
  }
  const clash = installedAt(state, root.folder);
  const policy = clash ? ((conflict as ConflictPolicy | undefined) ?? state.settings.conflictPolicy) : undefined;
  if (policy === 'ask') {
    stored.item = describeSource(state, queueId, item.path, stored.roots);
    fail('conflict', 'This skin is already installed', root.folder);
  }
  const installId = newId('i');
  if (policy === 'skip') {
    // Nothing to do: the installed version stays and the item leaves the queue.
    state.queue = state.queue.filter((q) => q !== stored);
    later(0, () => emitProgress({ installId, queueId, step: 'done', pct: 100, message: 'skipped' }));
    return { installId };
  }
  stored.item = { ...stored.item, status: 'installing' };
  for (const [share, step, pct] of INSTALL_STEPS) {
    later(share * INSTALL_MS, () => emitProgress({ installId, queueId, step, pct }));
  }
  later(INSTALL_MS, () => finishInstall(stored, root, installId, policy));
  return { installId };
}

/** Unknown ids are ignored; an item that is installing stays until it's done. */
function removeQueueItem(args: Args): null {
  const queueId = str('remove_queue_item', args, 'queueId');
  const stored = state.queue.find((q) => q.item.id === queueId);
  if (!stored) return null;
  if (stored.item.status === 'installing') fail('invalidInput', 'Wait for the install to finish', queueId);
  state.queue = state.queue.filter((q) => q !== stored);
  return null;
}

/**
 * Undo for "Replace, keep a backup": the new version is removed for good and the backed-up one
 * comes back where it was (active or inactive) with its id; `<folder> (2)` if the name is taken
 * by something else. The backup is used up.
 */
function undoReplace(args: Args): HangarSkin {
  const skinId = str('undo_replace', args, 'skinId');
  const backupId = str('undo_replace', args, 'backupId');
  prepare([backupId]);
  const record = state.backups.find((b) => b.backup.id === backupId);
  if (!record) return fail('notFound', 'This backup is no longer available', backupId);
  if (record.backup.reason !== 'replace' || record.backup.skinId !== skinId) {
    fail('invalidInput', "This backup isn't an older version of that skin", backupId);
  }
  const newer = state.index.find((s) => s.id === skinId);
  const taken = (name: string) =>
    [...state.index, ...state.diskOnly].some((s) => s !== newer && folderKey(s.folder) === folderKey(name));
  const folder = uniqueName(record.skin.folder, taken);
  const skin: HangarSkin = { ...record.skin, active: record.wasActive };
  if (folder !== skin.folder) {
    skin.name = `${skin.name}${folder.slice(skin.folder.length)}`;
    skin.folder = folder;
  }
  if (newer) state.index = state.index.map((s) => (s === newer ? skin : s));
  else state.index.push(skin);
  state.backups = state.backups.filter((b) => b !== record);
  state.textures.delete(skinId);
  return skin;
}

/** Exactly one of `skinId` (an installed or not-yet-imported skin) and `queueId`. */
function readTextures(args: Args): TextureInfo[] {
  const skinId = optStr('read_textures', args, 'skinId');
  const queueId = optStr('read_textures', args, 'queueId');
  if (skinId !== undefined && queueId === undefined) {
    prepare();
    const skin =
      [...state.index, ...state.diskOnly].find((s) => s.id === skinId) ?? fail('notFound', 'Skin not found', skinId);
    return state.textures.get(skinId) ?? hangarTextures(skin);
  }
  if (queueId !== undefined && skinId === undefined) {
    const { item, roots } = findQueued(queueId);
    if (item.status === 'error') fail('unsupported', item.error ?? UNSUPPORTED_ARCHIVES, item.path);
    // Several skins inside: each row names its folder.
    if (roots.length > 1) return roots.flatMap((r) => r.textures.map((t) => ({ ...t, file: `${r.folder}/${t.file}` })));
    return roots[0]?.textures ?? [];
  }
  return fail('invalidInput', 'Textures need either a skin or a queue item');
}

/**
 * `watch_folder`: turns watching on or off (`autoInstall`) for `path`; without one, the folder
 * already set, else Downloads. Returns the settings.
 */
function watchFolder(args: Args): Settings {
  const path = optStr('watch_folder', args, 'path')?.trim();
  const enabled = bool('watch_folder', args, 'enabled');
  if (path === '') fail('invalidInput', "The watched folder can't be found", path);
  const folder = path ?? state.settings.watchFolder ?? MOCK_DOWNLOADS;
  state.settings = { ...state.settings, watchFolder: folder, autoInstall: enabled };
  return state.settings;
}

/** `?watch=1`: a new skin folder lands in the watched folder a few seconds after load. */
function startWatcher(): void {
  if (!readFlag('watch')) return;
  later(WATCH_DELAY_MS, () => {
    if (!state.settings.autoInstall) return; // watching was turned off meanwhile
    const { item } = analyze(`${state.settings.watchFolder ?? MOCK_DOWNLOADS}\\${WATCHED_FOLDER}`);
    mockEmit(EVENTS.queueAdded, item);
  });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, (args: Args) => unknown> = {
  get_settings: () => state.settings,
  set_settings: setSettings,
  detect_game: () => runDetect(),
  set_game_path: setGamePath,
  scan_user_skins: scan,
  import_skins: importSkins,
  get_hangar: () => {
    purgeExpired();
    return state.index;
  },
  set_skin_active: setSkinActive,
  delete_skins: deleteSkins,
  restore_backups: restoreBackups,
  export_skins: exportSkins,
  collections_list: () => {
    purgeExpired();
    return collectionsState();
  },
  collections_create: createCollection,
  collections_update: updateCollection,
  collections_delete: deleteCollection,
  collections_restore: restoreCollection,
  collections_set_skins: setCollectionSkins,
  activate_collection: activateCollection,
  list_backups: listBackups,
  analyze_archive: analyzeArchive,
  install_from_archive: installFromArchive,
  list_queue: () => state.queue.map((q) => q.item),
  remove_queue_item: removeQueueItem,
  undo_replace: undoReplace,
  read_textures: readTextures,
  watch_folder: watchFolder,
  clear_backups: clearBackups,
};

/** Answers `cmd` like the Rust backend would, after a short simulated delay. */
export async function mockCall<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const input = wire(args ?? {});
  await pause();
  const handler = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!handler) return fail('noBackend', `"${cmd}" needs the desktop app`);
  return wire((await handler(input)) as T);
}
