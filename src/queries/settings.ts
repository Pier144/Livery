import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, isTauri } from '@/lib/tauri';
import type { AppError, Settings } from '@/types';

export const DEFAULT_SETTINGS: Settings = {
  autoInstall: false,
  conflictPolicy: 'ask',
  backups: true,
  backupDays: 30,
  language: 'en',
  autoUpdate: true,
  startWithWindows: false,
  onboarded: false,
};

export const SETTINGS_KEY = ['settings'] as const;

/** Settings from `<appData>/settings.json`; defaults when running outside Tauri (browser dev, tests). */
export function useSettings() {
  return useQuery<Settings, AppError>({
    queryKey: SETTINGS_KEY,
    queryFn: () => (isTauri() ? call<Settings>('get_settings') : Promise.resolve(DEFAULT_SETTINGS)),
    staleTime: Infinity,
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation<Settings, AppError, Partial<Settings>>({
    mutationFn: (patch) =>
      isTauri()
        ? call<Settings>('set_settings', { patch })
        : Promise.resolve({ ...(qc.getQueryData<Settings>(SETTINGS_KEY) ?? DEFAULT_SETTINGS), ...patch }),
    onSuccess: (settings) => qc.setQueryData(SETTINGS_KEY, settings),
  });
}
