import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/queries/client';
import { useUi } from '@/store/ui';
import { resetStores } from '@/test/render';
import { EVENTS, type FollowEntry, type ForYouNew, type SearchParams, type SearchResult, type WtLiveSkin } from '@/types';
import {
  FOLLOWING_KEY,
  WTLIVE_KEY,
  WTLIVE_STORAGE_KEY,
  isOfflineError,
  nextSearchPage,
  useFollowingNew,
  useForYouNew,
  useMarkFollowingSeen,
  useMarkForYouSeen,
  useNetStatusEvents,
  useSetFollow,
  useSetWtLiveHidden,
  useVehicleTop,
  useWtLivePost,
  useWtLiveSearch,
  useWtLiveSearchPages,
} from './wtlive';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from './settings';
import type { InfiniteData } from '@tanstack/react-query';

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

const found = (items: WtLiveSkin[], extra: Partial<SearchResult> = {}): SearchResult => ({
  items,
  total: items.length,
  tookMs: 14,
  hasMore: false,
  totalExact: true,
  ...extra,
});

describe('nextSearchPage', () => {
  it('follows the last page’s hasMore, not the total', () => {
    const first = found([item(1), item(2)], { total: 2, totalExact: false, hasMore: true });
    expect(nextSearchPage(first, [first])).toBe(1);
    // An inexact total equal to what is loaded doesn't stop paging; hasMore does.
    const second = found([item(3)], { total: 3, totalExact: false, hasMore: false });
    expect(nextSearchPage(second, [first, second])).toBeUndefined();
    // An exact total larger than what is loaded doesn't keep paging either.
    expect(nextSearchPage(found([item(1)], { total: 99 }), [found([item(1)])])).toBeUndefined();
  });
});

describe('useWtLiveSearchPages', () => {
  it('asks for the next page while the backend says there is one', async () => {
    backend.call.mockImplementation(async (_cmd, args) => {
      const { page } = (args as { params: SearchParams }).params;
      return page === 0
        ? found([item(1), item(2)], { total: 2, totalExact: false, hasMore: true })
        : found([item(3)], { total: 3, totalExact: false, hasMore: false });
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

describe('Browse WT Live off', () => {
  it('disables every WT Live query: no call at all', async () => {
    const client = createQueryClient();
    client.setQueryData(SETTINGS_KEY, { ...DEFAULT_SETTINGS, wtliveEnabled: false });
    const entries: FollowEntry[] = [{ kind: 'vehicle', id: 'su_27', name: 'Su-27', lastSeenAt: '2026-09-09T20:00:00Z' }];
    const { result: hooks } = renderHook(
      () => ({
        pages: useWtLiveSearchPages({ sort: 'downloads' }),
        single: useWtLiveSearch({ sort: 'downloads', page: 0 }),
        post: useWtLivePost('s1'),
        fresh: useFollowingNew(entries),
        top: useVehicleTop('su_27'),
        forYou: useForYouNew(['su_27']),
      }),
      { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> },
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(backend.call).not.toHaveBeenCalled();
    expect(hooks.current.pages.fetchStatus).toBe('idle');
    expect(hooks.current.post.fetchStatus).toBe('idle');
    expect(hooks.current.fresh.fetchStatus).toBe('idle');
    expect(hooks.current.top.fetchStatus).toBe('idle');
    expect(hooks.current.forYou.fetchStatus).toBe('idle');
  });
});

describe('useSetWtLiveHidden', () => {
  it('stores the counts, drops the skin from cached lists at once and refetches them', async () => {
    backend.call.mockResolvedValue({ cacheBytes: 10, hiddenCount: 1 });
    const client = createQueryClient();
    const pagesKey = [...WTLIVE_KEY, 'search-pages', { sort: 'downloads' }];
    const freshKey = [...WTLIVE_KEY, 'following-new', ['su_27'], []];
    client.setQueryData(pagesKey, { pages: [found([item(1), item(2)])], pageParams: [0] });
    client.setQueryData(freshKey, [item(2), item(3)]);
    const topKey = [...WTLIVE_KEY, 'vehicle-top', 'su_27'];
    const forYouKey = [...WTLIVE_KEY, 'for-you-new', ['su_27']];
    client.setQueryData(topKey, [item(1), item(2)]);
    client.setQueryData<ForYouNew>(forYouKey, { items: [{ vehicle: 'su_27', skin: item(2) }], checked: 1 });
    client.setQueryData([...WTLIVE_KEY, 'post', 's2'], item(2));
    const { result: hook } = renderHook(() => useSetWtLiveHidden(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await act(() => hook.current.mutateAsync({ id: 's2', hidden: true }));
    expect(backend.call).toHaveBeenLastCalledWith('wtlive_set_hidden', { id: 's2', hidden: true });
    expect(client.getQueryData(WTLIVE_STORAGE_KEY)).toEqual({ cacheBytes: 10, hiddenCount: 1 });
    const pages = client.getQueryData<InfiniteData<SearchResult>>(pagesKey);
    expect(pages?.pages[0]?.items.map((s) => s.id)).toEqual(['s1']);
    expect(client.getQueryData<WtLiveSkin[]>(freshKey)?.map((s) => s.id)).toEqual(['s3']);
    expect(client.getQueryState(pagesKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(freshKey)?.isInvalidated).toBe(true);
    // For you's lists too.
    expect(client.getQueryData<WtLiveSkin[]>(topKey)?.map((s) => s.id)).toEqual(['s1']);
    expect(client.getQueryData<ForYouNew>(forYouKey)).toEqual({ items: [], checked: 1 });
    expect(client.getQueryState(topKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(forYouKey)?.isInvalidated).toBe(true);
    // The post itself stays (an installed skin's detail still opens).
    expect(client.getQueryState([...WTLIVE_KEY, 'post', 's2'])?.isInvalidated).toBe(false);
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

const LEOPARD: FollowEntry = { kind: 'vehicle', id: 'germ_leopard_2a6', name: 'Leopard 2A6', lastSeenAt: '2026-09-09T20:00:00Z' };

describe('useSetFollow', () => {
  it('passes lastSeenAt only when it is given', async () => {
    backend.call.mockResolvedValue([LEOPARD]);
    const client = createQueryClient();
    const { result } = renderHook(() => useSetFollow(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    const { kind, id, name, lastSeenAt } = LEOPARD;

    await act(() => result.current.mutateAsync({ kind, id, name, follow: false }));
    expect(backend.call).toHaveBeenLastCalledWith('following_set', { kind, id, name, follow: false });
    // The Undo of that unfollow: the entry comes back with its own lastSeenAt.
    await act(() => result.current.mutateAsync({ kind, id, name, follow: true, lastSeenAt }));
    expect(backend.call).toHaveBeenLastCalledWith('following_set', { kind, id, name, follow: true, lastSeenAt });
    expect(client.getQueryData(FOLLOWING_KEY)).toEqual([LEOPARD]);
  });
});

describe('useMarkFollowingSeen', () => {
  it('stores the list and invalidates the new skins, which were counted from the old lastSeenAt', async () => {
    const seen = [{ ...LEOPARD, lastSeenAt: '2026-09-19T10:00:00Z' }];
    backend.call.mockResolvedValue(seen);
    const client = createQueryClient();
    const freshKey = [...WTLIVE_KEY, 'following-new', ['germ_leopard_2a6'], []];
    client.setQueryData(freshKey, [item(14)]);
    client.setQueryData([...WTLIVE_KEY, 'post', 's1'], item(1));
    const { result } = renderHook(() => useMarkFollowingSeen(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await act(() => result.current.mutateAsync());
    expect(backend.call).toHaveBeenCalledWith('following_mark_seen', undefined);
    expect(client.getQueryData(FOLLOWING_KEY)).toEqual(seen);
    expect(client.getQueryState(freshKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState([...WTLIVE_KEY, 'post', 's1'])?.isInvalidated, 'posts stay cached').toBe(false);
  });
});

describe('For you', () => {
  const clientWrapper =
    (client: ReturnType<typeof createQueryClient>) =>
    ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

  /** Settings already loaded, so the only calls are the hooks' own. */
  const seeded = () => {
    const client = createQueryClient();
    client.setQueryData(SETTINGS_KEY, DEFAULT_SETTINGS);
    return client;
  };

  it('useVehicleTop asks for one vehicle, only while enabled', async () => {
    backend.call.mockResolvedValue([item(1)]);
    const client = seeded();
    const { result, rerender } = renderHook(({ enabled }) => useVehicleTop('su_27', { enabled }), {
      wrapper: clientWrapper(client),
      initialProps: { enabled: false },
    });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(backend.call).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toEqual([item(1)]));
    expect(backend.call).toHaveBeenCalledWith('wtlive_vehicle_top', { code: 'su_27' });
    expect(client.getQueryData([...WTLIVE_KEY, 'vehicle-top', 'su_27'])).toEqual([item(1)]);
  });

  it('useForYouNew fetches where asked, reads the cache elsewhere, and never for no vehicles', async () => {
    const answer: ForYouNew = { items: [{ vehicle: 'su_27', skin: item(9) }], checked: 2 };
    backend.call.mockResolvedValue(answer);
    const client = seeded();
    const pill = renderHook(() => useForYouNew(['su_27', 'f_4e'], { fetch: false }), { wrapper: clientWrapper(client) });
    renderHook(() => useForYouNew([]), { wrapper: clientWrapper(client) });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(backend.call).not.toHaveBeenCalled();

    renderHook(() => useForYouNew(['su_27', 'f_4e']), { wrapper: clientWrapper(client) });
    await waitFor(() => expect(pill.result.current.data).toEqual(answer));
    expect(backend.call).toHaveBeenCalledTimes(1);
    expect(backend.call).toHaveBeenCalledWith('wtlive_for_you_new', { vehicles: ['su_27', 'f_4e'] });
  });

  it('useMarkForYouSeen empties the cached new skins, keeps checked, and invalidates them', async () => {
    backend.call.mockResolvedValue('2026-10-16T10:00:00Z');
    const client = seeded();
    const key = [...WTLIVE_KEY, 'for-you-new', ['su_27']];
    client.setQueryData<ForYouNew>(key, { items: [{ vehicle: 'su_27', skin: item(9) }], checked: 1 });
    client.setQueryData([...WTLIVE_KEY, 'vehicle-top', 'su_27'], [item(1)]);
    const { result } = renderHook(() => useMarkForYouSeen(), { wrapper: clientWrapper(client) });

    await act(() => result.current.mutateAsync());
    expect(backend.call).toHaveBeenCalledWith('for_you_mark_seen', undefined);
    expect(client.getQueryData(key)).toEqual({ items: [], checked: 1 });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryState([...WTLIVE_KEY, 'vehicle-top', 'su_27'])?.isInvalidated, 'top skins stay').toBe(false);
  });

  it('useMarkForYouSeen cancels an answer still on its way, so it cannot bring the old count back', async () => {
    let answer!: (value: ForYouNew) => void;
    backend.call.mockImplementation((cmd) =>
      cmd === 'wtlive_for_you_new' ? new Promise((resolve) => (answer = resolve)) : Promise.resolve('2026-10-16T10:00:00Z'),
    );
    const client = seeded();
    const key = [...WTLIVE_KEY, 'for-you-new', ['su_27']];
    client.setQueryData<ForYouNew>(key, { items: [], checked: 1 });
    void client
      .fetchQuery({ queryKey: key, queryFn: () => backend.call('wtlive_for_you_new') as Promise<ForYouNew>, staleTime: 0 })
      .catch(() => undefined);
    await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('fetching'));
    const { result } = renderHook(() => useMarkForYouSeen(), { wrapper: clientWrapper(client) });

    await act(() => result.current.mutateAsync());
    act(() => answer({ items: [{ vehicle: 'su_27', skin: item(9) }], checked: 1 }));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(client.getQueryData(key)).toEqual({ items: [], checked: 1 });
  });
});
