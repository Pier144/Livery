import { beforeEach, describe, expect, it } from 'vitest';
import { parseModelBuffer } from '@/atelier/modelBuffer';
import {
  EVENTS,
  type AppError,
  type ApplyProgress,
  type ApplyResult,
  type ApplyStarted,
  type AtelierProject,
  type AtelierProjectSummary,
  type HangarSkin,
  type Settings,
} from '@/types';
import { configureMockBackend, mockCall, mockListen, resetMockBackend } from './mockBackend';
import { MOCK_GAME } from './mockData';
import { MOCK_TEXTURE_SIZE, mockTemplate } from './mockAtelier';

const VEHICLE = 'germ_leopard_2a6';
const BODY = `${VEHICLE}_body_c`;
const TURRET = `${VEHICLE}_turret_c`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const call = <T>(cmd: string, args: Record<string, unknown> = {}) => mockCall<T>(cmd, args);
const raw = <T>(cmd: string, body: Uint8Array, headers: Record<string, string>) =>
  mockCall<T>(cmd, { __body: body, __headers: headers });

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected the command to fail');
}

async function onboard() {
  await call('set_game_path', { path: MOCK_GAME.path, source: 'steam' });
}

const create = (name = 'Desert camo') => call<AtelierProject>('atelier_project_create', { name, vehicle: VEHICLE });
const list = () => call<AtelierProjectSummary[]>('atelier_projects');
const texture = (applyId: string, slot: string, size = 8, bytes = size * size * 4) =>
  raw<null>('atelier_apply_texture', new Uint8Array(bytes), {
    'x-apply-id': applyId,
    'x-slot': slot,
    'x-width': String(size),
    'x-height': String(size),
  });

beforeEach(async () => {
  window.history.replaceState(null, '', '/');
  configureMockBackend({ latency: [0, 0], timeScale: 0 });
  resetMockBackend();
  await onboard();
});

describe('mock Atelier · model', () => {
  it('answers the cube as an LVM1 binary and the templates as RGBA8', async () => {
    const model = parseModelBuffer(await call<ArrayBuffer>('atelier_model', { vehicle: VEHICLE }));
    expect(model.header.slots.map((s) => s.texture)).toEqual([BODY, TURRET, `${VEHICLE}_gun_c`]);

    const template = await call<ArrayBuffer>('atelier_template_texture', { vehicle: VEHICLE, slot: TURRET.toUpperCase() });
    expect(template).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(template)).toEqual(mockTemplate(1));
    expect(template.byteLength).toBe(MOCK_TEXTURE_SIZE * MOCK_TEXTURE_SIZE * 4);
  });

  it('refuses unknown vehicles and slots, and needs Read data from the game and a game folder', async () => {
    expect(await rejection(call('atelier_model', { vehicle: 'f_4e' }))).toMatchObject({
      code: 'notFound',
      message: "This vehicle's 3D model isn't in the game's files",
    });
    expect(await rejection(call('atelier_template_texture', { vehicle: VEHICLE, slot: 'other_c' }))).toMatchObject({
      code: 'notFound',
      message: "A texture of this vehicle isn't in the game's files",
    });
    await call<Settings>('set_settings', { patch: { readGameData: false } });
    expect(await rejection(call('atelier_model', { vehicle: VEHICLE }))).toEqual({
      code: 'invalidInput',
      message: 'Atelier needs Read data from the game turned on',
    });
    expect(await rejection(create())).toMatchObject({ code: 'invalidInput' });
  });
});

describe('mock Atelier · projects', () => {
  it('creates, lists, gets and saves a project; layers are kept as they come', async () => {
    const created = await create('  Desert camo ');
    expect(created).toMatchObject({
      version: 1,
      name: 'Desert camo',
      vehicle: VEHICLE,
      layers: [],
      output: { highQuality: false },
    });
    expect(created.slots).toEqual([
      { texture: BODY, enabled: true },
      { texture: TURRET, enabled: true },
      { texture: `${VEHICLE}_gun_c`, enabled: true },
    ]);
    expect(await list()).toEqual([
      { id: created.id, name: 'Desert camo', vehicle: VEHICLE, updatedAt: created.updatedAt, hasThumb: false },
    ]);

    const layers = [{ id: 'l1', kind: 'base', name: 'Base', visible: true, mode: 'solid', colors: ['#56603f'], scale: 1, seed: 1 }];
    const saved = await call<AtelierProject>('atelier_project_save', { project: { ...created, name: 'Winter', layers } });
    expect(saved).toMatchObject({ name: 'Winter', layers, createdAt: created.createdAt });
    expect(await call<AtelierProject>('atelier_project_get', { id: created.id })).toEqual(saved);
  });

  it('checks names and envelopes like Rust', async () => {
    expect(await rejection(create('   '))).toMatchObject({
      code: 'invalidInput',
      message: 'A project name must be 1 to 80 characters long',
    });
    // C1 control characters too (Rust's char::is_control).
    expect(await rejection(create('Camo\u0085'))).toMatchObject({ message: 'A project name must be 1 to 80 characters long' });
    const p = await create();
    const huge = [{ id: 'b', kind: 'base', blob: 'x'.repeat(8 * 1024 * 1024) }];
    expect(await rejection(call('atelier_project_save', { project: { ...p, layers: huge } }))).toMatchObject({
      code: 'invalidInput',
      message: "This Atelier project can't be read",
    });
    expect(await rejection(call('atelier_project_save', { project: { ...p, version: 2 } }))).toMatchObject({
      code: 'invalidInput',
      message: "This Atelier project can't be read",
    });
    expect(await rejection(call('atelier_project_save', { project: { ...p, id: 'p-gone' } }))).toMatchObject({
      code: 'notFound',
      message: 'This Atelier project no longer exists',
    });
  });

  it('duplicates under a free name, without the installed skin, with the thumbnail', async () => {
    const p = await create('Camo');
    await raw('atelier_project_thumb', PNG, { 'x-project-id': p.id });
    await call('atelier_project_save', { project: { ...p, installedSkinId: 's-1' } });
    const copy = await call<AtelierProject>('atelier_project_duplicate', { id: p.id });
    expect(copy.name).toBe('Camo (2)');
    expect(copy.installedSkinId).toBeUndefined();
    const again = await call<AtelierProject>('atelier_project_duplicate', { id: p.id });
    expect(again.name).toBe('Camo (3)');
    expect(new Uint8Array(await call<ArrayBuffer>('atelier_project_thumb_get', { id: copy.id }))).toEqual(PNG);
  });

  it('deletes into the trash; Undo brings it back, forget removes it for good', async () => {
    const p = await create();
    await call('atelier_project_delete', { id: p.id });
    expect(await list()).toEqual([]);
    await call('atelier_project_undo_delete', { id: p.id });
    expect((await list()).map((s) => s.id)).toEqual([p.id]);

    await call('atelier_project_delete', { id: p.id });
    await call('atelier_project_forget_deleted', { id: p.id });
    expect(await rejection(call('atelier_project_undo_delete', { id: p.id }))).toMatchObject({ code: 'notFound' });
  });

  it('stores a PNG thumbnail from a raw body and refuses anything else', async () => {
    const p = await create();
    expect(new Uint8Array(await call<ArrayBuffer>('atelier_project_thumb_get', { id: p.id }))).toHaveLength(0);
    await raw('atelier_project_thumb', PNG, { 'x-project-id': p.id });
    expect((await list())[0]?.hasThumb).toBe(true);
    expect(new Uint8Array(await call<ArrayBuffer>('atelier_project_thumb_get', { id: p.id }))).toEqual(PNG);
    expect(await rejection(raw('atelier_project_thumb', new Uint8Array([1, 2, 3]), { 'x-project-id': p.id }))).toMatchObject({
      code: 'invalidInput',
      message: "The project's picture can't be saved",
    });
  });
});

describe('mock Atelier · apply', () => {
  /** Every `atelier://apply-progress` until done or error. */
  function progressUntilEnd(): Promise<ApplyProgress[]> {
    return new Promise((resolve) => {
      const seen: ApplyProgress[] = [];
      const off = mockListen<ApplyProgress>(EVENTS.atelierApplyProgress, (p) => {
        seen.push(p);
        if (p.step === 'done' || p.step === 'error') {
          off();
          resolve(seen);
        }
      });
    });
  }

  it('installs a mine skin, then replaces it keeping its id', async () => {
    const p = await create('Desert');
    const ended = progressUntilEnd();
    const { applyId } = await call<ApplyStarted>('atelier_apply_begin', { projectId: p.id, enabled: [BODY, TURRET] });
    await texture(applyId, BODY);
    await texture(applyId, TURRET.toUpperCase());
    const first = await call<ApplyResult>('atelier_apply_commit', { applyId });
    expect(first.backupId).toBeUndefined();
    expect(first.skin).toMatchObject({ origin: 'mine', active: true, folder: `${VEHICLE}_Desert` });
    expect(first.skin.vehicle.code).toBe(VEHICLE);
    expect((await ended).map((e) => [e.step, e.pct])).toEqual([
      ['encode', 0],
      ['write', 22],
      ['encode', 45],
      ['write', 67],
      ['install', 90],
      ['done', 100],
    ]);
    expect((await call<AtelierProject>('atelier_project_get', { id: p.id })).installedSkinId).toBe(first.skin.id);

    const second = await call<ApplyStarted>('atelier_apply_begin', { projectId: p.id, enabled: [BODY] });
    await texture(second.applyId, BODY);
    const replaced = await call<ApplyResult>('atelier_apply_commit', { applyId: second.applyId });
    expect(replaced.skin.id).toBe(first.skin.id);
    expect(replaced.backupId).toEqual(expect.any(String));
    const hangar = await call<HangarSkin[]>('get_hangar');
    expect(hangar.filter((s) => s.id === first.skin.id)).toHaveLength(1);
  });

  it('refuses nothing to apply, wrong sizes, slots that are off and unknown ids', async () => {
    const p = await create();
    expect(await rejection(call('atelier_apply_begin', { projectId: p.id, enabled: [] }))).toMatchObject({
      message: 'Turn on at least one part to apply',
    });
    expect(await rejection(call('atelier_apply_begin', { projectId: p.id, enabled: ['other_c'] }))).toMatchObject({
      message: "This part isn't turned on for this apply",
    });
    const { applyId } = await call<ApplyStarted>('atelier_apply_begin', { projectId: p.id, enabled: [BODY] });
    expect(await rejection(texture(applyId, BODY, 8, 10))).toMatchObject({ message: 'A painted texture has the wrong size' });
    expect(await rejection(texture(applyId, BODY, 6))).toMatchObject({ message: 'A painted texture has the wrong size' });
    expect(await rejection(texture(applyId, TURRET))).toMatchObject({ message: "This part isn't turned on for this apply" });
    expect(await rejection(call('atelier_apply_commit', { applyId }))).toMatchObject({
      message: 'Turn on at least one part to apply',
    });
    // The failed commit ended the apply.
    expect(await rejection(texture(applyId, BODY))).toMatchObject({ code: 'notFound', message: 'This apply is no longer running' });
  });

  it('runs one apply per project, and checks a texture size before the apply id', async () => {
    const p = await create();
    const { applyId } = await call<ApplyStarted>('atelier_apply_begin', { projectId: p.id, enabled: [BODY] });
    expect(await rejection(call('atelier_apply_begin', { projectId: p.id, enabled: [BODY] }))).toMatchObject({
      code: 'conflict',
      message: "The skin couldn't be applied to the game",
    });
    expect(await rejection(texture('a-none', BODY, 6))).toMatchObject({ message: 'A painted texture has the wrong size' });
    await call('atelier_apply_cancel', { applyId });
    await expect(call('atelier_apply_begin', { projectId: p.id, enabled: [BODY] })).resolves.toMatchObject({ applyId: expect.any(String) });
  });

  it('checks the name and the vehicle code before the game', async () => {
    await call<Settings>('set_settings', { patch: { readGameData: false } });
    expect(await rejection(call('atelier_project_create', { name: 'x', vehicle: '../evil' }))).toMatchObject({
      message: "This Atelier project can't be read",
    });
    expect(await rejection(call('atelier_project_create', { name: '', vehicle: VEHICLE }))).toMatchObject({
      message: 'A project name must be 1 to 80 characters long',
    });
  });

  it('a commit without a game folder fails at the last pct, before any install step', async () => {
    const p = await create();
    const ended = progressUntilEnd();
    const { applyId } = await call<ApplyStarted>('atelier_apply_begin', { projectId: p.id, enabled: [BODY] });
    await texture(applyId, BODY);
    await call('set_settings', { patch: { gamePath: '' } });
    expect(await rejection(call('atelier_apply_commit', { applyId }))).toMatchObject({ message: 'No game folder set' });
    expect((await ended).map((e) => [e.step, e.pct])).toEqual([
      ['encode', 0],
      ['write', 45],
      ['error', 45],
    ]);
  });

  it('cancel ends the apply', async () => {
    const p = await create();
    const { applyId } = await call<ApplyStarted>('atelier_apply_begin', { projectId: p.id, enabled: [BODY] });
    await call('atelier_apply_cancel', { applyId });
    expect(await rejection(call('atelier_apply_commit', { applyId }))).toMatchObject({ code: 'notFound' });
    // Unknown ids are fine.
    await expect(call('atelier_apply_cancel', { applyId: 'a-none' })).resolves.toBeNull();
  });
});

describe('mock Atelier · start-up switch', () => {
  it('?atelier=1 turns Settings → Experimental → Atelier on', async () => {
    expect((await call<Settings>('get_settings')).atelierEnabled).toBe(false);
    window.history.replaceState(null, '', '/?atelier=1');
    resetMockBackend();
    expect((await call<Settings>('get_settings')).atelierEnabled).toBe(true);
    expect((await call<Settings>('set_settings', { patch: { atelierEnabled: false } })).atelierEnabled).toBe(false);
  });
});
