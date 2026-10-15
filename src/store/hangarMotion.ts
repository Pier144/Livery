import { create } from 'zustand';
import { motionAllowed } from '@/lib/motion';

/** How long a removed card takes to fade out (`animate-card-out`). */
export const CARD_OUT_MS = 160;
/** How long a card that came back (Undo) plays `animate-card-in`. */
const CARD_IN_MS = 600;

/**
 * My Hangar cards that are on their way out (uninstalled or deleted, fading before the folder
 * goes) or just came back (Undo). Its own store, so a card reads only its own flag.
 */
interface HangarMotionState {
  leaving: ReadonlySet<string>;
  arriving: ReadonlySet<string>;
}

export const useHangarMotion = create<HangarMotionState>()(() => ({ leaving: new Set(), arriving: new Set() }));

const without = (set: ReadonlySet<string>, ids: readonly string[]) => {
  const next = new Set(set);
  ids.forEach((id) => next.delete(id));
  return next;
};

/** Starts the fade of these cards; resolves once it has played (at once with motion reduced). */
export function fadeOutSkins(ids: readonly string[]): Promise<void> {
  if (!motionAllowed()) return Promise.resolve();
  useHangarMotion.setState((s) => ({ leaving: new Set([...s.leaving, ...ids]) }));
  return new Promise((resolve) => setTimeout(resolve, CARD_OUT_MS));
}

/** The cards stay (the delete failed), or they're gone for good and the flag can go a moment later. */
export function endFade(ids: readonly string[], { gone }: { gone: boolean }) {
  const clear = () => useHangarMotion.setState((s) => ({ leaving: without(s.leaving, ids) }));
  // Gone: wait for the list to drop them, so a card never flashes back before it disappears.
  if (gone) setTimeout(clear, 1000);
  else clear();
}

/** Skins that came back (Undo): they fade in. */
export function markArriving(ids: readonly string[]) {
  if (ids.length === 0) return;
  useHangarMotion.setState((s) => ({ leaving: without(s.leaving, ids), arriving: motionAllowed() ? new Set([...s.arriving, ...ids]) : s.arriving }));
  setTimeout(() => useHangarMotion.setState((s) => ({ arriving: without(s.arriving, ids) })), CARD_IN_MS);
}

/** Card/row animation class for one skin. */
export function useCardMotion(id: string): string | undefined {
  return useHangarMotion((s) => (s.leaving.has(id) ? 'pointer-events-none motion-safe:animate-card-out' : s.arriving.has(id) ? 'motion-safe:animate-card-in' : undefined));
}
