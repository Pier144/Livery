import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Section } from '@/types';

export interface PaletteState {
  open: boolean;
  query: string;
  /** Index of the highlighted result. */
  index: number;
}

export interface UiState {
  screen: Section;
  sidebarOpen: boolean;
  palette: PaletteState;
  /** WT Live reachability; drives the title-bar tag and the sidebar dot. */
  online: boolean;
  /** Files are being dragged over the window. */
  dragActive: boolean;
  go: (screen: Section) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  setPaletteQuery: (query: string) => void;
  setPaletteIndex: (index: number) => void;
  setOnline: (online: boolean) => void;
  setDragActive: (active: boolean) => void;
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
      go: (screen) => set({ screen, palette: closedPalette }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      openPalette: () => set({ palette: { open: true, query: '', index: 0 } }),
      closePalette: () => set({ palette: closedPalette }),
      togglePalette: () => set((s) => ({ palette: s.palette.open ? closedPalette : { open: true, query: '', index: 0 } })),
      setPaletteQuery: (query) => set((s) => ({ palette: { ...s.palette, query, index: 0 } })),
      setPaletteIndex: (index) => set((s) => ({ palette: { ...s.palette, index } })),
      setOnline: (online) => set({ online }),
      setDragActive: (dragActive) => set({ dragActive }),
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
