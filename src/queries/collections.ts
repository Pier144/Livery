import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, hasBackend } from '@/lib/tauri';
import type { AppError, Collection, CollectionsState, HangarSkin } from '@/types';
import { HANGAR_KEY } from './hangar';

export const COLLECTIONS_KEY = ['collections'] as const;

const EMPTY: CollectionsState = { collections: [] };

/** Every collection plus the one activated last. Empty outside Tauri. */
export function useCollections() {
  return useQuery<CollectionsState, AppError>({
    queryKey: COLLECTIONS_KEY,
    queryFn: () => (hasBackend() ? call<CollectionsState>('collections_list') : Promise.resolve(EMPTY)),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: COLLECTIONS_KEY });
}

export function useCreateCollection() {
  const invalidate = useInvalidate();
  return useMutation<Collection, AppError, { name: string; description?: string }>({
    mutationFn: ({ name, description }) => call<Collection>('collections_create', { name, description }),
    onSettled: invalidate,
  });
}

/** `undefined` leaves a field as it is; an empty description clears it. */
export function useUpdateCollection() {
  const invalidate = useInvalidate();
  return useMutation<Collection, AppError, { id: string; name?: string; description?: string }>({
    mutationFn: ({ id, name, description }) => call<Collection>('collections_update', { id, name, description }),
    onSettled: invalidate,
  });
}

export function useDeleteCollection() {
  const qc = useQueryClient();
  return useMutation<CollectionsState, AppError, string>({
    mutationFn: (id) => call<CollectionsState>('collections_delete', { id }),
    onSuccess: (state) => qc.setQueryData(COLLECTIONS_KEY, state),
  });
}

/** Undo for a collection delete. */
export function useRestoreCollection() {
  const qc = useQueryClient();
  return useMutation<CollectionsState, AppError, Collection>({
    mutationFn: (collection) => call<CollectionsState>('collections_restore', { collection }),
    onSuccess: (state) => qc.setQueryData(COLLECTIONS_KEY, state),
  });
}

/** Adds and/or removes members ("Move to collection", "Remove"). */
export function useSetCollectionSkins() {
  const invalidate = useInvalidate();
  return useMutation<Collection, AppError, { id: string; add?: string[]; remove?: string[] }>({
    mutationFn: ({ id, add = [], remove = [] }) => call<Collection>('collections_set_skins', { id, add, remove }),
    onSettled: invalidate,
  });
}

/** Makes exactly the collection's skins active in the game. */
export function useActivateCollection() {
  const qc = useQueryClient();
  return useMutation<HangarSkin[], AppError, string>({
    mutationFn: (id) => call<HangarSkin[]>('activate_collection', { id }),
    onSuccess: (index) => {
      qc.setQueryData(HANGAR_KEY, index);
      return qc.invalidateQueries({ queryKey: COLLECTIONS_KEY });
    },
    // Clashing skins are skipped but the rest moved and activeCollectionId changed: re-read both.
    onError: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: HANGAR_KEY }),
        qc.invalidateQueries({ queryKey: COLLECTIONS_KEY }),
      ]),
  });
}
