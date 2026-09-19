import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { errorText } from '@/lib/errors';
import { toAppError } from '@/lib/tauri';
import {
  COLLECTIONS_KEY,
  useActivateCollection,
  useCreateCollection,
  useDeleteCollection,
  useRestoreCollection,
  useSetCollectionSkins,
  useUpdateCollection,
} from '@/queries/collections';
import { HANGAR_KEY } from '@/queries/hangar';
import { useCollectionsUi } from '@/store/collections';
import { toast } from '@/store/toasts';
import type { Collection, CollectionsState, HangarSkin } from '@/types';

const fail = (e: unknown) => {
  toast(errorText(toAppError(e), i18n.t));
};

/**
 * Everything the Collections screen can change. Each action awaits `mutateAsync` rather than
 * passing callbacks to `mutate`, which TanStack Query drops for all but the latest call (two quick
 * "Remove"s must both get their Undo toast) and after an unmount.
 *
 * Renames, descriptions and removals patch the cached list first so the UI answers at once; the
 * mutations' own invalidation then brings the backend's truth back (also after a failure).
 */
export function useCollectionActions() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const create = useCreateCollection();
  const update = useUpdateCollection();
  const del = useDeleteCollection();
  const restore = useRestoreCollection();
  const setSkins = useSetCollectionSkins();
  const activate = useActivateCollection();

  const patch = (id: string, fn: (c: Collection) => Collection) =>
    qc.setQueryData<CollectionsState>(COLLECTIONS_KEY, (s) =>
      s ? { ...s, collections: s.collections.map((c) => (c.id === id ? fn(c) : c)) } : s,
    );

  /** "+ New": creates "New collection", opens it and focuses its name field. */
  const createAndRename = async () => {
    // Every entry point ("+ New", the empty state's "New collection") ignores repeat clicks.
    if (create.isPending) return;
    try {
      const created = await create.mutateAsync({ name: t('collections.newName') });
      // Normally the refetch already has it; make sure the detail can open it right away.
      qc.setQueryData<CollectionsState>(COLLECTIONS_KEY, (s) =>
        s && !s.collections.some((c) => c.id === created.id) ? { ...s, collections: [...s.collections, created] } : s,
      );
      useCollectionsUi.getState().startRename(created.id);
    } catch (e) {
      fail(e);
    }
  };

  const rename = async (id: string, name: string) => {
    patch(id, (c) => ({ ...c, name }));
    try {
      await update.mutateAsync({ id, name });
    } catch (e) {
      fail(e);
    }
  };

  /** An empty description clears it. */
  const describe = async (id: string, description: string) => {
    patch(id, (c) => ({ ...c, description: description || undefined }));
    try {
      await update.mutateAsync({ id, description });
    } catch (e) {
      fail(e);
    }
  };

  /** Makes exactly the collection's skins active in the game. Resolves to true on success. */
  const activateCollection = async (collection: Collection): Promise<boolean> => {
    try {
      const index = await activate.mutateAsync(collection.id);
      const members = new Set(collection.skinIds);
      const count = index.filter((s) => members.has(s.id)).length;
      toast(t('collections.toast.activated', { name: collection.name, count }));
      return true;
    } catch (e) {
      fail(e);
      // Folders that could move did move, and the collection may be the active one now.
      void qc.invalidateQueries({ queryKey: HANGAR_KEY });
      void qc.invalidateQueries({ queryKey: COLLECTIONS_KEY });
      return false;
    }
  };

  /** Takes a skin out of a collection (the skin stays installed); undoable. */
  const removeMember = async (collection: Collection, skin: HangarSkin) => {
    patch(collection.id, (c) => ({ ...c, skinIds: c.skinIds.filter((id) => id !== skin.id) }));
    try {
      await setSkins.mutateAsync({ id: collection.id, remove: [skin.id] });
    } catch (e) {
      fail(e);
      return;
    }
    toast.undoable(t('collections.toast.removed', { name: collection.name }), async () => {
      try {
        await setSkins.mutateAsync({ id: collection.id, add: [skin.id] });
      } catch (e) {
        fail(e);
      }
    });
  };

  /** Deletes a collection (its skins stay installed); Undo restores it as it was and reopens it. */
  const deleteCollection = async (collection: Collection): Promise<boolean> => {
    try {
      await del.mutateAsync(collection.id);
    } catch (e) {
      fail(e);
      return false;
    }
    toast.undoable(t('collections.toast.deleted', { name: collection.name }), async () => {
      try {
        await restore.mutateAsync(collection);
        useCollectionsUi.getState().open(collection.id);
      } catch (e) {
        fail(e);
      }
    });
    return true;
  };

  return {
    creating: create.isPending,
    activating: activate.isPending,
    deleting: del.isPending,
    createAndRename,
    rename,
    describe,
    activate: activateCollection,
    removeMember,
    deleteCollection,
  };
}

export type CollectionActions = ReturnType<typeof useCollectionActions>;
