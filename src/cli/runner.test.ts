import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrbitState, SceneHit } from '@/atelier/gl/scene';
import type { Decal, ImageLayer, Layer } from '@/atelier/project';
import { encodeMockModel, mockSlots, mockTemplate } from '@/dev/mockAtelier';
import type { Engine, EngineInput } from '@/screens/Atelier/engine';
import type { AtelierProject } from '@/types';
import type { CliJob, PlaceResult, PutResult, RenderResult, VehicleInfo } from './job';

// jsdom has no 2D canvas: PNG encoding is a stand-in that keeps the pixels' sum (so a test can
// tell a grid was drawn).
vi.mock('@/atelier/gl/scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/atelier/gl/scene')>()),
  encodePng: vi.fn(async (rgba: Uint8ClampedArray, w: number, h: number) => {
    let sum = 0;
    for (const v of rgba) sum += v;
    return new TextEncoder().encode(JSON.stringify({ w, h, sum }));
  }),
}));

import { runJob, type RunnerDeps } from './runner';

const VEHICLE = 'mock_vehicle';
const SLOTS = mockSlots(VEHICLE);

const decal = (over: Partial<Decal> = {}): Decal => ({
  center: [0, 0, 0.5],
  normal: [0, 0, 1],
  up: [0, 1, 0],
  width: 0.2,
  height: 0.2,
  depth: 0.1,
  part: 'all',
  mirror: false,
  ...over,
});

const image = (id: string, d: Decal | null): ImageLayer => ({ id, kind: 'image', name: '', visible: true, assetId: 'a1', decal: d, opacity: 1, flipX: false });

function project(layers: unknown[] = []): AtelierProject {
  return {
    version: 1,
    id: 'p1',
    name: 'Test',
    vehicle: VEHICLE,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    slots: SLOTS.map((s) => ({ texture: s.texture, enabled: s.texture !== `${VEHICLE}_gun_c` })),
    output: { highQuality: false },
    layers,
  } as AtelierProject;
}

interface Stub {
  deps: RunnerDeps;
  calls: { cmd: string; args?: unknown }[];
  raw: { cmd: string; body: Uint8Array; headers: Record<string, string> }[];
  engine: ReturnType<typeof stubEngine>;
  inputs: EngineInput[];
}

const ORBIT: OrbitState = { target: [0, 0, 0], radius: 3, theta: 0, phi: 1 };
// A camera looking down −Z with +Y up: column-major, the up column is elements 4..6.
const CAMERA = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1];

function stubEngine() {
  const order: string[] = [];
  // Pictures the stub Baker asks for in whenReady (as the real one does through input.loadAsset).
  const pictures: string[] = [];
  const state: { input: EngineInput | null } = { input: null };
  let hit: SceneHit | null = { point: [0.1, 0.2, 0.5], normal: [0, 0, 1], node: '@root', group: 'hull', distance: 2.5 };
  const shared = new Set<string>();
  return {
    order,
    shared,
    pictures,
    state,
    setHit: (h: SceneHit | null) => (hit = h),
    scene: {
      quickOrbit: vi.fn(() => ORBIT),
      orbitFor: vi.fn(() => ORBIT),
      raycastView: vi.fn(() => ({ hit, cameraMatrixWorld: CAMERA })),
      renderPixels: vi.fn((_o: OrbitState, size: number) => {
        order.push('renderPixels');
        return new Uint8ClampedArray(size * size * 4);
      }),
      thumbnailPng: vi.fn(async () => new Uint8Array([1, 2, 3])),
      contextLost: vi.fn(() => false),
    },
    baker: {
      setLayers: vi.fn((_l: Layer[], _s: string[]) => order.push('setLayers')),
      whenReady: vi.fn(async () => {
        order.push('whenReady');
        // The real Baker swallows a failed picture (it marks it failed and bakes without it).
        for (const id of pictures) await state.input!.loadAsset!(id).catch(() => {});
      }),
      upgrade: vi.fn(() => order.push('upgrade')),
      decalTouchesSharedTexels: vi.fn(async (d: Decal) => shared.has(JSON.stringify(d.center))),
      prepareExport: vi.fn(async () => {
        order.push('prepareExport');
      }),
      bakeForExport: vi.fn((slot: string) => {
        order.push(`bake:${slot}`);
        return { rgba: new Uint8Array(4 * 4 * 4), w: 4, h: 4, downscaled: false };
      }),
      endExport: vi.fn(() => order.push('endExport')),
    },
    dispose: vi.fn(),
  };
}

function stub(stored: AtelierProject = project()): Stub {
  const calls: Stub['calls'] = [];
  const raw: Stub['raw'] = [];
  const engine = stubEngine();
  const inputs: EngineInput[] = [];
  const call = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case 'atelier_project_get':
        return stored;
      case 'atelier_model':
        return encodeMockModel(args!.vehicle as string);
      case 'atelier_template_texture': {
        const i = SLOTS.findIndex((s) => s.texture === args!.slot);
        return mockTemplate(i);
      }
      case 'atelier_asset': {
        if (args!.assetId === 'gone') throw { code: 'notFound', message: 'This picture is missing from the project' };
        // u32 width and height (little-endian), then RGBA.
        const buf = new Uint8Array(8 + 4);
        buf[0] = 1;
        buf[4] = 1;
        return buf;
      }
      case 'atelier_project_save':
        return { ...(args!.project as AtelierProject), updatedAt: '2026-02-02T00:00:00Z' };
      default:
        throw { code: 'internal', message: `unexpected ${cmd}` };
    }
  });
  const callRaw = vi.fn(async (cmd: string, body: Uint8Array, headers: Record<string, string>) => {
    raw.push({ cmd, body, headers });
    return null;
  });
  const deps: RunnerDeps = {
    call: call as unknown as RunnerDeps['call'],
    callRaw: callRaw as unknown as RunnerDeps['callRaw'],
    createEngine: (input) => {
      inputs.push(input);
      engine.state.input = input;
      return engine as unknown as Engine;
    },
    canvas: () => document.createElement('canvas'),
  };
  return { deps, calls, raw, engine, inputs };
}

const decoded = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body)) as { w: number; h: number; sum: number };

describe('runJob: place', () => {
  const job: CliJob = { command: 'place', id: 'p1', view: { kind: 'quick', name: 'front' }, at: [0.5, 0.25], part: null, width: null, height: null, depth: null };

  it('casts through the view at the given point and frames a decal at the hit', async () => {
    const s = stub();
    const out = (await runJob(job, s.deps)) as PlaceResult;
    expect(s.engine.scene.quickOrbit).toHaveBeenCalledWith('front');
    expect(s.engine.scene.raycastView).toHaveBeenCalledWith(ORBIT, 0, 0.5, null);
    expect(out.group).toBe('hull');
    expect(out.node).toBe('@root');
    expect(out.decal.center).toEqual([0.1, 0.2, 0.5]);
    expect(out.decal.normal).toEqual([0, 0, 1]);
    expect(out.decal.up).toEqual([0, 1, 0]);
    expect(out.decal).toMatchObject({ width: 1, height: 1, part: 'all', mirror: false });
    expect(out.decal.depth).toBeGreaterThan(0);
    expect(s.engine.dispose).toHaveBeenCalledOnce();
  });

  it('passes --part to the ray and to the decal, with the given size', async () => {
    const s = stub();
    const out = (await runJob({ ...job, view: { kind: 'orbit', theta: 0.5, phi: 1.2, zoom: 2 }, part: 'turret', width: 0.5, height: 0.25, depth: 0.3 }, s.deps)) as PlaceResult;
    expect(s.engine.scene.orbitFor).toHaveBeenCalledWith(0.5, 1.2, 2);
    expect(s.engine.scene.raycastView).toHaveBeenCalledWith(ORBIT, 0, 0.5, 'turret');
    expect(out.decal).toMatchObject({ width: 0.5, height: 0.25, depth: 0.3, part: 'turret' });
  });

  it('answers noHit when the ray misses, and still disposes the engine', async () => {
    const s = stub();
    s.engine.setHit(null);
    await expect(runJob(job, s.deps)).rejects.toMatchObject({ code: 'noHit' });
    expect(s.engine.dispose).toHaveBeenCalledOnce();
  });
});

describe('runJob: render', () => {
  const job = (over: Partial<Extract<CliJob, { command: 'render' }>> = {}): CliJob => ({
    command: 'render',
    id: 'p1',
    views: [
      { kind: 'quick', name: 'front' },
      { kind: 'orbit', theta: 0.5, phi: 1.2, zoom: 1 },
    ],
    size: 256,
    grid: false,
    flat: false,
    ...over,
  });

  it('sends one cli_file per view, named after it, at full preview quality', async () => {
    const s = stub();
    const out = (await runJob(job(), s.deps)) as RenderResult;
    const files = s.raw.filter((r) => r.cmd === 'cli_file');
    expect(files.map((f) => f.headers['x-name'])).toEqual(['front.png', 'orbit_0.50_1.20_1.00.png']);
    expect(out.views).toEqual([
      { view: 'front', file: 'front.png', width: 256, height: 256 },
      { view: 'orbit_0.50_1.20_1.00', file: 'orbit_0.50_1.20_1.00.png', width: 256, height: 256 },
    ]);
    expect(out.flat).toEqual([]);
    expect(s.engine.order.indexOf('upgrade')).toBeLessThan(s.engine.order.indexOf('renderPixels'));
    expect(s.engine.order.indexOf('whenReady')).toBeLessThan(s.engine.order.indexOf('renderPixels'));
    expect(decoded(files[0]!.body).sum).toBe(0);
  });

  it('draws the grid on the pictures with --grid', async () => {
    const s = stub();
    await runJob(job({ grid: true }), s.deps);
    const files = s.raw.filter((r) => r.cmd === 'cli_file');
    expect(decoded(files[0]!.body).sum).toBeGreaterThan(0);
  });

  it('with --flat bakes each painted slot between prepareExport and endExport', async () => {
    const s = stub();
    const out = (await runJob(job({ flat: true }), s.deps)) as RenderResult;
    const painted = SLOTS.map((x) => x.texture).filter((t) => t !== `${VEHICLE}_gun_c`);
    expect(out.flat).toEqual(painted.map((slot) => ({ slot, file: `flat_${slot}.png`, width: 4, height: 4 })));
    const o = s.engine.order;
    expect(o.slice(o.indexOf('prepareExport'))).toEqual(['prepareExport', ...painted.map((t) => `bake:${t}`), 'endExport']);
    expect(s.raw.filter((r) => r.cmd === 'cli_file').map((f) => f.headers['x-name'])).toEqual(['front.png', 'orbit_0.50_1.20_1.00.png', ...painted.map((t) => `flat_${t}.png`)]);
  });

  it('ends the export and disposes the engine when a bake fails', async () => {
    const s = stub();
    s.engine.baker.bakeForExport.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(runJob(job({ flat: true }), s.deps)).rejects.toThrow('boom');
    expect(s.engine.baker.endExport).toHaveBeenCalledOnce();
    expect(s.engine.dispose).toHaveBeenCalledOnce();
  });

  it('loads the project, the model, every template and pictures through the job project', async () => {
    const s = stub();
    await runJob(job(), s.deps);
    expect(s.calls.filter((c) => c.cmd === 'atelier_template_texture').map((c) => (c.args as { slot: string }).slot)).toEqual(SLOTS.map((x) => x.texture));
    expect([...s.inputs[0]!.templates.keys()]).toEqual(SLOTS.map((x) => x.texture));
    const [, painted] = s.engine.baker.setLayers.mock.calls[0]!;
    expect(painted).toEqual([`${VEHICLE}_body_c`, `${VEHICLE}_turret_c`]);
  });
});

describe('runJob: put', () => {
  it('saves the checked layers and lists only mirrored decals on shared texels', async () => {
    const mirroredShared = image('l-shared', decal({ center: [0.1, 0, 0.5], mirror: true }));
    const mirroredFree = image('l-free', decal({ center: [0.2, 0, 0.5], mirror: true }));
    const unmirroredShared = image('l-plain', decal({ center: [0.3, 0, 0.5] }));
    // No Base: checkLayers adds one (repaired).
    const doc = project([mirroredShared, mirroredFree, unmirroredShared]);
    const s = stub(doc);
    s.engine.shared.add(JSON.stringify([0.1, 0, 0.5]));
    s.engine.shared.add(JSON.stringify([0.3, 0, 0.5]));
    const out = (await runJob({ command: 'put', project: doc }, s.deps)) as PutResult;

    expect(out.sharedTexels).toEqual(['l-shared']);
    expect(out.repaired).toBe(true);
    const save = s.calls.find((c) => c.cmd === 'atelier_project_save')!;
    const saved = (save.args as { project: AtelierProject }).project;
    const kinds = (saved.layers as Layer[]).map((l) => l.kind);
    expect(kinds).toEqual(['base', 'image', 'image', 'image']);
    expect(out.project.updatedAt).toBe('2026-02-02T00:00:00Z');
    // Never fetched: put works on the given document.
    expect(s.calls.some((c) => c.cmd === 'atelier_project_get')).toBe(false);
    const thumb = s.raw.find((r) => r.cmd === 'atelier_project_thumb')!;
    expect(thumb.headers).toEqual({ 'x-project-id': 'p1' });
    expect(s.engine.scene.thumbnailPng).toHaveBeenCalledWith(512);
  });

  it('still answers when the thumbnail fails', async () => {
    const s = stub();
    s.engine.scene.thumbnailPng.mockRejectedValueOnce(new Error('no 2D'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = (await runJob({ command: 'put', project: project() }, s.deps)) as PutResult;
    expect(out.sharedTexels).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('runJob: vehicleInfo', () => {
  let s: Stub;
  beforeEach(() => {
    s = stub();
  });

  it('summarises the mock model without an engine', async () => {
    const out = (await runJob({ command: 'vehicleInfo', vehicle: VEHICLE }, s.deps)) as VehicleInfo;
    expect(s.inputs).toHaveLength(0);
    expect(out.vehicle).toBe(VEHICLE);
    expect(out.slots.map((x) => [x.texture, x.body])).toEqual([
      [`${VEHICLE}_body_c`, true],
      [`${VEHICLE}_turret_c`, false],
      [`${VEHICLE}_gun_c`, false],
    ]);
    const hull = out.parts.find((p) => p.group === 'hull')!;
    // The mock hull: a cube of half-size 0.5 round the origin.
    expect(hull.bounds).toEqual({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
    expect(hull.slot).toBe(`${VEHICLE}_body_c`);
    expect(hull.triangles).toBeGreaterThan(0);
    // The gun box reaches x = 1.1.
    expect(out.bounds.max[0]).toBeCloseTo(1.1);
    expect(out.bounds.min).toEqual([-0.5, -0.5, -0.5]);
    for (let c = 0; c < 3; c++) expect(out.center[c]).toBeCloseTo((out.bounds.min[c]! + out.bounds.max[c]!) / 2);
    expect(out.radius).toBeGreaterThan(0.8);
  });
});

describe('runJob: errors', () => {
  it('disposes the engine when loading the pictures fails', async () => {
    const s = stub();
    s.engine.baker.whenReady.mockRejectedValueOnce(new Error('lost'));
    await expect(runJob({ command: 'render', id: 'p1', views: [{ kind: 'quick', name: 'top' }], size: 256, grid: false, flat: false }, s.deps)).rejects.toThrow('lost');
    expect(s.engine.dispose).toHaveBeenCalledOnce();
  });
});

describe('runJob: pictures that cannot be loaded', () => {
  const merged = (id: string, assetId: string) => ({
    id,
    kind: 'merged',
    name: '',
    visible: true,
    decal: decal({ center: [0.4, 0, 0.5] }),
    opacity: 1,
    children: [{ id: `${id}-piece`, kind: 'image', name: '', visible: true, assetId, opacity: 1, flipX: false, place: { x: 0, y: 0, w: 1, h: 1, angle: 0 } }],
  });
  const layers = () => [{ ...image('l-ok', decal()), assetId: 'fine' }, { ...image('l-gone', decal({ center: [0.2, 0, 0.5] })), assetId: 'gone' }, merged('l-merged', 'gone')];
  const renderJob: CliJob = { command: 'render', id: 'p1', views: [{ kind: 'quick', name: 'front' }], size: 256, grid: false, flat: false };

  it('render refuses with notFound naming each layer and piece whose picture failed', async () => {
    const s = stub(project(layers()));
    s.engine.pictures.push('fine', 'gone');
    const err = await runJob(renderJob, s.deps).then(
      () => null,
      (e: unknown) => e as { code: string; message: string; detail: string },
    );
    expect(err).toMatchObject({ code: 'notFound', message: "A layer's picture can't be loaded" });
    expect(JSON.parse(err!.detail)).toEqual([
      { layer: 'l-gone', assetId: 'gone' },
      { layer: 'l-merged-piece', assetId: 'gone' },
    ]);
    expect(s.calls.filter((c) => c.cmd === 'atelier_asset').map((c) => (c.args as { assetId: string }).assetId)).toEqual(['fine', 'gone']);
    expect(s.raw.some((r) => r.cmd === 'cli_file')).toBe(false);
    expect(s.engine.dispose).toHaveBeenCalledOnce();
  });

  it('render goes on when every picture loads', async () => {
    const s = stub(project([{ ...image('l-ok', decal()), assetId: 'fine' }]));
    s.engine.pictures.push('fine');
    const out = (await runJob(renderJob, s.deps)) as RenderResult;
    expect(out.views).toHaveLength(1);
  });

  it('put still saves and lists the missing pictures', async () => {
    const doc = project(layers());
    const s = stub(doc);
    s.engine.pictures.push('fine', 'gone');
    const out = (await runJob({ command: 'put', project: doc }, s.deps)) as PutResult;
    expect(out.missingPictures).toEqual([
      { layer: 'l-gone', assetId: 'gone' },
      { layer: 'l-merged-piece', assetId: 'gone' },
    ]);
    expect(s.calls.some((c) => c.cmd === 'atelier_project_save')).toBe(true);
  });
});

describe('runJob: review fixes', () => {
  it('put treats a failing shared-texel check as not shared and still saves', async () => {
    const doc = project([image('l-m', decal({ mirror: true }))]);
    const s = stub(doc);
    s.engine.baker.decalTouchesSharedTexels.mockRejectedValueOnce(new Error('no overlap map'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = (await runJob({ command: 'put', project: doc }, s.deps)) as PutResult;
    expect(out.sharedTexels).toEqual([]);
    expect(out.missingPictures).toEqual([]);
    expect(s.calls.some((c) => c.cmd === 'atelier_project_save')).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('render refuses two views with the same name before loading anything', async () => {
    const s = stub();
    const job: CliJob = {
      command: 'render',
      id: 'p1',
      views: [
        { kind: 'orbit', theta: 0.501, phi: 1, zoom: 1 },
        { kind: 'orbit', theta: 0.499, phi: 1, zoom: 1 },
      ],
      size: 256,
      grid: false,
      flat: false,
    };
    await expect(runJob(job, s.deps)).rejects.toMatchObject({ code: 'invalidInput', message: 'Two views have the same name', detail: 'orbit_0.50_1.00_1.00' });
    expect(s.calls).toHaveLength(0);
    expect(s.inputs).toHaveLength(0);
  });
});
