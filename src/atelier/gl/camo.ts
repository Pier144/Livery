import { CAMO_PATTERNS, DEFAULT_STRIPE_ANGLE, type BaseLayer, type CamoPattern, type Vec3 } from '../project';
import {
  CAMO_CELL,
  CAMO_THRESHOLDS,
  NOISE_GLSL,
  WEAR_GLSL,
  WEAR_NONE,
  WEAR_RIM,
  WEAR_RIM_DARKEN,
  WEAR_RUST_CELL,
  WEAR_RUST_FROM,
  WEAR_RUST_TO,
  WEAR_SEED,
  camoIndex,
  camoNoise,
  glslFloat,
  hash32,
  latticeValue,
} from './shaders';

/**
 * The Base's camo styles (spec: docs/superpowers/specs/2026-10-17-atelier-geometric-camo-design.md).
 * `camoWeights` is the TypeScript reference of the GLSL `lvCamoWeights` (same structure, same
 * hashes): for a texel's model-space position and normal it gives the weight of each of the four
 * colour slots (sum 1; one-hot when sharp). `camoParams` turns a Base into the numbers both use.
 *
 * - organic: two octaves of 3D value noise split by thresholds (unchanged);
 * - digital, hex, triangles: a 2D grid on the plane of the normal's dominant axis; each cell takes
 *   the noise colour of the point on the texel's tangent plane above its centre, so blobs of cells
 *   carry across the vehicle's edges;
 * - splinter: 3D Voronoi cells, one random colour each;
 * - stripes: 3D bands across `stripeN`, shifted per segment along `stripeB` (stepped edges).
 *
 * Softness blends a texel with its neighbours across the cell edges: weight 1 for its own cell,
 * `1 − smoothstep(0, soft, d)` for each neighbour `d` away (organic: across the noise thresholds).
 */

export const PATTERN_INDEX: Record<CamoPattern, number> = { organic: 0, digital: 1, hex: 2, splinter: 3, triangles: 4, stripes: 5 };

/** Model units (metres) of a cell at cell size 1: square side, hexagon circumradius, triangle side. */
export const CELL_BASE = { digital: 0.1, hex: 0.12, triangles: 0.2 } as const;
/** Splinter: model units per Voronoi cell at scale 1. */
export const SPLINTER_CELL = 0.6;
/** Stripes: model units of one band at scale 1 (a period holds one band per colour). */
export const STRIPE_BAND = 0.35;
/** Stripes: length of the segments along the band, at scale 1. */
export const STRIPE_SEGMENT = 0.5;
/** Stripes: how far a segment shifts, as a fraction of the period (±half of it). */
export const STRIPE_JITTER = 0.25;
/** Organic: the widest softness, in noise units (also capped at half the gap between thresholds). */
export const ORGANIC_SOFT_MAX = 0.04;
/** Splinter: where a site sits in its cell (`cell + SITE_MIN + SITE_SPAN · hash`). */
export const SITE_MIN = 0.1;
export const SITE_SPAN = 0.8;
/** Salts of the per-site hashes and of the stripes' segment hash. */
export const SALT = { x: 0x68e31da4, y: 0xb5297a4d, z: 0x1b56c4e9, colour: 0x9e3779b9, stripe: 0x3c6ef372 } as const;

/**
 * Inverse CDF of `camoNoise` at i/64 (i = 0..64), measured over 4M random points (seeds
 * 1000..1063), so shares can pick thresholds; camo.test.ts checks it. The ends are 0 and 1.
 */
export const CAMO_QUANTILES: readonly number[] = [
  0, 0.2154, 0.2484, 0.2709, 0.2885, 0.3033, 0.3163, 0.3279, 0.3385, 0.3483, 0.3574, 0.366, 0.3742, 0.3819, 0.3894, 0.3966, 0.4036,
  0.4104, 0.417, 0.4235, 0.4298, 0.436, 0.4421, 0.4482, 0.4542, 0.4601, 0.4659, 0.4716, 0.4773, 0.483, 0.4886, 0.4943, 0.5, 0.5056,
  0.5112, 0.5169, 0.5226, 0.5284, 0.5341, 0.5399, 0.5458, 0.5517, 0.5578, 0.5639, 0.5701, 0.5764, 0.5829, 0.5895, 0.5963, 0.6033,
  0.6106, 0.6181, 0.6259, 0.6341, 0.6427, 0.6518, 0.6615, 0.6721, 0.6836, 0.6965, 0.7111, 0.7287, 0.751, 0.7844, 1,
];

type Triple = readonly [number, number, number];

/** The noise value below which a share `p` (0..1) of texels falls. */
export function noiseQuantile(p: number): number {
  const x = Math.min(64, Math.max(0, p * 64));
  const i = Math.min(63, Math.floor(x));
  return CAMO_QUANTILES[i]! + (CAMO_QUANTILES[i + 1]! - CAMO_QUANTILES[i]!) * (x - i);
}

const usable = (weights: readonly number[] | undefined, count: number): weights is readonly number[] =>
  weights !== undefined && weights.length === count && count >= 2;

/** Noise thresholds of the noise styles: today's table without shares, else the quantiles of the cumulative shares. Unused = 2. */
export function noiseThresholds(weights: readonly number[] | undefined, count: number): Triple {
  if (!usable(weights, count)) return CAMO_THRESHOLDS[count] ?? CAMO_THRESHOLDS[1]!;
  const t: [number, number, number] = [2, 2, 2];
  let acc = 0;
  for (let k = 0; k < count - 1; k++) {
    acc += weights[k]!;
    t[k] = noiseQuantile(acc);
  }
  return t;
}

/** Cumulative shares (splinter, stripes): equal shares without weights. Unused = 2. */
export function cumulativeBounds(weights: readonly number[] | undefined, count: number): Triple {
  const b: [number, number, number] = [2, 2, 2];
  let acc = 0;
  for (let k = 0; k < count - 1; k++) {
    acc += usable(weights, count) ? weights[k]! : 1 / count;
    b[k] = acc;
  }
  return b;
}

/** What the camo maths needs (also the Base shader's uniforms, see `baseUniforms`). */
export interface CamoParams {
  /** PATTERN_INDEX; an unknown style is organic. 0 also when the Base is solid. */
  pattern: number;
  /** Colours in use (1 when solid). */
  count: number;
  /** Noise thresholds (organic, digital, hex, triangles). */
  thresholds: Triple;
  /** Cumulative shares (splinter, stripes). */
  bounds: Triple;
  /** Noise cells per model unit: `1 / (CAMO_CELL · scale)`. */
  frequency: number;
  /** The seed as an int32 (the shader reads it back as a uint). */
  seed: number;
  /** Model units: the grid cell (digital, hex, triangles), the Voronoi cell (splinter), the period (stripes). */
  cell: number;
  /** Softness width in the style's units (noise units for organic, model units otherwise); 0 = sharp. */
  soft: number;
  /** Stripes: band normal and direction along the band (unit, in the XY plane). */
  stripeN: Vec3;
  stripeB: Vec3;
  /** Stripes: segment length and shift amplitude, model units. */
  segment: number;
  jitter: number;
}

const patternOf = (base: BaseLayer): number => {
  const p = base.pattern;
  return typeof p === 'string' && (CAMO_PATTERNS as readonly string[]).includes(p) ? PATTERN_INDEX[p as CamoPattern] : 0;
};

export function camoParams(base: BaseLayer | undefined): CamoParams {
  const colors = base && base.colors.length > 0 ? base.colors.length : 1;
  const camo = base?.mode === 'camo' && colors >= 2;
  const count = camo ? Math.min(4, colors) : 1;
  const pattern = camo ? patternOf(base) : 0;
  const scale = base && base.scale > 0 ? base.scale : 1;
  const weights = camo && usable(base.weights, count) ? base.weights : undefined;
  const softness = camo ? Math.min(1, Math.max(0, base.softness ?? 0)) : 0;
  const cellSize = base?.cellSize ?? 1;
  const thresholds = noiseThresholds(weights, count);
  const bounds = cumulativeBounds(weights, count);
  const angle = ((base?.angle ?? DEFAULT_STRIPE_ANGLE) * Math.PI) / 180;
  const period = count * STRIPE_BAND * scale;

  let cell = 0;
  let soft = 0;
  switch (pattern) {
    case PATTERN_INDEX.organic: {
      let gap = ORGANIC_SOFT_MAX * 2;
      for (let k = 0; k + 1 < count - 1; k++) gap = Math.min(gap, thresholds[k + 1]! - thresholds[k]!);
      soft = softness * Math.min(ORGANIC_SOFT_MAX, gap / 2);
      break;
    }
    case PATTERN_INDEX.digital:
      cell = CELL_BASE.digital * cellSize;
      soft = (softness * cell) / 2;
      break;
    case PATTERN_INDEX.hex:
      cell = CELL_BASE.hex * cellSize;
      soft = (softness * cell) / 2;
      break;
    case PATTERN_INDEX.triangles:
      cell = CELL_BASE.triangles * cellSize;
      soft = (softness * cell * Math.sqrt(3)) / 6;
      break;
    case PATTERN_INDEX.splinter:
      cell = SPLINTER_CELL * scale;
      soft = (softness * cell) / 4;
      break;
    case PATTERN_INDEX.stripes: {
      cell = period;
      const narrowest = weights ? Math.min(...weights) : 1 / count;
      soft = (softness * narrowest * period) / 2;
      break;
    }
  }
  return {
    pattern,
    count,
    thresholds,
    bounds,
    frequency: 1 / (CAMO_CELL * scale),
    seed: (base?.seed ?? 1) | 0,
    cell,
    soft,
    stripeN: [Math.cos(angle), Math.sin(angle), 0],
    stripeB: [-Math.sin(angle), Math.cos(angle), 0],
    segment: STRIPE_SEGMENT * scale,
    jitter: STRIPE_JITTER * period,
  };
}

// ---------------------------------------------------------------- the reference

export type CamoWeights = [number, number, number, number];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Softness weight of a neighbour `d` away (0 when sharp or beyond the width). */
const neighbourWeight = (d: number, soft: number) => (soft > 0 ? 1 - smoothstep(0, soft, d) : 0);

const normalized = (w: CamoWeights): CamoWeights => {
  const sum = w[0] + w[1] + w[2] + w[3];
  return [w[0] / sum, w[1] / sum, w[2] / sum, w[3] / sum];
};

const oneHot = (i: number): CamoWeights => {
  const w: CamoWeights = [0, 0, 0, 0];
  w[i] = 1;
  return w;
};

/** How many of `bounds` a value in [0, 1) reaches. */
const boundIndex = (u: number, bounds: Triple) => (u >= bounds[0] ? 1 : 0) + (u >= bounds[1] ? 1 : 0) + (u >= bounds[2] ? 1 : 0);

function organic(p: Vec3, prm: CamoParams): CamoWeights {
  const f = prm.frequency;
  const n = camoNoise(p[0] * f, p[1] * f, p[2] * f, prm.seed);
  if (!(prm.soft > 0)) return oneHot(camoIndex(n, prm.thresholds));
  const w: CamoWeights = [1, 0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const s = smoothstep(prm.thresholds[k]! - prm.soft, prm.thresholds[k]! + prm.soft, n);
    for (let i = 0; i < 4; i++) w[i]! *= 1 - s;
    w[k + 1]! += s;
  }
  return w;
}

/**
 * A grid cell on the projection plane: its centre and every cell touching it (by an edge or a
 * corner) with its centre and the exact distance from the point to that cell (0 on the shared
 * edge). A cell's softness weight then depends only on the point and that cell, so the blend is
 * continuous everywhere (cells further away than the softness width never touch).
 */
export interface GridCell {
  c: [number, number];
  neighbours: { c: [number, number]; d: number }[];
}

/** Distance from (pu, pv) to the segment (au, av)–(bu, bv). */
function segmentDistance(pu: number, pv: number, au: number, av: number, bu: number, bv: number): number {
  const eu = bu - au;
  const ev = bv - av;
  const t = Math.min(1, Math.max(0, ((pu - au) * eu + (pv - av) * ev) / (eu * eu + ev * ev)));
  return Math.hypot(pu - au - t * eu, pv - av - t * ev);
}

/** Squares of side `s`: the 8 cells around. */
export function digitalCell(u: number, v: number, s: number): GridCell {
  const i = Math.floor(u / s);
  const j = Math.floor(v / s);
  const cu = (i + 0.5) * s;
  const cv = (j + 0.5) * s;
  const gap = (k: number, lo: number, hi: number) => (k < 0 ? lo : k > 0 ? hi : 0);
  const neighbours: GridCell['neighbours'] = [];
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      if (di === 0 && dj === 0) continue;
      const d = Math.hypot(gap(di, u - i * s, (i + 1) * s - u), gap(dj, v - j * s, (j + 1) * s - v));
      neighbours.push({ c: [cu + di * s, cv + dj * s], d });
    }
  return { c: [cu, cv], neighbours };
}

const SQRT3 = Math.sqrt(3);
const HEX_DIRS: readonly [number, number][] = [0, 1, 2, 3, 4, 5].map((k) => [Math.cos((k * Math.PI) / 3), Math.sin((k * Math.PI) / 3)]);

/**
 * Pointy-top hexagons of circumradius `s` (vertices at 30° + k·60°): the 6 cells around, each at
 * the distance to the shared edge segment (exact for a point inside: the hexagons are convex).
 */
export function hexCell(u: number, v: number, s: number): GridCell {
  const q = ((SQRT3 / 3) * u - v / 3) / s;
  const r = ((2 / 3) * v) / s;
  let rx = Math.round(q);
  let rz = Math.round(r);
  const ry = Math.round(-q - r);
  const dx = Math.abs(rx - q);
  const dy = Math.abs(ry - (-q - r));
  const dz = Math.abs(rz - r);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (!(dy > dz)) rz = -rx - ry;
  const cu = s * SQRT3 * (rx + rz / 2);
  const cv = s * 1.5 * rz;
  // Edge k (towards neighbour k) runs between the vertices at 60k − 30° and 60k + 30°.
  const c30 = SQRT3 / 2;
  return {
    c: [cu, cv],
    neighbours: HEX_DIRS.map(([x, y]) => {
      const au = cu + s * (x * c30 + y * 0.5);
      const av = cv + s * (y * c30 - x * 0.5);
      const bu = cu + s * (x * c30 - y * 0.5);
      const bv = cv + s * (y * c30 + x * 0.5);
      return { c: [cu + SQRT3 * s * x, cv + SQRT3 * s * y], d: segmentDistance(u, v, au, av, bu, bv) };
    }),
  };
}

const TRI_N: readonly [number, number][] = [
  [0, 1],
  [-SQRT3 / 2, -0.5],
  [SQRT3 / 2, -0.5],
];

/** Rotation by +60°. */
const rot60 = (x: number, y: number): [number, number] => [0.5 * x - (SQRT3 / 2) * y, (SQRT3 / 2) * x + 0.5 * y];

/**
 * Equilateral triangles of side `s` (three line families `h = s·√3/2` apart, `a_k = dot(q, n_k)/h`):
 * the 3 cells across the edges (distance to the shared edge segment) and the 9 that only share a
 * corner (3 at each corner V, between the rays V + t·r_2…r_5 when r_0, r_1 run along the cell's
 * own edges: distance to the nearest of those rays, the middle one only touching at V).
 */
export function triangleCell(u: number, v: number, s: number): GridCell {
  const h = (s * SQRT3) / 2;
  const a = TRI_N.map(([x, y]) => (u * x + v * y) / h);
  const F = a.map(Math.floor);
  // Σa = 0, so ΣF is −1 (the triangle lies above its three lower lines) or −2 (below the upper ones).
  const lower = F[0]! + F[1]! + F[2]! >= -1;
  const toPlane = (b: readonly number[]): [number, number] => {
    let x = 0;
    let y = 0;
    for (let k = 0; k < 3; k++) {
      x += ((2 * h) / 3) * b[k]! * TRI_N[k]![0];
      y += ((2 * h) / 3) * b[k]! * TRI_N[k]![1];
    }
    return [x, y];
  };
  const off = lower ? 1 / 3 : 2 / 3;
  const c = toPlane(F.map((f) => f + off));
  // Vertex k: a_k one line further than the cell's own line k, the others on theirs.
  const V = [0, 1, 2].map((k) => toPlane(F.map((f, i) => (lower ? (i === k ? f + 1 : f) : i === k ? f : f + 1))));
  const step = lower ? -(2 * h) / 3 : (2 * h) / 3;
  const neighbours: GridCell['neighbours'] = [];
  for (let k = 0; k < 3; k++) {
    // Edge k lies on line k, between the two other vertices.
    const A = V[(k + 1) % 3]!;
    const B = V[(k + 2) % 3]!;
    neighbours.push({ c: [c[0] + step * TRI_N[k]![0], c[1] + step * TRI_N[k]![1]], d: segmentDistance(u, v, A[0], A[1], B[0], B[1]) });
  }
  const R = s / SQRT3;
  for (let k = 0; k < 3; k++) {
    const P = V[k]!;
    let r0 = [(V[(k + 1) % 3]![0] - P[0]) / s, (V[(k + 1) % 3]![1] - P[1]) / s] as [number, number];
    const r1 = [(V[(k + 2) % 3]![0] - P[0]) / s, (V[(k + 2) % 3]![1] - P[1]) / s] as [number, number];
    // r1 = r0 turned +60°, else swap.
    if (r0[0] * r1[1] - r0[1] * r1[0] < 0) r0 = r1;
    const r2 = rot60(...rot60(...r0));
    const r3 = rot60(...r2);
    const r4 = rot60(...r3);
    const r5 = rot60(...r4);
    const centre = (ray: [number, number]): [number, number] => {
      // The centroid of the wedge from `ray` to `ray` + 60°: R along `ray` turned +30°.
      const cx = (SQRT3 / 2) * ray[0] - 0.5 * ray[1];
      const cy = 0.5 * ray[0] + (SQRT3 / 2) * ray[1];
      return [P[0] + R * cx, P[1] + R * cy];
    };
    const toRay = (ray: [number, number]) => segmentDistance(u, v, P[0], P[1], P[0] + s * ray[0], P[1] + s * ray[1]);
    neighbours.push({ c: centre(r2), d: toRay(r2) });
    neighbours.push({ c: centre(r3), d: Math.hypot(u - P[0], v - P[1]) });
    neighbours.push({ c: centre(r4), d: toRay(r5) });
  }
  return { c, neighbours };
}

/**
 * The projection plane of a normal: the dominant axis `a` (ties X, Y, Z; a zero normal is +Y) and
 * the plane's two axes `u`, `v` (X → z, y; Y → x, z; Z → x, y), with the normal made unit length.
 */
export function planeOf(normal: Vec3): { n: Vec3; a: number; u: number; v: number } {
  const l = Math.hypot(normal[0], normal[1], normal[2]);
  const n: Vec3 = l > 1e-12 ? [normal[0] / l, normal[1] / l, normal[2] / l] : [0, 1, 0];
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (ax >= ay && ax >= az) return { n, a: 0, u: 2, v: 1 };
  if (ay >= az) return { n, a: 1, u: 0, v: 2 };
  return { n, a: 2, u: 0, v: 1 };
}

function grid(p: Vec3, normal: Vec3, prm: CamoParams, cellOf: (u: number, v: number, s: number) => GridCell): CamoWeights {
  const { n, a, u, v } = planeOf(normal);
  const pu = p[u]!;
  const pv = p[v]!;
  const f = prm.frequency;
  // The colour of the cell centred at (cu, cv): the noise at the point of the texel's tangent plane above it.
  const colourAt = (cu: number, cv: number) => {
    const q: Vec3 = [p[0], p[1], p[2]];
    q[u] = cu;
    q[v] = cv;
    q[a] = p[a]! - ((cu - pu) * n[u]! + (cv - pv) * n[v]!) / n[a]!;
    return camoIndex(camoNoise(q[0] * f, q[1] * f, q[2] * f, prm.seed), prm.thresholds);
  };
  const cell = cellOf(pu, pv, prm.cell);
  const w = oneHot(colourAt(cell.c[0], cell.c[1]));
  if (!(prm.soft > 0)) return w;
  for (const e of cell.neighbours) {
    const k = neighbourWeight(e.d, prm.soft);
    if (k > 0) w[colourAt(e.c[0], e.c[1])]! += k;
  }
  return normalized(w);
}

/** A splinter site: its position and colour value in [0, 1). */
export function splinterSite(cx: number, cy: number, cz: number, seed: number, size: number): { pos: Vec3; u: number } {
  const h = hash32((seed >>> 0) ^ hash32((cx >>> 0) ^ hash32((cy >>> 0) ^ hash32(cz >>> 0))));
  const unit = (salt: number) => (hash32(h ^ salt) >>> 8) / 16777216;
  return {
    pos: [(cx + SITE_MIN + SITE_SPAN * unit(SALT.x)) * size, (cy + SITE_MIN + SITE_SPAN * unit(SALT.y)) * size, (cz + SITE_MIN + SITE_SPAN * unit(SALT.z)) * size],
    u: unit(SALT.colour),
  };
}

function splinter(p: Vec3, prm: CamoParams): CamoWeights {
  const s = prm.cell;
  const gx = Math.floor(p[0] / s);
  const gy = Math.floor(p[1] / s);
  const gz = Math.floor(p[2] / s);
  const sites: { pos: Vec3; u: number; d2: number }[] = [];
  let best = 0;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const site = splinterSite(gx + dx, gy + dy, gz + dz, prm.seed, s);
        const d2 = (site.pos[0] - p[0]) ** 2 + (site.pos[1] - p[1]) ** 2 + (site.pos[2] - p[2]) ** 2;
        sites.push({ ...site, d2 });
        if (d2 < sites[best]!.d2) best = sites.length - 1;
      }
  const near = sites[best]!;
  const w = oneHot(boundIndex(near.u, prm.bounds));
  if (!(prm.soft > 0)) return w;
  for (const site of sites) {
    if (site === near) continue;
    const gap = Math.hypot(site.pos[0] - near.pos[0], site.pos[1] - near.pos[1], site.pos[2] - near.pos[2]);
    if (gap <= 0) continue;
    const d = (site.d2 - near.d2) / (2 * gap);
    if (d < prm.soft) w[boundIndex(site.u, prm.bounds)]! += neighbourWeight(d, prm.soft);
  }
  return normalized(w);
}

function stripes(p: Vec3, prm: CamoParams): CamoWeights {
  const N = prm.stripeN;
  const B = prm.stripeB;
  const d = p[0] * N[0] + p[1] * N[1] + p[2] * N[2];
  const e = p[0] * B[0] + p[1] * B[1] + p[2] * B[2];
  const seg = Math.floor(e / prm.segment);
  const offset = (latticeValue(seg, 0, 0, prm.seed ^ SALT.stripe) - 0.5) * prm.jitter;
  const t = (d + offset) / prm.cell;
  const f = t - Math.floor(t);
  const count = prm.count;
  // Band i spans [b_i, b_i+1) of the period.
  const b = [0, ...prm.bounds.slice(0, count - 1), 1];
  let i = 0;
  while (i < count - 1 && f >= b[i + 1]!) i++;
  const w = oneHot(i);
  if (!(prm.soft > 0)) return w;
  w[(i - 1 + count) % count]! += neighbourWeight((f - b[i]!) * prm.cell, prm.soft);
  w[(i + 1) % count]! += neighbourWeight((b[i + 1]! - f) * prm.cell, prm.soft);
  return normalized(w);
}

/** The weight of each colour slot at model position `p` with surface normal `normal` (sum 1). */
export function camoWeights(p: Vec3, normal: Vec3, prm: CamoParams): CamoWeights {
  if (prm.count < 2) return [1, 0, 0, 0];
  switch (prm.pattern) {
    case PATTERN_INDEX.digital:
      return grid(p, normal, prm, digitalCell);
    case PATTERN_INDEX.hex:
      return grid(p, normal, prm, hexCell);
    case PATTERN_INDEX.triangles:
      return grid(p, normal, prm, triangleCell);
    case PATTERN_INDEX.splinter:
      return splinter(p, prm);
    case PATTERN_INDEX.stripes:
      return stripes(p, prm);
    default:
      return organic(p, prm);
  }
}

// ---------------------------------------------------------------- GLSL

const f = glslFloat;

/**
 * `lvCamoWeights(p, normal)`, line for line the GLSL of `camoWeights` (same hashes through
 * `lvHash`/`lvLattice`/`lvCamoNoise` from NOISE_GLSL, same structure). Uniforms: the CamoParams
 * (`uPattern`, `uCount`, `uThresholds`, `uBounds`, `uFrequency`, `uSeed`, `uCell`, `uSoft`,
 * `uStripeN`, `uStripeB`, `uSegment`, `uJitter`).
 */
export const CAMO_GLSL = /* glsl */ `
uniform int uPattern;
uniform int uCount;
uniform vec3 uThresholds;
uniform vec3 uBounds;
uniform float uFrequency;
uniform int uSeed;
uniform float uCell;
uniform float uSoft;
uniform vec3 uStripeN;
uniform vec3 uStripeB;
uniform float uSegment;
uniform float uJitter;

vec4 lvOneHot(int i) {
  return vec4(equal(ivec4(i), ivec4(0, 1, 2, 3)));
}

float lvNeighbourWeight(float d) {
  return uSoft > 0.0 ? 1.0 - smoothstep(0.0, uSoft, d) : 0.0;
}

int lvThresholdIndex(float n) {
  return int(step(uThresholds.x, n) + step(uThresholds.y, n) + step(uThresholds.z, n));
}

int lvBoundIndex(float u) {
  return int(step(uBounds.x, u) + step(uBounds.y, u) + step(uBounds.z, u));
}

vec4 lvNormalized(vec4 w) {
  return w / (w.x + w.y + w.z + w.w);
}

vec4 lvOrganic(vec3 p) {
  float n = lvCamoNoise(p * uFrequency, uint(uSeed));
  if (!(uSoft > 0.0)) return lvOneHot(lvThresholdIndex(n));
  vec4 w = vec4(1.0, 0.0, 0.0, 0.0);
  for (int k = 0; k < 3; k++) {
    float s = smoothstep(uThresholds[k] - uSoft, uThresholds[k] + uSoft, n);
    w = w * (1.0 - s) + s * lvOneHot(k + 1);
  }
  return w;
}

// The projection plane of the texel being shaded (set by lvGrid).
vec3 gP;
vec3 gN;
vec3 gU;
vec3 gV;
vec3 gA;

// The colour of the grid cell centred at c (plane units): the noise on the tangent plane above it.
int lvCellColour(vec2 c) {
  float du = c.x - dot(gP, gU);
  float dv = c.y - dot(gP, gV);
  vec3 q = gP + du * gU + dv * gV - ((du * dot(gN, gU) + dv * dot(gN, gV)) / dot(gN, gA)) * gA;
  return lvThresholdIndex(lvCamoNoise(q * uFrequency, uint(uSeed)));
}

float lvSegment(vec2 p, vec2 a, vec2 b) {
  vec2 e = b - a;
  float t = clamp(dot(p - a, e) / dot(e, e), 0.0, 1.0);
  return length(p - a - t * e);
}

vec4 lvAddNeighbour(vec4 w, vec2 c, float d) {
  float k = lvNeighbourWeight(d);
  return k > 0.0 ? w + k * lvOneHot(lvCellColour(c)) : w;
}

vec4 lvDigital(vec2 q) {
  float s = uCell;
  vec2 i = floor(q / s);
  vec2 c = (i + 0.5) * s;
  vec4 w = lvOneHot(lvCellColour(c));
  if (!(uSoft > 0.0)) return w;
  vec2 lo = q - i * s;
  vec2 hi = (i + 1.0) * s - q;
  for (int dj = -1; dj <= 1; dj++)
    for (int di = -1; di <= 1; di++) {
      if (di == 0 && dj == 0) continue;
      float dx = di < 0 ? lo.x : di > 0 ? hi.x : 0.0;
      float dy = dj < 0 ? lo.y : dj > 0 ? hi.y : 0.0;
      w = lvAddNeighbour(w, c + vec2(float(di), float(dj)) * s, length(vec2(dx, dy)));
    }
  return lvNormalized(w);
}

const float LV_SQRT3 = ${f(SQRT3)};

vec4 lvHex(vec2 p) {
  float s = uCell;
  float q = ((LV_SQRT3 / 3.0) * p.x - p.y / 3.0) / s;
  float r = ((2.0 / 3.0) * p.y) / s;
  float rx = floor(q + 0.5);
  float rz = floor(r + 0.5);
  float ry = floor(-q - r + 0.5);
  float dx = abs(rx - q);
  float dy = abs(ry - (-q - r));
  float dz = abs(rz - r);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (!(dy > dz)) rz = -rx - ry;
  vec2 c = vec2(s * LV_SQRT3 * (rx + rz / 2.0), s * 1.5 * rz);
  vec4 w = lvOneHot(lvCellColour(c));
  if (!(uSoft > 0.0)) return w;
  float c30 = LV_SQRT3 / 2.0;
  for (int k = 0; k < 6; k++) {
    float angle = float(k) * ${f(Math.PI / 3)};
    vec2 d = vec2(cos(angle), sin(angle));
    vec2 a = c + s * vec2(d.x * c30 + d.y * 0.5, d.y * c30 - d.x * 0.5);
    vec2 b = c + s * vec2(d.x * c30 - d.y * 0.5, d.y * c30 + d.x * 0.5);
    w = lvAddNeighbour(w, c + LV_SQRT3 * s * d, lvSegment(p, a, b));
  }
  return lvNormalized(w);
}

vec2 lvRot60(vec2 v) {
  return vec2(0.5 * v.x - (LV_SQRT3 / 2.0) * v.y, (LV_SQRT3 / 2.0) * v.x + 0.5 * v.y);
}

// The centroid of the wedge from a ray at corner P to the ray + 60 degrees: R along the ray turned +30.
vec2 lvWedgeCentre(vec2 P, vec2 ray, float R) {
  return P + R * vec2((LV_SQRT3 / 2.0) * ray.x - 0.5 * ray.y, 0.5 * ray.x + (LV_SQRT3 / 2.0) * ray.y);
}

vec4 lvTriangles(vec2 p) {
  float s = uCell;
  float h = s * LV_SQRT3 / 2.0;
  vec2 N[3];
  N[0] = vec2(0.0, 1.0);
  N[1] = vec2(-LV_SQRT3 / 2.0, -0.5);
  N[2] = vec2(LV_SQRT3 / 2.0, -0.5);
  vec3 a = vec3(dot(p, N[0]), dot(p, N[1]), dot(p, N[2])) / h;
  vec3 F = floor(a);
  bool lower = F.x + F.y + F.z >= -1.5;
  float k2 = 2.0 * h / 3.0;
  vec3 b = F + (lower ? 1.0 / 3.0 : 2.0 / 3.0);
  vec2 c = k2 * (b.x * N[0] + b.y * N[1] + b.z * N[2]);
  vec4 w = lvOneHot(lvCellColour(c));
  if (!(uSoft > 0.0)) return w;
  vec3 v0 = lower ? F + vec3(1.0, 0.0, 0.0) : F + vec3(0.0, 1.0, 1.0);
  vec3 v1 = lower ? F + vec3(0.0, 1.0, 0.0) : F + vec3(1.0, 0.0, 1.0);
  vec3 v2 = lower ? F + vec3(0.0, 0.0, 1.0) : F + vec3(1.0, 1.0, 0.0);
  vec2 V[3];
  V[0] = k2 * (v0.x * N[0] + v0.y * N[1] + v0.z * N[2]);
  V[1] = k2 * (v1.x * N[0] + v1.y * N[1] + v1.z * N[2]);
  V[2] = k2 * (v2.x * N[0] + v2.y * N[1] + v2.z * N[2]);
  float across = lower ? -k2 : k2;
  for (int k = 0; k < 3; k++) w = lvAddNeighbour(w, c + across * N[k], lvSegment(p, V[(k + 1) % 3], V[(k + 2) % 3]));
  float R = s / LV_SQRT3;
  for (int k = 0; k < 3; k++) {
    vec2 P = V[k];
    vec2 r0 = (V[(k + 1) % 3] - P) / s;
    vec2 r1 = (V[(k + 2) % 3] - P) / s;
    if (r0.x * r1.y - r0.y * r1.x < 0.0) r0 = r1;
    vec2 r2 = lvRot60(lvRot60(r0));
    vec2 r3 = lvRot60(r2);
    vec2 r4 = lvRot60(r3);
    vec2 r5 = lvRot60(r4);
    w = lvAddNeighbour(w, lvWedgeCentre(P, r2, R), lvSegment(p, P, P + s * r2));
    w = lvAddNeighbour(w, lvWedgeCentre(P, r3, R), length(p - P));
    w = lvAddNeighbour(w, lvWedgeCentre(P, r4, R), lvSegment(p, P, P + s * r5));
  }
  return lvNormalized(w);
}

vec4 lvGrid(vec3 p, vec3 normal) {
  float l2 = dot(normal, normal);
  vec3 n = l2 > 1e-24 ? normal * inversesqrt(l2) : vec3(0.0, 1.0, 0.0);
  vec3 m = abs(n);
  gP = p;
  gN = n;
  if (m.x >= m.y && m.x >= m.z) {
    gA = vec3(1.0, 0.0, 0.0); gU = vec3(0.0, 0.0, 1.0); gV = vec3(0.0, 1.0, 0.0);
  } else if (m.y >= m.z) {
    gA = vec3(0.0, 1.0, 0.0); gU = vec3(1.0, 0.0, 0.0); gV = vec3(0.0, 0.0, 1.0);
  } else {
    gA = vec3(0.0, 0.0, 1.0); gU = vec3(1.0, 0.0, 0.0); gV = vec3(0.0, 1.0, 0.0);
  }
  vec2 q = vec2(dot(p, gU), dot(p, gV));
  if (uPattern == ${PATTERN_INDEX.digital}) return lvDigital(q);
  if (uPattern == ${PATTERN_INDEX.hex}) return lvHex(q);
  return lvTriangles(q);
}

vec4 lvSplinter(vec3 p) {
  float s = uCell;
  ivec3 g = ivec3(floor(p / s));
  vec3 sites[27];
  float us[27];
  float d2s[27];
  int best = 0;
  int i = 0;
  for (int dz = -1; dz <= 1; dz++)
    for (int dy = -1; dy <= 1; dy++)
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 c = g + ivec3(dx, dy, dz);
        uint h = lvHash(uint(uSeed) ^ lvHash(uint(c.x) ^ lvHash(uint(c.y) ^ lvHash(uint(c.z)))));
        vec3 j = vec3(
          float(lvHash(h ^ ${SALT.x >>> 0}u) >> 8u),
          float(lvHash(h ^ ${SALT.y >>> 0}u) >> 8u),
          float(lvHash(h ^ ${SALT.z >>> 0}u) >> 8u)) * (1.0 / 16777216.0);
        sites[i] = (vec3(c) + ${f(SITE_MIN)} + ${f(SITE_SPAN)} * j) * s;
        us[i] = float(lvHash(h ^ ${SALT.colour >>> 0}u) >> 8u) * (1.0 / 16777216.0);
        vec3 e = sites[i] - p;
        d2s[i] = dot(e, e);
        if (d2s[i] < d2s[best]) best = i;
        i++;
      }
  vec4 w = lvOneHot(lvBoundIndex(us[best]));
  if (!(uSoft > 0.0)) return w;
  for (int k = 0; k < 27; k++) {
    if (k == best) continue;
    float gap = length(sites[k] - sites[best]);
    if (!(gap > 0.0)) continue;
    float d = (d2s[k] - d2s[best]) / (2.0 * gap);
    if (d < uSoft) w += lvNeighbourWeight(d) * lvOneHot(lvBoundIndex(us[k]));
  }
  return lvNormalized(w);
}

vec4 lvStripes(vec3 p) {
  float d = dot(p, uStripeN);
  float e = dot(p, uStripeB);
  int seg = int(floor(e / uSegment));
  float offset = (lvLattice(ivec3(seg, 0, 0), uint(uSeed) ^ ${SALT.stripe >>> 0}u) - 0.5) * uJitter;
  float t = (d + offset) / uCell;
  float fr = t - floor(t);
  float b[5];
  b[0] = 0.0;
  b[1] = uBounds.x;
  b[2] = uBounds.y;
  b[3] = uBounds.z;
  b[4] = 1.0;
  b[uCount] = 1.0;
  int i = 0;
  while (i < uCount - 1 && fr >= b[i + 1]) i++;
  vec4 w = lvOneHot(i);
  if (!(uSoft > 0.0)) return w;
  w += lvNeighbourWeight((fr - b[i]) * uCell) * lvOneHot((i - 1 + uCount) % uCount);
  w += lvNeighbourWeight((b[i + 1] - fr) * uCell) * lvOneHot((i + 1) % uCount);
  return lvNormalized(w);
}

vec4 lvCamoWeights(vec3 p, vec3 normal) {
  if (uCount < 2) return vec4(1.0, 0.0, 0.0, 0.0);
  if (uPattern == ${PATTERN_INDEX.digital} || uPattern == ${PATTERN_INDEX.hex} || uPattern == ${PATTERN_INDEX.triangles}) return lvGrid(p, normal);
  if (uPattern == ${PATTERN_INDEX.splinter}) return lvSplinter(p);
  if (uPattern == ${PATTERN_INDEX.stripes}) return lvStripes(p);
  return lvOrganic(p);
}
`;

/**
 * Paint, step 1 (base pass, into the scratch intermediate, premultiplied): the Base (solid
 * `uColors[0]`, or camo: `uColors[0..3]` mixed by `lvCamoWeights`; a sharp organic camo keeps
 * the original `step` sum, so older projects bake bit for bit as before) as `(rgb · a, a)` with
 * `a = uBaseAlpha` (0 when the Base is hidden: the game texture shows wherever no decal covers).
 * With wear (`uWearThreshold` finite), `wearBaseColor`: a darker rim around the chips, and bare
 * metal (rust in patches) inside them.
 */
export const BASE_FRAGMENT = /* glsl */ `
${NOISE_GLSL}
varying vec3 vPos;
varying vec3 vNormal;
${WEAR_GLSL}
${CAMO_GLSL}
uniform int uMode;
uniform vec3 uColors[4];
uniform float uBaseAlpha;
uniform float uWearThreshold;
uniform vec3 uWearMetal;
uniform vec3 uWearRust;

void main() {
  vec3 color = uColors[0];
  if (uMode == 1) {
    if (uPattern == 0 && !(uSoft > 0.0)) {
      float n = lvCamoNoise(vPos * uFrequency, uint(uSeed));
      int index = int(step(uThresholds.x, n) + step(uThresholds.y, n) + step(uThresholds.z, n));
      color = uColors[index];
    } else {
      vec4 w = lvCamoWeights(vPos, vNormal);
      color = uColors[0] * w.x + uColors[1] * w.y + uColors[2] * w.z + uColors[3] * w.w;
    }
  }
  // A uniform branch: the field's derivatives stay defined.
  if (uWearThreshold < ${f(WEAR_NONE)}) {
    float field = lvWearField();
    float chip = lvChip(field, uWearThreshold);
    float rim = clamp(smoothstep(uWearThreshold - ${f(WEAR_RIM)}, uWearThreshold, field) - chip, 0.0, 1.0);
    float rust = smoothstep(${f(WEAR_RUST_FROM)}, ${f(WEAR_RUST_TO)}, lvValueNoise(vPos / ${f(WEAR_RUST_CELL)}, ${WEAR_SEED >>> 0}u));
    vec3 metal = mix(uWearMetal, uWearRust, rust);
    color = mix(color * (1.0 - ${f(WEAR_RIM_DARKEN)} * rim), metal, chip);
  }
  gl_FragColor = vec4(color * uBaseAlpha, uBaseAlpha);
}
`;
