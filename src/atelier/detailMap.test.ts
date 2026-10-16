import { describe, expect, it } from 'vitest';
import { boxesForGauss, DETAIL_MAX, DETAIL_MIN, detailMap, detailSigma, gaussianBlur } from './detailMap';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function flat(w: number, h: number, v: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([v, v, v, 255], i * 4);
  return rgba;
}

/** Separable Gaussian, kernel to 4 sigma, edges clamped: the reference the box blur approximates. */
function naiveGaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(4 * sigma);
  const kernel: number[] = [];
  let total = 0;
  for (let k = -r; k <= r; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(v);
    total += v;
  }
  const norm = kernel.map((v) => v / total);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const at = (i: number, max: number) => Math.min(max - 1, Math.max(0, i));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += norm[k + r]! * src[y * w + at(x + k, w)]!;
      tmp[y * w + x] = s;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += norm[k + r]! * tmp[at(y + k, h) * w + x]!;
      out[y * w + x] = s;
    }
  return out;
}

describe('boxesForGauss', () => {
  it('gives odd widths whose variances add up to sigma²', () => {
    // Below sigma ~2 the three integer widths can't get closer than ~20%.
    for (const sigma of [3, 6, 24, 48]) {
      const sizes = boxesForGauss(sigma);
      expect(sizes).toHaveLength(3);
      for (const s of sizes) expect(s % 2).toBe(1);
      const variance = sizes.reduce((acc, s) => acc + (s * s - 1) / 12, 0);
      expect(Math.abs(Math.sqrt(variance) - sigma) / sigma).toBeLessThan(0.1);
    }
  });
});

describe('gaussianBlur', () => {
  // Each box pass re-extends the edge (as PIL does), the reference extends it once: the two differ
  // within ~3 sigma of the border, so the 2% bound is checked inside it, plus an RMS over all texels.
  it('matches a naive Gaussian within 2% on a random 64×64', () => {
    const w = 64;
    const h = 64;
    const next = rng(7);
    const src = new Float32Array(w * h);
    for (let i = 0; i < src.length; i++) src[i] = next() * 255;
    for (const sigma of [3, 6]) {
      const fast = gaussianBlur(src, w, h, sigma);
      const ref = naiveGaussian(src, w, h, sigma);
      const border = Math.ceil(3 * sigma);
      let worst = 0;
      let squares = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const e = Math.abs(fast[i]! - ref[i]!) / ref[i]!;
          squares += e * e;
          if (x >= border && y >= border && x < w - border && y < h - border) worst = Math.max(worst, e);
        }
      expect(worst).toBeLessThan(0.02);
      expect(Math.sqrt(squares / src.length)).toBeLessThan(0.02);
    }
  });

  it('keeps a constant image constant and leaves the source alone', () => {
    const src = new Float32Array(32 * 16).fill(100);
    const out = gaussianBlur(src, 32, 16, 5);
    for (const v of out) expect(v).toBeCloseTo(100, 3);
    expect(src[0]).toBe(100);
  });
});

describe('detailMap', () => {
  it('scales sigma with the template width', () => {
    expect(detailSigma(2048)).toBe(24);
    expect(detailSigma(1024)).toBe(12);
    expect(detailSigma(4096)).toBe(48);
  });

  it('is all ones on a flat image', () => {
    const map = detailMap(flat(128, 64, 140), 128, 64);
    expect(map).toHaveLength(128 * 64);
    for (const v of map) expect(v).toBeCloseTo(1, 5);
  });

  it('darkens a thin dark line and leaves far texels near 1', () => {
    const w = 256;
    const h = 256;
    const rgba = flat(w, h, 160);
    const lineY = 128;
    for (let x = 0; x < w; x++) rgba.set([40, 40, 40, 255], (lineY * w + x) * 4);
    const map = detailMap(rgba, w, h);
    expect(map[lineY * w + 128]!).toBeLessThan(0.8);
    expect(map[lineY * w + 128]!).toBeGreaterThanOrEqual(Math.pow(DETAIL_MIN, 0.95) - 1e-6);
    expect(map[10 * w + 128]!).toBeCloseTo(1, 2);
    expect(map[250 * w + 10]!).toBeCloseTo(1, 2);
  });

  it('stays within the clamped range on noise', () => {
    const w = 96;
    const h = 64;
    const next = rng(3);
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = Math.floor(next() * 256);
    const lo = Math.pow(DETAIL_MIN, 0.95) - 1e-6;
    const hi = Math.pow(DETAIL_MAX, 0.95) + 1e-6;
    for (const v of detailMap(rgba, w, h)) {
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });

  it('rejects a short buffer', () => {
    expect(() => detailMap(new Uint8Array(10), 4, 4)).toThrow();
  });
});
