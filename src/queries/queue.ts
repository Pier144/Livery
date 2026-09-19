import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call } from '@/lib/tauri';
import { SETTINGS_KEY } from '@/queries/settings';
import type { AppError, ConflictPolicy, HangarSkin, InstallStarted, QueueItem, Settings } from '@/types';

// Install queue commands (M4). The queue itself lives in the Zustand store (`src/store/queue.ts`):
// items change through drops, events and optimistic installs, not through refetches.

/** Looks inside a dropped/picked archive or skin folder without installing anything. */
export function analyzeArchive(path: string): Promise<QueueItem> {
  return call<QueueItem>('analyze_archive', { path });
}

export interface InstallArgs {
  queueId: string;
  /** needsLook: the vehicle picked from `candidates`. */
  vehicleCode?: string;
  /** Omitted: the backend applies `settings.conflictPolicy` (and rejects with `conflict` when it is `ask`). */
  conflict?: ConflictPolicy;
}

/** Starts an install on a background thread; progress arrives as `install://progress` events. */
export function installFromArchive({ queueId, vehicleCode, conflict }: InstallArgs): Promise<InstallStarted> {
  const args: Record<string, unknown> = { queueId };
  if (vehicleCode !== undefined) args.vehicleCode = vehicleCode;
  if (conflict !== undefined) args.conflict = conflict;
  return call<InstallStarted>('install_from_archive', args);
}

/** Items the backend analysed this session (e.g. from the watcher before the UI subscribed). */
export function listQueue(): Promise<QueueItem[]> {
  return call<QueueItem[]>('list_queue');
}

export function removeQueueItem(queueId: string): Promise<void> {
  return call<void>('remove_queue_item', { queueId });
}

/** Undo for "Replace, keep a backup": removes the new version and puts the old one back. */
export function undoReplace(skinId: string, backupId: string): Promise<HangarSkin> {
  return call<HangarSkin>('undo_replace', { skinId, backupId });
}

export interface WatchArgs {
  /** Omitted: keep the current (or default Downloads) folder. */
  path?: string;
  enabled: boolean;
}

/** "Watch Downloads folder": starts/stops the watcher; the backend returns the updated settings. */
export function useWatchFolder() {
  const qc = useQueryClient();
  return useMutation<Settings, AppError, WatchArgs>({
    mutationFn: ({ path, enabled }) => call<Settings>('watch_folder', path === undefined ? { enabled } : { path, enabled }),
    onSuccess: (settings) => qc.setQueryData(SETTINGS_KEY, settings),
  });
}
