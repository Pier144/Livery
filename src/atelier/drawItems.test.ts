import { describe, expect, it } from 'vitest';
import { mirrorDecal } from './decal';
import { drawGroups, type DrawGroup } from './drawItems';
import { envelopeOf, mirrorAsOne, pieceDecal, repeatDecals } from './merge';
import {
  decalRight,
  dot,
  newBaseLayer,
  newFolder,
  newImageLayer,
  newMaskLayer,
  newShapeLayer,
  newTextLayer,
  sub,
  type Decal,
  type Layer,
  type MergedLayer,
  type Piece,
  type Place,
  type ShapeLayer,
  type UnsupportedLayer,
  type UnsupportedPiece,
  type Vec3,
} from './project';

const AXIS = 2;

function decal(over: Partial<Decal> = {}): Decal {
  return { center: [0.2, 1, -0.6], normal: [0, 0, -1], up: [0, 1, 0], width: 0.4, height: 0.2, depth: 0.05, part: 'all', mirror: false, ...over };
}

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

/** `p` in `frame`'s local metres (right, up) from its centre. */
function localX(p: Vec3, frame: Decal): number {
  return dot(sub(p, frame.center), decalRight(frame));
}

/** `layer` as a piece at `place` (its decal and repeat dropped). */
function piece(layer: object, place: Place): Piece {
  const p = { ...layer, place } as Partial<ShapeLayer> & { place: Place };
  delete p.decal;
  delete p.repeat;
  return p as Piece;
}

function merged(children: (Piece | UnsupportedPiece)[], over: Partial<MergedLayer> = {}): MergedLayer {
  return { id: 'm', kind: 'merged', name: '', visible: true, decal: decal({ width: 1, height: 0.3 }), opacity: 1, children, ...over };
}

const ids = (groups: readonly DrawGroup[]) => groups.map((g) => g.id);
const allBoxes = (groups: readonly DrawGroup[]) => groups.flatMap((g) => g.boxes);

describe('drawGroups: what is drawn', () => {
  it('skips the Base, the mask, unsupported, hidden, unplaced and transparent layers', () => {
    const unsupported: UnsupportedLayer = { id: 'u', kind: 'unsupported', name: '', visible: true, original: { kind: 'sticker' } };
    const shown = newImageLayer('a', decal());
    const layers: Layer[] = [
      newBaseLayer(),
      { ...newImageLayer('b', decal()), visible: false },
      newImageLayer('c', null),
      { ...newTextLayer('T', decal()), opacity: 0 },
      unsupported,
      shown,
      newMaskLayer(),
    ];
    const plan = drawGroups(layers, AXIS);
    expect(ids(plan.groups)).toEqual([shown.id]);
    expect(plan.boxes).toBe(1);
    expect(plan.truncated).toBe(false);
  });

  it('draws a folder’s children in order, bottom to top, and nothing of a hidden folder', () => {
    const a = newImageLayer('a', decal());
    const b = newTextLayer('B', decal());
    const c = newShapeLayer('star', decal());
    const hiddenChild = { ...newShapeLayer('rect', decal()), visible: false };
    const folder = newFolder('f', [b, hiddenChild, c]);
    const hidden = { ...newFolder('g', [newImageLayer('x', decal())]), visible: false };
    const top = newImageLayer('d', decal());
    expect(ids(drawGroups([a, folder, hidden, top], AXIS).groups)).toEqual([a.id, b.id, c.id, top.id]);
  });

  it('gives a plain layer one group with its own box, opacity, wear and flip', () => {
    const d = decal();
    const img = { ...newImageLayer('a', d), opacity: 0.5, wear: 0.3, flipX: true };
    const txt = { ...newTextLayer('T', d), flipX: true } as Layer;
    const [g, t] = drawGroups([img, txt], AXIS).groups as [DrawGroup, DrawGroup];
    expect(g).toMatchObject({ id: img.id, source: img, variant: 'main', opacity: 0.5, wear: 0.3, flipX: true });
    expect(g.boxes).toEqual([d]);
    expect(g.boxes[0]).toBe(d);
    expect(g.rasterDecal).toBe(d);
    expect(t.flipX).toBe(false);
    expect(t.wear).toBeUndefined();
  });

  it('skips hidden merged objects, hidden pieces, unsupported pieces and transparent pieces', () => {
    const a = piece(newShapeLayer('rect', null), { x: -0.3, y: 0, w: 0.3, h: 1, angle: 0 });
    const hiddenPiece = piece({ ...newShapeLayer('rect', null), visible: false }, { x: 0, y: 0, w: 0.2, h: 1, angle: 0 });
    const clear = piece({ ...newShapeLayer('rect', null), opacity: 0 }, { x: 0.1, y: 0, w: 0.2, h: 1, angle: 0 });
    const unsupported: UnsupportedPiece = { id: 'u', kind: 'unsupported', name: '', visible: true, original: { kind: 'sticker' } };
    const m = merged([a, hiddenPiece, clear, unsupported]);
    expect(ids(drawGroups([m], AXIS).groups)).toEqual([`m/${a.id}`]);
    expect(drawGroups([{ ...m, visible: false }], AXIS).groups).toEqual([]);
    expect(drawGroups([{ ...m, opacity: 0 }], AXIS).groups).toEqual([]);
    expect(drawGroups([{ ...m, decal: null }], AXIS).groups).toEqual([]);
  });
});

describe('drawGroups: duplicate ids', () => {
  it('draws a repeated layer or piece id once (the first, bottom-most)', () => {
    const a = newImageLayer('a', decal());
    const twin = { ...newTextLayer('T', decal()), id: a.id };
    const p = piece(newShapeLayer('rect', null), { x: 0, y: 0, w: 0.5, h: 1, angle: 0 });
    const m = merged([p, { ...p, place: { x: 0.2, y: 0, w: 0.5, h: 1, angle: 0 } }]);
    const plan = drawGroups([a, newFolder('f', [twin]), m, { ...m }], AXIS);
    expect(ids(plan.groups)).toEqual([a.id, `m/${p.id}`]);
    expect(plan.groups[0]!.source).toBe(a);
    expect(plan.boxes).toBe(2);
  });
});

describe('drawGroups: repeat and alternate', () => {
  it('draws every repeat copy in one group', () => {
    const d = decal();
    const repeat = { count: 4, gap: 0.5, direction: 'row' as const };
    const layer = { ...newImageLayer('a', d), repeat };
    const [g] = drawGroups([layer], AXIS).groups as [DrawGroup];
    expect(g.boxes).toEqual(repeatDecals(d, repeat));
    expect(g.rasterDecal).toBe(d);
    expect(drawGroups([layer], AXIS).boxes).toBe(4);
  });

  it('splits a solid shape’s alternate copies into an `:alt` group in the alternate colour', () => {
    const d = decal();
    const repeat = { count: 5, gap: 0.2, direction: 'column' as const, alternate: '#123456' };
    const layer: ShapeLayer = { ...newShapeLayer('rect', d), repeat };
    const copies = repeatDecals(d, repeat);
    const [main, alt] = drawGroups([layer], AXIS).groups as [DrawGroup, DrawGroup];
    expect(ids([main, alt])).toEqual([layer.id, `${layer.id}:alt`]);
    expect(main.variant).toBe('main');
    expect(main.source).toBe(layer);
    expect(main.boxes).toEqual([copies[0], copies[2], copies[4]]);
    expect(alt.variant).toBe('alt');
    expect(alt.boxes).toEqual([copies[1], copies[3]]);
    expect(alt.rasterDecal).toEqual(copies[1]);
    expect((alt.source as ShapeLayer).fill).toEqual({ kind: 'solid', color: '#123456' });
    expect(alt.source.id).toBe(layer.id);
  });

  it('ignores the alternate colour on striped shapes and on images', () => {
    const repeat = { count: 3, gap: 0.2, direction: 'row' as const, alternate: '#123456' };
    const striped: ShapeLayer = {
      ...newShapeLayer('rect', decal()),
      fill: { kind: 'stripes', colors: ['#000000', '#ffffff'], angle: 45, stripeWidth: 0.1 },
      repeat,
    };
    const img = { ...newImageLayer('a', decal()), repeat };
    const groups = drawGroups([striped, img], AXIS).groups;
    expect(ids(groups)).toEqual([striped.id, img.id]);
    expect(groups.map((g) => g.boxes.length)).toEqual([3, 3]);
  });
});

describe('drawGroups: mirror', () => {
  it('mirrors a plain layer like mirrorDecal, every box with mirror off', () => {
    const d = decal({ mirror: true });
    const layer = newTextLayer('T', d);
    const [g] = drawGroups([layer], AXIS).groups as [DrawGroup];
    expect(g.boxes).toHaveLength(2);
    expectDecal(g.boxes[0]!, { ...d, mirror: false }, 0);
    expectDecal(g.boxes[1]!, { ...mirrorDecal(d, AXIS)!, mirror: false }, 1e-12);
    expect(g.rasterDecal.mirror).toBe(false);
    expect(drawGroups([layer], AXIS).boxes).toBe(2);
  });

  it('draws no mirror copy for an invalid axis', () => {
    const layer = newTextLayer('T', decal({ mirror: true }));
    const [g] = drawGroups([layer], 7).groups as [DrawGroup];
    expect(g.boxes).toHaveLength(1);
    expect(g.boxes[0]!.mirror).toBe(false);
  });

  it('mirrors a row as one picture and sends each mirrored copy to its original’s group', () => {
    const d = decal({ mirror: true, width: 0.3 });
    const repeat = { count: 3, gap: 0.5, direction: 'row' as const, alternate: '#123456' };
    const layer: ShapeLayer = { ...newShapeLayer('ellipse', d), repeat };
    const copies = repeatDecals(d, repeat);
    const mirrored = mirrorAsOne(copies, envelopeOf(d, repeat), AXIS)!;
    const [main, alt] = drawGroups([layer], AXIS).groups as [DrawGroup, DrawGroup];
    const off = (b: Decal) => ({ ...b, mirror: false });
    expect(main.boxes).toEqual([off(copies[0]!), off(copies[2]!), mirrored[0], mirrored[2]]);
    expect(alt.boxes).toEqual([off(copies[1]!), mirrored[1]]);
  });

  it('keeps a merged "A" "B" in order on the other side', () => {
    const frame = decal({ width: 1, height: 0.3, mirror: true });
    const a = piece(newTextLayer('A', null), { x: -0.3, y: 0, w: 0.3, h: 1, angle: 0 });
    const b = piece(newTextLayer('B', null), { x: 0.3, y: 0, w: 0.3, h: 1, angle: 0 });
    const [ga, gb] = drawGroups([merged([a, b], { decal: frame })], AXIS).groups as [DrawGroup, DrawGroup];
    const env = mirrorDecal(frame, AXIS)!;
    expect(ga.boxes).toHaveLength(2);
    expect(localX(ga.boxes[1]!.center, env)).toBeCloseTo(-0.3 * frame.width, 12);
    expect(localX(gb.boxes[1]!.center, env)).toBeCloseTo(0.3 * frame.width, 12);
  });
});

describe('drawGroups: merged objects', () => {
  it('draws each piece through every repeat copy of the frame, with the product opacity', () => {
    const frame = decal({ width: 1, height: 0.3, mirror: true });
    const repeat = { count: 3, gap: 0.1, direction: 'row' as const };
    const pa: Place = { x: -0.3, y: 0.1, w: 0.3, h: 0.8, angle: 0.2 };
    const pb: Place = { x: 0.3, y: 0, w: 0.3, h: 1, angle: 0 };
    const a = piece({ ...newShapeLayer('star', null), opacity: 0.5, wear: 0.2 }, pa);
    const b = piece({ ...newImageLayer('img', null), flipX: true }, pb);
    const m = merged([a, b], { decal: frame, repeat, opacity: 0.8 });
    const plan = drawGroups([m], AXIS);
    const [ga, gb] = plan.groups as [DrawGroup, DrawGroup];
    const frames = repeatDecals(frame, repeat);
    const boxesA = frames.map((f) => pieceDecal(f, pa));
    const boxesB = frames.map((f) => pieceDecal(f, pb));
    const mirrored = mirrorAsOne([...boxesA, ...boxesB], envelopeOf(frame, repeat), AXIS)!;
    expect(ga).toMatchObject({ id: `m/${a.id}`, variant: 'main', wear: 0.2, flipX: false });
    expect(ga.opacity).toBeCloseTo(0.4, 12);
    expect(ga.boxes).toEqual([...boxesA, ...mirrored.slice(0, 3)]);
    expect(gb.boxes).toEqual([...boxesB, ...mirrored.slice(3)]);
    expect(gb.flipX).toBe(true);
    expect(gb.opacity).toBeCloseTo(0.8, 12);
    expect(ga.rasterDecal).toEqual(boxesA[0]);
    expect(ga.source.decal).toBe(ga.rasterDecal);
    expect('place' in ga.source).toBe(false);
    expect('repeat' in ga.source).toBe(false);
    expect(ga.source.kind).toBe('shape');
    expect(ga.source.id).toBe(a.id);
    expect(plan.boxes).toBe(12);
  });

  it('does not alternate pieces', () => {
    const repeat = { count: 4, gap: 0.1, direction: 'row' as const, alternate: '#123456' };
    const a = piece(newShapeLayer('rect', null), { x: 0, y: 0, w: 1, h: 1, angle: 0 });
    const groups = drawGroups([merged([a], { repeat })], AXIS).groups;
    expect(ids(groups)).toEqual([`m/${a.id}`]);
    expect(groups[0]!.boxes).toHaveLength(4);
  });
});

describe('drawGroups: every box', () => {
  it('has mirror off', () => {
    const repeat = { count: 3, gap: 0.2, direction: 'row' as const, alternate: '#123456' };
    const layers: Layer[] = [
      newImageLayer('a', decal({ mirror: true })),
      { ...newShapeLayer('rect', decal({ mirror: true })), repeat },
      newFolder('f', [{ ...newTextLayer('T', decal({ mirror: true })), repeat }]),
      merged([piece(newShapeLayer('rect', null), { x: 0, y: 0, w: 1, h: 1, angle: 0 })], { decal: decal({ mirror: true }), repeat }),
    ];
    const plan = drawGroups(layers, AXIS);
    const boxes = allBoxes(plan.groups);
    expect(boxes).toHaveLength(2 + 6 + 6 + 6);
    expect(plan.boxes).toBe(boxes.length);
    for (const g of plan.groups) {
      expect(g.rasterDecal.mirror).toBe(false);
      for (const b of g.boxes) expect(b.mirror).toBe(false);
    }
  });
});

describe('drawGroups: budget', () => {
  it('stops at the first layer that would go over and reports truncated', () => {
    const repeat = { count: 50, gap: 0, direction: 'row' as const };
    const layers = Array.from({ length: 9 }, () => ({ ...newImageLayer('a', decal()), repeat }));
    const plan = drawGroups(layers, AXIS, 400);
    expect(plan.groups).toHaveLength(8);
    expect(plan.boxes).toBe(400);
    expect(plan.truncated).toBe(true);
  });

  it('skips everything above the layer that does not fit, even small layers', () => {
    const big = { ...newImageLayer('a', decal()), repeat: { count: 5, gap: 0, direction: 'row' as const } };
    const small = newImageLayer('b', decal());
    const first = newImageLayer('c', decal());
    const plan = drawGroups([first, newFolder('f', [big, small])], AXIS, 4);
    expect(ids(plan.groups)).toEqual([first.id]);
    expect(plan.boxes).toBe(1);
    expect(plan.truncated).toBe(true);
  });

  it('never caches a truncation: a bigger budget draws everything with the same groups', () => {
    const repeat = { count: 3, gap: 0, direction: 'row' as const };
    const layers = [newImageLayer('a', decal()), { ...newImageLayer('b', decal()), repeat }, newTextLayer('C', decal())];
    expect(drawGroups(layers, AXIS, 4).truncated).toBe(true);
    const after = drawGroups(layers, AXIS, 400);
    expect(after.truncated).toBe(false);
    expect(after.boxes).toBe(5);
    const fresh = drawGroups(layers, AXIS, 400);
    expect(after.groups).toHaveLength(3);
    after.groups.forEach((g, i) => expect(g).toBe(fresh.groups[i]));
  });

  it('is not truncated when everything fits exactly', () => {
    const layer = { ...newImageLayer('a', decal({ mirror: true })), repeat: { count: 2, gap: 0, direction: 'row' as const } };
    const plan = drawGroups([layer], AXIS, 4);
    expect(plan.boxes).toBe(4);
    expect(plan.truncated).toBe(false);
  });
});

describe('drawGroups: stable objects', () => {
  it('gives the same groups for the same layer objects, new ones for a changed layer', () => {
    const repeat = { count: 3, gap: 0.2, direction: 'row' as const, alternate: '#123456' };
    const a = { ...newShapeLayer('rect', decal({ mirror: true })), repeat };
    const b = newImageLayer('b', decal());
    const m = merged([piece(newShapeLayer('rect', null), { x: 0, y: 0, w: 1, h: 1, angle: 0 })]);
    const first = drawGroups([a, b, m], AXIS);
    const second = drawGroups([a, b, m], AXIS);
    expect(second.groups).not.toBe(first.groups);
    second.groups.forEach((g, i) => {
      expect(g).toBe(first.groups[i]);
      expect(g.boxes).toBe(first.groups[i]!.boxes);
    });
    const changed = { ...b, opacity: 0.5 };
    const third = drawGroups([a, changed, m], AXIS);
    expect(third.groups[0]).toBe(first.groups[0]);
    expect(third.groups[1]).toBe(first.groups[1]);
    expect(third.groups[2]).not.toBe(first.groups[2]);
    expect(third.groups[2]!.opacity).toBe(0.5);
    expect(third.groups[3]).toBe(first.groups[3]);
  });

  it('keys the memo by mirror axis', () => {
    const a = newImageLayer('a', decal({ mirror: true }));
    const z = drawGroups([a], 2).groups[0]!;
    const x = drawGroups([a], 0).groups[0]!;
    expect(x).not.toBe(z);
    expect(drawGroups([a], 2).groups[0]).toBe(z);
    expect(drawGroups([a], 0).groups[0]).toBe(x);
  });

  it('keeps a renamed folder’s children groups', () => {
    const a = newImageLayer('a', decal());
    const b = newTextLayer('B', decal());
    const folder = newFolder('f', [a, b]);
    const first = drawGroups([folder], AXIS).groups;
    const second = drawGroups([{ ...folder, name: 'renamed' }], AXIS).groups;
    expect(second).toHaveLength(2);
    second.forEach((g, i) => expect(g).toBe(first[i]));
  });
});
