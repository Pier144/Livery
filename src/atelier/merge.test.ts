import { describe, expect, it } from 'vitest';
import { decalCorners, mirrorDecal } from './decal';
import { envelopeOf, mergeFrame, mirrorAsOne, pieceDecal, placeOf, repeatDecals, separatePieces } from './merge';
import {
  MAX_DECAL_SIZE,
  MERGE_MAX_ANGLE_DEG,
  REPEAT_DEPTH_GROWTH,
  add,
  checkPlacedLayer,
  decalRight,
  dot,
  length,
  newImageLayer,
  newShapeLayer,
  newTextLayer,
  normalize,
  scale,
  sub,
  type Decal,
  type MergedLayer,
  type Piece,
  type Place,
  type PlacedLayer,
  type UnsupportedPiece,
  type Vec3,
} from './project';

const DEG = Math.PI / 180;

function decal(over: Partial<Decal> = {}): Decal {
  return { center: [0, 1, 0], normal: [0, 0, 1], up: [0, 1, 0], width: 0.4, height: 0.2, depth: 0.05, part: 'all', mirror: false, ...over };
}

/** A unit normal turned by `deg` around world +y from +z (toward +x). */
const turned = (deg: number): Vec3 => [Math.sin(deg * DEG), 0, Math.cos(deg * DEG)];

function expectVec(a: Vec3, b: Vec3, tol: number) {
  for (let i = 0; i < 3; i += 1) expect(Math.abs(a[i]! - b[i]!)).toBeLessThanOrEqual(tol);
}

function expectDecal(a: Decal, b: Decal, tol: number) {
  expectVec(a.center, b.center, tol);
  expectVec(a.normal, b.normal, tol);
  expectVec(a.up, b.up, tol);
  expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.depth - b.depth)).toBeLessThanOrEqual(tol);
  expect(a.part).toBe(b.part);
  expect(a.mirror).toBe(b.mirror);
}

/** `p` in `frame`'s local metres (right, up, normal) from its centre. */
function local(p: Vec3, frame: Decal): Vec3 {
  const d = sub(p, frame.center);
  return [dot(d, decalRight(frame)), dot(d, frame.up), dot(d, frame.normal)];
}

const FRAMES: Decal[] = [
  decal(),
  decal({ center: [1.2, 0.4, -0.3], normal: [1, 0, 0], up: [0, 1, 0], width: 2, height: 0.5, depth: 0.3, part: 'hull' }),
  decal({ center: [0, 2, 0], normal: [0, 1, 0], up: [0, 0, -1], width: 0.7, height: 1.4 }),
  decal({ center: [-0.5, 0.3, 0.9], normal: normalize([0.3, 0.5, -0.8])!, up: normalize([0, 0.8, 0.5])!, width: 1.1, height: 0.9 }),
];
const PLACES: Place[] = [
  { x: 0, y: 0, w: 1, h: 1, angle: 0 },
  { x: -0.3, y: 0.2, w: 0.25, h: 0.5, angle: 0.4 },
  { x: 0.45, y: -0.4, w: 0.1, h: 0.05, angle: -2.5 },
  { x: 0.6, y: 0.55, w: 1.3, h: 0.7, angle: Math.PI / 2 },
];

describe('pieceDecal / placeOf', () => {
  it('pieceDecal centres, turns and sizes the piece inside the frame', () => {
    const f = FRAMES[0]!;
    const d = pieceDecal({ ...f, mirror: true }, { x: 0.25, y: -0.5, w: 0.5, h: 2, angle: Math.PI / 2 });
    // Right of FRAMES[0] is +x, up +y: a quarter turn counter-clockwise points up toward −x.
    expectVec(d.center, [0.1, 0.9, 0], 1e-12);
    expectVec(d.up, [-1, 0, 0], 1e-12);
    expectVec(d.normal, f.normal, 0);
    expect(d.width).toBeCloseTo(0.2, 12);
    expect(d.height).toBeCloseTo(0.4, 12);
    expect(d.depth).toBe(f.depth);
    expect(d.mirror).toBe(false);
  });

  it('placeOf inverts pieceDecal', () => {
    for (const f of FRAMES) {
      for (const p of PLACES) {
        const back = placeOf(f, pieceDecal(f, p));
        expect(Math.abs(back.x - p.x)).toBeLessThan(1e-9);
        expect(Math.abs(back.y - p.y)).toBeLessThan(1e-9);
        expect(Math.abs(back.w - p.w)).toBeLessThan(1e-9);
        expect(Math.abs(back.h - p.h)).toBeLessThan(1e-9);
        // Angles compare modulo a full turn.
        const da = Math.atan2(Math.sin(back.angle - p.angle), Math.cos(back.angle - p.angle));
        expect(Math.abs(da)).toBeLessThan(1e-9);
      }
    }
  });

  it('placeOf keeps a tilted decal its own size and reads the angle of its projected up', () => {
    const f = FRAMES[0]!;
    const d = decal({ center: [0.1, 1.05, 0.02], normal: turned(20), up: [0, 1, 0], width: 0.2, height: 0.1 });
    const p = placeOf(f, d);
    expect(p.x).toBeCloseTo(0.25, 12);
    expect(p.y).toBeCloseTo(0.25, 12);
    expect(p.w).toBeCloseTo(0.5, 12);
    expect(p.h).toBeCloseTo(0.5, 12);
    expect(p.angle).toBeCloseTo(0, 12);
  });
});

describe('repeatDecals', () => {
  it('is just the decal without a repeat or with fewer than two copies', () => {
    const d = decal();
    expect(repeatDecals(d, undefined)).toEqual([d]);
    expect(repeatDecals(d, undefined)[0]).toBe(d);
    expect(repeatDecals(d, { count: 1, gap: 0.5, direction: 'row' })[0]).toBe(d);
  });

  it('lays a row along the right with depth growing with the distance', () => {
    const d = decal({ mirror: true, part: 'turret' });
    const copies = repeatDecals(d, { count: 3, gap: 0.5, direction: 'row' });
    expect(copies).toHaveLength(3);
    expect(copies[0]).toEqual(d);
    copies.forEach((c, i) => {
      const offset = i * 1.5 * d.width;
      expectVec(c.center, add(d.center, [offset, 0, 0]), 1e-12);
      expect(c.depth).toBeCloseTo(d.depth + REPEAT_DEPTH_GROWTH * offset, 12);
      expect(c.normal).toEqual(d.normal);
      expect(c.up).toEqual(d.up);
      expect([c.width, c.height, c.part, c.mirror]).toEqual([d.width, d.height, d.part, d.mirror]);
    });
  });

  it('lays a column downwards (along −up) by heights', () => {
    const d = FRAMES[3]!;
    const copies = repeatDecals(d, { count: 4, gap: 0.25, direction: 'column' });
    copies.forEach((c, i) => {
      const offset = i * 1.25 * d.height;
      expectVec(c.center, sub(d.center, scale(d.up, offset)), 1e-12);
      expect(c.depth).toBeCloseTo(d.depth + REPEAT_DEPTH_GROWTH * offset, 12);
    });
  });

  it('caps the depth at MAX_DECAL_SIZE', () => {
    const d = decal({ width: 60, depth: MAX_DECAL_SIZE - 0.5 });
    const copies = repeatDecals(d, { count: 2, gap: 0, direction: 'row' });
    expect(copies[1]!.depth).toBe(MAX_DECAL_SIZE);
  });
});

describe('envelopeOf', () => {
  it('is the decal itself without a repeat', () => {
    const d = decal();
    expect(envelopeOf(d, undefined)).toBe(d);
  });

  it('holds a row: centre in the middle, width covering every copy', () => {
    const d = decal();
    const env = envelopeOf(d, { count: 3, gap: 0.5, direction: 'row' });
    const copies = repeatDecals(d, { count: 3, gap: 0.5, direction: 'row' });
    expectVec(env.center, scale(add(copies[0]!.center, copies[2]!.center), 0.5), 1e-12);
    expect(env.width).toBeCloseTo(d.width + 2 * 1.5 * d.width, 12);
    expect(env.height).toBe(d.height);
    expect(env.up).toEqual(d.up);
    expect(env.normal).toEqual(d.normal);
    // Every copy's corners lie inside the envelope on its plane.
    for (const c of copies) {
      for (const p of decalCorners(c)) {
        const [x, y] = local(p, env);
        expect(Math.abs(x)).toBeLessThanOrEqual(env.width / 2 + 1e-12);
        expect(Math.abs(y)).toBeLessThanOrEqual(env.height / 2 + 1e-12);
      }
    }
  });

  it('holds a column: centre half the length down, height covering every copy', () => {
    const d = decal();
    const env = envelopeOf(d, { count: 2, gap: 1, direction: 'column' });
    expectVec(env.center, sub(d.center, scale(d.up, d.height)), 1e-12);
    expect(env.height).toBeCloseTo(d.height * 3, 12);
    expect(env.width).toBe(d.width);
  });
});

describe('mirrorAsOne', () => {
  it('equals mirrorDecal (mirror off) for a single box that is its own envelope', () => {
    for (const f of FRAMES) {
      for (const axis of [0, 1, 2]) {
        const box = { ...f, mirror: true };
        const [m] = mirrorAsOne([box], box, axis)!;
        expectDecal(m!, { ...mirrorDecal(box, axis)!, mirror: false }, 1e-12);
      }
    }
  });

  it('is null for an invalid axis', () => {
    expect(mirrorAsOne([decal()], decal(), 3)).toBeNull();
    expect(mirrorAsOne([decal()], decal(), -1)).toBeNull();
  });

  it('keeps the reading order of two pieces on the other side', () => {
    const frame = decal({ center: [0.2, 1, -0.6], normal: [0, 0, -1], up: [0, 1, 0], width: 1, height: 0.3, mirror: true });
    const a = pieceDecal(frame, { x: -0.3, y: 0, w: 0.3, h: 1, angle: 0 });
    const b = pieceDecal(frame, { x: 0.3, y: 0, w: 0.3, h: 1, angle: 0 });
    const mirrored = mirrorAsOne([a, b], frame, 2)!;
    const env = mirrorDecal(frame, 2)!;
    const [ma, mb] = mirrored as [Decal, Decal];
    expect(local(ma.center, env)[0]).toBeCloseTo(-0.3 * frame.width, 12);
    expect(local(mb.center, env)[0]).toBeCloseTo(0.3 * frame.width, 12);
    for (const m of mirrored) {
      expect(m.mirror).toBe(false);
      expectVec(m.normal, env.normal, 1e-12);
      expectVec(m.up, env.up, 1e-12);
    }
    // Mirroring each piece on its own would swap them: A would land on the right.
    expect(local(mirrorDecal(a, 2)!.center, env)[0]).toBeCloseTo(0.3 * frame.width, 12);
  });

  it('keeps a piece turned inside its frame turned the same way', () => {
    const frame = decal({ normal: [0, 0, -1], up: [0, 1, 0], width: 1, height: 1 });
    const p = pieceDecal(frame, { x: 0.2, y: -0.1, w: 0.2, h: 0.4, angle: 0.6 });
    const [m] = mirrorAsOne([p], frame, 2)!;
    const env = mirrorDecal(frame, 2)!;
    const back = placeOf(env, m!);
    expect(back.x).toBeCloseTo(0.2, 12);
    expect(back.y).toBeCloseTo(-0.1, 12);
    expect(back.angle).toBeCloseTo(0.6, 12);
    expect(back.w).toBeCloseTo(0.2, 12);
    expect(back.h).toBeCloseTo(0.4, 12);
  });

  it('mirrors a row as one picture: over the reflected area, copy 0 still first', () => {
    const d = decal({ center: [0.5, 1, -0.6], normal: [0, 0, -1], up: [0, 1, 0], width: 0.3, height: 0.2, mirror: true });
    const repeat = { count: 3, gap: 0.5, direction: 'row' as const };
    const copies = repeatDecals(d, repeat);
    const env = envelopeOf(d, repeat);
    const mirrored = mirrorAsOne(copies, env, 2)!;
    const envM = mirrorDecal(env, 2)!;
    const mean = scale(mirrored.reduce<Vec3>((s, m) => add(s, m.center), [0, 0, 0]), 1 / mirrored.length);
    expectVec(mean, envM.center, 1e-12);
    const xs = mirrored.map((m) => local(m.center, envM)[0]);
    expect(xs[0]).toBeLessThan(xs[1]!);
    expect(xs[1]).toBeLessThan(xs[2]!);
    // Each copy keeps its own depth (growth included), size and part.
    mirrored.forEach((m, i) => {
      expect(m.depth).toBe(copies[i]!.depth);
      expect([m.width, m.height, m.part]).toEqual([d.width, d.height, d.part]);
    });
    // The mirrored copies cover the reflection of the original row's area.
    const reflectedCorners = copies.flatMap((c) => decalCorners(c)).map((p) => [p[0], p[1], -p[2]] as Vec3);
    const mirroredCorners = mirrored.flatMap((m) => decalCorners(m));
    for (const p of reflectedCorners) {
      expect(mirroredCorners.some((q) => length(sub(p, q)) < 1e-12)).toBe(true);
    }
  });
});

describe('mergeFrame', () => {
  it('encloses coplanar boxes in a frame on their plane', () => {
    const boxes = [
      decal({ center: [0, 1, 0.5], width: 0.4, height: 0.2 }),
      decal({ center: [0.5, 1.3, 0.5], up: normalize([1, 1, 0])!, width: 0.3, height: 0.3 }),
      decal({ center: [-0.4, 0.8, 0.5], width: 0.1, height: 0.6, depth: 0.08 }),
    ];
    const r = mergeFrame(boxes, [0, 1, 0]);
    expect('frame' in r).toBe(true);
    const f = (r as { frame: Decal }).frame;
    expectVec(f.normal, [0, 0, 1], 1e-12);
    expectVec(f.up, [0, 1, 0], 1e-12);
    expect(f.center[2]).toBeCloseTo(0.5, 12);
    expect(f.depth).toBeCloseTo(0.08, 12);
    expect(f.part).toBe('all');
    expect(f.mirror).toBe(false);
    const corners = boxes.flatMap((b) => decalCorners(b));
    for (const p of corners) {
      const [x, y] = local(p, f);
      expect(Math.abs(x)).toBeLessThanOrEqual(f.width / 2 + 1e-12);
      expect(Math.abs(y)).toBeLessThanOrEqual(f.height / 2 + 1e-12);
    }
    // Tight: the extremes touch the frame's edges.
    const xs = corners.map((p) => local(p, f)[0]);
    expect(Math.max(...xs)).toBeCloseTo(f.width / 2, 12);
    expect(Math.min(...xs)).toBeCloseTo(-f.width / 2, 12);
  });

  it('takes the up from topUp projected onto the plane, falling back to world +y', () => {
    const boxes = [decal(), decal({ center: [0.5, 1, 0] })];
    const tilted = (mergeFrame(boxes, [1, 1, 0.7]) as { frame: Decal }).frame;
    expectVec(tilted.up, normalize([1, 1, 0])!, 1e-12);
    const parallel = (mergeFrame(boxes, [0, 0, 3]) as { frame: Decal }).frame;
    expectVec(parallel.up, [0, 1, 0], 1e-12);
  });

  it('accepts boxes tilted ±20° and its depth covers every corner', () => {
    const boxes = [
      decal({ center: [-0.3, 1, 0.1], normal: turned(-20), width: 0.4, height: 0.3 }),
      decal({ center: [0.3, 1, 0.1], normal: turned(20), width: 0.4, height: 0.3, depth: 0.04 }),
    ];
    const r = mergeFrame(boxes, [0, 1, 0]);
    expect('frame' in r).toBe(true);
    const f = (r as { frame: Decal }).frame;
    expectVec(f.normal, [0, 0, 1], 1e-12);
    for (const b of boxes) {
      for (const p of decalCorners(b)) {
        const [x, y, z] = local(p, f);
        expect(Math.abs(z)).toBeLessThanOrEqual(f.depth / 2 + 1e-12);
        expect(Math.abs(x)).toBeLessThanOrEqual(f.width / 2 + 1e-12);
        expect(Math.abs(y)).toBeLessThanOrEqual(f.height / 2 + 1e-12);
      }
    }
  });

  it('refuses boxes facing too differently', () => {
    const at = (deg: number, x: number) => decal({ center: [x, 1, 0], normal: turned(deg) });
    expect(mergeFrame([at(-50, -0.3), at(50, 0.3)], [0, 1, 0])).toEqual({ refused: 'angle' });
    const limit = MERGE_MAX_ANGLE_DEG;
    expect('frame' in mergeFrame([at(-(limit - 1), -0.3), at(limit - 1, 0.3)], [0, 1, 0])).toBe(true);
    expect(mergeFrame([at(-(limit + 1), -0.3), at(limit + 1, 0.3)], [0, 1, 0])).toEqual({ refused: 'angle' });
    // Opposite normals have no mean plane.
    expect(mergeFrame([at(0, 0), at(180, 0.3)], [0, 1, 0])).toEqual({ refused: 'angle' });
  });
});

describe('separatePieces', () => {
  function piecesOf(layers: PlacedLayer[], frame: Decal): Piece[] {
    return layers.map((l) => {
      const piece = { ...l, place: placeOf(frame, l.decal!) } as Partial<PlacedLayer> & { place: Place };
      delete piece.decal;
      delete piece.repeat;
      return piece as Piece;
    });
  }

  it('gives coplanar layers back after a merge (centre, size, up within 1e-6)', () => {
    const layers: PlacedLayer[] = [
      newImageLayer('asset-1', decal({ center: [0.1, 1.1, 0.4], up: normalize([0.2, 1, 0])!, width: 0.3, height: 0.2 })),
      { ...newTextLayer('AB', decal({ center: [-0.3, 0.9, 0.4], width: 0.5, height: 0.25 })), opacity: 0.5 },
      newShapeLayer('star', decal({ center: [0.4, 0.7, 0.4], up: normalize([-1, 0.3, 0])!, width: 0.2, height: 0.2 })),
    ];
    const r = mergeFrame(
      layers.map((l) => l.decal!),
      layers[2]!.decal!.up,
    );
    const frame = { ...(r as { frame: Decal }).frame, part: 'hull', mirror: true };
    const merged: MergedLayer = { id: 'm1', kind: 'merged', name: '', visible: true, decal: frame, opacity: 0.8, children: piecesOf(layers, frame) };
    const back = separatePieces(merged);
    expect(back).toHaveLength(3);
    back.forEach((b, i) => {
      const orig = layers[i]!;
      expect(b.kind).toBe(orig.kind);
      expect(b.id).toBe(orig.id);
      expect('place' in b).toBe(false);
      const d = (b as PlacedLayer).decal!;
      const o = orig.decal!;
      expectVec(d.center, o.center, 1e-6);
      expectVec(d.up, o.up, 1e-6);
      expectVec(d.normal, o.normal, 1e-6);
      expect(Math.abs(d.width - o.width)).toBeLessThan(1e-6);
      expect(Math.abs(d.height - o.height)).toBeLessThan(1e-6);
      expect(d.depth).toBe(frame.depth);
      expect(d.part).toBe('hull');
      expect(d.mirror).toBe(true);
      expect((b as PlacedLayer & { opacity: number }).opacity).toBeCloseTo((orig as { opacity: number }).opacity * 0.8, 12);
      expect(checkPlacedLayer(b as PlacedLayer)).not.toBeNull();
    });
  });

  it('hides pieces of a hidden object and keeps unsupported pieces as unsupported layers', () => {
    const frame = decal();
    const hiddenPiece = { ...newShapeLayer('rect', frame), visible: false };
    const unsupported: UnsupportedPiece = {
      id: 'u1',
      kind: 'unsupported',
      name: '',
      visible: true,
      original: { kind: 'sticker', id: 'u1' },
      place: { x: 0, y: 0, w: 1, h: 1, angle: 0 },
    };
    const children = [...piecesOf([newImageLayer('a', frame), hiddenPiece], frame), unsupported];
    const merged: MergedLayer = { id: 'm', kind: 'merged', name: '', visible: false, decal: frame, opacity: 1, children };
    const back = separatePieces(merged);
    expect(back.map((b) => b.visible)).toEqual([false, false, true]);
    expect(back[2]).toEqual({ id: 'u1', kind: 'unsupported', name: '', visible: true, original: { kind: 'sticker', id: 'u1' } });
    const shown = separatePieces({ ...merged, visible: true });
    expect(shown.map((b) => b.visible)).toEqual([true, false, true]);
  });

  it('gives nothing for an unplaced merged object', () => {
    const merged: MergedLayer = {
      id: 'm',
      kind: 'merged',
      name: '',
      visible: true,
      decal: null,
      opacity: 1,
      children: [{ ...newImageLayer('a', null), place: { x: 0, y: 0, w: 1, h: 1, angle: 0 } } as Piece],
    };
    expect(separatePieces(merged)).toEqual([]);
  });
});
