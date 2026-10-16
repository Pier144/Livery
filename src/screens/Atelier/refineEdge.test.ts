import { describe, expect, it } from 'vitest';
import { alphaOf, brushWeight, paintDab, restoreSource, setAlpha, strokePoints, unionRect } from './refineEdge';

/** A w×h picture where every pixel is (r, g, b, a). */
function solid(w: number, h: number, [r, g, b, a]: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([r, g, b, a], i * 4);
  return out;
}

describe('refine edge', () => {
  it('reads restore from the cutout source at its offset, else from the picture itself', () => {
    const picture = { rgba: solid(2, 2, [1, 2, 3, 0]), width: 2, height: 2 };
    const source = { rgba: solid(4, 4, [9, 9, 9, 255]), width: 4, height: 4 };
    expect(restoreSource(picture, source, { x: 1, y: 2, w: 2, h: 2 })).toMatchObject({ rgba: source.rgba, x: 1, y: 2, width: 4 });
    // An offset that doesn't fit (or a size that doesn't match) falls back to the picture, copied.
    const own = restoreSource(picture, source, { x: 3, y: 3, w: 2, h: 2 });
    expect(own).toMatchObject({ x: 0, y: 0, width: 2 });
    expect(own.rgba).not.toBe(picture.rgba);
    expect(restoreSource(picture, null, undefined).rgba).toEqual(picture.rgba);
  });

  it('has a hard core and a smooth falloff', () => {
    expect(brushWeight(0, 10, 0.5)).toBe(1);
    expect(brushWeight(5, 10, 0.5)).toBe(1);
    expect(brushWeight(7.5, 10, 0.5)).toBeCloseTo(0.5);
    expect(brushWeight(10, 10, 0.5)).toBe(0);
  });

  it('erases alpha only (RGB kept under it) and restores the source pixels, never lowering alpha', () => {
    const w = 8;
    const rgba = solid(w, w, [200, 100, 50, 255]);
    const source = restoreSource({ rgba: solid(w, w, [10, 20, 30, 128]), width: w, height: w }, null, undefined);
    const dirty = paintDab(rgba, w, w, { x: 4, y: 4, radius: 2, hardness: 1, erase: true }, source);
    expect(dirty).toEqual({ x: 2, y: 2, w: 4, h: 4 });
    const at = (x: number, y: number) => Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
    expect(at(4, 4)).toEqual([200, 100, 50, 0]);
    expect(at(0, 0)).toEqual([200, 100, 50, 255]);
    paintDab(rgba, w, w, { x: 4, y: 4, radius: 2, hardness: 1, erase: false }, source);
    expect(at(4, 4)).toEqual([10, 20, 30, 128]);
    // Where alpha is already above the source's, restore leaves it.
    const full = solid(w, w, [200, 100, 50, 255]);
    paintDab(full, w, w, { x: 4, y: 4, radius: 2, hardness: 1, erase: false }, source);
    expect(Array.from(full.subarray((4 * w + 4) * 4 + 3, (4 * w + 4) * 4 + 4))).toEqual([255]);
    // Off the picture: nothing touched.
    expect(paintDab(rgba, w, w, { x: -10, y: -10, radius: 2, hardness: 1, erase: true }, source)).toBeNull();
  });

  it('fills a fast drag with dabs a quarter radius apart; unions dirty rects; snapshots alpha', () => {
    const points = strokePoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 4);
    expect(points).toHaveLength(10);
    expect(points.at(-1)).toEqual({ x: 10, y: 0 });
    expect(unionRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 3, y: 1, w: 2, h: 4 })).toEqual({ x: 0, y: 0, w: 5, h: 5 });
    expect(unionRect(null, { x: 1, y: 1, w: 1, h: 1 })).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    const rgba = solid(2, 1, [1, 2, 3, 40]);
    const snap = alphaOf(rgba);
    rgba[3] = 0;
    setAlpha(rgba, snap);
    expect(Array.from(rgba)).toEqual([1, 2, 3, 40, 1, 2, 3, 40]);
  });
});
