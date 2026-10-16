import { create } from 'zustand';
import type { AtelierProject } from '@/types';
import {
  baseOf,
  checkLayers,
  maskOf,
  newMaskLayer,
  serializeLayers,
  type BaseLayer,
  type Layer,
  type MaskLayer,
  type Stroke,
  type Vec3,
} from './project';

/** Undo steps kept by the editor. */
export const HISTORY_LIMIT = 100;

/** What a Base edit may change. */
export type BasePatch = Partial<Pick<BaseLayer, 'mode' | 'colors' | 'scale' | 'seed'>>;

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
   * any other action ends it too. Two drags with the same key are two steps.
   */
  mergeKey: string | null;
  /** What `beginStroke` replaced, put back when the stroke ends without a point. */
  strokeBefore: { future: Layer[][]; dirty: boolean; revision: number } | null;

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
      const { layers, mergeKey: current } = get();
      const base = baseOf(layers);
      if (!base) return;
      const next = layers.map((l) => (l === base ? { ...base, ...patch } : l));
      if (mergeKey !== undefined && mergeKey === current) {
        // Same gesture: the step pushed at its start already holds the layers before it.
        set((s) => ({ layers: next, dirty: true, revision: s.revision + 1, future: [] }));
        return;
      }
      commit(next, { mergeKey: mergeKey ?? null });
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
