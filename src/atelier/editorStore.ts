import { create } from 'zustand';
import type { AssetRef, AtelierProject, CropRect } from '@/types';
import {
  baseOf,
  isPlacedLayer,
  maskOf,
  newHazardStripe,
  newImageLayer,
  newMaskLayer,
  newShapeLayer,
  newTextLayer,
  type Decal,
  type FontRef,
  type Layer,
  type MaskLayer,
  type Piece,
  type PlacedLayer,
  type ShapeKind,
  type Stroke,
  type Vec3,
} from './project';
import { checkLayers, serializeLayers, toDecal } from './projectCheck';
import { childrenOf, findLayer, framedLayerOf, insertLayers, replaceLayer, updateLayer } from './layerTree';
import {
  createFolderIn,
  deleteItem,
  deleteItems,
  dissolveFolderIn,
  duplicateItem,
  insertTarget,
  mergeItems,
  moveIntoFolder,
  moveItem,
  multiSelectable,
  restoreItem,
  restoreItems,
  selectionIn,
  separateMerged,
  type DeletedEntry,
  type MergeResult,
  type SeparateResult,
} from './editorTree';
import { cutoutOf, patchedBase, remeasured, withProps, withTextWidth, type BasePatch, type LayerPropsPatch } from './layerEdits';

export { DUPLICATE_OFFSET, insertTarget, type DeletedEntry, type MergeResult, type SeparateResult } from './editorTree';
export { refitDecal, setTextMeasurer, type BasePatch, type LayerPropsPatch, type TextMeasurer } from './layerEdits';

/** Undo steps kept by the editor. */
export const HISTORY_LIMIT = 100;

/**
 * A new layer waiting for its placement click (outside `layers`: no history, no autosave).
 * `aspect` is width / height of the picture, of the measured text or of the shape's frame, for the
 * default size. A shape with `hazard` is the hazard stripe preset.
 */
export type PendingPlacement =
  | { kind: 'image'; assetId: string; aspect: number; name?: string }
  | { kind: 'text'; text: string; font: FontRef; aspect: number }
  | { kind: 'shape'; shape: ShapeKind; hazard?: boolean; name?: string; aspect: number };

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
   * when it, or anything inside it, has an id already in the tree.
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
   * is lost). An entry is skipped when it, or anything inside it, has an id already in the tree.
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

/** `layers` with the mask replaced by `change(mask)`; a mask is added (pinned last) when there is none. */
function withMask(layers: Layer[], change: (mask: MaskLayer) => MaskLayer): Layer[] {
  const mask = maskOf(layers);
  if (!mask) return [...layers, change(newMaskLayer())];
  return layers.map((l) => (l === mask ? change(mask) : l));
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
      const next = patchedBase(base, patch);
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
      const edit = deleteItem(layers, id, selectedId);
      if (edit) structural(edit.layers, { selectedId: edit.selectedId });
    },

    duplicateLayer: (id) => {
      const edit = duplicateItem(get().layers, id);
      if (edit) structural(edit.layers, { selectedId: edit.selectedId });
    },

    moveLayer: (id, toIndex) => {
      const next = moveItem(get().layers, id, toIndex);
      if (next) structural(next);
    },

    restoreLayer: (layer, index, parentId = null) => {
      const next = restoreItem(get().layers, layer, index, parentId);
      if (next) structural(next, { selectedId: layer.id });
    },

    setDecal: (id, patch, mergeKey) => {
      const layer = framedLayerOf(get().layers, id);
      if (!layer) return;
      const decal = toDecal({ ...(layer.decal ?? {}), ...patch });
      if (!decal) return;
      change(replaceLayer(get().layers, id, withTextWidth({ ...layer, decal })), layerKey(id, mergeKey));
    },

    setLayerProps: (id, patch, mergeKey) => {
      const found = find(id);
      const next = found && withProps(found, patch);
      if (next) change(replaceLayer(get().layers, id, next), layerKey(id, mergeKey));
    },

    applyCutout: (layerId, asset, crop, sourceAsset) => {
      const next = cutoutOf(framedLayerOf(get().layers, layerId), asset, crop, sourceAsset);
      if (next) commit(replaceLayer(get().layers, layerId, next));
    },

    refreshTextMetrics: (layerId) => {
      // Earlier and later versions of the layer were measured with the same stand-in font: fix them
      // too, whether it was a layer or a piece there (a merge keeps the first copy's id).
      const fix = (snapshot: Layer[]) => remeasured(snapshot, layerId);
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
      const edit = createFolderIn(layers, selectedId, name, ids);
      if (!edit) return null;
      structural(edit.layers, { selectedId: edit.selectedId });
      return edit.selectedId;
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
      const edit = dissolveFolderIn(layers, id, selectedId);
      if (edit) structural(edit.layers, { selectedId: edit.selectedId });
    },

    moveInto: (id, parentId, index) => {
      const next = moveIntoFolder(get().layers, id, parentId, index);
      if (next) structural(next);
    },

    deleteLayers: (ids) => {
      const { layers, selectedId } = get();
      const edit = deleteItems(layers, ids, selectedId);
      if (!edit) return [];
      structural(edit.layers, { selectedId: edit.selectedId });
      return edit.entries;
    },

    restoreLayers: (entries) => {
      const edit = restoreItems(get().layers, entries);
      if (edit) structural(edit.layers, { selectedId: edit.selectedId });
    },

    mergeLayers: (ids) => {
      const merged = mergeItems(get().layers, ids);
      if (!merged.ok) return merged;
      structural(merged.layers, { selectedId: merged.id });
      return { ok: true, id: merged.id, reset: merged.reset };
    },

    separate: (id) => {
      const separated = separateMerged(get().layers, id);
      if (!separated) return { ok: false };
      const { selectable } = separated;
      structural(separated.layers, { selectedId: selectable[selectable.length - 1] ?? null, selectedIds: selectable.length > 1 ? selectable : [] });
      return { ok: true, ids: separated.ids, droppedRepeat: separated.droppedRepeat };
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

