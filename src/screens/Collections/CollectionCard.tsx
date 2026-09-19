import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import type { Collection } from '@/types';

interface CollectionCardProps {
  collection: Collection;
  /** Members found in My Hangar. */
  count: number;
  /** Shown on the right. */
  open: boolean;
  /** The collection in use in the game. */
  active: boolean;
  onOpen: () => void;
}

/** Left-column card: `role=button`, Enter/Space open it, `aria-current` marks the open one. */
export function CollectionCard({ collection, count, open, active, onOpen }: CollectionCardProps) {
  const { t } = useTranslation();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);

  // Keep the open card in view (a new collection lands at the end of the list).
  useEffect(() => {
    if (open) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  const describedBy = [active && `${id}-badge`, collection.description && `${id}-desc`, `${id}-count`]
    .filter(Boolean)
    .join(' ');

  return (
    <li>
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        aria-current={open ? 'true' : undefined}
        aria-labelledby={`${id}-name`}
        aria-describedby={describedBy}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          onOpen();
        }}
        className={cn(
          'flex cursor-pointer flex-col gap-2 rounded-card border bg-bg-3 px-3.5 py-3 motion-safe:transition-colors motion-safe:duration-120',
          open ? 'border-amber' : 'border-line-2 hover:border-line-mark',
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span id={`${id}-name`} className="min-w-0 truncate text-card leading-[normal] text-ink-1">
            {collection.name}
          </span>
          {active && (
            <span id={`${id}-badge`} className="flex-none font-mono text-[10px] leading-[normal] tracking-[.06em] text-amber">
              {t('collections.activeBadge')}
            </span>
          )}
        </div>
        {collection.description && (
          <p id={`${id}-desc`} className="text-meta leading-[normal] text-ink-3">
            {collection.description}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <span id={`${id}-count`} className="font-mono text-mono-sm leading-[normal] text-ink-4">
            {t('collections.count', { count })}
          </span>
          {/* Same fact as the "Active" badge, which screen readers already get. */}
          {active && (
            <span aria-hidden className="text-[11px] font-medium leading-[normal] text-amber">
              {t('collections.inUse')}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
