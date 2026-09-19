import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENTS,
  type AppError,
  type Backup,
  type Collection,
  type CollectionsState,
  type DeleteResult,
  type DetectEvent,
  type FollowEntry,
  type GameDetection,
  type HangarSkin,
  type InstallProgress,
  type InstallStarted,
  type NetStatus,
  type QueueItem,
  type SearchResult,
  type Settings,
  type TextureInfo,
  type WtLiveSkin,
} from '@/types';
import {
  configureMockBackend,
  mockCall,
  mockDetectGame,
  mockEmit,
  mockListen,
  resetMockBackend,
} from './mockBackend';
import { FOLLOWING_SEEN_AT, MOCK_DOWNLOADS, MOCK_GAME } from './mockData';

const MB = 1024 * 1024;
const KB = 1024;

const call = <T>(cmd: string, args: Record<string, unknown> = {}) => mockCall<T>(cmd, args);

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected the command to fail');
}

/** First run done: the Steam folder saved, as `set_game_path` would leave it. */
async function onboard() {
  await call<GameDetection>('set_game_path', { path: MOCK_GAME.path, source: 'steam' });
}

const ids = (skins: HangarSkin[]) => skins.map((s) => s.id);

/** Every `install://progress` for `installId`, once its `done` or `error` arrives. */
function progressUntilEnd(installId: () => string | undefined): Promise<InstallProgress[]> {
  return new Promise((resolve) => {
    const seen: InstallProgress[] = [];
    const off = mockListen<InstallProgress>(EVENTS.installProgress, (p) => {
      if (p.installId !== installId()) return;
      seen.push(p);
      if (p.step === 'done' || p.step === 'error') {
        off();
        resolve(seen);
      }
    });
  });
}

/** Starts an install and waits for its last progress event. */
async function install(args: Record<string, unknown>): Promise<{ started: InstallStarted; events: InstallProgress[] }> {
  let installId: string | undefined;
  const ended = progressUntilEnd(() => installId);
  const started = await call<InstallStarted>('install_from_archive', args);
  installId = started.installId;
  return { started, events: await ended };
}

const queued = async (id: string) => (await call<QueueItem[]>('list_queue')).find((q) => q.id === id);

/** Starts a WT Live install and waits for its last progress event. */
async function installWt(args: Record<string, unknown>): Promise<{ started: InstallStarted; events: InstallProgress[] }> {
  let installId: string | undefined;
  const ended = progressUntilEnd(() => installId);
  const started = await call<InstallStarted>('install_from_wtlive', args);
  installId = started.installId;
  return { started, events: await ended };
}

/** `wtlive_search` with the defaults the Explore screen starts with. */
const search = (params: Record<string, unknown> = {}) =>
  call<SearchResult>('wtlive_search', { params: { sort: 'downloads', page: 0, ...params } });
const postIds = (result: SearchResult) => result.items.map((s) => s.id);
const hangarSkin = async (id: string | undefined) => (await call<HangarSkin[]>('get_hangar')).find((s) => s.id === id);

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  configureMockBackend({ latency: [0, 0], timeScale: 0 });
  resetMockBackend();
});

describe('mock backend · start-up', () => {
  it('starts on First run with the prototype hangar and collections for the first game folder', async () => {
    const settings = await call<Settings>('get_settings');
    expect(settings).toMatchObject({ onboarded: false, backups: true, backupDays: 30 });
    expect(settings.gamePath).toBeUndefined();
    // No game folder yet: no library to show (the real app has no index for "no folder").
    expect(await call('get_hangar')).toEqual([]);
    expect(await call('collections_list')).toEqual({ collections: [] });
    expect(await call('list_backups')).toEqual([]);

    await onboard();
    const hangar = await call<HangarSkin[]>('get_hangar');
    expect(hangar).toHaveLength(12);
    expect(hangar.filter((s) => !s.active).map((s) => s.id)).toEqual(['h3', 'h7', 'h9']);
    expect(hangar.find((s) => s.id === 'h3')?.attention).toEqual([
      { kind: 'missingTexture', message: 'turret_c.dds is missing', file: 'turret_c.dds' },
    ]);
    expect(new Set(hangar.map((s) => s.origin))).toEqual(new Set(['wtlive', 'imported', 'mine']));

    const collections = await call<CollectionsState>('collections_list');
    expect(collections.activeCollectionId).toBe('c1');
    expect(collections.collections.map((c) => c.name)).toEqual(['Historical only', 'Screenshots', 'Fictional fun']);
  });

  it('skips First run with ?onboarded=1', async () => {
    window.history.replaceState(null, '', '/?onboarded=1');
    resetMockBackend();
    expect(await call<Settings>('get_settings')).toMatchObject({
      onboarded: true,
      gamePath: MOCK_GAME.path,
      gameSource: 'steam',
    });
  });

  it('seeds WT Live skins only where the prototype has a skinId; its Mine skins stay local', async () => {
    await onboard();
    const hangar = await call<HangarSkin[]>('get_hangar');
    const fromWt = hangar.filter((s) => s.origin === 'wtlive');
    expect(fromWt.map((s) => [s.id, s.sourceId])).toEqual([
      ['h_s6', 's6'],
      ['h_s4', 's4'],
      ['h_s8', 's8'],
    ]);
    expect(hangar.filter((s) => s.sourceId !== undefined)).toEqual(fromWt);
    const blueAngels = hangar.find((s) => s.name === 'Blue Angels Tribute');
    expect(blueAngels).toMatchObject({ id: 'h7', folder: 'template_f_4e', origin: 'mine' });
    expect(blueAngels).not.toHaveProperty('author');
    expect(blueAngels).not.toHaveProperty('sourceId');
  });

  it('?many=1: generated WT Live skins are installs of catalog posts, the others are local', async () => {
    window.history.replaceState(null, '', '/?onboarded=1&many=1');
    resetMockBackend();
    const hangar = await call<HangarSkin[]>('get_hangar');
    expect(hangar).toHaveLength(1000);
    const fromWt = hangar.filter((s) => s.origin === 'wtlive');
    expect(fromWt.length).toBeGreaterThan(300);
    expect(new Set(fromWt.map((s) => s.sourceId)).size).toBe(fromWt.length);
    for (const s of fromWt) {
      const post = await call<WtLiveSkin>('wtlive_post', { id: s.sourceId });
      expect(s).toMatchObject({ name: post.name, vehicle: post.vehicle, author: post.author, sizeBytes: post.sizeBytes });
    }
    const local = hangar.filter((s) => s.origin !== 'wtlive');
    expect(local.every((s) => s.sourceId === undefined && s.author === undefined)).toBe(true);
    expect(local.filter((s) => s.origin === 'mine').every((s) => s.folder.startsWith('template_'))).toBe(true);
    expect(new Set(hangar.map((s) => s.folder.toLowerCase())).size).toBe(hangar.length);
  });

  it('rejects unknown commands with noBackend', async () => {
    expect(await rejection(call('install_skin'))).toMatchObject({ code: 'noBackend' });
  });

  it('keeps reduceMotion (system by default) and accepts it in set_settings', async () => {
    expect((await call<Settings>('get_settings')).reduceMotion).toBe('system');
    expect((await call<Settings>('set_settings', { patch: { reduceMotion: 'on' } })).reduceMotion).toBe('on');
    expect(await rejection(call('set_settings', { patch: { reduceMotion: 'sometimes' } }))).toMatchObject({
      code: 'internal',
    });
    expect((await call<Settings>('get_settings')).reduceMotion).toBe('on');
  });
});

describe('mock backend · game', () => {
  it('detects the Steam install and reports every source', async () => {
    const events: DetectEvent[] = [];
    const detection = await mockDetectGame((e) => events.push(e));
    expect(detection).toEqual({
      found: true,
      source: 'steam',
      path: MOCK_GAME.path,
      version: '2.59.0.13',
      existingSkins: 9,
    });
    expect(events).toEqual([
      { source: 'steam', state: 'checking' },
      { source: 'steam', state: 'found' },
      { source: 'standalone', state: 'checking' },
      { source: 'standalone', state: 'notFound' },
      { source: 'custom', state: 'skipped' },
    ]);
  });

  it('rejects a folder that is not War Thunder and saves nothing', async () => {
    const error = await rejection(call('set_game_path', { path: 'D:\\Games\\Steam' }));
    expect(error).toMatchObject({ code: 'invalidInput', detail: 'D:\\Games\\Steam' });
    expect((await call<Settings>('get_settings')).gamePath).toBeUndefined();
  });

  it('saves a picked folder as custom, case-insensitively', async () => {
    const detection = await call<GameDetection>('set_game_path', { path: 'E:\\games\\WAR THUNDER\\UserSkins\\' });
    expect(detection).toMatchObject({ found: true, source: 'custom', path: 'E:\\games\\WAR THUNDER' });
    expect(await call<Settings>('get_settings')).toMatchObject({
      gamePath: 'E:\\games\\WAR THUNDER',
      gameSource: 'custom',
      gameVersion: '2.59.0.13',
    });
  });

  it('needs a game folder before touching UserSkins', async () => {
    expect(await rejection(call('scan_user_skins'))).toMatchObject({ code: 'invalidInput', message: 'No game folder set' });
  });

  it('scans the index plus two folders not indexed yet, and imports them', async () => {
    await onboard();
    const scanned = await call<HangarSkin[]>('scan_user_skins');
    expect(scanned).toHaveLength(14);
    const pending = scanned.filter((s) => s.id.startsWith('disk:'));
    expect(pending.map((s) => s.folder)).toEqual(['Kursk Dust', 'template_bf-109g-6']);

    const index = await call<HangarSkin[]>('import_skins', { folders: scanned.map((s) => s.folder) });
    expect(index).toHaveLength(14);
    expect(index.some((s) => s.id.startsWith('disk:'))).toBe(false);
    expect(await call<HangarSkin[]>('get_hangar')).toEqual(index);
  });
});

describe('mock backend · hangar', () => {
  beforeEach(onboard);

  it('delete → restore puts the skins back with their memberships', async () => {
    const { backupIds } = await call<DeleteResult>('delete_skins', { ids: ['h1', 'h7', 'nope'] });
    expect(backupIds).toHaveLength(2);

    const afterDelete = await call<HangarSkin[]>('get_hangar');
    expect(ids(afterDelete)).not.toContain('h1');
    expect(ids(afterDelete)).not.toContain('h7');
    expect(afterDelete).toHaveLength(10);
    // Memberships stay while the backup exists.
    const { collections } = await call<CollectionsState>('collections_list');
    expect(collections.find((c) => c.id === 'c1')?.skinIds).toContain('h1');
    // Kept backups are listed, newest first.
    const listed = await call<Backup[]>('list_backups');
    expect(listed).toHaveLength(5);
    expect(listed.slice(0, 2).map((b) => b.id).sort()).toEqual([...backupIds].sort());

    const restored = await call<HangarSkin[]>('restore_backups', { backupIds });
    expect(ids(restored)).toEqual(['h1', 'h7']);
    expect(restored.find((s) => s.id === 'h7')?.active).toBe(false);

    const hangar = await call<HangarSkin[]>('get_hangar');
    expect(hangar).toHaveLength(12);
    expect(await call<Backup[]>('list_backups')).toHaveLength(3);
    // The backups are used up: a second Undo finds nothing.
    expect(await rejection(call('restore_backups', { backupIds }))).toMatchObject({ code: 'notFound' });
  });

  it('keeps delete backups ephemeral (unlisted) while backups are off', async () => {
    await call<Settings>('set_settings', { patch: { backups: false } });
    const { backupIds } = await call<DeleteResult>('delete_skins', { ids: ['h5'] });
    expect(backupIds).toHaveLength(1);
    expect(await call<Backup[]>('list_backups')).toHaveLength(3);
    expect(ids(await call<HangarSkin[]>('restore_backups', { backupIds }))).toEqual(['h5']);
  });

  it('toggles skins and returns the whole index', async () => {
    const index = await call<HangarSkin[]>('set_skin_active', { ids: ['h3', 'h9', 'unknown'], active: true });
    expect(index).toHaveLength(12);
    expect(index.filter((s) => !s.active).map((s) => s.id)).toEqual(['h7']);
    const off = await call<HangarSkin[]>('set_skin_active', { ids: ['h1'], active: false });
    expect(off.find((s) => s.id === 'h1')?.active).toBe(false);
  });

  it('exports known skins only', async () => {
    const result = await call('export_skins', { ids: ['h1', 'h2', 'gone'], dest: 'D:\\Exports' });
    expect(result).toEqual({ exported: 2, dest: 'D:\\Exports' });
    expect(await rejection(call('export_skins', { ids: ['h1'], dest: ' ' }))).toMatchObject({ code: 'invalidInput' });
  });
});

describe('mock backend · collections', () => {
  beforeEach(onboard);

  it('need a game folder to change', async () => {
    window.history.replaceState(null, '', '/');
    resetMockBackend();
    const noFolder = { code: 'invalidInput', message: 'No game folder set' };
    expect(await rejection(call('collections_create', { name: 'Night' }))).toEqual(noFolder);
    expect(await rejection(call('collections_update', { id: 'c1', name: 'x' }))).toEqual(noFolder);
    expect(await rejection(call('collections_delete', { id: 'c1' }))).toEqual(noFolder);
    expect(await rejection(call('collections_set_skins', { id: 'c1', add: [], remove: [] }))).toEqual(noFolder);
    expect(await rejection(call('activate_collection', { id: 'c1' }))).toEqual(noFolder);
    const collection = { id: 'c9', name: 'Back', skinIds: [], createdAt: '2026-09-01T00:00:00Z' };
    expect(await rejection(call('collections_restore', { collection }))).toEqual(noFolder);
  });

  it('activating a collection makes exactly its skins active', async () => {
    const index = await call<HangarSkin[]>('activate_collection', { id: 'c2' });
    expect(index.filter((s) => s.active).map((s) => s.id).sort()).toEqual(['h5', 'h7', 'h_s4']);
    expect((await call<CollectionsState>('collections_list')).activeCollectionId).toBe('c2');
    expect(await call<HangarSkin[]>('get_hangar')).toEqual(index);
    expect(await rejection(call('activate_collection', { id: 'c9' }))).toMatchObject({ code: 'notFound' });
  });

  it('creates, edits, fills, deletes and restores a collection', async () => {
    const created = await call<Collection>('collections_create', { name: '  Night ops  ', description: ' ' });
    expect(created).toMatchObject({ name: 'Night ops', skinIds: [] });
    expect(created.description).toBeUndefined();
    expect(await rejection(call('collections_create', { name: '   ' }))).toMatchObject({ code: 'invalidInput' });

    const renamed = await call<Collection>('collections_update', { id: created.id, description: 'Dark schemes' });
    expect(renamed).toMatchObject({ name: 'Night ops', description: 'Dark schemes' });

    const filled = await call<Collection>('collections_set_skins', {
      id: created.id,
      add: ['h1', 'h1', 'unknown', 'h2'],
      remove: ['h2'],
    });
    expect(filled.skinIds).toEqual(['h1']);

    const afterDelete = await call<CollectionsState>('collections_delete', { id: 'c1' });
    expect(afterDelete.activeCollectionId).toBeUndefined();
    expect(afterDelete.collections.map((c) => c.id)).not.toContain('c1');

    const remaining = (await call<CollectionsState>('collections_list')).collections;
    expect(remaining.map((c) => c.id)).toEqual(['c2', 'c3', created.id]);
    const original = { id: 'c1', name: 'Historical only', skinIds: ['h1'], createdAt: '2026-06-10T19:12:00Z' };
    const restored = await call<CollectionsState>('collections_restore', { collection: original });
    expect(restored.collections.at(-1)).toMatchObject(original);
    expect(await rejection(call('collections_restore', { collection: original }))).toMatchObject({ code: 'conflict' });
  });
});

describe('mock backend · backups', () => {
  beforeEach(onboard);

  it('clear_backups with ids removes only those; without, every one', async () => {
    const { backupIds } = await call<DeleteResult>('delete_skins', { ids: ['h1', 'h2'] });
    const listed = await call<Backup[]>('list_backups');
    expect(listed).toHaveLength(5);
    const [first, second] = backupIds;
    expect(await call('clear_backups', { ids: [first, 'nope'] })).toBeNull();
    const left = (await call<Backup[]>('list_backups')).map((b) => b.id);
    expect(left).toHaveLength(4);
    expect(left).not.toContain(first);
    expect(left).toContain(second);
    // h1 is gone for good: it leaves its collections; h2 can still come back.
    const { collections } = await call<CollectionsState>('collections_list');
    expect(collections.some((c) => c.skinIds.includes('h1'))).toBe(false);
    expect(await rejection(call('restore_backups', { backupIds: [first] }))).toMatchObject({ code: 'notFound' });

    expect(await call('clear_backups', { ids: [] })).toBeNull();
    expect(await call<Backup[]>('list_backups')).toHaveLength(4);
    expect(await call('clear_backups', { ids: null })).toBeNull();
    expect(await call<Backup[]>('list_backups')).toEqual([]);
    expect(await rejection(call('clear_backups', { ids: 'all' }))).toMatchObject({ code: 'internal' });
  });

  it('clear_backups needs a game folder', async () => {
    window.history.replaceState(null, '', '/');
    resetMockBackend();
    expect(await rejection(call('clear_backups'))).toEqual({ code: 'invalidInput', message: 'No game folder set' });
  });
});

describe('mock backend · game folders', () => {
  const OTHER = 'E:\\Games\\War Thunder';

  it('keeps one library per game folder and brings each back', async () => {
    await onboard();
    await call('delete_skins', { ids: ['h1'] });
    await call<Collection>('collections_create', { name: 'Steam only' });
    const steam = await call<HangarSkin[]>('get_hangar');
    const steamCollections = await call<CollectionsState>('collections_list');
    const steamBackups = await call<Backup[]>('list_backups');

    // Another folder: an empty index, two folders on its disk to import, nothing else.
    const detection = await call<GameDetection>('set_game_path', { path: OTHER });
    expect(detection).toMatchObject({ path: OTHER, source: 'custom', existingSkins: 2 });
    expect(await call('get_hangar')).toEqual([]);
    expect(await call('collections_list')).toEqual({ collections: [] });
    expect(await call('list_backups')).toEqual([]);
    const scanned = await call<HangarSkin[]>('scan_user_skins');
    expect(scanned.map((s) => s.folder)).toEqual(['Kursk Dust', 'template_bf-109g-6']);
    const imported = await call<HangarSkin[]>('import_skins', { folders: ['Kursk Dust'] });
    expect(imported.map((s) => s.folder)).toEqual(['Kursk Dust']);

    // Back to Steam (spelled differently): its library as it was.
    const back = await call<GameDetection>('set_game_path', { path: `${MOCK_GAME.path.toUpperCase()}\\`, source: 'steam' });
    expect(back.existingSkins).toBe(MOCK_GAME.existingSkins);
    expect(await call('get_hangar')).toEqual(steam);
    expect(await call('collections_list')).toEqual(steamCollections);
    expect(await call('list_backups')).toEqual(steamBackups);

    // And the other folder kept what was imported there.
    expect((await call<GameDetection>('set_game_path', { path: `${OTHER}\\UserSkins` })).existingSkins).toBe(2);
    expect((await call<HangarSkin[]>('get_hangar')).map((s) => s.folder)).toEqual(['Kursk Dust']);
  });

  it('gives the start-up library to the first folder saved, whichever it is', async () => {
    await call('set_game_path', { path: OTHER });
    expect(await call<HangarSkin[]>('get_hangar')).toHaveLength(12);
    await call('set_game_path', { path: MOCK_GAME.path, source: 'steam' });
    expect(await call('get_hangar')).toEqual([]);
  });

  it('follows a game folder saved through set_settings too', async () => {
    await onboard();
    await call('set_settings', { patch: { gamePath: OTHER } });
    expect(await call('get_hangar')).toEqual([]);
    await call('set_settings', { patch: { gamePath: MOCK_GAME.path } });
    expect(await call<HangarSkin[]>('get_hangar')).toHaveLength(12);
  });
});

describe('mock backend · events', () => {
  it('delivers JSON copies asynchronously, in order, until unlistened', async () => {
    const got: unknown[] = [];
    const off = mockListen<unknown>('test://event', (p) => got.push(p));
    const payload = { n: 1, gone: undefined };
    mockEmit('test://event', payload);
    mockEmit('test://event');
    payload.n = 2;
    expect(got).toEqual([]);
    await Promise.resolve();
    expect(got).toEqual([{ n: 1 }, null]);

    mockEmit('test://event', 3);
    off();
    off();
    await Promise.resolve();
    expect(got).toHaveLength(2);
  });

  it('keeps delivering when a listener throws', async () => {
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    const got: number[] = [];
    const offBad = mockListen('test://event', () => {
      throw new Error('boom');
    });
    const offGood = mockListen<number>('test://event', (n) => got.push(n));
    mockEmit('test://event', 7);
    await Promise.resolve();
    expect(got).toEqual([7]);
    expect(report).toHaveBeenCalledWith(new Error('boom'));
    offBad();
    offGood();
    vi.unstubAllGlobals();
  });
});

describe('mock backend · install queue', () => {
  beforeEach(onboard);

  it('starts with the prototype queue, newest first', async () => {
    const queue = await call<QueueItem[]>('list_queue');
    expect(queue.map((q) => [q.fileName, q.status])).toEqual([
      ['leopard2a6_flecktarn_v3', 'conflict'],
      ['spitfire_mk9_raf_no_611', 'ready'],
      ['unknown_pack', 'needsLook'],
    ]);
    const [conflict, ready, pack] = queue;
    expect(conflict).toMatchObject({ conflictWith: 'h_s4', targetFolder: 'germ_leopard_2a6_Kessler_Wolf' });
    expect(ready).toMatchObject({
      path: `${MOCK_DOWNLOADS}\\spitfire_mk9_raf_no_611`,
      vehicle: { code: 'spitfire_mk9c' },
      textureCount: 2,
      blkOk: true,
      note: '6 files · 2 textures · spitfire_mk9c.blk ok',
    });
    expect(ready?.files).toHaveLength(6);
    expect(pack?.candidates?.map((v) => v.code)).toEqual(['su_27', 'f_4e', 'bf-109g-6']);
    // Like serde: nothing optional is sent empty.
    expect(pack).not.toHaveProperty('vehicle');
    expect(pack).not.toHaveProperty('targetFolder');
    expect(ready).not.toHaveProperty('candidates');
  });

  it('starts empty with ?empty=1', async () => {
    window.history.replaceState(null, '', '/?empty=1');
    resetMockBackend();
    expect(await call<QueueItem[]>('list_queue')).toEqual([]);
  });

  it('analyzes a path by its last segment', async () => {
    const zip = await call<QueueItem>('analyze_archive', { path: 'D:\\Downloads\\camo.zip' });
    expect(zip).toMatchObject({ status: 'error', fileName: 'camo.zip' });
    expect(zip.error).toMatch(/^ZIP, RAR and 7z archives can't be unpacked yet/);
    expect(zip).not.toHaveProperty('files');

    const pack = await call<QueueItem>('analyze_archive', { path: 'D:\\Downloads\\winter_pack\\' });
    expect(pack).toMatchObject({ status: 'needsLook', fileName: 'winter_pack' });
    expect(pack.candidates).toHaveLength(3);

    const clash = await call<QueueItem>('analyze_archive', { path: 'E:\\skins\\Berlin 1945' });
    expect(clash).toMatchObject({
      status: 'conflict',
      conflictWith: 'h3',
      targetFolder: 'Berlin 1945',
      vehicle: { code: 'ussr_t_34_85' },
    });

    const ready = await call<QueueItem>('analyze_archive', { path: 'E:\\skins\\tiger_ambush' });
    expect(ready).toMatchObject({
      status: 'ready',
      targetFolder: 'tiger_ambush',
      vehicle: { code: 'germ_pzkpfw_VI_ausf_b_tiger_IIH' },
      textureCount: 4,
      note: '5 files · 4 textures · germ_pzkpfw_VI_ausf_b_tiger_IIH.blk ok',
    });

    expect(await rejection(call('analyze_archive', { path: 'E:\\notaskin' }))).toEqual({
      code: 'invalidInput',
      message: 'Not a skin folder or archive',
      detail: 'E:\\notaskin',
    });
    const queue = await call<QueueItem[]>('list_queue');
    expect(queue.slice(0, 4).map((q) => q.id)).toEqual([ready.id, clash.id, pack.id, zip.id]);
  });

  it('install answers at once, then emits progress up to done', async () => {
    const { started, events } = await install({ queueId: 'q2' });
    expect(started.installId).toEqual(expect.any(String));
    expect(events[0]).toEqual({ installId: started.installId, queueId: 'q2', step: 'extract', pct: 0 });
    expect(events.map((e) => e.step)).toEqual([...Array<string>(6).fill('extract'), 'verify', 'verify', 'done']);
    const pcts = events.map((e) => e.pct);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
    const done = events.at(-1);
    expect(done).toMatchObject({ step: 'done', pct: 100, skinId: expect.any(String) });
    expect(done).not.toHaveProperty('backupId');

    const hangar = await call<HangarSkin[]>('get_hangar');
    const skin = hangar.find((s) => s.id === done?.skinId);
    expect(skin).toMatchObject({ folder: 'spitfire_mk9_raf_no_611', origin: 'imported', active: true });
    // Its blk references a texture the folder lacks: the scan's attention, and a missing row.
    expect(skin?.attention).toEqual([{ kind: 'missingTexture', message: 'cockpit_c.tga is missing', file: 'cockpit_c.tga' }]);
    const textures = await call<TextureInfo[]>('read_textures', { skinId: skin?.id });
    expect(textures.find((t) => t.file === 'cockpit_c.tga')).toMatchObject({ missing: true });

    expect(await queued('q2')).toMatchObject({ status: 'done' });
    expect(await rejection(call('install_from_archive', { queueId: 'q2' }))).toMatchObject({ code: 'invalidInput' });
  });

  it('shows an item as installing until it is done', async () => {
    configureMockBackend({ timeScale: 1 });
    vi.useFakeTimers();
    try {
      await call<InstallStarted>('install_from_archive', { queueId: 'q2' });
      expect(await queued('q2')).toMatchObject({ status: 'installing' });
      expect(await rejection(call('remove_queue_item', { queueId: 'q2' }))).toMatchObject({ code: 'invalidInput' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await queued('q2')).toMatchObject({ status: 'done' });
      expect(await call('remove_queue_item', { queueId: 'q2' })).toBeNull();
      expect(await queued('q2')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a conflict while the policy is ask, and leaves everything as it was', async () => {
    const error = await rejection(call('install_from_archive', { queueId: 'q1' }));
    expect(error).toEqual({
      code: 'conflict',
      message: 'This skin is already installed',
      detail: 'germ_leopard_2a6_Kessler_Wolf',
    });
    expect(await queued('q1')).toMatchObject({ status: 'conflict', conflictWith: 'h_s4' });
    expect(await call<HangarSkin[]>('get_hangar')).toHaveLength(12);

    // An explicit `ask` is the same; Settings → Conflicts decides when the argument is omitted.
    expect(await rejection(call('install_from_archive', { queueId: 'q1', conflict: 'ask' }))).toMatchObject({
      code: 'conflict',
    });
    await call<Settings>('set_settings', { patch: { conflictPolicy: 'copy' } });
    const { events } = await install({ queueId: 'q1' });
    const hangar = await call<HangarSkin[]>('get_hangar');
    expect(hangar.find((s) => s.id === events.at(-1)?.skinId)?.folder).toBe('germ_leopard_2a6_Kessler_Wolf (2)');
    expect(hangar.find((s) => s.id === 'h_s4')?.name).toBe('Bundeswehr Flecktarn');
    expect(await queued('q1')).toMatchObject({ status: 'done', targetFolder: 'germ_leopard_2a6_Kessler_Wolf (2)' });
  });

  it('replace keeps a backup and undo_replace brings the old version back', async () => {
    const { events } = await install({ queueId: 'q1', conflict: 'replace' });
    const done = events.at(-1);
    expect(done).toMatchObject({ step: 'done', skinId: 'h_s4', backupId: expect.any(String) });

    const replaced = (await call<HangarSkin[]>('get_hangar')).find((s) => s.id === 'h_s4');
    expect(replaced).toMatchObject({ folder: 'germ_leopard_2a6_Kessler_Wolf', name: 'germ_leopard_2a6_Kessler_Wolf' });
    const backups = await call<Backup[]>('list_backups');
    expect(backups[0]).toMatchObject({ id: done?.backupId, skinId: 'h_s4', name: 'Bundeswehr Flecktarn', reason: 'replace' });
    // Collections still hold the skin: the new version kept its id.
    const { collections } = await call<CollectionsState>('collections_list');
    expect(collections.find((c) => c.id === 'c1')?.skinIds).toContain('h_s4');

    const restored = await call<HangarSkin>('undo_replace', { skinId: 'h_s4', backupId: done?.backupId });
    expect(restored).toMatchObject({ id: 'h_s4', name: 'Bundeswehr Flecktarn', folder: 'germ_leopard_2a6_Kessler_Wolf', active: true });
    const hangar = await call<HangarSkin[]>('get_hangar');
    expect(hangar).toHaveLength(12);
    expect(hangar.filter((s) => s.folder.startsWith('germ_leopard_2a6_Kessler_Wolf'))).toEqual([restored]);
    expect(await call<Backup[]>('list_backups')).toHaveLength(3);
    // The backup is used up.
    expect(await rejection(call('undo_replace', { skinId: 'h_s4', backupId: done?.backupId }))).toMatchObject({
      code: 'notFound',
    });
  });

  it('skip installs nothing and takes the item off the queue', async () => {
    const { events } = await install({ queueId: 'q1', conflict: 'skip' });
    expect(events).toEqual([expect.objectContaining({ step: 'done', pct: 100, message: 'skipped' })]);
    expect(events[0]).not.toHaveProperty('skinId');
    expect(await queued('q1')).toBeUndefined();
    expect(await call<HangarSkin[]>('get_hangar')).toHaveLength(12);
  });

  it('needs a vehicle for a folder with several skins, then installs that one', async () => {
    expect(await rejection(call('install_from_archive', { queueId: 'q3' }))).toMatchObject({ code: 'invalidInput' });
    expect(
      await rejection(call('install_from_archive', { queueId: 'q3', vehicleCode: 'us_m1a2_sep' })),
    ).toMatchObject({ code: 'invalidInput' });
    expect(await rejection(call('install_from_archive', { queueId: 'q3', conflict: 'maybe' }))).toMatchObject({
      code: 'internal',
    });

    const { events } = await install({ queueId: 'q3', vehicleCode: 'su_27' });
    const skin = (await call<HangarSkin[]>('get_hangar')).find((s) => s.id === events.at(-1)?.skinId);
    expect(skin).toMatchObject({ folder: 'su_27_Flanker_Splinter', vehicle: { code: 'su_27' } });
    const item = await queued('q3');
    expect(item).toMatchObject({ status: 'done', vehicle: { code: 'su_27' }, targetFolder: 'su_27_Flanker_Splinter' });
    expect(item).not.toHaveProperty('candidates');
  });

  it('rejects archives as unsupported and needs a game folder', async () => {
    const zip = await call<QueueItem>('analyze_archive', { path: 'D:\\Downloads\\camo.7z' });
    const error = await rejection(call('install_from_archive', { queueId: zip.id }));
    expect(error).toMatchObject({ code: 'unsupported', message: zip.error });
    expect(await rejection(call('install_from_archive', { queueId: 'gone' }))).toMatchObject({ code: 'notFound' });

    window.history.replaceState(null, '', '/');
    resetMockBackend();
    expect(await rejection(call('install_from_archive', { queueId: 'q2' }))).toMatchObject({
      code: 'invalidInput',
      message: 'No game folder set',
    });
  });

  it('reads textures like the prototype Textures tab', async () => {
    const heavy = await call<TextureInfo[]>('read_textures', { skinId: 'h1' });
    expect(heavy.map((t) => t.file)).toEqual([
      'hull_c.dds',
      'hull_n.dds',
      'turret_c.dds',
      'turret_n.dds',
      'tracks_c.dds',
      'germ_pzkpfw_VI_ausf_b_tiger_IIH.blk',
    ]);
    expect(heavy[0]).toMatchObject({
      width: 8192,
      height: 8192,
      format: 'BC7',
      warningKind: 'heavy',
      warning: expect.stringContaining('8192²'),
    });
    expect(heavy[1]).toEqual({ file: 'hull_n.dds', width: 4096, height: 4096, format: 'BC5', sizeBytes: 22334669 });
    expect(heavy.at(-1)).toEqual({ file: 'germ_pzkpfw_VI_ausf_b_tiger_IIH.blk', format: 'BLK', sizeBytes: 2048 });

    const missing = await call<TextureInfo[]>('read_textures', { skinId: 'h3' });
    expect(missing.find((t) => t.file === 'turret_c.dds')).toEqual({
      file: 'turret_c.dds',
      warningKind: 'missing',
      missing: true,
      warning: 'Referenced in ussr_t_34_85.blk but not in the skin folder.',
    });

    const pack = await call<TextureInfo[]>('read_textures', { queueId: 'q3' });
    expect(pack.map((t) => t.file)).toContain('f_4e_Aggressor_Grey/wings_c.dds');
    const air = await call<TextureInfo[]>('read_textures', { queueId: 'q2' });
    expect(air.find((t) => t.file === 'cockpit_c.tga')).toMatchObject({ missing: true, warningKind: 'missing' });
    // Rows without a warning carry no kind either.
    expect(air.filter((t) => !t.warning).every((t) => !('warningKind' in t))).toBe(true);

    expect(await rejection(call('read_textures'))).toMatchObject({ code: 'invalidInput' });
    expect(await rejection(call('read_textures', { skinId: 'h1', queueId: 'q2' }))).toMatchObject({
      code: 'invalidInput',
    });
    expect(await rejection(call('read_textures', { skinId: 'nope' }))).toMatchObject({ code: 'notFound' });
  });
});

describe('mock backend · watching', () => {
  afterEach(() => vi.useRealTimers());

  it('saves the watched folder and the toggle', async () => {
    const on = await call<Settings>('watch_folder', { enabled: true });
    expect(on).toMatchObject({ watchFolder: MOCK_DOWNLOADS, autoInstall: true });
    const moved = await call<Settings>('watch_folder', { path: ' E:\\Skins ', enabled: true });
    expect(moved.watchFolder).toBe('E:\\Skins');
    const off = await call<Settings>('watch_folder', { enabled: false });
    expect(off).toMatchObject({ watchFolder: 'E:\\Skins', autoInstall: false });
    expect(await call<Settings>('get_settings')).toEqual(off);
    expect(await rejection(call('watch_folder', { path: '  ', enabled: true }))).toMatchObject({
      code: 'invalidInput',
    });
    expect(await rejection(call('watch_folder', { path: 'E:\\Skins' }))).toMatchObject({ code: 'internal' });
  });

  it('?watch=1 turns watching on and queues a new folder 3 s after load', async () => {
    configureMockBackend({ timeScale: 1 });
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?watch=1');
    resetMockBackend();
    expect(await call<Settings>('get_settings')).toMatchObject({ autoInstall: true, watchFolder: MOCK_DOWNLOADS });
    const added: QueueItem[] = [];
    mockListen<QueueItem>(EVENTS.queueAdded, (item) => added.push(item));

    await vi.advanceTimersByTimeAsync(2900);
    expect(added).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(added).toEqual([
      expect.objectContaining({
        fileName: 'tiger2_h_ambush_winter',
        path: `${MOCK_DOWNLOADS}\\tiger2_h_ambush_winter`,
        status: 'ready',
        vehicle: expect.objectContaining({ name: 'Tiger II (H)' }),
        note: '5 files · 4 textures · germ_pzkpfw_VI_ausf_b_tiger_IIH.blk ok',
      }),
    ]);
    expect((await call<QueueItem[]>('list_queue'))[0]).toEqual(added[0]);
  });

  it('boots with ?watch=1 already in the URL when the module loads', async () => {
    window.history.replaceState(null, '', '/?watch=1');
    vi.resetModules();
    const fresh = await import('./mockBackend');
    fresh.configureMockBackend({ latency: [0, 0] });
    expect(await fresh.mockCall<Settings>('get_settings', {})).toMatchObject({ autoInstall: true });
    window.history.replaceState(null, '', '/');
    fresh.resetMockBackend(); // drops the pending watcher timer
  });

  it('?watch=1 stays quiet once watching is turned off', async () => {
    configureMockBackend({ timeScale: 1 });
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?watch=1');
    resetMockBackend();
    const added: QueueItem[] = [];
    mockListen<QueueItem>(EVENTS.queueAdded, (item) => added.push(item));
    await call<Settings>('watch_folder', { enabled: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(added).toEqual([]);
    expect(await call<QueueItem[]>('list_queue')).toHaveLength(3);
  });
});

describe('mock backend · WT Live search', () => {
  it('lists the prototype catalog, most downloaded first, with its count and time', async () => {
    const result = await search();
    expect(result).toMatchObject({ total: 16, tookMs: 28 });
    expect(postIds(result)).toEqual([
      's4', 's9', 's3', 's6', 's1', 's8', 's16', 's14', 's2', 's7', 's13', 's11', 's10', 's15', 's12', 's5',
    ]);
    expect(result.items.find((s) => s.id === 's1')).toEqual({
      id: 's1',
      name: 'Schwarzwald Ambush',
      vehicle: { code: 'germ_pzkpfw_VI_ausf_b_tiger_IIH', name: 'Tiger II (H)', nation: 'GER', type: 'ground', class: 'Heavy tank' },
      author: { id: '40318255', name: 'Kessler_Wolf', url: 'https://live.warthunder.com/user/40318255/', skinCount: 14 },
      category: 'Historical',
      downloads: 24120,
      likes: 1932,
      postedAt: '2026-06-12T17:48:09Z',
      sizeBytes: 48 * MB + 407 * KB,
      images: [],
      postUrl: 'https://live.warthunder.com/post/1043217/en/',
      downloadUrl: expect.stringMatching(/^https:\/\/live\.warthunder\.com\/dl\/[0-9a-f]+\/$/),
    });
    // New from a follow: the prototype's flags. Listings carry no files (the post does).
    expect(result.items.filter((s) => s.isNew).map((s) => s.id)).toEqual(['s14', 's11', 's12', 's5']);
    expect(result.items.some((s) => 'files' in s || ('isNew' in s && s.isNew !== true))).toBe(false);
    expect(result.items.every((s) => s.author.skinCount !== undefined)).toBe(true);
  });

  it('combines filters (AND); q matches the skin, vehicle or author name', async () => {
    expect(postIds(await search({ nation: 'GER', type: 'ground' }))).toEqual(['s4', 's1', 's14', 's13', 's11']);
    const combined = await search({ nation: 'GER', type: 'ground', category: 'Historical' });
    expect(combined).toMatchObject({ total: 3, tookMs: 15 });
    expect(postIds(combined)).toEqual(['s4', 's1', 's14']);
    expect(postIds(await search({ q: '  KESSLER ' }))).toEqual(['s4', 's1', 's14']);
    expect(postIds(await search({ q: 'phantom' }))).toEqual(['s6', 's12']);
    expect(postIds(await search({ q: 'winter' }))).toEqual(['s14', 's2']);
    expect(postIds(await search({ class: 'fighter', type: 'air' }))).toEqual(['s9', 's8', 's16', 's7', 's15']);
    expect(postIds(await search({ vehicle: 'su_27' }))).toEqual(['s9', 's16']);
    // A vehicle code, not a prefix.
    expect(postIds(await search({ vehicle: 'su_2' }))).toEqual([]);
    expect(await search({ nation: 'ITA', category: 'Historical' })).toEqual({ items: [], total: 0, tookMs: 12 });
    // Null or blank means any, like serde's Option.
    expect((await search({ nation: null, q: '  ', class: null })).total).toBe(16);
  });

  it('sorts by likes, newest or name, and pages by 60', async () => {
    expect(postIds(await search({ sort: 'likes' })).slice(0, 3)).toEqual(['s4', 's9', 's3']);
    expect(postIds(await search({ sort: 'newest' })).slice(0, 5)).toEqual(['s14', 's11', 's12', 's5', 's10']);
    const byName = await search({ sort: 'name' });
    expect(byName.items.map((s) => s.name).slice(0, 3)).toEqual(['Ace of Spades', 'Baltic Winter', 'Bundeswehr Flecktarn']);
    expect(byName.items.at(-1)?.name).toBe("Winter '44 Whitewash");
    expect(await search({ page: 1 })).toEqual({ items: [], total: 16, tookMs: 12 });
  });

  it('?many=1 has 1,284 posts to page through', async () => {
    window.history.replaceState(null, '', '/?many=1');
    resetMockBackend();
    const first = await search();
    expect(first).toMatchObject({ total: 1284, tookMs: 72 });
    expect(first.items).toHaveLength(60);
    const seen = new Set<string>();
    for (let page = 0; page < 22; page += 1) postIds(await search({ page })).forEach((id) => seen.add(id));
    expect(seen.size).toBe(1284);
    expect((await search({ page: 21 })).items).toHaveLength(24);
    expect((await search({ page: 22 })).items).toEqual([]);
    for (const category of ['Camouflage', 'Other']) expect((await search({ category })).total).toBeGreaterThan(0);
  });

  it('rejects malformed params like serde', async () => {
    const malformed: unknown[] = [
      undefined,
      { page: 0 },
      { sort: 'popular', page: 0 },
      { sort: 'name', page: -1 },
      { sort: 'name', page: 1.5 },
      { sort: 'name', page: 0, nation: 'Germany' },
      { sort: 'name', page: 0, type: 'tank' },
      { sort: 'name', page: 0, category: 'historical' },
      { sort: 'name', page: 0, q: 3 },
    ];
    for (const params of malformed) {
      expect(await rejection(call('wtlive_search', { params }))).toEqual({
        code: 'internal',
        message: 'invalid args `params` for command `wtlive_search`',
      });
    }
  });

  it('answers a post with the files in its archive', async () => {
    const post = await call<WtLiveSkin>('wtlive_post', { id: 's6' });
    expect(post).toMatchObject({ id: 's6', name: 'SEA Camo, 388th TFW', images: [] });
    expect(post.files?.map((f) => f.path)).toEqual([
      'fuselage_c.dds',
      'fuselage_n.dds',
      'wings_c.dds',
      'cockpit_c.tga',
      'f_4e.blk',
      'preview.jpg',
    ]);
    const s5 = await call<WtLiveSkin>('wtlive_post', { id: 's5' });
    expect(s5.isNew).toBe(true);
    expect(s5.files?.map((f) => f.path)).not.toContain('turret_n.dds');
    expect(await rejection(call('wtlive_post', { id: 's99' }))).toEqual({
      code: 'notFound',
      message: 'This skin is no longer on WT Live',
      detail: 's99',
    });
    expect((await call<WtLiveSkin>('wtlive_post', { id: ' s6 ' })).id).toBe('s6');
  });

  it('rejects a blank WT Live id first, and that says nothing about reaching WT Live', async () => {
    const statuses: NetStatus[] = [];
    mockListen<NetStatus>(EVENTS.netStatus, (s) => statuses.push(s));
    const blank = { code: 'invalidInput', message: 'Pass the id of a WT Live skin' };
    expect(await rejection(call('wtlive_post', { id: ' ' }))).toEqual(blank);
    expect(await rejection(call('install_from_wtlive', { skinId: '', mode: 'normal' }))).toEqual(blank);
    expect(await rejection(call('read_textures', { wtliveId: '' }))).toEqual(blank);
    expect(await rejection(call('finalize_try', { skinId: ' ', keep: false }))).toEqual(blank);
    // Neither does an unknown post.
    expect(await rejection(call('wtlive_post', { id: 's99' }))).toMatchObject({ code: 'notFound' });
    expect(statuses).toEqual([]);
  });

  it("reads a post's textures like the prototype Textures tab", async () => {
    const s3 = await call<TextureInfo[]>('read_textures', { wtliveId: 's3' });
    expect(s3.map((t) => t.file)).toEqual([
      'hull_c.dds',
      'hull_n.dds',
      'turret_c.dds',
      'turret_n.dds',
      'tracks_c.dds',
      'us_m1a2_sep.blk',
    ]);
    expect(s3[0]).toEqual({
      file: 'hull_c.dds',
      width: 8192,
      height: 8192,
      format: 'BC7',
      sizeBytes: Math.round(85.3 * MB),
      warningKind: 'heavy',
      warning: 'Very heavy texture (8192²). Load times may suffer.',
    });
    const s5 = await call<TextureInfo[]>('read_textures', { wtliveId: 's5' });
    expect(s5[3]).toEqual({
      file: 'turret_n.dds',
      warningKind: 'missing',
      warning: 'Referenced in it_c1_ariete.blk but not in the archive.',
      missing: true,
    });
    expect(s5.filter((t) => t.warningKind)).toHaveLength(1);
    const s8 = await call<TextureInfo[]>('read_textures', { wtliveId: 's8' });
    expect(s8.at(-1)).toEqual({ file: 'spitfire_mk9c.blk', format: 'BLK', sizeBytes: 2048 });
    expect(s8.some((t) => t.warning || t.warningKind)).toBe(false);
    expect(await rejection(call('read_textures', { wtliveId: 's99' }))).toMatchObject({ code: 'notFound' });
    expect(await rejection(call('read_textures', { wtliveId: 's3', skinId: 'h1' }))).toEqual({
      code: 'invalidInput',
      message: 'Pass exactly one of a skin id, a queue id or a WT Live id',
    });
  });
});

describe('mock backend · following', () => {
  it('seeds the prototype follows and answers their new posts', async () => {
    const following = await call<FollowEntry[]>('following_list');
    expect(following).toEqual([
      { kind: 'vehicle', id: 'germ_leopard_2a6', name: 'Leopard 2A6', lastSeenAt: FOLLOWING_SEEN_AT },
      { kind: 'author', id: '40318255', name: 'Kessler_Wolf', lastSeenAt: FOLLOWING_SEEN_AT },
      { kind: 'author', id: '61240877', name: 'Skyhook_Dan', lastSeenAt: FOLLOWING_SEEN_AT },
      { kind: 'vehicle', id: 'spitfire_mk9c', name: 'Spitfire Mk IX', lastSeenAt: FOLLOWING_SEEN_AT },
    ]);
    const fresh = await call<WtLiveSkin[]>('wtlive_following_new', {
      vehicles: ['germ_leopard_2a6', 'spitfire_mk9c'],
      authors: ['40318255', '61240877'],
    });
    expect(fresh.map((s) => s.id)).toEqual(['s14', 's11', 's12']);
    // The prototype's "N new" per follow: its new posts since it was last seen.
    const newFor = (f: FollowEntry) =>
      fresh.filter((s) => (f.kind === 'vehicle' ? s.vehicle.code : s.author.id) === f.id && s.postedAt > f.lastSeenAt).length;
    expect(following.map(newFor)).toEqual([2, 1, 1, 0]);
    expect(fresh.every((s) => s.isNew)).toBe(true);
    expect(fresh.find((s) => s.id === 's14')?.author.skinCount).toBe(14);
    expect(await call('wtlive_following_new', { vehicles: [], authors: [] })).toEqual([]);
    // Ids that aren't followed are left out, even with new posts (Tricolore Parade).
    expect(await call('wtlive_following_new', { vehicles: ['it_c1_ariete'], authors: ['83316042'] })).toEqual([]);
    // Each entry counts from its own lastSeenAt: once seen, nothing is new.
    await call('following_mark_seen');
    expect(
      await call('wtlive_following_new', { vehicles: ['germ_leopard_2a6'], authors: ['40318255', '61240877'] }),
    ).toEqual([]);
  });

  it('follows, unfollows and marks everything seen', async () => {
    const added = await call<FollowEntry[]>('following_set', {
      kind: 'author',
      id: '83316042',
      name: ' Vesuvio_Skins ',
      follow: true,
    });
    expect(added).toHaveLength(5);
    expect(added.at(-1)).toMatchObject({ kind: 'author', id: '83316042', name: 'Vesuvio_Skins' });
    expect(Date.parse(added.at(-1)?.lastSeenAt ?? '')).toBeGreaterThan(Date.parse(FOLLOWING_SEEN_AT));
    // Following again only refreshes the name; unfollowing something not followed changes nothing.
    expect(await call('following_set', { kind: 'author', id: '83316042', name: 'Vesuvio_Skins', follow: true })).toEqual(added);
    const renamed = await call<FollowEntry[]>('following_set', { kind: 'author', id: '83316042', name: 'Vesuvio', follow: true });
    expect(renamed.at(-1)).toEqual({ ...added.at(-1), name: 'Vesuvio' });
    const removed = await call<FollowEntry[]>('following_set', {
      kind: 'vehicle',
      id: 'spitfire_mk9c',
      name: 'Spitfire Mk IX',
      follow: false,
    });
    expect(removed.map((f) => f.id)).toEqual(['germ_leopard_2a6', '40318255', '61240877', '83316042']);
    // A vehicle and an author are different follows even with the same id.
    expect(await call('following_set', { kind: 'author', id: 'germ_leopard_2a6', name: 'x', follow: false })).toEqual(removed);
    expect(await rejection(call('following_set', { kind: 'squad', id: 'x', name: 'x', follow: true }))).toMatchObject({
      code: 'internal',
    });
    expect(await rejection(call('following_set', { kind: 'vehicle', id: ' ', name: 'x', follow: true }))).toEqual({
      code: 'invalidInput',
      message: 'Pass the id of the vehicle or author to follow',
    });
    expect(await rejection(call('following_set', { kind: 'vehicle', id: 'su_27', name: ' ', follow: true }))).toEqual({
      code: 'invalidInput',
      message: 'Pass the name of the vehicle or author to follow',
    });

    const seen = await call<FollowEntry[]>('following_mark_seen');
    expect(seen).toHaveLength(4);
    expect(new Set(seen.map((f) => f.lastSeenAt)).size).toBe(1);
    expect(Date.parse(seen[0]?.lastSeenAt ?? '')).toBeGreaterThan(Date.parse(FOLLOWING_SEEN_AT));
    expect(await call('following_list')).toEqual(seen);
  });

  it('trims id and name, and following again keeps lastSeenAt', async () => {
    const list = await call<FollowEntry[]>('following_set', {
      kind: 'vehicle',
      id: ' germ_leopard_2a6 ',
      name: ' Leopard 2A6 (renamed) ',
      follow: true,
    });
    expect(list).toHaveLength(4);
    expect(list[0]).toEqual({
      kind: 'vehicle',
      id: 'germ_leopard_2a6',
      name: 'Leopard 2A6 (renamed)',
      lastSeenAt: FOLLOWING_SEEN_AT,
    });
    const off = await call<FollowEntry[]>('following_set', {
      kind: 'vehicle',
      id: 'germ_leopard_2a6 ',
      name: 'x',
      follow: false,
    });
    expect(off.map((f) => f.id)).not.toContain('germ_leopard_2a6');
  });

  it('Undo of an unfollow: lastSeenAt brings the entry back exactly', async () => {
    const before = await call<FollowEntry[]>('following_list');
    const [leopard] = before;
    if (!leopard) throw new Error('seeded follows');
    await call('following_set', { ...leopard, follow: false });
    const undone = await call<FollowEntry[]>('following_set', { ...leopard, follow: true });
    expect(undone.at(-1)).toEqual(leopard);
    // The "N new" count is back: the posts after the old lastSeenAt are new again.
    const fresh = await call<WtLiveSkin[]>('wtlive_following_new', { vehicles: [leopard.id], authors: [] });
    expect(fresh).toHaveLength(2);

    // It also replaces the lastSeenAt of an entry already followed, and a new one takes it as given.
    const moved = await call<FollowEntry[]>('following_set', {
      ...leopard,
      lastSeenAt: ' 2026-01-01T00:00:00.5+01:00 ',
      follow: true,
    });
    expect(moved.at(-1)?.lastSeenAt).toBe('2026-01-01T00:00:00.5+01:00');
    const added = await call<FollowEntry[]>('following_set', {
      kind: 'author',
      id: 'a-new',
      name: 'New',
      follow: true,
      lastSeenAt: '2026-02-28T00:00:00Z',
    });
    expect(added.at(-1)).toEqual({ kind: 'author', id: 'a-new', name: 'New', lastSeenAt: '2026-02-28T00:00:00Z' });
    const again = { kind: 'author', id: 'a-new', name: 'New', follow: true, lastSeenAt: null };
    expect(await call('following_set', again)).toEqual(added);
  });

  it('refuses a lastSeenAt that is not RFC 3339, even with an unfollow', async () => {
    const before = await call<FollowEntry[]>('following_list');
    const follow = (lastSeenAt: unknown, more: Record<string, unknown> = {}) =>
      rejection(call('following_set', { kind: 'author', id: 'a1', name: 'A', follow: true, lastSeenAt, ...more }));
    for (const bad of ['', 'yesterday', '2026-02-29T00:00:00Z', '2026-09-19', '2026-09-19T25:00:00Z']) {
      expect(await follow(bad)).toEqual({ code: 'invalidInput', message: 'Not an RFC 3339 time', detail: bad });
    }
    const unfollow = { kind: 'vehicle', id: 'germ_leopard_2a6', follow: false };
    expect(await follow('soon', unfollow)).toMatchObject({ code: 'invalidInput', message: 'Not an RFC 3339 time' });
    // A blank id is reported first.
    expect(await follow('soon', { id: ' ' })).toMatchObject({ message: 'Pass the id of the vehicle or author to follow' });
    expect(await follow(7)).toMatchObject({ code: 'internal' });
    expect(await call('following_list')).toEqual(before);
  });

  it('follows nothing with ?empty=1, while WT Live keeps its catalog', async () => {
    window.history.replaceState(null, '', '/?empty=1');
    resetMockBackend();
    expect(await call('following_list')).toEqual([]);
    expect((await search()).total).toBe(16);
  });
});

describe('mock backend · WT Live installs', () => {
  beforeEach(onboard);

  it('answers at once, then walks download → extract → verify → done into the hangar', async () => {
    const { started, events } = await installWt({ skinId: 's1', mode: 'normal' });
    expect(events[0]).toEqual({ installId: started.installId, step: 'download', pct: 0 });
    expect(events.map((e) => e.step)).toEqual([
      ...Array<string>(6).fill('download'),
      ...Array<string>(3).fill('extract'),
      ...Array<string>(3).fill('verify'),
      'done',
    ]);
    const pcts = events.map((e) => e.pct);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
    const lastOf = (step: string) => events.filter((e) => e.step === step).at(-1)?.pct;
    expect([lastOf('download'), lastOf('extract'), lastOf('verify')]).toEqual([40, 75, 96]);
    const done = events.at(-1);
    expect(done).toEqual({ installId: started.installId, step: 'done', pct: 100, skinId: expect.any(String) });

    const post = await call<WtLiveSkin>('wtlive_post', { id: 's1' });
    const skin = await hangarSkin(done?.skinId);
    expect(skin).toMatchObject({
      folder: 'germ_pzkpfw_VI_ausf_b_tiger_IIH_Kessler_Wolf',
      name: 'Schwarzwald Ambush',
      origin: 'wtlive',
      sourceId: 's1',
      author: post.author,
      vehicle: post.vehicle,
      sizeBytes: post.sizeBytes,
      active: true,
    });
    expect(skin).not.toHaveProperty('temporary');
    expect(skin).not.toHaveProperty('attention');
    expect(await call<HangarSkin[]>('get_hangar')).toHaveLength(13);
    expect(await call('read_textures', { skinId: skin?.id })).toEqual(await call('read_textures', { wtliveId: 's1' }));
  });

  it('takes about 3 s, and a post installs once at a time', async () => {
    configureMockBackend({ timeScale: 1 });
    vi.useFakeTimers();
    try {
      const seen: InstallProgress[] = [];
      mockListen<InstallProgress>(EVENTS.installProgress, (p) => seen.push(p));
      await call<InstallStarted>('install_from_wtlive', { skinId: 's9', mode: 'normal' });
      expect(await rejection(call('install_from_wtlive', { skinId: 's9', mode: 'temporary' }))).toMatchObject({
        code: 'invalidInput',
      });
      await vi.advanceTimersByTimeAsync(2900);
      expect(seen.at(-1)).toMatchObject({ step: 'verify', pct: 96 });
      await vi.advanceTimersByTimeAsync(100);
      expect(seen.at(-1)).toMatchObject({ step: 'done', pct: 100 });
      // Installed now: another install is a conflict.
      expect(await rejection(call('install_from_wtlive', { skinId: 's9', mode: 'normal' }))).toMatchObject({
        code: 'conflict',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes to \"<folder> (2)\" when another post's skin has the folder", async () => {
    const { events } = await installWt({ skinId: 's14', mode: 'normal' });
    expect(await hangarSkin(events.at(-1)?.skinId)).toMatchObject({
      folder: 'germ_leopard_2a6_Kessler_Wolf (2)',
      name: 'Baltic Winter',
      sourceId: 's14',
    });
    expect(await hangarSkin('h_s4')).toMatchObject({ folder: 'germ_leopard_2a6_Kessler_Wolf', name: 'Bundeswehr Flecktarn' });
  });

  it('settles an installed post like the queue: ask rejects, skip, copy, replace with undo', async () => {
    expect(await rejection(call('install_from_wtlive', { skinId: 's4', mode: 'normal' }))).toEqual({
      code: 'conflict',
      message: 'This skin is already installed',
      detail: 'germ_leopard_2a6_Kessler_Wolf',
    });
    expect(await rejection(call('install_from_wtlive', { skinId: 's4', mode: 'temporary', conflict: 'ask' }))).toMatchObject({
      code: 'conflict',
    });
    expect(await call<HangarSkin[]>('get_hangar')).toHaveLength(12);

    const skipped = await installWt({ skinId: 's4', mode: 'normal', conflict: 'skip' });
    expect(skipped.events).toEqual([expect.objectContaining({ step: 'done', pct: 100, message: 'skipped' })]);
    expect(skipped.events[0]).not.toHaveProperty('skinId');
    expect(await call<HangarSkin[]>('get_hangar')).toHaveLength(12);

    const copied = await installWt({ skinId: 's4', mode: 'normal', conflict: 'copy' });
    expect(await hangarSkin(copied.events.at(-1)?.skinId)).toMatchObject({
      name: 'Bundeswehr Flecktarn (2)',
      folder: 'germ_leopard_2a6_Kessler_Wolf (2)',
      sourceId: 's4',
    });

    const replaced = await installWt({ skinId: 's6', mode: 'normal', conflict: 'replace' });
    const done = replaced.events.at(-1);
    expect(done).toMatchObject({ step: 'done', skinId: 'h_s6', backupId: expect.any(String) });
    expect((await call<Backup[]>('list_backups'))[0]).toMatchObject({
      id: done?.backupId,
      skinId: 'h_s6',
      name: 'SEA Camo, 388th TFW',
      reason: 'replace',
    });
    const newer = await hangarSkin('h_s6');
    expect(newer).toMatchObject({ folder: 'f_4e_Skyhook_Dan', sourceId: 's6', origin: 'wtlive' });
    expect(newer?.installedAt).not.toBe('2026-03-04T19:22:41Z');
    const restored = await call<HangarSkin>('undo_replace', { skinId: 'h_s6', backupId: done?.backupId });
    expect(restored).toMatchObject({ id: 'h_s6', folder: 'f_4e_Skyhook_Dan', installedAt: '2026-03-04T19:22:41Z' });

    // Without the argument, Settings → Conflicts decides.
    await call<Settings>('set_settings', { patch: { conflictPolicy: 'copy' } });
    const byPolicy = await installWt({ skinId: 's8', mode: 'normal' });
    expect((await hangarSkin(byPolicy.events.at(-1)?.skinId))?.name).toBe('D-Day Invasion Stripes (2)');
  });

  it('Try in game installs temporarily, then Keep or Discard', async () => {
    const tried = await installWt({ skinId: 's3', mode: 'temporary' });
    const id = tried.events.at(-1)?.skinId;
    expect(await hangarSkin(id)).toMatchObject({
      sourceId: 's3',
      temporary: true,
      active: true,
      folder: 'us_m1a2_sep_ironclad_mia',
    });
    // Activating a collection leaves the skin being tried in the game.
    await call('activate_collection', { id: 'c2' });
    expect((await hangarSkin(id))?.active).toBe(true);

    const kept = await call<HangarSkin>('finalize_try', { skinId: 's3', keep: true });
    expect(kept).toMatchObject({ id, sourceId: 's3' });
    expect(kept).not.toHaveProperty('temporary');
    expect(await hangarSkin(id)).toEqual(kept);
    expect(await rejection(call('finalize_try', { skinId: 's3', keep: true }))).toMatchObject({ code: 'notFound' });

    // s5 lacks a texture: the scan flags it. Discard leaves nothing behind, not even a backup.
    const second = await installWt({ skinId: 's5', mode: 'temporary' });
    const secondId = second.events.at(-1)?.skinId;
    expect((await hangarSkin(secondId))?.attention).toEqual([
      { kind: 'missingTexture', message: 'turret_n.dds is missing', file: 'turret_n.dds' },
    ]);
    expect(await call('finalize_try', { skinId: 's5', keep: false })).toBeNull();
    expect((await call<HangarSkin[]>('get_hangar')).some((s) => s.sourceId === 's5')).toBe(false);
    expect(await call<Backup[]>('list_backups')).toHaveLength(3);
    expect(await rejection(call('read_textures', { skinId: secondId }))).toMatchObject({ code: 'notFound' });
  });

  it('Discard puts back the version a Try in game replaced', async () => {
    const before = await hangarSkin('h_s8');
    const tried = await installWt({ skinId: 's8', mode: 'temporary', conflict: 'replace' });
    expect(tried.events.at(-1)).toMatchObject({ skinId: 'h_s8', backupId: expect.any(String) });
    expect(await hangarSkin('h_s8')).toMatchObject({ temporary: true, sourceId: 's8' });
    expect(await call('finalize_try', { skinId: 's8', keep: false })).toBeNull();
    expect(await hangarSkin('h_s8')).toEqual(before);
    expect(await call<HangarSkin[]>('get_hangar')).toHaveLength(12);
    expect(await call<Backup[]>('list_backups')).toHaveLength(3);
  });

  it('a normal install of a post being tried takes over its skin', async () => {
    const tried = await installWt({ skinId: 's7', mode: 'temporary' });
    const kept = await installWt({ skinId: 's7', mode: 'normal' });
    expect(kept.events.at(-1)?.skinId).toBe(tried.events.at(-1)?.skinId);
    const skins = (await call<HangarSkin[]>('get_hangar')).filter((s) => s.sourceId === 's7');
    expect(skins).toHaveLength(1);
    expect(skins[0]).not.toHaveProperty('temporary');
  });

  it('checks its arguments and needs a game folder', async () => {
    expect(await rejection(call('install_from_wtlive', { skinId: 's1', mode: 'forever' }))).toMatchObject({
      code: 'internal',
    });
    expect(await rejection(call('install_from_wtlive', { skinId: 's1', mode: 'normal', conflict: 'maybe' }))).toMatchObject({
      code: 'internal',
    });
    expect(await rejection(call('install_from_wtlive', { skinId: 's99', mode: 'normal' }))).toMatchObject({
      code: 'notFound',
    });
    expect(await rejection(call('finalize_try', { skinId: 's1' }))).toMatchObject({ code: 'internal' });

    window.history.replaceState(null, '', '/');
    resetMockBackend();
    const noFolder = { code: 'invalidInput', message: 'No game folder set' };
    expect(await rejection(call('install_from_wtlive', { skinId: 's1', mode: 'normal' }))).toEqual(noFolder);
    expect(await rejection(call('finalize_try', { skinId: 's1', keep: true }))).toEqual(noFolder);
  });
});

describe('mock backend · offline', () => {
  afterEach(() => localStorage.removeItem('livery.mock.offline'));

  it('?offline=1: WT Live calls reject network, net://status goes offline once, local data works', async () => {
    window.history.replaceState(null, '', '/?offline=1');
    resetMockBackend();
    await onboard();
    const statuses: NetStatus[] = [];
    mockListen<NetStatus>(EVENTS.netStatus, (s) => statuses.push(s));
    const network = { code: 'network', message: "WT Live can't be reached" };
    expect(await rejection(search())).toEqual(network);
    expect(await rejection(call('wtlive_post', { id: 's1' }))).toEqual(network);
    expect(await rejection(call('wtlive_following_new', { vehicles: ['f_4e'], authors: [] }))).toEqual(network);
    expect(await rejection(call('install_from_wtlive', { skinId: 's1', mode: 'normal' }))).toEqual(network);
    expect(await rejection(call('read_textures', { wtliveId: 's1' }))).toEqual(network);
    expect(statuses).toEqual(Array<NetStatus>(5).fill({ online: false }));

    expect(await call<FollowEntry[]>('following_list')).toHaveLength(4);
    expect(await call<FollowEntry[]>('following_mark_seen')).toHaveLength(4);
    expect(await call<HangarSkin[]>('get_hangar')).toHaveLength(12);
    expect(await call<TextureInfo[]>('read_textures', { skinId: 'h1' })).toHaveLength(6);
  });

  it('reads the localStorage switch on every call and comes back online', async () => {
    const statuses: NetStatus[] = [];
    mockListen<NetStatus>(EVENTS.netStatus, (s) => statuses.push(s));
    expect((await search()).total).toBe(16);

    localStorage.setItem('livery.mock.offline', '1');
    expect(await rejection(search())).toMatchObject({ code: 'network' });
    localStorage.removeItem('livery.mock.offline');
    expect((await search()).total).toBe(16);
    expect(statuses).toEqual([{ online: true }, { online: false }, { online: true }]);
  });

  it('works for Try in game offline: finalize_try is local', async () => {
    await onboard();
    const tried = await installWt({ skinId: 's2', mode: 'temporary' });
    localStorage.setItem('livery.mock.offline', '1');
    const statuses: NetStatus[] = [];
    mockListen<NetStatus>(EVENTS.netStatus, (s) => statuses.push(s));
    expect(await call<HangarSkin>('finalize_try', { skinId: 's2', keep: true })).toMatchObject({
      id: tried.events.at(-1)?.skinId,
    });
    expect(statuses).toEqual([]);
  });
});
