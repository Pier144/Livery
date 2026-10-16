import * as THREE from 'three';
import type { ModelSlot } from '@/types';
import { detailMap } from '../detailMap';
import { dilate, DILATE_PX } from '../dilate';
import type { VehicleModelData } from '../modelBuffer';
import { baseOf, maskOf, partGroupOf, type BaseLayer, type Layer, type Stroke, type Vec3 } from '../project';
import {
  BAKE_MAX_POINTS,
  BAKE_VERTEX,
  brushWeight,
  CAMO_CELL,
  CAMO_THRESHOLDS,
  COVERAGE_FRAGMENT,
  FACING_MIN,
  GROUP_INDEX,
  MASK_FRAGMENT,
  PAINT_FRAGMENT,
  PREVIEW_MAP_FRAGMENT,
  PREVIEW_UNIFORMS,
} from './shaders';

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
 * - a **paint** target (RGBA8, sRGB numbers, `NoColorSpace`): Base (solid or 3D-noise camo) ×
 *   template detail factor, alpha = 1 − mask. At most 1024 px while editing; the focused slot
 *   (the body by default) also gets a full-size target, rendered `UPGRADE_DELAY_MS` after the
 *   last change;
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
}

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

/** The paint pass's Base uniforms. */
export interface BaseUniforms {
  /** 0 solid, 1 camo. */
  mode: number;
  /** Four sRGB colours (x, y, z each), unused ones repeat the last. */
  colors: Float32Array;
  count: number;
  thresholds: readonly [number, number, number];
  /** Noise cells per model unit: `1 / (CAMO_CELL · scale)`. */
  frequency: number;
  /** The seed as an int32 (the shader reads it back as a uint). */
  seed: number;
  /** 0 when the Base is hidden or missing (nothing painted). */
  alpha: number;
}

export function baseUniforms(base: BaseLayer | undefined): BaseUniforms {
  const colors = new Float32Array(12);
  const list = base && base.colors.length > 0 ? base.colors : ['#000000'];
  const camo = base?.mode === 'camo' && list.length >= 2;
  const count = camo ? Math.min(4, list.length) : 1;
  for (let i = 0; i < 4; i++) colors.set(hexToSrgb(list[Math.min(i, count - 1)]!), i * 3);
  const scale = base && base.scale > 0 ? base.scale : 1;
  return {
    mode: camo ? 1 : 0,
    colors,
    count,
    thresholds: CAMO_THRESHOLDS[count] ?? CAMO_THRESHOLDS[1]!,
    frequency: 1 / (CAMO_CELL * scale),
    seed: (base?.seed ?? 1) | 0,
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
 * Triangles with non-finite UVs are skipped.
 */
export function buildUnwrapped(model: VehicleModelData, slotIndex: number): UnwrappedGeometry {
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
      for (let tu = 0; tu < tilesU; tu++) {
        for (let tv = 0; tv < tilesV; tv++) {
          for (const i of corner) {
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
  return { positions, normals, uvs, groups, spheres, vertexCount };
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

// ================================================================ the Baker

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
  private readonly options: BakerOptions;
  private readonly slots: SlotState[];
  private readonly byTexture = new Map<string, SlotState>();
  private readonly camera = new THREE.Camera();
  private readonly paintMaterial: THREE.ShaderMaterial;
  private readonly maskMaterial: THREE.ShaderMaterial;
  private readonly coverageMaterial: THREE.ShaderMaterial;
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

    this.paintMaterial = bakeMaterial(PAINT_FRAGMENT, {
      uMode: { value: 0 },
      uColors: { value: new Float32Array(12) },
      uThresholds: { value: new THREE.Vector3(2, 2, 2) },
      uFrequency: { value: 1 },
      uSeed: { value: 1 },
      uDetail: { value: null },
      uHasDetail: { value: 0 },
      uMask: { value: null },
      uHasMask: { value: 0 },
      uBaseAlpha: { value: 0 },
      uPremultiply: { value: 0 },
    });
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
      if (dirty || baseChanged) changed.push(state);
    }
    this.refresh(changed);
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
      this.drawPaint(state, target, mask, false);
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
    for (const state of this.slots) {
      this.disposeTarget(state, 'mask');
      this.disposeTarget(state, 'paintSmall');
      this.disposeTarget(state, 'paintFull');
      state.geometry?.dispose();
      state.detail?.dispose();
      state.template.dispose();
      state.preview.dispose();
      state.geometry = null;
      state.detail = null;
      state.mesh = null;
      state.scene = null;
    }
    this.paintMaterial.dispose();
    this.maskMaterial.dispose();
    this.coverageMaterial.dispose();
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
    this.notify();
  }

  private disposeTarget(state: SlotState, key: 'mask' | 'paintSmall' | 'paintFull'): void {
    state[key]?.dispose();
    state[key] = null;
  }

  private ensureGeometry(state: SlotState): void {
    if (state.geometry) return;
    const g = buildUnwrapped(this.model, state.index);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
    geometry.setAttribute('partGroup', new THREE.BufferAttribute(g.groups, 1));
    geometry.setAttribute('triSphere', new THREE.BufferAttribute(g.spheres, 4));
    const mesh = new THREE.Mesh(geometry, this.paintMaterial);
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
    const u = this.paintMaterial.uniforms;
    u.uMode!.value = b.mode;
    (u.uColors!.value as Float32Array).set(b.colors);
    (u.uThresholds!.value as THREE.Vector3).set(b.thresholds[0], b.thresholds[1], b.thresholds[2]);
    u.uFrequency!.value = b.frequency;
    u.uSeed!.value = b.seed;
    u.uBaseAlpha!.value = b.alpha;
  }

  private drawPaint(state: SlotState, target: THREE.WebGLRenderTarget, mask: THREE.WebGLRenderTarget | null, premultiply: boolean): void {
    const u = this.paintMaterial.uniforms;
    u.uPremultiply!.value = premultiply ? 1 : 0;
    u.uDetail!.value = state.detail;
    u.uHasDetail!.value = state.detail ? 1 : 0;
    u.uMask!.value = mask ? mask.texture : null;
    u.uHasMask!.value = mask && this.strokes.length > 0 ? 1 : 0;
    this.draw(state, this.paintMaterial, target, true);
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
   * Everything the GPU held is gone: targets (masks, paints) and the detail maps (their CPU data
   * was released after upload) are dropped and every slot is baked again from the last
   * `setLayers`. Geometries, materials and the templates (their data is kept) are re-uploaded
   * by three on their next use.
   */
  private handleContextRestored(): void {
    if (this.disposed) return;
    for (const state of this.slots) {
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
