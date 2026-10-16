import type { VehicleModelData } from './modelBuffer';
import {
  MAX_DECAL_SIZE,
  MIN_DECAL_SIZE,
  cross,
  decalRight,
  defaultDepth,
  dot,
  length,
  normalize,
  partGroupOf,
  scale,
  sub,
  type Decal,
  type PartFilter,
  type Vec3,
} from './project';

/**
 * Pure decal maths (no three.js, no DOM): placing a decal from a raycast hit, the model → decal
 * space transform the bake's fragment shader uses, the box and facing tests, Mirror to the other
 * side, the default size and the texel density text is rasterised at.
 *
 * Decal space is normalised: `u` along `decalRight(decal)` divided by the width, `v` along `up`
 * divided by the height, `w` along the normal divided by the depth, so the box is
 * `|u|, |v|, |w| <= 0.5` and the picture is sampled at `(u + 0.5, 0.5 - v)` (top-left origin).
 */

/**
 * Below this length (the sine of the angle, for a unit vector), a projected up is "nearly
 * parallel" to the normal and the next fallback is tried: a view within about 4.6° of edge-on
 * would give an up that jumps with every pixel, the world axis is steadier.
 */
export const PARALLEL_EPSILON = 0.08;
/**
 * The Protected-areas brush (mask strokes) touches a texel only when `dot(n, −dir) > FACING_MIN · |n|`
 * (a hard cut, about 78° off-axis). Decals don't use it: they fade (`facingWeight`).
 */
export const FACING_MIN = 0.2;
/**
 * Decals fade on steep surfaces: full strength where `cos θ = dot(n, decal normal) / |n|` is at
 * least DECAL_FADE_END, nothing at or below DECAL_FADE_START (`smoothstep` between), so text and
 * pictures don't streak along surfaces nearly parallel to the projection.
 */
export const DECAL_FADE_START = 0.35;
export const DECAL_FADE_END = 0.65;
/** Default width: this fraction of the model's bounding-box diagonal. */
export const DEFAULT_WIDTH_RATIO = 0.25;

/** `v` projected onto the plane perpendicular to the unit vector `n`, normalised; null when (nearly) parallel. */
function onPlane(v: Vec3, n: Vec3): Vec3 | null {
  const p = sub(v, scale(n, dot(v, n)));
  return length(p) < PARALLEL_EPSILON * Math.max(1, length(v)) ? null : normalize(p);
}

const clampSize = (s: number) => Math.min(MAX_DECAL_SIZE, Math.max(MIN_DECAL_SIZE, s));

export interface DecalSize {
  width: number;
  height: number;
  /** Defaults to `defaultDepth(width)`. */
  depth?: number;
}

/**
 * A decal placed at a raycast hit: centred on `point`, facing out along `normal`, its up the
 * camera's screen-up (column 1 of `camera.matrixWorld`, column-major as `Matrix4.elements`)
 * projected onto the surface; when that is nearly parallel to the normal, world +y, then +x.
 * Null when the normal is zero or not finite.
 */
export function frameFromHit(
  point: Vec3,
  normal: Vec3,
  cameraMatrixWorld: ArrayLike<number>,
  size: DecalSize,
  part: PartFilter = 'all',
): Decal | null {
  const n = normalize(normal);
  if (!n || !point.every(Number.isFinite)) return null;
  const screenUp: Vec3 = [cameraMatrixWorld[4] ?? 0, cameraMatrixWorld[5] ?? 0, cameraMatrixWorld[6] ?? 0];
  const up = onPlane(screenUp, n) ?? onPlane([0, 1, 0], n) ?? onPlane([1, 0, 0], n);
  if (!up) return null;
  const width = clampSize(size.width);
  return {
    center: [point[0], point[1], point[2]],
    normal: n,
    up,
    width,
    height: clampSize(size.height),
    depth: clampSize(size.depth ?? defaultDepth(width)),
    part,
    mirror: false,
  };
}

/**
 * Model space → normalised decal space as a 4×4 matrix, column-major (`Matrix4.fromArray`, a GLSL
 * `mat4` uniform): `(u, v, w) = ((p − c)·right / width, (p − c)·up / height, (p − c)·normal / depth)`.
 */
export function decalMatrix(decal: Decal): number[] {
  const rows: [Vec3, number][] = [
    [decalRight(decal), decal.width],
    [decal.up, decal.height],
    [decal.normal, decal.depth],
  ];
  const m = new Array<number>(16).fill(0);
  rows.forEach(([axis, extent], r) => {
    for (let c = 0; c < 3; c += 1) m[c * 4 + r] = (axis[c] ?? 0) / extent;
    m[12 + r] = -dot(axis, decal.center) / extent;
  });
  m[15] = 1;
  return m;
}

/** A model-space point in normalised decal space (see `decalMatrix`). */
export function toDecalSpace(p: Vec3, decal: Decal): Vec3 {
  const d = sub(p, decal.center);
  return [dot(d, decalRight(decal)) / decal.width, dot(d, decal.up) / decal.height, dot(d, decal.normal) / decal.depth];
}

/** The model-space point at decal coordinates `(u, v, w)` (inverse of `toDecalSpace`). */
export function fromDecalSpace(uvw: Vec3, decal: Decal): Vec3 {
  const right = decalRight(decal);
  return [0, 1, 2].map(
    (i) => decal.center[i]! + right[i]! * uvw[0] * decal.width + decal.up[i]! * uvw[1] * decal.height + decal.normal[i]! * uvw[2] * decal.depth,
  ) as Vec3;
}

/** The point is inside the decal's box (edges included). */
export function inBox(p: Vec3, decal: Decal): boolean {
  return toDecalSpace(p, decal).every((x) => Math.abs(x) <= 0.5);
}

/**
 * How strongly a surface with normal `n` (any length) receives the decal, 0 to 1:
 * `smoothstep(DECAL_FADE_START, DECAL_FADE_END, cos θ)` (the shader's weight, multiplying the
 * decal's alpha); 0 for a zero-length normal or a surface facing away.
 */
export function facingWeight(n: Vec3, decal: Decal): number {
  const len = length(n);
  if (!(len > 0)) return 0;
  const t = Math.min(1, Math.max(0, (dot(n, decal.normal) / len - DECAL_FADE_START) / (DECAL_FADE_END - DECAL_FADE_START)));
  return t * t * (3 - 2 * t);
}

/** A surface with normal `n` receives any of the decal (`facingWeight > 0`). */
export function facing(n: Vec3, decal: Decal): boolean {
  return facingWeight(n, decal) > 0;
}

/** `v` reflected across the plane `axis = 0` (0 = x, 1 = y, 2 = z). */
export function reflect(v: Vec3, axis: number): Vec3 {
  return v.map((x, i) => (i === axis ? -x : x)) as Vec3;
}

/**
 * The mirrored copy of a decal across the model's mirror plane (`ModelHeader.mirrorAxis = 0`):
 * centre, normal and up reflected; `right` is derived (`cross(up, normal)`), so the copy's frame
 * stays right-handed and the picture reads the right way round on the other side without being
 * flipped. Null when `axis` isn't 0, 1 or 2 (a header this version doesn't understand): callers
 * then draw no mirrored copy.
 */
export function mirrorDecal(decal: Decal, axis: number): Decal | null {
  if (axis !== 0 && axis !== 1 && axis !== 2) return null;
  return { ...decal, center: reflect(decal.center, axis), normal: reflect(decal.normal, axis), up: reflect(decal.up, axis) };
}

/** The diagonal of the bounding box of `positions` (xyz triples); 0 when empty. */
export function boundingDiagonal(positions: ArrayLike<number>): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = positions[i + k] ?? 0;
      if (v < lo[k]!) lo[k] = v;
      if (v > hi[k]!) hi[k] = v;
    }
  }
  return lo[0] === Infinity ? 0 : Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
}

/**
 * The size a new decal gets: width = DEFAULT_WIDTH_RATIO of the model's bounding-box diagonal,
 * height from the picture's (or text's) aspect (width / height), depth = 10% of the width, at
 * least 2 cm. Sides are clamped to MIN_DECAL_SIZE..MAX_DECAL_SIZE.
 */
export function defaultDecalSize(diagonal: number, aspect: number): Required<DecalSize> {
  const width = clampSize(DEFAULT_WIDTH_RATIO * diagonal);
  const height = clampSize(aspect > 0 && Number.isFinite(aspect) ? width / aspect : width);
  return { width, height, depth: clampSize(defaultDepth(width)) };
}

/** Whether the sphere (centre `c`, radius `r`) touches the decal's box. */
export function sphereTouchesBox(c: Vec3, r: number, decal: Decal): boolean {
  const d = sub(c, decal.center);
  const local = [dot(d, decalRight(decal)), dot(d, decal.up), dot(d, decal.normal)];
  const half = [decal.width / 2, decal.height / 2, decal.depth / 2];
  let dist2 = 0;
  for (let k = 0; k < 3; k += 1) {
    const out = Math.abs(local[k]!) - half[k]!;
    if (out > 0) dist2 += out * out;
  }
  return dist2 <= r * r;
}

/**
 * Texels per model unit (linear) of slot `slot` around a decal, for the text's raster size:
 * `sqrt(Σ UV area × output pixels / Σ world area)` over the slot's triangles whose bounding
 * sphere touches the decal's box (limited to the decal's part group), or over the hit triangle
 * (`hitTriangle`, an index into `indices / 3`) when none does. `output` is the size the slot is
 * baked at, not the template's (High quality bakes the body at 4096). Null when nothing has area
 * or the slot doesn't exist.
 */
export function texelsPerUnit(
  model: Pick<VehicleModelData, 'header' | 'positions' | 'uvs' | 'indices'>,
  slot: number,
  output: { width: number; height: number },
  decal: Decal,
  hitTriangle?: number,
): number | null {
  if (!model.header.slots[slot]) return null;
  const pixels = output.width * output.height;
  const group = partGroupOf(decal.part);
  const pos = (i: number): Vec3 => [model.positions[i * 3] ?? 0, model.positions[i * 3 + 1] ?? 0, model.positions[i * 3 + 2] ?? 0];
  const areas = (t: number): [number, number] => {
    const [a, b, c] = [model.indices[t * 3] ?? 0, model.indices[t * 3 + 1] ?? 0, model.indices[t * 3 + 2] ?? 0];
    const world = length(cross(sub(pos(b), pos(a)), sub(pos(c), pos(a)))) / 2;
    const [ua, va, ub, vb, uc, vc] = [a * 2, a * 2 + 1, b * 2, b * 2 + 1, c * 2, c * 2 + 1].map((k) => model.uvs[k] ?? 0) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const uv = Math.abs((ub - ua) * (vc - va) - (uc - ua) * (vb - va)) / 2;
    return [world, uv];
  };
  let world = 0;
  let uv = 0;
  for (const part of model.header.parts) {
    if (part.slot !== slot || (group !== null && part.group !== group)) continue;
    for (let t = part.indexOffset / 3; t < (part.indexOffset + part.indexCount) / 3; t += 1) {
      const [a, b, c] = [pos(model.indices[t * 3] ?? 0), pos(model.indices[t * 3 + 1] ?? 0), pos(model.indices[t * 3 + 2] ?? 0)];
      const centre = scale([a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]], 1 / 3);
      const radius = Math.max(length(sub(a, centre)), length(sub(b, centre)), length(sub(c, centre)));
      if (!sphereTouchesBox(centre, radius, decal)) continue;
      const [w, u] = areas(t);
      world += w;
      uv += u;
    }
  }
  if (world <= 0 && hitTriangle !== undefined && hitTriangle >= 0 && hitTriangle * 3 + 2 < model.indices.length) {
    [world, uv] = areas(hitTriangle);
  }
  if (world <= 0 || uv <= 0) return null;
  return Math.sqrt((uv * pixels) / world);
}
