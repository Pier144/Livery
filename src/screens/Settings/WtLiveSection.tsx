import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { errorText } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { useClearWtLiveCache, useUnhideAllWtLive, useWtLiveStorage } from '@/queries/wtlive';
import { toast } from '@/store/toasts';
import type { AppError } from '@/types';
import { SectionTitle, SettingGroup, SettingRow, UNAVAILABLE } from './SettingRow';
import { useSettingsPatch } from './useSettingsPatch';

/** 11px mono ink-4 value under a row's helper (sizes, counts), or its skeleton while loading. */
function Value({ children, loading }: { children: ReactNode; loading: boolean }) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <>
        <Skeleton className="mt-1 h-2.5 w-16 rounded-tag" />
        <span className="sr-only">{t('common.loading')}</span>
      </>
    );
  }
  return <span className="pt-0.5 font-mono text-mono-sm leading-[normal] text-ink-4">{children}</span>;
}

/**
 * WT Live (docs/wtlive-terms.md §7): the kill switch (Browse WT Live off → Livery sends WT Live no
 * request at all), the cache kept from WT Live and the skins hidden from Explore. Cache and hidden
 * skins are local (`wtlive_storage`), so the section works offline and with browsing off. Clearing
 * the cache isn't undoable (it is only a cache); hidden skins come back all at once.
 */
export function WtLiveSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettingsPatch();
  const storage = useWtLiveStorage();
  const clearCache = useClearWtLiveCache();
  const unhideAll = useUnhideAllWtLive();
  const data = storage.data;
  const loading = !data && !storage.isError;

  const canClear = !!data && !clearCache.isPending;
  const canUnhide = !!data && data.hiddenCount > 0 && !unhideAll.isPending;

  const clear = () => {
    if (!canClear) return;
    clearCache.mutateAsync().then(
      () => toast(t('settings.wtlive.cacheCleared')),
      (e: AppError) => toast(errorText(e, t)),
    );
  };

  const unhide = () => {
    if (!canUnhide) return;
    unhideAll.mutateAsync().then(
      () => toast(t('settings.wtlive.unhidden')),
      (e: AppError) => toast(errorText(e, t)),
    );
  };

  const unavailable = storage.isError ? t('settings.wtlive.unavailable') : undefined;

  return (
    <>
      <SectionTitle>{t('settings.nav.wtlive')}</SectionTitle>
      <SettingGroup>
        <SettingRow label={t('settings.wtlive.browse')} helper={t('settings.wtlive.browseHelper')}>
          {({ labelId, helperId }) => (
            <Switch
              checked={settings.wtliveEnabled}
              onChange={(next) => patch({ wtliveEnabled: next })}
              aria-labelledby={labelId}
              aria-describedby={helperId}
            />
          )}
        </SettingRow>
        <SettingRow
          label={t('settings.wtlive.cache')}
          helper={t('settings.wtlive.cacheHelper')}
          details={<Value loading={loading}>{unavailable ?? (data ? formatBytes(data.cacheBytes) : '')}</Value>}
        >
          {({ labelId }) => (
            <Button
              variant="secondary"
              size={28}
              onClick={clear}
              aria-disabled={!canClear || undefined}
              aria-describedby={labelId}
              className={`${UNAVAILABLE} aria-disabled:hover:border-line-3`}
            >
              {t('settings.wtlive.clearCache')}
            </Button>
          )}
        </SettingRow>
        <SettingRow
          label={t('settings.wtlive.hidden')}
          helper={t('settings.wtlive.hiddenHelper')}
          details={<Value loading={loading}>{unavailable ?? (data ? t('settings.wtlive.hiddenCount', { count: data.hiddenCount }) : '')}</Value>}
        >
          {({ labelId }) => (
            // Stays focusable at 0, so focus isn't lost right after showing them again.
            <Button
              variant="secondary"
              size={28}
              onClick={unhide}
              aria-disabled={!canUnhide || undefined}
              aria-describedby={labelId}
              className={`${UNAVAILABLE} aria-disabled:hover:border-line-3`}
            >
              {t('settings.wtlive.showAgain')}
            </Button>
          )}
        </SettingRow>
      </SettingGroup>
      <p className="text-meta leading-[normal] text-ink-4">{t('settings.wtlive.attribution')}</p>
    </>
  );
}
