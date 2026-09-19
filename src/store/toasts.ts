import { create } from 'zustand';

export const TOAST_DURATION_MS = 6000;
const MAX_TOASTS = 4;

export interface Toast {
  id: number;
  message: string;
  /** Present for undoable toasts; the backend keeps a backup until the toast expires. */
  onUndo?: () => void | Promise<void>;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
  /** Runs the toast's undo callback at most once; a no-op after dismissal or expiry. */
  undo: (id: number) => Promise<void>;
  /** Ctrl+Z: undoes the newest toast that offers Undo. Returns false when there is none. */
  undoLatest: () => boolean;
  /** Stops the expiry countdown (pointer over the toast or focus inside it — WCAG 2.2.1). */
  pause: (id: number) => void;
  /** Restarts the countdown with the time that was left when it was paused. */
  resume: (id: number) => void;
  clear: () => void;
}

/** Expiry bookkeeping per toast: a live timeout, or the time left while paused. */
type Timer =
  | { kind: 'running'; handle: ReturnType<typeof setTimeout>; endsAt: number }
  | { kind: 'paused'; remaining: number };

let nextId = 1;
const timers = new Map<number, Timer>();

function stopTimer(id: number) {
  const t = timers.get(id);
  if (t?.kind === 'running') clearTimeout(t.handle);
  timers.delete(id);
}

function startTimer(id: number, ms: number) {
  timers.set(id, {
    kind: 'running',
    handle: setTimeout(() => useToasts.getState().dismiss(id), ms),
    endsAt: Date.now() + ms,
  });
}

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    const toasts = [...get().toasts, { ...t, id }];
    // Oldest toasts fall off when the stack is full.
    toasts.slice(0, Math.max(0, toasts.length - MAX_TOASTS)).forEach((d) => stopTimer(d.id));
    set({ toasts: toasts.slice(-MAX_TOASTS) });
    startTimer(id, TOAST_DURATION_MS);
    return id;
  },
  dismiss: (id) => {
    stopTimer(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  undo: async (id) => {
    const t = get().toasts.find((x) => x.id === id);
    // Gone means already undone, dismissed or expired (backup window closed): never undo twice or late.
    if (!t) return;
    get().dismiss(id);
    await t.onUndo?.();
  },
  undoLatest: () => {
    const latest = get().toasts.findLast((t) => t.onUndo);
    if (!latest) return false;
    void get().undo(latest.id);
    return true;
  },
  pause: (id) => {
    const t = timers.get(id);
    if (t?.kind !== 'running') return;
    clearTimeout(t.handle);
    timers.set(id, { kind: 'paused', remaining: Math.max(0, t.endsAt - Date.now()) });
  },
  resume: (id) => {
    const t = timers.get(id);
    if (t?.kind !== 'paused') return;
    startTimer(id, t.remaining);
  },
  clear: () => {
    [...timers.keys()].forEach(stopTimer);
    set({ toasts: [] });
  },
}));

/**
 * `toast('Installed “X”')` for plain notices;
 * `toast.undoable('Deleted 3 skins', restore)` for anything the user can regret.
 */
export const toast = Object.assign((message: string) => useToasts.getState().push({ message }), {
  undoable: (message: string, onUndo: () => void | Promise<void>) => useToasts.getState().push({ message, onUndo }),
  dismiss: (id: number) => useToasts.getState().dismiss(id),
});
