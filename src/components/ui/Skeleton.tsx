import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

/** Shimmering placeholder block (1.4s linear). Static under reduced motion. Never use spinners. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('bg-shimmer motion-safe:animate-shimmer', className)} />;
}

/** Explore/Hangar loading card: 16:9 shimmer + two text bars + action bar. */
export function SkeletonCard() {
  return (
    <div aria-hidden className="overflow-hidden rounded-card border border-line-2 bg-bg-3">
      <Skeleton className="aspect-video" />
      <div className="flex flex-col gap-2 p-3">
        <div className="h-3 w-[70%] rounded-tag bg-bg-skel" />
        <div className="h-2.5 w-1/2 rounded-tag bg-bg-4" />
        <div className="mt-1.5 h-btn rounded-ctl bg-bg-hover" />
      </div>
    </div>
  );
}

/** Grid of loading cards, announced once to screen readers. */
export function SkeletonGrid({ count = 8, className }: { count?: number; className?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className={cn('grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4', className)}>
      <span className="sr-only">{t('common.loading')}</span>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
