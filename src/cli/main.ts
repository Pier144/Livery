import type { TemplateImage } from '@/atelier/gl/baker';
import { encodePng } from '@/atelier/gl/scene';
import { parseModelBuffer } from '@/atelier/modelBuffer';
import { checkLayers } from '@/atelier/projectCheck';
import { call, callRaw, toAppError } from '@/lib/tauri';
import { fetchAsset, toArrayBuffer } from '@/queries/atelier';
import { createEngine } from '@/screens/Atelier/engine';
import { enabledSlots } from '@/screens/Atelier/editorModel';
import type { AtelierProject } from '@/types';
import type { CliError, CliJob } from './job';

/**
 * The agent CLI's hidden page (`cli.html`): asks Rust for the job, runs it with the editor's own
 * scene and Baker, and answers with `cli_finish`. No UI.
 *
 * SPIKE (Task 5): only a minimal `render` (front view, one PNG) to prove WebGL works in the hidden
 * window; `runner.ts` replaces this (Task 8).
 */

function isCliError(e: unknown): e is CliError {
  return typeof e === 'object' && e !== null && typeof (e as CliError).code === 'string' && typeof (e as CliError).message === 'string';
}

/** Milliseconds until `start`'s callback runs, or `null` when it hasn't after 3 s. */
function waitMs(start: (done: () => void) => void): Promise<number | null> {
  const t = performance.now();
  return new Promise((resolve) => {
    const giveUp = setTimeout(() => resolve(null), 3000);
    start(() => {
      clearTimeout(giveUp);
      resolve(Math.round(performance.now() - t));
    });
  });
}

async function spikeRender(job: Extract<CliJob, { command: 'render' }>): Promise<unknown> {
  const t0 = performance.now();
  const project = await call<AtelierProject>('atelier_project_get', { id: job.id });
  const model = parseModelBuffer(toArrayBuffer(await call<unknown>('atelier_model', { vehicle: project.vehicle })));
  const templates = new Map<string, TemplateImage>();
  for (const slot of model.header.slots) {
    try {
      const rgba = new Uint8Array(toArrayBuffer(await call<unknown>('atelier_template_texture', { vehicle: project.vehicle, slot: slot.texture })));
      if (rgba.length === slot.width * slot.height * 4) templates.set(slot.texture, { rgba, w: slot.width, h: slot.height });
    } catch {
      // As the editor: that part shows plain grey under the paint.
    }
  }
  const tLoad = performance.now();
  const engine = createEngine({
    canvas: document.createElement('canvas'),
    model,
    templates,
    loadAsset: async (assetId) => {
      const picture = await fetchAsset(project.id, assetId);
      return { rgba: picture.rgba, w: picture.width, h: picture.height };
    },
  });
  try {
    const tEngine = performance.now();
    engine.baker.setLayers(checkLayers(project.layers).layers, enabledSlots(project, model));
    await engine.baker.whenReady();
    engine.baker.upgrade();
    const tReady = performance.now();
    const size = job.size;
    const pixels = engine.scene.renderPixels(engine.scene.quickOrbit('front'), size);
    let painted = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) painted++;
    const png = await encodePng(pixels, size, size);
    await callRaw('cli_file', png, { 'x-name': 'spike.png' });
    const tDone = performance.now();
    const ms = (a: number, b: number) => Math.round(b - a);
    // Whether a hidden page still runs timers and animation frames (the Baker's upgrade timer,
    // the scene's requestRender): how long a 300 ms timeout and one frame really take.
    const timer = await waitMs((done) => setTimeout(done, 300));
    const frame = await waitMs((done) => requestAnimationFrame(() => done()));
    return {
      views: [{ view: 'front', file: 'spike.png', width: size, height: size }],
      flat: [],
      spike: {
        paintedPixels: painted,
        timeout300: timer,
        animationFrame: frame,
        ms: { load: ms(t0, tLoad), engine: ms(tLoad, tEngine), ready: ms(tEngine, tReady), render: ms(tReady, tDone), total: ms(t0, tDone) },
      },
    };
  } finally {
    engine.dispose();
  }
}

async function main(): Promise<void> {
  try {
    const job = await call<CliJob>('cli_job');
    if (job.command !== 'render') throw { code: 'unsupported', message: `"${job.command}" is not in the agent CLI yet` } satisfies CliError;
    const ok = await spikeRender(job);
    await call('cli_finish', { ok, error: null });
  } catch (e) {
    const err = isCliError(e) ? e : toAppError(e);
    await call('cli_finish', { ok: null, error: { code: err.code, message: err.message, detail: err.detail ?? null } });
  }
}

void main();
