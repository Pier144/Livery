import { create } from 'zustand';
import i18n from '@/i18n';
import { baseName } from '@/lib/format';
import { toAppError } from '@/lib/tauri';
import { analyzeArchive, installFromArchive, removeQueueItem } from '@/queries/queue';
import { toast } from '@/store/toasts';
import type { ConflictPolicy, InstallProgress, InstallStep, QueueItem, QueueStatus } from '@/types';

/** An install the UI started (or saw events for), keyed by queue id. */
export interface InstallTrack {
  installId?: string;
  step: InstallStep;
  /** 0–100 across the whole install. */
  pct: number;
  /** Conflict choice sent with the install (drives the done toast). */
  conflict?: ConflictPolicy;
  /** Part of "Install N ready": one summary toast at the end instead of one per item. */
  batch?: boolean;
  /** Name of the installed skin being replaced, for the "Replaced …" toast. */
  replacedName?: string;
}

/** What a progress event did to the queue, so the event hook can toast and refresh. */
export type ProgressOutcome =
  | { kind: 'progress' }
  | { kind: 'done'; item: QueueItem; track?: InstallTrack; event: InstallProgress }
  | { kind: 'skipped'; item: QueueItem }
  | { kind: 'error'; item: QueueItem }
  /** No queue item for it (removed meanwhile, or an install started elsewhere). */
  | { kind: 'unknown'; event: InstallProgress };

export interface InstallOptions {
  conflict?: ConflictPolicy;
  vehicleCode?: string;
  batch?: boolean;
  replacedName?: string;
  /** A single-row install refused with `conflict` opens the Conflict dialog (never during a batch). */
  openDialogOnConflict?: boolean;
}

interface QueueState {
  /** Newest first. Keyed by backend id; `p-…` ids are local placeholders still being analysed. */
  items: QueueItem[];
  conflictDialogId: string | null;
  installs: Record<string, InstallTrack>;
  /** needsLook: the vehicle picked for an item (sent again when a conflict is resolved later). */
  picked: Record<string, string>;
  /** "Install N ready" is running. */
  batchRunning: boolean;
  /**
   * Adds dropped/picked paths (archives, skin folders, anything) as `analyzing` placeholders, newest first,
   * and analyses each one. Returns the placeholders synchronously. Results replace their placeholder;
   * paths that aren't skins disappear with one toast for the whole drop; other failures become error rows.
   */
  addPaths: (paths: string[]) => QueueItem[];
  /** Adds or replaces an item by id (watcher, `list_queue`). */
  upsert: (item: QueueItem) => void;
  /** Adds backend items not in the queue yet (startup). */
  hydrate: (items: QueueItem[]) => void;
  update: (id: string, patch: Partial<QueueItem>) => void;
  /** Removes an item here and in the backend (placeholders: here only). */
  remove: (id: string) => void;
  clearDone: () => void;
  openConflict: (id: string) => void;
  closeConflict: () => void;
  /** Starts one install (optimistic: the row shows progress at once). Resolves true when the backend took it. */
  install: (id: string, options?: InstallOptions) => Promise<boolean>;
  /** Conflict dialog / policy choice: replace, copy or skip. */
  resolve: (id: string, choice: Exclude<ConflictPolicy, 'ask'>, replacedName?: string) => Promise<void>;
  /** needsLook → install with the picked vehicle. */
  pickVehicle: (id: string, vehicleCode: string) => Promise<boolean>;
  /** Installs every ready item, one after the other. */
  installReady: () => Promise<void>;
  /** Applies one `install://progress` event. */
  applyProgress: (event: InstallProgress) => ProgressOutcome;
}

let seq = 0;
const placeholderId = () => `p-${Date.now().toString(36)}${(seq++).toString(36)}`;
export const isPlaceholder = (id: string) => id.startsWith('p-');

/** Placeholders the user removed while their analysis was running: the result is dropped too. */
const discarded = new Set<string>();

/** Error codes meaning "this path is not a skin" (the drop was a mistake, not a failure). */
const NOT_A_SKIN = new Set(['invalidInput']);

/** Folder or file name, ignoring a trailing separator (`C:\Skins\Tiger\`). */
function displayFileName(path: string): string {
  return baseName(path.replace(/[\\/]+$/, '')) || path;
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Settles when the item stops installing (done / error / conflict) or leaves the queue. */
function settled(id: string): Promise<QueueStatus | undefined> {
  return new Promise((resolve) => {
    const check = (s: QueueState) => {
      const item = s.items.find((i) => i.id === id);
      if (item?.status === 'installing') return false;
      resolve(item?.status);
      return true;
    };
    if (check(useQueue.getState())) return;
    const unsubscribe = useQueue.subscribe((s) => {
      if (check(s)) unsubscribe();
    });
  });
}

export const useQueue = create<QueueState>()((set, get) => {
  const patchItem = (id: string, patch: Partial<QueueItem>) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));

  const dropLocal = (id: string) =>
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
      installs: omit(s.installs, id),
      picked: omit(s.picked, id),
      conflictDialogId: s.conflictDialogId === id ? null : s.conflictDialogId,
    }));

  const forgetInBackend = (id: string) => {
    if (isPlaceholder(id)) return;
    removeQueueItem(id).catch((e: unknown) => console.warn('[livery] remove_queue_item failed', e));
  };

  /** The analysis of placeholder `pid` came back. */
  const settlePlaceholder = (pid: string, item: QueueItem) => {
    if (discarded.delete(pid)) {
      forgetInBackend(item.id);
      return;
    }
    set((s) => {
      const existing = s.items.find((i) => i.id === item.id);
      if (existing) {
        // The backend knew this path already (same id): keep one row, and never regress an install.
        const keep = existing.status === 'installing' || existing.status === 'done' ? existing : item;
        return { items: s.items.filter((i) => i.id !== pid).map((i) => (i.id === item.id ? keep : i)) };
      }
      return { items: s.items.map((i) => (i.id === pid ? item : i)) };
    });
  };

  const analyzeAll = async (placeholders: QueueItem[]) => {
    const notSkins: string[] = [];
    await Promise.all(
      placeholders.map(async (p) => {
        try {
          settlePlaceholder(p.id, await analyzeArchive(p.path));
        } catch (e) {
          if (discarded.delete(p.id)) return;
          const err = toAppError(e);
          if (NOT_A_SKIN.has(err.code)) {
            notSkins.push(p.fileName);
            dropLocal(p.id);
          } else {
            patchItem(p.id, { status: 'error', error: err.message });
          }
        }
      }),
    );
    if (notSkins.length) toast(i18n.t('queue.toast.notSkin', { count: notSkins.length, name: notSkins[0] }));
  };

  /** Skip needs nothing on disk: the row leaves the queue. Idempotent (event and reply may both call it). */
  const finishSkip = (id: string) => {
    if (!get().items.some((i) => i.id === id)) return false;
    dropLocal(id);
    toast(i18n.t('queue.toast.skipped'));
    return true;
  };

  const install = async (id: string, options: InstallOptions = {}): Promise<boolean> => {
    const item = get().items.find((i) => i.id === id);
    if (!item || item.status === 'analyzing' || item.status === 'installing' || item.status === 'done') return false;
    const { conflict, batch, replacedName } = options;
    const vehicleCode = options.vehicleCode ?? get().picked[id];
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? { ...i, status: 'installing' as const, error: undefined } : i)),
      installs: { ...s.installs, [id]: { step: 'extract', pct: 0, conflict, batch, replacedName } },
    }));
    try {
      const { installId } = await installFromArchive({ queueId: id, vehicleCode, conflict });
      // Events may have finished the install before the reply arrived; attach the id only while it runs.
      set((s) => (s.installs[id] ? { installs: { ...s.installs, [id]: { ...s.installs[id], installId } } } : s));
      return true;
    } catch (e) {
      const err = toAppError(e);
      set((s) => ({ installs: omit(s.installs, id) }));
      if (err.code === 'conflict') {
        patchItem(id, { status: 'conflict' });
        if (options.openDialogOnConflict) set({ conflictDialogId: id });
      } else {
        patchItem(id, { status: 'error', error: err.message });
      }
      return false;
    }
  };

  return {
    items: [],
    conflictDialogId: null,
    installs: {},
    picked: {},
    batchRunning: false,

    addPaths: (paths) => {
      const unique = [...new Set(paths.filter((p) => p.trim() !== ''))];
      const placeholders: QueueItem[] = unique.map((path) => ({
        id: placeholderId(),
        path,
        fileName: displayFileName(path),
        sizeBytes: 0,
        status: 'analyzing',
      }));
      if (placeholders.length === 0) return [];
      set((s) => ({ items: [...placeholders, ...s.items] }));
      void analyzeAll(placeholders);
      return placeholders;
    },

    upsert: (item) =>
      set((s) =>
        s.items.some((i) => i.id === item.id)
          ? { items: s.items.map((i) => (i.id === item.id ? item : i)) }
          : { items: [item, ...s.items] },
      ),

    hydrate: (items) =>
      set((s) => {
        const known = new Set(s.items.map((i) => i.id));
        const fresh = items.filter((i) => !known.has(i.id));
        return fresh.length ? { items: [...s.items, ...fresh] } : s;
      }),

    update: patchItem,

    remove: (id) => {
      const item = get().items.find((i) => i.id === id);
      if (!item || item.status === 'installing') return;
      if (item.status === 'analyzing') discarded.add(id);
      dropLocal(id);
      forgetInBackend(id);
    },

    clearDone: () => {
      const done = get().items.filter((i) => i.status === 'done');
      done.forEach((i) => dropLocal(i.id));
      done.forEach((i) => forgetInBackend(i.id));
    },

    openConflict: (id) => set({ conflictDialogId: id }),
    closeConflict: () => set({ conflictDialogId: null }),

    install,

    resolve: async (id, choice, replacedName) => {
      set({ conflictDialogId: null });
      const ok = await install(id, { conflict: choice, replacedName });
      if (ok && choice === 'skip') finishSkip(id);
    },

    pickVehicle: (id, vehicleCode) => {
      const item = get().items.find((i) => i.id === id);
      const vehicle = item?.candidates?.find((v) => v.code === vehicleCode);
      set((s) => ({ picked: { ...s.picked, [id]: vehicleCode } }));
      if (vehicle) patchItem(id, { vehicle });
      return install(id, { vehicleCode, openDialogOnConflict: true });
    },

    installReady: async () => {
      if (get().batchRunning) return;
      const ids = get()
        .items.filter((i) => i.status === 'ready')
        .map((i) => i.id);
      if (ids.length === 0) return;
      set({ batchRunning: true });
      let installed = 0;
      try {
        for (const id of ids) {
          if (get().items.find((i) => i.id === id)?.status !== 'ready') continue;
          if (!(await install(id, { batch: true }))) continue;
          if ((await settled(id)) === 'done') installed += 1;
        }
      } finally {
        set({ batchRunning: false });
      }
      if (installed > 0) toast(i18n.t('queue.toast.installedMany', { count: installed }));
    },

    applyProgress: (event) => {
      const { installs, items } = get();
      const queueId = event.queueId ?? Object.keys(installs).find((k) => installs[k]?.installId === event.installId);
      const item = queueId ? items.find((i) => i.id === queueId) : undefined;
      if (!queueId || !item) return { kind: 'unknown', event };
      const track = installs[queueId];
      // A finished row with no install running: a late event of the install that finished it.
      if (!track && (item.status === 'done' || item.status === 'error')) return { kind: 'unknown', event };

      if (event.step === 'done') {
        // Skipped: chosen here, or applied by the backend (Settings → Conflicts, watcher): done + "skipped".
        if (track?.conflict === 'skip' || event.message === 'skipped') {
          finishSkip(queueId);
          return { kind: 'skipped', item };
        }
        const done: QueueItem = { ...item, status: 'done', error: undefined };
        set((s) => ({ items: s.items.map((i) => (i.id === queueId ? done : i)), installs: omit(s.installs, queueId) }));
        return { kind: 'done', item: done, track, event };
      }
      if (event.step === 'error') {
        const failed: QueueItem = { ...item, status: 'error', error: event.message || i18n.t('queue.note.error') };
        set((s) => ({ items: s.items.map((i) => (i.id === queueId ? failed : i)), installs: omit(s.installs, queueId) }));
        return { kind: 'error', item: failed };
      }
      // download / extract / verify. An install we didn't start (e.g. the watcher's) shows up here too.
      const next: InstallTrack = { ...track, installId: event.installId, step: event.step, pct: event.pct };
      set((s) => ({
        installs: { ...s.installs, [queueId]: next },
        items: item.status === 'installing' ? s.items : s.items.map((i) => (i.id === queueId ? { ...i, status: 'installing' } : i)),
      }));
      return { kind: 'progress' };
    },
  };
});

/** Sidebar badge: everything not yet installed. */
export const selectPendingCount = (s: QueueState) => s.items.filter((i) => i.status !== 'done').length;
export const selectReadyCount = (s: QueueState) => s.items.filter((i) => i.status === 'ready').length;
