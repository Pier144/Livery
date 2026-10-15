import { useLayoutEffect, useState, type RefObject } from 'react';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the element matching `selector` sits inside `listRef` (offsets from the list, which must be
 * `relative`), measured after layout and again when the list resizes (fonts, language, a collapsed
 * sidebar). Null until measured or when the element has no size (jsdom): callers then keep their
 * static styling.
 */
export function useActiveBox(listRef: RefObject<HTMLElement>, selector: string, activeKey: string): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const el = list.querySelector<HTMLElement>(selector);
      if (!el || el.offsetWidth === 0) {
        setBox(null);
        return;
      }
      const next = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
      setBox((prev) =>
        prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height ? prev : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef, selector, activeKey]);
  return box;
}

/** The selected tab of a tablist (`useActiveBox` on `[aria-selected="true"]`). */
export function useTabIndicator(listRef: RefObject<HTMLElement>, activeKey: string): Box | null {
  return useActiveBox(listRef, '[role="tab"][aria-selected="true"]', activeKey);
}

/**
 * The 2px amber underline that slides from tab to tab (200 ms, decelerating). The tablist must be
 * `relative`; selected tabs hide their own underline while this one is shown.
 */
export function TabIndicator({ box }: { box: Box | null }) {
  if (!box) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-0 h-0.5 bg-amber motion-safe:transition-[transform,width] motion-safe:duration-200 motion-safe:ease-decel"
      style={{ top: box.top + box.height - 2, width: box.width, transform: `translateX(${box.left}px)` }}
    />
  );
}
