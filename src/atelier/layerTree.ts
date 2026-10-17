import type { FolderLayer, Layer, MergedLayer, Piece, PlacedLayer, TextLayer, UnsupportedPiece } from './project';
import { isPlacedLayer } from './project';

/**
 * The layer tree of an Atelier project, walked and edited without mutating it. Containers are the
 * top level (`null`), a folder (its id) and a merged object (its id, pieces only); ids are unique
 * across the tree, so one id names one item wherever it sits.
 *
 * Every edit returns a new top-level array that shares what it didn't touch: untouched layers and
 * containers keep their object identity, a container on the edited path gets a new object with a
 * new `children` array, and nothing at all changing returns the input array itself (so a result
 * must never be mutated). Edits refuse a piece outside a merged object and a layer inside one,
 * returning the input; other kinds aren't checked (a folder in a folder, a Base in a folder):
 * callers do, and `checkLayers` repairs whatever slips through on load.
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

/** Whether `item` may sit in a merged object (`merged`) or in a list of layers: pieces carry a `place`, layers don't. */
function fitsIn(item: TreeItem, merged: boolean): boolean {
  // An unsupported piece's `place` is optional, so an unsupported item fits a merged object either way.
  return merged ? 'place' in item || item.kind === 'unsupported' : !('place' in item);
}

/** `index` truncated and clamped into `list`; at the top level, above the Base and under the mask. NaN means the top. */
function clampIndex(list: readonly TreeItem[], topLevel: boolean, index: number): number {
  let min = 0;
  let max = list.length;
  if (topLevel) {
    if (list[0]?.kind === 'base') min = 1;
    if (list.length > min && list[list.length - 1]?.kind === 'mask') max = list.length - 1;
  }
  const at = Number.isNaN(index) ? max : Math.trunc(index);
  return Math.min(Math.max(at, min), max);
}

function toSet(ids: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return ids instanceof Set ? ids : new Set(ids as readonly string[]);
}

type Edit = (items: readonly TreeItem[], parentId: ParentId, merged: boolean) => readonly TreeItem[];

/**
 * Rebuilds the tree bottom-up: every container's children first, then `edit` on each list (the
 * top level with `null`; `merged` tells a merged object's pieces). `edit` returns its input when
 * it leaves a list alone, which keeps the containers above untouched as well.
 */
function transform(items: readonly TreeItem[], parentId: ParentId, merged: boolean, edit: Edit): readonly TreeItem[] {
  let next: TreeItem[] | null = null;
  for (const [i, item] of items.entries()) {
    if (!isContainer(item)) continue;
    const children = transform(item.children, item.id, item.kind === 'merged', edit);
    if (children === item.children) continue;
    next ??= items.slice();
    // Kinds aren't checked here (see the module comment): the container takes the list as given.
    next[i] = { ...item, children } as Container;
  }
  return edit(next ?? items, parentId, merged);
}

function transformLayers(layers: readonly Layer[], edit: Edit): Layer[] {
  // The top level holds layers only: pieces are refused there by `fitsIn`, other kinds aren't checked.
  return transform(layers, null, false, edit) as Layer[];
}

/**
 * The tree with the item `id` swapped for `next` (same container, same position). The result may be
 * the input array itself (never mutate it): for an unknown id, or when `next` doesn't fit the
 * container (a piece outside a merged object, a layer inside one).
 */
export function replaceLayer(layers: readonly Layer[], id: string, next: TreeItem): Layer[] {
  return updateLayer(layers, id, () => next);
}

/**
 * The tree with the item `id` replaced by `change(item)`. The result may be the input array itself
 * (never mutate it): for an unknown id, when `change` returns the item itself, or when its result
 * doesn't fit the container (as for `replaceLayer`).
 */
export function updateLayer(layers: readonly Layer[], id: string, change: (item: TreeItem) => TreeItem): Layer[] {
  return spliceWith(layers, id, (item) => [change(item)]);
}

/**
 * The tree with the item `id` replaced by `items` in place (same container; none removes it). The
 * result may be the input array itself (never mutate it): for an unknown id, or when one of `items`
 * doesn't fit the container (as for `replaceLayer`).
 */
export function spliceLayer(layers: readonly Layer[], id: string, items: readonly TreeItem[]): Layer[] {
  return spliceWith(layers, id, () => items);
}

function spliceWith(layers: readonly Layer[], id: string, make: (item: TreeItem) => readonly TreeItem[]): Layer[] {
  return transformLayers(layers, (list, _parentId, merged) => {
    const index = list.findIndex((item) => item.id === id);
    const item = list[index];
    if (!item) return list;
    const next = make(item);
    if (next.length === 1 && next[0] === item) return list;
    if (!next.every((n) => fitsIn(n, merged))) return list;
    return [...list.slice(0, index), ...next, ...list.slice(index + 1)];
  });
}

/**
 * The tree without these items: a container goes with its children; removing children leaves their
 * container, even empty. Removing every piece of a merged object leaves an empty (invalid) merged
 * object: callers remove the merged object instead. The result may be the input array itself when
 * nothing matches (never mutate it).
 */
export function removeLayers(layers: readonly Layer[], ids: ReadonlySet<string> | readonly string[]): Layer[] {
  const gone = toSet(ids);
  if (gone.size === 0) return layers as Layer[];
  return transformLayers(layers, (items) => {
    const kept = items.filter((item) => !gone.has(item.id));
    return kept.length === items.length ? items : kept;
  });
}

/**
 * The tree with `items` inserted into the container at `index`, truncated and clamped into it (NaN
 * means the top). At the top level the Base stays first and the mask last. Only layers go to the
 * top level or a folder, only pieces into a merged object: anything else is refused. Other kinds
 * aren't checked (a folder in a folder). The result may be the input array itself (never mutate
 * it): for an unknown container, no items, or a refused item. Typed so pieces need a container id:
 * with `null` or any `ParentId`, only layers are accepted.
 */
export function insertLayers(layers: readonly Layer[], parentId: null, index: number, items: readonly Layer[]): Layer[];
export function insertLayers(layers: readonly Layer[], parentId: string, index: number, items: readonly TreeItem[]): Layer[];
export function insertLayers(layers: readonly Layer[], parentId: ParentId, index: number, items: readonly Layer[]): Layer[];
export function insertLayers(layers: readonly Layer[], parentId: ParentId, index: number, items: readonly TreeItem[]): Layer[] {
  return insertInto(layers, parentId, index, items);
}

function insertInto(layers: readonly Layer[], parentId: ParentId, index: number, items: readonly TreeItem[]): Layer[] {
  if (items.length === 0) return layers as Layer[];
  return transformLayers(layers, (list, listId, merged) => {
    if (listId !== parentId || !items.every((item) => fitsIn(item, merged))) return list;
    const at = clampIndex(list, parentId === null, index);
    return [...list.slice(0, at), ...items, ...list.slice(at)];
  });
}

interface Moving {
  item: TreeItem;
  parentId: ParentId;
  index: number;
}

/** The items named in `wanted` in tree order, skipping those inside another moving container. */
function collectMoving(items: readonly TreeItem[], parentId: ParentId, wanted: ReadonlySet<string>, out: Moving[]): Moving[] {
  for (const [index, item] of items.entries()) {
    if (wanted.has(item.id)) out.push({ item, parentId, index });
    else if (isContainer(item)) collectMoving(item.children, item.id, wanted, out);
  }
  return out;
}

/**
 * The tree with these items moved into the container at `index`, given in the container's terms
 * before the move (corrected for moved items below it). The items keep their tree order; a moving
 * container takes its children. The result may be the input array itself (never mutate it): when
 * nothing matches or nothing would change, for an unknown container, a container moved into itself,
 * or an item that doesn't fit the target (as for `insertLayers`).
 */
export function moveItems(layers: readonly Layer[], ids: ReadonlySet<string> | readonly string[], parentId: ParentId, index: number): Layer[] {
  const same = layers as Layer[];
  const wanted = toSet(ids);
  const moving = collectMoving(layers, null, wanted, []);
  if (moving.length === 0) return same;

  let merged = false;
  if (parentId !== null) {
    const target = findLayer(layers, parentId);
    if (!target || !isContainer(target.layer)) return same;
    merged = target.layer.kind === 'merged';
    // The target can't be a moving item or sit inside one.
    for (let at: Found | null = target; at; at = at.parentId === null ? null : findLayer(layers, at.parentId)) {
      if (wanted.has(at.layer.id)) return same;
    }
  }
  if (!moving.every((m) => fitsIn(m.item, merged))) return same;

  const below = moving.filter((m) => m.parentId === parentId && m.index < index).length;
  const corrected = index - below;
  const removed = removeLayers(layers, new Set(moving.map((m) => m.item.id)));

  // Already in place: every item in the target, side by side, landing where it started.
  const first = moving[0];
  const inPlace =
    first !== undefined &&
    moving.every((m, i) => m.parentId === parentId && m.index === first.index + i) &&
    clampIndex(childrenOf(removed, parentId), parentId === null, corrected) === first.index;
  if (inPlace) return same;

  return insertInto(removed, parentId, corrected, moving.map((m) => m.item));
}

/**
 * `fn` applied to every item of the tree, bottom-up (a container's children before the container,
 * which `fn` receives with its children already mapped). Items `fn` returns unchanged keep their
 * identity; the result may be the input array itself (never mutate it). Kinds aren't checked.
 */
export function mapLayers(layers: readonly Layer[], fn: (item: TreeItem) => TreeItem): Layer[] {
  return mapItems(layers, fn) as Layer[];
}

function mapItems(items: readonly TreeItem[], fn: (item: TreeItem) => TreeItem): readonly TreeItem[] {
  let out: TreeItem[] | null = null;
  for (const [i, item] of items.entries()) {
    let current = item;
    if (isContainer(current)) {
      const children = mapItems(current.children, fn);
      if (children !== current.children) current = { ...current, children } as Container;
    }
    const next = fn(current);
    if (next === item) continue;
    out ??= items.slice();
    out[i] = next;
  }
  return out ?? items;
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

/**
 * Placed layers that have a frame of their own (top level and in folders; not pieces), unplaced
 * ones (`decal: null`) included.
 */
export function framedLayers(layers: readonly Layer[]): PlacedLayer[] {
  const out: PlacedLayer[] = [];
  for (const layer of layers) {
    if (isPlacedLayer(layer)) out.push(layer);
    else if (layer.kind === 'folder') for (const child of layer.children) if (isPlacedLayer(child)) out.push(child);
  }
  return out;
}

/**
 * The placed layer `id` with a frame of its own (top level or in a folder; never a merged object's
 * piece), or null: what the gizmo, the keys, the shared-texel check, the picture dialogs and the
 * store's frame edits act on.
 */
export function framedLayerOf(layers: readonly Layer[], id: string | null): PlacedLayer | null {
  if (id === null) return null;
  const found = findLayer(layers, id);
  if (!found || isPiece(found)) return null;
  const layer = found.layer as Layer;
  return isPlacedLayer(layer) ? layer : null;
}

/** Every text layer or text piece (for fonts). */
export function textLayers(layers: readonly Layer[]): (TextLayer | TextPiece)[] {
  return allLayers(layers).filter((item): item is TextLayer | TextPiece => item.kind === 'text');
}

/** The found item sits inside a merged object. */
export function isPiece(found: Found): boolean {
  return found.parent?.kind === 'merged';
}
