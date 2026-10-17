import { add, cross, dot, length, normalize, scale, sub, type Decal, type Vec3 } from '@/atelier/project';
import { rotateDecal } from './decalOps';

/**
 * Snapping for the decal gizmo (pure maths, no React, no WebGL). While a decal is dragged its
 * centre is pulled onto:
 * - the model's **centre line**, the mirror plane `mirrorAxis = 0` (moving within the decal's
 *   plane), when the decal's surface crosses it (not on a side facing along the axis);
 * - the **height** or the **vertical** of another decal's centre on a surface turned at most
 *   ALIGN_MAX_TILT_DEG from this one, along the surface's level frame (`levelFrame`).
 * While it is turned, it settles **level** (up along the frame's vertical or horizontal) within
 * LEVEL_SNAP_DEG. Every pull is at most SNAP_PX screen pixels; each one comes with a guide (a
 * segment in model space the gizmo draws dashed).
 */

/** A pull reaches this far on screen, CSS px. */
export const SNAP_PX = 8;
/** A turn settles level within this many degrees of it. */
export const LEVEL_SNAP_DEG = 4;
/** Other decals align with this one only on a surface turned at most this much from it. */
export const ALIGN_MAX_TILT_DEG = 20;
/** The centre line needs the decal's plane to cross the mirror plane at least this steeply (sine). */
const MIN_CROSSING = 0.3;
/** A pull along a direction that would move the centre off the centre line this much (cosine) is skipped once it snapped there. */
const KEEPS_CENTRE_LINE = 0.3;

const WORLD_UP: Vec3 = [0, 1, 0];
const WORLD_FORWARD: Vec3 = [1, 0, 0];

/** A guide line to draw while a snap holds (model space). */
export interface SnapGuide {
  kind: 'centre' | 'align' | 'level';
  from: Vec3;
  to: Vec3;
}

export interface SnapContext {
  /** `ModelHeader.mirrorAxis` (0, 1 or 2; anything else: no centre line). */
  mirrorAxis: number;
  /** The other image and text decals of the project. */
  others: readonly Decal[];
  /** Model units per screen pixel at the decal (from the camera). */
  unitsPerPx: number;
}

export interface SnapResult {
  decal: Decal;
  guides: SnapGuide[];
}

const axisVector = (axis: number): Vec3 => [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];

/** `v` laid onto the plane of the unit normal `n`, normalised; null when (nearly) along `n`. */
function onPlane(v: Vec3, n: Vec3, min = 0.3): Vec3 | null {
  const p = sub(v, scale(n, dot(v, n)));
  return length(p) < min ? null : normalize(p);
}

/**
 * The surface's level frame at the decal: `vertical` is the model's up laid onto the decal's
 * plane (its forward axis on a roof or a floor, where up is the normal), `horizontal` completes
 * it (`cross(vertical, normal)`, so it runs like the decal's right when the decal is level).
 */
export function levelFrame(normal: Vec3): { vertical: Vec3; horizontal: Vec3 } {
  const vertical = onPlane(WORLD_UP, normal) ?? onPlane(WORLD_FORWARD, normal, 0.05) ?? normalize(cross(normal, [0, 0, 1]))!;
  return { vertical, horizontal: normalize(cross(vertical, normal)) ?? cross(vertical, normal) };
}

/** The decal moved by `delta` (model units) within its plane. */
const moved = (decal: Decal, delta: Vec3): Decal => ({ ...decal, center: add(decal.center, delta) });

/** The decal's centre pulled onto the centre line, the height or the vertical of the other decals. */
export function snapMove(decal: Decal, ctx: SnapContext): SnapResult {
  const reach = SNAP_PX * ctx.unitsPerPx;
  if (!(reach > 0) || !Number.isFinite(reach)) return { decal, guides: [] };
  const guides: SnapGuide[] = [];
  const size = Math.max(decal.width, decal.height);
  let out = decal;
  let centreAxis: Vec3 | null = null;

  // Centre line: move within the plane along the direction that changes the axis coordinate fastest.
  if (ctx.mirrorAxis === 0 || ctx.mirrorAxis === 1 || ctx.mirrorAxis === 2) {
    const e = axisVector(ctx.mirrorAxis);
    const along = sub(e, scale(decal.normal, dot(e, decal.normal)));
    const crossing = length(along);
    const offset = decal.center[ctx.mirrorAxis]!;
    if (crossing >= MIN_CROSSING && Math.abs(offset) / crossing <= reach) {
      out = moved(out, scale(along, -offset / (crossing * crossing)));
      centreAxis = e;
      const line = normalize(cross(decal.normal, e));
      if (line) guides.push({ kind: 'centre', from: add(out.center, scale(line, -size)), to: add(out.center, scale(line, size)) });
    }
  }

  // Alignment with other decals on a surface facing about the same way, along the level frame.
  const { vertical, horizontal } = levelFrame(decal.normal);
  const minCos = Math.cos((ALIGN_MAX_TILT_DEG * Math.PI) / 180);
  const peers = ctx.others.filter((o) => dot(o.normal, decal.normal) >= minCos);
  for (const direction of [horizontal, vertical]) {
    // Moving along `direction` would leave the centre line: that snap wins.
    if (centreAxis && Math.abs(dot(direction, centreAxis)) > KEEPS_CENTRE_LINE) continue;
    let best: { shift: number; peer: Decal } | null = null;
    for (const peer of peers) {
      const shift = dot(sub(peer.center, out.center), direction);
      if (Math.abs(shift) <= reach && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, peer };
    }
    if (!best) continue;
    out = moved(out, scale(direction, best.shift));
    guides.push({ kind: 'align', from: out.center, to: best.peer.center });
  }
  return { decal: out, guides };
}

/** The decal's turn from level around its normal, radians (positive: counter-clockwise from the front). */
export function levelAngle(decal: Decal): number {
  const { vertical } = levelFrame(decal.normal);
  return Math.atan2(dot(cross(vertical, decal.up), decal.normal), dot(vertical, decal.up));
}

/** The decal turned level (up along the frame's vertical or horizontal, either way) when within LEVEL_SNAP_DEG. */
export function snapLevel(decal: Decal): SnapResult {
  const theta = levelAngle(decal);
  const quarter = Math.PI / 2;
  const target = Math.round(theta / quarter) * quarter;
  if (Math.abs(target - theta) > (LEVEL_SNAP_DEG * Math.PI) / 180) return { decal, guides: [] };
  const out = rotateDecal(decal, target - theta);
  const { vertical } = levelFrame(decal.normal);
  const reach = Math.max(decal.width, decal.height);
  return { decal: out, guides: [{ kind: 'level', from: add(out.center, scale(vertical, -reach)), to: add(out.center, scale(vertical, reach)) }] };
}

/** Model units per screen pixel at `point`, from two projected points `unit` apart along `along`. */
export function unitsPerPixel(project: (p: Vec3) => { x: number; y: number }, point: Vec3, along: Vec3, unit: number): number {
  const a = project(point);
  const b = project(add(point, scale(along, unit)));
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  return px > 1e-6 ? unit / px : 0;
}

