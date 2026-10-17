import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelHeader } from '@/types';
import type { VehicleModelData } from '../modelBuffer';
import {
  newBaseLayer,
  newImageLayer,
  newMaskLayer,
  newTextLayer,
  type BaseLayer,
  type Decal,
  type Layer,
  type MaskLayer,
  type Stroke,
  type Vec3,
} from '../project';
import { texelsPerUnit } from '../decal';
import type { DecalImage } from './decalTextures';
import { BASE_FRAGMENT } from './camo';
import {
  applyStamp,
  Baker,
  compositeTexel,
  decalContribution,
  decalSample,
  densityTable,
  EXPORT_PICTURE_NOT_READY,
  slotDensity,
  decalCopies,
  decalSampleUv,
  decalSphere,
  quantiseRasterHeight,
  textKey,
  baseUniforms,
  batchRanges,
  buildUnwrapped,
  exportSize,
  fitSize,
  hexToSrgb,
  isBodySlot,
  maskAt,
  packBatch,
  planMaskUpdate,
  PREVIEW_MAX,
  stampWeight,
  strokeParams,
  UPGRADE_DELAY_MS,
  visibleStrokes,
  type MaskTexel,
  type StampRecord,
  type TemplateImage,
} from './baker';
import {
  BAKE_MAX_POINTS,
  brushWeight,
  CAMO_CELL,
  CAMO_THRESHOLDS,
  camoIndex,
  camoNoise,
  latticeValue,
  MASK_FRAGMENT,
  COUNT_FRAGMENT,
  DECAL_FRAGMENT,
  FINAL_FRAGMENT,
  FOOTPRINT_FRAGMENT,
  valueNoise,
} from './shaders';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stroke(over: Partial<Stroke> = {}): Stroke {
  return { erase: false, radius: 0.5, hardness: 0.5, part: 'all', dir: [0, 0, -1], points: [[0, 0, 0]], ...over };
}

/**
 * Two slots: a body (hull, two triangles: one in range, one at u 1.2..1.4) and a turret (one
 * triangle crossing u = 1). Every normal faces +z.
 */
function model(): VehicleModelData {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0, // hull A
    2, 0, 0, 3, 0, 0, 2, 1, 0, // hull B
    0, 0, 1, 1, 0, 1, 0, 1, 1, // turret
  ]);
  const normals = new Float32Array(27);
  for (let i = 0; i < 9; i++) normals[i * 3 + 2] = 1;
  const uvs = new Float32Array([
    0.1, 0.1, 0.4, 0.1, 0.1, 0.4, // A
    1.2, 0.5, 1.4, 0.5, 1.2, 0.7, // B: shifted by −1 in u
    0.9, -0.5, 1.1, -0.5, 0.9, -0.3, // turret: crosses u = 1, v shifted by +1
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const header: ModelHeader = {
    vehicle: 'test_tank',
    model: 'test_tank',
    mirrorAxis: 2,
    slots: [
      { texture: 'test_tank_body_c', width: 64, height: 64, hq: true, paintableByDefault: true },
      { texture: 'test_tank_turret_c', width: 32, height: 32, hq: true, paintableByDefault: true },
    ],
    parts: [
      { node: 'body', group: 'hull', slot: 0, vertexOffset: 0, vertexCount: 6, indexOffset: 0, indexCount: 6 },
      { node: 'turret', group: 'turret', slot: 1, vertexOffset: 6, vertexCount: 3, indexOffset: 6, indexCount: 3 },
    ],
    vertexCount: 9,
    indexCount: 9,
  };
  return { header, positions, normals, uvs, indices };
}

function template(w: number, h: number, v = 128): TemplateImage {
  return { rgba: new Uint8Array(w * h * 4).fill(v), w, h };
}

describe('slot sizes', () => {
  it('knows the body slot by its name', () => {
    expect(isBodySlot('us_m4a3e2_sherman_jumbo_body_c')).toBe(true);
    expect(isBodySlot('us_m4a3e2_sherman_jumbo_turret_c')).toBe(false);
    expect(isBodySlot('body_c_extra')).toBe(false);
  });

  it('fits a size under a maximum keeping the aspect', () => {
    expect(fitSize({ w: 2048, h: 1024 }, PREVIEW_MAX)).toEqual({ w: 1024, h: 512 });
    expect(fitSize({ w: 512, h: 512 }, PREVIEW_MAX)).toEqual({ w: 512, h: 512 });
  });

  it('raises only a body slot below 4096 with High quality', () => {
    expect(exportSize({ w: 2048, h: 2048 }, 'x_body_c', true, 16384)).toEqual({ w: 4096, h: 4096, downscaled: false });
    expect(exportSize({ w: 2048, h: 1024 }, 'x_body_c', true, 16384)).toEqual({ w: 4096, h: 2048, downscaled: false });
    expect(exportSize({ w: 2048, h: 2048 }, 'x_body_c', false, 16384)).toEqual({ w: 2048, h: 2048, downscaled: false });
    expect(exportSize({ w: 2048, h: 2048 }, 'x_turret_c', true, 16384)).toEqual({ w: 2048, h: 2048, downscaled: false });
    expect(exportSize({ w: 4096, h: 4096 }, 'x_body_c', true, 16384)).toEqual({ w: 4096, h: 4096, downscaled: false });
  });

  it('falls back to 2048 above the GPU limit', () => {
    expect(exportSize({ w: 2048, h: 2048 }, 'x_body_c', true, 2048)).toEqual({ w: 2048, h: 2048, downscaled: true });
    expect(exportSize({ w: 8192, h: 4096 }, 'x_turret_c', false, 4096)).toEqual({ w: 2048, h: 1024, downscaled: true });
  });
});

describe('buildUnwrapped', () => {
  it('keeps a slot\'s triangles, shifts out-of-range UVs and copies triangles crossing an edge', () => {
    const body = buildUnwrapped(model(), 0);
    expect(body.vertexCount).toBe(6);
    expect([...body.uvs.subarray(0, 6)].map((v) => +v.toFixed(5))).toEqual([0.1, 0.1, 0.4, 0.1, 0.1, 0.4]);
    expect([...body.uvs.subarray(6, 12)].map((v) => +v.toFixed(5))).toEqual([0.2, 0.5, 0.4, 0.5, 0.2, 0.7]);
    expect([...body.groups]).toEqual([0, 0, 0, 0, 0, 0]);
    expect([...body.positions.subarray(9, 12)]).toEqual([2, 0, 0]);

    const turret = buildUnwrapped(model(), 1);
    // Crosses u = 1: drawn as is (0.9..1.1) and one tile back (−0.1..0.1).
    expect(turret.vertexCount).toBe(6);
    expect([...turret.uvs].map((v) => +v.toFixed(5))).toEqual([0.9, 0.5, 1.1, 0.5, 0.9, 0.7, -0.1, 0.5, 0.1, 0.5, -0.1, 0.7]);
    expect([...turret.groups]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('stores each triangle\'s bounding sphere on its three vertices', () => {
    const body = buildUnwrapped(model(), 0);
    const s = [...body.spheres.subarray(0, 4)];
    expect(s[0]).toBeCloseTo(1 / 3);
    expect(s[1]).toBeCloseTo(1 / 3);
    expect(s[2]).toBeCloseTo(0);
    expect(s[3]).toBeCloseTo(Math.hypot(2 / 3, 1 / 3));
    expect([...body.spheres.subarray(4, 8)]).toEqual([...body.spheres.subarray(0, 4)]);
  });

  it('gives each vertex its corner as barycentric coordinates and the sharp-edge heights of its triangle', () => {
    // Triangle 0 (hull A): one sharp edge; triangle 1 (hull B): none; triangle 2 (turret): two, copied with the wrap copy.
    const heights = new Float32Array([0.5, -1, -1, -1, -1, -1, 0.25, 0.75, -1]);
    const body = buildUnwrapped(model(), 0, heights);
    expect([...body.bary.subarray(0, 9)]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect([...body.edgeHeights.subarray(0, 9)]).toEqual([0.5, -1, -1, 0.5, -1, -1, 0.5, -1, -1]);
    expect([...body.edgeHeights.subarray(9, 18)]).toEqual(Array(9).fill(-1));
    const turret = buildUnwrapped(model(), 1, heights);
    expect([...turret.edgeHeights]).toEqual(Array(6).fill([0.25, 0.75, -1]).flat());
    // Without heights no edge is sharp.
    expect([...buildUnwrapped(model(), 0).edgeHeights].every((v) => v === -1)).toBe(true);
  });

  it('skips triangles with non-finite UVs', () => {
    const m = model();
    m.uvs[0] = Number.NaN;
    expect(buildUnwrapped(m, 0).vertexCount).toBe(3);
  });
});

describe('stroke batching and uniforms', () => {
  it('splits stroke points into batches of 64', () => {
    expect(BAKE_MAX_POINTS).toBe(64);
    expect(batchRanges(0, 150)).toEqual([
      [0, 64],
      [64, 64],
      [128, 22],
    ]);
    expect(batchRanges(70, 134)).toEqual([[70, 64]]);
    expect(batchRanges(5, 5)).toEqual([]);
  });

  it('packs points and a sphere enclosing every brush ball', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [9, 9, 9],
    ];
    const out = new Float32Array(BAKE_MAX_POINTS * 4);
    const sphere = new Float32Array(4);
    packBatch(points, 0, 2, 0.5, out, sphere);
    expect([...out.subarray(0, 8)]).toEqual([0, 0, 0, 0.5, 2, 0, 0, 0.5]);
    expect([...sphere]).toEqual([1, 0, 0, 1.5]);
  });

  it('packs the stroke parameters', () => {
    const out = new Float32Array(4);
    strokeParams(stroke({ hardness: 0.25, erase: true, part: 'turret' }), 12, out);
    expect([...out]).toEqual([0.25, 1, 1, 12]);
    strokeParams(stroke({ part: 'all' }), 3, out);
    expect([...out]).toEqual([0.5, 0, -1, 3]);
    strokeParams(stroke({ part: 'wing' }), 3, out);
    expect(out[2]).toBe(-1);
  });
});

describe('base uniforms', () => {
  const camo = (over: Partial<BaseLayer>): BaseLayer => ({ ...newBaseLayer(), mode: 'camo', colors: ['#ff8000', '#000000', '#ffffff'], ...over });

  it('uses colours as sRGB numbers', () => {
    expect(hexToSrgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    const u = baseUniforms({ ...newBaseLayer(), colors: ['#336699'] });
    expect(u.mode).toBe(0);
    expect(u.count).toBe(1);
    expect([...u.colors.subarray(0, 3)].map((v) => Math.round(v * 255))).toEqual([0x33, 0x66, 0x99]);
    expect(u.alpha).toBe(1);
  });

  it('packs a camo base', () => {
    const u = baseUniforms(camo({ scale: 2, seed: 42 }));
    expect(u.mode).toBe(1);
    expect(u.count).toBe(3);
    expect(u.thresholds).toEqual(CAMO_THRESHOLDS[3]);
    expect(u.frequency).toBeCloseTo(1 / (CAMO_CELL * 2));
    expect(u.seed).toBe(42);
    // The unused fourth colour repeats the last.
    expect([...u.colors.subarray(9, 12)]).toEqual([1, 1, 1]);
  });

  it('keeps big seeds as int32 and hides a hidden base', () => {
    expect(baseUniforms(camo({ seed: 0xffffffff })).seed).toBe(-1);
    expect(baseUniforms(camo({ visible: false })).alpha).toBe(0);
    expect(baseUniforms(undefined).alpha).toBe(0);
  });
});

describe('camo noise (TypeScript mirror of the GLSL)', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = camoNoise(1.3, -2.7, 0.4, 7);
    expect(camoNoise(1.3, -2.7, 0.4, 7)).toBe(a);
    let differs = 0;
    for (let i = 0; i < 20; i++) if (camoNoise(i * 0.37, i * 0.11, -i * 0.53, 7) !== camoNoise(i * 0.37, i * 0.11, -i * 0.53, 8)) differs++;
    expect(differs).toBeGreaterThan(15);
  });

  it('hits the lattice values at integer points and stays in [0, 1)', () => {
    expect(valueNoise(3, -4, 5, 9)).toBe(latticeValue(3, -4, 5, 9));
    const next = rng(1);
    for (let i = 0; i < 2000; i++) {
      const n = camoNoise(next() * 50 - 25, next() * 50 - 25, next() * 50 - 25, 3);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  it('is continuous (no seams inside a model)', () => {
    const e = 1e-4;
    for (const [x, y, z] of [
      [0.999, 0.5, 0.5],
      [2.5, -0.0001, 1.2],
    ] as Vec3[]) {
      expect(Math.abs(camoNoise(x, y, z, 5) - camoNoise(x + e, y, z, 5))).toBeLessThan(0.01);
    }
  });

  it('splits into colours of about the same area', () => {
    for (const count of [2, 3, 4]) {
      const thresholds = CAMO_THRESHOLDS[count]!;
      const shares = new Array<number>(count).fill(0);
      const next = rng(count);
      const n = 40000;
      for (let i = 0; i < n; i++) {
        const v = camoNoise(next() * 300, next() * 300, next() * 300, 1000 + i);
        shares[camoIndex(v, thresholds)]! += 1 / n;
      }
      for (const s of shares) expect(Math.abs(s - 1 / count)).toBeLessThan(0.03);
    }
  });

  it('picks colours by counting reached thresholds', () => {
    expect(camoIndex(0.1, CAMO_THRESHOLDS[4]!)).toBe(0);
    expect(camoIndex(0.5, CAMO_THRESHOLDS[4]!)).toBe(2);
    expect(camoIndex(0.99, CAMO_THRESHOLDS[4]!)).toBe(3);
    expect(camoIndex(0.99, CAMO_THRESHOLDS[2]!)).toBe(1);
  });
});

describe('mask maths (reference of the stamping shader)', () => {
  const texel = (pos: Vec3, over: Partial<MaskTexel> = {}): MaskTexel => ({ pos, normal: [0, 0, 1], group: 0, ...over });

  it('falls off from the centre to the radius', () => {
    expect(brushWeight(0, 1, 0.5)).toBe(1);
    expect(brushWeight(0.5, 1, 0.5)).toBe(1);
    expect(brushWeight(1, 1, 0.5)).toBe(0);
    expect(brushWeight(0.75, 1, 0.5)).toBeCloseTo(0.5);
    expect(brushWeight(0.9995, 1, 1)).toBeGreaterThan(0);
    expect(brushWeight(1.2, 1, 1)).toBe(0);
  });

  it('skips texels of another part or not facing the stroke', () => {
    const s = stroke({ part: 'turret' });
    expect(stampWeight(s, 0, 1, texel([0, 0, 0]))).toBe(0);
    expect(stampWeight(s, 0, 1, texel([0, 0, 0], { group: 1 }))).toBe(1);
    expect(stampWeight(stroke(), 0, 1, texel([0, 0, 0], { normal: [0, 0, -1] }))).toBe(0);
    expect(stampWeight(stroke(), 0, 1, texel([0, 0, 0], { normal: [1, 0, 0.1] }))).toBe(0);
    expect(stampWeight(stroke({ dir: [0, 0, -5] }), 0, 1, texel([0, 0, 0], { normal: [0, 0, 3] }))).toBe(1);
    // A zero-length normal is never stamped (the shader checks the length before the facing test).
    expect(stampWeight(stroke(), 0, 1, texel([0, 0, 0], { normal: [0, 0, 0] }))).toBe(0);
  });

  it('paints with max and erases with min(1 − w), in order', () => {
    const t = texel([0, 0, 0]);
    const paint = stroke();
    const erase = stroke({ erase: true, points: [[0.3, 0, 0]] });
    const w = brushWeight(0.3, 0.5, 0.5);
    expect(maskAt([paint], t)).toBe(1);
    expect(maskAt([paint, erase], t)).toBeCloseTo(1 - w);
    expect(maskAt([erase, paint], t)).toBe(1);
  });

  it('gives the same mask stamped incrementally in any batch split as replayed whole', () => {
    const next = rng(11);
    const point = (): Vec3 => [next() * 4 - 2, next() * 4 - 2, next() * 0.2];
    const strokes: Stroke[] = [];
    for (let k = 0; k < 8; k++) {
      const points = Array.from({ length: 1 + Math.floor(next() * 150) }, point);
      strokes.push(stroke({ erase: next() < 0.4, radius: 0.2 + next() * 0.5, hardness: next(), points }));
    }
    const texels = Array.from({ length: 300 }, () => texel([next() * 4 - 2, next() * 4 - 2, next() * 0.2]));
    for (const t of texels) {
      let m = 0;
      for (const s of strokes) {
        // Pointer moves deliver a few points at a time; each delivery is stamped in batches of 64.
        let from = 0;
        while (from < s.points.length) {
          const to = Math.min(s.points.length, from + 1 + Math.floor(next() * 90));
          for (const [start, count] of batchRanges(from, to)) m = applyStamp(m, s, start, count, t);
          from = to;
        }
      }
      expect(m).toBe(maskAt(strokes, t));
    }
  });
});

describe('planMaskUpdate', () => {
  const a = stroke({ points: [[0, 0, 0], [1, 0, 0]] });
  const b = stroke({ erase: true, points: [[2, 0, 0]] });
  const records = (...pairs: [Stroke, number][]): StampRecord[] => pairs.map(([s, n]) => ({ stroke: s, stamped: n }));

  it('appends new points of the last stroke and new strokes', () => {
    const grown = { ...a, points: [...a.points, [3, 0, 0] as Vec3] };
    expect(planMaskUpdate(records([a, 2]), [grown, b])).toEqual({
      replay: false,
      ops: [
        { stroke: 0, from: 2 },
        { stroke: 1, from: 0 },
      ],
    });
    expect(planMaskUpdate([], [a])).toEqual({ replay: false, ops: [{ stroke: 0, from: 0 }] });
  });

  it('does nothing for the same content in new objects', () => {
    expect(planMaskUpdate(records([a, 2], [b, 1]), [{ ...a, points: [...a.points] }, { ...b }])).toEqual({ replay: false, ops: [] });
  });

  it('replays after an undo, a clear or a change to an earlier stroke', () => {
    expect(planMaskUpdate(records([a, 2], [b, 1]), [a])).toEqual({ replay: true });
    expect(planMaskUpdate(records([a, 2]), [])).toEqual({ replay: true });
    expect(planMaskUpdate(records([a, 2], [b, 1]), [{ ...a, radius: 2 }, b])).toEqual({ replay: true });
    expect(planMaskUpdate(records([a, 2], [b, 1]), [{ ...a, points: [[0, 0, 0], [5, 0, 0]] }, b])).toEqual({ replay: true });
    // An earlier stroke that grew would be stamped after the later ones: replay.
    expect(planMaskUpdate(records([a, 1], [b, 1]), [a, b])).toEqual({ replay: true });
  });

  it('matches a replay when applied to the reference mask', () => {
    const texelAt: MaskTexel = { pos: [0.5, 0, 0], normal: [0, 0, 1], group: 0 };
    const grown = { ...a, points: [...a.points, [0.5, 0.1, 0] as Vec3] };
    const target = [grown, stroke({ erase: true, points: [[0.6, 0, 0]] })];
    let m = maskAt([a], texelAt);
    const plan = planMaskUpdate(records([a, 2]), target);
    expect(plan.replay).toBe(false);
    if (!plan.replay) for (const op of plan.ops) m = applyStamp(m, target[op.stroke]!, op.from, target[op.stroke]!.points.length - op.from, texelAt);
    expect(m).toBe(maskAt(target, texelAt));
  });

  it('ignores a hidden mask', () => {
    const mask: MaskLayer = { ...newMaskLayer(), strokes: [a] };
    expect(visibleStrokes([newBaseLayer(), mask])).toEqual([a]);
    expect(visibleStrokes([newBaseLayer(), { ...mask, visible: false }])).toEqual([]);
    expect(visibleStrokes([newBaseLayer()])).toEqual([]);
  });
});

// ---------------------------------------------------------------- the Baker, WebGL stubbed

const KINDS = new Map<string, Draw['kind']>([
  [BASE_FRAGMENT, 'base'],
  [DECAL_FRAGMENT, 'decal'],
  [FINAL_FRAGMENT, 'paint'],
  [MASK_FRAGMENT, 'mask'],
  [COUNT_FRAGMENT, 'count'],
  [FOOTPRINT_FRAGMENT, 'footprint'],
]);

interface Draw {
  /** `paint` is the final pass (into the slot's target). */
  kind: 'base' | 'decal' | 'paint' | 'mask' | 'coverage' | 'count' | 'footprint';
  target: THREE.WebGLRenderTarget | null;
  equation: number;
  count: number;
  /** Paint uniforms at draw time. */
  alpha: number;
  premultiply: number;
  detail: THREE.DataTexture | null;
  /** Decal pass: the picture drawn, opacity, flip, blend factors (src, dst, src alpha, dst alpha). */
  decalTex: THREE.Texture | null;
  opacity: number;
  flipX: number;
  blend: [number, number, number | null, number | null];
  blending: number;
  sphere: [number, number, number, number] | null;
}

/** A WebGLRenderer stand-in that records draws and clears; read-back fills from `fill`. */
function fakeRenderer(maxTextureSize = 16384) {
  const draws: Draw[] = [];
  const clears: (THREE.WebGLRenderTarget | null)[] = [];
  let current: THREE.WebGLRenderTarget | null = null;
  let lastKind: Draw['kind'] | null = null;
  const canvas = document.createElement('canvas');
  const context = { lost: false };
  /** What the footprint read-back answers: some shared texel or none. */
  const footprint = { shared: false };
  const renderer = {
    capabilities: { maxTextureSize },
    domElement: canvas,
    getContext: () => ({ isContextLost: () => context.lost }),
    autoClear: true,
    getRenderTarget: () => current,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      current = t;
    },
    getClearColor: (c: THREE.Color) => c.set(0x123456),
    getClearAlpha: () => 1,
    setClearColor: vi.fn(),
    clear: () => clears.push(current),
    render: (scene: THREE.Scene) => {
      const mesh = scene.children[0] as THREE.Mesh;
      const material = mesh.material as THREE.ShaderMaterial;
      const kind = KINDS.get(material.fragmentShader) ?? 'coverage';
      lastKind = kind;
      const params = material.uniforms.uParams?.value as THREE.Vector4 | undefined;
      draws.push({
        kind,
        target: current,
        equation: material.blendEquation,
        count: kind === 'mask' && params ? params.w : 0,
        alpha: (material.uniforms.uBaseAlpha?.value as number | undefined) ?? -1,
        premultiply: (material.uniforms.uPremultiply?.value as number | undefined) ?? -1,
        detail: (material.uniforms.uDetail?.value as THREE.DataTexture | null | undefined) ?? null,
        decalTex: (material.uniforms.uDecalTex?.value as THREE.Texture | null | undefined) ?? null,
        opacity: (material.uniforms.uOpacity?.value as number | undefined) ?? -1,
        flipX: (material.uniforms.uFlipX?.value as number | undefined) ?? -1,
        blend: [material.blendSrc, material.blendDst, material.blendSrcAlpha, material.blendDstAlpha],
        blending: material.blending,
        sphere: material.uniforms.uSphere ? ((material.uniforms.uSphere.value as THREE.Vector4).toArray() as [number, number, number, number]) : null,
      });
    },
    // Triangles cover the left half of every row: the paint is (10, 20, 30, 255) there, 0 elsewhere.
    readRenderTargetPixels: (_t: THREE.WebGLRenderTarget, _x: number, _y: number, w: number, rows: number, buf: Uint8Array) => {
      if (lastKind === 'footprint') {
        buf.fill(0);
        if (footprint.shared) buf[(5 * w + 7) * 4] = 255;
        return;
      }
      for (let r = 0; r < rows; r++)
        for (let x = 0; x < w; x++) {
          const covered = x < w / 2;
          buf.set(lastKind === 'paint' ? (covered ? [10, 20, 30, 255] : [0, 0, 0, 0]) : covered ? [255, 255, 255, 255] : [0, 0, 0, 0], (r * w + x) * 4);
        }
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, draws, clears, canvas, context, footprint };
}

function layersWith(strokes: Stroke[], base: Partial<BaseLayer> = {}): Layer[] {
  return [{ ...newBaseLayer(), ...base }, { ...newMaskLayer(), id: 'mask', strokes }];
}

const BODY = 'test_tank_body_c';
const TURRET = 'test_tank_turret_c';

describe('Baker (WebGL stubbed)', () => {
  afterEach(() => vi.useRealTimers());

  function setup(maxTextureSize?: number, templates = new Map([[BODY, template(64, 64)], [TURRET, template(32, 32)]])) {
    const fake = fakeRenderer(maxTextureSize);
    const onUpdate = vi.fn();
    const baker = new Baker(fake.renderer, model(), templates, { onUpdate });
    return { ...fake, baker, onUpdate };
  }

  it('bakes enabled slots and shows the template on the others', () => {
    const { baker, draws, onUpdate } = setup();
    baker.setLayers(layersWith([]), [BODY]);
    expect(draws.filter((d) => d.kind === 'paint')).toHaveLength(1);
    expect(baker.previewTexture(BODY)).not.toBeNull();
    expect(baker.previewTexture(TURRET)).toBeNull();
    expect(previewMix(baker, BODY)).toBe(1);
    expect(previewMix(baker, TURRET)).toBe(0);
    baker.setShowTemplate(true);
    expect(previewMix(baker, BODY)).toBe(0);
    expect(onUpdate).toHaveBeenCalled();
    baker.dispose();
  });

  it('stamps while painting without replaying, and replays after an undo', () => {
    const { baker, draws, clears } = setup();
    const first = stroke({ points: [[0, 0, 0]] });
    baker.setLayers(layersWith([first]), [BODY, TURRET]);
    const maskClears = () => clears.filter((t) => t && t.texture.format === THREE.RedFormat).length;
    expect(maskClears()).toBe(2); // the first sync of each slot replays

    // A second stroke painted point by point: setLayers before or after stampStroke.
    let live = stroke({ erase: true, points: [] });
    let layers = layersWith([first, live]);
    baker.setLayers(layers, [BODY, TURRET]);
    for (let i = 0; i < 70; i++) {
      live = { ...live, points: [...live.points, [i * 0.01, 0, 0]] };
      layers = layersWith([first, live]);
      if (i % 2 === 0) {
        baker.stampStroke('all', live, i);
        baker.setLayers(layers, [BODY, TURRET]);
      } else {
        baker.setLayers(layers, [BODY, TURRET]);
        baker.stampStroke('all', live, i);
      }
    }
    expect(maskClears()).toBe(2);
    const erased = draws.filter((d) => d.kind === 'mask' && d.equation === THREE.MinEquation);
    // Every point stamped exactly once per slot.
    expect(erased.reduce((sum, d) => sum + d.count, 0)).toBe(70 * 2);

    // Undo the second stroke: replay (clear + the first stroke), per slot.
    const before = draws.length;
    baker.setLayers(layersWith([first]), [BODY, TURRET]);
    expect(maskClears()).toBe(4);
    const replayed = draws.slice(before).filter((d) => d.kind === 'mask');
    expect(replayed.every((d) => d.equation === THREE.MaxEquation)).toBe(true);
    baker.dispose();
  });

  it('stamps long strokes in batches of 64 points', () => {
    const { baker, draws } = setup();
    const points: Vec3[] = Array.from({ length: 150 }, (_, i) => [i * 0.01, 0, 0]);
    baker.setLayers(layersWith([stroke({ points })]), [BODY]);
    expect(draws.filter((d) => d.kind === 'mask').map((d) => d.count)).toEqual([64, 64, 22]);
    baker.dispose();
  });

  it('re-renders the paint when the base changes, not for unrelated edits', () => {
    const { baker, draws } = setup();
    const base = newBaseLayer();
    const mask = { ...newMaskLayer(), strokes: [] };
    baker.setLayers([base, mask], [BODY]);
    const paints = () => draws.filter((d) => d.kind === 'paint').length;
    expect(paints()).toBe(1);
    baker.setLayers([base, { ...mask, name: 'renamed' }], [BODY]);
    expect(paints()).toBe(1);
    baker.setLayers([{ ...base, colors: ['#ff0000'] }, mask], [BODY]);
    expect(paints()).toBe(2);
    baker.dispose();
  });

  it('upgrades the focused slot to full size after the last change', () => {
    vi.useFakeTimers();
    const { baker, draws } = setup(undefined, new Map([[BODY, template(1100, 8)], [TURRET, template(32, 32)]]));
    const base = newBaseLayer();
    baker.setLayers([base], [BODY]);
    const paintSizes = () => draws.filter((d) => d.kind === 'paint').map((d) => d.target && [d.target.width, d.target.height]);
    expect(paintSizes()).toEqual([[1100, 8]]); // first bake: full size directly
    baker.setLayers([{ ...base, seed: 2 }], [BODY]);
    expect(paintSizes().at(-1)).toEqual([1024, 7]);
    expect(baker.previewTexture(BODY)?.image).toMatchObject({ width: 1024 });
    vi.advanceTimersByTime(UPGRADE_DELAY_MS);
    expect(paintSizes().at(-1)).toEqual([1100, 8]);
    expect(baker.previewTexture(BODY)?.image).toMatchObject({ width: 1100 });
    baker.dispose();
  });

  it('exports top-to-bottom RGBA dilated past the covered texels', () => {
    const { baker } = setup();
    baker.setLayers(layersWith([]), [BODY]);
    const out = baker.bakeForExport(BODY, false);
    expect(out).toMatchObject({ w: 64, h: 64, downscaled: false });
    expect(out.rgba).toHaveLength(64 * 64 * 4);
    // Covered: x < 32 keeps the paint; dilation fills x = 32..35 with it; beyond stays empty.
    const at = (x: number, y: number) => [...out.rgba.subarray((y * 64 + x) * 4, (y * 64 + x + 1) * 4)];
    expect(at(0, 0)).toEqual([10, 20, 30, 255]);
    expect(at(35, 5)).toEqual([10, 20, 30, 255]);
    expect(at(36, 63)).toEqual([0, 0, 0, 0]);
    baker.dispose();
  });

  it('exports a High quality body at 4096, or 2048 downscaled above the GPU limit', () => {
    const { baker } = setup(1024);
    baker.setLayers(layersWith([]), [BODY]);
    expect(baker.bakeForExport(BODY, true)).toMatchObject({ w: 1024, h: 1024, downscaled: true });
    expect(baker.bakeForExport(TURRET, true)).toMatchObject({ w: 32, h: 32, downscaled: false });
    baker.dispose();
  });

  it('renders nothing opaque before the first setLayers', () => {
    const { baker, draws } = setup();
    baker.bakeForExport(BODY, false);
    expect(draws.find((d) => d.kind === 'base')?.alpha).toBe(0);
    baker.dispose();
  });

  it('premultiplies the preview targets and keeps straight alpha for export', () => {
    const { baker, draws } = setup();
    baker.setLayers(layersWith([]), [BODY]);
    expect(draws.filter((d) => d.kind === 'paint').map((d) => d.premultiply)).toEqual([1]);
    baker.bakeForExport(BODY, false);
    expect(draws.filter((d) => d.kind === 'paint').map((d) => d.premultiply)).toEqual([1, 0]);
    baker.dispose();
  });

  it('uploads the detail map as Float32 into R16F and releases the CPU copy', () => {
    const { baker, draws } = setup();
    baker.setLayers(layersWith([]), [BODY]);
    const detail = draws.find((d) => d.kind === 'paint')!.detail!;
    expect(detail.type).toBe(THREE.FloatType);
    expect(detail.format).toBe(THREE.RedFormat);
    expect(detail.internalFormat).toBe('R16F');
    expect(detail.image.data).toBeInstanceOf(Float32Array);
    detail.onUpdate?.(detail);
    expect(detail.image.data).toBeNull();
    baker.dispose();
  });

  it('re-bakes everything after a context restore and refuses to export while lost', () => {
    const { baker, draws, clears, canvas, context, onUpdate } = setup();
    const layers = layersWith([stroke()]);
    baker.setLayers(layers, [BODY, TURRET]);
    const maskClears = () => clears.filter((t) => t && t.texture.format === THREE.RedFormat).length;
    expect(maskClears()).toBe(2);

    context.lost = true;
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(() => baker.bakeForExport(BODY, false)).toThrow(/context is lost/);
    const count = draws.length;
    baker.setLayers(layersWith([stroke(), stroke({ erase: true })]), [BODY]);
    expect(draws.length).toBe(count);

    context.lost = false;
    onUpdate.mockClear();
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    // The last setLayers (one slot, two strokes) is baked again from scratch.
    expect(maskClears()).toBe(3);
    const after = draws.slice(count);
    expect(after.filter((d) => d.kind === 'mask')).toHaveLength(2);
    expect(after.filter((d) => d.kind === 'paint')).toHaveLength(1);
    expect(after.find((d) => d.kind === 'paint')!.detail).not.toBeNull();
    expect(baker.previewTexture(BODY)).not.toBeNull();
    expect(baker.previewTexture(TURRET)).toBeNull();
    expect(onUpdate).toHaveBeenCalled();
    expect(baker.bakeForExport(BODY, false).w).toBe(64);

    baker.dispose();
    const disposedAt = draws.length;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(draws.length).toBe(disposedAt);
  });

  it('frees its targets on dispose and ignores calls afterwards', () => {
    const spy = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');
    const { baker, draws } = setup();
    baker.setLayers(layersWith([stroke()]), [BODY, TURRET]);
    baker.dispose();
    // Two masks and two paint targets.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
    const count = draws.length;
    baker.setLayers(layersWith([]), [BODY]);
    baker.stampStroke('all', stroke(), 0);
    expect(draws.length).toBe(count);
    expect(() => baker.bakeForExport(BODY, false)).toThrow();
    spy.mockRestore();
  });
});

/** The preview's `uPaintMix` (1 shows the paint over the template). */
function previewMix(baker: Baker, slot: string): number {
  const material = baker.previewMaterial(slot);
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    fragmentShader: 'void main() {\n#include <map_fragment>\n}',
    vertexShader: '',
  };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
  expect(shader.fragmentShader).toContain('uPaintMix');
  return shader.uniforms.uPaintMix!.value as number;
}

// ---------------------------------------------------------------- decals

const DECAL: Decal = { center: [0.5, 0.5, 0], normal: [0, 0, 1], up: [0, 1, 0], width: 0.4, height: 0.2, depth: 0.1, part: 'all', mirror: false };

describe('decal maths (mirror of the decal shader)', () => {
  const texel = (pos: Vec3, over: Partial<{ normal: Vec3; group: number }> = {}) => ({ pos, normal: [0, 0, 1] as Vec3, group: 0, ...over });

  it('samples the picture top-left first, +u to the right, +v up', () => {
    expect(decalSampleUv(texel([0.5, 0.5, 0]), DECAL, false)).toEqual([0.5, 0.5]);
    // right = cross(up, normal) = +x; up = +y (the picture's top, t = 0).
    const [s0, t0] = decalSampleUv(texel([0.6, 0.55, 0]), DECAL, false)!;
    expect(s0).toBeCloseTo(0.75);
    expect(t0).toBeCloseTo(0.25);
    expect(decalSampleUv(texel([0.6, 0.55, 0]), DECAL, true)![0]).toBeCloseTo(0.25);
  });

  it('skips texels outside the box, not facing it or of another part', () => {
    expect(decalSampleUv(texel([0.75, 0.5, 0]), DECAL, false)).toBeNull();
    expect(decalSampleUv(texel([0.5, 0.5, 0.06]), DECAL, false)).toBeNull();
    expect(decalSampleUv(texel([0.5, 0.5, 0], { normal: [0, 0, -1] }), DECAL, false)).toBeNull();
    expect(decalSampleUv(texel([0.5, 0.5, 0], { normal: [0, 0, 0] }), DECAL, false)).toBeNull();
    expect(decalSampleUv(texel([0.5, 0.5, 0]), { ...DECAL, part: 'turret' }, false)).toBeNull();
    expect(decalSampleUv(texel([0.5, 0.5, 0], { group: 1 }), { ...DECAL, part: 'turret' }, false)).toEqual([0.5, 0.5]);
  });

  it('fades decals on steep surfaces instead of cutting them', () => {
    const at = (cos: number) => texel([0.5, 0.5, 0], { normal: [Math.sqrt(1 - cos * cos), 0, cos] });
    expect(decalSample(at(1), DECAL, false)!.weight).toBe(1);
    expect(decalSample(at(0.5), DECAL, false)!.weight).toBeCloseTo(0.5, 6);
    // About 78° off-axis (cos 0.2) the old hard cut still drew it; the fade gives nothing.
    expect(decalSample(at(0.2), DECAL, false)).toBeNull();
    // The weight scales the premultiplied contribution: half the alpha over a hidden Base.
    const half = decalContribution([1, 0, 0, 1], 1, decalSample(at(0.5), DECAL, false)!.weight);
    const out = compositeTexel({ rgb: [0, 0, 1], alpha: 0 }, [half], 1, 0, false);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[3]).toBeCloseTo(0.5, 6);
    expect(decalContribution([0.5, 0.25, 0, 0.5], 0.5, 0.5)).toEqual([0.125, 0.0625, 0, 0.125]);
  });

  it('adds the mirrored copy across the model plane', () => {
    expect(decalCopies(DECAL, 2)).toHaveLength(1);
    const [own, copy] = decalCopies({ ...DECAL, center: [0.5, 0.5, 0.3], mirror: true }, 2);
    expect(own!.center).toEqual([0.5, 0.5, 0.3]);
    expect(copy!.center).toEqual([0.5, 0.5, -0.3]);
    expect(copy!.normal).toEqual([0, 0, -1]);
    expect(decalSphere(DECAL)[3]).toBeCloseTo(0.5 * Math.hypot(0.4, 0.2, 0.1));
  });

  it('composites premultiplied: hidden base + decal keeps alpha only where the decal covers', () => {
    const hidden = { rgb: [0.2, 0.4, 0.6] as Vec3, alpha: 0 };
    expect(compositeTexel(hidden, [], 1, 0, false)).toEqual([0, 0, 0, 0]);
    expect(compositeTexel(hidden, [[0.5, 0, 0, 0.5]], 1, 0, false)).toEqual([1, 0, 0, 0.5]);
    // Over a visible base, un-premultiplied for export and premultiplied for the preview.
    const base = { rgb: [0, 0, 1] as Vec3, alpha: 1 };
    expect(compositeTexel(base, [[0.5, 0, 0, 0.5]], 1, 0, false)).toEqual([0.5, 0, 0.5, 1]);
    expect(compositeTexel(base, [[0.5, 0, 0, 0.5]], 1, 0.5, true)).toEqual([0.25, 0, 0.25, 0.5]);
    expect(compositeTexel(base, [[0.5, 0, 0, 0.5]], 1, 0.5, false)).toEqual([0.5, 0, 0.5, 0.5]);
    // Detail darkens decals too; never past 1.
    expect(compositeTexel(base, [], 1.3, 0, false)).toEqual([0, 0, 1, 1]);
    expect(compositeTexel(base, [], 0.5, 0, false)).toEqual([0, 0, 0.5, 1]);
  });

  it('snaps text raster heights to quarter octaves within the raster limits', () => {
    expect(quantiseRasterHeight(10)).toBe(64);
    expect(quantiseRasterHeight(64)).toBe(64);
    expect(quantiseRasterHeight(65)).toBe(76);
    expect(quantiseRasterHeight(1000)).toBe(1024);
    expect(quantiseRasterHeight(99999)).toBe(4096);
    for (let px = 64; px < 4000; px += 37) expect(quantiseRasterHeight(px)).toBeGreaterThanOrEqual(px);
  });

  it('keys text rasters by what changes their pixels', () => {
    const t = newTextLayer('Hello', DECAL);
    expect(textKey(t, 128, false)).toBe(textKey({ ...t, name: 'other' } as typeof t, 128, false));
    expect(textKey(t, 128, false)).not.toBe(textKey({ ...t, text: 'Hallo' }, 128, false));
    expect(textKey(t, 128, false)).not.toBe(textKey(t, 256, false));
    // The export copy never shares a key with the (possibly reduced) preview one.
    expect(textKey(t, 128, true)).not.toBe(textKey(t, 128, false));
  });
});

describe('Baker decals (WebGL stubbed)', () => {
  /** A loader whose pictures arrive when the test says. */
  function assets() {
    const pending = new Map<string, (img: DecalImage) => void>();
    const loadAsset = vi.fn(
      (id: string) =>
        new Promise<DecalImage>((resolve) => {
          pending.set(id, resolve);
        }),
    );
    const resolve = async (id: string, w = 4, h = 2) => {
      pending.get(id)!({ rgba: new Uint8Array(w * h * 4).fill(255), w, h });
      pending.delete(id);
      await new Promise((r) => setTimeout(r, 0));
    };
    return { loadAsset, resolve, pending };
  }

  function setupDecals() {
    const fake = fakeRenderer();
    const a = assets();
    const onUpdate = vi.fn();
    const rasteriseText = vi.fn(async (_layer: unknown, px: number): Promise<DecalImage | null> => ({ rgba: new Uint8Array(4 * px * 4).fill(255), w: 4 * px, h: px }));
    const baker = new Baker(fake.renderer, model(), new Map([[BODY, template(64, 64)], [TURRET, template(32, 32)]]), {
      onUpdate,
      loadAsset: a.loadAsset,
      rasteriseText,
    });
    return { ...fake, ...a, baker, onUpdate, rasteriseText };
  }

  const imageLayer = (assetId: string, over: Partial<Decal> = {}) => ({ ...newImageLayer(assetId, { ...DECAL, ...over }), id: `img-${assetId}` });
  const kinds = (draws: Draw[]) => draws.map((d) => d.kind);

  it('composites base, decals in layer order, then the final pass, with premultiplied over blending', async () => {
    const { baker, draws, resolve } = setupDecals();
    const layers: Layer[] = [newBaseLayer(), imageLayer('a'), imageLayer('b', { mirror: true }), newMaskLayer()];
    baker.setLayers(layers, [BODY]);
    // Pictures not loaded yet: no decal draw.
    expect(kinds(draws)).toEqual(['base', 'paint']);
    await resolve('a');
    await resolve('b');
    await baker.whenReady();
    const last = draws.slice(draws.lastIndexOf(draws.filter((d) => d.kind === 'base').at(-1)!));
    // a once, b twice (its mirrored copy), in layer order, then the final pass.
    expect(kinds(last)).toEqual(['base', 'decal', 'decal', 'decal', 'paint']);
    const decal = last[1]!;
    expect(decal.blending).toBe(THREE.CustomBlending);
    expect(decal.blend).toEqual([THREE.OneFactor, THREE.OneMinusSrcAlphaFactor, THREE.OneFactor, THREE.OneMinusSrcAlphaFactor]);
    expect(decal.sphere).toEqual(decalSphere(DECAL));
    expect(last[2]!.decalTex).not.toBe(decal.decalTex);
    expect(last[3]!.sphere![2]).toBeCloseTo(-last[2]!.sphere![2]);
    // Base, decals and their blends go to the scratch intermediate, the final pass to the slot's target.
    expect(new Set(last.slice(0, 4).map((d) => d.target))).toHaveLength(1);
    expect(last[4]!.target).not.toBe(last[0]!.target);
    baker.dispose();
  });

  it('whenReady waits for the pictures and the re-bake', async () => {
    const { baker, draws, resolve, onUpdate } = setupDecals();
    baker.setLayers([newBaseLayer(), imageLayer('a')], [BODY]);
    let ready = false;
    const waiting = baker.whenReady().then(() => (ready = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(ready).toBe(false);
    onUpdate.mockClear();
    await resolve('a');
    await waiting;
    expect(ready).toBe(true);
    expect(onUpdate).toHaveBeenCalled();
    expect(draws.at(-2)!.kind).toBe('decal');
    baker.dispose();
  });

  it('keeps showing the previous picture until the new one arrives, and releases what layers drop', async () => {
    const { baker, draws, resolve, loadAsset } = setupDecals();
    const layer = imageLayer('a');
    baker.setLayers([newBaseLayer(), layer], [BODY]);
    await resolve('a');
    const shown = draws.filter((d) => d.kind === 'decal').at(-1)!.decalTex;
    baker.setLayers([newBaseLayer(), { ...layer, assetId: 'b' }], [BODY]);
    expect(draws.filter((d) => d.kind === 'decal').at(-1)!.decalTex).toBe(shown);
    await resolve('b');
    expect(draws.filter((d) => d.kind === 'decal').at(-1)!.decalTex).not.toBe(shown);
    expect(loadAsset.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    // Hidden: no decal draws.
    const before = draws.length;
    baker.setLayers([newBaseLayer(), { ...layer, assetId: 'b', visible: false }], [BODY]);
    expect(kinds(draws.slice(before))).toEqual(['base', 'paint']);
    baker.dispose();
  });

  it('draws full-size pictures between prepareExport and endExport, and refuses to export without them', async () => {
    const { baker, draws, resolve, loadAsset } = setupDecals();
    const layer = imageLayer('a');
    baker.setLayers([newBaseLayer(), layer], [BODY]);
    // Wider than the preview cap: the preview copy is reduced, so the export loads its own.
    await resolve('a', 4096, 2);
    const preview = draws.filter((d) => d.kind === 'decal').at(-1)!.decalTex;
    expect(preview?.image).toMatchObject({ width: 2048, height: 1 });
    expect(() => baker.bakeForExport(BODY, false)).toThrow(EXPORT_PICTURE_NOT_READY);
    const prepared = baker.prepareExport();
    await new Promise((r) => setTimeout(r, 0));
    expect(loadAsset).toHaveBeenCalledTimes(2);
    // Not loaded yet: still refused.
    expect(() => baker.bakeForExport(BODY, false)).toThrow(EXPORT_PICTURE_NOT_READY);
    await resolve('a', 4096, 2);
    await prepared;
    baker.bakeForExport(BODY, false);
    const exported = draws.filter((d) => d.kind === 'decal').at(-1)!;
    expect(exported.decalTex).not.toBe(preview);
    expect(exported.decalTex?.image).toMatchObject({ width: 4096, height: 2 });
    expect(draws.filter((d) => d.kind === 'paint').at(-1)!.premultiply).toBe(0);
    baker.endExport();
    expect(() => baker.bakeForExport(BODY, false)).toThrow(EXPORT_PICTURE_NOT_READY);
    // The preview keeps its own copy.
    baker.setLayers([newBaseLayer(), { ...layer, opacity: 0.5 }], [BODY]);
    expect(draws.filter((d) => d.kind === 'decal').at(-1)!.decalTex).toBe(preview);
    baker.dispose();
  });

  it('exports with the preview copy when it is already full size', async () => {
    const { baker, draws, resolve, loadAsset } = setupDecals();
    baker.setLayers([newBaseLayer(), imageLayer('a')], [BODY]);
    await resolve('a', 8, 4);
    const preview = draws.filter((d) => d.kind === 'decal').at(-1)!.decalTex;
    await baker.prepareExport();
    expect(loadAsset).toHaveBeenCalledTimes(1);
    baker.bakeForExport(BODY, false);
    expect(draws.filter((d) => d.kind === 'decal').at(-1)!.decalTex).toBe(preview);
    baker.endExport();
    // The shared reference went back: the preview still draws.
    baker.setLayers([newBaseLayer(), { ...imageLayer('a'), opacity: 0.4 }], [BODY]);
    expect(draws.filter((d) => d.kind === 'decal').at(-1)!.decalTex).toBe(preview);
    baker.dispose();
  });

  it('holds no stray reference when a picture change is undone while the new one loads', async () => {
    const { baker, resolve, pending } = setupDecals();
    const layer = imageLayer('a');
    baker.setLayers([newBaseLayer(), layer], [BODY]);
    await resolve('a');
    baker.setLayers([newBaseLayer(), { ...layer, assetId: 'b' }], [BODY]);
    baker.setLayers([newBaseLayer(), layer], [BODY]);
    const cache = (baker as unknown as { decalTextures: { refs(k: string): number; keys(): string[] } }).decalTextures;
    expect(cache.refs('img:a:p')).toBe(1);
    expect(cache.keys()).toEqual(['img:a:p']);
    expect(pending.has('b')).toBe(true);
    await resolve('b');
    expect(cache.keys()).toEqual(['img:a:p']);
    baker.setLayers([newBaseLayer()], [BODY]);
    expect(cache.keys()).toEqual([]);
    baker.dispose();
  });

  it('rasterises text for export at the export height, apart from a reduced preview', async () => {
    const fake = fakeRenderer();
    // Very wide text: the raster is wider than the preview cap, so the preview copy is reduced.
    const rasteriseText = vi.fn(async (_l: unknown, px: number): Promise<DecalImage> => ({ rgba: new Uint8Array(3000 * px * 4), w: 3000, h: px }));
    const baker = new Baker(fake.renderer, model(), new Map([[BODY, template(64, 64)]]), { rasteriseText });
    const text = { ...newTextLayer('A long line of text', { ...DECAL, width: 0.8, height: 0.05 }), id: 'txt' };
    baker.setLayers([newBaseLayer(), text], [BODY]);
    await baker.whenReady();
    await baker.prepareExport();
    expect(rasteriseText).toHaveBeenCalledTimes(2);
    const keys = (baker as unknown as { decalTextures: { keys(): string[] } }).decalTextures.keys();
    expect(keys.some((k) => k.endsWith(':p'))).toBe(true);
    expect(keys.some((k) => k.endsWith(':f'))).toBe(true);
    baker.bakeForExport(BODY, false);
    expect(fake.draws.filter((d) => d.kind === 'decal').at(-1)!.decalTex?.image).toMatchObject({ width: 3000 });
    baker.endExport();
    baker.dispose();
  });

  it('drops scratch intermediates no preview uses any more', async () => {
    const { baker } = setupDecals();
    const scratches = () => (baker as unknown as { scratches: Map<string, unknown> }).scratches;
    baker.setLayers([newBaseLayer()], [BODY, TURRET]);
    expect([...scratches().keys()].sort()).toEqual(['32x32', '64x64']);
    baker.setLayers([newBaseLayer()], [BODY]);
    expect([...scratches().keys()]).toEqual(['64x64']);
    baker.bakeForExport(TURRET, false); // 32×32, no preview of that size now: its scratch goes right after
    expect([...scratches().keys()]).toEqual(['64x64']);
    baker.dispose();
  });

  it('rasterises text at twice the texel density, snapped', async () => {
    const { baker, rasteriseText, draws } = setupDecals();
    const text = { ...newTextLayer('Hi', { ...DECAL, width: 0.2, height: 0.1 }), id: 'txt' };
    baker.setLayers([newBaseLayer(), text], [BODY]);
    await baker.whenReady();
    expect(rasteriseText).toHaveBeenCalledTimes(1);
    const px = rasteriseText.mock.calls[0]![1];
    expect(px).toBe(quantiseRasterHeight(px));
    expect(px).toBeGreaterThanOrEqual(64);
    expect(draws.at(-2)!.kind).toBe('decal');
    // Same text, other opacity: no new raster.
    baker.setLayers([newBaseLayer(), { ...text, opacity: 0.5 }], [BODY]);
    expect(rasteriseText).toHaveBeenCalledTimes(1);
    expect(draws.at(-2)!.opacity).toBe(0.5);
    baker.dispose();
  });

  it('checks shared texels from the overlap map built once per slot', async () => {
    const { baker, draws, footprint } = setupDecals();
    baker.setLayers([newBaseLayer()], [BODY, TURRET]);
    expect(await baker.decalTouchesSharedTexels(DECAL)).toBe(false);
    expect(draws.filter((d) => d.kind === 'count')).toHaveLength(2);
    expect(draws.filter((d) => d.kind === 'footprint')).toHaveLength(2);
    footprint.shared = true;
    expect(await baker.decalTouchesSharedTexels(DECAL)).toBe(true);
    // Overlap maps are kept; the first slot already answers.
    expect(draws.filter((d) => d.kind === 'count')).toHaveLength(2);
    expect(draws.filter((d) => d.kind === 'footprint')).toHaveLength(3);
    baker.dispose();
    expect(await baker.decalTouchesSharedTexels(DECAL)).toBe(false);
  });
});

describe('texel density for text rasters', () => {
  /** A grid of `n × n` quads (2 triangles each) per slot, UVs over the whole texture. */
  function gridModel(n: number, slots = 3): VehicleModelData {
    const perSlot = (n + 1) * (n + 1);
    const positions = new Float32Array(perSlot * slots * 3);
    const normals = new Float32Array(perSlot * slots * 3);
    const uvs = new Float32Array(perSlot * slots * 2);
    const indices = new Uint32Array(n * n * 6 * slots);
    const parts: ModelHeader['parts'] = [];
    let k = 0;
    for (let s = 0; s < slots; s++) {
      const v0 = s * perSlot;
      for (let y = 0; y <= n; y++)
        for (let x = 0; x <= n; x++) {
          const v = v0 + y * (n + 1) + x;
          positions.set([(x / n) * 4 - 2, (y / n) * 2 - 1, s * 0.5], v * 3);
          normals.set([0, 0, 1], v * 3);
          uvs.set([x / n, 1 - y / n], v * 2);
        }
      const indexOffset = k;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const a = v0 + y * (n + 1) + x;
          indices.set([a, a + 1, a + n + 2, a, a + n + 2, a + n + 1], k);
          k += 6;
        }
      parts.push({ node: `n${s}`, group: s === 0 ? 'hull' : s === 1 ? 'turret' : 'gun', slot: s, vertexOffset: v0, vertexCount: perSlot, indexOffset, indexCount: k - indexOffset });
    }
    const header: ModelHeader = {
      vehicle: 'grid',
      model: 'grid',
      mirrorAxis: 2,
      slots: Array.from({ length: slots }, (_, i) => ({ texture: `grid_${i}_c`, width: 2048, height: 2048, hq: true, paintableByDefault: true })),
      parts,
      vertexCount: perSlot * slots,
      indexCount: indices.length,
    };
    return { header, positions, normals, uvs, indices };
  }

  it('matches texelsPerUnit (decal.ts) from the precomputed table', () => {
    const m = gridModel(40);
    const output = { width: 2048, height: 2048 };
    for (const decal of [
      DECAL,
      { ...DECAL, center: [-1.5, 0.7, 0] as Vec3, width: 0.3, height: 0.1 },
      { ...DECAL, part: 'turret' },
      { ...DECAL, center: [9, 9, 9] as Vec3 },
    ]) {
      for (let slot = 0; slot < 3; slot++) {
        const ref = texelsPerUnit(m, slot, output, decal);
        const fast = slotDensity(densityTable(m, slot), decal, output);
        if (ref === null) expect(fast).toBeNull();
        else expect(fast!).toBeCloseTo(ref, 3);
      }
    }
  });
});
