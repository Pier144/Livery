import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { listenEvent } from '@/lib/events';
import { call, hasBackend, toAppError } from '@/lib/tauri';
import { useWtLiveEnabled } from '@/queries/settings';
import { useUi } from '@/store/ui';
import {
  EVENTS,
  type AppError,
  type ConflictPolicy,
  type FollowEntry,
  type FollowKind,
  type ForYouNew,
  type HangarSkin,
  type InstallMode,
  type InstallStarted,
  type NetStatus,
  type SearchParams,
  type SearchResult,
  type WtLiveSkin,
  type WtLiveStorage,
} from '@/types';
import { HANGAR_KEY } from './hangar';

export const WTLIVE_KEY = ['wtlive'] as const;
export const FOLLOWING_KEY = ['following'] as const;
/** Cache size and hidden skins (Settings → WT Live); local data, not under WTLIVE_KEY. */
export const WTLIVE_STORAGE_KEY = ['wtlive-storage'] as const;

/** Errors that mean "WT Live can't be reached from here" (drives the offline state). */
const OFFLINE_CODES = new Set(['network', 'unsupported', 'noBackend']);

/** Runs a WT Live call and keeps `ui.online` in step with how it went. */
async function tracked<T>(run: () => Promise<T>): Promise<T> {
  if (!hasBackend()) {
    useUi.getState().setOnline(false);
    throw { code: 'noBackend', message: 'WT Live needs the desktop app' } satisfies AppError;
  }
  try {
    const result = await run();
    useUi.getState().setOnline(true);
    return result;
  } catch (e) {
    const error = toAppError(e);
    if (OFFLINE_CODES.has(error.code)) useUi.getState().setOnline(false);
    throw error;
  }
}

export const isOfflineError = (e: AppError | null | undefined) => !!e && OFFLINE_CODES.has(e.code);

/** Keeps `ui.online` in step with the backend's `net://status` events; mounted once in App. */
export function useNetStatusEvents() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenEvent<NetStatus>(EVENTS.netStatus, (status) => useUi.getState().setOnline(status.online))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e: unknown) => console.error('[livery] net://status listener failed', e));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/**
 * Every WT Live query below is disabled while Settings → WT Live → Browse WT Live is off
 * (`useWtLiveEnabled`): no request at all, and the screens show the "turned off" state.
 */

/** Explore grid. Filters combine (AND); previous results stay on screen while the next page loads. */
export function useWtLiveSearch(params: SearchParams) {
  const enabled = useWtLiveEnabled();
  return useQuery<SearchResult, AppError>({
    queryKey: [...WTLIVE_KEY, 'search', params],
    queryFn: () => tracked(() => call<SearchResult>('wtlive_search', { params })),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

/** Next page to ask for: WT Live's feed has no total count, so it follows the last page's `hasMore`. */
export const nextSearchPage = (last: SearchResult, pages: readonly SearchResult[]): number | undefined =>
  last.hasMore ? pages.length : undefined;

/**
 * Explore grid, page after page: the backend fetches, caches and
 * filters WT Live locally and answers pages of results; call `fetchNextPage()` when the virtual
 * grid nears the end. The count comes from the last loaded page (a lower bound unless
 * `totalExact`), the query time from the first.
 */
export function useWtLiveSearchPages(params: Omit<SearchParams, 'page'>) {
  const enabled = useWtLiveEnabled();
  return useInfiniteQuery<SearchResult, AppError, InfiniteData<SearchResult, number>, QueryKey, number>({
    queryKey: [...WTLIVE_KEY, 'search-pages', params],
    queryFn: ({ pageParam }) => tracked(() => call<SearchResult>('wtlive_search', { params: { ...params, page: pageParam } })),
    enabled,
    initialPageParam: 0,
    getNextPageParam: nextSearchPage,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    // Every loaded page would be fetched again (WT Live is asked only on the user's
    // action): coming back to Explore, refocusing the window or reconnecting reuse what is here.
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Full post (images, files) for the Skin detail. */
export function useWtLivePost(id: string | null) {
  const enabled = useWtLiveEnabled();
  return useQuery<WtLiveSkin, AppError>({
    queryKey: [...WTLIVE_KEY, 'post', id],
    queryFn: () => tracked(() => call<WtLiveSkin>('wtlive_post', { id })),
    enabled: enabled && id !== null,
    staleTime: 5 * 60_000,
  });
}

/**
 * New skins from followed vehicles/authors since they were last seen. One WT Live request per
 * followed entry, so it is fetched only where `fetch` is true (the Following tab); elsewhere (the
 * "N new" pill) it only reads what that tab already fetched.
 */
export function useFollowingNew(entries: FollowEntry[] | undefined, { fetch = true }: { fetch?: boolean } = {}) {
  const enabled = useWtLiveEnabled();
  const vehicles = (entries ?? []).filter((e) => e.kind === 'vehicle').map((e) => e.id);
  const authors = (entries ?? []).filter((e) => e.kind === 'author').map((e) => e.id);
  return useQuery<WtLiveSkin[], AppError>({
    queryKey: [...WTLIVE_KEY, 'following-new', vehicles, authors],
    queryFn: () => tracked(() => call<WtLiveSkin[]>('wtlive_following_new', { vehicles, authors })),
    enabled: fetch && enabled && entries !== undefined && (vehicles.length > 0 || authors.length > 0),
    staleTime: 5 * 60_000,
  });
}

/** Followed vehicles and authors (local data; works offline). */
export function useFollowing() {
  return useQuery<FollowEntry[], AppError>({
    queryKey: FOLLOWING_KEY,
    queryFn: () => (hasBackend() ? call<FollowEntry[]>('following_list') : Promise.resolve([])),
  });
}

export interface SetFollowArgs {
  kind: FollowKind;
  id: string;
  name: string;
  follow: boolean;
  /**
   * RFC 3339. With `follow`, the entry gets this `lastSeenAt` (new or already followed): the Undo
   * of an unfollow passes the entry's old value so its "N new" comes back exactly.
   */
  lastSeenAt?: string;
}

/** Follows or unfollows a vehicle or an author (`following_set`); resolves with the whole list. */
export function useSetFollow() {
  const qc = useQueryClient();
  return useMutation<FollowEntry[], AppError, SetFollowArgs>({
    mutationFn: ({ lastSeenAt, ...args }) =>
      call<FollowEntry[]>('following_set', lastSeenAt === undefined ? { ...args } : { ...args, lastSeenAt }),
    onSuccess: (list) => qc.setQueryData(FOLLOWING_KEY, list),
  });
}

/**
 * Leaving the Following tab resets its "N new" count. `following-new` holds only the asked ids
 * (not their `lastSeenAt`), so it is invalidated too: its cached skins are no longer new.
 */
export function useMarkFollowingSeen() {
  const qc = useQueryClient();
  return useMutation<FollowEntry[], AppError, void>({
    mutationFn: () => call<FollowEntry[]>('following_mark_seen'),
    onSuccess: (list) => {
      qc.setQueryData(FOLLOWING_KEY, list);
      // Everything was just seen: nothing is new (outside the Following tab the query doesn't
      // refetch, so the pill must not keep the old count).
      qc.setQueriesData<WtLiveSkin[]>({ queryKey: [...WTLIVE_KEY, 'following-new'] }, (old) => (old ? [] : old));
      return qc.invalidateQueries({ queryKey: [...WTLIVE_KEY, 'following-new'] });
    },
  });
}

// ── For you ──────────────────────────────────────────────────────────────────

/**
 * For you: the 3 most downloaded skins of one lineup vehicle (`wtlive_vehicle_top`, one WT Live
 * request). Each row of the virtual list asks for its own, so only the rows on screen fetch.
 */
export function useVehicleTop(code: string, { enabled: wanted = true }: { enabled?: boolean } = {}) {
  const enabled = useWtLiveEnabled();
  return useQuery<WtLiveSkin[], AppError>({ ...vehicleTopQuery(code), enabled: wanted && enabled });
}

/** `useVehicleTop`'s query without `enabled`, for `useQueries` over several rows. */
export const vehicleTopQuery = (code: string) => ({
  queryKey: [...WTLIVE_KEY, 'vehicle-top', code],
  queryFn: () => tracked(() => call<WtLiveSkin[]>('wtlive_vehicle_top', { code })),
  staleTime: 30 * 60_000,
});

/**
 * New skins for the lineup vehicles (`vehicles` in display order) since For you was last seen.
 * Up to 10 WT Live requests, so it is fetched only where `fetch` is true (the For you tab, once
 * its rows have loaded); elsewhere (the "N new" pill) it only reads what that tab fetched.
 */
export function useForYouNew(vehicles: readonly string[], { fetch = true }: { fetch?: boolean } = {}) {
  const enabled = useWtLiveEnabled();
  return useQuery<ForYouNew, AppError>({
    queryKey: forYouNewKey(vehicles),
    queryFn: () => tracked(() => call<ForYouNew>('wtlive_for_you_new', { vehicles })),
    enabled: fetch && enabled && vehicles.length > 0,
    staleTime: 5 * 60_000,
  });
}

/** The query key of `useForYouNew` for this vehicle list. */
export const forYouNewKey = (vehicles: readonly string[]) => [...WTLIVE_KEY, 'for-you-new', vehicles];

/**
 * Leaving the For you tab resets its "N new" (`for_you_mark_seen`, local). An answer still on its
 * way is cancelled first (it was counted from the old time and would bring the count back); the
 * cached answers keep how many vehicles were checked but hold nothing new any more, then they are
 * invalidated.
 */
export function useMarkForYouSeen() {
  const qc = useQueryClient();
  return useMutation<string, AppError, void>({
    mutationFn: () => call<string>('for_you_mark_seen'),
    onMutate: () => qc.cancelQueries({ queryKey: [...WTLIVE_KEY, 'for-you-new'] }),
    onSuccess: () => {
      // Outside the tab the query doesn't refetch, so the pill must not keep the old count.
      qc.setQueriesData<ForYouNew>({ queryKey: [...WTLIVE_KEY, 'for-you-new'] }, (old) =>
        old ? { items: [], checked: old.checked } : old,
      );
      return qc.invalidateQueries({ queryKey: [...WTLIVE_KEY, 'for-you-new'] });
    },
  });
}

/** Starts a download + install; progress arrives as `install://progress` (see src/store/installs.ts). */
export function installFromWtLive(skinId: string, mode: InstallMode, conflict?: ConflictPolicy): Promise<InstallStarted> {
  return tracked(() => call<InstallStarted>('install_from_wtlive', conflict ? { skinId, mode, conflict } : { skinId, mode }));
}

/**
 * Try in game → Keep (becomes a normal hangar skin) or Discard (removed, game files restored).
 * `skinId` is the **WT Live** skin id (the hangar skin's `sourceId`), not a hangar id.
 */
export function useFinalizeTry() {
  const qc = useQueryClient();
  return useMutation<HangarSkin | null, AppError, { skinId: string; keep: boolean }>({
    mutationFn: (args) => call<HangarSkin | null>('finalize_try', args),
    onSettled: () => qc.invalidateQueries({ queryKey: HANGAR_KEY }),
  });
}

// ── Settings → WT Live: cache and hidden skins (local; never emit net://status) ──

/** What Livery keeps from WT Live: cache size and hidden skins (`wtlive_storage`, works offline). */
export function useWtLiveStorage() {
  return useQuery<WtLiveStorage, AppError>({
    queryKey: WTLIVE_STORAGE_KEY,
    queryFn: () =>
      hasBackend() ? call<WtLiveStorage>('wtlive_storage') : Promise.resolve<WtLiveStorage>({ cacheBytes: 0, hiddenCount: 0 }),
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

/** Empties the WT Live cache (`wtlive_clear_cache`). Not undoable: it is only a cache. */
export function useClearWtLiveCache() {
  const qc = useQueryClient();
  return useMutation<WtLiveStorage, AppError, void>({
    mutationFn: () => call<WtLiveStorage>('wtlive_clear_cache'),
    onSuccess: (storage) => qc.setQueryData(WTLIVE_STORAGE_KEY, storage),
  });
}

/**
 * The WT Live lists a hide or unhide changes: Explore's searches, Following's new skins and For
 * you's top and new skins (posts stay: a hidden skin's detail still opens, e.g. from My Hangar).
 */
function invalidateWtLiveLists(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: [...WTLIVE_KEY, 'search-pages'] }),
    qc.invalidateQueries({ queryKey: [...WTLIVE_KEY, 'search'] }),
    qc.invalidateQueries({ queryKey: [...WTLIVE_KEY, 'following-new'] }),
    qc.invalidateQueries({ queryKey: [...WTLIVE_KEY, 'vehicle-top'] }),
    qc.invalidateQueries({ queryKey: [...WTLIVE_KEY, 'for-you-new'] }),
  ]);
}

/** Takes a hidden skin out of the cached lists at once, so going back never shows (or focuses) its card. */
function pruneHidden(qc: ReturnType<typeof useQueryClient>, id: string) {
  const keep = (s: WtLiveSkin) => s.id !== id;
  qc.setQueriesData<InfiniteData<SearchResult, number>>({ queryKey: [...WTLIVE_KEY, 'search-pages'] }, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter(keep) })) } : data,
  );
  qc.setQueriesData<SearchResult>({ queryKey: [...WTLIVE_KEY, 'search'] }, (data) =>
    data ? { ...data, items: data.items.filter(keep) } : data,
  );
  qc.setQueriesData<WtLiveSkin[]>({ queryKey: [...WTLIVE_KEY, 'following-new'] }, (data) => data?.filter(keep));
  qc.setQueriesData<WtLiveSkin[]>({ queryKey: [...WTLIVE_KEY, 'vehicle-top'] }, (data) => data?.filter(keep));
  qc.setQueriesData<ForYouNew>({ queryKey: [...WTLIVE_KEY, 'for-you-new'] }, (data) =>
    data ? { ...data, items: data.items.filter((i) => keep(i.skin)) } : data,
  );
}

/**
 * Hides a WT Live skin from Explore and Following, or shows it again (`wtlive_set_hidden`). A skin
 * already installed stays in My Hangar: hiding only affects the WT Live lists.
 */
export function useSetWtLiveHidden() {
  const qc = useQueryClient();
  return useMutation<WtLiveStorage, AppError, { id: string; hidden: boolean }>({
    mutationFn: (args) => call<WtLiveStorage>('wtlive_set_hidden', args),
    onSuccess: (storage, { id, hidden }) => {
      qc.setQueryData(WTLIVE_STORAGE_KEY, storage);
      if (hidden) pruneHidden(qc, id);
      return invalidateWtLiveLists(qc);
    },
  });
}

/** Every hidden skin back in Explore and Following (`wtlive_unhide_all`). */
export function useUnhideAllWtLive() {
  const qc = useQueryClient();
  return useMutation<WtLiveStorage, AppError, void>({
    mutationFn: () => call<WtLiveStorage>('wtlive_unhide_all'),
    onSuccess: (storage) => {
      qc.setQueryData(WTLIVE_STORAGE_KEY, storage);
      return invalidateWtLiveLists(qc);
    },
  });
}
