import { describe, expect, it } from 'vitest';
import { decalRight, MAX_DECAL_SIZE, type Decal } from '@/atelier/project';
import { decalCorners, MAX_DEPTH_UI, MIN_DEPTH_UI, nudgePoint, NUDGE_FRACTION, rotateDecal, scaleDecal, slideTo, wheelDepth } from './decalOps';

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
