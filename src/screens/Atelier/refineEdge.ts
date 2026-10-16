import type { CropRect } from '@/types';

/**
 * Refine edge (pure, no DOM): an erase / restore brush on a picture's alpha. Restore brings back
 * the original pixels the picture came from: for a cut-out picture, the source picture's pixel
 * under it (the layer's `sourceAssetId`, offset by `sourceOffset`), RGB and alpha; for any other
 * picture, its own pixels as they were when the dialog opened. Erase only lowers alpha (RGB is
 * kept under alpha 0, so a later restore or the bake's premultiplication loses nothing).
 */

/** Where restore reads from: straight-alpha RGBA and the picture's offset inside it. */
export interface RestoreSource {
  rgba: Uint8Array;
  width: number;
  height: number;
  /** The picture's top-left inside the source, in source pixels. */
  x: number;
  y: number;
}

export interface Dab {
  x: number;
  y: number;
  /** Pixels. */
  radius: number;
  /** 0 (soft) to 1 (hard). */
  hardness: number;
  erase: boolean;
}

export interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The source restore reads for a picture `width` × `height`: the cutout's source at its offset
 * when that offset fits inside it, else the picture itself (its own original).
 */
export function restoreSource(
  picture: { rgba: Uint8Array; width: number; height: number },
  source: { rgba: Uint8Array; width: number; height: number } | null,
  offset: CropRect | undefined,
): RestoreSource {
  if (
    source &&
    offset &&
    offset.w === picture.width &&
    offset.h === picture.height &&
    offset.x >= 0 &&
    offset.y >= 0 &&
    offset.x + offset.w <= source.width &&
    offset.y + offset.h <= source.height
  ) {
    return { rgba: source.rgba, width: source.width, height: source.height, x: offset.x, y: offset.y };
  }
  return { rgba: picture.rgba.slice(), width: picture.width, height: picture.height, x: 0, y: 0 };
}

/** The brush's weight at `d` pixels from its centre: 1 inside the hard core, falling smoothly to 0 at the radius. */
export function brushWeight(d: number, radius: number, hardness: number): number {
  if (d >= radius) return 0;
  const core = radius * Math.min(0.99, Math.max(0, hardness));
  if (d <= core) return 1;
  const t = (d - core) / (radius - core);
  return 1 - t * t * (3 - 2 * t);
}

/** One dab on `rgba` (`width` × `height`, edited in place); the rectangle it touched, or null. */
export function paintDab(rgba: Uint8Array, width: number, height: number, dab: Dab, source: RestoreSource): DirtyRect | null {
  const x0 = Math.max(0, Math.floor(dab.x - dab.radius));
  const y0 = Math.max(0, Math.floor(dab.y - dab.radius));
  const x1 = Math.min(width, Math.ceil(dab.x + dab.radius));
  const y1 = Math.min(height, Math.ceil(dab.y + dab.radius));
  if (x1 <= x0 || y1 <= y0) return null;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const w = brushWeight(Math.hypot(x + 0.5 - dab.x, y + 0.5 - dab.y), dab.radius, dab.hardness);
      if (w <= 0) continue;
      const i = (y * width + x) * 4;
      const a = rgba[i + 3]!;
      if (dab.erase) {
        rgba[i + 3] = Math.round(a * (1 - w));
      } else {
        const s = ((y + source.y) * source.width + (x + source.x)) * 4;
        const target = source.rgba[s + 3]!;
        rgba[i] = source.rgba[s]!;
        rgba[i + 1] = source.rgba[s + 1]!;
        rgba[i + 2] = source.rgba[s + 2]!;
        // Restore only raises alpha towards the original (never past it, never down).
        if (target > a) rgba[i + 3] = Math.round(a + (target - a) * w);
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The union of two rectangles (either may be null). */
export function unionRect(a: DirtyRect | null, b: DirtyRect | null): DirtyRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Dabs from `from` to `to` (exclusive of `from`), a quarter radius apart, so a fast drag leaves no gaps. */
export function strokePoints(from: { x: number; y: number }, to: { x: number; y: number }, radius: number): { x: number; y: number }[] {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.ceil(d / Math.max(0.5, radius / 4)));
  return Array.from({ length: n }, (_, i) => ({ x: from.x + ((to.x - from.x) * (i + 1)) / n, y: from.y + ((to.y - from.y) * (i + 1)) / n }));
}

/** The alpha channel of `rgba` (an undo snapshot). */
export function alphaOf(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3]!;
  return out;
}

/** Puts an alpha snapshot back into `rgba` (RGB is left as it is: restore only ever writes the source's own RGB). */
export function setAlpha(rgba: Uint8Array, alpha: Uint8Array): void {
  for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i]!;
}
