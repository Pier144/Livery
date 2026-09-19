import { useTranslation } from 'react-i18next';
import { SkeletonGrid } from '@/components/ui/Skeleton';
import { ScreenFrame } from './ScreenHeader';

/** M1 placeholder: tab row + loading grid. The real screen lands in M5. */
export function Explore() {
  const { t } = useTranslation();
  return (
    <ScreenFrame label={t('explore.title')}>
      <div className="flex items-end justify-between border-b border-line-2">
        <div className="flex gap-5.5">
          <span className="-mb-px border-b-2 border-amber pb-2.5 pt-1.5 text-card text-ink-1">{t('explore.title')}</span>
          <span className="-mb-px border-b-2 border-transparent pb-2.5 pt-1.5 text-card text-ink-3">{t('explore.following')}</span>
        </div>
        <span className="pb-2.5 font-mono text-mono-sm text-ink-4">{t('common.comingIn', { milestone: 'M5' })}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SkeletonGrid />
      </div>
    </ScreenFrame>
  );
}
