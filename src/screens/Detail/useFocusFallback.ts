import { useEffect, useRef, type RefObject } from 'react';

/**
 * When `key` changes and the focused control went away with the old view (focus fell back to
 * `<body>`), focus `target` instead, so keyboard and screen-reader users keep their place:
 * Compare ↔ gallery, Try in game states, the install action.
 */
export function useFocusFallback(key: unknown, target: RefObject<HTMLElement>) {
  const previous = useRef(key);
  useEffect(() => {
    if (Object.is(previous.current, key)) return;
    previous.current = key;
    const active = document.activeElement;
    if (!active || active === document.body) target.current?.focus();
  }, [key, target]);
}
