import { decalCorners, mirrorDecal, upOnPlane } from './decal';
import {
  MAX_DECAL_SIZE,
  MERGE_MAX_ANGLE_DEG,
  MIN_DECAL_SIZE,
  REPEAT_DEPTH_GROWTH,
  add,
  cross,
  decalRight,
  dot,
  normalize,
  scale,
  sub,
  type Decal,
  type MergedLayer,
  type Piece,
  type PieceLayer,
  type Place,
  type PlacedLayer,
  type Repeat,
  type UnsupportedLayer,
  type UnsupportedPiece,
  type Vec3,
} from './project';

/**
 * Frame maths for repeats, Mirror and merged objects (pure: no three.js, no DOM, no store).
 *
 * With `R = decalRight(frame)`, `U = frame.up`, `N = frame.normal`, a place's angle is
 * counter-clockwise seen from the front (as `rotateDecal`): `up(a) = cos a·U − sin a·R`.
 * A repeated layer's copies and a merged object's pieces all lie on one plane; Mirror reflects
 * the envelope holding them (`mirrorAsOne`) so a row "1 2 3" or pieces "A" "B" read the same on
 * the other side instead of each copy being mirrored on its own (which would reverse the order).
 */

/** Why a merge is refused (the store's `mergeLayers`; `mergeFrame` itself only refuses `angle`). */
export type MergeRefusal = 'count' | 'unplaced' | 'angle' | 'pieces' | 'container';

const clampSize = (s: number) => Math.min(MAX_DECAL_SIZE, Math.max(MIN_DECAL_SIZE, s));

/** The angle of `up` around the frame's normal from the frame's up (counter-clockwise from the front). */
function angleIn(frame: Decal, up: Vec3): number {
  return Math.atan2(-dot(up, decalRight(frame)), dot(up, frame.up));
}

/** A piece's frame on the vehicle: inside `frame` at `place` (normal, part, depth of the frame; mirror off). */
export function pieceDecal(frame: Decal, place: Place): Decal {
  const R = decalRight(frame);
  const U = frame.up;
  const c = Math.cos(place.angle);
  const s = Math.sin(place.angle);
  return {
    ...frame,
    center: add(add(frame.center, scale(R, place.x * frame.width)), scale(U, place.y * frame.height)),
    up: normalize(sub(scale(U, c), scale(R, s))) ?? U,
    width: place.w * frame.width,
    height: place.h * frame.height,
    mirror: false,
  };
}

/**
 * Inverse of `pieceDecal` for a decal on (or near) the frame's plane: its centre projected onto
 * the plane, the angle of its up projected onto the plane, and its own size in metres (not the
 * projected one), all as fractions of the frame.
 */
export function placeOf(frame: Decal, decal: Decal): Place {
  const d = sub(decal.center, frame.center);
  const upOnFrame = sub(decal.up, scale(frame.normal, dot(decal.up, frame.normal)));
  return {
    x: dot(d, decalRight(frame)) / frame.width,
    y: dot(d, frame.up) / frame.height,
    w: decal.width / frame.width,
    h: decal.height / frame.height,
    angle: angleIn(frame, upOnFrame),
  };
}

/** How far copy `i` sits from the first: `i × (1 + gap)` widths (row) or heights (column). */
const copyOffset = (decal: Decal, repeat: Repeat, i: number) => i * (1 + repeat.gap) * (repeat.direction === 'row' ? decal.width : decal.height);

/** The unit step from one copy to the next: the frame's right (row) or its −up (column). */
const copyStep = (decal: Decal, repeat: Repeat): Vec3 => (repeat.direction === 'row' ? decalRight(decal) : scale(decal.up, -1));

/**
 * The boxes of a layer's repeat copies, first copy first (just `[decal]`, the same object, without
 * a repeat or with fewer than two copies). Copies share the first copy's plane, normal, up, size,
 * part and mirror; each one's depth grows by REPEAT_DEPTH_GROWTH × its distance from the first
 * (at most MAX_DECAL_SIZE) so a row keeps landing on gently curved surfaces.
 */
export function repeatDecals(decal: Decal, repeat: Repeat | undefined): Decal[] {
  if (!repeat || repeat.count < 2) return [decal];
  const step = copyStep(decal, repeat);
  const copies: Decal[] = [decal];
  for (let i = 1; i < repeat.count; i += 1) {
    const offset = copyOffset(decal, repeat, i);
    copies.push({
      ...decal,
      center: add(decal.center, scale(step, offset)),
      depth: Math.min(MAX_DECAL_SIZE, decal.depth + REPEAT_DEPTH_GROWTH * offset),
    });
  }
  return copies;
}

/**
 * The frame holding every copy (the envelope Mirror reflects): same axes, centre in the middle of
 * the row or column, width (row) or height (column) grown to cover the last copy, depth of the
 * last (deepest) copy. Sides are not clamped, so copies keep their spot in it. The decal itself
 * without a repeat.
 */
export function envelopeOf(decal: Decal, repeat: Repeat | undefined): Decal {
  if (!repeat || repeat.count < 2) return decal;
  const length = copyOffset(decal, repeat, repeat.count - 1);
  const row = repeat.direction === 'row';
  return {
    ...decal,
    center: add(decal.center, scale(copyStep(decal, repeat), length / 2)),
    width: row ? decal.width + length : decal.width,
    height: row ? decal.height : decal.height + length,
    depth: Math.min(MAX_DECAL_SIZE, decal.depth + REPEAT_DEPTH_GROWTH * length),
  };
}

/**
 * `boxes` reflected as one picture across the model's mirror plane: the envelope mirrored
 * (`mirrorDecal`, which keeps pictures readable) and each box placed in it at the same local spot
 * (right, up) and turn, facing the reflected envelope's normal. Each box keeps its own size and
 * part; its depth is at least the envelope's (a mirrored row's copy i lands on the reflection of
 * copy N−1−i, so it takes the deepest copy's box, which `envelopeOf` carries). `mirror` is off so
 * nothing mirrors them again. For one box that is its own envelope this is `mirrorDecal(box)` with
 * mirror off. Null for an invalid axis (no mirrored copy drawn).
 */
export function mirrorAsOne(boxes: readonly Decal[], envelope: Decal, axis: number): Decal[] | null {
  const mirrored = mirrorDecal(envelope, axis);
  if (!mirrored) return null;
  const R = decalRight(envelope);
  const U = envelope.up;
  const R2 = decalRight(mirrored);
  const U2 = mirrored.up;
  return boxes.map((box) => {
    const d = sub(box.center, envelope.center);
    const lx = dot(d, R);
    const ly = dot(d, U);
    const a = angleIn(envelope, box.up);
    const c = Math.cos(a);
    const s = Math.sin(a);
    return {
      ...box,
      center: add(add(mirrored.center, scale(R2, lx)), scale(U2, ly)),
      normal: mirrored.normal,
      up: normalize(sub(scale(U2, c), scale(R2, s))) ?? U2,
      depth: Math.max(box.depth, envelope.depth),
      mirror: false,
    };
  });
}

/**
 * The shared frame of a merge (spec "Merge"). The plane's normal is the normalised mean of the
 * boxes' normals; refused (`angle`) when any box faces more than MERGE_MAX_ANGLE_DEG away from it
 * (or the normals cancel out). Up is `topUp` (the topmost layer's) projected onto the plane, with
 * `frameFromHit`'s fallbacks. Width and height are the bounding rectangle of every box's corners
 * on the plane (clamped to MIN_DECAL_SIZE..MAX_DECAL_SIZE); the centre sits in the middle of the
 * corners on all three axes; depth is the deepest box plus the corners' spread along the normal,
 * so no box's corners fall outside. `part: 'all'` and `mirror: false`: the caller decides those.
 */
export function mergeFrame(boxes: readonly Decal[], topUp: Vec3): { frame: Decal } | { refused: 'angle' } {
  const refused = { refused: 'angle' as const };
  const n = normalize(boxes.reduce<Vec3>((s, b) => add(s, b.normal), [0, 0, 0]));
  if (!n || boxes.length === 0) return refused;
  const minDot = Math.cos((MERGE_MAX_ANGLE_DEG * Math.PI) / 180);
  if (boxes.some((b) => dot(b.normal, n) < minDot)) return refused;
  const U = upOnPlane(topUp, n);
  const R = U && normalize(cross(U, n));
  if (!U || !R) return refused;
  const origin = boxes[0]!.center;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (const p of decalCorners(b)) {
      const d = sub(p, origin);
      const at = [dot(d, R), dot(d, U), dot(d, n)];
      for (let k = 0; k < 3; k += 1) {
        lo[k] = Math.min(lo[k]!, at[k]!);
        hi[k] = Math.max(hi[k]!, at[k]!);
      }
    }
  }
  const mid = [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2) as Vec3;
  const deepest = Math.max(...boxes.map((b) => b.depth));
  return {
    frame: {
      center: add(add(add(origin, scale(R, mid[0])), scale(U, mid[1])), scale(n, mid[2])),
      normal: n,
      up: U,
      width: clampSize(hi[0]! - lo[0]!),
      height: clampSize(hi[1]! - lo[1]!),
      depth: clampSize(deepest + (hi[2]! - lo[2]!)),
      part: 'all',
      mirror: false,
    },
  };
}

/**
 * A merged object's pieces as layers again (Separate), bottom to top with the same ids: each
 * drawable piece gets the decal of its place in the frame with the frame's normal, depth, part and
 * mirror, opacity × the object's; unsupported pieces come back as unsupported layers. Every
 * piece is hidden when the object is. Nothing for an unplaced object.
 */
export function separatePieces(merged: MergedLayer): (PlacedLayer | UnsupportedLayer)[] {
  const frame = merged.decal;
  if (!frame) return [];
  return merged.children.map((child): PlacedLayer | UnsupportedLayer => {
    if (child.kind === 'unsupported') {
      const layer: Partial<UnsupportedPiece> & UnsupportedLayer = { ...child, visible: child.visible && merged.visible };
      delete layer.place;
      return layer;
    }
    const piece: Piece = child;
    const layer = {
      ...piece,
      decal: { ...pieceDecal(frame, piece.place), depth: frame.depth, part: frame.part, mirror: frame.mirror },
      opacity: piece.opacity * merged.opacity,
      visible: piece.visible && merged.visible,
    } as PieceLayer & { place?: Place };
    delete layer.place;
    return layer;
  });
}
