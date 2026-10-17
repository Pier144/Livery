import {
  MAX_PIECES,
  add,
  decalRight,
  isPlacedLayer,
  maskOf,
  newFolder,
  newLayerId,
  scale,
  sub,
  type Decal,
  type Layer,
  type MergedLayer,
  type Piece,
  type PieceLayer,
  type PlacedLayer,
  type UnsupportedLayer,
} from './project';
import { checkPiece } from './projectCheck';
import {
  allLayers,
  childrenOf,
  findLayer,
  framedLayerOf,
  insertLayers,
  isPiece,
  moveItems,
  removeLayers,
  spliceLayer,
  type Found,
  type ParentId,
  type TreeItem,
} from './layerTree';
import { mergeFrame, pieceDecal, placeOf, repeatDecals, separatePieces, type MergeRefusal } from './merge';

/**
 * The editor's structural edits of the layer tree (add, duplicate, move, delete and restore,
 * folders, merge and separate), as pure functions: each takes the layers and answers the new ones
 * with who is selected after, or null when nothing changes. The store makes them undo steps.
 */

/** Where `duplicateLayer` puts the copy: this fraction of the decal's height down and right along the surface. */
export const DUPLICATE_OFFSET = 0.05;

/**
 * What `deleteLayers` removed: the layer or piece as it was, its container and its index there.
 * `fromMerged` marks a piece (an unsupported one may have no `place`), which only goes back into
 * its merged object.
 */
export interface DeletedEntry {
  layer: Layer | Piece;
  parentId: string | null;
  index: number;
  fromMerged?: boolean;
}

/** What `mergeLayers` answers. `reset` says whether the shared part or Mirror differ from some layer's own. */
export type MergeResult = { ok: true; id: string; reset: { part: boolean; mirror: boolean } } | { ok: false; reason: MergeRefusal };

/** What `separate` answers: the new layers' ids (bottom to top) and whether the object's repeat was dropped. */
export type SeparateResult = { ok: true; ids: string[]; droppedRepeat: boolean } | { ok: false };

/** A structural edit: the new layers and the active row after it. */
export interface TreeEdit {
  layers: Layer[];
  selectedId: string | null;
}

/**
 * Where a new layer goes (spec "Where a new layer goes"): above the selected layer in its
 * container; at the top of a selected folder; above the merged object of a selected piece; just
 * under the mask with the Base, the mask or nothing selected.
 */
export function insertTarget(layers: readonly Layer[], selectedId: string | null): { parentId: ParentId; index: number } {
  const found = selectedId === null ? null : findLayer(layers, selectedId);
  if (found) {
    const { layer } = found;
    if (isPiece(found)) {
      const merged = findLayer(layers, found.parentId!);
      if (merged) return { parentId: merged.parentId, index: merged.index + 1 };
    } else if (layer.kind === 'folder') {
      return { parentId: layer.id, index: layer.children.length };
    } else if (layer.kind !== 'base' && layer.kind !== 'mask') {
      return { parentId: found.parentId, index: found.index + 1 };
    }
  }
  const mask = layers.findIndex((l) => l.kind === 'mask');
  return { parentId: null, index: mask >= 0 ? mask : layers.length };
}

/** Whether the found item may be part of a multi-selection: a placed layer or a folder, not a piece. */
export function multiSelectable(found: Found | null): found is Found {
  return !!found && !isPiece(found) && (found.layer.kind === 'folder' || isPlacedLayer(found.layer as Layer));
}

/** Who is selected after the item at `index` of `parentId` went: the item below, else the container, else the first layer. */
function selectionAfterRemoval(layers: readonly Layer[], parentId: ParentId, index: number): string | null {
  const below = childrenOf(layers, parentId)[index - 1];
  if (below) return below.id;
  if (parentId !== null && findLayer(layers, parentId)) return parentId;
  return layers[0]?.id ?? null;
}

/** The selection kept by an undo or redo landing on `layers`: the active row if it still exists, else the first layer. */
export function selectionIn(layers: readonly Layer[], selectedId: string | null): string | null {
  return selectedId !== null && findLayer(layers, selectedId) ? selectedId : (layers[0]?.id ?? null);
}

/** Gives `item` and everything inside it new ids (in place: call it on a copy). */
function renewIds(item: TreeItem): void {
  item.id = newLayerId();
  if (item.kind === 'folder' || item.kind === 'merged') for (const child of item.children) renewIds(child);
}

/** The decal of a duplicate: moved down and right along the surface by DUPLICATE_OFFSET of its height. */
function offsetDecal(decal: Decal): Decal {
  const step = (DUPLICATE_OFFSET * decal.height) / Math.SQRT2;
  return { ...decal, center: add(decal.center, scale(sub(decalRight(decal), decal.up), step)) };
}

/** A copy of a placed layer or folder right above it, with new ids and moved a little (see `duplicateLayer`). */
export function duplicateItem(layers: Layer[], id: string): TreeEdit | null {
  const found = findLayer(layers, id);
  if (!found || isPiece(found)) return null;
  const layer = found.layer as Layer;
  if (!isPlacedLayer(layer) && layer.kind !== 'folder') return null;
  const copy = structuredClone(layer);
  renewIds(copy);
  if (copy.kind === 'folder') {
    for (const child of copy.children) if (isPlacedLayer(child) && child.decal) child.decal = offsetDecal(child.decal);
  } else if (copy.decal) {
    copy.decal = offsetDecal(copy.decal);
  }
  const next = insertLayers(layers, found.parentId, found.index + 1, [copy]);
  return next === layers ? null : { layers: next, selectedId: copy.id };
}

/** A layer or folder moved within its container (see `moveLayer`). */
export function moveItem(layers: Layer[], id: string, toIndex: number): Layer[] | null {
  const found = findLayer(layers, id);
  if (!found || isPiece(found) || !Number.isFinite(toIndex)) return null;
  const layer = found.layer as Layer;
  if (layer.kind === 'base' || layer.kind === 'mask') return null;
  const list = childrenOf(layers, found.parentId);
  const top = found.parentId === null;
  const first = top ? 1 : 0;
  const last = list.length - 1 - (top && maskOf(layers) ? 1 : 0);
  const target = Math.min(last, Math.max(first, Math.round(toIndex)));
  if (target === found.index) return null;
  return insertLayers(removeLayers(layers, [id]), found.parentId, target, [layer]);
}

/** A layer or folder moved into a folder or to the top level (see `moveInto`). */
export function moveIntoFolder(layers: Layer[], id: string, parentId: string | null, index: number): Layer[] | null {
  const found = findLayer(layers, id);
  if (!found || isPiece(found) || !Number.isFinite(index)) return null;
  const kind = found.layer.kind;
  if (kind === 'base' || kind === 'mask') return null;
  if (parentId !== null) {
    // One level of folders, and only folders take layers dragged in.
    if (kind === 'folder' || findLayer(layers, parentId)?.layer.kind !== 'folder') return null;
  }
  const next = moveItems(layers, [id], parentId, index);
  return next === layers ? null : next;
}

/** The merged object that would be left without a drawable piece if the found piece went, or null. */
function emptiedBy(found: Found): MergedLayer | null {
  if (!isPiece(found) || found.parent?.kind !== 'merged') return null;
  const merged = found.parent;
  return merged.children.some((c) => c.id !== found.layer.id && c.kind !== 'unsupported') ? null : merged;
}

/** Removes the found item (or the merged object it would leave empty); the entry, or null for the Base. */
function removal(layers: Layer[], found: Found): { layers: Layer[]; entry: DeletedEntry } | null {
  if (found.layer.kind === 'base') return null;
  const emptied = emptiedBy(found);
  const target = emptied ? findLayer(layers, emptied.id) : found;
  if (!target) return null;
  const entry: DeletedEntry = { layer: target.layer as Layer | Piece, parentId: target.parentId, index: target.index };
  if (isPiece(target)) entry.fromMerged = true;
  return { layers: removeLayers(layers, [target.layer.id]), entry };
}

/**
 * `layers` with `item` back in `parentId` at `index`, or the top level under the mask when that
 * container can't take it. Unchanged when the item or anything inside it has an id already in the
 * tree (it came back another way: an undo then Separate or Dissolve), and for a piece
 * (`fromMerged`) whose merged object is gone.
 */
function restored(layers: Layer[], item: Layer | Piece, parentId: ParentId, index: number, fromMerged = false): Layer[] {
  if (allLayers([item] as Layer[]).some((inner) => findLayer(layers, inner.id))) return layers;
  if (parentId !== null) {
    const container = findLayer(layers, parentId)?.layer;
    const piece = fromMerged || 'place' in item;
    const fits = container?.kind === 'merged' ? piece : container?.kind === 'folder' && item.kind !== 'folder' && !piece;
    if (fits) return insertLayers(layers, parentId, index, [item]);
  }
  // A piece only lives in a merged object.
  if (fromMerged || 'place' in item) return layers;
  return insertLayers(layers, null, parentId === null ? index : Number.NaN, [item]);
}

/** One item deleted (see `deleteLayer`): the active row stays when it is still there. */
export function deleteItem(layers: Layer[], id: string, selectedId: string | null): TreeEdit | null {
  const found = findLayer(layers, id);
  const removed = found && removal(layers, found);
  if (!removed) return null;
  const { entry } = removed;
  const next = removed.layers;
  const keep = selectedId !== null && findLayer(next, selectedId) !== null;
  return { layers: next, selectedId: keep ? selectedId : selectionAfterRemoval(next, entry.parentId, entry.index) };
}

/** These items deleted (see `deleteLayers`), with what was removed in removal order; null when nothing was. */
export function deleteItems(layers: Layer[], ids: string[], selectedId: string | null): (TreeEdit & { entries: DeletedEntry[] }) | null {
  const wanted = new Set(ids);
  /** Inside a container that goes too: it goes with it. */
  const inWanted = (id: string): boolean => {
    for (let at = findLayer(layers, id); at && at.parentId !== null; at = findLayer(layers, at.parentId)) {
      if (wanted.has(at.parentId)) return true;
    }
    return false;
  };
  // Top of the tree first, so each entry's index is its place before the delete.
  const order = allLayers(layers)
    .filter((item) => wanted.has(item.id) && !inWanted(item.id))
    .reverse();
  let next = layers;
  const entries: DeletedEntry[] = [];
  for (const item of order) {
    const found = findLayer(next, item.id);
    // Gone with a container deleted earlier in this run.
    if (!found) continue;
    const removed = removal(next, found);
    if (!removed) continue;
    next = removed.layers;
    entries.push(removed.entry);
  }
  const last = entries[entries.length - 1];
  if (!last) return null;
  const keep = selectedId !== null && findLayer(next, selectedId) !== null;
  return { layers: next, selectedId: keep ? selectedId : selectionAfterRemoval(next, last.parentId, last.index), entries };
}

/** A deleted layer or piece put back (see `restoreLayer`); null when it can't be. */
export function restoreItem(layers: Layer[], layer: Layer | Piece, index: number, parentId: ParentId): Layer[] | null {
  if (layer.kind === 'base' || layer.kind === 'mask' || !Number.isFinite(index)) return null;
  const next = restored(layers, layer, parentId, Math.round(index));
  return next === layers ? null : next;
}

/** What `deleteItems` removed put back (see `restoreLayers`), the topmost restored item active; null when none could be. */
export function restoreItems(layers: Layer[], entries: DeletedEntry[]): TreeEdit | null {
  let next = layers;
  let topmost: string | null = null;
  // In reverse removal order, so each index means what it meant when its item left.
  for (const entry of [...entries].reverse()) {
    const { layer } = entry;
    if (layer.kind === 'base' || layer.kind === 'mask') continue;
    const put = restored(next, layer, entry.parentId, entry.index, entry.fromMerged === true);
    if (put === next) continue;
    next = put;
    topmost = layer.id;
  }
  return next === layers ? null : { layers: next, selectedId: topmost };
}

/** A new folder (see `createFolder`); null when refused. */
export function createFolderIn(layers: Layer[], selectedId: string | null, name: string, ids?: string[]): TreeEdit | null {
  if (ids && ids.length > 0) {
    const unique = [...new Set(ids)];
    const founds = unique.map((id) => findLayer(layers, id));
    if (!founds.every((f): f is Found => f !== null && f.parentId === null && isPlacedLayer(f.layer as Layer))) return null;
    founds.sort((a, b) => a.index - b.index);
    const topmost = founds[founds.length - 1]!;
    const folder = newFolder(
      name,
      founds.map((f) => f.layer as PlacedLayer),
    );
    // The folder takes the topmost layer's place once the layers below it have left.
    const next = insertLayers(removeLayers(layers, unique), null, topmost.index - (founds.length - 1), [folder]);
    return { layers: next, selectedId: folder.id };
  }
  let { parentId, index } = insertTarget(layers, selectedId);
  if (parentId !== null) {
    // Never in a folder: right above the top-level layer holding the target.
    let holder = findLayer(layers, parentId);
    while (holder && holder.parentId !== null) holder = findLayer(layers, holder.parentId);
    if (!holder) return null;
    parentId = null;
    index = holder.index + 1;
  }
  const folder = newFolder(name);
  return { layers: insertLayers(layers, parentId, index, [folder]), selectedId: folder.id };
}

/** The folder's children in its place (see `dissolveFolder`); the topmost child becomes active when the folder was. */
export function dissolveFolderIn(layers: Layer[], id: string, selectedId: string | null): TreeEdit | null {
  const found = findLayer(layers, id);
  if (found?.layer.kind !== 'folder') return null;
  const { children } = found.layer;
  const next = spliceLayer(layers, id, children);
  if (next === layers) return null;
  const active =
    selectedId !== id ? selectedId : (children[children.length - 1]?.id ?? selectionAfterRemoval(next, found.parentId, found.index));
  return { layers: next, selectedId: active };
}

/** One piece-to-be of a merge: the item without its frame and its box on the vehicle (null for an unsupported piece without a place). */
interface MergeSource {
  item: Omit<Piece, 'place'> | UnsupportedLayer;
  box: Decal | null;
}

/** A placed layer's merge sources: one per repeat copy, or a merged object's pieces per frame copy (flattened). */
function mergeSources(layer: PlacedLayer & { decal: Decal }): MergeSource[] {
  const copies = repeatDecals(layer.decal, layer.repeat);
  if (layer.kind !== 'merged') {
    const source = { ...layer } as Partial<PieceLayer>;
    delete source.decal;
    delete source.repeat;
    // A solid shape's alternate colour fills every second copy (as `plainGroups` draws it).
    const alternate = layer.kind === 'shape' && layer.fill.kind === 'solid' ? layer.repeat?.alternate : undefined;
    // The first copy keeps the layer's id (as Separate gives it back), the others get new ones.
    return copies.map((box, i) => {
      const fill = alternate !== undefined && i % 2 === 1 ? { fill: { kind: 'solid' as const, color: alternate } } : {};
      return { item: { ...source, ...fill, id: i === 0 ? layer.id : newLayerId() } as Omit<Piece, 'place'>, box };
    });
  }
  const out: MergeSource[] = [];
  copies.forEach((frame, i) => {
    for (const child of layer.children) {
      // An unsupported piece can't be drawn, so it isn't repeated either.
      if (child.kind === 'unsupported' && i > 0) continue;
      const { place, ...rest } = child;
      const id = i === 0 ? child.id : newLayerId();
      if (rest.kind === 'unsupported') {
        out.push({ item: { ...rest, id } as UnsupportedLayer, box: place ? pieceDecal(frame, place) : null });
        continue;
      }
      // The merged object's opacity and visibility go into its pieces, so they look the same in the new one.
      const item = { ...rest, id, opacity: rest.opacity * layer.opacity, visible: rest.visible && layer.visible } as Omit<Piece, 'place'>;
      out.push({ item, box: place ? pieceDecal(frame, place) : null });
    }
  });
  return out;
}

/** Placed layers of one container merged into a merged object at the topmost one's place (spec "Merge"). */
export function mergeItems(layers: Layer[], ids: string[]): (Extract<MergeResult, { ok: true }> & { layers: Layer[] }) | Extract<MergeResult, { ok: false }> {
  const unique = [...new Set(ids)];
  if (unique.length < 2) return { ok: false, reason: 'count' };
  const founds = unique.map((id) => findLayer(layers, id));
  const first = founds[0];
  if (!founds.every((f): f is Found => f !== null && !isPiece(f) && f.layer.kind !== 'folder' && f.parentId === first?.parentId)) {
    return { ok: false, reason: 'container' };
  }
  const placed = unique.map((id) => framedLayerOf(layers, id));
  if (!placed.every((l): l is PlacedLayer & { decal: Decal } => l !== null && l.decal !== null)) return { ok: false, reason: 'unplaced' };
  // Bottom to top in the container.
  const order = founds.map((f, i) => ({ found: f, layer: placed[i]! })).sort((a, b) => a.found.index - b.found.index);
  const sources = order.flatMap(({ layer }) => mergeSources(layer));
  if (sources.length > MAX_PIECES) return { ok: false, reason: 'pieces' };
  const top = order[order.length - 1]!;
  const boxes = sources.filter((s) => s.item.kind !== 'unsupported' && s.box !== null).map((s) => s.box!);
  const made = mergeFrame(boxes, top.layer.decal.up);
  if (!('frame' in made)) return { ok: false, reason: made.refused };
  const parts = order.map(({ layer }) => layer.decal.part);
  const part = parts.every((p) => p === parts[0]) ? parts[0]! : 'all';
  const mirror = order.every(({ layer }) => layer.decal.mirror);
  const frame: Decal = { ...made.frame, part, mirror };
  const children: MergedLayer['children'] = [];
  for (const { item, box } of sources) {
    if (item.kind === 'unsupported') {
      children.push(box ? { ...item, place: placeOf(frame, box) } : item);
      continue;
    }
    const piece = checkPiece({ ...item, place: placeOf(frame, box!) } as Piece);
    // Nothing is lost silently: a piece that doesn't check out refuses the merge.
    if (!piece) return { ok: false, reason: 'pieces' };
    children.push(piece);
  }
  const merged: MergedLayer = { id: newLayerId(), kind: 'merged', name: '', visible: true, decal: frame, opacity: 1, children };
  const parentId = top.found.parentId;
  const next = insertLayers(removeLayers(layers, unique), parentId, top.found.index - (order.length - 1), [merged]);
  return {
    ok: true,
    layers: next,
    id: merged.id,
    reset: { part: order.some(({ layer }) => layer.decal.part !== part), mirror: order.some(({ layer }) => layer.decal.mirror !== mirror) },
  };
}

/**
 * A merged object's pieces as layers again, at its place (spec "Separate"): the new layers, their
 * ids (bottom to top), the placed ones (only those can be selected together) and whether the
 * object's repeat was dropped; null when it can't be separated.
 */
export function separateMerged(
  layers: Layer[],
  id: string,
): { layers: Layer[]; ids: string[]; selectable: string[]; droppedRepeat: boolean } | null {
  const found = findLayer(layers, id);
  if (found?.layer.kind !== 'merged') return null;
  const merged = found.layer;
  const separated = separatePieces(merged);
  if (separated.length === 0) return null;
  const next = spliceLayer(layers, id, separated);
  if (next === layers) return null;
  // Unsupported pieces come back as layers too, but only placed layers can be selected together.
  const selectable = separated.filter((l) => isPlacedLayer(l)).map((l) => l.id);
  return { layers: next, ids: separated.map((l) => l.id), selectable, droppedRepeat: merged.repeat !== undefined };
}
