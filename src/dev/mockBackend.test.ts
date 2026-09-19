import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENTS,
  type AppError,
  type Backup,
  type Collection,
  type CollectionsState,
  type DeleteResult,
  type DetectEvent,
  type GameDetection,
  type HangarSkin,
  type InstallProgress,
  type InstallStarted,
  type QueueItem,
  type Settings,
  type TextureInfo,
} from '@/types';
import {
  configureMockBackend,
  mockCall,
  mockDetectGame,
  mockEmit,
  mockListen,
  resetMockBackend,
} from './mockBackend';
import { MOCK_DOWNLOADS, MOCK_GAME } from './mockData';

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

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  configureMockBackend({ latency: [0, 0], timeScale: 0 });
  resetMockBackend();
});

describe('mock backend · start-up', () => {
  it('starts on First run with the prototype hangar and collections', async () => {
    const settings = await call<Settings>('get_settings');
    expect(settings).toMatchObject({ onboarded: false, backups: true, backupDays: 30 });
    expect(settings.gamePath).toBeUndefined();

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

  it('rejects unknown commands with noBackend', async () => {
    expect(await rejection(call('install_skin'))).toMatchObject({ code: 'noBackend' });
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
    expect(heavy[0]).toMatchObject({ width: 8192, height: 8192, format: 'BC7', warning: expect.stringContaining('8192²') });
    expect(heavy[1]).toEqual({ file: 'hull_n.dds', width: 4096, height: 4096, format: 'BC5', sizeBytes: 22334669 });
    expect(heavy.at(-1)).toEqual({ file: 'germ_pzkpfw_VI_ausf_b_tiger_IIH.blk', format: 'BLK', sizeBytes: 2048 });

    const missing = await call<TextureInfo[]>('read_textures', { skinId: 'h3' });
    expect(missing.find((t) => t.file === 'turret_c.dds')).toEqual({
      file: 'turret_c.dds',
      missing: true,
      warning: 'Referenced in ussr_t_34_85.blk but not in the skin folder.',
    });

    const pack = await call<TextureInfo[]>('read_textures', { queueId: 'q3' });
    expect(pack.map((t) => t.file)).toContain('f_4e_Aggressor_Grey/wings_c.dds');
    const air = await call<TextureInfo[]>('read_textures', { queueId: 'q2' });
    expect(air.find((t) => t.file === 'cockpit_c.tga')).toMatchObject({ missing: true });

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
