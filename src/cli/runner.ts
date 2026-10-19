import { isBodySlot, type TemplateImage } from '@/atelier/gl/baker';
import type { DecalImage } from '@/atelier/gl/decalTextures';
import { encodePng } from '@/atelier/gl/scene';
import { frameFromHit } from '@/atelier/decal';
import { allLayers, framedLayers } from '@/atelier/layerTree';
import { envelopeOf } from '@/atelier/merge';
import { parseModelBuffer, type VehicleModelData } from '@/atelier/modelBuffer';
import type { Layer } from '@/atelier/project';
import { checkLayers, serializeLayers } from '@/atelier/projectCheck';
import type { call, callRaw } from '@/lib/tauri';
import { ATELIER_CMD, parseAssetBuffer, toArrayBuffer } from '@/queries/atelier';
import type { Engine, EngineFactory } from '@/screens/Atelier/engine';
import { enabledSlots } from '@/screens/Atelier/editorModel';
import type { AtelierProject } from '@/types';
import { drawGrid } from './grid';
import {
  atToNdc,
  checkViewNames,
  viewName,
  viewOrbit,
  type Bounds,
  type CliError,
  type CliJob,
  type MissingPicture,
  type PlaceResult,
  type PutResult,
  type RenderResult,
  type VehicleInfo,
} from './job';

/**
 * Runs the agent CLI's GPU jobs in the hidden page (`cli.html`) with the editor's own scene and
 * Baker: `put`, `vehicleInfo`, `place` and `render` (`apply` is Task 9's `apply.ts`). Everything
 * the page talks to comes in `deps`, so Vitest runs it with stubs and no WebGL.
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

const noHit = (): CliError => ({ code: 'noHit', message: 'Nothing of the vehicle at that point' });

async function loadModel(vehicle: string, deps: Pick<RunnerDeps, 'call'>): Promise<VehicleModelData> {
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

/** Stores the project's thumbnail as the editor makes it; a failure only warns (as in the editor). */
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

/** Runs `job` and resolves with the `ok` JSON; rejects with an `AppError` or a `CliError`. */
export async function runJob(job: CliJob, deps: RunnerDeps): Promise<unknown> {
  switch (job.command) {
    case 'vehicleInfo':
      return vehicleInfo(await loadModel(job.vehicle, deps));
    case 'put':
      return withWorkspace(job.project, deps, (w) => put(w, deps));
    case 'place':
      return withWorkspace(job.id, deps, async (w) => place(w, job));
    case 'render':
      checkViewNames(job.views);
      return withWorkspace(job.id, deps, (w) => render(w, job, deps));
    case 'apply':
      throw { code: 'unsupported', message: '"apply" is not in the agent CLI yet' } satisfies CliError;
  }
}

async function withWorkspace<T>(source: string | AtelierProject, deps: RunnerDeps, run: (w: Workspace) => Promise<T>): Promise<T> {
  const w = await loadWorkspace(source, deps);
  try {
    return await run(w);
  } finally {
    w.engine.dispose();
  }
}

// ── vehicle-info ────────────────────────────────────────────────────────────

/** The model summary from the parsed buffer alone (no engine). */
export function vehicleInfo(model: VehicleModelData): VehicleInfo {
  const { header, positions } = model;
  const vertices = positions.length / 3;
  const boxOf = (from: number, count: number): Bounds | null => {
    const end = Math.min(from + count, vertices);
    if (end <= from) return null;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = from; i < end; i++) {
      for (let c = 0; c < 3; c++) {
        const v = positions[i * 3 + c]!;
        if (v < min[c]!) min[c] = v;
        if (v > max[c]!) max[c] = v;
      }
    }
    return { min, max };
  };
  const bounds = boxOf(0, vertices) ?? { min: [0, 0, 0], max: [0, 0, 0] };
  // As three's computeBoundingSphere (what the editor frames with): the box's centre, the farthest vertex.
  const center: [number, number, number] = [0, 1, 2].map((c) => (bounds.min[c]! + bounds.max[c]!) / 2) as [number, number, number];
  let r2 = 0;
  for (let i = 0; i < vertices; i++) {
    const dx = positions[i * 3]! - center[0];
    const dy = positions[i * 3 + 1]! - center[1];
    const dz = positions[i * 3 + 2]! - center[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return {
    vehicle: header.vehicle,
    model: header.model,
    mirrorAxis: header.mirrorAxis,
    slots: header.slots.map((s) => ({ ...s, body: isBodySlot(s.texture) })),
    parts: header.parts.map((p) => ({
      node: p.node,
      group: p.group,
      slot: header.slots[p.slot]?.texture ?? '',
      triangles: p.indexCount / 3,
      bounds: boxOf(p.vertexOffset, p.vertexCount),
    })),
    bounds,
    center,
    radius: Math.sqrt(r2),
  };
}

// ── project put ─────────────────────────────────────────────────────────────

async function put(w: Workspace, deps: RunnerDeps): Promise<PutResult> {
  // As the editor's checkShared: every framed layer with Mirror on, every repeat copy (the envelope).
  const sharedTexels: string[] = [];
  for (const layer of framedLayers(w.layers)) {
    if (!layer.decal?.mirror) continue;
    try {
      if (await w.engine.baker.decalTouchesSharedTexels(envelopeOf(layer.decal, layer.repeat))) sharedTexels.push(layer.id);
    } catch (e) {
      // As the editor: a failed check counts as not shared, the save still happens.
      console.warn('Atelier CLI: shared-texel check failed', layer.id, e);
    }
  }
  // As the editor store saves: unsupported layers and pieces go back as they came.
  const saved = await deps.call<AtelierProject>('atelier_project_save', { project: { ...w.project, layers: serializeLayers(w.layers) } });
  await sendThumb({ ...w, project: saved }, deps);
  return { project: saved, missingPictures: missingPictures(w), repaired: w.repaired, sharedTexels };
}

// ── place ───────────────────────────────────────────────────────────────────

function place(w: Workspace, job: Extract<CliJob, { command: 'place' }>): PlaceResult {
  const scene = w.engine.scene;
  const [x, y] = atToNdc(job.at);
  const { hit, cameraMatrixWorld } = scene.raycastView(viewOrbit(job.view, scene), x, y, job.part);
  if (!hit) throw noHit();
  // As a click in the editor: frameFromHit clamps the size and picks the default depth.
  const decal = frameFromHit(hit.point, hit.normal, cameraMatrixWorld, { width: job.width ?? 1, height: job.height ?? 1, depth: job.depth ?? undefined }, job.part ?? 'all');
  if (!decal) throw noHit();
  return { decal, group: hit.group, node: hit.node };
}

// ── render ──────────────────────────────────────────────────────────────────

async function render(w: Workspace, job: Extract<CliJob, { command: 'render' }>, deps: RunnerDeps): Promise<RenderResult> {
  const { scene, baker } = w.engine;
  const size = job.size;
  requirePictures(w);
  // The full-size paint before the pictures (otherwise the body shows the 1024 px preview).
  baker.upgrade();
  const views: RenderResult['views'] = [];
  for (const v of job.views) {
    const px = scene.renderPixels(viewOrbit(v, scene), size);
    if (job.grid) drawGrid(px, size);
    const file = `${viewName(v)}.png`;
    await deps.callRaw('cli_file', await encodePng(px, size, size), { 'x-name': file });
    views.push({ view: viewName(v), file, width: size, height: size });
  }
  const flat: RenderResult['flat'] = [];
  if (job.flat && w.slots.length > 0) {
    try {
      // bakeForExport needs the full-size decal pictures that prepareExport loads; a failing
      // prepareExport still gets its endExport (as useApply).
      await baker.prepareExport(false);
      // The full-size copies load again: a picture can fail here too.
      requirePictures(w);
      for (const slot of w.slots) {
        const r = baker.bakeForExport(slot, false);
        const file = `flat_${slot.replace(/[^A-Za-z0-9._-]/g, '_')}.png`;
        await deps.callRaw('cli_file', await encodePng(new Uint8ClampedArray(r.rgba), r.w, r.h), { 'x-name': file });
        flat.push({ slot, file, width: r.w, height: r.h });
      }
    } finally {
      baker.endExport();
    }
  }
  return { views, flat };
}
