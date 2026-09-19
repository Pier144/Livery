import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call, isTauri } from '@/lib/tauri';
import { DETECT_EVENT, type AppError, type DetectEvent, type GameDetection, type GameSource, type HangarSkin } from '@/types';
import { HANGAR_KEY } from './hangar';
import { SETTINGS_KEY } from './settings';

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
 * folder isn't War Thunder. The backend persists gamePath/gameSource/gameVersion, so settings are
 * refetched before the mutation settles.
 */
export function useSetGamePath() {
  const qc = useQueryClient();
  return useMutation<GameDetection, AppError, SetGamePathArgs>({
    mutationFn: ({ path, source }) => call<GameDetection>('set_game_path', source ? { path, source } : { path }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
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
