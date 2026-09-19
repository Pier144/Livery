import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { LEGEND_STATUSES, STATUS_TONE } from './queueModel';

/** "WHAT THE STATES MEAN": one line per status with its dot. */
export function LegendCard() {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 rounded-card border border-line-2 bg-bg-3 p-3.5">
      {/* ink-4, not the prototype's ink-5: README reserves ink-4 for ≥10px mono labels. */}
      <h2 id={titleId} className="font-mono text-mono-label uppercase text-ink-4">
        {t('queue.legend.title')}
      </h2>
      <ul className="flex flex-col gap-2">
        {LEGEND_STATUSES.map((status) => (
          <li key={status} className="flex gap-2.5 text-meta text-ink-3">
            <span aria-hidden className={cn('mt-1 h-2 w-2 flex-none rounded-full', STATUS_TONE[status].dot)} />
            <span>
              <span className="font-medium text-ink-1">{t(`queue.status.${status}`)}</span> — {t(`queue.legend.${status}`)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
