import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { baseName } from '@/lib/format';
import { isTauri, toAppError } from '@/lib/tauri';
import { useSetCollectionSkins } from '@/queries/collections';
import { useDeleteSkins, useExportSkins, useRescan, useRestoreBackups, useSetSkinActive } from '@/queries/hangar';
import { useHangarStore } from '@/store/hangar';
import { toast } from '@/store/toasts';
import type { Collection, HangarSkin } from '@/types';

/** An Active/Inactive change shown before the backend confirms it (the toggle feels instant). */
interface PendingActive {
  active: boolean;
  /** Which request set it: only that request's end removes it. */
  token: number;
}

function reportError(e: unknown) {
  toast(toAppError(e).message);
}

/**
 * Everything My Hangar does to skins: Active toggles (optimistic), Re-check and the bulk actions.
 * Callbacks use `mutateAsync` so every request settles its own UI, however many overlap.
 * `afterBulk` runs once a bulk action has cleared the selection (the bar is about to disappear).
 */
export function useHangarActions(afterBulk: (removed?: readonly string[]) => void) {
  const { t } = useTranslation();
  // `mutateAsync` is stable across renders (the result objects are not): handlers stay memoized.
  const { mutateAsync: setActive } = useSetSkinActive();
  const { mutateAsync: deleteSkins } = useDeleteSkins();
  const { mutateAsync: restoreBackups } = useRestoreBackups();
  const { mutateAsync: exportSkins } = useExportSkins();
  const { mutateAsync: setCollectionSkins } = useSetCollectionSkins();
  const { mutateAsync: rescan } = useRescan();
  const clearSelection = useHangarStore((s) => s.clear);

  const [pending, setPending] = useState<ReadonlyMap<string, PendingActive>>(() => new Map());
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const token = useRef(0);
  const busy = useRef(false);
  const scanning = useRef(false);

  /** Skins with the pending Active changes applied. */
  const withPending = useCallback(
    (skins: HangarSkin[]): HangarSkin[] => {
      if (pending.size === 0) return skins;
      return skins.map((s) => {
        const p = pending.get(s.id);
        return p && p.active !== s.active ? { ...s, active: p.active } : s;
      });
    },
    [pending],
  );

  const applyActive = useCallback(
    async (ids: string[], active: boolean): Promise<boolean> => {
      const mine = ++token.current;
      setPending((prev) => {
        const next = new Map(prev);
        ids.forEach((id) => next.set(id, { active, token: mine }));
        return next;
      });
      try {
        await setActive({ ids, active });
        return true;
      } catch (e) {
        reportError(e);
        return false;
      } finally {
        setPending((prev) => {
          const next = new Map(prev);
          ids.forEach((id) => {
            if (next.get(id)?.token === mine) next.delete(id);
          });
          return next.size === prev.size ? prev : next;
        });
      }
    },
    [setActive],
  );

  const toggleActive = useCallback((skin: HangarSkin) => void applyActive([skin.id], !skin.active), [applyActive]);

  const recheck = useCallback(
    async (skin: HangarSkin) => {
      if (scanning.current) return;
      scanning.current = true;
      setRechecking(skin.id);
      try {
        const found = (await rescan()).find((s) => s.id === skin.id);
        const key = !found ? 'hangar.toast.recheckGone' : found.attention?.length ? 'hangar.toast.recheckStill' : 'hangar.toast.recheckOk';
        toast(t(key, { name: skin.name }));
      } catch (e) {
        reportError(e);
      } finally {
        scanning.current = false;
        setRechecking(null);
      }
    },
    [rescan, t],
  );

  /** One bulk action at a time; the bar ignores clicks meanwhile. */
  const runBulk = useCallback(async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setBulkBusy(true);
    try {
      await action();
    } finally {
      busy.current = false;
      setBulkBusy(false);
    }
  }, []);

  /** `removed`: skins the action deleted (focus must not go back to them). */
  const endBulk = useCallback(
    (removed?: readonly string[]) => {
      clearSelection();
      afterBulk(removed);
    },
    [clearSelection, afterBulk],
  );

  const activateMany = useCallback(
    (ids: string[], active: boolean) =>
      runBulk(async () => {
        if (!(await applyActive(ids, active))) return;
        endBulk();
        toast(t(active ? 'hangar.toast.activated' : 'hangar.toast.deactivated', { count: ids.length }));
      }),
    [runBulk, applyActive, endBulk, t],
  );

  const deleteMany = useCallback(
    (ids: string[]) =>
      runBulk(async () => {
        let backupIds: string[];
        try {
          ({ backupIds } = await deleteSkins(ids));
        } catch (e) {
          reportError(e);
          return;
        }
        endBulk(ids);
        // Folders already gone from disk have no backup: nothing to undo, but the user still hears about it.
        if (backupIds.length === 0) {
          toast(t('hangar.toast.deleted', { count: ids.length }));
          return;
        }
        // The backend keeps a backup of each deleted folder; Undo puts them back.
        toast.undoable(t('hangar.toast.deleted', { count: ids.length }), async () => {
          try {
            const restored = await restoreBackups(backupIds);
            toast(t('hangar.toast.restored', { count: restored.length }));
          } catch (e) {
            reportError(e);
          }
        });
      }),
    [runBulk, deleteSkins, restoreBackups, endBulk, t],
  );

  const moveMany = useCallback(
    (ids: string[], collection: Collection) =>
      runBulk(async () => {
        try {
          await setCollectionSkins({ id: collection.id, add: ids });
        } catch (e) {
          reportError(e);
          return;
        }
        endBulk();
        toast(t('hangar.toast.moved', { count: ids.length, collection: collection.name }));
      }),
    [runBulk, setCollectionSkins, endBulk, t],
  );

  /** Folder picker, then a copy of each skin folder there. Needs the desktop app (no-op otherwise). */
  const exportMany = useCallback(
    (ids: string[]) =>
      runBulk(async () => {
        if (!isTauri()) return;
        let dest: string | null;
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const picked = await open({ directory: true, title: t('hangar.bulk.exportTitle') });
          dest = typeof picked === 'string' ? picked : null;
        } catch (e) {
          reportError(e);
          return;
        }
        if (!dest) return;
        try {
          const result = await exportSkins({ ids, dest });
          // Paths stay hidden in the UI: only the folder's name is shown.
          toast(t('hangar.toast.exported', { count: result.exported, folder: baseName(result.dest.replace(/[\\/]+$/, '')) || result.dest }));
        } catch (e) {
          reportError(e);
        }
      }),
    [runBulk, exportSkins, t],
  );

  return useMemo(
    () => ({ withPending, toggleActive, recheck, rechecking, bulkBusy, activateMany, deleteMany, moveMany, exportMany }),
    [withPending, toggleActive, recheck, rechecking, bulkBusy, activateMany, deleteMany, moveMany, exportMany],
  );
}
