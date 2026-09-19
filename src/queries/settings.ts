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

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation<Settings, AppError, Partial<Settings>>({
    mutationFn: (patch) =>
      hasBackend()
        ? call<Settings>('set_settings', { patch })
        : Promise.resolve({ ...(qc.getQueryData<Settings>(SETTINGS_KEY) ?? DEFAULT_SETTINGS), ...patch }),
    onSuccess: (settings) => qc.setQueryData(SETTINGS_KEY, settings),
  });
}
