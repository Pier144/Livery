import { create } from 'zustand';

/**
 * UI state of the Atelier screen: which project the editor shows (`null`: the home with the
 * project grid). Projects themselves live in TanStack Query; the open project's layers in the
 * editor store (`src/atelier/editorStore.ts`). Kept while the user visits other screens, so coming
 * back to Atelier lands in the same project.
 */
export interface AtelierUiState {
  openProjectId: string | null;
  open: (id: string) => void;
  close: () => void;
}

const INITIAL = { openProjectId: null } satisfies Pick<AtelierUiState, 'openProjectId'>;

export const useAtelierUi = create<AtelierUiState>()((set) => ({
  ...INITIAL,
  open: (openProjectId) => set({ openProjectId }),
  close: () => set({ openProjectId: null }),
}));

/** Back to the initial state (tests). */
export function resetAtelierUi() {
  useAtelierUi.setState(INITIAL);
}
