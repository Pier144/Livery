import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/queries/client';
import type { GameDetection } from '@/types';
import { COLLECTIONS_KEY } from './collections';
import { useSetGamePath } from './game';
import { HANGAR_KEY } from './hangar';
import { BACKUPS_KEY, DEFAULT_SETTINGS, SETTINGS_KEY } from './settings';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

const DETECTION: GameDetection = { found: true, source: 'custom', path: 'E:\\War Thunder', existingSkins: 2 };

/** Everything that belongs to one game folder, plus the settings that name it. */
const FOLDER_KEYS: QueryKey[] = [SETTINGS_KEY, HANGAR_KEY, COLLECTIONS_KEY, BACKUPS_KEY];

function setup() {
  const client = createQueryClient();
  client.setQueryData(SETTINGS_KEY, DEFAULT_SETTINGS);
  client.setQueryData(HANGAR_KEY, []);
  client.setQueryData(COLLECTIONS_KEY, { collections: [] });
  client.setQueryData(BACKUPS_KEY, []);
  client.setQueryData(['queue'], []);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, hook: renderHook(() => useSetGamePath(), { wrapper }) };
}

beforeEach(() => {
  backend.call.mockReset();
});

describe('useSetGamePath', () => {
  it('re-reads the settings and the new folder’s hangar, collections and backups', async () => {
    backend.call.mockResolvedValue(DETECTION);
    const { client, hook } = setup();
    await act(() => hook.result.current.mutateAsync({ path: 'E:\\War Thunder' }));

    expect(backend.call).toHaveBeenCalledWith('set_game_path', { path: 'E:\\War Thunder' });
    for (const queryKey of FOLDER_KEYS) {
      expect(client.getQueryState(queryKey)?.isInvalidated, JSON.stringify(queryKey)).toBe(true);
    }
    expect(client.getQueryState(['queue'])?.isInvalidated, 'other queries are left alone').toBe(false);
  });

  it('passes the source when there is one, and invalidates nothing when the folder is refused', async () => {
    backend.call.mockRejectedValueOnce({ code: 'invalidInput', message: "That folder doesn't look like a War Thunder install" });
    const { client, hook } = setup();
    act(() => hook.result.current.mutate({ path: 'D:\\Games', source: 'steam' }));
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(backend.call).toHaveBeenCalledWith('set_game_path', { path: 'D:\\Games', source: 'steam' });
    for (const queryKey of FOLDER_KEYS) {
      expect(client.getQueryState(queryKey)?.isInvalidated, JSON.stringify(queryKey)).toBe(false);
    }
  });
});
