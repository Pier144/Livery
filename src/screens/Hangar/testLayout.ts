import { vi } from 'vitest';

export interface LayoutOptions {
  /** Height of the scroll area (px). */
  viewport?: number;
  /** Width of every element, so the grid computes its columns (1000 → 4 columns). A function is read on each access. */
  width?: number | (() => number);
  /** Height of every virtual row (elements with `data-index`). */
  row?: number;
}

/**
 * jsdom has no layout, so TanStack Virtual would see a 0px viewport and render nothing. This gives
 * elements sizes: the scroll area `viewport` tall, each measured row `row` tall. Returns a restore.
 */
export function mockLayout({ viewport = 600, width = 1000, row = 200 }: LayoutOptions = {}): () => void {
  const w = typeof width === 'function' ? width : () => width;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.index !== undefined ? row : viewport;
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(w),
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(w),
  ];
  return () => spies.forEach((spy) => spy.mockRestore());
}
