import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VehicleModelData } from '@/atelier/modelBuffer';

// No WebGL in jsdom: the renderer, the scene and the Baker are stand-ins that record how
// `createEngine` wires them together.
const baker = vi.hoisted(() => ({ options: [] as { loadAsset?: unknown }[] }));

vi.mock('three', async (importOriginal) => ({
  ...(await importOriginal<typeof import('three')>()),
  WebGLRenderer: class {
    dispose = vi.fn();
    forceContextLoss = vi.fn();
  },
}));
vi.mock('@/atelier/gl/baker', () => ({
  Baker: class {
    constructor(_renderer: unknown, _model: unknown, _templates: unknown, options: { loadAsset?: unknown }) {
      baker.options.push(options);
    }
    previewMaterial = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('@/atelier/gl/scene', () => ({
  EditorScene: class {
    setModel = vi.fn();
    dispose = vi.fn();
  },
}));

import { createEngine, loadProjectAsset } from './engine';

const model = { header: { slots: [] } } as unknown as VehicleModelData;

describe('createEngine', () => {
  beforeEach(() => {
    baker.options.length = 0;
  });

  it('gives the Baker the project loader unless the caller brings its own', () => {
    createEngine({ canvas: document.createElement('canvas'), model, templates: new Map() }).dispose();
    expect(baker.options[0]!.loadAsset).toBe(loadProjectAsset);
  });

  it('passes a given loadAsset to the Baker (the CLI loads pictures of a project the editor store does not hold)', () => {
    const loadAsset = vi.fn();
    createEngine({ canvas: document.createElement('canvas'), model, templates: new Map(), loadAsset }).dispose();
    expect(baker.options[0]!.loadAsset).toBe(loadAsset);
  });
});
