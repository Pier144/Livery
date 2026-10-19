import type { TemplateImage } from '@/atelier/gl/baker';
import type { DecalImage } from '@/atelier/gl/decalTextures';
import { allLayers } from '@/atelier/layerTree';
import { parseModelBuffer, type VehicleModelData } from '@/atelier/modelBuffer';
import type { Layer } from '@/atelier/project';
import { checkLayers } from '@/atelier/projectCheck';
import type { call, callRaw } from '@/lib/tauri';
import { ATELIER_CMD, parseAssetBuffer, toArrayBuffer } from '@/queries/atelier';
import type { Engine, EngineFactory } from '@/screens/Atelier/engine';
import { enabledSlots } from '@/screens/Atelier/editorModel';
import type { AtelierProject } from '@/types';
import type { CliError, MissingPicture } from './job';

/**
 * What the agent CLI's jobs share (`runner.ts`, `apply.ts`): the page's dependencies, a project
 * loaded and baked as the editor loads it, the missing-picture check and the thumbnail.
 */
export interface RunnerDeps {
  call: typeof call;
  callRaw: typeof callRaw;
  createEngine: EngineFactory;
  canvas: () => HTMLCanvasElement;
}

/** A project loaded as the editor loads it: its model, checked layers, painted slots and an engine baking them. */
export interface Workspace {
  project: AtelierProject;
  model: VehicleModelData;
  engine: Engine;
  layers: Layer[];
  slots: string[];
  /** `checkLayers` repaired something. */
  repaired: boolean;
  /** Assets whose picture the last load failed (the Baker then leaves their layers out silently). */
  failedAssets: Set<string>;
}

/** Side of the project thumbnail, as the editor's (`Editor.tsx` THUMB_SIZE). */
const THUMB_SIZE = 512;


export async function loadModel(vehicle: string, deps: Pick<RunnerDeps, 'call'>): Promise<VehicleModelData> {
  return parseModelBuffer(toArrayBuffer(await deps.call<unknown>('atelier_model', { vehicle })));
}

/** One template per slot, as `Editor.tsx`: a texture that fails or has the wrong size is left out (plain grey). */
async function loadTemplates(vehicle: string, model: VehicleModelData, deps: Pick<RunnerDeps, 'call'>): Promise<Map<string, TemplateImage>> {
  const templates = new Map<string, TemplateImage>();
  for (const slot of model.header.slots) {
    try {
      const rgba = new Uint8Array(toArrayBuffer(await deps.call<unknown>('atelier_template_texture', { vehicle, slot: slot.texture })));
      if (rgba.length === slot.width * slot.height * 4) templates.set(slot.texture, { rgba, w: slot.width, h: slot.height });
    } catch (e) {
      console.warn(`Atelier CLI: template ${slot.texture} not loaded`, e);
    }
  }
  return templates;
}

/**
 * Loads `project` (by id, or the given document for `put`) with its model and templates, builds
 * an engine on an offscreen canvas and bakes the checked layers; resolves once the decal pictures
 * are in. The caller disposes `engine`.
 */
export async function loadWorkspace(source: string | AtelierProject, deps: RunnerDeps): Promise<Workspace> {
  const project = typeof source === 'string' ? await deps.call<AtelierProject>('atelier_project_get', { id: source }) : source;
  const model = await loadModel(project.vehicle, deps);
  const templates = await loadTemplates(project.vehicle, model, deps);
  const { layers, repaired } = checkLayers(project.layers);
  const slots = enabledSlots(project, model);
  // The editor's loader without its UI flags; a failure is remembered (the editor flags the layer,
  // the CLI reports it: see `missingPictures`).
  const failedAssets = new Set<string>();
  const loadAsset = async (assetId: string): Promise<DecalImage> => {
    try {
      const picture = parseAssetBuffer(toArrayBuffer(await deps.call<unknown>(ATELIER_CMD.asset, { projectId: project.id, assetId })));
      failedAssets.delete(assetId);
      return { rgba: picture.rgba, w: picture.width, h: picture.height };
    } catch (e) {
      failedAssets.add(assetId);
      throw e;
    }
  };
  const engine = deps.createEngine({ canvas: deps.canvas(), model, templates, loadAsset });
  try {
    engine.baker.setLayers(layers, slots);
    await engine.baker.whenReady();
  } catch (e) {
    engine.dispose();
    throw e;
  }
  return { project, model, engine, layers, slots, repaired, failedAssets };
}

/** Image layers and image pieces of merged objects whose picture failed to load. */
export function missingPictures(w: Pick<Workspace, 'layers' | 'failedAssets'>): MissingPicture[] {
  if (w.failedAssets.size === 0) return [];
  const out: MissingPicture[] = [];
  for (const item of allLayers(w.layers)) {
    if (item.kind === 'image' && w.failedAssets.has(item.assetId)) out.push({ layer: item.id, assetId: item.assetId });
  }
  return out;
}

/** Refuses to make pictures or textures without every layer's picture (`render`, `apply`). */
export function requirePictures(w: Pick<Workspace, 'layers' | 'failedAssets'>): void {
  const missing = missingPictures(w);
  if (missing.length > 0) throw { code: 'notFound', message: "A layer's picture can't be loaded", detail: JSON.stringify(missing) } satisfies CliError;
}

/**
 * Stores the project's thumbnail as the editor makes it; a failure only warns (as in the editor).
 * Callers have already waited for the current layers' pictures (`loadWorkspace`, or `prepareExport` in apply).
 */
export async function sendThumb(w: Workspace, deps: Pick<RunnerDeps, 'callRaw'>): Promise<void> {
  try {
    if (w.engine.scene.contextLost()) return;
    w.engine.baker.upgrade();
    const png = await w.engine.scene.thumbnailPng(THUMB_SIZE);
    await deps.callRaw('atelier_project_thumb', png, { 'x-project-id': w.project.id });
  } catch (e) {
    console.warn('Atelier CLI: thumbnail not saved', e);
  }
}

export async function withWorkspace<T>(source: string | AtelierProject, deps: RunnerDeps, run: (w: Workspace) => Promise<T>): Promise<T> {
  const w = await loadWorkspace(source, deps);
  try {
    return await run(w);
  } finally {
    w.engine.dispose();
  }
}
