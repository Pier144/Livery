import { useTranslation } from 'react-i18next';
import { useQueue } from '@/store/queue';
import { ScreenFrame, ScreenHeader } from './ScreenHeader';

/**
 * M1 placeholder: shows archives dropped on the window while they wait for analysis.
 * Statuses, actions, the drop zone and the conflict dialog land in M4.
 */
export function Queue() {
  const { t } = useTranslation();
  const items = useQueue((s) => s.items);
  return (
    <ScreenFrame label={t('queue.title')}>
      <ScreenHeader title={t('queue.title')} meta={t('common.comingIn', { milestone: 'M4' })} />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto pb-6">
        <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-line-4 bg-bg-input p-[26px] text-center">
          <span className="text-card">{t('queue.dropZone')}</span>
          <span className="text-meta text-ink-4">{t('queue.browse')}</span>
        </div>
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="grid grid-cols-[8px_1fr_auto] items-center gap-3 rounded-card border border-line-2 bg-bg-3 px-3.5 py-3"
            >
              <span aria-hidden className="h-2 w-2 rounded-full bg-ink-5 motion-safe:animate-pulse6" />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate font-mono text-mono-data text-ink-1">{item.fileName}</span>
                <span className="text-meta text-ink-3">{t('common.drop.analyzing')}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ScreenFrame>
  );
}
