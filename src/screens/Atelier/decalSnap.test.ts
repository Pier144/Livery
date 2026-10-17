import { describe, expect, it } from 'vitest';
import type { Decal, Vec3 } from '@/atelier/project';
import { rotateDecal } from './decalOps';
import { LEVEL_SNAP_DEG, SNAP_PX, levelAngle, levelFrame, snapLevel, snapMove, unitsPerPixel } from './decalSnap';

const decal = (over: Partial<Decal> = {}): Decal => ({
  center: [0, 0, 0],
  normal: [1, 0, 0],
  up: [0, 1, 0],
  width: 0.4,
  height: 0.2,
  depth: 0.1,
  part: 'all',
  mirror: false,
  ...over,
});

// 1 cm per pixel: a pull reaches 8 cm.
const ctx = (over: Partial<Parameters<typeof snapMove>[1]> = {}) => ({ mirrorAxis: 2, others: [], unitsPerPx: 0.01, ...over });
const reach = SNAP_PX * 0.01;
const close = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));
const rad = (deg: number) => (deg * Math.PI) / 180;

describe('snapMove', () => {
  it('pulls a decal on the front plate onto the centre line within reach, with a guide along it', () => {
    const near = snapMove(decal({ center: [2, 0.5, reach * 0.6] }), ctx());
    close(near.decal.center, [2, 0.5, 0]);
    expect(near.guides).toHaveLength(1);
    expect(near.guides[0]!.kind).toBe('centre');
    // The guide runs up the plate (in the decal's plane and the mirror plane).
    expect(near.guides[0]!.from[2]).toBeCloseTo(0);
    expect(near.guides[0]!.to[1]).not.toBeCloseTo(near.guides[0]!.from[1]);

    const far = snapMove(decal({ center: [2, 0.5, reach * 1.5] }), ctx());
    close(far.decal.center, [2, 0.5, reach * 1.5]);
    expect(far.guides).toEqual([]);
  });

  it('moves within a sloped plate to reach the centre line', () => {
    // A glacis turned 40° about the vertical: reaching z = 0 within the plane moves x too.
    const n: Vec3 = [Math.cos(rad(40)), 0, Math.sin(rad(40))];
    const out = snapMove(decal({ normal: n, center: [1, 0.3, 0.03] }), ctx()).decal;
    expect(out.center[2]).toBeCloseTo(0, 6);
    // Still on its plane.
    const d = (p: Vec3) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
    expect(d(out.center)).toBeCloseTo(d([1, 0.3, 0.03]), 6);
  });

  it('never pulls a decal on a side facing along the mirror axis onto the centre line', () => {
    const out = snapMove(decal({ normal: [0, 0, 1], center: [0.5, 0.5, 0.02] }), ctx());
    close(out.decal.center, [0.5, 0.5, 0.02]);
    expect(out.guides).toEqual([]);
  });

  it('aligns with the height or the vertical of another decal on the same side, not on a side facing away', () => {
    const peer = decal({ normal: [0, 0, 1], center: [1.5, 0.53, 1] });
    const out = snapMove(decal({ normal: [0, 0, 1], center: [0.5, 0.5, 1] }), ctx({ others: [peer] }));
    close(out.decal.center, [0.5, 0.53, 1]);
    expect(out.guides).toEqual([{ kind: 'align', from: out.decal.center, to: peer.center }]);

    const below = decal({ normal: [0, 0, 1], center: [0.55, -0.4, 1] });
    close(snapMove(decal({ normal: [0, 0, 1], center: [0.5, 0.5, 1] }), ctx({ others: [below] })).decal.center, [0.55, 0.5, 1]);

    const opposite = decal({ normal: [0, 0, -1], center: [1.5, 0.53, -1] });
    close(snapMove(decal({ normal: [0, 0, 1], center: [0.5, 0.5, 1] }), ctx({ others: [opposite] })).decal.center, [0.5, 0.5, 1]);
  });

  it('takes the nearest peer, and the centre line wins over an alignment that would leave it', () => {
    const a = decal({ center: [2, 0.55, 0.5] });
    const b = decal({ center: [2, 0.52, 0.04] });
    const out = snapMove(decal({ center: [2, 0.5, 0.05] }), ctx({ others: [a, b] }));
    // Onto the centre line (z = 0) and b's height; b's horizontal (z) offset is ignored.
    close(out.decal.center, [2, 0.52, 0]);
    expect(out.guides.map((g) => g.kind)).toEqual(['centre', 'align']);
  });

  it('does nothing without a usable reach', () => {
    const d = decal({ center: [2, 0.5, 0.01] });
    expect(snapMove(d, ctx({ unitsPerPx: 0 })).decal).toBe(d);
    expect(snapMove(d, ctx({ mirrorAxis: 7 })).decal).toBe(d);
  });
});

describe('snapLevel', () => {
  it('measures the turn from level, counter-clockwise from the front', () => {
    expect(levelAngle(decal())).toBeCloseTo(0);
    expect(levelAngle(rotateDecal(decal(), 0.05))).toBeCloseTo(0.05);
    expect(levelAngle(rotateDecal(decal(), -0.3))).toBeCloseTo(-0.3);
  });

  it('settles level within a few degrees, either way up or on its side, with a guide', () => {
    const tilted = rotateDecal(decal(), rad(LEVEL_SNAP_DEG - 1));
    const level = snapLevel(tilted);
    close(level.decal.up, [0, 1, 0]);
    expect(level.guides.map((g) => g.kind)).toEqual(['level']);

    const free = rotateDecal(decal(), rad(LEVEL_SNAP_DEG + 4));
    expect(snapLevel(free).decal).toBe(free);
    expect(snapLevel(free).guides).toEqual([]);

    const sideways = snapLevel(rotateDecal(decal(), rad(92)));
    expect(Math.abs(sideways.decal.up[1])).toBeCloseTo(0);
  });

  it('uses the forward axis on a roof, where up is the normal', () => {
    const roof = decal({ normal: [0, 1, 0], up: [Math.cos(rad(2)), 0, Math.sin(rad(2))] });
    expect(levelFrame(roof.normal).vertical).toEqual([1, 0, 0]);
    close(snapLevel(roof).decal.up, [1, 0, 0]);
  });
});

it('unitsPerPixel converts a screen distance at a point', () => {
  const project = (p: Vec3) => ({ x: p[0] * 200, y: p[1] * 200 });
  expect(unitsPerPixel(project, [0, 0, 0], [1, 0, 0], 0.1)).toBeCloseTo(0.005);
  expect(unitsPerPixel(() => ({ x: 0, y: 0 }), [0, 0, 0], [1, 0, 0], 0.1)).toBe(0);
});
