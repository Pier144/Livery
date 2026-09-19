import { create } from 'zustand';
import { baseName, isArchive } from '@/lib/format';
import type { QueueItem } from '@/types';

interface QueueState {
  items: QueueItem[];
  conflictDialogId: string | null;
  /** Adds dropped/watched archive paths as `analyzing` items (newest first). Returns the accepted items. */
  addPaths: (paths: string[]) => QueueItem[];
  update: (id: string, patch: Partial<QueueItem>) => void;
  remove: (id: string) => void;
}

let seq = 0;
const newId = () => `q${Date.now().toString(36)}${(seq++).toString(36)}`;

export const useQueue = create<QueueState>()((set) => ({
  items: [],
  conflictDialogId: null,
  addPaths: (paths) => {
    const accepted: QueueItem[] = paths
      .filter((p) => isArchive(p))
      .map((path) => ({ id: newId(), path, fileName: baseName(path), sizeBytes: 0, status: 'analyzing' }));
    if (accepted.length) set((s) => ({ items: [...accepted, ...s.items] }));
    return accepted;
  },
  update: (id, patch) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

/** Sidebar badge: everything not yet installed. */
export const selectPendingCount = (s: QueueState) => s.items.filter((i) => i.status !== 'done').length;
