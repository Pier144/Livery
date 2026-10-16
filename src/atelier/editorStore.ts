import { create } from 'zustand';
import type { AssetRef, AtelierProject, CropRect } from '@/types';
import {
  MAX_DECAL_SIZE,
  MIN_DECAL_SIZE,
  add,
  baseOf,
  checkDecalLayer,
  checkLayers,
  decalRight,
  isDecalLayer,
  maskOf,
  newImageLayer,
  newLayerId,
  newMaskLayer,
  newTextLayer,
  scale,
  serializeLayers,
  sub,
  toDecal,
  type BaseLayer,
  type Decal,
  type DecalLayer,
  type FontRef,
  type ImageLayer,
  type Layer,
  type MaskLayer,
  type Stroke,
  type TextLayer,
  type Vec3,
} from './project';
import { measureTextAspect } from './text';

/** Undo steps kept by the editor. */
export const HISTORY_LIMIT = 100;

/** What a Base edit may change. */
export type BasePatch = Partial<Pick<BaseLayer, 'mode' | 'colors' | 'scale' | 'seed'>>;

/** What `setLayerProps` may change on an image or text layer (fields of the other kind are dropped). */
export type LayerPropsPatch = Partial<Omit<ImageLayer, 'id' | 'kind' | 'decal'> & Omit<TextLayer, 'id' | 'kind' | 'decal'>>;

/** Fields only an image layer has, dropped from a text layer's patch; and the other way round. */
const IMAGE_ONLY_PROPS = ['assetId', 'flipX', 'sourceAssetId', 'sourceOffset'] as const;
const TEXT_ONLY_PROPS = ['text', 'font', 'color', 'outlineColor', 'outlineWidth', 'skew'] as const;

/**
 * A new image or text layer waiting for its placement click (outside `layers`: no history, no
 * autosave). `aspect` is width / height of the picture or of the measured text, for the default size.
 */
export type PendingPlacement =
  | { kind: 'image'; assetId: string; aspect: number; name?: string }
  | { kind: 'text'; text: string; font: FontRef; aspect: number };

/** Where `duplicateLayer` puts the copy: this fraction of the decal's height down and right along the surface. */
export const DUPLICATE_OFFSET = 0.05;

/**
 * The width / height of a text layer as drawn now (its font, or the stand-in while the font
 * loads), or null when it can't be measured. Defaults to `measureTextAspect` (text.ts); tests set their own.
 */
export type TextMeasurer = (layer: TextLayer) => number | null;

let textMeasurer: TextMeasurer | null = measureTextAspect;

/** Sets how text layers are measured (null: text widths are left as they are). */
export function setTextMeasurer(measurer: TextMeasurer | null): void {
  textMeasurer = measurer;
}

/** `layer` with a text decal's width set from the measured aspect (the same object when nothing changes). */
function withTextWidth<T extends DecalLayer>(layer: T): T {
  if (layer.kind !== 'text' || !layer.decal || !textMeasurer) return layer;
  const aspect = textMeasurer(layer);
  if (aspect === null || !Number.isFinite(aspect) || aspect <= 0) return layer;
  const width = Math.min(MAX_DECAL_SIZE, Math.max(MIN_DECAL_SIZE, layer.decal.height * aspect));
  return width === layer.decal.width ? layer : { ...layer, decal: { ...layer.decal, width } };
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
  selectedId: string | null;
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
  /** A new image or text layer waiting for its placement click (see PendingPlacement). */
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
  toggleLayerVisible(id: string): void;
  renameLayer(id: string, name: string): void;
  select(id: string | null): void;
  /** Adds an image or text layer above the selected image/text layer, else just under the mask; selects it. */
  addDecalLayer(layer: DecalLayer): void;
  /** Any layer but the Base; the selection moves to the layer below. */
  deleteLayer(id: string): void;
  /** A copy of an image or text layer right above it, moved a little along the surface; selects it. */
  duplicateLayer(id: string): void;
  /** Image, text and unsupported layers only, kept between the Base and the mask. */
  moveLayer(id: string, toIndex: number): void;
  /** A decal edit; on a layer without a decal, `patch` must be a whole decal. Ignored when the result doesn't check out. */
  setDecal(id: string, patch: Partial<Decal>, mergeKey?: string): void;
  /** Ignored when the result doesn't check out (e.g. an empty asset id); numbers are clamped. */
  setLayerProps(id: string, patch: LayerPropsPatch, mergeKey?: string): void;
  /** Switches an image layer to its cut-out picture, keeping it where it was on the model (one undo step). */
  applyCutout(layerId: string, asset: AssetRef, crop: CropRect, sourceAsset: AssetRef): void;
  /** Re-measures a text layer (its font finished loading): no undo step, saved like any change. */
  refreshTextMetrics(layerId: string): void;
  /** Placement: a new layer waits for its click (replaces any pending one). */
  beginPlacement(pending: PendingPlacement): void;
  /** Escape: drops the pending layer (nothing to undo). */
  cancelPlacement(): void;
  /** The placement click: adds the pending layer with this decal as one undo step and selects it; its id, or null without a pending layer or a valid decal. */
  placePending(decal: Decal): string | null;
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

/** `layers` with the layer `id` replaced by `next`. */
function replaced(layers: readonly Layer[], id: string, next: Layer): Layer[] {
  return layers.map((l) => (l.id === id ? next : l));
}

/** Where a new decal layer goes: above the selected image, text or unsupported layer, else just under the mask. */
function insertIndex(layers: readonly Layer[], selectedId: string | null): number {
  const selected = layers.findIndex((l) => l.id === selectedId);
  const kind = layers[selected]?.kind;
  if (selected >= 0 && kind !== 'base' && kind !== 'mask') return selected + 1;
  const mask = layers.findIndex((l) => l.kind === 'mask');
  return mask >= 0 ? mask : layers.length;
}

/** `layers` with `layer` inserted at `at`. */
function inserted(layers: readonly Layer[], at: number, layer: Layer): Layer[] {
  return [...layers.slice(0, at), layer, ...layers.slice(at)];
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

  const decalLayer = (id: string): DecalLayer | undefined => {
    const layer = get().layers.find((l) => l.id === id);
    return isDecalLayer(layer) ? layer : undefined;
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
      change(
        layers.map((l) => (l === base ? { ...base, ...patch } : l)),
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
      if (!layers.some((l) => l.id === id)) return;
      commit(layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
    },

    renameLayer: (id, name) => {
      const { layers } = get();
      const layer = layers.find((l) => l.id === id);
      if (!layer || layer.name === name) return;
      commit(layers.map((l) => (l.id === id ? { ...l, name } : l)));
    },

    select: (id) => set({ selectedId: id, mergeKey: null }),

    addDecalLayer: (layer) => {
      const { layers, selectedId } = get();
      const added = withTextWidth(layer);
      commit(inserted(layers, insertIndex(layers, selectedId), added), { selectedId: added.id });
    },

    deleteLayer: (id) => {
      const { layers, selectedId } = get();
      const at = layers.findIndex((l) => l.id === id);
      if (at < 0 || layers[at]?.kind === 'base') return;
      commit(
        layers.filter((l) => l.id !== id),
        { selectedId: selectedId === id ? (layers[at - 1]?.id ?? null) : selectedId },
      );
    },

    duplicateLayer: (id) => {
      const { layers } = get();
      const at = layers.findIndex((l) => l.id === id);
      const layer = layers[at];
      if (!isDecalLayer(layer)) return;
      const copy: DecalLayer = { ...structuredClone(layer), id: newLayerId() };
      if (copy.decal) copy.decal = offsetDecal(copy.decal);
      commit(inserted(layers, at + 1, copy), { selectedId: copy.id });
    },

    moveLayer: (id, toIndex) => {
      const { layers } = get();
      const at = layers.findIndex((l) => l.id === id);
      const layer = layers[at];
      if (!layer || layer.kind === 'base' || layer.kind === 'mask' || !Number.isFinite(toIndex)) return;
      const last = layers.length - 1 - (maskOf(layers) ? 1 : 0);
      const target = Math.min(last, Math.max(1, Math.round(toIndex)));
      if (target === at) return;
      commit(inserted(layers.filter((l) => l.id !== id), target, layer));
    },

    setDecal: (id, patch, mergeKey) => {
      const layer = decalLayer(id);
      if (!layer) return;
      const decal = toDecal({ ...(layer.decal ?? {}), ...patch });
      if (!decal) return;
      change(replaced(get().layers, id, withTextWidth({ ...layer, decal })), layerKey(id, mergeKey));
    },

    setLayerProps: (id, patch, mergeKey) => {
      const layer = decalLayer(id);
      if (!layer) return;
      const own: Record<string, unknown> = { ...patch };
      for (const key of layer.kind === 'text' ? IMAGE_ONLY_PROPS : TEXT_ONLY_PROPS) delete own[key];
      const next = checkDecalLayer({ ...layer, ...own, id: layer.id, kind: layer.kind, decal: layer.decal } as DecalLayer);
      if (!next) return;
      change(replaced(get().layers, id, withTextWidth(next)), layerKey(id, mergeKey));
    },

    applyCutout: (layerId, asset, crop, sourceAsset) => {
      const layer = decalLayer(layerId);
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
      commit(replaced(get().layers, layerId, next));
    },

    refreshTextMetrics: (layerId) => {
      const layer = decalLayer(layerId);
      if (layer?.kind !== 'text') return;
      const next = withTextWidth(layer);
      if (next === layer) return;
      // Earlier and later versions of the layer were measured with the same stand-in font: fix them too.
      const fix = (snapshot: Layer[]) => snapshot.map((l) => (l.id === layerId && l.kind === 'text' ? withTextWidth(l) : l));
      set((s) => ({
        layers: replaced(s.layers, layerId, next),
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
      const { pending, layers, selectedId } = get();
      const checked = toDecal(decal);
      if (!pending || !checked) return null;
      const made =
        pending.kind === 'image'
          ? newImageLayer(pending.assetId, checked, pending.name)
          : newTextLayer(pending.text, checked, pending.font);
      const layer = withTextWidth(made);
      commit(inserted(layers, insertIndex(layers, selectedId), layer), { selectedId: layer.id, pending: null });
      return layer.id;
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
        selectedId: previous.some((l) => l.id === s.selectedId) ? s.selectedId : (previous[0]?.id ?? null),
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
        selectedId: next.some((l) => l.id === s.selectedId) ? s.selectedId : (next[0]?.id ?? null),
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
