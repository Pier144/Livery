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
// after 80–250 ms.
//
// Start-up switches — a query parameter, or a localStorage key set to "1" (then reload):
//   ?onboarded=1  livery.mock.onboarded  skip First run: onboarded, Steam game folder saved
//   ?empty=1      livery.mock.empty      empty library, no collections, no backups
//   ?many=1       livery.mock.many       ~1,000 skins in the hangar (scroll performance check)
//   ?notfound=1   livery.mock.notfound   detection finds nothing ("Can't find War Thunder"); a
//                                        folder whose path contains "War Thunder" is accepted
// A query parameter wins over localStorage; `=0` turns a stored switch off for that load.
// Without switches the app opens on First run (onboarded: false, no game folder), which saves the
// Steam folder; until a folder is saved, commands that touch UserSkins fail like the real app
// ("No game folder set").

import { DEFAULT_SETTINGS } from '@/queries/settings';
import type {
  AppError,
  Backup,
  Collection,
  CollectionsState,
  ConflictPolicy,
  DeleteResult,
  DetectEvent,
  DetectState,
  ExportResult,
  GameDetection,
  GameSource,
  HangarSkin,
  Language,
  Settings,
} from '@/types';
import {
  MOCK_GAME,
  seedBackups,
  seedCollections,
  seedDiskOnly,
  seedHangar,
  seedManyHangar,
  type StoredBackup,
} from './mockData';

// ── Start-up switches ───────────────────────────────────────────────────────

type Flag = 'onboarded' | 'empty' | 'notfound' | 'many';

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

// ── State ───────────────────────────────────────────────────────────────────

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
  detectNothing: boolean;
  nextId: number;
}

function createState(): MockState {
  const onboarded = readFlag('onboarded');
  const empty = readFlag('empty');
  const seeded = empty ? undefined : seedCollections();
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      ...(onboarded
        ? { onboarded: true, gamePath: MOCK_GAME.path, gameSource: 'steam' as const, gameVersion: MOCK_GAME.version }
        : {}),
    },
    index: empty ? [] : readFlag('many') ? seedManyHangar() : seedHangar(),
    diskOnly: seedDiskOnly(),
    collections: seeded?.collections ?? [],
    activeCollectionId: seeded?.activeCollectionId,
    backups: empty ? [] : seedBackups(Date.now()).reverse(),
    detectNothing: readFlag('notfound'),
    nextId: 1,
  };
}

let state = createState();
let latency: [number, number] = [80, 250];

/** Back to the start-up state (switches are read again). For tests. */
export function resetMockBackend(): void {
  state = createState();
}

/** Tests pass `{ latency: [0, 0] }` so round-trips don't wait. */
export function configureMockBackend(options: { latency?: [number, number] }): void {
  if (options.latency) latency = options.latency;
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
