import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import type { VehicleModelData } from '@/atelier/modelBuffer';
import { errorText } from '@/lib/errors';
import { listenEvent } from '@/lib/events';
import { call, callRaw, toAppError } from '@/lib/tauri';
import { atelierProjectKey } from '@/queries/atelier';
import { HANGAR_KEY } from '@/queries/hangar';
import { undoReplace } from '@/queries/queue';
import { toast } from '@/store/toasts';
import { EVENTS, type ApplyProgress, type ApplyResult, type ApplyStarted, type AtelierProject } from '@/types';
import { applyPercent, enabledSlots, slotLabel } from './editorModel';
import type { Engine } from './engine';

export type ApplyStepShown = 'save' | 'bake' | 'encode' | 'write' | 'install';

export type ApplyState = { running: false } | { running: true; step: ApplyStepShown; pct: number; part?: string };

interface Job {
  applyId?: string;
  /** The user left the editor: stop quietly (the apply is cancelled). */
  aborted: boolean;
  /** `atelier_apply_commit` was sent: from here the apply finishes even if the user leaves. */
  committing: boolean;
}

/** Lets the progress render before a slot's bake blocks the main thread. */
const yieldToPaint = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

interface UseApplyArgs {
  projectId: string;
  model: VehicleModelData | undefined;
  engine: () => Engine | null;
  /** Saves pending edits; false when something isn't saved. */
  flush: () => Promise<boolean>;
  /** After a successful apply, with the engine still alive (thumbnail). */
  onApplied?: (engine: Engine) => void;
}

/**
 * Apply to game (spec §3): save first, `atelier_apply_begin`, then per enabled slot the GPU bake
 * and `atelier_apply_texture` (raw RGBA), then `atelier_apply_commit`. Progress: the bake fills
 * 0 to 50 %, Rust's encode / write / install events (`atelier://apply-progress`) the rest. Any error
 * cancels the apply (`atelier_apply_cancel`) and toasts it; leaving the editor before the commit
 * cancels it too. After the commit the project records the installed skin at once.
 */
export function useApply({ projectId, model, engine, flush, onApplied }: UseApplyArgs) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [state, setState] = useState<ApplyState>({ running: false });
  const job = useRef<Job | null>(null);
  const mounted = useRef(true);
  const latest = useRef({ engine, flush, onApplied, model, t });
  latest.current = { engine, flush, onApplied, model, t };

  const show = useCallback((s: ApplyState) => {
    if (mounted.current) setState(s);
  }, []);

  const start = useCallback(async () => {
    if (job.current) return;
    const current: Job = { aborted: false, committing: false };
    job.current = current;
    const { t } = latest.current;
    let unlisten: (() => void) | undefined;
    let baked = 0;
    let slots: string[] = [];
    let rustPct = 0;
    let step: ApplyStepShown = 'save';
    let part: string | undefined;
    const progress = () => show({ running: true, step, pct: applyPercent(baked, slots.length || 1, rustPct), part });
    show({ running: true, step: 'save', pct: 0 });
    try {
      if (!(await latest.current.flush())) {
        if (!current.aborted) toast(t('atelier.apply.saveFailed'));
        return;
      }
      const { model } = latest.current;
      const project = useAtelierEditor.getState().project;
      if (current.aborted || !model || !project || project.id !== projectId) return;
      slots = enabledSlots(project, model);
      const highQuality = project.output.highQuality;

      unlisten = await listenEvent<ApplyProgress>(EVENTS.atelierApplyProgress, (p) => {
        if (p.applyId !== current.applyId || current.aborted) return;
        if (p.step === 'encode' || p.step === 'write' || p.step === 'install') {
          rustPct = Math.max(rustPct, p.pct);
          // The bake label stays while slots are still being baked.
          if (baked >= slots.length) step = p.step;
          progress();
        }
      });

      const { applyId } = await call<ApplyStarted>('atelier_apply_begin', { projectId, enabled: slots });
      current.applyId = applyId;
      if (current.aborted) {
        // Left while the apply was starting: the leave couldn't name it yet.
        void call('atelier_apply_cancel', { applyId }).catch(() => {});
        return;
      }

      let downscaled = false;
      for (const slot of slots) {
        step = 'bake';
        part = slotLabel(slot, t);
        progress();
        await yieldToPaint();
        if (current.aborted) return;
        const engine = latest.current.engine();
        if (!engine) throw new Error('Atelier: the 3D view is gone');
        const result = engine.baker.bakeForExport(slot, highQuality);
        downscaled ||= result.downscaled;
        baked += 1;
        progress();
        await callRaw<null>('atelier_apply_texture', result.rgba, {
          'x-apply-id': applyId,
          'x-slot': slot,
          'x-width': String(result.w),
          'x-height': String(result.h),
        });
        if (current.aborted) return;
      }

      step = 'install';
      part = undefined;
      progress();
      current.committing = true;
      const { skin, backupId } = await call<ApplyResult>('atelier_apply_commit', { applyId });

      // The next autosave carries the installed skin (Rust stored it with the project too).
      const store = useAtelierEditor.getState();
      if (store.project?.id === projectId) store.setInstalledSkinId(skin.id);
      qc.setQueryData<AtelierProject>(atelierProjectKey(projectId), (p) => (p ? { ...p, installedSkinId: skin.id } : p));
      void qc.invalidateQueries({ queryKey: HANGAR_KEY });

      const reselect = t('atelier.apply.reselect');
      if (backupId) {
        toast.undoable(`${t('atelier.apply.replaced')} ${reselect}`, async () => {
          try {
            await undoReplace(skin.id, backupId);
            toast(t('atelier.apply.restored'));
          } catch (e) {
            toast(errorText(toAppError(e), t));
          } finally {
            void qc.invalidateQueries({ queryKey: HANGAR_KEY });
          }
        });
      } else {
        toast(`${t('atelier.apply.installed')} ${reselect}`);
      }
      if (downscaled) toast(t('atelier.apply.downscaled'));
      const engine = latest.current.engine();
      if (engine && !current.aborted) latest.current.onApplied?.(engine);
    } catch (e) {
      if (current.applyId && !current.committing) void call('atelier_apply_cancel', { applyId: current.applyId }).catch(() => {});
      if (!current.aborted || current.committing) toast(errorText(toAppError(e), t));
    } finally {
      unlisten?.();
      if (job.current === current) job.current = null;
      show({ running: false });
    }
  }, [projectId, qc, show]);

  // Leaving the editor (back, another screen) cancels an apply that hasn't reached its commit.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const running = job.current;
      if (!running || running.committing) return;
      running.aborted = true;
      if (running.applyId) void call('atelier_apply_cancel', { applyId: running.applyId }).catch(() => {});
      toast(latest.current.t('atelier.apply.cancelled'));
    };
  }, []);

  return { state, start };
}
