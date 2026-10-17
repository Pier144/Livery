import type { FolderLayer, Layer, MergedLayer, Piece, PlacedLayer, TextLayer, UnsupportedPiece } from './project';
import { isPlacedLayer } from './project';

/**
 * The layer tree of an Atelier project, walked and edited without mutating it. Containers are the
 * top level (`null`), a folder (its id) and a merged object (its id, pieces only); ids are unique
 * across the tree, so one id names one item wherever it sits.
 *
 * Every edit returns a new top-level array that shares what it didn't touch: untouched layers and
 * containers keep their object identity, a container on the edited path gets a new object with a
 * new `children` array, and nothing at all changing returns the input array itself. The helpers
 * don't check kinds (a folder in a folder, a layer among pieces): callers do, and `checkLayers`
 * repairs whatever slips through on load.
 */

/** A container: the top level (`null`), a folder's id or a merged object's id. */
export type ParentId = string | null;
/** Anything the tree holds: a top-level layer, a folder child or a merged object's piece. */
export type TreeItem = Layer | Piece | UnsupportedPiece;

/** Where `findLayer` found an item. */
export interface Found {
  layer: TreeItem;
  parentId: ParentId;
  /** Position in the container's list (bottom to top). */
  index: number;
  /** The folder or merged object holding it; null at the top level. */
  parent: FolderLayer | MergedLayer | null;
}

type Container = FolderLayer | MergedLayer;
type TextPiece = Extract<Piece, { kind: 'text' }>;

function isContainer(item: TreeItem): item is Container {
  return item.kind === 'folder' || item.kind === 'merged';
}

function search(items: readonly TreeItem[], id: string, parent: Container | null): Found | null {
  for (const [index, layer] of items.entries()) {
    if (layer.id === id) return { layer, parentId: parent?.id ?? null, index, parent };
    if (isContainer(layer)) {
      const found = search(layer.children, id, layer);
      if (found) return found;
    }
  }
  return null;
}

/** The item with this id at any depth (folder children and merged pieces included), or null. */
export function findLayer(layers: readonly Layer[], id: string): Found | null {
  return search(layers, id, null);
}

/** The container's list, bottom to top: the layers themselves for `null`, `[]` for an id that isn't a container. */
export function childrenOf(layers: readonly Layer[], parentId: ParentId): readonly TreeItem[] {
  if (parentId === null) return layers;
  const found = findLayer(layers, parentId);
  return found && isContainer(found.layer) ? found.layer.children : [];
}

/**
 * Rebuilds the tree bottom-up: every container's children first, then `edit` on each list (the
 * top level with `null`). `edit` returns its input when it leaves a list alone, which keeps the
 * containers above untouched as well.
 */
function transform(
  items: readonly TreeItem[],
  parentId: ParentId,
  edit: (items: readonly TreeItem[], parentId: ParentId) => readonly TreeItem[],
): readonly TreeItem[] {
  let next: TreeItem[] | null = null;
  for (const [i, item] of items.entries()) {
    if (!isContainer(item)) continue;
    const children = transform(item.children, item.id, edit);
    if (children === item.children) continue;
    next ??= items.slice();
    // Kinds aren't checked here (see the module comment): the container takes the list as given.
    next[i] = { ...item, children } as Container;
  }
  return edit(next ?? items, parentId);
}

function transformLayers(layers: readonly Layer[], edit: (items: readonly TreeItem[], parentId: ParentId) => readonly TreeItem[]): Layer[] {
  // The top level holds layers only as long as callers insert layers there (not checked).
  return transform(layers, null, edit) as Layer[];
}

/** The tree with the item `id` swapped for `next` (same container, same position); unchanged for an unknown id. */
export function replaceLayer(layers: readonly Layer[], id: string, next: TreeItem): Layer[] {
  return updateLayer(layers, id, () => next);
}

/** The tree with the item `id` replaced by `change(item)`; unchanged when it returns the item itself or `id` is unknown. */
export function updateLayer(layers: readonly Layer[], id: string, change: (item: TreeItem) => TreeItem): Layer[] {
  return transformLayers(layers, (items) => {
    const index = items.findIndex((item) => item.id === id);
    const item = items[index];
    if (!item) return items;
    const next = change(item);
    if (next === item) return items;
    const out = items.slice();
    out[index] = next;
    return out;
  });
}

/** The tree without these items: a container goes with its children; removing children leaves their container, even empty. */
export function removeLayers(layers: readonly Layer[], ids: ReadonlySet<string> | readonly string[]): Layer[] {
  const gone: ReadonlySet<string> = ids instanceof Set ? ids : new Set(ids as readonly string[]);
  if (gone.size === 0) return layers as Layer[];
  return transformLayers(layers, (items) => {
    const kept = items.filter((item) => !gone.has(item.id));
    return kept.length === items.length ? items : kept;
  });
}

/**
 * The tree with `items` inserted into the container at `index` (clamped into it). At the top level
 * the Base stays first and the mask last. Kinds aren't checked; unchanged for an unknown container
 * or no items.
 */
export function insertLayers(layers: readonly Layer[], parentId: ParentId, index: number, items: readonly TreeItem[]): Layer[] {
  if (items.length === 0) return layers as Layer[];
  return transformLayers(layers, (list, listId) => {
    if (listId !== parentId) return list;
    let min = 0;
    let max = list.length;
    if (parentId === null) {
      if (list[0]?.kind === 'base') min = 1;
      if (list.length > min && list[list.length - 1]?.kind === 'mask') max = list.length - 1;
    }
    const at = Math.min(Math.max(Number.isFinite(index) ? Math.trunc(index) : max, min), max);
    return [...list.slice(0, at), ...items, ...list.slice(at)];
  });
}

/** Depth-first, bottom to top: every layer, folder children and merged pieces included (folders and merged objects before their children). */
export function allLayers(layers: readonly Layer[]): TreeItem[] {
  const out: TreeItem[] = [];
  const walk = (items: readonly TreeItem[]) => {
    for (const item of items) {
      out.push(item);
      if (isContainer(item)) walk(item.children);
    }
  };
  walk(layers);
  return out;
}

/** Placed layers that have a frame of their own (top level and in folders; not pieces). */
export function framedLayers(layers: readonly Layer[]): PlacedLayer[] {
  const out: PlacedLayer[] = [];
  for (const layer of layers) {
    if (isPlacedLayer(layer)) out.push(layer);
    else if (layer.kind === 'folder') for (const child of layer.children) if (isPlacedLayer(child)) out.push(child);
  }
  return out;
}

/** Every text layer or text piece (for fonts). */
export function textLayers(layers: readonly Layer[]): (TextLayer | TextPiece)[] {
  return allLayers(layers).filter((item): item is TextLayer | TextPiece => item.kind === 'text');
}

/** The found item sits inside a merged object. */
export function isPiece(found: Found): boolean {
  return found.parent?.kind === 'merged';
}
