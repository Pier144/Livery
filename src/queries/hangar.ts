import { useQuery } from '@tanstack/react-query';

export interface HangarSummary {
  count: number;
  sizeBytes: number;
}

export const HANGAR_SUMMARY_KEY = ['hangar', 'summary'] as const;

const EMPTY: HangarSummary = { count: 0, sizeBytes: 0 };

/** Installed-skin count and total size on disk (sidebar status card). Zero while loading. */
export function useHangarSummary(): HangarSummary {
  const { data } = useQuery<HangarSummary>({
    queryKey: HANGAR_SUMMARY_KEY,
    // TODO(M3): derive from the `get_hangar` command (skin count + summed sizeBytes).
    queryFn: () => Promise.resolve(EMPTY),
  });
  return data ?? EMPTY;
}
