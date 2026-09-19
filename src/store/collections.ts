import { create } from 'zustand';
import type { Collection, CollectionsState } from '@/types';

/** UI state of the Collections screen. The collections themselves live in TanStack Query. */
export interface CollectionsUiState {
  /** Collection shown on the right. `null` (or an id that is gone): the active one, else the first. */
  openId: string | null;
  /** Just created: its detail focuses and selects the name field once, then clears this. */
  renameId: string | null;
  open: (id: string) => void;
  /** Opens a collection and asks for its name field to take focus (after "+ New"). */
  startRename: (id: string) => void;
  /** Called by the detail once the name field has focus. */
  renameStarted: () => void;
}

const INITIAL = { openId: null, renameId: null } satisfies Pick<CollectionsUiState, 'openId' | 'renameId'>;

export const useCollectionsUi = create<CollectionsUiState>()((set) => ({
  ...INITIAL,
  open: (openId) => set({ openId }),
  startRename: (id) => set({ openId: id, renameId: id }),
  renameStarted: () => set({ renameId: null }),
}));

/** Back to the initial state (tests). */
export function resetCollectionsUi() {
  useCollectionsUi.setState(INITIAL);
}

/** The collection the detail shows: the one picked, else the active one, else the first. */
export function resolveOpenCollection(state: CollectionsState | undefined, openId: string | null): Collection | undefined {
  const list = state?.collections ?? [];
  const byId = (id: string | null | undefined) => (id ? list.find((c) => c.id === id) : undefined);
  return byId(openId) ?? byId(state?.activeCollectionId) ?? list[0];
}
