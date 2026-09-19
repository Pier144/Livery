import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Screen } from '@/types';

export interface PaletteState {
  open: boolean;
  query: string;
  /** Index of the highlighted result. */
  index: number;
}

/** Where First run starts and where it returns when done (Settings → Game → Change). */
export interface FirstRunEntry {
  /** `detect` = full onboarding; `choose` = straight to the folder picker (not-found view). */
  step: 'detect' | 'choose';
  /** Screen to open when it finishes; Explore for the onboarding. */
  returnTo: Screen;
}

/** Receives dropped paths instead of the install queue (First run's "or drop it here"). */
export type FolderDropHandler = (paths: string[]) => void;

export interface UiState {
  screen: Screen;
  sidebarOpen: boolean;
  palette: PaletteState;
  /** WT Live reachability; drives the title-bar tag and the sidebar dot. */
  online: boolean;
  /** Files are being dragged over the window. */
  dragActive: boolean;
  /** While set, window drops go here and the overlay asks for the game folder. */
  folderDrop: FolderDropHandler | null;
  /** WT Live skin shown by the Skin detail screen. */
  detailSkinId: string | null;
  firstRun: FirstRunEntry;
  go: (screen: Screen) => void;
  /** Opens the Skin detail for a WT Live skin. */
  openSkin: (skinId: string) => void;
  /** Opens First run at a given step (Settings → Game → Change uses `choose`, returning to Settings). */
  startFirstRun: (entry: FirstRunEntry) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  setPaletteQuery: (query: string) => void;
  setPaletteIndex: (index: number) => void;
  setOnline: (online: boolean) => void;
  setDragActive: (active: boolean) => void;
  setFolderDrop: (handler: FolderDropHandler | null) => void;
  /** Esc: closes the palette (and, from later milestones, menus/dialogs/zoom). */
  dismissTransient: () => void;
}

const closedPalette: PaletteState = { open: false, query: '', index: 0 };

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      screen: 'explore',
      sidebarOpen: true,
      palette: closedPalette,
      online: true,
      dragActive: false,
      folderDrop: null,
      detailSkinId: null,
      firstRun: { step: 'detect', returnTo: 'explore' },
      go: (screen) => set({ screen, palette: closedPalette }),
      openSkin: (detailSkinId) => set({ screen: 'detail', detailSkinId, palette: closedPalette }),
      startFirstRun: (firstRun) => set({ screen: 'firstRun', firstRun, palette: closedPalette }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      openPalette: () => set({ palette: { open: true, query: '', index: 0 } }),
      closePalette: () => set({ palette: closedPalette }),
      togglePalette: () => set((s) => ({ palette: s.palette.open ? closedPalette : { open: true, query: '', index: 0 } })),
      setPaletteQuery: (query) => set((s) => ({ palette: { ...s.palette, query, index: 0 } })),
      setPaletteIndex: (index) => set((s) => ({ palette: { ...s.palette, index } })),
      setOnline: (online) => set({ online }),
      setDragActive: (dragActive) => set({ dragActive }),
      setFolderDrop: (folderDrop) => set({ folderDrop }),
      dismissTransient: () => set({ palette: closedPalette }),
    }),
    {
      name: 'livery.ui',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Only the sidebar preference survives a restart.
      partialize: (s) => ({ sidebarOpen: s.sidebarOpen }),
    },
  ),
);

if (import.meta.env.DEV && typeof window !== 'undefined') {
  // Handy for poking at chrome states from devtools (e.g. `__liveryUi.getState().setOnline(false)`).
  (window as unknown as { __liveryUi: typeof useUi }).__liveryUi = useUi;
}
