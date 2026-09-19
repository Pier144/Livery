import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import i18n from '@/i18n';
import { listenEvent } from '@/lib/events';
import { call, hasBackend, toAppError } from '@/lib/tauri';
import { HANGAR_KEY } from '@/queries/hangar';
import { listQueue, undoReplace } from '@/queries/queue';
import { skinName } from '@/screens/Queue/queueModel';
import { useQueue, type ProgressOutcome } from '@/store/queue';
import { toast } from '@/store/toasts';
import { EVENTS, type InstallProgress, type QueueItem } from '@/types';

type Pending = { kind: 'progress'; event: InstallProgress } | { kind: 'added'; item: QueueItem };

const isTerminal = (e: InstallProgress) => e.step === 'done' || e.step === 'error';

/** Longest wait for a frame: hidden or minimized windows get no frames, but a running batch must go on. */
const MAX_FRAME_WAIT_MS = 100;

/** Next animation frame, or `MAX_FRAME_WAIT_MS`, whichever comes first. Returns a cancel function. */
function nextFrame(cb: () => void): () => void {
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    cb();
  };
  const timer = window.setTimeout(run, MAX_FRAME_WAIT_MS);
  const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : null;
  return () => {
    ran = true;
    window.clearTimeout(timer);
    if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  };
}

/**
 * Collects backend events and applies them once per animation frame (~30–60 fps), in arrival order.
 * Consecutive progress ticks of one install collapse into the latest; `done`/`error` are never dropped.
 */
function createFrameBatcher(apply: (batch: Pending[]) => void) {
  let queue: Pending[] = [];
  /** installId → index in `queue` of its latest non-terminal tick. */
  let latestTick = new Map<string, number>();
  // A flag, not the handle: a scheduler that runs the callback at once must not leave a stale handle behind.
  let scheduled = false;
  let cancelFrame: () => void = () => {};

  const flush = () => {
    scheduled = false;
    const batch = queue;
    queue = [];
    latestTick = new Map();
    apply(batch);
  };

  return {
    push(p: Pending) {
      if (p.kind === 'progress' && !isTerminal(p.event)) {
        const at = latestTick.get(p.event.installId);
        if (at !== undefined) queue[at] = p;
        else {
          latestTick.set(p.event.installId, queue.length);
          queue.push(p);
        }
      } else {
        // Later ticks must not be merged back in front of a terminal event.
        if (p.kind === 'progress') latestTick.delete(p.event.installId);
        queue.push(p);
      }
      if (!scheduled) {
        scheduled = true;
        cancelFrame = nextFrame(flush);
      }
    },
    cancel() {
      if (scheduled) cancelFrame();
      scheduled = false;
      queue = [];
    },
  };
}

/** Toasts and cache refresh for what an event did to the queue. */
function afterEvent(outcome: ProgressOutcome, qc: QueryClient) {
  const t = i18n.t;
  switch (outcome.kind) {
    case 'unknown':
      if (outcome.event.step === 'done') void qc.invalidateQueries({ queryKey: HANGAR_KEY });
      return;
    case 'done': {
      void qc.invalidateQueries({ queryKey: HANGAR_KEY });
      const { item, track, event } = outcome;
      const name = skinName(item);
      const { skinId, backupId } = event;
      if (skinId && backupId) {
        // A replace (chosen in the dialog, or the Settings policy): the old version is in a backup.
        toast.undoable(t('queue.toast.replaced', { name: track?.replacedName ?? name }), async () => {
          try {
            const restored = await undoReplace(skinId, backupId);
            useQueue.getState().update(item.id, { status: 'conflict', conflictWith: restored.id });
            toast(t('queue.toast.restored'));
          } catch (e) {
            toast(toAppError(e).message);
          } finally {
            void qc.invalidateQueries({ queryKey: HANGAR_KEY });
          }
        });
      } else if (track?.conflict === 'replace') {
        toast(t('queue.toast.replacedPlain', { name: track.replacedName ?? name }));
      } else if (track?.conflict === 'copy') {
        toast(t('queue.toast.copied'));
      } else if (!track?.batch) {
        // "Install N ready" toasts once for the whole batch.
        toast(t('queue.toast.installed', { name }));
      }
      return;
    }
    default:
      // progress / error / skipped: the row shows it (and the skip toasted already).
      return;
  }
}

/**
 * Keeps the install queue in sync with the backend. Mount once, in `App`:
 * - `install://progress` → row progress, then Installed (hangar refetch + toast) or Error;
 * - `queue://added` → the watcher's new items;
 * - `hangar://changed` → hangar refetch;
 * - on start, items the backend already had (`list_queue`).
 */
export function useInstallEvents() {
  const qc = useQueryClient();

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const batcher = createFrameBatcher((batch) => {
      const store = useQueue.getState();
      for (const p of batch) {
        if (p.kind === 'added') store.upsert(p.item);
        else afterEvent(store.applyProgress(p.event), qc);
      }
    });

    const subscribe = <T>(name: string, handler: (payload: T) => void) =>
      listenEvent<T>(name, handler)
        .then((unlisten) => {
          // Unmounted before the listener was registered.
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch((e: unknown) => console.error(`[livery] ${name} listener failed`, e));

    void subscribe<InstallProgress>(EVENTS.installProgress, (event) => batcher.push({ kind: 'progress', event }));
    void subscribe<QueueItem>(EVENTS.queueAdded, (item) => batcher.push({ kind: 'added', item }));
    // UserSkins changed outside Livery (Explorer, the game): rescan so the index follows the disk.
    let rescanning = false;
    void subscribe<unknown>(EVENTS.hangarChanged, () => {
      if (rescanning) return;
      rescanning = true;
      call('scan_user_skins')
        .catch((e: unknown) => console.warn('[livery] rescan after hangar://changed failed', e))
        .finally(() => {
          rescanning = false;
          void qc.invalidateQueries({ queryKey: HANGAR_KEY });
        });
    });

    if (hasBackend()) {
      listQueue()
        .then((items) => {
          if (!disposed) useQueue.getState().hydrate(items);
        })
        .catch((e: unknown) => console.warn('[livery] list_queue failed', e));
    }

    return () => {
      disposed = true;
      batcher.cancel();
      unlisteners.splice(0).forEach((u) => u());
    };
  }, [qc]);
}
