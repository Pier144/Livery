import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseModelBuffer } from '@/atelier/modelBuffer';
import { parseAssetBuffer } from '@/queries/atelier';
import {
  EVENTS,
  type AppError,
  type ApplyProgress,
  type ApplyResult,
  type ApplyStarted,
  type AssetRef,
  type AtelierProject,
  type AtelierProjectSummary,
  type CutoutProgress,
  type CutoutResult,
  type CutoutStatus,
  type DownloadProgress,
  type FontInfo,
  type HangarSkin,
  type Settings,
} from '@/types';
import { configureMockBackend, mockCall, mockListen, resetMockBackend } from './mockBackend';
import { MOCK_GAME } from './mockData';
import {
  ASSET_INVALID,
  ASSET_NOT_FOUND,
  ATELIER_DISABLED,
  CUTOUT_BUSY,
  CUTOUT_CANCELLED,
  CUTOUT_MARGIN,
  CUTOUT_NOT_READY,
  CUTOUT_RESTART_NEEDED,
  DOWNLOAD_BUSY,
  DOWNLOAD_CANCELLED,
  DOWNLOAD_CORRUPT,
  DOWNLOAD_FAILED,
  FONT_NOT_FOUND,
  IMAGE_TOO_LARGE,
  IMAGE_UNREADABLE,
  MOCK_MODEL_BYTES,
  MOCK_PICTURE_HEIGHT,
  MOCK_PICTURE_WIDTH,
  MOCK_RUNTIME_BYTES,
  MOCK_RUNTIME_DOWNLOAD_BYTES,
  MOCK_TEXTURE_SIZE,
  mockPicture,
  mockTemplate,
} from './mockAtelier';

const VEHICLE = 'germ_leopard_2a6';
const BODY = `${VEHICLE}_body_c`;
const TURRET = `${VEHICLE}_turret_c`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const call = <T>(cmd: string, args: Record<string, unknown> = {}) => mockCall<T>(cmd, args);
const raw = <T>(cmd: string, body: Uint8Array, headers: Record<string, string>) =>
  mockCall<T>(cmd, { __body: body, __headers: headers });

// Not `new URL(…, import.meta.url)`: Vite rewrites that pattern into an asset URL.
const RUST_ATELIER = resolve(dirname(fileURLToPath(import.meta.url)), '../../src-tauri/src/atelier');

/** Every plain string literal in src-tauri/src/atelier/*.rs (the messages the mock must match). */
function rustAtelierLiterals(): string[] {
  return readdirSync(RUST_ATELIER)
    .filter((f) => f.endsWith('.rs'))
    .flatMap((f) => [...readFileSync(join(RUST_ATELIER, f), 'utf8').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(["\\'])/g, '$1')));
}

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

describe('mock Atelier · pictures', () => {
  it('imports a generated picture and answers it as raw RGBA with a size header', async () => {
    const p = await create();
    await expect(call('atelier_project_open', { projectId: p.id })).resolves.toBeNull();
    const ref = await call<AssetRef>('atelier_import_image', { projectId: p.id, path: 'C:\\Pictures\\megumin.PNG' });
    expect(ref).toEqual({ id: expect.stringMatching(/^img-/), width: MOCK_PICTURE_WIDTH, height: MOCK_PICTURE_HEIGHT });
    const picture = parseAssetBuffer(await call<ArrayBuffer>('atelier_asset', { projectId: p.id, assetId: ref.id }));
    expect(picture).toMatchObject({ width: MOCK_PICTURE_WIDTH, height: MOCK_PICTURE_HEIGHT });
    expect(picture.rgba).toEqual(mockPicture().rgba);
  });

  it('refuses paths and extensions like Rust, and unknown projects and assets', async () => {
    const p = await create();
    for (const path of ['relative\\a.png', '\\\\server\\share\\a.png', '\\\\?\\C:\\a.png', 'C:\\a.gif', 'C:\\noext']) {
      expect(await rejection(call('atelier_import_image', { projectId: p.id, path })), path).toMatchObject({
        code: 'invalidInput',
        message: IMAGE_UNREADABLE,
      });
    }
    expect(await rejection(call('atelier_import_image', { projectId: 'p-none', path: 'C:\\a.png' }))).toMatchObject({ code: 'notFound' });
    expect(await rejection(call('atelier_asset', { projectId: p.id, assetId: 'img-none' }))).toMatchObject({
      code: 'notFound',
      message: ASSET_NOT_FOUND,
    });
  });

  it('stores raw RGBA as a new picture, keeping colour under alpha 0, and checks its size', async () => {
    const p = await create();
    const rgba = new Uint8Array([10, 20, 30, 0, 40, 50, 60, 255]);
    const put = (body: Uint8Array, w: string, h: string, id = p.id) =>
      raw<AssetRef>('atelier_asset_put', body, { 'x-project-id': id, 'x-width': w, 'x-height': h });
    const ref = await put(rgba, '2', '1');
    expect(ref).toMatchObject({ width: 2, height: 1 });
    expect(parseAssetBuffer(await call<ArrayBuffer>('atelier_asset', { projectId: p.id, assetId: ref.id })).rgba).toEqual(rgba);
    for (const [w, h] of [['2', '2'], ['x', '1'], ['0', '0'], ['4097', '1']] as const) {
      expect(await rejection(put(rgba, w, h)), `${w}x${h}`).toMatchObject({ code: 'invalidInput', message: ASSET_INVALID });
    }
    expect(await rejection(put(rgba, '2', '1', 'p-none'))).toMatchObject({ code: 'notFound' });
  });

  it('sends the messages Rust sends', () => {
    const literals = rustAtelierLiterals();
    for (const message of [IMAGE_UNREADABLE, IMAGE_TOO_LARGE, ASSET_NOT_FOUND, ASSET_INVALID, FONT_NOT_FOUND]) {
      expect(literals).toContain(message);
    }
  });
});

describe('mock Atelier · fonts', () => {
  it('lists two families and answers their bytes from the self-hosted files', async () => {
    const fonts = await call<FontInfo[]>('atelier_fonts');
    expect(new Set(fonts.map((f) => f.family))).toEqual(new Set(['Geist', 'IBM Plex Mono']));
    expect(fonts).toContainEqual({ family: 'Geist', style: 'Regular', file: 'Geist-Regular.woff2' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32])));
    try {
      const bytes = await call<ArrayBuffer>('atelier_font_file', { family: 'Geist', style: 'Regular' });
      expect(new Uint8Array(bytes)).toEqual(new Uint8Array([0x77, 0x4f, 0x46, 0x32]));
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('Geist-Regular');
      expect(await rejection(call('atelier_font_file', { family: 'Arial', style: 'Regular' }))).toMatchObject({
        code: 'notFound',
        message: FONT_NOT_FOUND,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('mock Atelier · background removal', () => {
  const status = () => call<CutoutStatus>('atelier_cutout_status');

  beforeEach(async () => {
    await call('set_settings', { patch: { atelierEnabled: true } });
  });

  it('needs Atelier on', async () => {
    await call('set_settings', { patch: { atelierEnabled: false } });
    expect(await rejection(call('atelier_cutout_download'))).toMatchObject({ code: 'invalidInput', message: ATELIER_DISABLED });
  });

  it('downloads the runtime then the model with progress, then cuts out a disc cropped with its margin', async () => {
    expect(await status()).toEqual({
      runtime: false,
      model: false,
      bytes: 0,
      downloadBytes: MOCK_RUNTIME_DOWNLOAD_BYTES + MOCK_MODEL_BYTES,
      pendingRemoval: false,
    });
    const p = await create();
    const source = await call<AssetRef>('atelier_import_image', { projectId: p.id, path: 'C:\\a.png' });
    expect(await rejection(call('atelier_cutout', { projectId: p.id, assetId: source.id }))).toMatchObject({ message: CUTOUT_NOT_READY });

    const seen: DownloadProgress[] = [];
    const off = mockListen<DownloadProgress>(EVENTS.atelierDownloadProgress, (e) => seen.push(e));
    expect(await call<CutoutStatus>('atelier_cutout_download')).toMatchObject({ runtime: true, model: true, downloadBytes: 0 });
    off();
    expect(seen[0]).toEqual({ item: 'runtime', received: 0, total: MOCK_RUNTIME_DOWNLOAD_BYTES });
    expect(seen.at(-1)).toEqual({ item: 'model', received: MOCK_MODEL_BYTES, total: MOCK_MODEL_BYTES });
    expect(await status()).toMatchObject({ runtime: true, model: true, bytes: MOCK_RUNTIME_BYTES + MOCK_MODEL_BYTES, downloadBytes: 0 });

    const steps: string[] = [];
    const offSteps = mockListen<CutoutProgress>(EVENTS.atelierCutoutProgress, (e) => steps.push(e.step));
    const { asset, crop } = await call<CutoutResult>('atelier_cutout', { projectId: p.id, assetId: source.id });
    offSteps();
    expect(steps).toEqual(['load', 'run', 'write']);
    expect(crop).toEqual({ x: 140 - CUTOUT_MARGIN, y: 50 - CUTOUT_MARGIN, w: 200 + 2 * CUTOUT_MARGIN, h: 200 + 2 * CUTOUT_MARGIN });
    expect(asset).toMatchObject({ width: crop.w, height: crop.h });
    const cut = parseAssetBuffer(await call<ArrayBuffer>('atelier_asset', { projectId: p.id, assetId: asset.id }));
    const at = (x: number, y: number) => cut.rgba.slice((y * cut.width + x) * 4, (y * cut.width + x) * 4 + 4);
    // The corner is background: transparent, its colour kept. The centre is the opaque disc.
    const original = mockPicture();
    const so = (crop.y * original.width + crop.x) * 4;
    expect([...at(0, 0)]).toEqual([...original.rgba.slice(so, so + 3), 0]);
    expect(at(cut.width >> 1, cut.height >> 1)[3]).toBe(255);
    // The original stays.
    await expect(call('atelier_asset', { projectId: p.id, assetId: source.id })).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it('cancel stops a download; a second one while one runs is refused', async () => {
    const first = call('atelier_cutout_download');
    expect(await rejection(call('atelier_cutout_download'))).toMatchObject({ code: 'conflict', message: DOWNLOAD_BUSY });
    await call('atelier_cutout_cancel');
    expect(await rejection(first)).toMatchObject({ message: DOWNLOAD_CANCELLED });
    expect((await status()).model).toBe(false);
    // Nothing runs any more: cancel is a no-op, a new download completes.
    await expect(call('atelier_cutout_cancel')).resolves.toBeNull();
    await call('atelier_cutout_download');
    expect(await status()).toMatchObject({ runtime: true, model: true });
  });

  it('remove: refused while busy; pending when the runtime was loaded', async () => {
    await call('atelier_cutout_download');
    expect(await call<CutoutStatus>('atelier_cutout_remove')).toMatchObject({ runtime: false, model: false, bytes: 0, pendingRemoval: false });
    await call('atelier_cutout_download');
    const p = await create();
    const source = await call<AssetRef>('atelier_import_image', { projectId: p.id, path: 'C:\\a.png' });
    const running = call('atelier_cutout', { projectId: p.id, assetId: source.id });
    expect(await rejection(call('atelier_cutout_remove'))).toMatchObject({ code: 'conflict', message: CUTOUT_BUSY });
    await running;
    expect(await call<CutoutStatus>('atelier_cutout_remove')).toMatchObject({
      runtime: false,
      model: false,
      bytes: MOCK_RUNTIME_BYTES,
      pendingRemoval: true,
    });
    // Until a restart: no download, no cutout.
    expect(await rejection(call('atelier_cutout_download'))).toMatchObject({ code: 'conflict', message: CUTOUT_RESTART_NEEDED });
    expect(await rejection(call('atelier_cutout', { projectId: p.id, assetId: source.id }))).toMatchObject({ message: CUTOUT_NOT_READY });
  });

  it('sends the messages Rust sends', () => {
    const literals = rustAtelierLiterals();
    for (const message of [ATELIER_DISABLED, DOWNLOAD_FAILED, DOWNLOAD_CORRUPT, DOWNLOAD_CANCELLED, DOWNLOAD_BUSY, CUTOUT_BUSY, CUTOUT_RESTART_NEEDED]) {
      expect(literals).toContain(message);
    }
  });

  it('cancel stops a cutout', async () => {
    await call('atelier_cutout_download');
    const p = await create();
    const source = await call<AssetRef>('atelier_import_image', { projectId: p.id, path: 'C:\\a.png' });
    const running = call('atelier_cutout', { projectId: p.id, assetId: source.id });
    await call('atelier_cutout_cancel');
    expect(await rejection(running)).toMatchObject({ code: 'internal', message: CUTOUT_CANCELLED });
  });
});
