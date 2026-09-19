import { useQuery } from '@tanstack/react-query';
import { call, isTauri } from '@/lib/tauri';
import type { AppError, HangarSkin } from '@/types';

export interface HangarSummary {
  count: number;
  sizeBytes: number;
}

/** Invalidate after anything that changes the index (import, install, delete…). */
export const HANGAR_KEY = ['hangar'] as const;

const NONE: HangarSkin[] = [];

/** Skins in My Hangar (`get_hangar`, from the library index). Empty outside Tauri. */
export function useHangar() {
  return useQuery<HangarSkin[], AppError>({
    queryKey: HANGAR_KEY,
    queryFn: () => (isTauri() ? call<HangarSkin[]>('get_hangar') : Promise.resolve(NONE)),
  });
}

/** Installed-skin count and total size on disk (sidebar status card). Zero while loading. */
export function useHangarSummary(): HangarSummary {
  const { data = NONE } = useHangar();
  return { count: data.length, sizeBytes: data.reduce((sum, s) => sum + s.sizeBytes, 0) };
}
