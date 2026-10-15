import { useQuery } from '@tanstack/react-query';
import { call, hasBackend } from '@/lib/tauri';
import { useWtLiveEnabled } from '@/queries/settings';
import { useWtLivePost } from '@/queries/wtlive';
import type { HangarSkin } from '@/types';

/**
 * The picture a Hangar card shows: the WT Live post's (stored at install; for skins installed
 * before 0.3.0, the post's first picture, read while the card is on screen and cached like any
 * post), else a picture shipped in the skin's own folder (`skin_preview`), else none (the striped
 * placeholder stays).
 */
export function useSkinPreview(skin: HangarSkin): string | undefined {
  const wtlive = useWtLiveEnabled();
  const askPost = !skin.preview && skin.sourceId ? skin.sourceId : null;
  const post = useWtLivePost(askPost);
  const postPicture = post.data?.images[0];
  // The folder is read when the post has nothing to show (or there is no post).
  const postSettled = !askPost || !wtlive || post.isError || (post.isSuccess && !postPicture);
  const local = useQuery<string | null>({
    queryKey: ['skinPreview', skin.id, skin.folder],
    queryFn: () => call<string | null>('skin_preview', { id: skin.id }),
    enabled: hasBackend() && !skin.preview && postSettled,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
  return skin.preview ?? postPicture ?? local.data ?? undefined;
}
