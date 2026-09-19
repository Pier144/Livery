import { create } from 'zustand';
import type { Category, Nation, SortOrder, VehicleType } from '@/types';

export type ExploreTab = 'explore' | 'following';

/** Explore filters (README State: `explore {tab, q, nation, type, class, vehicle, category, sort}`); `null` = Any. */
export interface ExploreFilters {
  /** Free text (name, vehicle or author); set from Following's author cards. */
  q: string;
  nation: Nation | null;
  type: VehicleType | null;
  class: string | null;
  /** Vehicle code. */
  vehicle: string | null;
  category: Category | null;
}

export type ExploreFilterKey = keyof ExploreFilters;

export const NO_EXPLORE_FILTERS: ExploreFilters = { q: '', nation: null, type: null, class: null, vehicle: null, category: null };

export interface ExploreState extends ExploreFilters {
  tab: ExploreTab;
  sort: SortOrder;
  setTab: (tab: ExploreTab) => void;
  setQuery: (q: string) => void;
  setNation: (nation: Nation | null) => void;
  setType: (type: VehicleType | null) => void;
  setClass: (klass: string | null) => void;
  setVehicle: (code: string | null) => void;
  setCategory: (category: Category | null) => void;
  setSort: (sort: SortOrder) => void;
  /** Removes one filter (the active-filters line). */
  clear: (key: ExploreFilterKey) => void;
  /** Every filter back to Any; the sort stays. */
  clearAll: () => void;
  /** Explore tab showing exactly this vehicle's skins (palette, Following, Skin detail's vehicle card). */
  applyVehicle: (code: string) => void;
  /** Explore tab searching for this author's name (Following). */
  applyAuthor: (name: string) => void;
}

/** Initial state (also used by tests to reset the store). */
export function exploreDefaults(): Pick<ExploreState, 'tab' | 'sort' | ExploreFilterKey> {
  return { tab: 'explore', sort: 'downloads', ...NO_EXPLORE_FILTERS };
}

/** Blank strings mean "no filter". */
const orNull = (value: string | null) => (value === null || value.trim() === '' ? null : value.trim());

/**
 * Explore UI state. Not persisted: WT Live browsing starts fresh each launch, but the filters
 * survive a trip to the Skin detail and back (the store outlives the screen).
 */
export const useExplore = create<ExploreState>()((set) => ({
  ...exploreDefaults(),
  setTab: (tab) => set({ tab }),
  setQuery: (q) => set({ q }),
  setNation: (nation) => set({ nation }),
  setType: (type) => set({ type }),
  setClass: (klass) => set({ class: orNull(klass) }),
  setVehicle: (code) => set({ vehicle: orNull(code) }),
  setCategory: (category) => set({ category }),
  setSort: (sort) => set({ sort }),
  clear: (key) => set({ [key]: NO_EXPLORE_FILTERS[key] }),
  clearAll: () => set({ ...NO_EXPLORE_FILTERS }),
  // A focused view: the other filters would only narrow (or empty) the vehicle's / author's skins.
  applyVehicle: (code) => set({ ...NO_EXPLORE_FILTERS, tab: 'explore', vehicle: orNull(code) }),
  applyAuthor: (name) => set({ ...NO_EXPLORE_FILTERS, tab: 'explore', q: name.trim() }),
}));
