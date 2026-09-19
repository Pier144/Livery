import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MOCK_BACKEND, call, isTauri } from '@/lib/tauri';
import type { AppError, Settings } from '@/types';

/**
 * `hasBackend()` (Tauri or the `pnpm dev:mock` backend), spelled out so tests that mock only
 * `isTauri` in `@/lib/tauri` still reach `call`.
 */
const hasBackend = () => isTauri() || MOCK_BACKEND;

export const DEFAULT_SETTINGS: Settings = {
  autoInstall: false,
  conflictPolicy: 'ask',
  backups: true,
  backupDays: 30,
  language: 'en',
  autoUpdate: true,
  startWithWindows: false,
  onboarded: false,
  reduceMotion: 'system',
};

export const SETTINGS_KEY = ['settings'] as const;

/** Mutation scope of every settings patch (run one at a time, in order). */
export const SETTINGS_SCOPE = 'settings';

/**
 * Kept backups (`list_backups`), Settings → Backups. Declared here so queries that change the
 * backups (a new game folder) can invalidate them without importing a screen.
 */
export const BACKUPS_KEY = ['backups'] as const;

/**
 * Settings from `<appData>/settings.json` (or the `pnpm dev:mock` backend); defaults when nothing
 * answers commands (plain browser dev, tests).
 */
export function useSettings() {
  return useQuery<Settings, AppError>({
    queryKey: SETTINGS_KEY,
    queryFn: () => (hasBackend() ? call<Settings>('get_settings') : Promise.resolve(DEFAULT_SETTINGS)),
    staleTime: Infinity,
  });
}

/**
 * Saves a partial update (`set_settings`); the answer (the whole settings) replaces the query
 * data. Patches share one mutation scope, so they reach the backend one after another in the
 * order they were made: `set_settings` runs on a background thread, and two in flight at once
 * could otherwise be answered out of order and leave the older settings in the cache.
 */
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation<Settings, AppError, Partial<Settings>>({
    scope: { id: SETTINGS_SCOPE },
    mutationFn: (patch) =>
      hasBackend()
        ? call<Settings>('set_settings', { patch })
        : Promise.resolve({ ...(qc.getQueryData<Settings>(SETTINGS_KEY) ?? DEFAULT_SETTINGS), ...patch }),
    onSuccess: (settings) => qc.setQueryData(SETTINGS_KEY, settings),
  });
}
