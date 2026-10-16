import { describe, expect, it } from 'vitest';
import type { ModelHeader } from '@/types';
import {
  DEFAULT_WIDTH_RATIO,
  PARALLEL_EPSILON,
  boundingDiagonal,
  decalMatrix,
  defaultDecalSize,
  facing,
  fromDecalSpace,
  frameFromHit,
  inBox,
  mirrorDecal,
  sphereTouchesBox,
  texelsPerUnit,
  toDecalSpace,
} from './decal';
import { MIN_DEPTH, cross, decalRight, dot, length, normalize, sub, type Decal, type Vec3 } from './project';

/** `camera.matrixWorld.elements` for a camera at `eye` looking at `target` with world up +y (three's lookAt). */
function lookAt(eye: Vec3, target: Vec3, worldUp: Vec3 = [0, 1, 0]): number[] {
  const z = normalize(sub(eye, target))!;
  const x = normalize(cross(worldUp, z)) ?? [1, 0, 0];
  const y = cross(z, x);
  return [...x, 0, ...y, 0, ...z, 0, ...eye, 1];
}

const SIZE = { width: 0.4, height: 0.2 };
const close = (a: Vec3, b: Vec3) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));

describe('frameFromHit', () => {
  it('takes the camera screen-up projected on the surface; the frame is orthonormal and right-handed', () => {
    const normal: Vec3 = [1, 0.3, 0];
    const cam = lookAt([3, 1, 0.5], [0, 0, 0]);
    const d = frameFromHit([0.5, 0.1, 0], normal, cam, SIZE)!;
    expect(length(d.normal)).toBeCloseTo(1);
    expect(length(d.up)).toBeCloseTo(1);
    expect(dot(d.normal, d.up)).toBeCloseTo(0);
    const right = decalRight(d);
    expect(dot(cross(right, d.up), d.normal)).toBeCloseTo(1);
    // Up still points upward on screen.
    expect(dot(d.up, [cam[4]!, cam[5]!, cam[6]!])).toBeGreaterThan(0);
    expect(d).toMatchObject({ width: 0.4, height: 0.2, part: 'all', mirror: false });
    expect(d.depth).toBeCloseTo(0.04);
    expect(frameFromHit([0, 0, 0], normal, cam, { width: 0.05, height: 0.05 })?.depth).toBe(MIN_DEPTH);
  });

  it('a camera looking along the normal: screen-up is used as it is', () => {
    const d = frameFromHit([0, 0, 0.5], [0, 0, 1], lookAt([0, 0, 3], [0, 0, 0]), SIZE)!;
    close(d.up, [0, 1, 0]);
    close(decalRight(d), [1, 0, 0]);
  });

  it('falls back to world +y, then +x, when screen-up is parallel to the normal', () => {
    // Screen-up = +y on a top face (normal +y): +y is parallel too, so +x.
    const rolled = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1];
    const top = frameFromHit([0, 0.5, 0], [0, 1, 0], rolled, SIZE)!;
    close(top.up, [1, 0, 0]);
    // Screen-up = +z on a front face (normal +z): world +y.
    const front = frameFromHit([0, 0, 0.5], [0, 0, 1], [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 1], SIZE)!;
    close(front.up, [0, 1, 0]);
    expect(frameFromHit([0, 0, 0], [0, 0, 0], rolled, SIZE)).toBeNull();
  });

  it(`a nearly edge-on screen-up (within PARALLEL_EPSILON = ${PARALLEL_EPSILON}) falls back to the world axis`, () => {
    // Screen-up 3° off the front face's normal (+z): sin 3° ≈ 0.052 < 0.08, so world +y.
    const a = (3 * Math.PI) / 180;
    const near = [1, 0, 0, 0, 0, Math.sin(a), Math.cos(a), 0, 0, 0, 0, 0, 0, 0, 3, 1];
    close(frameFromHit([0, 0, 0.5], [0, 0, 1], near, SIZE)!.up, [0, 1, 0]);
    // 10° off (sin ≈ 0.17): screen-up is kept.
    const b = (10 * Math.PI) / 180;
    const kept = frameFromHit([0, 0, 0.5], [0, 0, 1], [1, 0, 0, 0, 0, Math.sin(b), Math.cos(b), 0, 0, 0, 0, 0, 0, 0, 3, 1], SIZE)!;
    close(kept.up, [0, 1, 0]);
    // …but with the screen-up leaning sideways it follows the screen.
    const side = frameFromHit([0, 0, 0.5], [0, 0, 1], [0, 0, 0, 0, Math.sin(b), 0, Math.cos(b), 0, 0, 0, 0, 0, 0, 0, 3, 1], SIZE)!;
    close(side.up, [1, 0, 0]);
    const nearSide = frameFromHit([0, 0, 0.5], [0, 0, 1], [0, 0, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 0, 0, 0, 3, 1], SIZE)!;
    close(nearSide.up, [0, 1, 0]);
  });
});

describe('decal space', () => {
  const decal = frameFromHit([0.5, 0.1, 0.2], [1, 0, 0], lookAt([3, 0.1, 0.2], [0.5, 0.1, 0.2]), { width: 0.4, height: 0.2, depth: 0.1 })!;

  it('decalMatrix agrees with toDecalSpace, and fromDecalSpace inverts it', () => {
    const m = decalMatrix(decal);
    for (const p of [
      [0.5, 0.1, 0.2],
      [0.55, 0.15, 0.1],
      [0.2, -0.3, 0.9],
    ] as Vec3[]) {
      const viaMatrix: Vec3 = [0, 1, 2].map((r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]!) as Vec3;
      close(viaMatrix, toDecalSpace(p, decal));
      close(fromDecalSpace(toDecalSpace(p, decal), decal), p);
    }
    expect(m[15]).toBe(1);
  });

  it('the picture +u runs along right, +v along up', () => {
    // Seen from +x looking at -x with +y up, right is -z.
    close(fromDecalSpace([0.5, 0, 0], decal), [0.5, 0.1, 0.2 - 0.2]);
    close(fromDecalSpace([0, 0.5, 0], decal), [0.5, 0.2, 0.2]);
  });

  it('inBox and facing', () => {
    expect(inBox([0.5, 0.1, 0.2], decal)).toBe(true);
    expect(inBox([0.54, 0.19, 0.01], decal)).toBe(true);
    expect(inBox([0.56, 0.1, 0.2], decal)).toBe(false);
    expect(inBox([0.5, 0.21, 0.2], decal)).toBe(false);
    expect(facing([2, 0, 0], decal)).toBe(true);
    expect(facing([1, 4.8, 0], decal)).toBe(true);
    expect(facing([1, 5, 0], decal)).toBe(false);
    expect(facing([-1, 0, 0], decal)).toBe(false);
  });

  it('sphereTouchesBox', () => {
    expect(sphereTouchesBox([0.5, 0.1, 0.2], 0.001, decal)).toBe(true);
    expect(sphereTouchesBox([0.5, 0.5, 0.2], 0.29, decal)).toBe(false);
    expect(sphereTouchesBox([0.5, 0.5, 0.2], 0.31, decal)).toBe(true);
  });
});

describe('mirror', () => {
  /** Where the picture's +u texel lands on screen for a viewer outside the decal's side: > 0 is the viewer's right. */
  function screenX(decal: Decal): number {
    const eye = fromDecalSpace([0, 0, 20], decal);
    const cam = lookAt(eye, decal.center);
    const p = fromDecalSpace([0.25, 0, 0], decal);
    return dot(sub(p, eye), [cam[0]!, cam[1]!, cam[2]!]);
  }

  it('the copy reads the right way round on the other side, without flipping the picture', () => {
    const original = frameFromHit([0.1, 0.2, 0.5], [0, 0, 1], lookAt([0.1, 0.5, 3], [0.1, 0.2, 0.5]), SIZE)!;
    const copy = mirrorDecal(original, 2)!;
    close(copy.center, [0.1, 0.2, -0.5]);
    close(copy.normal, [0, 0, -1]);
    expect(screenX(original)).toBeGreaterThan(0);
    expect(screenX(copy)).toBeGreaterThan(0);
    // The frame stays right-handed.
    expect(dot(cross(decalRight(copy), copy.up), copy.normal)).toBeCloseTo(1);
    // A plain reflection of right (a mirror image) would put +u on the viewer's left.
    const eye = fromDecalSpace([0, 0, 20], copy);
    const cam = lookAt(eye, copy.center);
    const reflectedRight: Vec3 = [decalRight(original)[0], decalRight(original)[1], -decalRight(original)[2]];
    expect(dot(reflectedRight, [cam[0]!, cam[1]!, cam[2]!])).toBeLessThan(0);
    // Up still points up on both sides.
    expect(copy.up[1]).toBeCloseTo(original.up[1]);
  });

  it('works on a tilted side and across x', () => {
    const original = frameFromHit([0.5, 0, 0.3], [1, 0.2, 0.4], lookAt([3, 1, 2], [0.5, 0, 0.3]), SIZE)!;
    for (const axis of [0, 2]) {
      const copy = mirrorDecal(original, axis)!;
      expect(screenX(copy)).toBeGreaterThan(0);
      expect(copy.center[axis]).toBeCloseTo(-original.center[axis]!);
    }
  });

  it('an axis other than 0, 1 or 2 gives no copy', () => {
    const original = frameFromHit([0.1, 0.2, 0.5], [0, 0, 1], lookAt([0.1, 0.5, 3], [0.1, 0.2, 0.5]), SIZE)!;
    for (const axis of [-1, 3, 1.5, Number.NaN]) expect(mirrorDecal(original, axis)).toBeNull();
    expect(mirrorDecal(original, 1)?.center[1]).toBeCloseTo(-0.2);
  });
});

describe('default size', () => {
  it('width from the diagonal, height from the aspect, depth 10% (at least 2 cm)', () => {
    expect(boundingDiagonal([0, 0, 0, 3, 4, 0, 1, 1, 12])).toBeCloseTo(13);
    expect(boundingDiagonal([])).toBe(0);
    const size = defaultDecalSize(8, 2);
    expect(size.width).toBeCloseTo(8 * DEFAULT_WIDTH_RATIO);
    expect(size.height).toBeCloseTo(1);
    expect(size.depth).toBeCloseTo(0.2);
    expect(defaultDecalSize(0.4, 1).depth).toBe(MIN_DEPTH);
    expect(defaultDecalSize(8, 0).height).toBeCloseTo(2);
  });
});

describe('texelsPerUnit', () => {
  /**
   * Two quads on slot 0 (512×256): A at z = 0.5 spanning x,y in [-0.5, 0.5] on UV [0, 0.5]² (1 m
   * → 256 px across, 128 px down); B far away at x = 10 on UV [0.5, 1]×[0, 1]. A small triangle on
   * slot 1, part `gun`, over A.
   */
  function model() {
    const positions = [
      ...[-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5],
      ...[10, -0.5, 0, 10, -0.5, 1, 10, 0.5, 1, 10, 0.5, 0],
      ...[0, 0, 0.5, 0.1, 0, 0.5, 0, 0.1, 0.5],
    ];
    const uvs = [...[0, 0.5, 0.5, 0.5, 0.5, 0, 0, 0], ...[0.5, 1, 1, 1, 1, 0, 0.5, 0], ...[0, 0, 1, 0, 0, 1]];
    const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10];
    const header = {
      vehicle: 'v',
      model: 'v',
      mirrorAxis: 2,
      slots: [
        { texture: 'v_body_c', width: 512, height: 256, hq: true, paintableByDefault: true },
        { texture: 'v_gun_c', width: 64, height: 64, hq: true, paintableByDefault: true },
      ],
      parts: [
        { node: '@root', group: 'hull', slot: 0, vertexOffset: 0, vertexCount: 8, indexOffset: 0, indexCount: 12 },
        { node: 'gun', group: 'gun', slot: 1, vertexOffset: 8, vertexCount: 3, indexOffset: 12, indexCount: 3 },
      ],
      vertexCount: 11,
      indexCount: 15,
    } satisfies ModelHeader;
    return { header, positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
  }

  const onA: Decal = { center: [0, 0, 0.5], normal: [0, 0, 1], up: [0, 1, 0], width: 0.2, height: 0.1, depth: 0.05, part: 'all', mirror: false };
  /** The slots baked at their template size. */
  const BODY_OUT = { width: 512, height: 256 };
  const GUN_OUT = { width: 64, height: 64 };

  it('uses the output size, not the template size (High quality bakes larger)', () => {
    // 1024×512 output: twice the texels per unit of the 512×256 template.
    expect(texelsPerUnit(model(), 0, { width: 1024, height: 512 }, onA)).toBeCloseTo(2 * Math.sqrt(32768));
  });

  it('uses the triangles whose bounding sphere touches the box (sqrt of UV px area over world area)', () => {
    // Quad A: world area 1, UV area 0.25 × 512 × 256 px = 32768 px²: sqrt = 181.02.
    expect(texelsPerUnit(model(), 0, BODY_OUT, onA)).toBeCloseTo(Math.sqrt(32768));
  });

  it('a small decal in the middle of a big plate still finds it (the plate is large, its centroid outside the box)', () => {
    const corner: Decal = { ...onA, center: [0.4, 0.4, 0.5], width: 0.01, height: 0.01 };
    expect(texelsPerUnit(model(), 0, BODY_OUT, corner)).toBeCloseTo(Math.sqrt(32768));
  });

  it('limits to the decal part group and the slot, falls back to the hit triangle, null when nothing', () => {
    expect(texelsPerUnit(model(), 1, GUN_OUT, onA)).toBeCloseTo(Math.sqrt((0.5 * 64 * 64) / 0.005));
    expect(texelsPerUnit(model(), 1, GUN_OUT, { ...onA, part: 'hull' })).toBeNull();
    const far: Decal = { ...onA, center: [0, 0, -5] };
    expect(texelsPerUnit(model(), 0, BODY_OUT, far)).toBeNull();
    expect(texelsPerUnit(model(), 0, BODY_OUT, far, 2)).toBeCloseTo(Math.sqrt((0.5 * 512 * 256) / 1));
    expect(texelsPerUnit(model(), 0, BODY_OUT, far, 99)).toBeNull();
    expect(texelsPerUnit(model(), 7, GUN_OUT, onA)).toBeNull();
  });
});
