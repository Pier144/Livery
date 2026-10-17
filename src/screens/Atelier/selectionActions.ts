import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor, type DeletedEntry } from '@/atelier/editorStore';
import { findLayer, isPiece } from '@/atelier/layerTree';
import type { MergeRefusal } from '@/atelier/merge';
import { MAX_PIECES, isPlacedLayer, type Layer } from '@/atelier/project';
import { toast } from '@/store/toasts';

/**
 * What the Layers panel and the Properties panel both offer on the selection: Merge, Put in
 * folder, Delete (with its undoable toast) and Separate, with the same toasts and refusals. The
 * one place these actions live.
 */

/** The toast for each reason a merge is refused. */
export const REFUSAL_KEYS: Record<MergeRefusal, `atelier.merge.${MergeRefusal}`> = {
  count: 'atelier.merge.count',
  unplaced: 'atelier.merge.unplaced',
  angle: 'atelier.merge.angle',
  pieces: 'atelier.merge.pieces',
  container: 'atelier.merge.container',
};

/**
 * Deletes these items as one undo step with an undoable toast. Undo uses the editor's own undo
 * while the layers are still the ones the delete left (redo keeps working), else puts every item
 * back where it was; with another project open it does nothing.
 */
export function deleteWithToast(ids: string[], message: string): void {
  const store = useAtelierEditor.getState();
  const projectId = store.project?.id;
  const entries: DeletedEntry[] = store.deleteLayers(ids);
  if (entries.length === 0) return;
  const after = useAtelierEditor.getState().layers;
  toast.undoable(message, () => {
    const now = useAtelierEditor.getState();
    // Another project open now (or none): the layers belong to the one they were deleted from.
    if (!projectId || now.project?.id !== projectId) return;
    if (entries.every((e) => findLayer(now.layers, e.layer.id))) return;
    // Still the layers the delete left: the editor's own undo.
    if (now.layers === after && now.past.length > 0) now.undo();
    else now.restoreLayers(entries);
  });
}

/**
 * Why Merge or Put in folder can't take this selection (null: it can). Merge is unavailable with a
 * folder or an unplaced layer; Put in folder with a folder (one level only), layers already in a
 * folder, or anything that isn't a top-level image, text, shape or merged layer.
 */
export function selectionBlocks(layers: readonly Layer[], ids: readonly string[], t: TFunction): { merge: string | null; folder: string | null } {
  const founds = ids.map((id) => findLayer(layers, id));
  const hasFolder = founds.some((f) => f?.layer.kind === 'folder');
  const unplaced = founds.some((f) => !f || !isPlacedLayer(f.layer as Layer) || !('decal' in f.layer) || f.layer.decal === null);
  const inFolder = founds.some((f) => f?.parent?.kind === 'folder');
  const notLayer = founds.some((f) => !f || isPiece(f) || !isPlacedLayer(f.layer as Layer));
  return {
    merge: hasFolder ? t('atelier.layers.mergeNoFolders') : unplaced ? t('atelier.layers.mergeUnplaced') : null,
    folder: hasFolder
      ? t('atelier.layers.noFolderInFolder')
      : inFolder
        ? t('atelier.layers.alreadyInFolder')
        : notLayer
          ? t('atelier.layers.folderOnlyLayers')
          : null,
  };
}

/** The selection actions with their toasts, in the current language. */
export function useSelectionActions() {
  const { t } = useTranslation();
  return {
    /** Merges these layers; a refusal or a reset Only this part / Mirror shows a toast. */
    merge: (ids: string[]) => {
      const result = useAtelierEditor.getState().mergeLayers(ids);
      if (!result.ok) {
        toast(t(REFUSAL_KEYS[result.reason], { max: MAX_PIECES }));
        return;
      }
      const done = t('atelier.merge.done', { count: ids.length });
      const { part, mirror } = result.reset;
      const note = part && mirror ? t('atelier.merge.resetBoth') : part ? t('atelier.merge.resetPart') : mirror ? t('atelier.merge.resetMirror') : null;
      toast(note ? t('atelier.merge.withNote', { done, note }) : done);
    },
    /**
     * A new "Folder N", selected; its id. With `ids` it holds them, and when they can't go in
     * together no folder is made: a toast says why and the result is null. Without, it is empty.
     */
    putInFolder: (ids?: string[]): string | null => {
      const store = useAtelierEditor.getState();
      const name = t('atelier.layers.folderName', { number: store.layers.filter((l) => l.kind === 'folder').length + 1 });
      if (!ids || ids.length === 0) return store.createFolder(name);
      const id = store.createFolder(name, ids);
      if (id === null) toast(selectionBlocks(store.layers, ids, t).folder ?? t('atelier.layers.folderOnlyLayers'));
      return id;
    },
    /** Deletes one layer with the "Deleted layer" undoable toast. */
    deleteOne: (id: string, name: string) => deleteWithToast([id], t('atelier.layers.deleted', { name })),
    /** Deletes the selected layers with the "Deleted N layers" undoable toast. */
    deleteMany: (ids: string[]) => deleteWithToast(ids, t('atelier.layers.deletedCount', { count: ids.length })),
    /** Deletes a folder and its content with the "Deleted folder" undoable toast. */
    deleteFolder: (id: string, name: string) => deleteWithToast([id], t('atelier.layers.deletedFolder', { name })),
    /** Separates a merged object; says so when its repeat was dropped. */
    separate: (id: string) => {
      const result = useAtelierEditor.getState().separate(id);
      if (result.ok && result.droppedRepeat) toast(t('atelier.layers.separatedRepeat'));
    },
  };
}
