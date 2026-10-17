import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { normalizeZoom, stepZoom, ZOOM_DEFAULT } from '@/lib/zoom';
import type { Screen, Section } from '@/types';

/** Open sidebar width: the `w-sidebar` token by default, dragged between min and max. */
export const SIDEBAR_DEFAULT = 216;
export const SIDEBAR_MIN = 184;
export const SIDEBAR_MAX = 360;

/** A width back inside the sidebar's range (whole pixels); anything that isn't a number is the default. */
export function clampSidebarWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

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
  /** Width of the open sidebar in CSS pixels (dragged by its edge; the rail stays 56px). */
  sidebarWidth: number;
  /** Interface size, one of `ZOOM_STEPS` (1 = 100 %). */
  zoom: number;
  palette: PaletteState;
  /** WT Live reachability; drives the title-bar tag and the sidebar dot. */
  online: boolean;
  /** Files are being dragged over the window. */
  dragActive: boolean;
  /** While set, window drops go here and the overlay asks for the game folder. */
  folderDrop: FolderDropHandler | null;
  /** WT Live skin shown by the Skin detail screen. */
  detailSkinId: string | null;
  /** Section the Skin detail's back button returns to: where the detail was opened from. */
  detailReturnTo: Section;
  /**
   * WT Live skin whose card takes focus when the screen the Skin detail went back to renders
   * (`leaveDetail`). Whoever moves focus clears it with `takeReturnFocus`; any `go` drops it.
   */
  returnFocusSkin: string | null;
  /**
   * Bumped to ask for the current screen's `<h1>` to take focus once it has rendered (section
   * shortcuts, palette navigation), so keyboard and screen-reader users land on the new screen.
   */
  headingFocus: number;
  firstRun: FirstRunEntry;
  go: (screen: Screen) => void;
  /** Opens the Skin detail for a WT Live skin and remembers where to go back to. */
  openSkin: (skinId: string) => void;
  /** The Skin detail's back button: back to `detailReturnTo`, with focus returning to the skin's card. */
  leaveDetail: () => void;
  /** Reads and clears `returnFocusSkin` (the caller then moves focus). */
  takeReturnFocus: () => string | null;
  /** See `headingFocus`. */
  focusHeading: () => void;
  /** Opens First run at a given step (Settings → Game → Change uses `choose`, returning to Settings). */
  startFirstRun: (entry: FirstRunEntry) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setZoom: (zoom: number) => void;
  /** Ctrl + / Ctrl −: one step up or down. */
  stepZoom: (dir: 1 | -1) => void;
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

/**
 * Where the Skin detail's back button leads when a detail opens while `screen` is shown: that
 * section; from another detail (palette), the section the first one came from; from First run
 * (palette), Explore, as leaving First run through the palette does.
 */
export function detailReturnFor(screen: Screen, current: Section): Section {
  if (screen === 'detail') return current;
  if (screen === 'firstRun') return 'explore';
  return screen;
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      screen: 'explore',
      sidebarOpen: true,
      sidebarWidth: SIDEBAR_DEFAULT,
      zoom: ZOOM_DEFAULT,
      palette: closedPalette,
      online: true,
      dragActive: false,
      folderDrop: null,
      detailSkinId: null,
      detailReturnTo: 'explore',
      returnFocusSkin: null,
      headingFocus: 0,
      firstRun: { step: 'detect', returnTo: 'explore' },
      go: (screen) => set({ screen, palette: closedPalette, returnFocusSkin: null }),
      openSkin: (detailSkinId) =>
        set((s) => ({
          screen: 'detail',
          detailSkinId,
          detailReturnTo: detailReturnFor(s.screen, s.detailReturnTo),
          palette: closedPalette,
          returnFocusSkin: null,
        })),
      leaveDetail: () =>
        set((s) => ({
          screen: s.detailReturnTo,
          palette: closedPalette,
          returnFocusSkin: s.detailSkinId,
          // No skin to return to ("no skin" state): the screen's heading takes focus instead.
          headingFocus: s.detailSkinId === null ? s.headingFocus + 1 : s.headingFocus,
        })),
      takeReturnFocus: () => {
        const id = get().returnFocusSkin;
        if (id !== null) set({ returnFocusSkin: null });
        return id;
      },
      focusHeading: () => set((s) => ({ headingFocus: s.headingFocus + 1 })),
      startFirstRun: (firstRun) => set({ screen: 'firstRun', firstRun, palette: closedPalette }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      setZoom: (zoom) => set({ zoom: normalizeZoom(zoom) }),
      stepZoom: (dir) => set((s) => ({ zoom: stepZoom(s.zoom, dir) })),
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
      // Only the sidebar (open, width) and the interface size survive a restart.
      partialize: (s) => ({ sidebarOpen: s.sidebarOpen, sidebarWidth: s.sidebarWidth, zoom: s.zoom }),
      // Stored values are checked: a hand-edited or older entry can't break the layout.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<UiState, 'sidebarOpen' | 'sidebarWidth' | 'zoom'>>;
        return {
          ...current,
          sidebarOpen: typeof p.sidebarOpen === 'boolean' ? p.sidebarOpen : current.sidebarOpen,
          sidebarWidth: clampSidebarWidth(p.sidebarWidth),
          zoom: normalizeZoom(p.zoom),
        };
      },
    },
  ),
);

if (import.meta.env.DEV && typeof window !== 'undefined') {
  // Handy for poking at chrome states from devtools (e.g. `__liveryUi.getState().setOnline(false)`).
  (window as unknown as { __liveryUi: typeof useUi }).__liveryUi = useUi;
}
