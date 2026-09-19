import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AppError,
  Backup,
  Collection,
  CollectionsState,
  DeleteResult,
  DetectEvent,
  GameDetection,
  HangarSkin,
  Settings,
} from '@/types';
import { configureMockBackend, mockCall, mockDetectGame, resetMockBackend } from './mockBackend';
import { MOCK_GAME } from './mockData';

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

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  configureMockBackend({ latency: [0, 0] });
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
