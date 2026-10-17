import type { VehicleModelData } from '../modelBuffer';
import type { Vec3 } from '../project';
import {
  WEAR_FAR,
  WEAR_METAL,
  WEAR_NONE,
  WEAR_RIM,
  WEAR_RIM_DARKEN,
  WEAR_RUST,
  WEAR_RUST_CELL,
  WEAR_RUST_FROM,
  WEAR_RUST_TO,
  WEAR_SEED,
  chipAmount,
  valueNoise,
  wearThreshold,
} from './shaders';

/**
 * Wear's geometry and CPU mirrors (WebGL-free, Vitest covers them): which edges of the model are
 * sharp and convex (where paint chips first), each triangle's distance from its sharp edges, and
 * the Base colour the base pass writes.
 *
 * Edges are found on the whole model, every part and slot together, after welding vertices that
 * share a position (the game splits them along hard edges and UV seams): an edge shared by two
 * faces is sharp when they turn more than SHARP_EDGE_DEG from each other and the edge sticks out
 * (the other face lies behind each one's plane); an open edge (one face: a plate's rim) is sharp
 * too. Inner corners and edges shared by three faces or more are not.
 */

/** Faces turned more than this from each other make a sharp edge. */
export const SHARP_EDGE_DEG = 30;
/** Positions closer than this (metres) are one vertex for the edge search. */
export const WELD_STEP = 1e-4;

const SHARP_COS = Math.cos((SHARP_EDGE_DEG * Math.PI) / 180);
// Welded vertex ids stay far below 2^26, so a pair packs into one exact double.
const PAIR = 67108864;

/**
 * Per triangle of `model.indices` (triangle `t` = indices `3t..3t+2`), three heights: entry
 * `3t + i` is the distance from corner `i` to the opposite edge when that edge is sharp, −1
 * otherwise. A texel's distance to a sharp edge is then `bary_i · h_i` (`edgeDistance`).
 * Degenerate triangles get −1 everywhere.
 */
export function sharpEdgeHeights(model: Pick<VehicleModelData, 'positions' | 'normals' | 'indices'>): Float32Array {
  const { positions: P, normals: N, indices } = model;
  const triangles = Math.floor(indices.length / 3);
  const heights = new Float32Array(triangles * 3).fill(-1);

  // Weld by position.
  const vertexCount = Math.floor(P.length / 3);
  const welded = new Int32Array(vertexCount);
  const byKey = new Map<string, number>();
  for (let v = 0; v < vertexCount; v++) {
    const key = `${Math.round(P[v * 3]! / WELD_STEP)},${Math.round(P[v * 3 + 1]! / WELD_STEP)},${Math.round(P[v * 3 + 2]! / WELD_STEP)}`;
    let id = byKey.get(key);
    if (id === undefined) {
      id = byKey.size;
      byKey.set(key, id);
    }
    welded[v] = id;
  }

  // Face normals, turned to agree with the vertex normals (the game's winding isn't trusted).
  const faceNormals = new Float32Array(triangles * 3);
  const valid = new Uint8Array(triangles);
  const at = (v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3]!;
    const b = indices[t * 3 + 1]!;
    const c = indices[t * 3 + 2]!;
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    const [ax, ay, az] = at(a);
    const ux = P[b * 3]! - ax;
    const uy = P[b * 3 + 1]! - ay;
    const uz = P[b * 3 + 2]! - az;
    const vx = P[c * 3]! - ax;
    const vy = P[c * 3 + 1]! - ay;
    const vz = P[c * 3 + 2]! - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    const sx = N[a * 3]! + N[b * 3]! + N[c * 3]!;
    const sy = N[a * 3 + 1]! + N[b * 3 + 1]! + N[c * 3 + 1]!;
    const sz = N[a * 3 + 2]! + N[b * 3 + 2]! + N[c * 3 + 2]!;
    if (nx * sx + ny * sy + nz * sz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    faceNormals[t * 3] = nx;
    faceNormals[t * 3 + 1] = ny;
    faceNormals[t * 3 + 2] = nz;
    valid[t] = 1;
  }

  // Edges: welded pair → the (triangle, opposite corner) entries that use it.
  const edges = new Map<number, number[]>();
  for (let t = 0; t < triangles; t++) {
    if (!valid[t]) continue;
    for (let i = 0; i < 3; i++) {
      const p = welded[indices[t * 3 + ((i + 1) % 3)]!]!;
      const q = welded[indices[t * 3 + ((i + 2) % 3)]!]!;
      if (p === q) continue;
      const key = p < q ? p * PAIR + q : q * PAIR + p;
      const list = edges.get(key);
      if (list) list.push(t * 3 + i);
      else edges.set(key, [t * 3 + i]);
    }
  }

  const sharp = new Uint8Array(triangles * 3);
  for (const list of edges.values()) {
    if (list.length === 1) {
      sharp[list[0]!] = 1;
      continue;
    }
    if (list.length !== 2) continue;
    const [e1, e2] = list as [number, number];
    const t1 = Math.floor(e1 / 3);
    const t2 = Math.floor(e2 / 3);
    const n1x = faceNormals[t1 * 3]!;
    const n1y = faceNormals[t1 * 3 + 1]!;
    const n1z = faceNormals[t1 * 3 + 2]!;
    const n2x = faceNormals[t2 * 3]!;
    const n2y = faceNormals[t2 * 3 + 1]!;
    const n2z = faceNormals[t2 * 3 + 2]!;
    if (n1x * n2x + n1y * n2y + n1z * n2z > SHARP_COS) continue;
    // Convex: the other face's far corner lies behind this face's plane (and the other way round).
    const edgeVertex = indices[t1 * 3 + (((e1 % 3) + 1) % 3)]!;
    const far2 = indices[e2]!;
    const far1 = indices[e1]!;
    const [ex, ey, ez] = at(edgeVertex);
    const behind2 = (P[far2 * 3]! - ex) * n1x + (P[far2 * 3 + 1]! - ey) * n1y + (P[far2 * 3 + 2]! - ez) * n1z;
    const behind1 = (P[far1 * 3]! - ex) * n2x + (P[far1 * 3 + 1]! - ey) * n2y + (P[far1 * 3 + 2]! - ez) * n2z;
    if (behind2 < -1e-6 && behind1 < -1e-6) {
      sharp[e1] = 1;
      sharp[e2] = 1;
    }
  }

  // Heights of the sharp edges' opposite corners: 2 · area / |edge|.
  for (let t = 0; t < triangles; t++) {
    if (!valid[t]) continue;
    const corners = [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!];
    const [a, b, c] = corners.map(at) as [Vec3, Vec3, Vec3];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const doubleArea = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    for (let i = 0; i < 3; i++) {
      if (!sharp[t * 3 + i]) continue;
      const p = at(corners[(i + 1) % 3]!);
      const q = at(corners[(i + 2) % 3]!);
      const edgeLength = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (edgeLength > 0) heights[t * 3 + i] = doubleArea / edgeLength;
    }
  }
  return heights;
}

/** A texel's distance to its triangle's nearest sharp edge (the GLSL `lvEdgeDistance`). */
export function edgeDistance(bary: Vec3, heights: Vec3): number {
  let d = WEAR_FAR;
  for (let i = 0; i < 3; i++) if (heights[i]! >= 0) d = Math.min(d, bary[i]! * heights[i]!);
  return d;
}

/** The threshold uniform for a layer's wear (WEAR_NONE without wear). */
export function wearUniform(wear: number | undefined): number {
  const t = wearThreshold(wear ?? 0);
  return Number.isFinite(t) ? t : WEAR_NONE;
}

const hex = (h: string): Vec3 => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
/** WEAR_METAL and WEAR_RUST as sRGB numbers, for the base pass's uniforms. */
export const WEAR_METAL_RGB = hex(WEAR_METAL);
export const WEAR_RUST_RGB = hex(WEAR_RUST);

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The Base colour with wear at a texel (the base pass's maths, without anti-aliasing): darker in a
 * rim around the chips, bare metal inside them (rust specks where their noise is high).
 */
export function wearBaseColor(rgb: Vec3, pos: Vec3, field: number, wear: number | undefined): Vec3 {
  const threshold = wearUniform(wear);
  if (threshold >= WEAR_NONE) return rgb;
  const chip = chipAmount(field, wear!);
  const rim = Math.min(1, Math.max(0, smoothstep(threshold - WEAR_RIM, threshold, field) - chip));
  const rust = smoothstep(WEAR_RUST_FROM, WEAR_RUST_TO, valueNoise(pos[0] / WEAR_RUST_CELL, pos[1] / WEAR_RUST_CELL, pos[2] / WEAR_RUST_CELL, WEAR_SEED >>> 0));
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const metal = WEAR_METAL_RGB[i]! + (WEAR_RUST_RGB[i]! - WEAR_METAL_RGB[i]!) * rust;
    const paint = rgb[i]! * (1 - WEAR_RIM_DARKEN * rim);
    out[i] = paint + (metal - paint) * chip;
  }
  return out;
}
