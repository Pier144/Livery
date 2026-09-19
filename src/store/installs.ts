import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';
import { listenEvent } from '@/lib/events';
import { toAppError } from '@/lib/tauri';
import { HANGAR_KEY, useHangar } from '@/queries/hangar';
import { installFromWtLive } from '@/queries/wtlive';
import { EVENTS, type ConflictPolicy, type InstallMode, type InstallProgress, type InstallStep, type WtLiveSkin } from '@/types';

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
    if (current && current.step !== 'error' && current.step !== 'done') return;
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
      if (event.step === 'done') {
        // Installed: the hangar (sourceId) now says so; nothing left to track.
        return { bySkin: without(s.bySkin, skinId), byInstallId: without(s.byInstallId, event.installId) };
      }
      const next: WtInstall =
        event.step === 'error'
          ? { ...prev, step: 'error', error: event.message ?? prev.error, pct: event.pct }
          : { ...prev, step: event.step, pct: Math.max(prev.pct, event.pct) };
      return { bySkin: { ...s.bySkin, [skinId]: next } };
    });
    return skinId;
  },
  clear: (skinId) => set((s) => ({ bySkin: without(s.bySkin, skinId) })),
}));

/** Routes `install://progress` to WT Live installs; mounted once in App (the queue has its own hook). */
export function useWtLiveInstallEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenEvent<InstallProgress>(EVENTS.installProgress, (event) => {
      const skinId = useInstalls.getState().apply(event);
      if (skinId && event.step === 'done') void qc.invalidateQueries({ queryKey: HANGAR_KEY });
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

/** Card / side-panel install state for a WT Live skin: hangar (by sourceId) + in-flight installs. */
export function useWtLiveInstall(skin: Pick<WtLiveSkin, 'id'>): { state: WtInstallState; install: (conflict?: ConflictPolicy) => void } {
  const { data: hangar } = useHangar();
  const track = useInstalls((s) => s.bySkin[skin.id]);
  const start = useInstalls((s) => s.start);
  const installed = hangar?.find((h) => h.sourceId === skin.id);
  const state: WtInstallState =
    track && track.step === 'error'
      ? { kind: 'error', message: track.error ?? '', code: track.errorCode }
      : track
        ? { kind: 'installing', step: track.step, pct: track.pct }
        : installed
          ? { kind: 'installed', temporary: installed.temporary === true }
          : { kind: 'idle' };
  return { state, install: (conflict) => void start(skin.id, 'normal', conflict) };
}
