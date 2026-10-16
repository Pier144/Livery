import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, isTauri } from '@/lib/tauri';
import {
  DETECT_EVENT,
  type AppError,
  type DetectEvent,
  type GameDetection,
  type GameSource,
  type HangarSkin,
  type Lineups,
} from '@/types';
import { COLLECTIONS_KEY } from './collections';
import { HANGAR_KEY } from './hangar';
import { BACKUPS_KEY, SETTINGS_KEY, useSettings } from './settings';

/** What the plain-browser build (`pnpm dev`, no backend) reports: nothing found anywhere. */
const BROWSER_EVENTS: DetectEvent[] = [
  { source: 'steam', state: 'notFound' },
  { source: 'standalone', state: 'notFound' },
  { source: 'custom', state: 'skipped' },
];

/**
 * Runs `detect_game`, forwarding each `game://detect` event to `onEvent` so First run can animate
 * its rows. The listener is registered before the command starts and removed when it settles.
 * Rejects with an `AppError`.
 */
export async function detectGame(onEvent: (event: DetectEvent) => void): Promise<GameDetection> {
  if (!isTauri()) {
    // `pnpm dev:mock`: the mock hands over its events directly (there is no Tauri event bus).
    // The env check is inline (not `MOCK_BACKEND`) so the production build drops the mock chunk.
    if (import.meta.env.VITE_MOCK_BACKEND === '1') {
      const { mockDetectGame } = await import('@/dev/mockBackend');
      return mockDetectGame(onEvent);
    }
    BROWSER_EVENTS.forEach(onEvent);
    return { found: false, existingSkins: 0 };
  }
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<DetectEvent>(DETECT_EVENT, (e) => onEvent(e.payload));
  try {
    return await call<GameDetection>('detect_game');
  } finally {
    unlisten();
  }
}

export interface SetGamePathArgs {
  path: string;
  /** Omitted for a folder the user picked or dropped (`custom`). */
  source?: GameSource;
}

/**
 * Validates and saves the game root (`set_game_path`). Rejects with code `invalidInput` when the
 * folder isn't War Thunder. The backend persists gamePath/gameSource/gameVersion, and each game
 * folder has its own library index (skins, collections, backups), so the settings, My Hangar,
 * the collections and the backups list are refetched before the mutation settles.
 */
export function useSetGamePath() {
  const qc = useQueryClient();
  return useMutation<GameDetection, AppError, SetGamePathArgs>({
    mutationFn: ({ path, source }) => call<GameDetection>('set_game_path', source ? { path, source } : { path }),
    onSuccess: () =>
      Promise.all(
        [SETTINGS_KEY, HANGAR_KEY, COLLECTIONS_KEY, BACKUPS_KEY].map((queryKey) => qc.invalidateQueries({ queryKey })),
      ),
  });
}

/** Full rescan of `UserSkins` with attention checks (`scan_user_skins`). Doesn't touch the index. */
export function useScanUserSkins() {
  return useMutation<HangarSkin[], AppError, void>({
    mutationFn: () => call<HangarSkin[]>('scan_user_skins'),
  });
}

/** Adds scanned `UserSkins` folders to the library index (`import_skins`); resolves with the whole index. */
export function useImportSkins() {
  const qc = useQueryClient();
  return useMutation<HangarSkin[], AppError, string[]>({
    mutationFn: (folders) => call<HangarSkin[]>('import_skins', { folders }),
    onSuccess: () => qc.invalidateQueries({ queryKey: HANGAR_KEY }),
  });
}

export const LINEUPS_KEY = ['lineups'] as const;

/**
 * The player's lineups from the War Thunder profile (`game_lineups`, local data). Read only while
 * `enabled` (the For you tab is open): on opening it and when the window regains focus meanwhile;
 * elsewhere the hook only returns what is cached. Settings → Game → Read data from the game is in
 * the key, so switching it reads again. The backend caches by path, size and modification time,
 * so a refetch is cheap.
 */
export function useLineups({ enabled }: { enabled: boolean }) {
  const readGameData = useSettings().data?.readGameData !== false;
  return useQuery<Lineups, AppError>({
    queryKey: [...LINEUPS_KEY, readGameData],
    queryFn: () => call<Lineups>('game_lineups'),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}
