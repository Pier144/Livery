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
import { useUi } from '@/store/ui';
import {
  EVENTS,
  type AppError,
  type ConflictPolicy,
  type FollowEntry,
  type FollowKind,
  type HangarSkin,
  type InstallMode,
  type InstallStarted,
  type NetStatus,
  type SearchParams,
  type SearchResult,
  type WtLiveSkin,
} from '@/types';
import { HANGAR_KEY } from './hangar';

export const WTLIVE_KEY = ['wtlive'] as const;
export const FOLLOWING_KEY = ['following'] as const;

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

/** Explore grid. Filters combine (AND); previous results stay on screen while the next page loads. */
export function useWtLiveSearch(params: SearchParams) {
  return useQuery<SearchResult, AppError>({
    queryKey: [...WTLIVE_KEY, 'search', params],
    queryFn: () => tracked(() => call<SearchResult>('wtlive_search', { params })),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

/**
 * Explore grid, page after page (BUILD_PLAN open decision 2): the backend fetches, caches and
 * filters WT Live locally and answers pages of results; call `fetchNextPage()` when the virtual
 * grid nears the end. `total` and `tookMs` come from the first page.
 */
export function useWtLiveSearchPages(params: Omit<SearchParams, 'page'>) {
  return useInfiniteQuery<SearchResult, AppError, InfiniteData<SearchResult, number>, QueryKey, number>({
    queryKey: [...WTLIVE_KEY, 'search-pages', params],
    queryFn: ({ pageParam }) => tracked(() => call<SearchResult>('wtlive_search', { params: { ...params, page: pageParam } })),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? pages.length : undefined;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

/** Full post (images, files) for the Skin detail. */
export function useWtLivePost(id: string | null) {
  return useQuery<WtLiveSkin, AppError>({
    queryKey: [...WTLIVE_KEY, 'post', id],
    queryFn: () => tracked(() => call<WtLiveSkin>('wtlive_post', { id })),
    enabled: id !== null,
    staleTime: 5 * 60_000,
  });
}

/** New skins from followed vehicles/authors since they were last seen. */
export function useFollowingNew(entries: FollowEntry[] | undefined) {
  const vehicles = (entries ?? []).filter((e) => e.kind === 'vehicle').map((e) => e.id);
  const authors = (entries ?? []).filter((e) => e.kind === 'author').map((e) => e.id);
  return useQuery<WtLiveSkin[], AppError>({
    queryKey: [...WTLIVE_KEY, 'following-new', vehicles, authors],
    queryFn: () => tracked(() => call<WtLiveSkin[]>('wtlive_following_new', { vehicles, authors })),
    enabled: entries !== undefined && (vehicles.length > 0 || authors.length > 0),
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
      return qc.invalidateQueries({ queryKey: [...WTLIVE_KEY, 'following-new'] });
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
