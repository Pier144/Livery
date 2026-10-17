import { describe, expect, it } from 'vitest';
import { newBaseLayer, type BaseLayer, type Vec3 } from '../project';
import {
  CAMO_QUANTILES,
  CELL_BASE,
  ORGANIC_SOFT_MAX,
  PATTERN_INDEX,
  SPLINTER_CELL,
  STRIPE_BAND,
  camoParams,
  camoWeights,
  cumulativeBounds,
  digitalCell,
  hexCell,
  noiseThresholds,
  planeOf,
  splinterSite,
  triangleCell,
  type CamoParams,
} from './camo';
import { CAMO_CELL, CAMO_THRESHOLDS, camoIndex, camoNoise } from './shaders';

const rng = (seed = 1) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const camo = (over: Partial<BaseLayer> = {}): BaseLayer => ({ ...newBaseLayer(), mode: 'camo', colors: ['#ff8000', '#000000', '#ffffff'], ...over });
const sum = (w: readonly number[]) => w.reduce((a, b) => a + b, 0);
const argmax = (w: readonly number[]) => w.indexOf(Math.max(...w));

/** Shares of each colour over `n` random points on faces of a 20 m box (normals ±X, ±Y, ±Z). */
function shares(prm: CamoParams, n = 20000, seed = 3): number[] {
  const next = rng(seed);
  const out = [0, 0, 0, 0];
  const normals: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [next() * 20 - 10, next() * 20 - 10, next() * 20 - 10];
    out[argmax(camoWeights(p, normals[i % 4]!, prm))]! += 1 / n;
  }
  return out;
}

describe('camo thresholds and shares', () => {
  it('CAMO_QUANTILES is increasing from 0 to 1 and matches sampled noise', () => {
    expect(CAMO_QUANTILES).toHaveLength(65);
    expect(CAMO_QUANTILES[0]).toBe(0);
    expect(CAMO_QUANTILES[64]).toBe(1);
    for (let i = 1; i < 65; i++) expect(CAMO_QUANTILES[i]!).toBeGreaterThan(CAMO_QUANTILES[i - 1]!);
    const next = rng(11);
    const values = Array.from({ length: 60000 }, (_, i) => camoNoise(next() * 300, next() * 300, next() * 300, 2000 + (i % 16))).sort((a, b) => a - b);
    for (const i of [4, 16, 32, 48, 60]) expect(Math.abs(values[Math.floor((i / 64) * values.length)]! - CAMO_QUANTILES[i]!)).toBeLessThan(0.005);
  });

  it('without shares the noise thresholds are today’s table, with shares they follow them', () => {
    for (const count of [2, 3, 4]) expect(noiseThresholds(undefined, count)).toEqual(CAMO_THRESHOLDS[count]);
    const t = noiseThresholds([0.5, 0.3, 0.2], 3);
    const next = rng(5);
    const got = [0, 0, 0];
    const n = 40000;
    for (let i = 0; i < n; i++) got[camoIndex(camoNoise(next() * 300, next() * 300, next() * 300, 77 + (i % 8)), t)]! += 1 / n;
    [0.5, 0.3, 0.2].forEach((w, i) => expect(Math.abs(got[i]! - w)).toBeLessThan(0.02));
    expect(t[2]).toBe(2);
  });

  it('cumulative bounds: k/count without shares, else the running sum; unused 2', () => {
    expect(cumulativeBounds(undefined, 4)).toEqual([0.25, 0.5, 0.75]);
    expect(cumulativeBounds([0.5, 0.3, 0.2], 3)[0]).toBeCloseTo(0.5);
    expect(cumulativeBounds([0.5, 0.3, 0.2], 3)[1]).toBeCloseTo(0.8);
    expect(cumulativeBounds([0.5, 0.3, 0.2], 3)[2]).toBe(2);
    expect(cumulativeBounds([0.5, 0.5], 3)).toEqual([1 / 3, 2 / 3, 2]);
  });
});

describe('camoParams', () => {
  it('an older camo Base gives today’s numbers, organic and sharp', () => {
    const p = camoParams(camo({ scale: 2, seed: 42 }));
    expect(p).toMatchObject({ pattern: 0, count: 3, seed: 42, soft: 0 });
    expect(p.thresholds).toEqual(CAMO_THRESHOLDS[3]);
    expect(p.frequency).toBeCloseTo(1 / (CAMO_CELL * 2));
  });

  it('solid and unknown styles are organic; each style gets its cell', () => {
    expect(camoParams({ ...newBaseLayer(), pattern: 'hex' }).pattern).toBe(0);
    expect(camoParams({ ...newBaseLayer(), pattern: 'hex' }).count).toBe(1);
    expect(camoParams(camo({ pattern: 'sticker-camo' })).pattern).toBe(0);
    expect(camoParams(camo({ pattern: 'digital', cellSize: 2 })).cell).toBeCloseTo(CELL_BASE.digital * 2);
    expect(camoParams(camo({ pattern: 'hex' })).cell).toBeCloseTo(CELL_BASE.hex);
    expect(camoParams(camo({ pattern: 'triangles' })).cell).toBeCloseTo(CELL_BASE.triangles);
    expect(camoParams(camo({ pattern: 'splinter', scale: 2 })).cell).toBeCloseTo(SPLINTER_CELL * 2);
    expect(camoParams(camo({ pattern: 'stripes' })).cell).toBeCloseTo(3 * STRIPE_BAND);
    expect(camoParams(camo({ pattern: 'splinter', weights: [0.5, 0.3, 0.2] })).bounds[1]).toBeCloseTo(0.8);
  });

  it('softness widths stay inside a cell, band or threshold gap', () => {
    expect(camoParams(camo({ softness: 1 })).soft).toBeLessThanOrEqual(ORGANIC_SOFT_MAX);
    const tight = camoParams(camo({ softness: 1, weights: [0.45, 0.05, 0.5] }));
    expect(tight.soft).toBeLessThanOrEqual((tight.thresholds[1] - tight.thresholds[0]) / 2 + 1e-12);
    expect(camoParams(camo({ pattern: 'digital', softness: 1 })).soft).toBeCloseTo(CELL_BASE.digital / 2);
    expect(camoParams(camo({ pattern: 'triangles', softness: 1 })).soft).toBeCloseTo((CELL_BASE.triangles * Math.sqrt(3)) / 6);
    const st = camoParams(camo({ pattern: 'stripes', softness: 1, weights: [0.05, 0.45, 0.5] }));
    expect(st.soft).toBeCloseTo((0.05 * st.cell) / 2);
  });

  it('stripe angle: 0° gives a band normal along X', () => {
    const p = camoParams(camo({ pattern: 'stripes', angle: 0 }));
    expect(p.stripeN[0]).toBeCloseTo(1);
    expect(p.stripeB[1]).toBeCloseTo(1);
  });
});

describe('grid cells', () => {
  it('digital: centre and the distances to the 8 cells around', () => {
    const c = digitalCell(0.03, 0.07, 0.1);
    expect(c.c[0]).toBeCloseTo(0.05);
    expect(c.c[1]).toBeCloseTo(0.05);
    const h = Math.hypot;
    expect(c.neighbours.map((e) => +e.d.toFixed(6))).toEqual([h(0.03, 0.07), 0.07, h(0.07, 0.07), 0.03, 0.07, h(0.03, 0.03), 0.03, h(0.07, 0.03)].map((v) => +v.toFixed(6)));
  });

  it('hex: a centre is (√3/2)·s from all six edges and maps to itself; neighbours √3·s away', () => {
    const s = 0.12;
    const c = hexCell(0.3, -0.2, s);
    const again = hexCell(c.c[0], c.c[1], s);
    expect(again.c[0]).toBeCloseTo(c.c[0]);
    expect(again.c[1]).toBeCloseTo(c.c[1]);
    for (const e of again.neighbours) {
      expect(e.d).toBeCloseTo((Math.sqrt(3) / 2) * s);
      expect(Math.hypot(e.c[0] - c.c[0], e.c[1] - c.c[1])).toBeCloseTo(Math.sqrt(3) * s);
      // The neighbour's own cell is where we said.
      const n = hexCell(e.c[0], e.c[1], s);
      expect(n.c[0]).toBeCloseTo(e.c[0]);
      expect(n.c[1]).toBeCloseTo(e.c[1]);
    }
    // Every point lies inside its hexagon: no negative edge distance.
    const next = rng(9);
    for (let i = 0; i < 500; i++) for (const e of hexCell(next() * 4 - 2, next() * 4 - 2, s).neighbours) expect(e.d).toBeGreaterThanOrEqual(-1e-9);
  });

  it('triangles: 3 edge and 9 corner neighbours, all real cells, distances exact at the centroid', () => {
    const s = 0.2;
    const h = (s * Math.sqrt(3)) / 2;
    const next = rng(4);
    for (let i = 0; i < 300; i++) {
      const cell = triangleCell(next() * 4 - 2, next() * 4 - 2, s);
      expect(cell.neighbours).toHaveLength(12);
      for (const e of cell.neighbours) expect(e.d).toBeGreaterThanOrEqual(0);
      const centre = triangleCell(cell.c[0], cell.c[1], s);
      expect(centre.c[0]).toBeCloseTo(cell.c[0]);
      for (const e of centre.neighbours.slice(0, 3)) expect(e.d).toBeCloseTo(h / 3);
      // Corner neighbours: none closer than an edge, the middle one of each corner exactly at the corner (R = s/√3).
      for (const e of centre.neighbours.slice(3)) expect(e.d).toBeGreaterThan(h / 3);
      expect(centre.neighbours[4]!.d).toBeCloseTo(s / Math.sqrt(3));
      const keys = new Set<string>();
      for (const e of cell.neighbours) {
        const n = triangleCell(e.c[0], e.c[1], s);
        expect(n.c[0]).toBeCloseTo(e.c[0]);
        expect(n.c[1]).toBeCloseTo(e.c[1]);
        keys.add(`${e.c[0].toFixed(5)},${e.c[1].toFixed(5)}`);
      }
      expect(keys.size).toBe(12);
    }
  });

  it('grid softness is continuous everywhere (also across corners)', () => {
    for (const pattern of ['digital', 'hex', 'triangles'] as const) {
      const prm = camoParams(camo({ pattern, softness: 1, colors: ['#000000', '#111111', '#222222', '#333333'] }));
      const next = rng(17);
      let maxJump = 0;
      for (let i = 0; i < 3000; i++) {
        const x = next() * 3;
        const y = next() * 3;
        const a = camoWeights([x, y, 0], [0, 0, 1], prm);
        const b = camoWeights([x + 1e-6, y + 1e-6, 0], [0, 0, 1], prm);
        maxJump = Math.max(maxJump, ...a.map((v, k) => Math.abs(v - b[k]!)));
      }
      expect(maxJump, pattern).toBeLessThan(1e-3);
    }
  });

  it('planes: dominant axis, ties X then Y, zero normal is +Y', () => {
    expect(planeOf([0.9, 0.1, 0.2])).toMatchObject({ a: 0, u: 2, v: 1 });
    expect(planeOf([0.1, -2, 0.2])).toMatchObject({ a: 1, u: 0, v: 2 });
    expect(planeOf([0.1, 0.1, -0.9])).toMatchObject({ a: 2, u: 0, v: 1 });
    expect(planeOf([1, 1, 1]).a).toBe(0);
    expect(planeOf([0, 0, 0])).toMatchObject({ a: 1, n: [0, 1, 0] });
  });
});

describe('camoWeights', () => {
  const styles = ['organic', 'digital', 'hex', 'splinter', 'triangles', 'stripes'] as const;

  it('weights sum to 1 and are one-hot when sharp, for every style', () => {
    const next = rng(21);
    for (const pattern of styles)
      for (const softness of [0, 0.6]) {
        const prm = camoParams(camo({ pattern, softness, colors: ['#000000', '#111111', '#222222', '#333333'] }));
        for (let i = 0; i < 200; i++) {
          const w = camoWeights([next() * 6 - 3, next() * 3, next() * 4 - 2], [next() - 0.5, next() - 0.5, next() - 0.5], prm);
          expect(sum(w)).toBeCloseTo(1, 9);
          for (const v of w) expect(v).toBeGreaterThanOrEqual(0);
          if (softness === 0) expect(w.filter((v) => v === 1)).toHaveLength(1);
        }
      }
  });

  it('organic, sharp: exactly today’s colour', () => {
    const base = camo({ scale: 1.3, seed: 7 });
    const prm = camoParams(base);
    const next = rng(8);
    for (let i = 0; i < 300; i++) {
      const p: Vec3 = [next() * 8, next() * 8, next() * 8];
      const f = prm.frequency;
      expect(argmax(camoWeights(p, [0, 0, 1], prm))).toBe(camoIndex(camoNoise(p[0] * f, p[1] * f, p[2] * f, 7), CAMO_THRESHOLDS[3]!));
    }
  });

  it('shares follow the weights in every style', () => {
    for (const pattern of styles) {
      const prm = camoParams(camo({ pattern, weights: [0.5, 0.3, 0.2], scale: 0.5 }));
      const got = shares(prm, pattern === 'splinter' ? 8000 : 20000);
      [0.5, 0.3, 0.2].forEach((w, i) => expect(Math.abs(got[i]! - w), `${pattern} colour ${i}`).toBeLessThan(0.05));
    }
  });

  it('grid styles: one colour per cell on a flat face, also off the axes', () => {
    for (const pattern of ['digital', 'hex', 'triangles'] as const) {
      const prm = camoParams(camo({ pattern }));
      const normal: Vec3 = [0.3, 0.2, 1];
      const next = rng(31);
      let checked = 0;
      for (let i = 0; i < 300; i++) {
        // Two points of the plane z = 0.3·(…) through the same projected cell (projection on z: u = x, v = y).
        const x = next() * 5;
        const y = next() * 5;
        const cell = (pattern === 'digital' ? digitalCell : pattern === 'hex' ? hexCell : triangleCell)(x, y, prm.cell);
        const x2 = cell.c[0] + (x - cell.c[0]) * 0.5;
        const y2 = cell.c[1] + (y - cell.c[1]) * 0.5;
        const z = (u: number, v: number) => 2 - 0.3 * u - 0.2 * v;
        const a = argmax(camoWeights([x, y, z(x, y)], normal, prm));
        const b = argmax(camoWeights([x2, y2, z(x2, y2)], normal, prm));
        expect(a, pattern).toBe(b);
        checked++;
      }
      expect(checked).toBe(300);
    }
  });

  it('softness: continuous across a digital edge, pure at a cell centre', () => {
    const prm = camoParams(camo({ pattern: 'digital', softness: 0.8 }));
    const s = prm.cell;
    let crossed = 0;
    for (let i = 1; i < 200; i++) {
      const x = i * s; // an edge between cells along u
      const y = 0.37 * s + i * 0.013;
      const left = camoWeights([x - 1e-7, y, 0], [0, 0, 1], prm);
      const right = camoWeights([x + 1e-7, y, 0], [0, 0, 1], prm);
      for (let k = 0; k < 4; k++) expect(Math.abs(left[k]! - right[k]!)).toBeLessThan(1e-3);
      if (Math.max(...left) < 0.99) crossed++;
      const centre = camoWeights([x + s / 2, (Math.floor(y / s) + 0.5) * s, 0], [0, 0, 1], prm);
      expect(Math.max(...centre)).toBeCloseTo(1, 6);
    }
    expect(crossed).toBeGreaterThan(20);
  });

  it('softness: continuous across stripe bands and splinter bisectors', () => {
    const st = camoParams(camo({ pattern: 'stripes', softness: 1, angle: 0 }));
    // Angle 0: bands across x; within a segment (y fixed) the band edges are where x + offset crosses a bound.
    let maxJump = 0;
    for (let i = 0; i < 4000; i++) {
      const x = i * 0.0005;
      const a = camoWeights([x, 0.1, 0], [0, 0, 1], st);
      const b = camoWeights([x + 0.0005, 0.1, 0], [0, 0, 1], st);
      maxJump = Math.max(maxJump, ...a.map((v, k) => Math.abs(v - b[k]!)));
    }
    expect(maxJump).toBeLessThan(0.05);
    const sp = camoParams(camo({ pattern: 'splinter', softness: 1 }));
    maxJump = 0;
    for (let i = 0; i < 4000; i++) {
      const x = i * 0.0005;
      const a = camoWeights([x, 0.2, 0.3], [0, 0, 1], sp);
      const b = camoWeights([x + 0.0005, 0.2, 0.3], [0, 0, 1], sp);
      maxJump = Math.max(maxJump, ...a.map((v, k) => Math.abs(v - b[k]!)));
    }
    expect(maxJump).toBeLessThan(0.1);
  });

  it('splinter: a site’s surroundings take its colour', () => {
    const prm = camoParams(camo({ pattern: 'splinter' }));
    const site = splinterSite(2, -1, 3, prm.seed, prm.cell);
    const w = camoWeights(site.pos, [0, 1, 0], prm);
    const expected = (site.u >= prm.bounds[0] ? 1 : 0) + (site.u >= prm.bounds[1] ? 1 : 0) + (site.u >= prm.bounds[2] ? 1 : 0);
    expect(argmax(w)).toBe(expected);
  });

  it('stripes at 0°: within a segment the colour does not change along Y', () => {
    const prm = camoParams(camo({ pattern: 'stripes', angle: 0 }));
    const next = rng(2);
    for (let i = 0; i < 200; i++) {
      const x = next() * 5;
      const seg = Math.floor(next() * 10);
      const y1 = (seg + 0.1) * prm.segment;
      const y2 = (seg + 0.9) * prm.segment;
      expect(argmax(camoWeights([x, y1, 0], [0, 0, 1], prm))).toBe(argmax(camoWeights([x, y2, 0.5], [0, 0, 1], prm)));
    }
    expect(PATTERN_INDEX.stripes).toBe(prm.pattern);
  });
});
