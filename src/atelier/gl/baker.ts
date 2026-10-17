import * as THREE from 'three';
import type { ModelSlot } from '@/types';
import { detailMap } from '../detailMap';
import { dilate, DILATE_PX } from '../dilate';
import { decalMatrix, facingWeight, mirrorDecal, toDecalSpace } from '../decal';
import { drawGroups, type DrawGroup } from '../drawItems';
import type { VehicleModelData } from '../modelBuffer';
import {
  baseOf,
  decalRight,
  maskOf,
  partGroupOf,
  type BaseLayer,
  type Decal,
  type Layer,
  type ShapeLayer,
  type Stroke,
  type TextLayer,
  type Vec3,
} from '../project';
import { rasteriseShape as defaultRasteriseShape, shapeKey } from '../shapes';
import { loadFont, MAX_RASTER_SIDE, MIN_RASTER_HEIGHT, rasterHeightFor, rasterise } from '../text';
import { BASE_FRAGMENT, camoParams, type CamoParams } from './camo';
import { DecalTextureCache, PREVIEW_DECAL_MAX, type DecalImage } from './decalTextures';
import {
  BAKE_MAX_POINTS,
  BAKE_VERTEX,
  brushWeight,
  COUNT_FRAGMENT,
  COVERAGE_FRAGMENT,
  DECAL_FRAGMENT,
  FACING_MIN,
  FINAL_FRAGMENT,
  FOOTPRINT_FRAGMENT,
  FOOTPRINT_SIZE,
  GROUP_INDEX,
  MASK_FRAGMENT,
  OVERLAP_SIZE,
  PREVIEW_MAP_FRAGMENT,
  PREVIEW_UNIFORMS,
} from './shaders';
import { WEAR_METAL_RGB, WEAR_RUST_RGB, sharpEdgeHeights, wearUniform } from './wear';

/**
 * The GPU bake of an Atelier project (spec §2 "Bake", plan Task 20), on three.js.
 *
 * Per enabled slot (a `_c` texture of the model):
 * - an **unwrapped geometry** (non-indexed, triangles shifted into 0..1 UV on the CPU, wrap
 *   copies for triangles crossing a tile edge) drawn with `gl_Position = uv · 2 − 1`;
 * - a **mask** target (R8, the slot's full size, persistent): Protected-area strokes stamped as
 *   model-space spheres, paint with `MaxEquation`, erase with `MinEquation` (`1 − w`), so
 *   incremental stamping while painting equals a full replay; replays happen only when the
 *   stroke list changes in a way that isn't an append (undo, clear, edit);
 * - a **paint** target (RGBA8, sRGB numbers, `NoColorSpace`), composited in three steps through
 *   a scratch **intermediate** (RGBA8, premultiplied, one per exact size, shared by the slots):
 *   the Base (solid or 3D-noise camo; alpha 0 when hidden), then every draw group
 *   (`drawGroups`, drawItems.ts: one picture of an image, text or shape layer or of a merged
 *   object's piece, with all its repeat and mirror boxes) in layer order, projected through each
 *   box and blended `ONE, ONE_MINUS_SRC_ALPHA`, then a final pass: × template detail factor,
 *   alpha × (1 − mask). Past the draw budget the topmost layers aren't drawn (`truncated`).
 *   At most 1024 px while editing; the focused slot (the body by default) also gets a full-size
 *   target, rendered `UPGRADE_DELAY_MS` after the last change;
 * - a **preview** material (`MeshStandardMaterial` + `onBeforeCompile`) showing
 *   `mix(template, paint, paint.a)` with the raw UVs of the model, so protected areas show the
 *   game's texture; disabled slots and the Template toggle show the template alone. Preview
 *   targets hold premultiplied colour, so filtering at island edges doesn't darken them.
 *
 * Export (`bakeForExport`) renders a temporary target at the output size (straight alpha), reads
 * it back top-to-bottom (DirectX v = 0 is row 0, no flip), renders a coverage pass and dilates 4 px.
 *
 * `upgrade()` brings the focused slot's full-size target up to date right away (instead of
 * `UPGRADE_DELAY_MS` after the last change): call it before rendering a thumbnail.
 *
 * Decal pictures (`decalTextures.ts`) load asynchronously: image assets through
 * `options.loadAsset`, text through `options.rasteriseText` (font + raster), shapes through
 * `options.rasteriseShape`; a draw group keeps showing its previous picture until the new one is
 * ready, and the slots re-bake when one arrives. Draw groups are rebuilt whenever their layer
 * object changes (a rename, typing, a colour), so the Baker compares them by value: draws are
 * recomputed only when a group's boxes moved, texel densities are cached by box geometry, and
 * the paint re-renders only when a group's picture, boxes, opacity, flip or wear changed.
 * `whenReady()` resolves once the pictures the current groups need are loaded;
 * `prepareExport()` loads full-size copies (pictures, text and shapes at export resolution) that
 * `bakeForExport` uses until `endExport()`. `decalTouchesSharedTexels(decal)` tells whether a
 * decal lands on texels more than one triangle draws (mirrored or repeated UVs), from a
 * per-slot overlap map built once.
 *
 * WebGL context loss: the Baker listens to `webglcontextrestored` on `renderer.domElement`
 * (after three's own listener, registered when the renderer was created, has rebuilt its
 * state), drops every GPU resource whose contents were lost and re-bakes from the last
 * `setLayers`. While the context is lost nothing renders and `bakeForExport` throws.
 *
 * WebGL-free logic lives in the exported helpers below (Vitest covers them without a GPU).
 */

export interface TemplateImage {
  /** RGBA8, top-to-bottom (row 0 = DirectX v = 0). */
  rgba: Uint8Array;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface BakeResult {
  /** RGBA8, top-to-bottom, sRGB bytes ready for the DDS encoder. */
  rgba: Uint8Array;
  w: number;
  h: number;
  /** The GPU couldn't render the asked size: the slot was baked at 2048 instead. */
  downscaled: boolean;
}

export interface BakerOptions {
  /** Called after a preview texture or uniform changed (the viewport should render a frame). */
  onUpdate?: () => void;
  /** A project picture (image layers) as straight-alpha RGBA; without it image layers draw nothing. */
  loadAsset?: (assetId: string) => Promise<DecalImage>;
  /**
   * A text layer drawn `pxHeight` tall (straight alpha), null when there's nothing to draw.
   * Defaults to loading its font (`loadFont`) and `rasterise`.
   */
  rasteriseText?: (layer: TextLayer, pxHeight: number) => Promise<DecalImage | null>;
  /**
   * A shape layer (`variant` picks its repeat's alternate colour) drawn for a frame of `frame`
   * metres, `px` tall (straight alpha), null when there's nothing to draw. Defaults to
   * `rasteriseShape` (shapes.ts).
   */
  rasteriseShape?: (
    layer: ShapeLayer,
    variant: 'main' | 'alt',
    frame: { width: number; height: number },
    px: number,
  ) => Promise<DecalImage | null>;
}

/** The default text rasteriser: the layer's font (or the fallback), then the canvas raster. */
async function defaultRasteriseText(layer: TextLayer, pxHeight: number): Promise<DecalImage | null> {
  await loadFont(layer.font);
  const raster = rasterise(layer, pxHeight);
  return raster ? { rgba: raster.rgba, w: raster.width, h: raster.height } : null;
}

/** `bakeForExport` with a visible decal whose full-size picture `prepareExport` didn't load. */
export const EXPORT_PICTURE_NOT_READY = 'Baker: a decal picture for the export is not ready (call prepareExport first)';

/** Largest side of the paint targets while editing (and of every non-focused slot). */
export const PREVIEW_MAX = 1024;
/** High quality raises the body slot to this size when its template is smaller. */
export const HQ_SIZE = 4096;
/** Export size when the GPU can't render the asked one. */
export const FALLBACK_SIZE = 2048;
/** The focused slot is re-baked at full size this long after the last change. */
export const UPGRADE_DELAY_MS = 300;
/** Rows read back per `readPixels` call in the coverage pass (bounded temporary buffer). */
const COVERAGE_STRIP_ROWS = 256;

// ================================================================ pure helpers

/** The body slot: the texture whose name ends in `_body_c` (High quality applies to it only). */
export function isBodySlot(texture: string): boolean {
  return texture.endsWith('_body_c');
}

/** `size` scaled so its larger side is at most `max` (aspect kept, at least 1 px). */
export function fitSize(size: Size, max: number): Size {
  const larger = Math.max(size.w, size.h);
  if (larger <= max) return { w: size.w, h: size.h };
  return { w: Math.max(1, Math.round((size.w * max) / larger)), h: Math.max(1, Math.round((size.h * max) / larger)) };
}

/** The slot's full size: its decoded template's, else the header's. */
export function slotFullSize(slot: ModelSlot, template?: TemplateImage): Size {
  return template ? { w: template.w, h: template.h } : { w: slot.width, h: slot.height };
}

/**
 * Output size of a slot: its full size; High quality raises a body slot below 4096 to 4096
 * (aspect kept); above the GPU's `maxTextureSize` it falls back to 2048 and says so.
 */
export function exportSize(full: Size, texture: string, highQuality: boolean, maxTextureSize: number): Size & { downscaled: boolean } {
  let size = { w: full.w, h: full.h };
  const larger = Math.max(size.w, size.h);
  if (highQuality && isBodySlot(texture) && larger < HQ_SIZE && larger > 0) {
    size = { w: Math.round((size.w * HQ_SIZE) / larger), h: Math.round((size.h * HQ_SIZE) / larger) };
  }
  if (Math.max(size.w, size.h) > maxTextureSize) {
    return { ...fitSize(size, Math.min(FALLBACK_SIZE, maxTextureSize)), downscaled: true };
  }
  return { ...size, downscaled: false };
}

/** `#rrggbb` as sRGB numbers 0..1 (never through a linear conversion). */
export function hexToSrgb(hex: string): Vec3 {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** The paint pass's Base uniforms: the camo maths (`camoParams`, camo.ts) plus the colours. */
export interface BaseUniforms extends CamoParams {
  /** 0 solid, 1 camo. */
  mode: number;
  /** Four sRGB colours (x, y, z each), unused ones repeat the last. */
  colors: Float32Array;
  /** 0 when the Base is hidden or missing (nothing painted). */
  alpha: number;
}

export function baseUniforms(base: BaseLayer | undefined): BaseUniforms {
  const colors = new Float32Array(12);
  const list = base && base.colors.length > 0 ? base.colors : ['#000000'];
  const camo = camoParams(base);
  for (let i = 0; i < 4; i++) colors.set(hexToSrgb(list[Math.min(i, camo.count - 1)]!), i * 3);
  return {
    ...camo,
    mode: camo.count >= 2 ? 1 : 0,
    colors,
    alpha: base && base.visible ? 1 : 0,
  };
}

/** The unwrapped, non-indexed geometry of one slot. */
export interface UnwrappedGeometry {
  positions: Float32Array;
  normals: Float32Array;
  /** Shifted into 0..1 per triangle (`uv − floor(min uv)`), plus wrap copies. */
  uvs: Float32Array;
  /** `GROUP_INDEX` of the vertex's part. */
  groups: Float32Array;
  /** Per vertex: its triangle's centroid (xyz) and bounding radius (w), for batch culling. */
  spheres: Float32Array;
  /** Per vertex: its corner of the triangle as barycentric coordinates (1,0,0), (0,1,0) or (0,0,1). */
  bary: Float32Array;
  /** Per vertex: its triangle's three sharp-edge heights (`sharpEdgeHeights`, −1 = not sharp). */
  edgeHeights: Float32Array;
  vertexCount: number;
}

/** UV tiles a shifted triangle reaches along one axis (1 or 2: wider triangles are clipped). */
function tilesSpanned(max: number): number {
  return max > 1 ? 2 : 1;
}

/**
 * The triangles of every part drawn with slot `slotIndex`, unindexed, with UVs outside 0..1
 * shifted per triangle by `−floor(min u)`, `−floor(min v)`. A triangle still crossing the
 * 1.0 edge after the shift is drawn a second time one tile back (and a fourth time when it
 * crosses both), so the texels past the edge (which the game wraps to the other side) are baked.
 * Triangles with non-finite UVs are skipped. `heights` (`sharpEdgeHeights` of the model) gives
 * each triangle its sharp edges for wear; without it no edge is sharp.
 */
export function buildUnwrapped(model: VehicleModelData, slotIndex: number, heights?: Float32Array): UnwrappedGeometry {
  const { positions: P, normals: N, uvs: T, indices, header } = model;
  const parts = header.parts.filter((p) => p.slot === slotIndex);

  const finite = (a: number, b: number, c: number) => Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c);
  let triangles = 0;
  for (const part of parts) {
    for (let k = part.indexOffset; k < part.indexOffset + part.indexCount; k += 3) {
      const a = indices[k]!;
      const b = indices[k + 1]!;
      const c = indices[k + 2]!;
      const u0 = T[a * 2]!;
      const u1 = T[b * 2]!;
      const u2 = T[c * 2]!;
      const v0 = T[a * 2 + 1]!;
      const v1 = T[b * 2 + 1]!;
      const v2 = T[c * 2 + 1]!;
      if (!finite(u0, u1, u2) || !finite(v0, v1, v2)) continue;
      const su = Math.floor(Math.min(u0, u1, u2));
      const sv = Math.floor(Math.min(v0, v1, v2));
      triangles += tilesSpanned(Math.max(u0, u1, u2) - su) * tilesSpanned(Math.max(v0, v1, v2) - sv);
    }
  }

  const vertexCount = triangles * 3;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const groups = new Float32Array(vertexCount);
  const spheres = new Float32Array(vertexCount * 4);
  const bary = new Float32Array(vertexCount * 3);
  const edgeHeights = new Float32Array(vertexCount * 3).fill(-1);
  let out = 0;
  const corner = [0, 0, 0];
  for (const part of parts) {
    const group = GROUP_INDEX[part.group];
    for (let k = part.indexOffset; k < part.indexOffset + part.indexCount; k += 3) {
      corner[0] = indices[k]!;
      corner[1] = indices[k + 1]!;
      corner[2] = indices[k + 2]!;
      const [a, b, c] = corner as [number, number, number];
      const u0 = T[a * 2]!;
      const u1 = T[b * 2]!;
      const u2 = T[c * 2]!;
      const v0 = T[a * 2 + 1]!;
      const v1 = T[b * 2 + 1]!;
      const v2 = T[c * 2 + 1]!;
      if (!finite(u0, u1, u2) || !finite(v0, v1, v2)) continue;
      const su = Math.floor(Math.min(u0, u1, u2));
      const sv = Math.floor(Math.min(v0, v1, v2));
      const tilesU = tilesSpanned(Math.max(u0, u1, u2) - su);
      const tilesV = tilesSpanned(Math.max(v0, v1, v2) - sv);
      // Bounding sphere around the centroid.
      const cx = (P[a * 3]! + P[b * 3]! + P[c * 3]!) / 3;
      const cy = (P[a * 3 + 1]! + P[b * 3 + 1]! + P[c * 3 + 1]!) / 3;
      const cz = (P[a * 3 + 2]! + P[b * 3 + 2]! + P[c * 3 + 2]!) / 3;
      let radius = 0;
      for (const i of corner) {
        const dx = P[i * 3]! - cx;
        const dy = P[i * 3 + 1]! - cy;
        const dz = P[i * 3 + 2]! - cz;
        radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      const triangle = k / 3;
      for (let tu = 0; tu < tilesU; tu++) {
        for (let tv = 0; tv < tilesV; tv++) {
          for (let n = 0; n < 3; n++) {
            const i = corner[n]!;
            bary[out * 3 + n] = 1;
            if (heights) edgeHeights.set(heights.subarray(triangle * 3, triangle * 3 + 3), out * 3);
            positions[out * 3] = P[i * 3]!;
            positions[out * 3 + 1] = P[i * 3 + 1]!;
            positions[out * 3 + 2] = P[i * 3 + 2]!;
            normals[out * 3] = N[i * 3]!;
            normals[out * 3 + 1] = N[i * 3 + 1]!;
            normals[out * 3 + 2] = N[i * 3 + 2]!;
            uvs[out * 2] = T[i * 2]! - su - tu;
            uvs[out * 2 + 1] = T[i * 2 + 1]! - sv - tv;
            groups[out] = group;
            spheres[out * 4] = cx;
            spheres[out * 4 + 1] = cy;
            spheres[out * 4 + 2] = cz;
            spheres[out * 4 + 3] = radius;
            out++;
          }
        }
      }
    }
  }
  return { positions, normals, uvs, groups, spheres, bary, edgeHeights, vertexCount };
}

/** `[start, count]` of each stamping batch covering points `from..to` (at most 64 each). */
export function batchRanges(from: number, to: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = from; start < to; start += BAKE_MAX_POINTS) ranges.push([start, Math.min(BAKE_MAX_POINTS, to - start)]);
  return ranges;
}

/**
 * Packs points `start..start+count` of a stroke into `out` (x, y, z, radius per point, the
 * `uPoints` uniform) and their bounding sphere into `sphere` (centre xyz, radius incl. the
 * brush radius: the `uSphere` uniform used to cull triangles).
 */
export function packBatch(points: readonly Vec3[], start: number, count: number, radius: number, out: Float32Array, sphere: Float32Array): void {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    const p = points[start + i]!;
    out[i * 4] = p[0];
    out[i * 4 + 1] = p[1];
    out[i * 4 + 2] = p[2];
    out[i * 4 + 3] = radius;
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const inv = count > 0 ? 1 / count : 0;
  cx *= inv;
  cy *= inv;
  cz *= inv;
  let far = 0;
  for (let i = 0; i < count; i++) {
    const p = points[start + i]!;
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const dz = p[2] - cz;
    far = Math.max(far, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  sphere[0] = cx;
  sphere[1] = cy;
  sphere[2] = cz;
  sphere[3] = far + radius;
}

/** The `GROUP_INDEX` a stroke is limited to, −1 for every part (`all` or an unknown kind). */
export function strokeGroup(stroke: Stroke): number {
  const group = partGroupOf(stroke.part);
  return group === null ? -1 : GROUP_INDEX[group];
}

/** `uParams` of a stroke: hardness, erase (0/1), part group (−1 = all), point count of the batch. */
export function strokeParams(stroke: Stroke, count: number, out: Float32Array): void {
  out[0] = stroke.hardness;
  out[1] = stroke.erase ? 1 : 0;
  out[2] = strokeGroup(stroke);
  out[3] = count;
}

/** The stroke's direction, normalised (`uDir`); a zero vector becomes (0, 0, −1). */
export function normalizedDir(dir: Vec3, out: Float32Array): void {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = -1;
    return;
  }
  out[0] = dir[0] / len;
  out[1] = dir[1] / len;
  out[2] = dir[2] / len;
}

/** A texel of a slot as the mask shader sees it. */
export interface MaskTexel {
  pos: Vec3;
  normal: Vec3;
  /** `GROUP_INDEX` of its part. */
  group: number;
}

/** Mirror of `MASK_FRAGMENT`: the weight of points `start..start+count` of a stroke on a texel. */
export function stampWeight(stroke: Stroke, start: number, count: number, texel: MaskTexel): number {
  const group = strokeGroup(stroke);
  if (group >= 0 && group !== texel.group) return 0;
  const dir = new Float32Array(3);
  normalizedDir(stroke.dir, dir);
  const nl = Math.hypot(texel.normal[0], texel.normal[1], texel.normal[2]);
  if (nl === 0) return 0;
  const facing = -(texel.normal[0] * dir[0]! + texel.normal[1] * dir[1]! + texel.normal[2] * dir[2]!) / nl;
  if (facing <= FACING_MIN) return 0;
  let w = 0;
  for (let i = start; i < start + count; i++) {
    const p = stroke.points[i]!;
    const d = Math.hypot(texel.pos[0] - p[0], texel.pos[1] - p[1], texel.pos[2] - p[2]);
    w = Math.max(w, brushWeight(d, stroke.radius, stroke.hardness));
  }
  return w;
}

/** One stamping draw on a texel's mask value: `max(m, w)` to paint, `min(m, 1 − w)` to erase. */
export function applyStamp(value: number, stroke: Stroke, start: number, count: number, texel: MaskTexel): number {
  const w = stampWeight(stroke, start, count, texel);
  if (w <= 0) return value;
  return stroke.erase ? Math.min(value, 1 - w) : Math.max(value, w);
}

/** Reference mask value of a texel: every stroke in order, all its points at once (a replay). */
export function maskAt(strokes: readonly Stroke[], texel: MaskTexel): number {
  let m = 0;
  for (const s of strokes) m = applyStamp(m, s, 0, s.points.length, texel);
  return m;
}

/** A stroke stamped into a slot's mask, and how many of its points. */
export interface StampRecord {
  stroke: Stroke;
  stamped: number;
}

export type MaskPlan = { replay: true } | { replay: false; ops: { stroke: number; from: number }[] };

/** Same brush settings (the points aside). */
export function sameStrokeParams(a: Stroke, b: Stroke): boolean {
  return (
    a.erase === b.erase &&
    a.radius === b.radius &&
    a.hardness === b.hardness &&
    a.part === b.part &&
    a.dir[0] === b.dir[0] &&
    a.dir[1] === b.dir[1] &&
    a.dir[2] === b.dir[2]
  );
}

function samePoints(a: readonly Vec3[], b: readonly Vec3[], count: number): boolean {
  for (let i = 0; i < count; i++) {
    const p = a[i];
    const q = b[i];
    if (p === q) continue;
    if (!p || !q || p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2]) return false;
  }
  return true;
}

/**
 * How to bring a mask that holds `records` to `strokes`: when the strokes only grew (new points
 * on the last stamped stroke, new strokes after it) the missing points are stamped in order;
 * anything else (undo, clear, an earlier stroke changed) needs a replay (clear + every stroke).
 */
export function planMaskUpdate(records: readonly StampRecord[], strokes: readonly Stroke[]): MaskPlan {
  if (records.length > strokes.length) return { replay: true };
  const ops: { stroke: number; from: number }[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const s = strokes[i]!;
    if (r.stroke !== s) {
      if (!sameStrokeParams(r.stroke, s) || r.stamped > s.points.length || !samePoints(r.stroke.points, s.points, r.stamped)) {
        return { replay: true };
      }
    } else if (r.stamped > s.points.length) {
      return { replay: true };
    }
    if (r.stamped < s.points.length) {
      // Only the last stamped stroke may still grow: stamping an earlier one now would land
      // after the strokes that follow it.
      if (i < records.length - 1) return { replay: true };
      ops.push({ stroke: i, from: r.stamped });
    }
  }
  for (let i = records.length; i < strokes.length; i++) ops.push({ stroke: i, from: 0 });
  return { replay: false, ops };
}

/** The visible mask strokes of the layers (a hidden mask protects nothing). */
export function visibleStrokes(layers: readonly Layer[]): Stroke[] {
  const mask = maskOf(layers);
  return mask && mask.visible ? mask.strokes : [];
}

// ---------------------------------------------------------------- decals (pure)

/** A decal's `uPart`: the group index it's limited to, −1 for every part. */
export function decalGroupIndex(decal: Decal): number {
  const group = partGroupOf(decal.part);
  return group === null ? -1 : GROUP_INDEX[group];
}

/** The bounding sphere of a decal's box (centre xyz, radius), the `uSphere` that culls its draw. */
export function decalSphere(decal: Decal): [number, number, number, number] {
  return [decal.center[0], decal.center[1], decal.center[2], 0.5 * Math.hypot(decal.width, decal.height, decal.depth)];
}

/** The decal box itself and, with Mirror on, its copy across the model's mirror plane (none for an invalid axis). */
export function decalCopies(decal: Decal, mirrorAxis: number): Decal[] {
  const copy = decal.mirror ? mirrorDecal(decal, mirrorAxis) : null;
  return copy ? [decal, copy] : [decal];
}

/** A texel as the decal shader sees it. */
export interface DecalTexel {
  pos: Vec3;
  normal: Vec3;
  /** `GROUP_INDEX` of its part. */
  group: number;
}

/**
 * Mirror of `DECAL_FRAGMENT`'s tests: where the decal's picture is sampled for a texel (texture
 * coordinates, top-left origin) and how much of it the texel takes (`weight`, the facing fade),
 * or null when the texel is of another part, lies outside the box or takes none of it.
 */
export function decalSample(texel: DecalTexel, decal: Decal, flipX: boolean): { uv: [number, number]; weight: number } | null {
  const group = decalGroupIndex(decal);
  if (group >= 0 && group !== texel.group) return null;
  const [u, v, w] = toDecalSpace(texel.pos, decal);
  if (Math.abs(u) > 0.5 || Math.abs(v) > 0.5 || Math.abs(w) > 0.5) return null;
  const weight = facingWeight(texel.normal, decal);
  if (weight <= 0) return null;
  return { uv: [(flipX ? -u : u) + 0.5, 0.5 - v], weight };
}

/** `decalSample`'s texture coordinates only. */
export function decalSampleUv(texel: DecalTexel, decal: Decal, flipX: boolean): [number, number] | null {
  return decalSample(texel, decal, flipX)?.uv ?? null;
}

/** A decal's contribution to the composite: its premultiplied sample × opacity × facing weight. */
export function decalContribution(sample: Rgba, opacity: number, weight: number): Rgba {
  const k = opacity * weight;
  return [sample[0] * k, sample[1] * k, sample[2] * k, sample[3] * k];
}

/** Premultiplied RGBA, 0..1. */
export type Rgba = [number, number, number, number];

/**
 * Mirror of the three paint steps for one texel, in 0..1: the Base (`rgb`, alpha 0 or 1), the
 * decal contributions in layer order (`decalContribution`: premultiplied, × opacity × facing
 * weight) blended `ONE,
 * ONE_MINUS_SRC_ALPHA`, then × detail and × (1 − mask). Premultiplied output for the preview,
 * straight for export. `quantise` rounds the intermediate to 8 bits after each step like the
 * RGBA8 target does.
 */
export function compositeTexel(
  base: { rgb: Vec3; alpha: number },
  decals: readonly Rgba[],
  detail: number,
  mask: number,
  premultiplied: boolean,
  quantise = false,
): Rgba {
  const q = (v: number) => (quantise ? Math.round(Math.min(1, Math.max(0, v)) * 255) / 255 : v);
  let p: Rgba = [q(base.rgb[0] * base.alpha), q(base.rgb[1] * base.alpha), q(base.rgb[2] * base.alpha), q(base.alpha)];
  for (const d of decals) {
    const k = 1 - d[3];
    p = [q(d[0] + p[0] * k), q(d[1] + p[1] * k), q(d[2] + p[2] * k), q(d[3] + p[3] * k)];
  }
  const straight: Vec3 = p[3] > 0 ? [0, 1, 2].map((i) => Math.min(1, Math.max(0, (p[i]! * detail) / p[3]))) as Vec3 : [0, 0, 0];
  const alpha = p[3] * (1 - mask);
  return premultiplied ? [straight[0] * alpha, straight[1] * alpha, straight[2] * alpha, alpha] : [straight[0], straight[1], straight[2], alpha];
}

/** Text raster heights snap to quarter octaves, so resizing a text decal doesn't re-rasterise on every step. */
export function quantiseRasterHeight(px: number): number {
  const clamped = Math.min(MAX_RASTER_SIDE, Math.max(MIN_RASTER_HEIGHT, px));
  const snapped = Math.pow(2, Math.ceil(Math.log2(clamped) * 4 - 1e-9) / 4);
  return Math.round(Math.min(MAX_RASTER_SIDE, Math.max(MIN_RASTER_HEIGHT, snapped)));
}

/** Cache key of an image layer's picture (preview copy or full size). */
export function imageKey(assetId: string, full: boolean): string {
  return `img:${assetId}:${full ? 'f' : 'p'}`;
}

/**
 * Cache key of a text layer's raster: everything that changes its pixels, its height, and
 * whether it is the preview copy (capped at PREVIEW_DECAL_MAX) or the export one.
 */
export function textKey(
  layer: Pick<TextLayer, 'text' | 'font' | 'color' | 'outlineColor' | 'outlineWidth' | 'skew'>,
  px: number,
  full: boolean,
): string {
  return `txt:${JSON.stringify([layer.text, layer.font.family, layer.font.style, layer.color, layer.outlineColor, layer.outlineWidth, layer.skew])}:${px}:${full ? 'f' : 'p'}`;
}

// ---------------------------------------------------------------- texel density (pure)

/** Floats per triangle in a `DensityTable`: centre xyz, bounding radius, world area, UV area, group. */
const DENSITY_STRIDE = 7;

/** Per-triangle data of one slot for texel densities, computed once per model. */
export interface DensityTable {
  data: Float32Array;
  count: number;
}

/** The density table of slot `slot` (raw UVs: shifting islands doesn't change UV areas). */
export function densityTable(model: Pick<VehicleModelData, 'header' | 'positions' | 'uvs' | 'indices'>, slot: number): DensityTable {
  const { positions: P, uvs: T, indices } = model;
  const parts = model.header.parts.filter((p) => p.slot === slot);
  const count = parts.reduce((n, p) => n + p.indexCount / 3, 0);
  const data = new Float32Array(count * DENSITY_STRIDE);
  let o = 0;
  for (const part of parts) {
    const group = GROUP_INDEX[part.group];
    for (let k = part.indexOffset; k < part.indexOffset + part.indexCount; k += 3) {
      const a = indices[k]!;
      const b = indices[k + 1]!;
      const c = indices[k + 2]!;
      const ax = P[a * 3]!, ay = P[a * 3 + 1]!, az = P[a * 3 + 2]!;
      const bx = P[b * 3]!, by = P[b * 3 + 1]!, bz = P[b * 3 + 2]!;
      const cx = P[c * 3]!, cy = P[c * 3 + 1]!, cz = P[c * 3 + 2]!;
      const mx = (ax + bx + cx) / 3;
      const my = (ay + by + cy) / 3;
      const mz = (az + bz + cz) / 3;
      const r = Math.sqrt(
        Math.max(
          (ax - mx) ** 2 + (ay - my) ** 2 + (az - mz) ** 2,
          (bx - mx) ** 2 + (by - my) ** 2 + (bz - mz) ** 2,
          (cx - mx) ** 2 + (cy - my) ** 2 + (cz - mz) ** 2,
        ),
      );
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const world = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      const ua = T[a * 2]!, va = T[a * 2 + 1]!;
      const uv = Math.abs((T[b * 2]! - ua) * (T[c * 2 + 1]! - va) - (T[c * 2]! - ua) * (T[b * 2 + 1]! - va)) / 2;
      data[o] = mx;
      data[o + 1] = my;
      data[o + 2] = mz;
      data[o + 3] = r;
      data[o + 4] = world;
      data[o + 5] = uv;
      data[o + 6] = group;
      o += DENSITY_STRIDE;
    }
  }
  return { data, count };
}

/**
 * Texels per model unit around a decal on one slot rendered at `output`: the same as
 * `texelsPerUnit` in decal.ts (`sqrt(Σ UV area × pixels / Σ world area)` over the triangles whose
 * bounding sphere touches the decal's box, limited to its part group) from a precomputed table,
 * with a sphere-to-sphere prefilter and no allocations per triangle. Null when nothing has area.
 */
export function slotDensity(table: DensityTable, decal: Decal, output: { width: number; height: number }): number | null {
  const [rx, ry, rz] = decalRight(decal);
  const [ux, uy, uz] = decal.up;
  const [nx, ny, nz] = decal.normal;
  const [ox, oy, oz] = decal.center;
  const hw = decal.width / 2;
  const hh = decal.height / 2;
  const hd = decal.depth / 2;
  const boxRadius = Math.sqrt(hw * hw + hh * hh + hd * hd);
  const group = decalGroupIndex(decal);
  const d = table.data;
  let world = 0;
  let uv = 0;
  for (let i = 0, o = 0; i < table.count; i++, o += DENSITY_STRIDE) {
    if (group >= 0 && d[o + 6] !== group) continue;
    const r = d[o + 3]!;
    const px = d[o]! - ox;
    const py = d[o + 1]! - oy;
    const pz = d[o + 2]! - oz;
    const reach = r + boxRadius;
    if (px * px + py * py + pz * pz > reach * reach) continue;
    let dist2 = 0;
    let e = Math.abs(px * rx + py * ry + pz * rz) - hw;
    if (e > 0) dist2 += e * e;
    e = Math.abs(px * ux + py * uy + pz * uz) - hh;
    if (e > 0) dist2 += e * e;
    e = Math.abs(px * nx + py * ny + pz * nz) - hd;
    if (e > 0) dist2 += e * e;
    if (dist2 > r * r) continue;
    world += d[o + 4]!;
    uv += d[o + 5]!;
  }
  if (world <= 0 || uv <= 0) return null;
  return Math.sqrt((uv * output.width * output.height) / world);
}

/** Most entries the texel density cache keeps before it starts over. */
const DENSITY_CACHE_MAX = 4096;

/** Rounds to 1e-9 (the box geometry keys and comparisons ignore float noise below it). */
const nano = (v: number) => Math.round(v * 1e9);

/** A box's geometry as a string: what the texel density around it depends on (mirror aside). */
export function decalGeometryKey(d: Decal): string {
  const n = nano;
  return `${n(d.center[0])},${n(d.center[1])},${n(d.center[2])};${n(d.normal[0])},${n(d.normal[1])},${n(d.normal[2])};${n(d.up[0])},${n(d.up[1])},${n(d.up[2])};${n(d.width)},${n(d.height)},${n(d.depth)};${d.part}`;
}

function sameVec(a: Vec3, b: Vec3): boolean {
  return nano(a[0]) === nano(b[0]) && nano(a[1]) === nano(b[1]) && nano(a[2]) === nano(b[2]);
}

/** Same boxes, element by element, by value (within 1e-9): their draws are the same. */
export function sameBoxes(a: readonly Decal[], b: readonly Decal[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p === q) continue;
    if (
      !sameVec(p.center, q.center) ||
      !sameVec(p.normal, q.normal) ||
      !sameVec(p.up, q.up) ||
      nano(p.width) !== nano(q.width) ||
      nano(p.height) !== nano(q.height) ||
      nano(p.depth) !== nano(q.depth) ||
      p.part !== q.part ||
      p.mirror !== q.mirror
    ) {
      return false;
    }
  }
  return true;
}

// ================================================================ the Baker

/** One draw of a decal box (a repeat copy or a mirror copy of a group): uniforms ready to set. */
interface DecalDraw {
  matrix: THREE.Matrix4;
  normal: THREE.Vector3;
  sphere: THREE.Vector4;
  part: number;
}

/** What the Baker holds for a draw group (keyed by `group.id`). */
interface LayerBinding {
  group: DrawGroup;
  /** The picture it needs now (a reference is held). */
  key: string;
  /** The picture drawn now: `key` once settled, the previous one until then (a reference is held). */
  shown: string | null;
  /** The boxes the draws were computed from (equal by value to `group.boxes`). */
  boxes: Decal[];
  draws: DecalDraw[];
}

interface SlotState {
  index: number;
  slot: ModelSlot;
  full: Size;
  templateImage: TemplateImage | undefined;
  template: THREE.Texture;
  /** Built when the slot is first enabled (or exported). */
  geometry: THREE.BufferGeometry | null;
  scene: THREE.Scene | null;
  mesh: THREE.Mesh | null;
  detail: THREE.DataTexture | null;
  enabled: boolean;
  mask: THREE.WebGLRenderTarget | null;
  records: StampRecord[];
  /** False when the mask target doesn't match `records` (next `setLayers` replays). */
  maskValid: boolean;
  /** ≤ PREVIEW_MAX, rendered on every change. */
  paintSmall: THREE.WebGLRenderTarget | null;
  /** Full size, focused slot only (when larger than PREVIEW_MAX). */
  paintFull: THREE.WebGLRenderTarget | null;
  /** Bumped on every change of what the paint shows. */
  version: number;
  smallVersion: number;
  fullVersion: number;
  preview: THREE.MeshStandardMaterial;
  previewUniforms: { uPaint: THREE.IUniform<THREE.Texture>; uPaintMix: THREE.IUniform<number> };
  /** Triangles per texel at OVERLAP_SIZE² (R8, k/255), built on the first shared-texel check. */
  overlap: THREE.WebGLRenderTarget | null;
}

/** `onUpdate` of textures whose CPU copy isn't needed once on the GPU. */
function releaseImageData(texture: THREE.Texture): void {
  (texture.image as { data: unknown }).data = null;
}

function makeDataTexture(data: Uint8Array, w: number, h: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

export class Baker {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly model: VehicleModelData;
  /** The model's sharp edges for wear (`sharpEdgeHeights`), found when the first slot's geometry is built. */
  private edgeHeights: Float32Array | null = null;
  private readonly options: BakerOptions;
  private readonly slots: SlotState[];
  private readonly byTexture = new Map<string, SlotState>();
  private readonly camera = new THREE.Camera();
  private readonly baseMaterial: THREE.ShaderMaterial;
  private readonly decalMaterial: THREE.ShaderMaterial;
  private readonly finalMaterial: THREE.ShaderMaterial;
  private readonly maskMaterial: THREE.ShaderMaterial;
  private readonly coverageMaterial: THREE.ShaderMaterial;
  private readonly countMaterial: THREE.ShaderMaterial;
  private readonly footprintMaterial: THREE.ShaderMaterial;
  private readonly decalTextures: DecalTextureCache;
  /** Drawn groups, bottom to top. */
  private decalOrder: LayerBinding[] = [];
  /** By group id. */
  private readonly bindings = new Map<string, LayerBinding>();
  /** The last draw plan left the topmost layers out (draw budget). */
  private planTruncated = false;
  /** Full-size pictures per group id between `prepareExport` and `endExport`. */
  private exportKeys: Map<string, string> | null = null;
  /** Scratch intermediates by exact size (`w×h`). */
  private readonly scratches = new Map<string, THREE.WebGLRenderTarget>();
  private footprintTarget: THREE.WebGLRenderTarget | null = null;
  /**
   * Texel density around a box (max over the slots), by output (`p`, `f`, `fhq`) and box geometry
   * (`decalGeometryKey`): rebuilt groups bring new box objects with the same values.
   */
  private readonly densities = new Map<string, number | null>();
  /** High quality of the export `prepareExport` prepares (the body's output size). */
  private exportHighQuality = false;
  /** Texel density tables per slot index (built on the first text layer). */
  private readonly densityTables = new Map<number, DensityTable>();
  private readonly emptyPaint: THREE.DataTexture;
  /** Reused per stamping draw (no allocations while painting). */
  private readonly pointsBuffer = new Float32Array(BAKE_MAX_POINTS * 4);
  private readonly sphereBuffer = new Float32Array(4);
  private readonly paramsBuffer = new Float32Array(4);
  private readonly dirBuffer = new Float32Array(3);
  private readonly savedClear = new THREE.Color();
  private readonly changedScratch: SlotState[] = [];
  private base: BaseLayer | undefined;
  private strokes: readonly Stroke[] = [];
  private focused: SlotState | null;
  private showTemplate = false;
  private upgradeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** The last `setLayers` arguments, replayed after a context restore. */
  private lastLayers: Layer[] | null = null;
  private lastEnabled: string[] = [];
  private readonly onContextLost = () => this.handleContextLost();
  private readonly onContextRestored = () => this.handleContextRestored();
  readonly maxTextureSize: number;

  constructor(
    renderer: THREE.WebGLRenderer,
    model: VehicleModelData,
    templates: Map<string, TemplateImage>,
    options: BakerOptions = {},
  ) {
    this.renderer = renderer;
    this.model = model;
    this.options = options;
    this.maxTextureSize = renderer.capabilities.maxTextureSize;
    this.emptyPaint = makeDataTexture(new Uint8Array(4), 1, 1);

    const bakeMaterial = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string> = {}) =>
      new THREE.ShaderMaterial({
        vertexShader: BAKE_VERTEX,
        fragmentShader,
        uniforms: { uSphere: { value: new THREE.Vector4() }, ...uniforms },
        defines,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
      });

    this.baseMaterial = bakeMaterial(BASE_FRAGMENT, {
      uMode: { value: 0 },
      uColors: { value: new Float32Array(12) },
      uThresholds: { value: new THREE.Vector3(2, 2, 2) },
      uFrequency: { value: 1 },
      uSeed: { value: 1 },
      uPattern: { value: 0 },
      uCount: { value: 1 },
      uBounds: { value: new THREE.Vector3(2, 2, 2) },
      uCell: { value: 1 },
      uSoft: { value: 0 },
      uStripeN: { value: new THREE.Vector3(1, 0, 0) },
      uStripeB: { value: new THREE.Vector3(0, 1, 0) },
      uSegment: { value: 1 },
      uJitter: { value: 0 },
      uBaseAlpha: { value: 0 },
      uWearThreshold: { value: wearUniform(undefined) },
      uWearMetal: { value: new THREE.Vector3(...WEAR_METAL_RGB) },
      uWearRust: { value: new THREE.Vector3(...WEAR_RUST_RGB) },
    });
    const decalUniforms = () => ({
      uDecal: { value: new THREE.Matrix4() },
      uDecalNormal: { value: new THREE.Vector3(0, 0, 1) },
      uPart: { value: -1 },
    });
    this.decalMaterial = bakeMaterial(
      DECAL_FRAGMENT,
      { ...decalUniforms(), uDecalTex: { value: null }, uOpacity: { value: 1 }, uFlipX: { value: 0 }, uWearThreshold: { value: wearUniform(undefined) } },
      { LV_BATCH_CULL: '' },
    );
    // Premultiplied "over" on colour and alpha.
    this.decalMaterial.blending = THREE.CustomBlending;
    this.decalMaterial.blendEquation = THREE.AddEquation;
    this.decalMaterial.blendSrc = THREE.OneFactor;
    this.decalMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
    this.decalMaterial.blendEquationAlpha = THREE.AddEquation;
    this.decalMaterial.blendSrcAlpha = THREE.OneFactor;
    this.decalMaterial.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    this.finalMaterial = bakeMaterial(FINAL_FRAGMENT, {
      uIntermediate: { value: null },
      uDetail: { value: null },
      uHasDetail: { value: 0 },
      uMask: { value: null },
      uHasMask: { value: 0 },
      uPremultiply: { value: 0 },
    });
    this.countMaterial = bakeMaterial(COUNT_FRAGMENT, {});
    this.countMaterial.blending = THREE.CustomBlending;
    this.countMaterial.blendEquation = THREE.AddEquation;
    this.countMaterial.blendSrc = THREE.OneFactor;
    this.countMaterial.blendDst = THREE.OneFactor;
    this.footprintMaterial = bakeMaterial(
      FOOTPRINT_FRAGMENT,
      { ...decalUniforms(), uOverlap: { value: null }, uOverlapRatio: { value: OVERLAP_SIZE / FOOTPRINT_SIZE } },
      { LV_BATCH_CULL: '' },
    );
    this.decalTextures = new DecalTextureCache({ onSettled: (key) => this.decalPictureSettled(key) });
    this.maskMaterial = bakeMaterial(
      MASK_FRAGMENT,
      {
        uPoints: { value: this.pointsBuffer },
        uParams: { value: new THREE.Vector4() },
        uDir: { value: new THREE.Vector3(0, 0, -1) },
      },
      { LV_BATCH_CULL: '' },
    );
    this.maskMaterial.blending = THREE.CustomBlending;
    this.maskMaterial.blendSrc = THREE.OneFactor;
    this.maskMaterial.blendDst = THREE.OneFactor;
    this.maskMaterial.blendEquation = THREE.MaxEquation;
    this.coverageMaterial = bakeMaterial(COVERAGE_FRAGMENT, {});

    this.slots = model.header.slots.map((slot, index) => {
      const templateImage = templates.get(slot.texture);
      const template = templateImage
        ? makeDataTexture(templateImage.rgba, templateImage.w, templateImage.h)
        : makeDataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
      template.wrapS = THREE.RepeatWrapping;
      template.wrapT = THREE.RepeatWrapping;
      template.magFilter = THREE.LinearFilter;
      template.minFilter = THREE.LinearMipmapLinearFilter;
      template.generateMipmaps = true;
      const previewUniforms = { uPaint: { value: this.emptyPaint as THREE.Texture }, uPaintMix: { value: 0 } };
      const preview = new THREE.MeshStandardMaterial({ map: template, roughness: 0.85, metalness: 0 });
      preview.onBeforeCompile = (shader) => {
        shader.uniforms.uPaint = previewUniforms.uPaint;
        shader.uniforms.uPaintMix = previewUniforms.uPaintMix;
        shader.fragmentShader = shader.fragmentShader
          .replace('void main() {', `${PREVIEW_UNIFORMS}\nvoid main() {`)
          .replace('#include <map_fragment>', PREVIEW_MAP_FRAGMENT);
      };
      preview.customProgramCacheKey = () => 'livery-atelier-preview-1';
      const full = fitSize(slotFullSize(slot, templateImage), this.maxTextureSize);
      const state: SlotState = {
        index,
        slot,
        full,
        templateImage,
        template,
        geometry: null,
        scene: null,
        mesh: null,
        detail: null,
        enabled: false,
        mask: null,
        records: [],
        maskValid: false,
        paintSmall: null,
        paintFull: null,
        version: 0,
        smallVersion: -1,
        fullVersion: -1,
        preview,
        previewUniforms,
        overlap: null,
      };
      this.byTexture.set(slot.texture, state);
      return state;
    });
    this.focused = this.slots.find((s) => isBodySlot(s.slot.texture)) ?? this.slots[0] ?? null;
    // No Base yet: transparent (alpha 0), never opaque black.
    this.applyBaseUniforms();
    const canvas = renderer.domElement as HTMLCanvasElement | undefined;
    canvas?.addEventListener?.('webglcontextlost', this.onContextLost);
    canvas?.addEventListener?.('webglcontextrestored', this.onContextRestored);
  }

  // ---------------------------------------------------------------- public API

  /**
   * The project's layers and the enabled slots (texture names). Diff-based: the mask is
   * stamped incrementally when strokes were only appended and replayed otherwise; the paint is
   * re-rendered when the Base, the mask or the slot set changed.
   */
  setLayers(layers: Layer[], enabled: string[]): void {
    if (this.disposed) return;
    this.lastLayers = layers;
    this.lastEnabled = enabled;
    // Recorded even while the context is lost (the plan is memoised, so this is cheap).
    this.planTruncated = drawGroups(layers, this.model.header.mirrorAxis).truncated;
    if (this.contextLost()) return;
    const base = baseOf(layers);
    const strokes = visibleStrokes(layers);
    const baseChanged = base !== this.base;
    if (baseChanged) {
      this.base = base;
      this.applyBaseUniforms();
    }
    const strokesChanged = strokes !== this.strokes;
    this.strokes = strokes;
    const decalsChanged = this.updateDecals(layers);
    const want = new Set(enabled);
    const changed: SlotState[] = [];
    for (const state of this.slots) {
      const on = want.has(state.slot.texture);
      if (!on) {
        if (state.enabled) this.disable(state);
        continue;
      }
      let dirty = false;
      if (!state.enabled) {
        this.enable(state);
        dirty = true;
      }
      if (strokesChanged || !state.maskValid) dirty = this.syncMask(state) || dirty;
      if (dirty || baseChanged || decalsChanged) changed.push(state);
    }
    this.refresh(changed);
  }

  /** The last `setLayers` left the topmost layers undrawn: their boxes would pass the draw budget. */
  get truncated(): boolean {
    return this.planTruncated;
  }

  /**
   * Resolves when the pictures the current draw groups need (decal images, text rasters with
   * their fonts, shape rasters) have loaded, or failed, and the slots were re-baked with them.
   */
  async whenReady(): Promise<void> {
    for (;;) {
      if (this.disposed) return;
      const keys = this.decalOrder.map((b) => b.key);
      if (keys.every((k) => this.decalTextures.settled(k))) return;
      await this.decalTextures.whenSettled(keys);
    }
  }

  /**
   * Loads full-size copies of the current groups' pictures (images at their own size, text and
   * shapes at their export resolution, which `highQuality` raises with the body's output) for
   * `bakeForExport`, until `endExport()`. Resolves when loaded.
   */
  async prepareExport(highQuality = false): Promise<void> {
    if (this.disposed) return;
    await this.whenReady();
    this.endExport();
    this.exportHighQuality = highQuality;
    const keys = new Map<string, string>();
    for (const b of this.decalOrder) {
      const { source, id } = b.group;
      const full = this.pictureKey(b.group, true);
      if (source.kind !== 'shape') {
        // The preview copy already is the full-size picture when it wasn't reduced (and, for
        // text, has the export height): share it instead of loading the same pixels twice.
        // Shapes always load their export raster.
        const preview = source.kind === 'image' ? imageKey(source.assetId, false) : full.replace(/:f$/, ':p');
        if (b.shown === preview && this.decalTextures.loadedUnreduced(preview)) {
          this.decalTextures.acquire(preview, async () => null);
          keys.set(id, preview);
          continue;
        }
      }
      this.acquirePicture(b.group, full, true);
      keys.set(id, full);
    }
    this.exportKeys = keys;
    // Until every export picture has settled (a context restore may reload them meanwhile).
    for (;;) {
      if (this.disposed || this.exportKeys !== keys) return;
      const pending = [...keys.values()];
      if (pending.every((k) => this.decalTextures.settled(k))) return;
      await this.decalTextures.whenSettled(pending);
    }
  }

  /** Releases the full-size pictures `prepareExport` loaded. */
  endExport(): void {
    const keys = this.exportKeys;
    this.exportKeys = null;
    if (keys) for (const key of keys.values()) this.decalTextures.release(key);
  }

  /**
   * Whether `decal` lands on texels that more than one triangle draws (mirrored sides, repeated
   * road wheels) in an enabled slot: the decal would show twice, one copy reading backwards.
   * Uses the slot's overlap map (built once) and a small footprint render; call it when a
   * gesture ends, not on every move. False when the context is lost.
   */
  async decalTouchesSharedTexels(decal: Decal): Promise<boolean> {
    if (this.disposed || this.contextLost()) return false;
    const target = (this.footprintTarget ??= this.createReadableTarget(FOOTPRINT_SIZE, FOOTPRINT_SIZE));
    const pixels = new Uint8Array(FOOTPRINT_SIZE * FOOTPRINT_SIZE * 4);
    const u = this.footprintMaterial.uniforms;
    this.setDecalUniforms(u, this.decalDraw(decal));
    for (const state of this.slots) {
      if (!state.enabled) continue;
      this.ensureGeometry(state);
      u.uOverlap!.value = this.ensureOverlap(state).texture;
      this.draw(state, this.footprintMaterial, target, true);
      this.renderer.readRenderTargetPixels(target, 0, 0, FOOTPRINT_SIZE, FOOTPRINT_SIZE, pixels);
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 127) return true;
    }
    return false;
  }

  /** The slot kept at full size between bakes (the one the user works on); null = none. */
  setFocusSlot(texture: string | null): void {
    if (this.disposed) return;
    const next = texture === null ? null : (this.byTexture.get(texture) ?? null);
    if (next === this.focused) return;
    const previous = this.focused;
    this.focused = next;
    if (previous) {
      this.disposeTarget(previous, 'paintFull');
      if (previous.enabled && previous.smallVersion !== previous.version) this.renderPaintTarget(previous, 'small');
      this.bindPreview(previous);
    }
    if (next && next.enabled) {
      if (this.hasSeparateFull(next)) this.renderPaintTarget(next, 'full');
      else if (next.smallVersion !== next.version) this.renderPaintTarget(next, 'small');
      this.bindPreview(next);
    }
    this.pruneScratches();
    this.notify();
  }

  /** Template toggle: every slot shows the game's texture alone. */
  setShowTemplate(on: boolean): void {
    if (this.disposed || on === this.showTemplate) return;
    this.showTemplate = on;
    for (const state of this.slots) this.bindPreview(state);
    this.notify();
  }

  /**
   * The preview material of a slot (stable object: the Baker swaps its textures and uniforms).
   * Draw the slot's parts with the model's raw UVs as the `uv` attribute.
   */
  previewMaterial(slot: string): THREE.MeshStandardMaterial {
    return this.state(slot).preview;
  }

  /** The texture the preview currently shows for a slot's paint (changes after bakes), or null. */
  previewTexture(slot: string): THREE.Texture | null {
    const state = this.state(slot);
    const t = state.previewUniforms.uPaint.value;
    return t === this.emptyPaint ? null : t;
  }

  /**
   * Stamps a stroke while it is being painted, into one slot or every enabled one (`'all'`),
   * then re-renders their paint. `_from` (the first point the caller hasn't stamped yet) is only
   * a hint: the Baker tracks what each slot's mask holds and stamps whatever is missing, so
   * calling this before or after `setLayers` carries the same points gives the same mask and
   * never causes a replay.
   */
  stampStroke(slot: string | 'all', stroke: Stroke, _from: number): void {
    if (this.disposed) return;
    const changed = this.changedScratch;
    changed.length = 0;
    const only = slot === 'all' ? null : this.state(slot);
    for (const state of this.slots) {
      if ((only && state !== only) || !state.enabled || !state.mask || !state.maskValid) continue;
      const n = stroke.points.length;
      const last = state.records[state.records.length - 1];
      const continues =
        last !== undefined &&
        sameStrokeParams(last.stroke, stroke) &&
        last.stamped <= n &&
        samePoints(last.stroke.points, stroke.points, last.stamped);
      if (continues) {
        if (last.stamped === n) continue;
        this.stampRange(state, state.mask, stroke, last.stamped, n);
        last.stroke = stroke;
        last.stamped = n;
      } else {
        // A stroke the mask doesn't hold yet: the newest one, stamped whole.
        this.stampRange(state, state.mask, stroke, 0, n);
        state.records.push({ stroke, stamped: n });
      }
      changed.push(state);
    }
    this.refresh(changed);
  }

  /**
   * Renders a slot at its output size (full, or 4096 for a body slot with High quality) and
   * reads it back: RGBA top-to-bottom, dilated 4 px past the islands. Falls back to 2048
   * (`downscaled`) above the GPU's `maxTextureSize`.
   */
  bakeForExport(slot: string, highQuality: boolean): BakeResult {
    if (this.disposed) throw new Error('Baker: disposed');
    if (this.contextLost()) throw new Error('Baker: the WebGL context is lost');
    const state = this.state(slot);
    this.ensureGeometry(state);
    this.ensureDetail(state);
    const size = exportSize(slotFullSize(state.slot, state.templateImage), state.slot.texture, highQuality, this.maxTextureSize);
    const { w, h } = size;

    // The mask at the output size: the live one when it matches, else a replay.
    let mask: THREE.WebGLRenderTarget | null = null;
    let tempMask: THREE.WebGLRenderTarget | null = null;
    if (this.strokes.length > 0) {
      if (state.mask && state.maskValid && state.mask.width === w && state.mask.height === h) {
        mask = state.mask;
      } else {
        tempMask = this.createMaskTarget(w, h);
        this.replayInto(state, tempMask);
        mask = tempMask;
      }
    }

    const target = this.createPaintTarget(w, h, false);
    const rgba = new Uint8Array(w * h * 4);
    const covered = new Uint8Array(w * h);
    try {
      this.drawPaint(state, target, mask, false, true);
      this.renderer.readRenderTargetPixels(target, 0, 0, w, h, rgba);
      this.draw(state, this.coverageMaterial, target, true);
      const strip = new Uint8Array(w * Math.min(COVERAGE_STRIP_ROWS, h) * 4);
      for (let y = 0; y < h; y += COVERAGE_STRIP_ROWS) {
        const rows = Math.min(COVERAGE_STRIP_ROWS, h - y);
        const view = rows * w * 4 === strip.length ? strip : strip.subarray(0, rows * w * 4);
        this.renderer.readRenderTargetPixels(target, 0, y, w, rows, view);
        for (let i = 0, o = y * w; i < rows * w; i++, o++) covered[o] = view[i * 4]! > 127 ? 1 : 0;
      }
    } finally {
      target.dispose();
      tempMask?.dispose();
      this.releaseScratchUnlessPreview(w, h);
    }
    dilate(rgba, covered, w, h, DILATE_PX);
    return { rgba, w, h, downscaled: size.downscaled };
  }

  /** Frees every GPU resource; the Baker does nothing afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const canvas = this.renderer.domElement as HTMLCanvasElement | undefined;
    canvas?.removeEventListener?.('webglcontextlost', this.onContextLost);
    canvas?.removeEventListener?.('webglcontextrestored', this.onContextRestored);
    if (this.upgradeTimer !== null) clearTimeout(this.upgradeTimer);
    this.upgradeTimer = null;
    this.exportKeys = null;
    this.decalTextures.dispose();
    this.bindings.clear();
    this.decalOrder = [];
    this.disposeScratches();
    for (const state of this.slots) {
      this.disposeTarget(state, 'mask');
      this.disposeTarget(state, 'paintSmall');
      this.disposeTarget(state, 'paintFull');
      this.disposeTarget(state, 'overlap');
      state.geometry?.dispose();
      state.detail?.dispose();
      state.template.dispose();
      state.preview.dispose();
      state.geometry = null;
      state.detail = null;
      state.mesh = null;
      state.scene = null;
    }
    this.baseMaterial.dispose();
    this.decalMaterial.dispose();
    this.finalMaterial.dispose();
    this.maskMaterial.dispose();
    this.coverageMaterial.dispose();
    this.countMaterial.dispose();
    this.footprintMaterial.dispose();
    this.emptyPaint.dispose();
  }

  // ---------------------------------------------------------------- slots

  private state(texture: string): SlotState {
    const state = this.byTexture.get(texture);
    if (!state) throw new Error(`Baker: unknown slot ${texture}`);
    return state;
  }

  private hasSeparateFull(state: SlotState): boolean {
    return Math.max(state.full.w, state.full.h) > PREVIEW_MAX;
  }

  private enable(state: SlotState): void {
    this.ensureGeometry(state);
    this.ensureDetail(state);
    state.mask = this.createMaskTarget(state.full.w, state.full.h);
    state.records = [];
    state.maskValid = false;
    state.enabled = true;
  }

  private disable(state: SlotState): void {
    state.enabled = false;
    this.disposeTarget(state, 'mask');
    this.disposeTarget(state, 'paintSmall');
    this.disposeTarget(state, 'paintFull');
    state.records = [];
    state.maskValid = false;
    state.smallVersion = -1;
    state.fullVersion = -1;
    this.bindPreview(state);
    this.pruneScratches();
    this.notify();
  }

  private disposeTarget(state: SlotState, key: 'mask' | 'paintSmall' | 'paintFull' | 'overlap'): void {
    state[key]?.dispose();
    state[key] = null;
  }

  private ensureGeometry(state: SlotState): void {
    if (state.geometry) return;
    this.edgeHeights ??= sharpEdgeHeights(this.model);
    const g = buildUnwrapped(this.model, state.index, this.edgeHeights);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
    geometry.setAttribute('partGroup', new THREE.BufferAttribute(g.groups, 1));
    geometry.setAttribute('triSphere', new THREE.BufferAttribute(g.spheres, 4));
    geometry.setAttribute('edgeBary', new THREE.BufferAttribute(g.bary, 3));
    geometry.setAttribute('edgeH', new THREE.BufferAttribute(g.edgeHeights, 3));
    const mesh = new THREE.Mesh(geometry, this.baseMaterial);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    state.geometry = geometry;
    state.mesh = mesh;
    state.scene = scene;
  }

  private ensureDetail(state: SlotState): void {
    if (state.detail || !state.templateImage) return;
    const { rgba, w, h } = state.templateImage;
    // Float32 data into an R16F texture: half floats are filterable without an extension, and
    // the CPU data is dropped once uploaded (a context restore recomputes it).
    const detail = new THREE.DataTexture(detailMap(rgba, w, h), w, h, THREE.RedFormat, THREE.FloatType);
    detail.internalFormat = 'R16F';
    detail.unpackAlignment = 4;
    detail.colorSpace = THREE.NoColorSpace;
    detail.flipY = false;
    detail.magFilter = THREE.LinearFilter;
    detail.minFilter = THREE.LinearFilter;
    detail.wrapS = THREE.RepeatWrapping;
    detail.wrapT = THREE.RepeatWrapping;
    detail.generateMipmaps = false;
    detail.onUpdate = releaseImageData;
    detail.needsUpdate = true;
    state.detail = detail;
  }

  private createMaskTarget(w: number, h: number): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
    });
    return target;
  }

  private createPaintTarget(w: number, h: number, preview: boolean): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: preview,
      minFilter: preview ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      colorSpace: THREE.NoColorSpace,
    });
  }

  // ---------------------------------------------------------------- mask

  /** Brings the slot's mask to `this.strokes`; true when it changed. */
  private syncMask(state: SlotState): boolean {
    if (!state.mask) return false;
    const plan: MaskPlan = state.maskValid ? planMaskUpdate(state.records, this.strokes) : { replay: true };
    if (plan.replay) {
      this.replayInto(state, state.mask);
      state.records = this.strokes.map((stroke) => ({ stroke, stamped: stroke.points.length }));
      state.maskValid = true;
      return true;
    }
    if (plan.ops.length === 0) {
      // Same content, possibly new objects: keep the latest references.
      state.records = state.records.map((r, i) => ({ stroke: this.strokes[i]!, stamped: r.stamped }));
      return false;
    }
    for (const op of plan.ops) {
      const stroke = this.strokes[op.stroke]!;
      this.stampRange(state, state.mask, stroke, op.from, stroke.points.length);
    }
    state.records = this.strokes.map((stroke) => ({ stroke, stamped: stroke.points.length }));
    return true;
  }

  /** Clears `target` and stamps every visible stroke in order. */
  private replayInto(state: SlotState, target: THREE.WebGLRenderTarget): void {
    this.clearTarget(target);
    for (const stroke of this.strokes) this.stampRange(state, target, stroke, 0, stroke.points.length);
  }

  /** Stamps points `from..to` of a stroke in batches of `BAKE_MAX_POINTS`. */
  private stampRange(state: SlotState, target: THREE.WebGLRenderTarget, stroke: Stroke, from: number, to: number): void {
    if (from >= to) return;
    const material = this.maskMaterial;
    const u = material.uniforms;
    material.blendEquation = stroke.erase ? THREE.MinEquation : THREE.MaxEquation;
    normalizedDir(stroke.dir, this.dirBuffer);
    (u.uDir!.value as THREE.Vector3).fromArray(this.dirBuffer);
    for (let start = from; start < to; start += BAKE_MAX_POINTS) {
      const count = Math.min(BAKE_MAX_POINTS, to - start);
      packBatch(stroke.points, start, count, stroke.radius, this.pointsBuffer, this.sphereBuffer);
      strokeParams(stroke, count, this.paramsBuffer);
      (u.uSphere!.value as THREE.Vector4).fromArray(this.sphereBuffer);
      (u.uParams!.value as THREE.Vector4).fromArray(this.paramsBuffer);
      this.draw(state, material, target, false);
    }
  }

  // ---------------------------------------------------------------- paint

  private applyBaseUniforms(): void {
    const b = baseUniforms(this.base);
    const u = this.baseMaterial.uniforms;
    u.uMode!.value = b.mode;
    (u.uColors!.value as Float32Array).set(b.colors);
    (u.uThresholds!.value as THREE.Vector3).set(b.thresholds[0], b.thresholds[1], b.thresholds[2]);
    u.uFrequency!.value = b.frequency;
    u.uSeed!.value = b.seed;
    u.uPattern!.value = b.pattern;
    u.uCount!.value = b.count;
    (u.uBounds!.value as THREE.Vector3).set(b.bounds[0], b.bounds[1], b.bounds[2]);
    u.uCell!.value = b.cell;
    u.uSoft!.value = b.soft;
    (u.uStripeN!.value as THREE.Vector3).set(...b.stripeN);
    (u.uStripeB!.value as THREE.Vector3).set(...b.stripeB);
    u.uSegment!.value = b.segment;
    u.uJitter!.value = b.jitter;
    u.uBaseAlpha!.value = b.alpha;
    u.uWearThreshold!.value = wearUniform(this.base?.wear);
  }

  /**
   * The three paint steps into `target`: Base and decals into the scratch intermediate of the
   * same size, then the final pass (detail, mask; premultiplied for preview targets). Export
   * draws the full-size pictures `prepareExport` loaded, where there are.
   */
  private drawPaint(
    state: SlotState,
    target: THREE.WebGLRenderTarget,
    mask: THREE.WebGLRenderTarget | null,
    premultiply: boolean,
    exporting = false,
  ): void {
    const scratch = this.scratch(target.width, target.height);
    this.draw(state, this.baseMaterial, scratch, true);
    const du = this.decalMaterial.uniforms;
    for (const b of this.decalOrder) {
      let texture: THREE.Texture | null;
      if (exporting) {
        // Export draws the full-size pictures only: a missing one is an error, never a fallback.
        const key = this.exportKeys?.get(b.group.id);
        if (key === undefined || !this.decalTextures.settled(key)) throw new Error(EXPORT_PICTURE_NOT_READY);
        texture = this.decalTextures.get(key);
      } else {
        texture = b.shown ? this.decalTextures.get(b.shown) : null;
      }
      if (!texture) continue;
      du.uDecalTex!.value = texture;
      du.uOpacity!.value = Math.min(1, Math.max(0, b.group.opacity));
      du.uFlipX!.value = b.group.flipX ? 1 : 0;
      du.uWearThreshold!.value = wearUniform(b.group.wear);
      for (const d of b.draws) {
        this.setDecalUniforms(du, d);
        this.draw(state, this.decalMaterial, scratch, false);
      }
    }
    const u = this.finalMaterial.uniforms;
    u.uIntermediate!.value = scratch.texture;
    u.uPremultiply!.value = premultiply ? 1 : 0;
    u.uDetail!.value = state.detail;
    u.uHasDetail!.value = state.detail ? 1 : 0;
    u.uMask!.value = mask ? mask.texture : null;
    u.uHasMask!.value = mask && this.strokes.length > 0 ? 1 : 0;
    this.draw(state, this.finalMaterial, target, true);
  }

  /** The shared intermediate of exactly `w × h` (premultiplied RGBA8, read texel for texel). */
  private scratch(w: number, h: number): THREE.WebGLRenderTarget {
    const key = `${w}x${h}`;
    let target = this.scratches.get(key);
    if (!target) {
      target = new THREE.WebGLRenderTarget(w, h, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        colorSpace: THREE.NoColorSpace,
      });
      this.scratches.set(key, target);
    }
    return target;
  }

  /** A preview target of an enabled slot has this size (its scratch is worth keeping). */
  private previewUses(w: number, h: number): boolean {
    return this.slots.some(
      (s) =>
        s.enabled &&
        ((s.paintSmall !== null && s.paintSmall.width === w && s.paintSmall.height === h) ||
          (s.paintFull !== null && s.paintFull.width === w && s.paintFull.height === h)),
    );
  }

  /** After an export: its scratch goes unless a preview target uses the same size. */
  private releaseScratchUnlessPreview(w: number, h: number): void {
    if (this.previewUses(w, h)) return;
    const key = `${w}x${h}`;
    this.scratches.get(key)?.dispose();
    this.scratches.delete(key);
  }

  /** Drops the scratches no preview target uses any more (focus moved, a slot turned off). */
  private pruneScratches(): void {
    for (const [key, target] of this.scratches) {
      if (this.previewUses(target.width, target.height)) continue;
      target.dispose();
      this.scratches.delete(key);
    }
  }

  private disposeScratches(): void {
    for (const t of this.scratches.values()) t.dispose();
    this.scratches.clear();
    this.footprintTarget?.dispose();
    this.footprintTarget = null;
  }

  // ---------------------------------------------------------------- decals

  /** The draw uniforms of one decal box. */
  private decalDraw(decal: Decal): DecalDraw {
    const [x, y, z, r] = decalSphere(decal);
    return {
      matrix: new THREE.Matrix4().fromArray(decalMatrix(decal)),
      normal: new THREE.Vector3(decal.normal[0], decal.normal[1], decal.normal[2]),
      sphere: new THREE.Vector4(x, y, z, r),
      part: decalGroupIndex(decal),
    };
  }

  private setDecalUniforms(u: Record<string, THREE.IUniform>, d: DecalDraw): void {
    (u.uDecal!.value as THREE.Matrix4).copy(d.matrix);
    (u.uDecalNormal!.value as THREE.Vector3).copy(d.normal);
    (u.uSphere!.value as THREE.Vector4).copy(d.sphere);
    u.uPart!.value = d.part;
  }

  /**
   * The size a slot is rendered at, for text texel densities: the export size (4096 for a High
   * quality body) for export rasters, its largest preview target (full size) for preview ones.
   */
  private outputSize(state: SlotState, full: boolean): { width: number; height: number } {
    if (!full) return { width: state.full.w, height: state.full.h };
    const size = exportSize(slotFullSize(state.slot, state.templateImage), state.slot.texture, this.exportHighQuality, this.maxTextureSize);
    return { width: size.w, height: size.h };
  }

  /** Texel density around a box, max over the slots rendered at their preview or export size. */
  private densityAround(decal: Decal, full: boolean): number | null {
    let density: number | null = null;
    for (const state of this.slots) {
      let table = this.densityTables.get(state.index);
      if (!table) {
        table = densityTable(this.model, state.index);
        this.densityTables.set(state.index, table);
      }
      const d = slotDensity(table, decal, this.outputSize(state, full));
      if (d !== null && (density === null || d > density)) density = d;
    }
    return density;
  }

  /** The text (or shape) raster height for a box: 2 × the texel density around it (max over slots), snapped. */
  private textHeight(decal: Decal, full: boolean): number {
    const cacheKey = `${full ? (this.exportHighQuality ? 'fhq' : 'f') : 'p'}|${decalGeometryKey(decal)}`;
    let density = this.densities.get(cacheKey);
    if (density === undefined) {
      density = this.densityAround(decal, full);
      if (this.densities.size >= DENSITY_CACHE_MAX) this.densities.clear();
      this.densities.set(cacheKey, density);
    }
    const px = quantiseRasterHeight(rasterHeightFor(density, decal.height));
    return full ? Math.min(px, this.maxTextureSize) : Math.min(px, PREVIEW_DECAL_MAX);
  }

  /** The cache key of a group's picture; text and shape rasters are sized for its `rasterDecal`. */
  private pictureKey(group: DrawGroup, full: boolean): string {
    const { source, rasterDecal } = group;
    switch (source.kind) {
      case 'image':
        return imageKey(source.assetId, full);
      case 'text':
        return textKey(source, this.textHeight(rasterDecal, full), full);
      case 'shape':
        return shapeKey(source, group.variant, rasterDecal, this.textHeight(rasterDecal, full), full);
    }
  }

  /** One more reference to a group's picture, loading it on first use. */
  private acquirePicture(group: DrawGroup, key: string, full: boolean): void {
    const maxSide = full ? this.maxTextureSize : PREVIEW_DECAL_MAX;
    const { source, rasterDecal, variant } = group;
    if (source.kind === 'image') {
      const { loadAsset } = this.options;
      const assetId = source.assetId;
      this.decalTextures.acquire(key, async () => (loadAsset ? loadAsset(assetId) : null), maxSide);
    } else if (source.kind === 'text') {
      const rasteriseText = this.options.rasteriseText ?? defaultRasteriseText;
      const px = this.textHeight(rasterDecal, full);
      this.decalTextures.acquire(key, () => rasteriseText(source, px), maxSide);
    } else {
      const rasteriseShape = this.options.rasteriseShape ?? defaultRasteriseShape;
      const px = this.textHeight(rasterDecal, full);
      const frame = { width: rasterDecal.width, height: rasterDecal.height };
      this.decalTextures.acquire(key, () => rasteriseShape(source, variant, frame, px), maxSide);
    }
  }

  /** The drawn group now shows its current picture (the previous one is released). */
  private promote(b: LayerBinding): void {
    if (b.shown === b.key) return;
    if (b.shown !== null) this.decalTextures.release(b.shown);
    b.shown = b.key;
  }

  /**
   * Brings the bindings to the draw groups of `layers` (`drawGroups`: repeat and mirror copies
   * are already among each group's boxes). True when what the paint shows changed: a group came,
   * went or moved in the order, or one's picture shown, boxes (by value), opacity, flip or wear
   * changed. A rebuilt group with the same values (a rename) changes nothing.
   */
  private updateDecals(layers: readonly Layer[]): boolean {
    const plan = drawGroups(layers, this.model.header.mirrorAxis);
    this.planTruncated = plan.truncated;
    const previous = this.decalOrder;
    let changed = false;
    const order: LayerBinding[] = [];
    const seen = new Set<string>();
    for (const group of plan.groups) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      const key = this.pictureKey(group, false);
      let b = this.bindings.get(group.id);
      if (!b) {
        this.acquirePicture(group, key, false);
        b = { group, key, shown: null, boxes: group.boxes, draws: group.boxes.map((d) => this.decalDraw(d)) };
        this.bindings.set(group.id, b);
        changed = true;
      } else if (b.key !== key) {
        if (key === b.shown) {
          // Back to the picture shown (whose reference is held): the pending one is dropped.
          this.decalTextures.release(b.key);
        } else {
          // Keep drawing the picture shown until the new one is ready; a pending one is dropped.
          if (b.key !== b.shown) this.decalTextures.release(b.key);
          this.acquirePicture(group, key, false);
        }
        b.key = key;
      }
      const before = b.group;
      if (before !== group) {
        if (before.opacity !== group.opacity || before.flipX !== group.flipX || before.wear !== group.wear) changed = true;
        b.group = group;
      }
      if (b.boxes !== group.boxes) {
        if (!sameBoxes(b.boxes, group.boxes)) {
          b.draws = group.boxes.map((d) => this.decalDraw(d));
          changed = true;
        }
        b.boxes = group.boxes;
      }
      const shown = b.shown;
      if (this.decalTextures.settled(b.key)) this.promote(b);
      if (b.shown !== shown) changed = true;
      if (previous[order.length] !== b) changed = true;
      order.push(b);
    }
    if (order.length !== previous.length) changed = true;
    for (const [id, b] of this.bindings) {
      if (seen.has(id)) continue;
      this.decalTextures.release(b.key);
      if (b.shown !== null && b.shown !== b.key) this.decalTextures.release(b.shown);
      this.bindings.delete(id);
      changed = true;
    }
    this.decalOrder = order;
    return changed;
  }

  /** A picture finished loading: groups waiting for it show it and the enabled slots re-bake. */
  private decalPictureSettled(key: string): void {
    if (this.disposed) return;
    let shown = false;
    for (const b of this.decalOrder) {
      if (b.key === key) {
        this.promote(b);
        shown = true;
      }
    }
    if (!shown || this.contextLost()) return;
    this.refresh(this.slots.filter((s) => s.enabled));
  }

  /** The slot's overlap map: every triangle adds 1/255 to the texels it covers (sample-based). */
  private ensureOverlap(state: SlotState): THREE.WebGLRenderTarget {
    if (state.overlap) return state.overlap;
    const target = this.createMaskTarget(OVERLAP_SIZE, OVERLAP_SIZE);
    target.texture.minFilter = THREE.NearestFilter;
    target.texture.magFilter = THREE.NearestFilter;
    this.draw(state, this.countMaterial, target, true);
    state.overlap = target;
    return target;
  }

  /** An RGBA8 target read back with `readRenderTargetPixels`. */
  private createReadableTarget(w: number, h: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
    });
  }

  /** Renders one of the slot's preview targets (allocated at its size on first use). */
  private renderPaintTarget(state: SlotState, which: 'small' | 'full'): void {
    const size = which === 'full' ? state.full : fitSize(state.full, PREVIEW_MAX);
    const key = which === 'full' ? 'paintFull' : 'paintSmall';
    let target = state[key];
    if (!target || target.width !== size.w || target.height !== size.h) {
      target?.dispose();
      target = this.createPaintTarget(size.w, size.h, true);
      state[key] = target;
    }
    this.drawPaint(state, target, state.mask, true);
    if (which === 'full') state.fullVersion = state.version;
    else state.smallVersion = state.version;
  }

  /**
   * Re-renders the paint of changed slots: the small target now; the focused slot's full target
   * now on its first bake, else `UPGRADE_DELAY_MS` after the last change.
   */
  private refresh(changed: SlotState[]): void {
    if (changed.length === 0) return;
    let upgrade = false;
    for (const state of changed) {
      state.version++;
      if (state === this.focused && this.hasSeparateFull(state)) {
        if (!state.paintFull && !state.paintSmall) {
          this.renderPaintTarget(state, 'full');
        } else {
          this.renderPaintTarget(state, 'small');
          upgrade = true;
        }
      } else {
        this.renderPaintTarget(state, 'small');
      }
      this.bindPreview(state);
    }
    if (upgrade) this.scheduleUpgrade();
    this.notify();
  }

  private scheduleUpgrade(): void {
    if (this.upgradeTimer !== null) clearTimeout(this.upgradeTimer);
    this.upgradeTimer = setTimeout(() => {
      this.upgradeTimer = null;
      this.upgrade();
    }, UPGRADE_DELAY_MS);
  }

  /** Brings the focused slot's full-size target up to date. */
  upgrade(): void {
    const state = this.focused;
    if (this.disposed || !state || !state.enabled || !this.hasSeparateFull(state)) return;
    if (state.fullVersion === state.version) return;
    this.renderPaintTarget(state, 'full');
    this.bindPreview(state);
    this.notify();
  }

  /** Points the slot's preview at its most up-to-date paint (or the template alone). */
  private bindPreview(state: SlotState): void {
    let texture: THREE.Texture = this.emptyPaint;
    if (state.enabled) {
      if (state.paintFull && state.fullVersion === state.version) texture = state.paintFull.texture;
      else if (state.paintSmall && state.smallVersion >= 0) texture = state.paintSmall.texture;
    }
    state.previewUniforms.uPaint.value = texture;
    state.previewUniforms.uPaintMix.value = this.showTemplate || texture === this.emptyPaint ? 0 : 1;
  }

  // ---------------------------------------------------------------- drawing

  private clearTarget(target: THREE.WebGLRenderTarget): void {
    const r = this.renderer;
    const previous = r.getRenderTarget();
    r.getClearColor(this.savedClear);
    const alpha = r.getClearAlpha();
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setClearColor(this.savedClear, alpha);
    r.setRenderTarget(previous);
  }

  /** One unwrapped draw of the slot's mesh with `material` into `target` (cleared first if asked). */
  private draw(state: SlotState, material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget, clear: boolean): void {
    if (!state.mesh || !state.scene) return;
    if (clear) this.clearTarget(target);
    const r = this.renderer;
    const previous = r.getRenderTarget();
    const autoClear = r.autoClear;
    r.autoClear = false;
    state.mesh.material = material;
    r.setRenderTarget(target);
    r.render(state.scene, this.camera);
    r.setRenderTarget(previous);
    r.autoClear = autoClear;
  }

  // ---------------------------------------------------------------- context loss

  private contextLost(): boolean {
    const gl = this.renderer.getContext?.();
    return gl ? gl.isContextLost() : false;
  }

  private handleContextLost(): void {
    if (this.upgradeTimer !== null) clearTimeout(this.upgradeTimer);
    this.upgradeTimer = null;
  }

  /**
   * Everything the GPU held is gone: targets (masks, paints, intermediates, overlap maps), the
   * detail maps and the decal pictures (their CPU data was released after upload) are dropped and every slot is baked again from the last
   * `setLayers`. Geometries, materials and the templates (their data is kept) are re-uploaded
   * by three on their next use.
   */
  private handleContextRestored(): void {
    if (this.disposed) return;
    this.disposeScratches();
    // Their CPU copies were dropped after upload: load them again (the slots re-bake as they arrive).
    this.decalTextures.reloadAll();
    for (const state of this.slots) {
      this.disposeTarget(state, 'overlap');
      this.disposeTarget(state, 'mask');
      this.disposeTarget(state, 'paintSmall');
      this.disposeTarget(state, 'paintFull');
      state.detail?.dispose();
      state.detail = null;
      state.enabled = false;
      state.records = [];
      state.maskValid = false;
      state.smallVersion = -1;
      state.fullVersion = -1;
      this.bindPreview(state);
    }
    if (this.lastLayers) this.setLayers(this.lastLayers, this.lastEnabled);
    this.notify();
  }

  private notify(): void {
    this.options.onUpdate?.();
  }
}
