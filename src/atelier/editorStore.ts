import { create } from 'zustand';
import type { AssetRef, AtelierProject, CropRect } from '@/types';
import {
  MAX_DECAL_SIZE,
  MAX_PIECES,
  MIN_DECAL_SIZE,
  add,
  baseOf,
  checkLayers,
  checkPiece,
  checkPlacedLayer,
  decalRight,
  isPlacedLayer,
  maskOf,
  newFolder,
  newHazardStripe,
  newImageLayer,
  newLayerId,
  newMaskLayer,
  newShapeLayer,
  newTextLayer,
  scale,
  serializeLayers,
  sub,
  toDecal,
  type BaseLayer,
  type Decal,
  type FontRef,
  type ImageLayer,
  type Layer,
  type MaskLayer,
  type MergedLayer,
  type Piece,
  type PieceLayer,
  type PlacedLayer,
  type Repeat,
  type ShapeKind,
  type ShapeLayer,
  type Stroke,
  type TextLayer,
  type UnsupportedLayer,
  type UnsupportedPiece,
  type Vec3,
} from './project';
import {
  allLayers,
  childrenOf,
  findLayer,
  insertLayers,
  isPiece,
  mapLayers,
  moveItems,
  removeLayers,
  replaceLayer,
  spliceLayer,
  updateLayer,
  type Found,
  type ParentId,
  type TreeItem,
} from './layerTree';
import { mergeFrame, pieceDecal, placeOf, repeatDecals, separatePieces, type MergeRefusal } from './merge';
import { measureTextAspect } from './text';

/** Undo steps kept by the editor. */
export const HISTORY_LIMIT = 100;

/** What a Base edit may change. */
export type BasePatch = Partial<Pick<BaseLayer, 'mode' | 'colors' | 'scale' | 'seed' | 'wear' | 'pattern' | 'weights' | 'cellSize' | 'angle' | 'softness'>>;

/**
 * What `setLayerProps` may change on a placed layer or a piece (fields the layer's kind doesn't
 * have are dropped). `repeat: null` removes the repeat.
 */
export type LayerPropsPatch = Partial<
  Omit<ImageLayer, 'id' | 'kind' | 'decal' | 'repeat'> &
    Omit<TextLayer, 'id' | 'kind' | 'decal' | 'repeat'> &
    Omit<ShapeLayer, 'id' | 'kind' | 'decal' | 'repeat'>
> & { repeat?: Repeat | null };

/** The fields `setLayerProps` takes, per kind (everything else in a patch is dropped). */
const COMMON_PROPS = ['name', 'visible', 'opacity', 'wear', 'repeat'] as const;
const PROPS_OF: Record<PlacedLayer['kind'], readonly string[]> = {
  image: [...COMMON_PROPS, 'assetId', 'flipX', 'sourceAssetId', 'sourceOffset'],
  text: [...COMMON_PROPS, 'text', 'font', 'color', 'outlineColor', 'outlineWidth', 'skew'],
  shape: [...COMMON_PROPS, 'shape', 'corner', 'points', 'innerRatio', 'fill', 'outlineColor', 'outlineWidth'],
  merged: ['name', 'opacity', 'repeat'],
};

/**
 * A new layer waiting for its placement click (outside `layers`: no history, no autosave).
 * `aspect` is width / height of the picture, of the measured text or of the shape's frame, for the
 * default size. A shape with `hazard` is the hazard stripe preset.
 */
export type PendingPlacement =
  | { kind: 'image'; assetId: string; aspect: number; name?: string }
  | { kind: 'text'; text: string; font: FontRef; aspect: number }
  | { kind: 'shape'; shape: ShapeKind; hazard?: boolean; name?: string; aspect: number };

/** Where `duplicateLayer` puts the copy: this fraction of the decal's height down and right along the surface. */
export const DUPLICATE_OFFSET = 0.05;

/** What `deleteLayers` removed: the layer or piece as it was, its container and its index there. */
export interface DeletedEntry {
  layer: Layer | Piece;
  parentId: string | null;
  index: number;
}

/** What `mergeLayers` answers. `reset` says whether the shared part or Mirror differ from some layer's own. */
export type MergeResult = { ok: true; id: string; reset: { part: boolean; mirror: boolean } } | { ok: false; reason: MergeRefusal };

/** What `separate` answers: the new layers' ids (bottom to top) and whether the object's repeat was dropped. */
export type SeparateResult = { ok: true; ids: string[]; droppedRepeat: boolean } | { ok: false };

/** What a text measurer reads. */
type MeasuredText = Pick<TextLayer, 'text' | 'font' | 'outlineWidth' | 'skew'>;

/**
 * The width / height of a text layer or piece as drawn now (its font, or the stand-in while the
 * font loads), or null when it can't be measured. Defaults to `measureTextAspect` (text.ts); tests
 * set their own.
 */
export type TextMeasurer = (layer: MeasuredText) => number | null;

let textMeasurer: TextMeasurer | null = measureTextAspect;

/** Sets how text layers are measured (null: text widths are left as they are). */
export function setTextMeasurer(measurer: TextMeasurer | null): void {
  textMeasurer = measurer;
}

/** The measured aspect of a text, or null when there is none worth using. */
function measured(text: MeasuredText): number | null {
  if (!textMeasurer) return null;
  const aspect = textMeasurer(text);
  return aspect === null || !Number.isFinite(aspect) || aspect <= 0 ? null : aspect;
}

/** `layer` with a text decal's width set from the measured aspect (the same object when nothing changes). */
function withTextWidth<T extends PlacedLayer>(layer: T): T {
  if (layer.kind !== 'text' || !layer.decal) return layer;
  const aspect = measured(layer);
  if (aspect === null) return layer;
  const width = Math.min(MAX_DECAL_SIZE, Math.max(MIN_DECAL_SIZE, layer.decal.height * aspect));
  return width === layer.decal.width ? layer : { ...layer, decal: { ...layer.decal, width } };
}

/**
 * A text piece with its place's width set from the measured aspect, its centre and height kept
 * and the frame not refitted (the same object when nothing changes or it isn't a text piece).
 */
function withPieceTextWidth<T extends Piece | UnsupportedPiece>(piece: T, frame: Decal | null): T {
  if (piece.kind !== 'text' || !frame) return piece;
  const aspect = measured(piece);
  if (aspect === null) return piece;
  const metres = Math.min(MAX_DECAL_SIZE, Math.max(MIN_DECAL_SIZE, piece.place.h * frame.height * aspect));
  const w = metres / frame.width;
  return w === piece.place.w ? piece : { ...piece, place: { ...piece.place, w } };
}

/** The decal of a duplicate: moved down and right along the surface by DUPLICATE_OFFSET of its height. */
function offsetDecal(decal: Decal): Decal {
  const step = (DUPLICATE_OFFSET * decal.height) / Math.SQRT2;
  return { ...decal, center: add(decal.center, scale(sub(decalRight(decal), decal.up), step)) };
}

/**
 * The decal refitted after a cutout: the same model units per source pixel (per axis, so a
 * stretched picture stays stretched alike), sized to the crop and moved by the crop centre's
 * offset from the source centre (image y down; mirrored along u when the layer is flipped), so
 * the picture neither stretches nor moves on the model.
 */
export function refitDecal(decal: Decal, crop: CropRect, source: { width: number; height: number }, flipX: boolean): Decal {
  const sx = decal.width / source.width;
  const sy = decal.height / source.height;
  const du = (crop.x + crop.w / 2 - source.width / 2) * sx * (flipX ? -1 : 1);
  const dv = -(crop.y + crop.h / 2 - source.height / 2) * sy;
  const center = add(add(decal.center, scale(decalRight(decal), du)), scale(decal.up, dv));
  return { ...decal, center, width: crop.w * sx, height: crop.h * sy };
}

interface EditorState {
  /** The open project (its `layers` field is stale: `layers` below is the truth). */
  project: AtelierProject | null;
  layers: Layer[];
  /** The active row (the gizmo's and the properties panel's layer); one of `selectedIds` when several are selected. */
  selectedId: string | null;
  /**
   * The multi-selection: placed layers and folders of one container, in the order they were
   * picked (Ctrl) or bottom to top (Shift). Empty or one id means a single selection (`selectedId`).
   */
  selectedIds: string[];
  /** Earlier `layers`, oldest first (at most HISTORY_LIMIT). */
  past: Layer[][];
  future: Layer[][];
  /** Something changed since the last save. */
  dirty: boolean;
  /** Counts every change, so a save that answers after a newer change leaves `dirty` on. */
  revision: number;
  /** A stroke is being drawn (between beginStroke and endStroke). */
  stroking: boolean;
  /**
   * Edits sharing this key make a single undo step (one slider drag, one colour picker session).
   * The gesture ends with `endGesture()`, which callers call on pointer-up / change-commit / blur;
   * any other action ends it too. Two drags with the same key are two steps. Layer edits
   * (`setDecal`, `setLayerProps`) scope the key to the layer.
   */
  mergeKey: string | null;
  /** What `beginStroke` replaced, put back when the stroke ends without a point. */
  strokeBefore: { future: Layer[][]; dirty: boolean; revision: number } | null;
  /** A new layer waiting for its placement click (see PendingPlacement). */
  pending: PendingPlacement | null;

  load(project: AtelierProject): void;
  setBase(patch: BasePatch, mergeKey?: string): void;
  /** Ends the current merged gesture (see `mergeKey`). */
  endGesture(): void;
  addStroke(stroke: Stroke): void;
  beginStroke(stroke: Omit<Stroke, 'points'> & { points?: Vec3[] }): void;
  extendStroke(point: Vec3): void;
  endStroke(): void;
  removeLastStroke(): void;
  clearMask(): void;
  /** Any item of the tree (folders hide their content, pieces hide themselves). */
  toggleLayerVisible(id: string): void;
  /** Any item of the tree. */
  renameLayer(id: string, name: string): void;
  /** Single selection (clears `selectedIds`); not an undo step. */
  select(id: string | null): void;
  /**
   * Ctrl+click: adds `id` to the selection or takes it out. Only placed layers and folders of the
   * active row's container take part: anything else (the Base, the mask, a piece, another
   * container) becomes a single selection.
   */
  toggleSelect(id: string): void;
  /**
   * Shift+click: the placed layers and folders from the active row to `id` in their container
   * (the active row stays the anchor); a single selection when they don't share a container.
   */
  selectRange(id: string): void;
  /** Adds a placed layer where `insertTarget` says and selects it. */
  addDecalLayer(layer: PlacedLayer): void;
  /**
   * Any item but the Base. Deleting the last drawable piece of a merged object deletes the merged
   * object. The selection moves to the item below in the same container, else to the container.
   */
  deleteLayer(id: string): void;
  /**
   * A copy of a placed layer or folder right above it, selected. Every id inside a merged object or
   * folder copy is new; a placed copy is moved a little along the surface (a folder copy's children are).
   */
  duplicateLayer(id: string): void;
  /** Moves a layer or folder within its container (at the top level kept between the Base and the mask); pieces don't move. */
  moveLayer(id: string, toIndex: number): void;
  /**
   * Puts back a deleted layer or piece at `index` of its container (kept between the Base and the
   * mask at the top level; a layer whose folder is gone goes to the top level) as one undo step and
   * selects it: the "Layer deleted" toast's Undo once other edits came after the delete. Ignored
   * when an item with its id is already there.
   */
  restoreLayer(layer: Layer | Piece, index: number, parentId?: string | null): void;
  /**
   * A decal edit on a layer with a frame of its own (top level or folder child; not a piece); on a
   * layer without a decal, `patch` must be a whole decal. Ignored when the result doesn't check out.
   */
  setDecal(id: string, patch: Partial<Decal>, mergeKey?: string): void;
  /**
   * Placed layers and pieces (merged objects: name, opacity and repeat only; pieces: no repeat).
   * Ignored when the result doesn't check out (e.g. an empty asset id); numbers are clamped.
   */
  setLayerProps(id: string, patch: LayerPropsPatch, mergeKey?: string): void;
  /** Switches an image layer (not a piece) to its cut-out picture, keeping it where it was on the model (one undo step). */
  applyCutout(layerId: string, asset: AssetRef, crop: CropRect, sourceAsset: AssetRef): void;
  /** Re-measures a text layer or piece (its font finished loading): no undo step, saved like any change. */
  refreshTextMetrics(layerId: string): void;
  /** Placement: a new layer waits for its click (replaces any pending one). */
  beginPlacement(pending: PendingPlacement): void;
  /** Escape: drops the pending layer (nothing to undo). */
  cancelPlacement(): void;
  /** The placement click: adds the pending layer with this decal as one undo step and selects it; its id, or null without a pending layer or a valid decal. */
  placePending(decal: Decal): string | null;
  /**
   * A folder named `name`, selected; its id, or null when refused. With `ids` (top-level placed
   * layers) it holds them, in their order, at the topmost one's place; without, it goes where
   * `insertTarget` says, but never inside a folder (right above it instead).
   */
  createFolder(name: string, ids?: string[]): string | null;
  /** Opens or closes a folder: saved, but not an undo step (the flag is set in the history too, so undo never flips it). */
  toggleCollapsed(id: string): void;
  /** The folder's children take its place. */
  dissolveFolder(id: string): void;
  /**
   * Moves a layer or folder into a folder (`parentId`) or to the top level (`null`) at `index`,
   * given in the target's terms before the move (`moveItems`). Folders stay at the top level;
   * pieces never move.
   */
  moveInto(id: string, parentId: string | null, index: number): void;
  /** Deletes these items (not the Base) as one undo step; what was removed, in removal order, for `restoreLayers`. */
  deleteLayers(ids: string[]): DeletedEntry[];
  /**
   * Puts back what `deleteLayers` removed, as one undo step: each into its container at its index
   * (a container that is gone: the top level, under the mask; a piece whose merged object is gone
   * is lost). Items whose id is already there are skipped.
   */
  restoreLayers(entries: DeletedEntry[]): void;
  /** Merges placed layers of one container into a merged object at the topmost one's place, selected (spec "Merge"). */
  mergeLayers(ids: string[]): MergeResult;
  /** A merged object's pieces as layers again, at its place, selected (spec "Separate"). */
  separate(id: string): SeparateResult;
  undo(): void;
  redo(): void;
  /** Project settings (outside the undo history): */
  setSlotEnabled(texture: string, on: boolean): void;
  setHighQuality(on: boolean): void;
  setName(name: string): void;
  setInstalledSkinId(id: string): void;
  /** A save of `revision` came back: `dirty` goes off unless something changed since. */
  markSaved(saved: AtelierProject, revision: number): void;
}

const initial = {
  project: null,
  layers: [] as Layer[],
  selectedId: null,
  selectedIds: [] as string[],
  past: [] as Layer[][],
  future: [] as Layer[][],
  dirty: false,
  revision: 0,
  stroking: false,
  mergeKey: null,
  strokeBefore: null,
  pending: null,
};

/** The project as `atelier_project_save` takes it (null when none is open). */
export function currentProject(state: Pick<EditorState, 'project' | 'layers'>): AtelierProject | null {
  return state.project ? { ...state.project, layers: serializeLayers(state.layers) } : null;
}

/** `past` with `layers` pushed, capped at HISTORY_LIMIT. */
function pushed(past: Layer[][], layers: Layer[]): Layer[][] {
  const next = [...past, layers];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
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

/** `layers` with the mask replaced by `change(mask)`; a mask is added (pinned last) when there is none. */
function withMask(layers: Layer[], change: (mask: MaskLayer) => MaskLayer): Layer[] {
  const mask = maskOf(layers);
  if (!mask) return [...layers, change(newMaskLayer())];
  return layers.map((l) => (l === mask ? change(mask) : l));
}

/** The found item when it is a placed layer with a frame of its own (top level or folder child; not a piece). */
function framedOf(found: Found | null): PlacedLayer | null {
  if (!found || isPiece(found)) return null;
  const layer = found.layer as Layer;
  return isPlacedLayer(layer) ? layer : null;
}

/** Whether the found item may be part of a multi-selection: a placed layer or a folder, not a piece. */
function multiSelectable(found: Found | null): found is Found {
  return !!found && !isPiece(found) && (found.layer.kind === 'folder' || isPlacedLayer(found.layer as Layer));
}

/** Gives `item` and everything inside it new ids (in place: call it on a copy). */
function renewIds(item: TreeItem): void {
  item.id = newLayerId();
  if (item.kind === 'folder' || item.kind === 'merged') for (const child of item.children) renewIds(child);
}

/** The merged object that would be left without a drawable piece if the found piece went, or null. */
function emptiedBy(found: Found): MergedLayer | null {
  if (!isPiece(found) || found.parent?.kind !== 'merged') return null;
  const merged = found.parent;
  return merged.children.some((c) => c.id !== found.layer.id && c.kind !== 'unsupported') ? null : merged;
}

/** Who is selected after the item at `index` of `parentId` went: the item below, else the container, else the first layer. */
function selectionAfterRemoval(layers: readonly Layer[], parentId: ParentId, index: number): string | null {
  const below = childrenOf(layers, parentId)[index - 1];
  if (below) return below.id;
  if (parentId !== null && findLayer(layers, parentId)) return parentId;
  return layers[0]?.id ?? null;
}

/** The selection kept by an undo or redo landing on `layers`: the active row if it still exists, else the first layer. */
function selectionIn(layers: readonly Layer[], selectedId: string | null): string | null {
  return selectedId !== null && findLayer(layers, selectedId) ? selectedId : (layers[0]?.id ?? null);
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
    // The first copy keeps the layer's id (as Separate gives it back), the others get new ones.
    return copies.map((box, i) => ({ item: { ...source, id: i === 0 ? layer.id : newLayerId() } as Omit<Piece, 'place'>, box }));
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

export const useAtelierEditor = create<EditorState>()((set, get) => {
  /** A layer change that is one undo step. */
  const commit = (layers: Layer[], extra: Partial<EditorState> = {}) =>
    set((s) => ({
      layers,
      past: pushed(s.past, s.layers),
      future: [],
      dirty: true,
      revision: s.revision + 1,
      mergeKey: null,
      ...extra,
    }));

  /** A structural change (one undo step) that goes back to a single selection. */
  const structural = (layers: Layer[], extra: Partial<EditorState> = {}) => commit(layers, { selectedIds: [], ...extra });

  /** A layer change merged into the current gesture when `mergeKey` is its key, else one undo step. */
  const change = (layers: Layer[], mergeKey?: string) => {
    if (mergeKey !== undefined && mergeKey === get().mergeKey) {
      // Same gesture: the step pushed at its start already holds the layers before it.
      set((s) => ({ layers, dirty: true, revision: s.revision + 1, future: [] }));
      return;
    }
    commit(layers, { mergeKey: mergeKey ?? null });
  };

  /** A merge key scoped to one layer, so the same gesture on two layers makes two steps. */
  const layerKey = (id: string, mergeKey?: string) => (mergeKey === undefined ? undefined : `${id}\u0000${mergeKey}`);

  const find = (id: string) => findLayer(get().layers, id);

  /** Adds `layer` where `insertTarget` says, selected, as one undo step. */
  const insertNew = (layer: PlacedLayer, extra: Partial<EditorState> = {}) => {
    const { layers, selectedId } = get();
    const { parentId, index } = insertTarget(layers, selectedId);
    structural(insertLayers(layers, parentId, index, [layer]), { selectedId: layer.id, ...extra });
  };

  /** Removes the found item (or the merged object it would leave empty); the entry, or null for the Base. */
  const removal = (layers: Layer[], found: Found): { layers: Layer[]; entry: DeletedEntry } | null => {
    if (found.layer.kind === 'base') return null;
    const emptied = emptiedBy(found);
    const target = emptied ? findLayer(layers, emptied.id) : found;
    if (!target) return null;
    const entry: DeletedEntry = { layer: target.layer as Layer | Piece, parentId: target.parentId, index: target.index };
    return { layers: removeLayers(layers, [target.layer.id]), entry };
  };

  /** `layers` with `item` back in `parentId` at `index`, or the top level under the mask when that container can't take it. */
  const restored = (layers: Layer[], item: Layer | Piece, parentId: ParentId, index: number): Layer[] => {
    if (parentId !== null) {
      const container = findLayer(layers, parentId)?.layer;
      const fits = container?.kind === 'merged' ? 'place' in item : container?.kind === 'folder' && item.kind !== 'folder' && !('place' in item);
      if (fits) return insertLayers(layers, parentId, index, [item]);
    }
    // A piece only lives in a merged object.
    if ('place' in item) return layers;
    return insertLayers(layers, null, parentId === null ? index : Number.NaN, [item]);
  };

  /** A project setting change (saved, never undone). */
  const setProject = (change: (p: AtelierProject) => AtelierProject) =>
    set((s) => (s.project ? { project: change(s.project), dirty: true, revision: s.revision + 1 } : {}));

  return {
    ...initial,

    load: (project) => {
      // Structural repairs (a new project's Base, misplaced layers, repeated ids) are saved like any change.
      const { layers, repaired } = checkLayers(project.layers);
      set({ ...initial, project, layers, selectedId: layers[0]?.id ?? null, dirty: repaired, revision: repaired ? 1 : 0 });
    },

    setBase: (patch, mergeKey) => {
      const { layers } = get();
      const base = baseOf(layers);
      if (!base) return;
      const next: BaseLayer = { ...base, ...patch };
      // No wear is no field, as in a loaded project.
      if (!(next.wear !== undefined && next.wear > 0)) delete next.wear;
      else next.wear = Math.min(1, next.wear);
      // Defaults are no field either (organic, equal shares, sharp), and shares follow the colours.
      if (next.pattern === undefined || next.pattern === 'organic') delete next.pattern;
      if (next.weights === undefined || next.weights.length !== next.colors.length) delete next.weights;
      if (!(next.softness !== undefined && next.softness > 0)) delete next.softness;
      else next.softness = Math.min(1, next.softness);
      if (next.cellSize === undefined) delete next.cellSize;
      if (next.angle === undefined) delete next.angle;
      change(
        layers.map((l) => (l === base ? next : l)),
        mergeKey,
      );
    },

    endGesture: () => set({ mergeKey: null }),

    addStroke: (stroke) => commit(withMask(get().layers, (m) => ({ ...m, strokes: [...m.strokes, stroke] }))),

    beginStroke: (stroke) => {
      const { future, dirty, revision } = get();
      const begun: Stroke = { ...stroke, points: stroke.points ?? [] };
      commit(withMask(get().layers, (m) => ({ ...m, strokes: [...m.strokes, begun] })), {
        stroking: true,
        strokeBefore: { future, dirty, revision },
      });
    },

    extendStroke: (point) => {
      if (!get().stroking) return;
      set((s) => ({
        layers: withMask(s.layers, (m) => {
          const last = m.strokes[m.strokes.length - 1];
          if (!last) return m;
          return { ...m, strokes: [...m.strokes.slice(0, -1), { ...last, points: [...last.points, point] }] };
        }),
        dirty: true,
        revision: s.revision + 1,
      }));
    },

    endStroke: () => {
      const { stroking, layers, past, strokeBefore } = get();
      if (!stroking) return;
      const mask = maskOf(layers);
      const last = mask?.strokes[mask.strokes.length - 1];
      if (last && last.points.length === 0) {
        // Nothing was painted (the pointer missed the model): as if the stroke never began (no
        // undo step, redo kept, dirty and revision as they were).
        set({
          layers: past[past.length - 1] ?? layers,
          past: past.slice(0, -1),
          stroking: false,
          strokeBefore: null,
          ...(strokeBefore ?? {}),
        });
        return;
      }
      set({ stroking: false, strokeBefore: null });
    },

    removeLastStroke: () => {
      const mask = maskOf(get().layers);
      if (!mask || mask.strokes.length === 0) return;
      commit(withMask(get().layers, (m) => ({ ...m, strokes: m.strokes.slice(0, -1) })));
    },

    clearMask: () => {
      const mask = maskOf(get().layers);
      if (!mask || mask.strokes.length === 0) return;
      commit(withMask(get().layers, (m) => ({ ...m, strokes: [] })));
    },

    toggleLayerVisible: (id) => {
      const { layers } = get();
      const next = updateLayer(layers, id, (item) => ({ ...item, visible: !item.visible }));
      if (next !== layers) commit(next);
    },

    renameLayer: (id, name) => {
      const { layers } = get();
      const next = updateLayer(layers, id, (item) => (item.name === name ? item : { ...item, name }));
      if (next !== layers) commit(next);
    },

    select: (id) => set({ selectedId: id, selectedIds: [], mergeKey: null }),

    toggleSelect: (id) => {
      const { layers, selectedId, selectedIds } = get();
      const found = findLayer(layers, id);
      const current = selectedIds.length > 0 ? selectedIds : selectedId !== null ? [selectedId] : [];
      const anchor = current[0] === undefined ? null : findLayer(layers, current[0]);
      if (!multiSelectable(found) || !multiSelectable(anchor) || anchor.parentId !== found.parentId) {
        get().select(id);
        return;
      }
      if (current.includes(id)) {
        const rest = current.filter((x) => x !== id);
        const active = selectedId !== null && rest.includes(selectedId) ? selectedId : (rest[rest.length - 1] ?? null);
        set({ selectedId: active, selectedIds: rest.length > 1 ? rest : [], mergeKey: null });
        return;
      }
      set({ selectedId: id, selectedIds: [...current, id], mergeKey: null });
    },

    selectRange: (id) => {
      const { layers, selectedId } = get();
      const found = findLayer(layers, id);
      const anchor = selectedId === null ? null : findLayer(layers, selectedId);
      if (!multiSelectable(found) || !multiSelectable(anchor) || anchor.parentId !== found.parentId) {
        get().select(id);
        return;
      }
      const from = Math.min(anchor.index, found.index);
      const to = Math.max(anchor.index, found.index);
      const range = childrenOf(layers, found.parentId)
        .slice(from, to + 1)
        .filter((item) => item.kind === 'folder' || isPlacedLayer(item as Layer))
        .map((item) => item.id);
      set({ selectedId: anchor.layer.id, selectedIds: range.length > 1 ? range : [], mergeKey: null });
    },

    addDecalLayer: (layer) => insertNew(withTextWidth(layer)),

    deleteLayer: (id) => {
      const { layers, selectedId } = get();
      const found = findLayer(layers, id);
      const removed = found && removal(layers, found);
      if (!removed) return;
      const { entry } = removed;
      const next = removed.layers;
      const keep = selectedId !== null && findLayer(next, selectedId) !== null;
      structural(next, { selectedId: keep ? selectedId : selectionAfterRemoval(next, entry.parentId, entry.index) });
    },

    duplicateLayer: (id) => {
      const { layers } = get();
      const found = findLayer(layers, id);
      if (!found || isPiece(found)) return;
      const layer = found.layer as Layer;
      if (!isPlacedLayer(layer) && layer.kind !== 'folder') return;
      const copy = structuredClone(layer);
      renewIds(copy);
      if (copy.kind === 'folder') {
        for (const child of copy.children) if (isPlacedLayer(child) && child.decal) child.decal = offsetDecal(child.decal);
      } else if (copy.decal) {
        copy.decal = offsetDecal(copy.decal);
      }
      const next = insertLayers(layers, found.parentId, found.index + 1, [copy]);
      if (next !== layers) structural(next, { selectedId: copy.id });
    },

    moveLayer: (id, toIndex) => {
      const { layers } = get();
      const found = findLayer(layers, id);
      if (!found || isPiece(found) || !Number.isFinite(toIndex)) return;
      const layer = found.layer as Layer;
      if (layer.kind === 'base' || layer.kind === 'mask') return;
      const list = childrenOf(layers, found.parentId);
      const top = found.parentId === null;
      const first = top ? 1 : 0;
      const last = list.length - 1 - (top && maskOf(layers) ? 1 : 0);
      const target = Math.min(last, Math.max(first, Math.round(toIndex)));
      if (target === found.index) return;
      structural(insertLayers(removeLayers(layers, [id]), found.parentId, target, [layer]));
    },

    restoreLayer: (layer, index, parentId = null) => {
      const { layers } = get();
      if (layer.kind === 'base' || layer.kind === 'mask' || findLayer(layers, layer.id) || !Number.isFinite(index)) return;
      const next = restored(layers, layer, parentId, Math.round(index));
      if (next !== layers) structural(next, { selectedId: layer.id });
    },

    setDecal: (id, patch, mergeKey) => {
      const layer = framedOf(find(id));
      if (!layer) return;
      const decal = toDecal({ ...(layer.decal ?? {}), ...patch });
      if (!decal) return;
      change(replaceLayer(get().layers, id, withTextWidth({ ...layer, decal })), layerKey(id, mergeKey));
    },

    setLayerProps: (id, patch, mergeKey) => {
      const found = find(id);
      if (!found || found.layer.kind === 'unsupported') return;
      const kind = found.layer.kind;
      if (kind !== 'image' && kind !== 'text' && kind !== 'shape' && kind !== 'merged') return;
      const own: Record<string, unknown> = {};
      for (const key of PROPS_OF[kind]) if (key in patch) own[key] = (patch as Record<string, unknown>)[key];
      if (isPiece(found)) {
        // A piece has no repeat (or frame) of its own: the merged object's apply.
        delete own.repeat;
        const piece = found.layer as Piece;
        const checked = checkPiece({ ...piece, ...own, id: piece.id, kind: piece.kind, place: piece.place } as Piece);
        if (!checked) return;
        const frame = found.parent?.kind === 'merged' ? found.parent.decal : null;
        change(replaceLayer(get().layers, id, withPieceTextWidth(checked, frame)), layerKey(id, mergeKey));
        return;
      }
      const layer = found.layer as PlacedLayer;
      // A placed layer checks out as one of the same kind (or not at all); `repeat: null` is read as no repeat.
      const next = checkPlacedLayer({ ...layer, ...own, id: layer.id, kind: layer.kind, decal: layer.decal } as PlacedLayer);
      if (!next) return;
      change(replaceLayer(get().layers, id, withTextWidth(next)), layerKey(id, mergeKey));
    },

    applyCutout: (layerId, asset, crop, sourceAsset) => {
      const layer = framedOf(find(layerId));
      if (layer?.kind !== 'image' || sourceAsset.width <= 0 || sourceAsset.height <= 0 || crop.w <= 0 || crop.h <= 0) return;
      // A stale result (undo, another cutout or an edit since it started): the layer no longer shows its source.
      if (layer.assetId !== sourceAsset.id) return;
      // A cutout of a cutout: the crop is inside the current picture, which lies at the earlier offset in the
      // original. Without a known offset, the current picture becomes the source.
      const composed = layer.sourceAssetId !== undefined && layer.sourceOffset !== undefined;
      const before = composed ? layer.sourceOffset : undefined;
      const sourceOffset: CropRect = { x: (before?.x ?? 0) + crop.x, y: (before?.y ?? 0) + crop.y, w: crop.w, h: crop.h };
      const refit = layer.decal ? toDecal(refitDecal(layer.decal, crop, sourceAsset, layer.flipX)) : null;
      const next: ImageLayer = {
        ...layer,
        assetId: asset.id,
        sourceAssetId: composed ? layer.sourceAssetId : sourceAsset.id,
        sourceOffset,
        decal: refit ?? layer.decal,
      };
      commit(replaceLayer(get().layers, layerId, next));
    },

    refreshTextMetrics: (layerId) => {
      // Earlier and later versions of the layer were measured with the same stand-in font: fix them
      // too, whether it was a layer or a piece there (a merge keeps the first copy's id).
      const fix = (snapshot: Layer[]) =>
        mapLayers(snapshot, (item) => {
          if (item.id === layerId && item.kind === 'text' && 'decal' in item) return withTextWidth(item);
          if (item.kind !== 'merged' || !item.children.some((c) => c.id === layerId)) return item;
          const children = item.children.map((c) => (c.id === layerId ? withPieceTextWidth(c, item.decal) : c));
          return children.every((c, i) => c === item.children[i]) ? item : { ...item, children };
        });
      const { layers } = get();
      const next = fix(layers);
      if (next === layers) return;
      set((s) => ({
        layers: next,
        past: s.past.map(fix),
        future: s.future.map(fix),
        dirty: true,
        revision: s.revision + 1,
      }));
    },

    beginPlacement: (pending) => set({ pending, mergeKey: null }),

    cancelPlacement: () => {
      if (get().pending) set({ pending: null });
    },

    placePending: (decal) => {
      const { pending } = get();
      const checked = toDecal(decal);
      if (!pending || !checked) return null;
      let made: PlacedLayer;
      if (pending.kind === 'image') made = newImageLayer(pending.assetId, checked, pending.name);
      else if (pending.kind === 'text') made = newTextLayer(pending.text, checked, pending.font);
      else made = pending.hazard ? newHazardStripe(pending.name ?? '', checked) : newShapeLayer(pending.shape, checked, pending.name ?? '');
      const layer = withTextWidth(made);
      insertNew(layer, { pending: null });
      return layer.id;
    },

    createFolder: (name, ids) => {
      const { layers, selectedId } = get();
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
        structural(next, { selectedId: folder.id });
        return folder.id;
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
      structural(insertLayers(layers, parentId, index, [folder]), { selectedId: folder.id });
      return folder.id;
    },

    toggleCollapsed: (id) => {
      const { layers } = get();
      const found = findLayer(layers, id);
      if (found?.layer.kind !== 'folder') return;
      const collapsed = !found.layer.collapsed;
      const apply = (snapshot: Layer[]) =>
        updateLayer(snapshot, id, (item) => (item.kind === 'folder' && item.collapsed !== collapsed ? { ...item, collapsed } : item));
      set((s) => ({
        layers: apply(s.layers),
        past: s.past.map(apply),
        future: s.future.map(apply),
        dirty: true,
        revision: s.revision + 1,
      }));
    },

    dissolveFolder: (id) => {
      const { layers, selectedId } = get();
      const found = findLayer(layers, id);
      if (found?.layer.kind !== 'folder') return;
      const { children } = found.layer;
      const next = spliceLayer(layers, id, children);
      if (next === layers) return;
      const active =
        selectedId !== id ? selectedId : (children[children.length - 1]?.id ?? selectionAfterRemoval(next, found.parentId, found.index));
      structural(next, { selectedId: active });
    },

    moveInto: (id, parentId, index) => {
      const { layers } = get();
      const found = findLayer(layers, id);
      if (!found || isPiece(found) || !Number.isFinite(index)) return;
      const kind = found.layer.kind;
      if (kind === 'base' || kind === 'mask') return;
      if (parentId !== null) {
        // One level of folders, and only folders take layers dragged in.
        if (kind === 'folder' || findLayer(layers, parentId)?.layer.kind !== 'folder') return;
      }
      const next = moveItems(layers, [id], parentId, index);
      if (next !== layers) structural(next);
    },

    deleteLayers: (ids) => {
      const { layers, selectedId } = get();
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
      if (!last) return [];
      const keep = selectedId !== null && findLayer(next, selectedId) !== null;
      structural(next, { selectedId: keep ? selectedId : selectionAfterRemoval(next, last.parentId, last.index) });
      return entries;
    },

    restoreLayers: (entries) => {
      const { layers } = get();
      let next = layers;
      let topmost: string | null = null;
      // In reverse removal order, so each index means what it meant when its item left.
      for (const entry of [...entries].reverse()) {
        const { layer } = entry;
        if (layer.kind === 'base' || layer.kind === 'mask' || findLayer(next, layer.id)) continue;
        const put = restored(next, layer, entry.parentId, entry.index);
        if (put === next) continue;
        next = put;
        topmost = layer.id;
      }
      if (next === layers) return;
      structural(next, { selectedId: topmost });
    },

    mergeLayers: (ids) => {
      const { layers } = get();
      const unique = [...new Set(ids)];
      if (unique.length < 2) return { ok: false, reason: 'count' };
      const founds = unique.map((id) => findLayer(layers, id));
      const first = founds[0];
      if (
        !founds.every((f): f is Found => f !== null && !isPiece(f) && f.layer.kind !== 'folder' && f.parentId === first?.parentId)
      ) {
        return { ok: false, reason: 'container' };
      }
      const placed = founds.map((f) => framedOf(f));
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
        if (piece) children.push(piece);
      }
      const merged: MergedLayer = { id: newLayerId(), kind: 'merged', name: '', visible: true, decal: frame, opacity: 1, children };
      const parentId = top.found.parentId;
      const next = insertLayers(removeLayers(layers, unique), parentId, top.found.index - (order.length - 1), [merged]);
      structural(next, { selectedId: merged.id });
      return {
        ok: true,
        id: merged.id,
        reset: { part: order.some(({ layer }) => layer.decal.part !== part), mirror: order.some(({ layer }) => layer.decal.mirror !== mirror) },
      };
    },

    separate: (id) => {
      const { layers } = get();
      const found = findLayer(layers, id);
      if (found?.layer.kind !== 'merged') return { ok: false };
      const merged = found.layer;
      const separated = separatePieces(merged);
      if (separated.length === 0) return { ok: false };
      const next = spliceLayer(layers, id, separated);
      if (next === layers) return { ok: false };
      const separatedIds = separated.map((l) => l.id);
      structural(next, { selectedId: separatedIds[separatedIds.length - 1] ?? null, selectedIds: separatedIds.length > 1 ? separatedIds : [] });
      return { ok: true, ids: separatedIds, droppedRepeat: merged.repeat !== undefined };
    },

    undo: () => {
      const { past, layers, future, stroking } = get();
      const previous = past[past.length - 1];
      if (!previous || stroking) return;
      set((s) => ({
        layers: previous,
        past: past.slice(0, -1),
        future: [layers, ...future],
        dirty: true,
        revision: s.revision + 1,
        mergeKey: null,
        selectedId: selectionIn(previous, s.selectedId),
        selectedIds: [],
      }));
    },

    redo: () => {
      const { past, layers, future, stroking } = get();
      const [next, ...rest] = future;
      if (!next || stroking) return;
      set((s) => ({
        layers: next,
        past: pushed(past, layers),
        future: rest,
        dirty: true,
        revision: s.revision + 1,
        mergeKey: null,
        selectedId: selectionIn(next, s.selectedId),
        selectedIds: [],
      }));
    },

    setSlotEnabled: (texture, on) =>
      setProject((p) => ({ ...p, slots: p.slots.map((s) => (s.texture === texture ? { ...s, enabled: on } : s)) })),

    setHighQuality: (on) => setProject((p) => ({ ...p, output: { ...p.output, highQuality: on } })),

    setName: (name) => setProject((p) => ({ ...p, name })),

    setInstalledSkinId: (id) => setProject((p) => ({ ...p, installedSkinId: id })),

    markSaved: (saved, revision) =>
      set((s) => {
        if (!s.project || s.project.id !== saved.id) return {};
        return {
          project: {
            ...s.project,
            updatedAt: saved.updatedAt,
            createdAt: saved.createdAt,
            installedSkinId: s.project.installedSkinId ?? saved.installedSkinId,
          },
          dirty: s.revision === revision ? false : s.dirty,
        };
      }),
  };
});

/** Back to no open project. Tests call it through `resetStores()`. */
export function resetAtelierEditor(): void {
  useAtelierEditor.setState({ ...initial });
}

