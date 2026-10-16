import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeMockModel } from '@/dev/mockAtelier';
import { createQueryClient } from '@/queries/client';
import { useToasts } from '@/store/toasts';
import { resetStores } from '@/test/render';
import type { AtelierProject } from '@/types';
import {
  ATELIER_PROJECTS_KEY,
  CUTOUT_STATUS_KEY,
  atelierAssetKey,
  atelierProjectKey,
  cancelCutoutWork,
  fontFileKey,
  importImage,
  openProjectAssets,
  parseAssetBuffer,
  putAsset,
  thumbKey,
  toArrayBuffer,
  useAsset,
  useCutout,
  useCutoutStatus,
  useDownloadCutoutFiles,
  useFontFile,
  useFonts,
  useRemoveCutoutFiles,
  useDeleteProject,
  useSaveProject,
  useSetThumb,
  useTemplateTexture,
  useThumb,
  useVehicleModel,
} from './atelier';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  callRaw: vi.fn<(cmd: string, body: Uint8Array, headers: Record<string, string>) => Promise<unknown>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
  callRaw: (cmd: string, body: Uint8Array, headers: Record<string, string>) => backend.callRaw(cmd, body, headers),
}));

const PROJECT: AtelierProject = {
  version: 1,
  id: 'p-1',
  name: 'Desert',
  vehicle: 'germ_leopard_2a6',
  createdAt: '2026-10-16T10:00:00Z',
  updatedAt: '2026-10-16T10:00:00Z',
  slots: [{ texture: 'germ_leopard_2a6_body_c', enabled: true }],
  output: { highQuality: false },
  layers: [],
};

function setup() {
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  resetStores();
  backend.call.mockReset();
  backend.callRaw.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Atelier queries', () => {
  it('useVehicleModel reads the binary model and parses it', async () => {
    backend.call.mockResolvedValue(encodeMockModel('germ_leopard_2a6'));
    const { wrapper } = setup();
    const { result } = renderHook(() => useVehicleModel('germ_leopard_2a6'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(backend.call).toHaveBeenCalledWith('atelier_model', { vehicle: 'germ_leopard_2a6' });
    expect(result.current.data?.header.slots).toHaveLength(3);
  });

  it('useVehicleModel and useTemplateTexture wait for a vehicle and slot', () => {
    const { wrapper } = setup();
    renderHook(() => [useVehicleModel(null), useTemplateTexture('v', null)], { wrapper });
    expect(backend.call).not.toHaveBeenCalled();
  });

  it('useTemplateTexture answers the bytes', async () => {
    backend.call.mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
    const { wrapper } = setup();
    const { result } = renderHook(() => useTemplateTexture('v', 'v_body_c'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(backend.call).toHaveBeenCalledWith('atelier_template_texture', { vehicle: 'v', slot: 'v_body_c' });
    expect(result.current.data).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('useThumb is null for an empty answer', async () => {
    backend.call.mockResolvedValue(new ArrayBuffer(0));
    const { wrapper } = setup();
    const { result } = renderHook(() => useThumb('p-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('useSaveProject writes the saved copy into the cache and invalidates only the list', async () => {
    const saved = { ...PROJECT, updatedAt: '2026-10-16T10:05:00Z' };
    backend.call.mockResolvedValue(saved);
    const { client, wrapper } = setup();
    client.setQueryData(atelierProjectKey('p-1'), PROJECT);
    client.setQueryData(ATELIER_PROJECTS_KEY, []);
    const { result } = renderHook(() => useSaveProject(), { wrapper });
    await act(() => result.current.mutateAsync(PROJECT));
    expect(backend.call).toHaveBeenCalledWith('atelier_project_save', { project: PROJECT });
    expect(client.getQueryData(atelierProjectKey('p-1'))).toEqual(saved);
    expect(client.getQueryState(atelierProjectKey('p-1'))?.isInvalidated).toBe(false);
    expect(client.getQueryState(ATELIER_PROJECTS_KEY)?.isInvalidated).toBe(true);
  });

  it('useDeleteProject deletes, then Undo restores and an expired toast forgets the trash entry', async () => {
    backend.call.mockResolvedValue(null);
    const { wrapper } = setup();
    const { result } = renderHook(() => useDeleteProject(), { wrapper });
    await act(() => result.current.mutateAsync({ id: 'p-1', name: 'Desert' }));
    expect(backend.call).toHaveBeenCalledWith('atelier_project_delete', { id: 'p-1' });
    const [first] = useToasts.getState().toasts;
    expect(first?.message).toBe('Deleted project “Desert”');
    await act(() => useToasts.getState().undo(first!.id));
    expect(backend.call).toHaveBeenCalledWith('atelier_project_undo_delete', { id: 'p-1' });
    expect(backend.call).not.toHaveBeenCalledWith('atelier_project_forget_deleted', expect.anything());

    await act(() => result.current.mutateAsync({ id: 'p-2', name: 'Winter' }));
    const [second] = useToasts.getState().toasts;
    act(() => useToasts.getState().dismiss(second!.id));
    expect(backend.call).toHaveBeenCalledWith('atelier_project_forget_deleted', { id: 'p-2' });
    expect(backend.call).not.toHaveBeenCalledWith('atelier_project_undo_delete', { id: 'p-2' });
  });

  it('a failed Undo of a delete shows the error and still refreshes the list; forgetting drops the thumbnail', async () => {
    backend.call.mockImplementation(async (cmd) => {
      if (cmd === 'atelier_project_undo_delete') throw { code: 'notFound', message: 'This Atelier project no longer exists' };
      return null;
    });
    const { client, wrapper } = setup();
    client.setQueryData(ATELIER_PROJECTS_KEY, []);
    client.setQueryData(thumbKey('p-1'), new Uint8Array([1]));
    client.setQueryData(thumbKey('p-2'), new Uint8Array([2]));
    const { result } = renderHook(() => useDeleteProject(), { wrapper });
    await act(() => result.current.mutateAsync({ id: 'p-1', name: 'Desert' }));
    client.setQueryData(ATELIER_PROJECTS_KEY, []);
    const [first] = useToasts.getState().toasts;
    await act(() => useToasts.getState().undo(first!.id));
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain('This Atelier project no longer exists');
    expect(client.getQueryState(ATELIER_PROJECTS_KEY)?.isInvalidated).toBe(true);

    await act(() => result.current.mutateAsync({ id: 'p-2', name: 'Winter' }));
    const deleted = useToasts.getState().toasts.find((t) => t.message === 'Deleted project “Winter”');
    act(() => useToasts.getState().dismiss(deleted!.id));
    expect(client.getQueryData(thumbKey('p-2'))).toBeUndefined();
    expect(backend.call).toHaveBeenCalledWith('atelier_project_forget_deleted', { id: 'p-2' });
  });

  it('toArrayBuffer accepts the payloads Tauri may answer with', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    expect(toArrayBuffer(buf)).toBe(buf);
    expect(new Uint8Array(toArrayBuffer(new Uint8Array([9, 1, 2, 3]).subarray(1)))).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(toArrayBuffer([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    for (const bad of [null, 'x', [1, 300], { a: 1 }]) {
      expect(() => toArrayBuffer(bad)).toThrow('model buffer: unexpected payload');
    }
  });

  it('useSetThumb sends the PNG as a raw body and refreshes the thumbnail and the list', async () => {
    backend.callRaw.mockResolvedValue(null);
    const { client, wrapper } = setup();
    client.setQueryData(thumbKey('p-1'), null);
    client.setQueryData(ATELIER_PROJECTS_KEY, []);
    const { result } = renderHook(() => useSetThumb(), { wrapper });
    const png = new Uint8Array([0x89, 0x50]);
    await act(() => result.current.mutateAsync({ id: 'p-1', png }));
    expect(backend.callRaw).toHaveBeenCalledWith('atelier_project_thumb', png, { 'x-project-id': 'p-1' });
    expect(client.getQueryState(thumbKey('p-1'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(ATELIER_PROJECTS_KEY)?.isInvalidated).toBe(true);
  });
});

/** `atelier_asset`'s answer for a w×h picture whose bytes count up. */
function assetBuffer(w: number, h: number, extra = 0): ArrayBuffer {
  const buf = new ArrayBuffer(8 + w * h * 4 + extra);
  const view = new DataView(buf);
  view.setUint32(0, w, true);
  view.setUint32(4, h, true);
  new Uint8Array(buf, 8).forEach((_, i, a) => (a[i] = i % 256));
  return buf;
}

describe('Atelier queries · pictures, fonts, background removal', () => {
  it('parseAssetBuffer reads the size header and checks the length', () => {
    const picture = parseAssetBuffer(assetBuffer(2, 3));
    expect(picture).toMatchObject({ width: 2, height: 3 });
    expect(picture.rgba).toHaveLength(24);
    expect(picture.rgba[5]).toBe(5);
    expect(() => parseAssetBuffer(assetBuffer(2, 3, 1))).toThrow('asset: 2x3');
    expect(() => parseAssetBuffer(new ArrayBuffer(4))).toThrow('asset: 4 bytes');
    expect(() => parseAssetBuffer(assetBuffer(0, 3))).toThrow('asset: 0x3');
  });

  it('useAsset reads raw RGBA and is dropped from the cache once unused', async () => {
    backend.call.mockResolvedValue(assetBuffer(1, 1));
    const { client, wrapper } = setup();
    const { result, unmount } = renderHook(() => useAsset('p-1', 'img-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(backend.call).toHaveBeenCalledWith('atelier_asset', { projectId: 'p-1', assetId: 'img-1' });
    expect(result.current.data?.rgba).toEqual(new Uint8Array([0, 1, 2, 3]));
    unmount();
    await waitFor(() => expect(client.getQueryData(atelierAssetKey('p-1', 'img-1'))).toBeUndefined());
  });

  it('putAsset sends the pixels as a raw body with the size headers; importImage and openProjectAssets pass their ids', async () => {
    const ref = { id: 'img-2', width: 2, height: 1 };
    backend.callRaw.mockResolvedValue(ref);
    backend.call.mockResolvedValue(ref);
    const rgba = new Uint8Array(8);
    await expect(putAsset('p-1', { width: 2, height: 1, rgba })).resolves.toEqual(ref);
    expect(backend.callRaw).toHaveBeenCalledWith('atelier_asset_put', rgba, { 'x-project-id': 'p-1', 'x-width': '2', 'x-height': '1' });
    await importImage('p-1', 'C:\\pics\\a.png');
    expect(backend.call).toHaveBeenCalledWith('atelier_import_image', { projectId: 'p-1', path: 'C:\\pics\\a.png' });
    backend.call.mockResolvedValue(null);
    await openProjectAssets('p-1');
    expect(backend.call).toHaveBeenCalledWith('atelier_project_open', { projectId: 'p-1' });
  });

  it('fonts: the list, and a font file not kept in the cache', async () => {
    const fonts = [{ family: 'Arial', style: 'Regular', file: 'arial.ttf' }];
    backend.call.mockImplementation(async (cmd) => (cmd === 'atelier_fonts' ? fonts : new Uint8Array([7, 8]).buffer));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => [useFonts(), useFontFile({ family: 'Arial', style: 'Regular' })] as const, { wrapper });
    await waitFor(() => expect(result.current[0].isSuccess && result.current[1].isSuccess).toBe(true));
    expect(result.current[0].data).toEqual(fonts);
    expect(new Uint8Array(result.current[1].data!)).toEqual(new Uint8Array([7, 8]));
    expect(backend.call).toHaveBeenCalledWith('atelier_font_file', { family: 'Arial', style: 'Regular' });
    expect(client.getQueryCache().find({ queryKey: fontFileKey({ family: 'Arial', style: 'Regular' }) })?.options.gcTime).toBe(0);
  });

  it('background removal: status, download refreshes it, remove writes it, cutout and cancel', async () => {
    const status = { runtime: false, model: false, bytes: 0, downloadBytes: 190e6, pendingRemoval: false };
    const result = { asset: { id: 'img-3', width: 10, height: 10 }, crop: { x: 1, y: 2, w: 10, h: 10 } };
    backend.call.mockImplementation(async (cmd) => {
      if (cmd === 'atelier_cutout_status') return status;
      if (cmd === 'atelier_cutout_remove') return { ...status, pendingRemoval: true };
      if (cmd === 'atelier_cutout') return result;
      return null;
    });
    const { client, wrapper } = setup();
    const hooks = renderHook(() => [useCutoutStatus(), useDownloadCutoutFiles(), useRemoveCutoutFiles(), useCutout()] as const, { wrapper });
    await waitFor(() => expect(hooks.result.current[0].data).toEqual(status));
    await act(() => hooks.result.current[1].mutateAsync());
    expect(backend.call).toHaveBeenCalledWith('atelier_cutout_download', undefined);
    await act(() => hooks.result.current[2].mutateAsync());
    expect(client.getQueryData(CUTOUT_STATUS_KEY)).toMatchObject({ pendingRemoval: true });
    await expect(act(() => hooks.result.current[3].mutateAsync({ projectId: 'p-1', assetId: 'img-1' }))).resolves.toEqual(result);
    expect(backend.call).toHaveBeenCalledWith('atelier_cutout', { projectId: 'p-1', assetId: 'img-1' });
    await cancelCutoutWork();
    expect(backend.call).toHaveBeenCalledWith('atelier_cutout_cancel', undefined);
  });
});
