import { describe, expect, it } from 'vitest';
import {
  decalRight,
  HAZARD_ASPECT,
  MAX_DECAL_SIZE,
  newBaseLayer,
  newFolder,
  newHazardStripe,
  newImageLayer,
  newShapeLayer,
  type Decal,
  type Layer,
  type MergedLayer,
  type Piece,
} from '@/atelier/project';
import {
  axisScale,
  decalCorners,
  framedLayerOf,
  MAX_DEPTH_UI,
  MIN_DEPTH_UI,
  nudgePoint,
  NUDGE_FRACTION,
  rotateDecal,
  scaleDecal,
  shapePlaceAspect,
  slideOnto,
  slideTo,
  wheelDepth,
} from './decalOps';

const DECAL: Decal = { center: [0.5, 0, 0], normal: [1, 0, 0], up: [0, 1, 0], width: 0.4, height: 0.2, depth: 0.04, part: 'all', mirror: false };

describe('decal edits', () => {
  it('slides onto a new surface keeping its turn, the up laid onto the new plane', () => {
    const turned = rotateDecal(DECAL, Math.PI / 6);
    const moved = slideTo(turned, [0, 0.5, 0.2], [0, 1, 0]);
    expect(moved.center).toEqual([0, 0.5, 0.2]);
    expect(moved.normal).toEqual([0, 1, 0]);
    // The old up (mostly +y, a little +z) projected onto the y = const plane: +z.
    expect(moved.up[1]).toBeCloseTo(0);
    expect(moved.up[2]).toBeCloseTo(1);
    // A degenerate normal leaves it where it was.
    expect(slideTo(DECAL, [1, 1, 1], [0, 0, 0])).toBe(DECAL);
  });

  it('adopts a surface turned up to 35°, else keeps its orientation and moves along its own plane', () => {
    const tilt = (deg: number): [number, number, number] => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0];
    const gentle = slideOnto(DECAL, [0.55, 0.1, 0.1], tilt(30));
    expect(gentle.center).toEqual([0.55, 0.1, 0.1]);
    expect(gentle.normal[1]).toBeCloseTo(0.5);
    const steep = slideOnto(DECAL, [0.3, 0.1, 0.1], tilt(60));
    expect(steep.normal).toEqual(DECAL.normal);
    expect(steep.up).toEqual(DECAL.up);
    // The hit projected onto the decal's plane (x = 0.5).
    expect(steep.center).toEqual([0.5, 0.1, 0.1]);
    // Around a corner (90°): never tilts.
    expect(slideOnto(DECAL, [0.2, 0, 0.6], [0, 0, 1]).normal).toEqual(DECAL.normal);
    expect(slideOnto(DECAL, [0, 0, 0], [0, 0, 0])).toBe(DECAL);
  });

  it('turns counter-clockwise (seen from the front) for a positive angle', () => {
    const r = rotateDecal(DECAL, Math.PI / 2);
    // Up (+y) turned a quarter around +x: +z.
    expect(r.up[1]).toBeCloseTo(0);
    expect(r.up[2]).toBeCloseTo(1);
    // The frame stays right-handed: right = cross(up, normal).
    expect(decalRight(r)[1]).toBeCloseTo(1);
  });

  it('scales per axis within the size limits, ignoring bad factors', () => {
    expect(scaleDecal(DECAL, 2)).toMatchObject({ width: 0.8, height: 0.4 });
    expect(scaleDecal(DECAL, 2, 1)).toMatchObject({ width: 0.8, height: 0.2 });
    expect(scaleDecal(DECAL, 1e6).width).toBe(MAX_DECAL_SIZE);
    expect(scaleDecal(DECAL, 0)).toBe(DECAL);
    expect(scaleDecal(DECAL, Number.NaN)).toBe(DECAL);
  });

  it('nudges along its own axes and lists its corners in picture order', () => {
    const step = NUDGE_FRACTION * 0.4;
    // right = cross(up, normal) = -z here.
    expect(nudgePoint(DECAL, 1, 0)).toEqual([0.5, 0, -step]);
    expect(nudgePoint(DECAL, 0, 1)[1]).toBeCloseTo(step);
    const [tl, tr, br, bl] = decalCorners(DECAL);
    expect(tl).toEqual([0.5, 0.1, 0.2]);
    expect(tr).toEqual([0.5, 0.1, -0.2]);
    expect(br).toEqual([0.5, -0.1, -0.2]);
    expect(bl).toEqual([0.5, -0.1, 0.2]);
  });

  it('changes the depth with the wheel, within its limits', () => {
    expect(wheelDepth(0.1, -100)).toBeCloseTo(0.11);
    expect(wheelDepth(0.1, 100)).toBeCloseTo(0.1 / 1.1);
    expect(wheelDepth(0.5, -100000)).toBe(MAX_DEPTH_UI);
    expect(wheelDepth(0.05, 100000)).toBe(MIN_DEPTH_UI);
  });
});

describe('edge scaling', () => {
  it('measures the drag along the axis on screen, whatever its length', () => {
    // Twice as far along the axis: twice the size; the drag across it doesn't count.
    expect(axisScale({ x: 10, y: 0 }, { x: 20, y: 7 }, { x: 3, y: 0 })).toBeCloseTo(2);
    // A slanted axis: only the part along it.
    expect(axisScale({ x: 10, y: 10 }, { x: 5, y: 5 }, { x: 1, y: 1 })).toBeCloseTo(0.5);
    // Past the centre counts as the distance from it (the other side mirrors).
    expect(axisScale({ x: 0, y: 10 }, { x: 0, y: -30 }, { x: 0, y: -4 })).toBeCloseTo(3);
  });

  it('counts a start under 1 px as 1 px and leaves a degenerate axis alone', () => {
    expect(axisScale({ x: 0.2, y: 0 }, { x: 4, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(4);
    expect(axisScale({ x: 10, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 0 })).toBe(1);
  });
});

describe('framed layers', () => {
  const piece = (id: string): Piece => {
    const { decal: _d, repeat: _r, ...rest } = newShapeLayer('rect', DECAL);
    return { ...rest, id, place: { x: 0, y: 0, w: 1, h: 1, angle: 0 } };
  };
  const shape = { ...newShapeLayer('star', DECAL), id: 's' };
  const child = { ...newImageLayer('asset', DECAL), id: 'c' };
  const folder = { ...newFolder('Folder 1', [child]), id: 'f' };
  const merged: MergedLayer = { id: 'm', kind: 'merged', name: '', visible: true, decal: DECAL, opacity: 1, children: [piece('p')] };
  const layers: Layer[] = [newBaseLayer(), shape, folder, merged];

  it('finds top-level and folder layers with a frame; never pieces, folders, the Base or unknown ids', () => {
    expect(framedLayerOf(layers, 's')).toBe(shape);
    expect(framedLayerOf(layers, 'c')).toBe(child);
    expect(framedLayerOf(layers, 'm')).toBe(merged);
    expect(framedLayerOf(layers, 'p')).toBeNull();
    expect(framedLayerOf(layers, 'f')).toBeNull();
    expect(framedLayerOf(layers, layers[0]!.id)).toBeNull();
    expect(framedLayerOf(layers, 'nope')).toBeNull();
    expect(framedLayerOf(layers, null)).toBeNull();
  });

  it('places a shape again square, a striped band at the hazard aspect, a merged object square', () => {
    expect(shapePlaceAspect(shape)).toBe(1);
    expect(shapePlaceAspect(newHazardStripe('Hazard stripe'))).toBe(HAZARD_ASPECT);
    expect(shapePlaceAspect(merged)).toBe(1);
  });
});
