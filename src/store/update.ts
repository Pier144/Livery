import { create } from 'zustand';
import { call, toAppError } from '@/lib/tauri';
import type { AppError, UpdateInfo, UpdateProgress } from '@/types';

/**
 * Settings → Updates. `checking` → `upToDate` | `available` | `ready`; `available` → `downloading`
 * → `installing` (Livery closes); a background download (automatic updates) goes `downloading` →
 * `ready` and installs when Livery closes.
 */
export type UpdatePhase = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

interface UpdateState {
  phase: UpdatePhase;
  /** The version on offer. */
  latest?: string;
  /** 0–100 while downloading; undefined while the size is unknown. */
  pct?: number;
  /** The user asked to install: the download ends in `installing`, not `ready`. */
  requested: boolean;
  error?: AppError;
  /** The version the launch popup offers (UpdateDialog); undefined when it's closed. */
  prompt?: string;
  check: () => Promise<void>;
  /**
   * The check at launch: like `check`, but quiet when it fails (no error state), and it opens the
   * popup for a newer version unless "Later" was chosen for that version this session.
   */
  checkAtLaunch: () => Promise<void>;
  /** "Later": closes the popup; it won't open again for this version until Livery restarts. */
  dismissPrompt: () => void;
  install: () => Promise<void>;
  /** `update://progress`. */
  progress: (p: UpdateProgress) => void;
  /** `update://ready`. */
  ready: (version: string) => void;
  reset: () => void;
}

const INITIAL = { phase: 'idle', latest: undefined, pct: undefined, requested: false, error: undefined, prompt: undefined } as const;

/** Versions the user put off with "Later" this session. */
const postponed = new Set<string>();

const busy = (phase: UpdatePhase) => phase === 'checking' || phase === 'downloading' || phase === 'installing';

export const useUpdate = create<UpdateState>()((set, get) => ({
  ...INITIAL,
  check: async () => {
    if (busy(get().phase)) return;
    set({ phase: 'checking', error: undefined });
    try {
      const info = await call<UpdateInfo>('check_update');
      // A background download may have started meanwhile: its events own the phase.
      if (get().phase !== 'checking') return;
      if (!info.latest) set({ phase: 'upToDate', latest: undefined });
      else set({ phase: info.ready ? 'ready' : 'available', latest: info.latest });
    } catch (e) {
      set({ phase: 'error', error: toAppError(e) });
    }
  },
  checkAtLaunch: async () => {
    if (get().phase !== 'idle') return;
    let info: UpdateInfo;
    try {
      info = await call<UpdateInfo>('check_update');
    } catch (e) {
      console.warn('[livery] update check at launch failed', e);
      return;
    }
    if (!info.latest) {
      if (get().phase === 'idle') set({ phase: 'upToDate' });
      return;
    }
    const busyNow = busy(get().phase);
    if (!busyNow) set({ phase: info.ready ? 'ready' : 'available', latest: info.latest });
    if (!postponed.has(info.latest)) set({ prompt: info.latest });
  },
  dismissPrompt: () => {
    const { prompt } = get();
    if (prompt) postponed.add(prompt);
    set({ prompt: undefined });
  },
  install: async () => {
    const { phase } = get();
    if (busy(phase)) return;
    set(phase === 'ready' ? { phase: 'installing', requested: true, error: undefined } : { phase: 'downloading', pct: 0, requested: true, error: undefined });
    try {
      // On Windows Livery closes during this call and the installer takes over.
      await call<void>('install_update');
      set({ phase: 'installing' });
    } catch (e) {
      set({ phase: 'error', requested: false, error: toAppError(e) });
    }
  },
  progress: ({ downloaded, total }) => {
    const { phase, requested } = get();
    if (phase === 'installing') return;
    const pct = total ? Math.min(100, Math.floor((downloaded / total) * 100)) : undefined;
    if (requested && total !== undefined && downloaded >= total) set({ phase: 'installing', pct: 100 });
    else set({ phase: 'downloading', pct });
  },
  ready: (version) => {
    if (get().phase === 'installing') return;
    set({ phase: 'ready', latest: version, pct: undefined, error: undefined });
  },
  reset: () => {
    postponed.clear();
    set({ ...INITIAL });
  },
}));
