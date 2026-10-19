import { isBodySlot } from '@/atelier/gl/baker';
import { encodePng } from '@/atelier/gl/scene';
import { frameFromHit } from '@/atelier/decal';
import { framedLayers } from '@/atelier/layerTree';
import { envelopeOf } from '@/atelier/merge';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import { serializeLayers } from '@/atelier/projectCheck';
import type { AtelierProject } from '@/types';
import { applyProject } from './apply';
import { drawGrid } from './grid';
import {
  atToNdc,
  checkViewNames,
  viewName,
  viewOrbit,
  type Bounds,
  type CliError,
  type CliJob,
  type PlaceResult,
  type PutResult,
  type RenderResult,
  type VehicleInfo,
} from './job';
import { loadModel, missingPictures, requirePictures, sendThumb, withWorkspace, type RunnerDeps, type Workspace } from './workspace';

/**
 * Runs the agent CLI's GPU jobs in the hidden page (`cli.html`) with the editor's own scene and
 * Baker: `put`, `vehicleInfo`, `place`, `render` and `apply` (`apply.ts`). Everything
 * the page talks to comes in `deps`, so Vitest runs it with stubs and no WebGL.
 */

const noHit = (): CliError => ({ code: 'noHit', message: 'Nothing of the vehicle at that point' });

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
      return withWorkspace(job.id, deps, (w) => applyProject(w, deps));
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
