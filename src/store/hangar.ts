import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Nation, Origin, VehicleType } from '@/types';

export type HangarView = 'grid' | 'list';

/** Toolbar chip filters; `null` means "Any". */
export interface HangarFilters {
  nation: Nation | null;
  type: VehicleType | null;
  origin: Origin | null;
}

export const NO_FILTERS: HangarFilters = { nation: null, type: null, origin: null };

export interface HangarUiState {
  view: HangarView;
  /** Search box text, as typed (matching trims and ignores case). */
  q: string;
  filters: HangarFilters;
  /** Selected skin ids. Always replaced, never mutated, so subscribers see the change. */
  selection: ReadonlySet<string>;
  /** Last skin toggled on its own; Shift+click selects from here. */
  anchor: string | null;
  setView: (view: HangarView) => void;
  setQuery: (q: string) => void;
  setFilter: <K extends keyof HangarFilters>(key: K, value: HangarFilters[K]) => void;
  /** Empties the search box and every chip filter. */
  clearFilters: () => void;
  toggle: (id: string) => void;
  /**
   * Shift+click: selects every skin between the anchor and `id` in `ordered` (the on-screen order).
   * Without a usable anchor it behaves like `toggle`.
   */
  selectRange: (ordered: readonly string[], id: string) => void;
  /** Replaces the selection with `ids` ("Select all" selects what the filters show). */
  selectAll: (ids: readonly string[]) => void;
  clear: () => void;
}

/** Initial UI state (also used by tests to reset the store). */
export function hangarDefaults(): Pick<HangarUiState, 'view' | 'q' | 'filters' | 'selection' | 'anchor'> {
  return { view: 'grid', q: '', filters: NO_FILTERS, selection: new Set(), anchor: null };
}

export const useHangarStore = create<HangarUiState>()(
  persist(
    (set) => ({
      ...hangarDefaults(),
      setView: (view) => set({ view }),
      setQuery: (q) => set({ q }),
      setFilter: (key, value) => set((s) => ({ filters: { ...s.filters, [key]: value } })),
      clearFilters: () => set({ q: '', filters: NO_FILTERS }),
      toggle: (id) =>
        set((s) => {
          const selection = new Set(s.selection);
          if (!selection.delete(id)) selection.add(id);
          return { selection, anchor: id };
        }),
      selectRange: (ordered, id) =>
        set((s) => {
          const from = s.anchor === null ? -1 : ordered.indexOf(s.anchor);
          const to = ordered.indexOf(id);
          if (from < 0 || to < 0) {
            const selection = new Set(s.selection);
            if (!selection.delete(id)) selection.add(id);
            return { selection, anchor: id };
          }
          const selection = new Set(s.selection);
          for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
            const at = ordered[i];
            if (at !== undefined) selection.add(at);
          }
          return { selection };
        }),
      selectAll: (ids) => set({ selection: new Set(ids) }),
      clear: () => set({ selection: new Set(), anchor: null }),
    }),
    {
      name: 'livery.hangar',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Like the sidebar: only the grid/list preference survives a restart.
      partialize: (s) => ({ view: s.view }),
    },
  ),
);
