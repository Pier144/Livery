import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Whether animations may play right now: Settings → Reduce motion first (`data-reduce-motion` on
 * <html>, see useReduceMotion), else the OS preference. False without `matchMedia` (jsdom), so
 * tests never wait for an exit animation.
 */
export function motionAllowed(doc: Document = document): boolean {
  const mode = doc.documentElement.dataset.reduceMotion;
  if (mode === 'true') return false;
  if (mode === 'false') return true;
  const view = doc.defaultView;
  if (!view || typeof view.matchMedia !== 'function') return false;
  return !view.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A short one-off animation on an element (Web Animations API): a pop on Follow, a bump on a
 * count. Nothing happens when motion is reduced or the API is missing. Never changes classes, so
 * React's re-renders can't cut it short.
 */
export function play(el: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions): void {
  if (!el || typeof (el as HTMLElement).animate !== 'function' || !motionAllowed(el.ownerDocument)) return;
  (el as HTMLElement).animate(keyframes, options);
}

/** A little pop: up 6 % and back, with the spring easing. */
export const POP: [Keyframe[], KeyframeAnimationOptions] = [
  [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
  { duration: 240, easing: 'cubic-bezier(.3,1.35,.5,1)' },
];

/**
 * Keeps the last non-null `value` for `ms` after it goes back to null, so its view can play an
 * exit animation (`leaving` is true meanwhile). With motion reduced it goes at once, before paint.
 */
export function useLeaving<T>(value: T | null, ms: number): { value: T | null; leaving: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  if (value !== null && value !== kept) setKept(value);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useLayoutEffect(() => {
    clearTimeout(timer.current);
    if (value !== null || kept === null) return;
    if (!motionAllowed()) {
      setKept(null);
      return;
    }
    timer.current = setTimeout(() => setKept(null), ms);
    return () => clearTimeout(timer.current);
  }, [value, kept, ms]);

  return { value: value ?? kept, leaving: value === null && kept !== null };
}

/**
 * `items` plus the ones just removed, kept in their old place for `ms` with `leaving: true`, so a
 * list (the toast stack) can animate them out. With motion reduced, removed items go at once.
 */
export function useLeavingList<T extends { id: string | number }>(items: readonly T[], ms: number): Array<{ item: T; leaving: boolean }> {
  const [gone, setGone] = useState<ReadonlyArray<{ item: T; index: number }>>([]);
  const prev = useRef(items);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = items;
    if (before === items || !motionAllowed()) return;
    const removed = before.flatMap((item, index) => (items.some((i) => i.id === item.id) ? [] : [{ item, index }]));
    if (removed.length === 0) return;
    setGone((g) => [...g, ...removed]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setGone((g) => g.filter((x) => !removed.includes(x)));
    }, ms);
    timers.current.add(timer);
  }, [items, ms]);

  useLayoutEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const out = items.map((item) => ({ item, leaving: false }));
  for (const { item, index } of [...gone].sort((a, b) => a.index - b.index)) {
    if (!items.some((i) => i.id === item.id)) out.splice(Math.min(index, out.length), 0, { item, leaving: true });
  }
  return out;
}

/**
 * True from the render where `active` turns true after the first one (a state just reached, like
 * "Installed" after a download), so a one-off entrance plays then and not when the view mounts
 * already in that state. Set before paint.
 */
export function useJustEntered(active: boolean): boolean {
  const was = useRef(active);
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    if (active && !was.current) setEntered(true);
    if (!active) setEntered(false);
    was.current = active;
  }, [active]);
  return active && entered;
}
