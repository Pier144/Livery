import type { ApplyResult, ApplyStarted } from '@/types';
import { requirePictures, sendThumb, type RunnerDeps, type Workspace } from './workspace';

/** `apply`'s answer: the installed skin (and the backup after a replace), plus whether a slot was baked smaller. */
export type CliApplyResult = ApplyResult & {
  /** The GPU couldn't render a slot at its size: it was baked at 2048 instead. */
  downscaled: boolean;
};

/**
 * The CLI's Apply to game: the same calls in the same order as the editor's
 * `src/screens/Atelier/useApply.ts` (keep the two in step): begin → layers → pictures at full
 * size → per slot bake + texture → thumbnail → commit; cancel on any error before the commit.
 * The project is the stored one (the editor saves first; the CLI's `project put` already did).
 * A picture that can't be loaded fails the apply instead of leaving its layer out.
 */
export async function applyProject(w: Workspace, deps: Pick<RunnerDeps, 'call' | 'callRaw'>): Promise<CliApplyResult> {
  const { project, engine, layers, slots } = w;
  const highQuality = project.output.highQuality;
  // loadWorkspace already waited for the pictures: a missing one fails before anything starts.
  requirePictures(w);
  const { applyId } = await deps.call<ApplyStarted>('atelier_apply_begin', { projectId: project.id, enabled: slots });
  let committing = false;
  let exporting = false;
  try {
    engine.baker.setLayers(layers, slots);
    await engine.baker.whenReady();
    // Before the call: a failing prepareExport still gets its endExport (as useApply).
    exporting = true;
    await engine.baker.prepareExport(highQuality);
    // The full-size copies load again: a picture can fail here too.
    requirePictures(w);
    let downscaled = false;
    for (const slot of slots) {
      engine.baker.setLayers(layers, slots);
      const r = engine.baker.bakeForExport(slot, highQuality);
      downscaled ||= r.downscaled;
      await deps.callRaw<null>('atelier_apply_texture', r.rgba, {
        'x-apply-id': applyId,
        'x-slot': slot,
        'x-width': String(r.w),
        'x-height': String(r.h),
      });
    }
    // Rust copies the thumbnail into the skin as preview.png; a failure only warns. No whenReady
    // first: prepareExport already waited for these same layers' pictures.
    await sendThumb(w, deps);
    committing = true;
    const result = await deps.call<ApplyResult>('atelier_apply_commit', { applyId });
    return { ...result, downscaled };
  } catch (e) {
    if (!committing) await deps.call('atelier_apply_cancel', { applyId }).catch(() => {});
    throw e;
  } finally {
    if (exporting) engine.baker.endExport();
  }
}
