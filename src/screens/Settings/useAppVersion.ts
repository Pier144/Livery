import { useQuery } from '@tanstack/react-query';
import { isTauri } from '@/lib/tauri';
import { version as PACKAGE_VERSION } from '../../../package.json';

/** Livery's version: the app's own (`tauri.conf.json`) in the desktop app, else package.json's. */
export function useAppVersion(): string {
  const { data } = useQuery({
    queryKey: ['appVersion'],
    queryFn: async () => {
      if (!isTauri()) return PACKAGE_VERSION;
      const { getVersion } = await import('@tauri-apps/api/app');
      return getVersion();
    },
    staleTime: Infinity,
  });
  return data ?? PACKAGE_VERSION;
}
