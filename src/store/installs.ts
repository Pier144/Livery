import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';
import i18n from '@/i18n';
import { listenEvent } from '@/lib/events';
import { toAppError } from '@/lib/tauri';
import { HANGAR_KEY, useHangar } from '@/queries/hangar';
import { installFromWtLive } from '@/queries/wtlive';
import { toast } from '@/store/toasts';
import {
  EVENTS,
  type ConflictPolicy,
  type HangarSkin,
  type InstallMode,
  type InstallProgress,
  type InstallStep,
  type WtLiveSkin,
} from '@/types';

/** A WT Live install in flight (or failed), keyed by WT Live skin id. */
export interface WtInstall {
  /** Empty until the backend answers (the card shows progress at once: optimistic UI). */
  installId: string;
  mode: InstallMode;
  step: InstallStep;
  pct: number;
  /** step 'error': what went wrong (backend message). */
  error?: string;
  /** step 'error': the AppError code, e.g. 'conflict' so the UI can offer a way out. */
  errorCode?: string;
}

interface InstallsState {
  bySkin: Record<string, WtInstall>;
  /** installId → skinId, to route `install://progress`. */
  byInstallId: Record<string, string>;
  start: (skinId: string, mode?: InstallMode, conflict?: ConflictPolicy) => Promise<void>;
  /** Returns the skin id the event belonged to (undefined: not a WT Live install). */
  apply: (event: InstallProgress) => string | undefined;
  /** Stops tracking a finished install, once the hangar shows it. */
  finish: (skinId: string) => void;
  clear: (skinId: string) => void;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export const useInstalls = create<InstallsState>()((set, get) => ({
  bySkin: {},
  byInstallId: {},
  start: async (skinId, mode = 'normal', conflict) => {
    const current = get().bySkin[skinId];
    if (current && current.step !== 'error') return;
    set((s) => ({ bySkin: { ...s.bySkin, [skinId]: { installId: '', mode, step: 'download', pct: 0 } } }));
    try {
      const { installId } = await installFromWtLive(skinId, mode, conflict);
      set((s) => ({
        byInstallId: { ...s.byInstallId, [installId]: skinId },
        bySkin: s.bySkin[skinId] ? { ...s.bySkin, [skinId]: { ...s.bySkin[skinId]!, installId } } : s.bySkin,
      }));
    } catch (e) {
      const error = toAppError(e);
      set((s) => ({ bySkin: { ...s.bySkin, [skinId]: { installId: '', mode, step: 'error', pct: 0, error: error.message, errorCode: error.code } } }));
    }
  },
  apply: (event) => {
    const skinId = get().byInstallId[event.installId];
    if (!skinId) return undefined;
    set((s) => {
      const prev = s.bySkin[skinId];
      if (!prev) return s;
      // 'done' stays tracked until the hangar refetch lands (see useWtLiveInstallEvents), or the
      // card would flash back to Install in between.
      const next: WtInstall =
        event.step === 'error'
          ? { ...prev, step: 'error', error: event.message ?? prev.error, pct: event.pct }
          : event.step === 'done'
            ? { ...prev, step: 'done', pct: 100 }
            : { ...prev, step: event.step, pct: Math.max(prev.pct, event.pct) };
      return { bySkin: { ...s.bySkin, [skinId]: next } };
    });
    return skinId;
  },
  finish: (skinId) =>
    set((s) => ({
      bySkin: without(s.bySkin, skinId),
      byInstallId: Object.fromEntries(Object.entries(s.byInstallId).filter(([, id]) => id !== skinId)),
    })),
  clear: (skinId) => set((s) => ({ bySkin: without(s.bySkin, skinId) })),
}));

/**
 * Routes `install://progress` to WT Live installs; mounted once in App (the queue has its own hook).
 * On `done` it refetches the hangar, then stops tracking and toasts "Installed “name”" (README
 * Interactions: "on Done, skin joins My Hangar and toasts"). Try in game has its own UI: no toast.
 */
export function useWtLiveInstallEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenEvent<InstallProgress>(EVENTS.installProgress, (event) => {
      const skinId = useInstalls.getState().apply(event);
      if (!skinId || event.step !== 'done') return;
      const mode = useInstalls.getState().bySkin[skinId]?.mode;
      void qc
        .invalidateQueries({ queryKey: HANGAR_KEY })
        .catch(() => undefined)
        .then(() => {
          useInstalls.getState().finish(skinId);
          if (mode === 'temporary') return;
          const skin = qc.getQueryData<HangarSkin[]>(HANGAR_KEY)?.find((h) => h.sourceId === skinId);
          toast(skin ? i18n.t('common.installed.toast', { name: skin.name }) : i18n.t('common.installed.toastPlain'));
        });
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e: unknown) => console.error('[livery] install://progress listener failed', e));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [qc]);
}

export type WtInstallState =
  | { kind: 'idle' }
  | { kind: 'installing'; step: InstallStep; pct: number }
  | { kind: 'installed'; temporary: boolean }
  | { kind: 'error'; message: string; code?: string };

/**
 * Card / side-panel install state for a WT Live skin: hangar (by sourceId, temporary installs
 * included) + in-flight installs. A finished install reads 'installing' at 100% until the hangar
 * refetch shows it, then 'installed'.
 */
export function useWtLiveInstall(skin: Pick<WtLiveSkin, 'id'>): { state: WtInstallState; install: (conflict?: ConflictPolicy) => void } {
  const { data: hangar } = useHangar({ includeTemporary: true });
  const track = useInstalls((s) => s.bySkin[skin.id]);
  const start = useInstalls((s) => s.start);
  const installed = hangar?.find((h) => h.sourceId === skin.id);
  const state: WtInstallState =
    track && track.step === 'error'
      ? { kind: 'error', message: track.error ?? '', code: track.errorCode }
      : track && track.step !== 'done'
        ? { kind: 'installing', step: track.step, pct: track.pct }
        : installed
          ? { kind: 'installed', temporary: installed.temporary === true }
          : track
            ? { kind: 'installing', step: 'done', pct: 100 }
            : { kind: 'idle' };
  return { state, install: (conflict) => void start(skin.id, 'normal', conflict) };
}
