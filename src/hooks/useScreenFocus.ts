import { useEffect, useRef } from 'react';
import { useUi } from '@/store/ui';

/** The shown screen's `<h1>` (every screen has one; some are `sr-only`). */
function screenHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1');
}

/**
 * Focuses the shown screen's `<h1>`, so screen readers announce the new screen and the next Tab
 * starts from the top of it. Headings are `tabIndex=-1` (not tab stops) with no ring, as in First run.
 */
export function focusScreenHeading(): boolean {
  const heading = screenHeading();
  if (!heading) return false;
  // Every screen heading declares it; this only covers one that doesn't.
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  return document.activeElement === heading;
}

/**
 * Focuses the rendered card of a WT Live skin: an Explore card (`data-skin-id`), a Following card
 * (a `button` with `data-skin-id`) or, with `by: 'sourceId'`, a My Hangar card installed from it
 * (`data-source-id`; its `data-skin-id` is the library id). The card's own button, or its
 * full-card `role=button` hit area, takes focus.
 */
export function focusSkinCard(skinId: string, root: ParentNode = document, by: 'skinId' | 'sourceId' = 'skinId'): boolean {
  const selector = by === 'skinId' ? '[data-skin-id]' : '[data-source-id]';
  const card = Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) => el.dataset[by] === skinId);
  if (!card) return false;
  const target = card.matches('button, [role="button"]') ? card : card.querySelector<HTMLElement>('[role="button"], button');
  if (!target) return false;
  // The browser scrolls it into view (a virtual list may hold it in its overscan rows).
  target.focus();
  return document.activeElement === target;
}

/**
 * Screen-level focus moves, run after the new screen has rendered (the hook lives in App's tree, so
 * its effects run after the screen's own):
 * - `ui.focusHeading()` (section shortcuts, palette navigation) → the screen's `<h1>`;
 * - back from the Skin detail (`ui.leaveDetail()`) → the skin's card when it is rendered, else the
 *   screen's `<h1>`. Explore's virtual grid claims the skin first (it scrolls the card into view);
 * - any other screen change that took the focused control away (a button inside the old screen,
 *   e.g. "Open My Hangar" or First run's last step) → the new screen's `<h1>`, not `<body>`.
 */
export function useScreenFocus() {
  const headingFocus = useUi((s) => s.headingFocus);
  const returnFocusSkin = useUi((s) => s.returnFocusSkin);
  const screen = useUi((s) => s.screen);

  const handled = useRef(headingFocus);
  useEffect(() => {
    if (handled.current === headingFocus) return;
    handled.current = headingFocus;
    focusScreenHeading();
  }, [headingFocus]);

  useEffect(() => {
    if (returnFocusSkin === null) return;
    // A screen may have claimed it already (Explore's grid).
    const id = useUi.getState().takeReturnFocus();
    if (id === null) return;
    const main = document.querySelector('main') ?? document;
    // Only Explore lists WT Live posts by their id; elsewhere cards carry the library id.
    const by = useUi.getState().screen === 'explore' ? 'skinId' : 'sourceId';
    if (!focusSkinCard(id, main, by)) focusScreenHeading();
  }, [returnFocusSkin]);

  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    // Back from a detail: the effect above (or Explore's grid, a render later) moves focus.
    if (returnFocusSkin !== null) return;
    const active = document.activeElement;
    if (!active || active === document.body) focusScreenHeading();
  }, [screen, returnFocusSkin]);
}
