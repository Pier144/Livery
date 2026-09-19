import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/queries/client';
import { useUi } from '@/store/ui';
import { resetStores } from '@/test/render';
import { EVENTS, type SearchParams, type SearchResult, type WtLiveSkin } from '@/types';
import { isOfflineError, useNetStatusEvents, useWtLiveSearchPages } from './wtlive';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

vi.mock('@/lib/events', () => ({
  listenEvent: (name: string, handler: (payload: unknown) => void) => {
    backend.listeners.set(name, handler);
    return Promise.resolve(() => {});
  },
}));

const item = (n: number) => ({ id: `s${n}` }) as WtLiveSkin;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  resetStores();
  backend.call.mockReset();
  backend.listeners.clear();
});

describe('useWtLiveSearchPages', () => {
  it('asks for the next page until every result is loaded', async () => {
    backend.call.mockImplementation(async (_cmd, args) => {
      const { page } = (args as { params: SearchParams }).params;
      const items = page === 0 ? [item(1), item(2)] : [item(3)];
      return { items, total: 3, tookMs: 14 } satisfies SearchResult;
    });
    const { result } = renderHook(() => useWtLiveSearchPages({ sort: 'downloads', nation: 'GER' }), { wrapper });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(backend.call).toHaveBeenLastCalledWith('wtlive_search', { params: { sort: 'downloads', nation: 'GER', page: 0 } });
    expect(result.current.hasNextPage).toBe(true);

    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(backend.call).toHaveBeenLastCalledWith('wtlive_search', { params: { sort: 'downloads', nation: 'GER', page: 1 } });
    expect(result.current.hasNextPage).toBe(false);
    expect(useUi.getState().online).toBe(true);
  });

  it('reports WT Live offline when the backend says it is unsupported', async () => {
    backend.call.mockRejectedValue({ code: 'unsupported', message: "WT Live can't be reached" });
    const { result } = renderHook(() => useWtLiveSearchPages({ sort: 'downloads' }), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isOfflineError(result.current.error)).toBe(true);
    expect(useUi.getState().online).toBe(false);
  });
});

describe('useNetStatusEvents', () => {
  it('follows net://status', async () => {
    renderHook(() => useNetStatusEvents(), { wrapper });
    await waitFor(() => expect(backend.listeners.has(EVENTS.netStatus)).toBe(true));

    act(() => backend.listeners.get(EVENTS.netStatus)?.({ online: false }));
    expect(useUi.getState().online).toBe(false);
    act(() => backend.listeners.get(EVENTS.netStatus)?.({ online: true }));
    expect(useUi.getState().online).toBe(true);
  });
});
