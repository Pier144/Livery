import { createContext } from 'react';
import * as THREE from 'three';
import { Baker, type TemplateImage } from '@/atelier/gl/baker';
import { EditorScene, type OrbitState, type QuickView, type SceneHit } from '@/atelier/gl/scene';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import type { Vec3 } from '@/atelier/project';

/**
 * The editor's GPU side: the 3D view and the Baker on one WebGL renderer. The viewport creates it
 * through `EngineContext`, so tests can inject a stub without WebGL.
 */

/** What the editor uses of the 3D view (`EditorScene`). */
export interface EngineScene {
  readonly boundingRadius: number;
  requestRender(): void;
  quickView(view: QuickView): void;
  orbitBy(dx: number, dy: number): void;
  panBy(dx: number, dy: number): void;
  zoomBy(deltaY: number): void;
  viewDirection(): Vec3;
  pixelRadius(radius: number, distance: number): number;
  raycast(x: number, y: number): SceneHit | null;
  thumbnailPng(size?: number): Promise<Uint8Array>;
  view(): OrbitState;
  setView(view: OrbitState): void;
  contextLost(): boolean;
}

/** What the editor uses of the Baker. */
export type EngineBaker = Pick<Baker, 'setLayers' | 'setShowTemplate' | 'stampStroke' | 'bakeForExport' | 'upgrade'>;

export interface Engine {
  scene: EngineScene;
  baker: EngineBaker;
  dispose(): void;
}

export interface EngineInput {
  canvas: HTMLCanvasElement;
  model: VehicleModelData;
  templates: Map<string, TemplateImage>;
}

export type EngineFactory = (input: EngineInput) => Engine;

/** The real engine: a WebGL 2 renderer shared by the scene and the Baker. Throws when WebGL fails. */
export const createEngine: EngineFactory = ({ canvas, model, templates }) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  let scene: EditorScene | null = null;
  let baker: Baker | null = null;
  try {
    scene = new EditorScene(renderer, canvas);
    const view = scene;
    baker = new Baker(renderer, model, templates, { onUpdate: () => view.requestRender() });
    const bake = baker;
    scene.setModel(model, (slot) => bake.previewMaterial(model.header.slots[slot]!.texture));
  } catch (e) {
    baker?.dispose();
    scene?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    throw e;
  }
  const s = scene;
  const b = baker;
  return {
    scene: s,
    baker: b,
    dispose: () => {
      b.dispose();
      s.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
};

export const EngineContext = createContext<EngineFactory>(createEngine);
