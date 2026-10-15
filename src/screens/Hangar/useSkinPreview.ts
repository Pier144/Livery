import { skipToken, useQuery } from '@tanstack/react-query';
import { call, hasBackend } from '@/lib/tauri';
import { WTLIVE_KEY } from '@/queries/wtlive';
import type { HangarSkin, WtLiveSkin } from '@/types';

/**
 * The picture a Hangar card shows, without asking WT Live anything (docs/wtlive-terms.md: only a
 * user action reaches WT Live):
 * 1. `HangarSkin.preview`, the post's picture stored at install, or when the user last opened the
 *    post's page (the backend stores it then for skins installed before pictures were kept);
 * 2. the post's picture if this session already has the post (its page was opened), read from the
 *    query cache only;
 * 3. a picture shipped in the skin's own folder (`skin_preview`);
 * else none, and the striped placeholder stays.
 */
export function useSkinPreview(skin: HangarSkin): string | undefined {
  const cachedPost = useQuery<WtLiveSkin>({
    queryKey: [...WTLIVE_KEY, 'post', skin.sourceId ?? null],
    // Never fetched from here: only what the Skin detail already loaded.
    queryFn: skipToken,
  });
  const postPicture = skin.preview ? undefined : cachedPost.data?.images[0];
  const local = useQuery<string | null>({
    queryKey: ['skinPreview', skin.id, skin.folder],
    queryFn: () => call<string | null>('skin_preview', { id: skin.id }),
    enabled: hasBackend() && !skin.preview && !postPicture,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
  return skin.preview ?? postPicture ?? local.data ?? undefined;
}
