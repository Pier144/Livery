import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VehicleModelData } from '../modelBuffer';
import {
  defaultOrbit,
  EditorScene,
  FOV,
  framingDistance,
  orbitDrag,
  orbitPosition,
  orbitZoom,
  PHI_MAX,
  PHI_MIN,
  projectedRadius,
  quickViewOrbit,
  toStraightTopDown,
  ZOOM_MAX,
  ZOOM_MIN,
} from './scene';

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) < eps);

describe('scene camera maths', () => {
  it('frames a sphere: the wider the FOV the closer, and a view narrower than tall steps back', () => {
    const d = framingDistance(2);
    expect(d).toBeGreaterThan(2 / Math.sin((FOV * Math.PI) / 360));
    expect(framingDistance(2, 60)).toBeLessThan(d);
    expect(framingDistance(2, FOV, 0.5)).toBeGreaterThan(d);
    expect(framingDistance(2, FOV, 2)).toBeCloseTo(d);
    expect(framingDistance(0)).toBe(framingDistance(1));
  });

  it('quick views look at the nose along −X, from the left (−Z), from behind and from above', () => {
    const c: [number, number, number] = [1, 2, 3];
    const pos = (v: Parameters<typeof quickViewOrbit>[0]) => orbitPosition(quickViewOrbit(v, c, 10));
    const front = pos('front');
    expect(front[0]).toBeGreaterThan(c[0] + 5);
    expect(front[2]).toBeCloseTo(c[2]);
    const rear = pos('rear');
    expect(rear[0]).toBeLessThan(c[0] - 5);
    const side = pos('side');
    expect(side[2]).toBeLessThan(c[2] - 5);
    expect(side[0]).toBeCloseTo(c[0]);
    const top = pos('top');
    expect(top[1]).toBeCloseTo(c[1] + 10, 2);
    // Just behind the zenith, so the nose points up the screen.
    expect(top[0]).toBeLessThan(c[0]);
  });

  it('orbit positions sit at the radius around the target', () => {
    const o = defaultOrbit([0, 1, 0], 5);
    const p = orbitPosition(o);
    expect(Math.hypot(p[0], p[1] - 1, p[2])).toBeCloseTo(5);
  });

  it('dragging turns the azimuth and clamps the polar angle short of the poles', () => {
    const o = defaultOrbit([0, 0, 0], 5);
    const turned = orbitDrag(o, 100, 0);
    expect(turned.theta).toBeGreaterThan(o.theta);
    expect(turned.phi).toBe(o.phi);
    expect(orbitDrag(o, 0, 10_000).phi).toBe(PHI_MIN);
    expect(orbitDrag(o, 0, -10_000).phi).toBe(PHI_MAX);
  });

  it('zoom stays within the framing limits', () => {
    const o = defaultOrbit([0, 0, 0], 5);
    expect(orbitZoom(o, -100, 5).radius).toBeLessThan(5);
    expect(orbitZoom(o, 100, 5).radius).toBeGreaterThan(5);
    expect(orbitZoom(o, -1e6, 5).radius).toBeCloseTo(5 * ZOOM_MIN);
    expect(orbitZoom(o, 1e6, 5).radius).toBeCloseTo(5 * ZOOM_MAX);
  });

  it('projects a brush radius to screen pixels', () => {
    // At the distance where the half-height of the view spans exactly `r`, r covers half the view height.
    const r = 1;
    const d = r / Math.tan((FOV * Math.PI) / 360);
    expect(projectedRadius(r, d, 800)).toBeCloseTo(400);
    expect(projectedRadius(r, 2 * d, 800)).toBeCloseTo(200);
    expect(projectedRadius(r, 0, 800)).toBe(0);
  });

  it('turns a WebGL read-back into top-down rows with straight alpha', () => {
    // 1×2: bottom row (first in GL) half-transparent red premultiplied, top row opaque blue.
    const gl = new Uint8Array([128, 0, 0, 128, 0, 0, 255, 255]);
    const out = toStraightTopDown(gl, 1, 2);
    expect(close([...out.slice(0, 4)], [0, 0, 255, 255])).toBe(true);
    expect([...out.slice(4, 8)]).toEqual([255, 0, 0, 128]);
    // Fully transparent pixels stay zero.
    expect([...toStraightTopDown(new Uint8Array(4), 1, 1)]).toEqual([0, 0, 0, 0]);
  });
});

afterEach(() => vi.unstubAllGlobals());

/** A renderer that draws nothing: enough for the scene's camera, picking and read-back code. */
function fakeRenderer() {
  const seen: { aspect: number; position: number[] }[] = [];
  const renderer = {
    setClearColor: vi.fn(),
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    setRenderTarget: vi.fn(),
    getRenderTarget: vi.fn(() => null),
    clear: vi.fn(),
    render: vi.fn((_scene: THREE.Scene, cam: THREE.PerspectiveCamera) => {
      seen.push({ aspect: cam.aspect, position: cam.position.toArray() });
    }),
    readRenderTargetPixels: vi.fn(),
    outputColorSpace: '',
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, mock: renderer, seen };
}

/** A hull triangle at z = 0 and a smaller turret triangle in front of it at z = 2, both facing +z. */
function twoPartModel(): VehicleModelData {
  const positions = new Float32Array([-5, -5, 0, 5, -5, 0, 0, 5, 0, -1, -1, 2, 1, -1, 2, 0, 1, 2]);
  const normals = new Float32Array(18);
  for (let i = 0; i < 6; i++) normals[i * 3 + 2] = 1;
  return {
    header: {
      vehicle: 't',
      model: 't',
      mirrorAxis: 2,
      slots: [{ texture: 't_body_c', width: 64, height: 64, hq: true, paintableByDefault: true }],
      parts: [
        { node: 'body', group: 'hull', slot: 0, vertexOffset: 0, vertexCount: 3, indexOffset: 0, indexCount: 3 },
        { node: 'turret', group: 'turret', slot: 0, vertexOffset: 3, vertexCount: 3, indexOffset: 3, indexCount: 3 },
      ],
      vertexCount: 6,
      indexCount: 6,
    },
    positions,
    normals,
    uvs: new Float32Array(12),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
  };
}

/** A scene over a 200 x 100 view (so the on-screen aspect is not 1) holding `twoPartModel`. */
function makeScene() {
  // The scene asks for a frame after every camera change; none must run behind the tests' back.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const fake = fakeRenderer();
  const canvas = document.createElement('canvas');
  const parent = document.createElement('div');
  Object.defineProperty(parent, 'clientWidth', { value: 200 });
  Object.defineProperty(parent, 'clientHeight', { value: 100 });
  parent.appendChild(canvas);
  const scene = new EditorScene(fake.renderer, canvas);
  scene.setModel(twoPartModel(), () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  return { scene, ...fake };
}

describe('EditorScene orbits at aspect 1', () => {
  it('quickOrbit is the quick view framed for a square picture, whatever shape the view on screen is', () => {
    const { scene } = makeScene();
    const framing = framingDistance(scene.boundingRadius, FOV, 1);
    const center = scene.orbitFor(0, 1, 1).target;
    for (const view of ['front', 'side', 'rear', 'top'] as const) {
      expect(scene.quickOrbit(view)).toEqual(quickViewOrbit(view, center, framing));
    }
  });

  it('orbitFor clamps the polar angle and the zoom, and looks at the model centre', () => {
    const { scene } = makeScene();
    const framing = framingDistance(scene.boundingRadius, FOV, 1);
    const o = scene.orbitFor(0.7, 1.2, 1);
    expect(o.theta).toBe(0.7);
    expect(o.phi).toBe(1.2);
    expect(o.radius).toBeCloseTo(framing);
    // The bounding sphere of the two triangles is centred in x and y, and between z 0 and 2.
    expect(o.target[0]).toBeCloseTo(0, 3);
    expect(o.target[2]).toBeGreaterThan(0);
    expect(o.target[2]).toBeLessThan(2);
    expect(scene.orbitFor(0, -3, 1).phi).toBe(PHI_MIN);
    expect(scene.orbitFor(0, 10, 1).phi).toBe(PHI_MAX);
    expect(scene.orbitFor(0, 1, 0.001).radius).toBeCloseTo(framing * ZOOM_MIN);
    expect(scene.orbitFor(0, 1, 100).radius).toBeCloseTo(framing * ZOOM_MAX);
    expect(scene.orbitFor(0, 1, 2).radius).toBeCloseTo(framing * 2);
  });

  it('orbitFor hands out its own target array', () => {
    const { scene } = makeScene();
    const a = scene.orbitFor(0, 1, 1);
    a.target[0] = 99;
    expect(scene.orbitFor(0, 1, 1).target[0]).not.toBe(99);
  });
});

describe('EditorScene.raycastView', () => {
  /** Camera on +z, 20 units out, looking down −z at the origin. */
  const FRONT = { target: [0, 0, 0] as [number, number, number], radius: 20, theta: Math.PI / 2, phi: Math.PI / 2 };

  it('picks from the given orbit, filters by group and answers the camera it used', () => {
    const { scene } = makeScene();
    const all = scene.raycastView(FRONT, 0, 0);
    expect(all.hit?.node).toBe('turret');
    expect(all.hit?.point[2]).toBeCloseTo(2);
    expect(all.hit?.distance).toBeCloseTo(18);
    expect(scene.raycastView(FRONT, 0, 0, 'hull').hit?.node).toBe('body');
    expect(scene.raycastView(FRONT, 0, 0, 'gun').hit).toBeNull();
    // Column-major world matrix: the translation is the camera position.
    const m = all.cameraMatrixWorld;
    expect(m).toHaveLength(16);
    expect([m[12], m[13], m[14]].map((v) => Math.round(v!))).toEqual([0, 0, 20]);
  });

  it('misses outside the model', () => {
    const { scene } = makeScene();
    expect(scene.raycastView(FRONT, 0.99, 0.99).hit).toBeNull();
  });

  it('uses aspect 1 whatever the view on screen is, and puts the on-screen camera back', () => {
    const { scene } = makeScene();
    const matrix = scene.cameraMatrixWorld();
    const projected = scene.project([1, 0.5, 0]);
    // At aspect 1 the half-height spans tan(FOV / 2) · 20 units on the hull plane, and so does the half-width.
    const hit = scene.raycastView(FRONT, 0.2, 0, 'hull').hit;
    expect(hit?.point[0]).toBeCloseTo(0.2 * Math.tan((FOV * Math.PI) / 360) * 20, 3);
    // Back on screen: the 200 x 100 projection (its aspect is observable through project()) and the camera.
    expect(scene.cameraMatrixWorld()).toEqual(matrix);
    expect(scene.project([1, 0.5, 0])).toEqual(projected);
  });

  it('puts the camera back when the pick throws', () => {
    const { scene } = makeScene();
    const matrix = scene.cameraMatrixWorld();
    const projected = scene.project([1, 0.5, 0]);
    // Camera and projection must both be restored by `finally`, so the failure is injected inside the pick.
    const spy = vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    try {
      expect(() => scene.raycastView(FRONT, 0, 0)).toThrow('boom');
    } finally {
      spy.mockRestore();
    }
    expect(scene.cameraMatrixWorld()).toEqual(matrix);
    expect(scene.project([1, 0.5, 0])).toEqual(projected);
  });

  it('leaves plain raycast on the on-screen camera', () => {
    const { scene } = makeScene();
    const hit = scene.raycast(100, 50);
    expect(hit).not.toBeNull();
    expect(['body', 'turret']).toContain(hit!.node);
  });
});

describe('EditorScene.renderPixels', () => {
  it('renders the given orbit square, reads it back as straight top-down RGBA and restores the camera', () => {
    const { scene, mock, seen } = makeScene();
    seen.length = 0; // the frames the scene drew while being set up
    const before = scene.cameraMatrixWorld();
    const projected = scene.project([1, 0.5, 0]);
    // 2 x 2 read-back, bottom row first: an empty pixel pair, then an opaque blue and a half-transparent premultiplied red.
    mock.readRenderTargetPixels.mockImplementation((_t: unknown, _x: number, _y: number, _w: number, _h: number, out: Uint8Array) => {
      out.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 128, 0, 0, 128]);
    });
    const orbit = scene.orbitFor(0.4, 1, 1);
    const out = scene.renderPixels(orbit, 2);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect([...out]).toEqual([0, 0, 255, 255, 255, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aspect).toBe(1);
    const expected = orbitPosition(orbit);
    seen[0]!.position.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 4));
    expect(mock.readRenderTargetPixels).toHaveBeenCalledWith(expect.anything(), 0, 0, 2, 2, expect.any(Uint8Array));
    expect(scene.cameraMatrixWorld()).toEqual(before);
    expect(scene.project([1, 0.5, 0])).toEqual(projected);
    expect(mock.setRenderTarget).toHaveBeenLastCalledWith(null);
  });

  it('restores the camera and the render target when drawing fails', () => {
    const { scene, mock } = makeScene();
    const before = scene.cameraMatrixWorld();
    mock.render.mockImplementationOnce(() => {
      throw new Error('context lost');
    });
    expect(() => scene.renderPixels(scene.orbitFor(1, 1, 1), 4)).toThrow('context lost');
    expect(scene.cameraMatrixWorld()).toEqual(before);
    expect(mock.setRenderTarget).toHaveBeenLastCalledWith(null);
  });

  it('thumbnailPng is a caller of renderPixels with the opening view', async () => {
    const { scene } = makeScene();
    const spy = vi.spyOn(scene, 'renderPixels');
    // jsdom has no 2D canvas, so the PNG step fails: the call into renderPixels is the point.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(scene.thumbnailPng(8)).rejects.toThrow('no 2D context');
    expect(spy).toHaveBeenCalledTimes(1);
    const [orbit, size] = spy.mock.calls[0]!;
    expect(size).toBe(8);
    expect(orbit).toEqual(defaultOrbit(scene.orbitFor(0, 1, 1).target, framingDistance(scene.boundingRadius, FOV, 1)));
  });
});
