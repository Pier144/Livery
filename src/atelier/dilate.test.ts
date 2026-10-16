import { describe, expect, it } from 'vitest';
import { dilate } from './dilate';

/** A `w × h` slot with a covered square of colour `rgba` from (x0, y0), size `s`. */
function square(w: number, h: number, x0: number, y0: number, s: number, color: [number, number, number, number]) {
  const rgba = new Uint8Array(w * h * 4);
  const covered = new Uint8Array(w * h);
  for (let y = y0; y < y0 + s; y++)
    for (let x = x0; x < x0 + s; x++) {
      rgba.set(color, (y * w + x) * 4);
      covered[y * w + x] = 1;
    }
  return { rgba, covered };
}

/** L1 distance from (x, y) to the square. */
function l1(x: number, y: number, x0: number, y0: number, s: number): number {
  const dx = x < x0 ? x0 - x : x >= x0 + s ? x - (x0 + s - 1) : 0;
  const dy = y < y0 ? y0 - y : y >= y0 + s ? y - (y0 + s - 1) : 0;
  return dx + dy;
}

describe('dilate', () => {
  it('grows coverage by exactly px texels around a square', () => {
    const w = 40;
    const h = 40;
    const { rgba, covered } = square(w, h, 15, 15, 10, [200, 100, 50, 255]);
    dilate(rgba, covered, w, h, 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = l1(x, y, 15, 15, 10);
        expect(covered[y * w + x]).toBe(d <= 4 ? 1 : 0);
        const p = (y * w + x) * 4;
        expect([...rgba.subarray(p, p + 4)]).toEqual(d <= 4 ? [200, 100, 50, 255] : [0, 0, 0, 0]);
      }
    // Along the axes: exactly 4 more on each side.
    expect(covered[20 * w + 10]).toBe(0);
    expect(covered[20 * w + 11]).toBe(1);
    expect(covered[20 * w + 28]).toBe(1);
    expect(covered[20 * w + 29]).toBe(0);
  });

  it('averages the covered neighbours', () => {
    const w = 3;
    const h = 1;
    const rgba = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0, 30, 40, 50, 0]);
    const covered = new Uint8Array([1, 0, 1]);
    dilate(rgba, covered, w, h, 1);
    expect([...rgba.subarray(4, 8)]).toEqual([20, 30, 40, 128]);
    expect([...covered]).toEqual([1, 1, 1]);
  });

  it('stops at the image edges and does nothing with px = 0', () => {
    const { rgba, covered } = square(4, 4, 0, 0, 1, [9, 9, 9, 9]);
    const before = rgba.slice();
    dilate(rgba, covered, 4, 4, 0);
    expect(rgba).toEqual(before);
    dilate(rgba, covered, 4, 4, 10);
    expect(covered.every((c) => c === 1)).toBe(true);
  });
});
