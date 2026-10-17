import {
  MAX_DECAL_SIZE,
  MIN_DECAL_SIZE,
  add,
  cross,
  decalRight,
  dot,
  length,
  normalize,
  scale,
  sub,
  type Decal,
  type Vec3,
} from '@/atelier/project';

/**
 * Pure edits of a placed decal, shared by the gizmo (mouse) and the viewport's keys: slide along
 * the surface, rotate around the normal, scale. No React, no WebGL.
 */

/** Arrow keys move the decal by this fraction of its larger side. */
export const NUDGE_FRACTION = 0.05;
/** Shift+arrow turns it by this many degrees. */
export const ROTATE_STEP_DEG = 5;
/** + / − scale it by this factor. */
export const SCALE_STEP = 1.05;
/** Sliding adopts a surface whose normal is within this angle of the decal's; beyond it the decal keeps its orientation. */
export const MAX_SLIDE_TILT_DEG = 35;
/** Alt+wheel: depth changes by this factor per 100 px of wheel. */
export const DEPTH_WHEEL_STEP = 1.1;
export const MIN_DEPTH_UI = 0.01;
export const MAX_DEPTH_UI = 1;

const clampSize = (s: number) => Math.min(MAX_DECAL_SIZE, Math.max(MIN_DECAL_SIZE, s));

/** `v` projected onto the plane perpendicular to the unit `n` and normalised; null when (nearly) parallel. */
function onPlane(v: Vec3, n: Vec3): Vec3 | null {
  const p = sub(v, scale(n, dot(v, n)));
  return length(p) < 0.08 * Math.max(1, length(v)) ? null : normalize(p);
}

/**
 * The decal moved to a surface hit: centred there, facing out along the hit's normal, its up the
 * old up laid onto the new surface (so it keeps its turn as it slides over an edge); world +y, then
 * +x when that is impossible. The decal unchanged when the normal is degenerate.
 */
export function slideTo(decal: Decal, point: Vec3, normal: Vec3): Decal {
  const n = normalize(normal);
  if (!n || !point.every(Number.isFinite)) return decal;
  const up = onPlane(decal.up, n) ?? onPlane([0, 1, 0], n) ?? onPlane([1, 0, 0], n);
  if (!up) return decal;
  return { ...decal, center: [point[0], point[1], point[2]], normal: n, up };
}

/**
 * Where a drag or nudge that hit the model at `point` (surface `normal`) takes the decal: onto
 * that surface (`slideTo`) when it is turned at most MAX_SLIDE_TILT_DEG from the decal's own;
 * otherwise (an edge, a wheel, a hatch seen at a grazing angle) the decal keeps its orientation
 * and its centre moves to the hit projected onto its current plane, so it never tilts wildly.
 */
export function slideOnto(decal: Decal, point: Vec3, normal: Vec3): Decal {
  const n = normalize(normal);
  if (!n || !point.every(Number.isFinite)) return decal;
  if (dot(n, decal.normal) >= Math.cos((MAX_SLIDE_TILT_DEG * Math.PI) / 180)) return slideTo(decal, point, n);
  const off = dot(sub(point, decal.center), decal.normal);
  return { ...decal, center: sub(point, scale(decal.normal, off)) };
}

/** The point `du`, `dv` decal sides away from the centre on the decal's plane (keyboard nudge). */
export function nudgePoint(decal: Decal, du: number, dv: number): Vec3 {
  const step = NUDGE_FRACTION * Math.max(decal.width, decal.height);
  return add(add(decal.center, scale(decalRight(decal), du * step)), scale(decal.up, dv * step));
}

/** The decal turned by `radians` around its normal (positive: counter-clockwise seen from the front). */
export function rotateDecal(decal: Decal, radians: number): Decal {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const side = cross(decal.normal, decal.up);
  const up = normalize(add(scale(decal.up, c), scale(side, s)));
  return up ? { ...decal, up } : decal;
}

/** The decal scaled by `kx` across and `ky` up (sides clamped); the depth stays as it is. */
export function scaleDecal(decal: Decal, kx: number, ky = kx): Decal {
  if (!(kx > 0) || !(ky > 0) || !Number.isFinite(kx) || !Number.isFinite(ky)) return decal;
  return { ...decal, width: clampSize(decal.width * kx), height: clampSize(decal.height * ky) };
}

/** The box depth after an Alt+wheel of `deltaY` (positive: thinner). */
export function wheelDepth(depth: number, deltaY: number): number {
  const next = depth * Math.pow(DEPTH_WHEEL_STEP, -deltaY / 100);
  return Math.min(MAX_DEPTH_UI, Math.max(MIN_DEPTH_UI, next));
}

/** Re-exported from `@/atelier/decal` (the merge maths uses it too), so existing imports keep working. */
export { decalCorners } from '@/atelier/decal';
