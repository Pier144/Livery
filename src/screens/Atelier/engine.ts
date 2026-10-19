import { createContext } from 'react';
import * as THREE from 'three';
import { useAtelierEditor } from '@/atelier/editorStore';
import { Baker, type TemplateImage } from '@/atelier/gl/baker';
import type { DecalImage } from '@/atelier/gl/decalTextures';
import { EditorScene, type OrbitState, type QuickView, type SceneHit } from '@/atelier/gl/scene';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import type { Vec3 } from '@/atelier/project';
import type { PartGroup } from '@/types';
import { toAppError } from '@/lib/tauri';
import { fetchAsset } from '@/queries/atelier';
import { noteAssetSize, setAssetMissing } from './decalUi';

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
  /** With `group`, only that part group's meshes are hit. */
  raycast(x: number, y: number, group?: PartGroup | null): SceneHit | null;
  thumbnailPng(size?: number): Promise<Uint8Array>;
  /** The model from `orbit`, square at `size` px: straight-alpha RGBA rows from the top (the CLI's pictures). */
  renderPixels(orbit: OrbitState, size: number): Uint8ClampedArray<ArrayBuffer>;
  /** `raycast` through a square picture taken from `orbit`, with the camera it used; normalised x right, y up. */
  raycastView(orbit: OrbitState, ndcX: number, ndcY: number, group?: PartGroup | null): { hit: SceneHit | null; cameraMatrixWorld: number[] };
  /** A quick view's orbit, framed for a square picture. */
  quickOrbit(view: QuickView): OrbitState;
  /** An orbit round the model's centre for a square picture (angles in radians, `zoom` in framing distances). */
  orbitFor(theta: number, phi: number, zoom: number): OrbitState;
  view(): OrbitState;
  setView(view: OrbitState): void;
  contextLost(): boolean;
  /** Overlays (the decal gizmo) follow the camera: called after every frame drawn. */
  onRender(listener: () => void): () => void;
  viewSize(): { width: number; height: number };
  cameraMatrixWorld(): ArrayLike<number>;
  project(p: Vec3): { x: number; y: number; behind: boolean };
}

/** What the editor uses of the Baker. */
export type EngineBaker = Pick<
  Baker,
  | 'setLayers'
  | 'setShowTemplate'
  | 'stampStroke'
  | 'bakeForExport'
  | 'upgrade'
  | 'whenReady'
  | 'prepareExport'
  | 'endExport'
  | 'decalTouchesSharedTexels'
  | 'truncated'
>;

export interface Engine {
  scene: EngineScene;
  baker: EngineBaker;
  dispose(): void;
}

export interface EngineInput {
  canvas: HTMLCanvasElement;
  model: VehicleModelData;
  templates: Map<string, TemplateImage>;
  /** Where the Baker reads a project's pictures from; the editor's own loader when omitted. */
  loadAsset?: (assetId: string) => Promise<DecalImage>;
}

export type EngineFactory = (input: EngineInput) => Engine;

/**
 * A picture of the open project (image layers), straight-alpha RGBA. The project is the one the
 * editor store holds when the Baker asks (the engine lives inside that project's editor). Its size
 * is remembered (Remove background needs it) and a picture that can't be read is flagged.
 */
export async function loadProjectAsset(assetId: string): Promise<DecalImage> {
  const projectId = useAtelierEditor.getState().project?.id;
  if (!projectId) throw new Error('Atelier: no open project for its pictures');
  try {
    const picture = await fetchAsset(projectId, assetId);
    noteAssetSize(assetId, picture.width, picture.height);
    setAssetMissing(assetId, false);
    return { rgba: picture.rgba, w: picture.width, h: picture.height };
  } catch (e) {
    // The layer shows a warning (Layers panel); the bake skips it.
    if (toAppError(e).code === 'notFound' || toAppError(e).code === 'invalidInput') setAssetMissing(assetId, true);
    throw e;
  }
}

/** The real engine: a WebGL 2 renderer shared by the scene and the Baker. Throws when WebGL fails. */
export const createEngine: EngineFactory = ({ canvas, model, templates, loadAsset }) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  let scene: EditorScene | null = null;
  let baker: Baker | null = null;
  try {
    scene = new EditorScene(renderer, canvas);
    const view = scene;
    baker = new Baker(renderer, model, templates, { onUpdate: () => view.requestRender(), loadAsset: loadAsset ?? loadProjectAsset });
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
