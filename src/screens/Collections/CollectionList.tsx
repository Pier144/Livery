import { Plus } from 'lucide-react';
import { forwardRef, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import type { Collection } from '@/types';
import { CollectionCard } from './CollectionCard';

interface CollectionListProps {
  /** `undefined` while loading: skeleton cards. */
  collections: Collection[] | undefined;
  activeId: string | undefined;
  openId: string | undefined;
  /** Members found in My Hangar, per collection id. */
  counts: ReadonlyMap<string, number>;
  onOpen: (id: string) => void;
  onNew: () => void;
  creating: boolean;
}

/** Left column: title, "+ New", the helper line and one card per collection. */
export const CollectionList = forwardRef<HTMLUListElement, CollectionListProps>(function CollectionList(
  { collections, activeId, openId, counts, onOpen, onNew, creating },
  ref,
) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-auto border-r border-line-2 px-5 py-4.5">
      <div className="flex items-center justify-between gap-3">
        <h1 id={headingId} tabIndex={-1} className="text-card outline-none">
          {t('collections.title')}
        </h1>
        <Button size={26} aria-label={t('collections.newCollection')} onClick={() => !creating && onNew()}>
          {/* One child, so the button's 8px gap doesn't apply: "+ New" stays as tight as the prototype. */}
          <span className="flex items-center gap-1">
            <Plus size={14} strokeWidth={1.75} aria-hidden className="-ml-0.5" />
            {t('collections.new')}
          </span>
        </Button>
      </div>
      <p className="text-meta leading-[1.5] text-ink-3">{t('collections.helper')}</p>
      {collections ? (
        <ul ref={ref} aria-labelledby={headingId} className="flex flex-col gap-3">
          {collections.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              count={counts.get(c.id) ?? 0}
              open={c.id === openId}
              active={c.id === activeId}
              onOpen={() => onOpen(c.id)}
            />
          ))}
        </ul>
      ) : (
        <div role="status" aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">{t('common.loading')}</span>
          {[0, 1, 2].map((i) => (
            <div key={i} aria-hidden className="flex flex-col gap-2.5 rounded-card border border-line-2 bg-bg-3 px-3.5 py-3">
              <Skeleton className="h-3.5 w-1/2 rounded-tag" />
              <Skeleton className="h-3 w-4/5 rounded-tag" />
              <Skeleton className="h-2.5 w-1/4 rounded-tag" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
