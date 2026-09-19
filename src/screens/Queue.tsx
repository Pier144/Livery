import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useHangar } from '@/queries/hangar';
import { useSettings } from '@/queries/settings';
import { useQueue } from '@/store/queue';
import type { QueueItem, QueueStatus } from '@/types';
import { ConflictDialog, type ConflictChoice } from './Queue/ConflictDialog';
import { PRIMARY_28 } from './Queue/controls';
import { DropZone } from './Queue/DropZone';
import { LegendCard } from './Queue/LegendCard';
import { conflictTarget, headerMeta } from './Queue/queueModel';
import { QueueRow } from './Queue/QueueRow';
import { WatchCard } from './Queue/WatchCard';
import { ScreenFrame, ScreenHeader } from './ScreenHeader';

/** A row's element (its `li` is focusable with tabindex -1). */
function rowElement(list: HTMLElement | null, id: string): HTMLElement | null {
  if (!list) return null;
  return Array.from(list.querySelectorAll<HTMLElement>('[data-queue-row]')).find((el) => el.dataset.queueRow === id) ?? null;
}

/** Focus fell to <body> (its element went away): move it somewhere sensible. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/**
 * Install queue (README §6): drop zone + rows on the left (status, action, progress), Watch folder and
 * legend cards on the right; the Conflict dialog on top. Queue state lives in `useQueue`; backend events
 * arrive through `useInstallEvents` (mounted in App).
 */
export function Queue() {
  const { t } = useTranslation();
  const items = useQueue((s) => s.items);
  const installs = useQueue((s) => s.installs);
  const batchRunning = useQueue((s) => s.batchRunning);
  const conflictDialogId = useQueue((s) => s.conflictDialogId);
  // A temporary (Try in game) skin still occupies its folder.
  const { data: hangar } = useHangar({ includeTemporary: true });
  const { data: settings } = useSettings();
  const policy = settings?.conflictPolicy ?? 'ask';

  const listRef = useRef<HTMLUListElement>(null);
  const dropRef = useRef<HTMLButtonElement>(null);

  const ready = items.filter((i) => i.status === 'ready').length;
  const batchLeft = ready + Object.values(installs).filter((i) => i.batch).length;
  const hasDone = items.some((i) => i.status === 'done');
  const conflictItem = conflictDialogId ? items.find((i) => i.id === conflictDialogId && i.status === 'conflict') : undefined;

  /** After the next commit, if the focused control vanished, focus the row (or the list, or the drop zone). */
  const rescueFocus = useCallback((id?: string) => {
    window.setTimeout(() => {
      if (!focusIsLost()) return;
      const row = id ? rowElement(listRef.current, id) : null;
      (row ?? listRef.current ?? dropRef.current)?.focus();
    }, 0);
  }, []);

  // ── Row actions ──────────────────────────────────────────────────────────

  const onInstall = useCallback(
    (item: QueueItem) => {
      void useQueue.getState().install(item.id, { openDialogOnConflict: true });
      rescueFocus(item.id);
    },
    [rescueFocus],
  );

  const onResolve = useCallback(
    (item: QueueItem) => {
      if (policy === 'ask') {
        useQueue.getState().openConflict(item.id);
        return;
      }
      // Settings → Conflicts decides; a replace is still undoable from its toast.
      void useQueue.getState().resolve(item.id, policy, conflictTarget(item, hangar, items).name);
      rescueFocus(item.id);
    },
    [policy, hangar, rescueFocus],
  );

  const onPickVehicle = useCallback(
    (item: QueueItem, code: string) => {
      void useQueue.getState().pickVehicle(item.id, code);
      rescueFocus(item.id);
    },
    [rescueFocus],
  );

  // After a removal, focus the × of the row that took its place (or the one before, or the drop zone).
  const focusAfterRemove = useRef<number | null>(null);
  const onRemove = useCallback((item: QueueItem) => {
    const before = useQueue.getState().items;
    focusAfterRemove.current = before.findIndex((i) => i.id === item.id);
    useQueue.getState().remove(item.id);
    // Nothing was removed (e.g. the row started installing meanwhile): don't move focus on a later change.
    if (useQueue.getState().items === before) focusAfterRemove.current = null;
  }, []);
  useLayoutEffect(() => {
    const index = focusAfterRemove.current;
    if (index === null) return;
    focusAfterRemove.current = null;
    const rows = listRef.current ? Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-queue-row]')) : [];
    const row = rows[Math.min(index, rows.length - 1)];
    (row?.querySelector<HTMLElement>('[data-row-remove]') ?? row ?? dropRef.current)?.focus();
  }, [items]);

  const onChoose = useCallback(
    (choice: ConflictChoice) => {
      if (!conflictItem) return;
      void useQueue.getState().resolve(conflictItem.id, choice, conflictTarget(conflictItem, hangar, items).name);
    },
    [conflictItem, hangar],
  );
  const onCancelConflict = useCallback(() => useQueue.getState().closeConflict(), []);
  const conflictFallback = useCallback(() => {
    const row = conflictItem ? rowElement(listRef.current, conflictItem.id) : null;
    return row?.querySelector<HTMLElement>('[data-row-action]') ?? row ?? listRef.current;
  }, [conflictItem]);

  // A dialog for an item that left the queue (or stopped conflicting) closes; so does leaving the screen.
  useEffect(() => {
    if (conflictDialogId && !conflictItem) useQueue.getState().closeConflict();
  }, [conflictDialogId, conflictItem]);
  useEffect(() => () => useQueue.getState().closeConflict(), []);

  // ── Header actions ───────────────────────────────────────────────────────

  const installReady = () => {
    void useQueue
      .getState()
      .installReady()
      .finally(() => rescueFocus());
  };
  const clearDone = () => {
    useQueue.getState().clearDone();
    rescueFocus();
  };

  const onPaths = useCallback((paths: string[]) => void useQueue.getState().addPaths(paths), []);

  // ── Live region: installs finishing or failing ───────────────────────────

  // `seq` alternates a trailing no-break space so the same message twice in a row is announced again.
  const [announcement, setAnnouncement] = useState({ text: '', seq: 0 });
  const lastStatus = useRef<Map<string, QueueStatus> | null>(null);
  useEffect(() => {
    const before = lastStatus.current;
    lastStatus.current = new Map(items.map((i) => [i.id, i.status]));
    if (!before) return;
    const messages = items.flatMap((item) => {
      const was = before.get(item.id);
      if (was === item.status) return [];
      // New rows are announced only when they arrive failed (e.g. an archive that can't be unpacked yet).
      if (item.status === 'done' && was) return [t('queue.announce.done', { name: item.fileName })];
      if (item.status === 'error') return [t('queue.announce.error', { name: item.fileName, message: item.error ?? '' })];
      return [];
    });
    if (messages.length) setAnnouncement((a) => ({ text: messages.join(' '), seq: a.seq + 1 }));
  }, [items, t]);

  return (
    <ScreenFrame label={t('queue.title')}>
      <ScreenHeader
        title={t('queue.title')}
        meta={headerMeta(items, t)}
        right={
          <div className="flex gap-2">
            {hasDone && (
              <Button variant="ghost" size={28} onClick={clearDone}>
                {t('queue.clearDone')}
              </Button>
            )}
            {(ready > 0 || batchRunning) && (
              <button
                type="button"
                onClick={() => {
                  if (!batchRunning) installReady();
                }}
                aria-disabled={batchRunning || undefined}
                className={PRIMARY_28}
              >
                {t('queue.installReady', { count: batchRunning ? batchLeft : ready })}
              </button>
            )}
          </div>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] gap-5 overflow-hidden">
        {/* -mx-1 -mt-1 px-1 pt-1 leave room for focus rings at the scroll edges without moving the layout. */}
        <div className="-mx-1 -mt-1 flex min-h-0 flex-col gap-2.5 overflow-auto px-1 pb-6 pt-1">
          <DropZone ref={dropRef} onPaths={onPaths} />
          {items.length === 0 ? (
            <p className="p-10 text-center text-body text-ink-4">{t('queue.empty')}</p>
          ) : (
            <ul ref={listRef} aria-label={t('queue.list')} tabIndex={-1} className="flex flex-col gap-2.5 outline-none">
              {items.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  track={installs[item.id]}
                  installedName={item.status === 'conflict' ? conflictTarget(item, hangar, items).name : ''}
                  conflictQueued={item.status === 'conflict' && Boolean(conflictTarget(item, hangar, items).queued)}
                  onInstall={onInstall}
                  onResolve={onResolve}
                  onPickVehicle={onPickVehicle}
                  onRemove={onRemove}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto pb-6">
          <WatchCard />
          <LegendCard />
        </div>
      </div>
      <p role="status" className="sr-only">
        {announcement.text}
        {announcement.seq % 2 === 1 ? ' ' : ''}
      </p>
      {conflictItem && (
        <ConflictDialog
          key={conflictItem.id}
          item={conflictItem}
          installed={conflictTarget(conflictItem, hangar, items)}
          onChoose={onChoose}
          onCancel={onCancelConflict}
          fallbackFocus={conflictFallback}
        />
      )}
    </ScreenFrame>
  );
}
