import { describe, expect, it, vi } from 'vitest';
import type { Layer } from '@/atelier/project';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import type { Engine } from '@/screens/Atelier/engine';
import type { AtelierProject } from '@/types';
import { applyProject } from './apply';
import type { RunnerDeps, Workspace } from './runner';

const SLOTS = ['v_body_c', 'v_turret_c'];
const LAYERS = [{ id: 'l-img', kind: 'image', name: '', visible: true, assetId: 'a1', decal: null, opacity: 1, flipX: false }] as unknown as Layer[];

function setup(opts: { highQuality?: boolean; downscaled?: string[] } = {}) {
  const log: string[] = [];
  const engine = {
    scene: {
      contextLost: () => false,
      thumbnailPng: vi.fn(async () => {
        log.push('thumbnailPng');
        return new Uint8Array([1]);
      }),
    },
    baker: {
      setLayers: vi.fn(() => log.push('setLayers')),
      whenReady: vi.fn(async () => {
        log.push('whenReady');
      }),
      prepareExport: vi.fn(async (hq: boolean) => {
        log.push(`prepareExport:${hq}`);
      }),
      bakeForExport: vi.fn((slot: string, hq: boolean) => {
        log.push(`bake:${slot}:${hq}`);
        return { rgba: new Uint8Array(16), w: 2, h: 2, downscaled: opts.downscaled?.includes(slot) ?? false };
      }),
      endExport: vi.fn(() => log.push('endExport')),
      upgrade: vi.fn(),
    },
    dispose: vi.fn(),
  };
  const w: Workspace = {
    project: { id: 'p1', output: { highQuality: opts.highQuality ?? false } } as AtelierProject,
    model: {} as VehicleModelData,
    engine: engine as unknown as Engine,
    layers: LAYERS,
    slots: SLOTS,
    repaired: false,
    failedAssets: new Set(),
  };
  const call = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    log.push(cmd);
    if (cmd === 'atelier_apply_begin') return { applyId: 'ap1' };
    if (cmd === 'atelier_apply_commit') return { skin: { id: 's1' }, backupId: 'b1' };
    if (cmd === 'atelier_apply_cancel') return null;
    throw new Error(`unexpected ${cmd} ${JSON.stringify(args)}`);
  });
  const callRaw = vi.fn(async (cmd: string, _body: Uint8Array, headers: Record<string, string>): Promise<unknown> => {
    log.push(cmd === 'atelier_apply_texture' ? `texture:${headers['x-slot']}` : cmd);
    return null;
  });
  const deps = { call: call as unknown as RunnerDeps['call'], callRaw: callRaw as unknown as RunnerDeps['callRaw'] };
  return { w, engine, deps, log, call, callRaw };
}

describe('applyProject', () => {
  it('runs the editor sequence: begin, layers, pictures, per slot bake + texture, thumbnail, commit', async () => {
    const s = setup({ highQuality: true });
    const out = await applyProject(s.w, s.deps);
    expect(s.log).toEqual([
      'atelier_apply_begin',
      'setLayers',
      'whenReady',
      'prepareExport:true',
      'setLayers',
      'bake:v_body_c:true',
      'texture:v_body_c',
      'setLayers',
      'bake:v_turret_c:true',
      'texture:v_turret_c',
      'thumbnailPng',
      'atelier_project_thumb',
      'atelier_apply_commit',
      'endExport',
    ]);
    expect(s.call).toHaveBeenCalledWith('atelier_apply_begin', { projectId: 'p1', enabled: SLOTS });
    expect(s.callRaw).toHaveBeenCalledWith('atelier_apply_texture', expect.any(Uint8Array), {
      'x-apply-id': 'ap1',
      'x-slot': 'v_body_c',
      'x-width': '2',
      'x-height': '2',
    });
    expect(s.call).toHaveBeenCalledWith('atelier_apply_commit', { applyId: 'ap1' });
    expect(out).toEqual({ skin: { id: 's1' }, backupId: 'b1', downscaled: false });
  });

  it('reports downscaled when any slot was baked smaller', async () => {
    const s = setup({ downscaled: ['v_turret_c'] });
    expect((await applyProject(s.w, s.deps)).downscaled).toBe(true);
  });

  it('cancels, rethrows and ends the export when the second texture fails', async () => {
    const s = setup();
    s.callRaw.mockImplementation(async (cmd: string, _b: Uint8Array, headers: Record<string, string>) => {
      if (headers['x-slot'] === 'v_turret_c') throw { code: 'invalidInput', message: 'A painted texture has the wrong size' };
      s.log.push(cmd);
      return null;
    });
    await expect(applyProject(s.w, s.deps)).rejects.toMatchObject({ code: 'invalidInput' });
    expect(s.call).toHaveBeenCalledWith('atelier_apply_cancel', { applyId: 'ap1' });
    expect(s.log).not.toContain('atelier_apply_commit');
    expect(s.engine.baker.endExport).toHaveBeenCalledOnce();
  });

  it('does not cancel once the commit was sent', async () => {
    const s = setup();
    s.call.mockImplementation(async (cmd: string) => {
      s.log.push(cmd);
      if (cmd === 'atelier_apply_begin') return { applyId: 'ap1' };
      if (cmd === 'atelier_apply_commit') throw { code: 'io', message: "The skin couldn't be applied to the game" };
      return null;
    });
    await expect(applyProject(s.w, s.deps)).rejects.toMatchObject({ code: 'io' });
    expect(s.log).not.toContain('atelier_apply_cancel');
    expect(s.engine.baker.endExport).toHaveBeenCalledOnce();
  });

  it('ends the export and cancels when prepareExport itself fails', async () => {
    const s = setup();
    s.engine.baker.prepareExport.mockRejectedValueOnce(new Error('lost'));
    await expect(applyProject(s.w, s.deps)).rejects.toThrow('lost');
    expect(s.engine.baker.endExport).toHaveBeenCalledOnce();
    expect(s.log).toContain('atelier_apply_cancel');
  });

  it('a picture that cannot be loaded fails the apply with notFound and cancels it, before any bake', async () => {
    const s = setup();
    s.w.failedAssets.add('a1');
    await expect(applyProject(s.w, s.deps)).rejects.toMatchObject({
      code: 'notFound',
      detail: JSON.stringify([{ layer: 'l-img', assetId: 'a1' }]),
    });
    expect(s.log).toContain('atelier_apply_cancel');
    expect(s.engine.baker.bakeForExport).not.toHaveBeenCalled();
    expect(s.engine.baker.endExport).not.toHaveBeenCalled();
  });

  it('a picture whose full-size copy fails in prepareExport fails the apply too', async () => {
    const s = setup();
    s.engine.baker.prepareExport.mockImplementationOnce(async () => {
      s.w.failedAssets.add('a1');
    });
    await expect(applyProject(s.w, s.deps)).rejects.toMatchObject({ code: 'notFound' });
    expect(s.log).toContain('atelier_apply_cancel');
    expect(s.engine.baker.bakeForExport).not.toHaveBeenCalled();
    expect(s.engine.baker.endExport).toHaveBeenCalledOnce();
  });

  it('a failing thumbnail only warns', async () => {
    const s = setup();
    s.engine.scene.thumbnailPng.mockRejectedValueOnce(new Error('no 2D'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(applyProject(s.w, s.deps)).resolves.toMatchObject({ skin: { id: 's1' } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
