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
  atelierProjectKey,
  thumbKey,
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
