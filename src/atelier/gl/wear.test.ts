import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../project';
import {
  BASE_FRAGMENT,
  DECAL_FRAGMENT,
  WEAR_EDGE_WIDTH,
  WEAR_NONE,
  chipAmount,
  wearField,
  wearThreshold,
} from './shaders';
import { WEAR_METAL_RGB, edgeDistance, sharpEdgeHeights, wearBaseColor, wearUniform } from './wear';

/** Quads (four corners, counter-clockwise seen from the outside) as split vertices with face normals, like the game's meshes. */
function mesh(quads: { corners: [Vec3, Vec3, Vec3, Vec3]; normal: Vec3 }[], flip = false) {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const q of quads) {
    const base = positions.length / 3;
    for (const c of q.corners) {
      positions.push(...c);
      normals.push(...q.normal);
    }
    const tris = [
      [0, 1, 2],
      [0, 2, 3],
    ];
    for (const t of tris) indices.push(...(flip ? [t[0]!, t[2]!, t[1]!] : t).map((i) => base + i));
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

/** The unit cube [0,1]³, six faces. */
function cube(flip = false) {
  return mesh(
    [
      { corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], normal: [0, 0, 1] },
      { corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], normal: [0, 0, -1] },
      { corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], normal: [1, 0, 0] },
      { corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], normal: [-1, 0, 0] },
      { corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], normal: [0, 1, 0] },
      { corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], normal: [0, -1, 0] },
    ],
    flip,
  );
}

const sorted = (h: Float32Array, t: number) => [...h.subarray(t * 3, t * 3 + 3)].map((v) => +v.toFixed(5)).sort((a, b) => a - b);

describe('sharp edges', () => {
  it('every edge of a cube is sharp and convex; the faces\' diagonals are not', () => {
    for (const flip of [false, true]) {
      const h = sharpEdgeHeights(cube(flip));
      expect(h).toHaveLength(36);
      // Each triangle: the two cube edges (height 1 from the opposite corner) and the diagonal (not sharp).
      for (let t = 0; t < 12; t++) expect(sorted(h, t)).toEqual([-1, 1, 1]);
    }
  });

  it('an open plate is sharp along its rim only', () => {
    const h = sharpEdgeHeights(mesh([{ corners: [[0, 0, 0], [2, 0, 0], [2, 0, -2], [0, 0, -2]], normal: [0, 1, 0] }]));
    expect(sorted(h, 0)).toEqual([-1, 2, 2]);
    expect(sorted(h, 1)).toEqual([-1, 2, 2]);
  });

  it('an inner corner is not sharp, and nearly flat folds are not either', () => {
    // Floor (y = 0, facing up) and a wall (x = 0, facing +x) meeting in an inner corner along z.
    const corner = sharpEdgeHeights(
      mesh([
        { corners: [[0, 0, 0], [1, 0, 0], [1, 0, -1], [0, 0, -1]], normal: [0, 1, 0] },
        { corners: [[0, 0, -1], [0, 0, 0], [0, 1, 0], [0, 1, -1]], normal: [1, 0, 0] },
      ]),
    );
    // The floor's edge at x = 0 (shared with the wall) is the only one that isn't its rim.
    const floor = [...corner.subarray(0, 6)];
    // Not sharp: the diagonal (in both triangles) and the edge shared with the wall.
    expect(floor.filter((v) => v < 0)).toHaveLength(3);
    // A 10° fold between two plates is not an edge.
    const s = Math.sin((10 * Math.PI) / 180);
    const c = Math.cos((10 * Math.PI) / 180);
    const fold = sharpEdgeHeights(
      mesh([
        { corners: [[0, 0, 0], [1, 0, 0], [1, 0, -1], [0, 0, -1]], normal: [0, 1, 0] },
        { corners: [[1, 0, 0], [1 + c, -s, 0], [1 + c, -s, -1], [1, 0, -1]], normal: [s, c, 0] },
      ]),
    );
    // The shared edge (x = 1) is not sharp: each plate keeps only its three rim edges.
    const sharpCount = [...fold].filter((v) => v > 0).length;
    expect(sharpCount).toBe(6);
  });

  it('skips degenerate triangles', () => {
    const h = sharpEdgeHeights({ positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) });
    expect([...h]).toEqual([-1, -1, -1]);
  });

  it('a texel\'s distance is its barycentric weight times the sharp edge\'s height', () => {
    expect(edgeDistance([0.25, 0.75, 0], [2, -1, -1])).toBeCloseTo(0.5);
    expect(edgeDistance([0.5, 0.5, 0], [-1, -1, -1])).toBeGreaterThan(1000);
    expect(edgeDistance([0.3, 0.3, 0.4], [1, 1, 0.5])).toBeCloseTo(0.2);
  });
});

/** Shares of chipped texels among random points `d` metres from an edge. */
function share(amount: number, d: number, n = 4000) {
  let chipped = 0;
  let s = 7;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [r() * 4, r() * 4, r() * 4];
    chipped += chipAmount(wearField(p, d), amount);
  }
  return chipped / n;
}

describe('wear field', () => {
  it('nothing chips without wear', () => {
    expect(wearThreshold(0)).toBe(Infinity);
    expect(wearUniform(undefined)).toBe(WEAR_NONE);
    expect(wearUniform(0)).toBe(WEAR_NONE);
    expect(share(0, 0)).toBe(0);
  });

  it('low wear chips the edges only; more wear reaches the flat surfaces', () => {
    const far = 10 * WEAR_EDGE_WIDTH;
    expect(share(0.3, 0)).toBeGreaterThan(0.05);
    expect(share(0.3, far)).toBe(0);
    expect(share(1, far)).toBeGreaterThan(0.3);
    expect(share(1, far)).toBeLessThan(0.75);
    // Monotonic: more wear never chips less, on edges and on flat surfaces.
    let edge = 0;
    let flat = 0;
    for (const a of [0.1, 0.25, 0.5, 0.75, 1]) {
      const e = share(a, 0, 1500);
      const f = share(a, far, 1500);
      expect(e).toBeGreaterThanOrEqual(edge);
      expect(f).toBeGreaterThanOrEqual(flat);
      edge = e;
      flat = f;
    }
  });

  it('the Base shows bare metal in a chip and stays as it was without wear', () => {
    const paint: Vec3 = [0.3, 0.4, 0.2];
    expect(wearBaseColor(paint, [0, 0, 0], 5, undefined)).toEqual(paint);
    const chipped = wearBaseColor(paint, [0, 0, 0], 5, 1);
    // Inside a chip: between the bare steel and the rust, never the paint.
    expect(chipped[1]).toBeLessThanOrEqual(WEAR_METAL_RGB[1] + 1e-6);
    expect(chipped).not.toEqual(paint);
  });

  it('the shaders read the same uniforms', () => {
    expect(BASE_FRAGMENT).toContain('uniform float uWearThreshold;');
    expect(BASE_FRAGMENT).toContain('lvWearField()');
    expect(DECAL_FRAGMENT).toContain('uniform float uWearThreshold;');
    expect(DECAL_FRAGMENT).toContain('(1.0 - chip)');
  });
});
