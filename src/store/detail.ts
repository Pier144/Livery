import { create } from 'zustand';
import { useHangar } from '@/queries/hangar';
import { deriveTryState, type DetailTab, type TryState } from '@/screens/Detail/detailModel';
import { useInstalls, type WtInstall } from '@/store/installs';
import { useUi } from '@/store/ui';
import type { HangarSkin } from '@/types';

export type { DetailTab, TryState } from '@/screens/Detail/detailModel';

/**
 * Skin detail UI state (README "State": `detail {skinId, tab, galleryIndex, zoom, compare,
 * compareWith, tryState}`). Server data stays in TanStack Query; `tryState` is derived from the
 * installs store and the hangar (`useDetailTry`), never stored.
 */
export interface DetailState {
  /** WT Live id this state belongs to (the screen resets it on every entry). */
  skinId: string | null;
  tab: DetailTab;
  /**
   * The opening tab is settled: the user picked a tab, or the hangar answered (a skin being tried
   * in game opens on Try in game, so coming back from Explore lands on Keep / Discard).
   */
  tabSettled: boolean;
  galleryIndex: number;
  zoom: boolean;
  compare: boolean;
  /** WT Live id of pane B. */
  compareWith: string | null;
  /** Fresh state for a skin (Gallery, first view, no zoom, no compare). */
  reset: (skinId: string | null) => void;
  setTab: (tab: DetailTab) => void;
  /** Once the hangar is known: opens on Try in game when the skin is installed temporarily. */
  settleTab: (triedInGame: boolean) => void;
  setGalleryIndex: (index: number) => void;
  toggleZoom: () => void;
  /** Compare mode (zoom off) against `withId`, or the skin compared last. */
  openCompare: (withId: string) => void;
  exitCompare: () => void;
  setCompareWith: (id: string) => void;
  /**
   * Escape on the Gallery: leaves zoom first, then compare, one layer per press. Returns whether it
   * closed something (other tabs have no layers).
   */
  escape: () => boolean;
}

const fresh = (skinId: string | null) => ({
  skinId,
  tab: 'gallery' as DetailTab,
  tabSettled: false,
  galleryIndex: 0,
  zoom: false,
  compare: false,
  compareWith: null,
});

export const useDetail = create<DetailState>()((set, get) => ({
  ...fresh(null),
  reset: (skinId) => set(fresh(skinId)),
  setTab: (tab) => set({ tab, tabSettled: true }),
  settleTab: (triedInGame) => {
    if (get().tabSettled) return;
    set(triedInGame ? { tab: 'try', tabSettled: true } : { tabSettled: true });
  },
  setGalleryIndex: (galleryIndex) => set({ galleryIndex }),
  toggleZoom: () => set((s) => ({ zoom: !s.zoom })),
  openCompare: (withId) => set((s) => ({ compare: true, zoom: false, compareWith: s.compareWith ?? withId })),
  exitCompare: () => set({ compare: false }),
  setCompareWith: (compareWith) => set({ compareWith }),
  escape: () => {
    const s = get();
    if (s.tab !== 'gallery') return false;
    if (s.zoom) {
      set({ zoom: false });
      return true;
    }
    if (s.compare) {
      set({ compare: false });
      return true;
    }
    return false;
  },
}));

// Every entry into the Skin detail starts fresh (prototype `openSkin`), before the screen renders.
useUi.subscribe((s, prev) => {
  if (s.screen === 'detail' && (prev.screen !== 'detail' || s.detailSkinId !== prev.detailSkinId)) {
    useDetail.getState().reset(s.detailSkinId);
  }
});

/** Resets the store (tests). */
export function resetDetail() {
  useDetail.setState(fresh(null));
}

export interface DetailTry {
  state: TryState;
  /** The skin in the hangar (temporary installs included), by `sourceId`. */
  hangarSkin: HangarSkin | undefined;
  /** In-flight or failed WT Live install of this skin. */
  track: WtInstall | undefined;
  /** False until `get_hangar` answered. */
  hangarKnown: boolean;
}

/** Try in game state of a WT Live skin, derived from the installs store and the hangar. */
export function useDetailTry(skinId: string): DetailTry {
  const { data: hangar } = useHangar({ includeTemporary: true });
  const track = useInstalls((s) => s.bySkin[skinId]);
  const hangarSkin = hangar?.find((h) => h.sourceId === skinId);
  return { state: deriveTryState(track, hangarSkin), hangarSkin, track, hangarKnown: hangar !== undefined };
}
