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
  undo: (id: number) => Promise<void>;
  clear: () => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t !== undefined) clearTimeout(t);
  timers.delete(id);
}

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set((s) => {
      const toasts = [...s.toasts, { ...t, id }];
      // Oldest toasts fall off when the stack is full.
      const dropped = toasts.slice(0, Math.max(0, toasts.length - MAX_TOASTS));
      dropped.forEach((d) => clearTimer(d.id));
      return { toasts: toasts.slice(-MAX_TOASTS) };
    });
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), TOAST_DURATION_MS),
    );
    return id;
  },
  dismiss: (id) => {
    clearTimer(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  undo: async (id) => {
    const t = get().toasts.find((x) => x.id === id);
    get().dismiss(id);
    await t?.onUndo?.();
  },
  clear: () => {
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
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
