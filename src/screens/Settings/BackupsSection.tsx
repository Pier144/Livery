import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { formatBytes } from '@/lib/format';
import { call, hasBackend, toAppError } from '@/lib/tauri';
import { BACKUPS_KEY } from '@/queries/settings';
import { toast } from '@/store/toasts';
import type { AppError, Backup } from '@/types';
import { SectionTitle, SettingGroup, SettingRow, UNAVAILABLE } from './SettingRow';
import { useSettingsUi } from './settingsUi';
import { useSettingsPatch } from './useSettingsPatch';


const NONE: Backup[] = [];

/** Kept backups (`list_backups`), read again each time the section opens and when the window regains focus. */
export function useBackups() {
  return useQuery<Backup[], AppError>({
    queryKey: BACKUPS_KEY,
    queryFn: () => (hasBackend() ? call<Backup[]>('list_backups') : Promise.resolve(NONE)),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

/**
 * Backups: the keep-a-backup switch and what's on disk. Clear is permanent on the backend, so it is
 * deferred: the listed backups vanish from the UI at once, the toast offers Undo for 6 s, and
 * `clear_backups` runs only when the toast leaves without Undo — with the ids listed when Clear was
 * pressed, so a backup made during the Undo window (a delete or replace elsewhere) survives and
 * shows up. Clear is unavailable while one is pending.
 */
export function BackupsSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { settings, patch } = useSettingsPatch();
  const backups = useBackups();
  const clearing = useSettingsUi((s) => s.clearingBackups);

  const shown = useMemo(() => {
    if (!clearing || !backups.data) return backups.data;
    const pending = new Set(clearing);
    return backups.data.filter((b) => !pending.has(b.id));
  }, [backups.data, clearing]);
  const count = shown?.length ?? 0;
  const size = shown?.reduce((sum, b) => sum + b.sizeBytes, 0) ?? 0;
  const canClear = !clearing && !!shown && count > 0;

  const clear = () => {
    const listed = backups.data;
    if (!canClear || !listed) return;
    const ids = listed.map((b) => b.id);
    useSettingsUi.setState({ clearingBackups: ids });
    toast.undoable(
      t('settings.backups.cleared', { count: ids.length }),
      () => useSettingsUi.setState({ clearingBackups: null }),
      async () => {
        try {
          await call('clear_backups', { ids });
          const gone = new Set(ids);
          qc.setQueryData<Backup[]>(BACKUPS_KEY, (list) => list?.filter((b) => !gone.has(b.id)));
        } catch (e) {
          toast(toAppError(e).message);
        } finally {
          useSettingsUi.setState({ clearingBackups: null });
          void qc.invalidateQueries({ queryKey: BACKUPS_KEY });
        }
      },
    );
  };

  let summary: ReactNode;
  if (shown) {
    summary = t('settings.backups.summary', { count, size: formatBytes(size) });
  } else if (backups.isError) {
    summary = t('settings.backups.unavailable');
  } else {
    summary = (
      <>
        <Skeleton className="mt-0.5 h-2.5 w-28 rounded-tag" />
        <span className="sr-only">{t('common.loading')}</span>
      </>
    );
  }

  return (
    <>
      <SectionTitle>{t('settings.nav.backups')}</SectionTitle>
      <SettingGroup>
        <SettingRow label={t('settings.backups.keep')} helper={t('settings.backups.keepHelper', { count: settings.backupDays })}>
          {({ labelId, helperId }) => (
            <Switch
              checked={settings.backups}
              onChange={(next) => patch({ backups: next })}
              aria-labelledby={labelId}
              aria-describedby={helperId}
            />
          )}
        </SettingRow>
        <SettingRow label={t('settings.backups.onDisk')} helper={summary} mono>
          {({ labelId, helperId }) => (
            // Stays focusable when there is nothing to clear, so focus isn't lost right after a Clear.
            <Button
              variant="secondary"
              size={28}
              onClick={clear}
              aria-disabled={!canClear || undefined}
              aria-describedby={`${labelId} ${helperId ?? ''}`.trim()}
              className={`${UNAVAILABLE} aria-disabled:hover:border-line-3`}
            >
              {t('settings.backups.clear')}
            </Button>
          )}
        </SettingRow>
      </SettingGroup>
    </>
  );
}
