import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { TabIndicator, useTabIndicator } from '@/components/ui/TabIndicator';
import { cn } from '@/lib/cn';
import { useJustEntered } from '@/lib/motion';
import type { ExploreTab } from '@/store/explore';

const TABS: readonly ExploreTab[] = ['explore', 'following', 'forYou'];

const TAB_LABELS = { explore: 'explore.title', following: 'explore.following', forYou: 'explore.forYou.tab' } as const;

/** A tab's "N new" pill; when new skins show up it sends out two soft rings, then rests. Nothing at 0. */
function NewPill({ count }: { count: number }) {
  const { t } = useTranslation();
  const freshNews = useJustEntered(count > 0);
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'whitespace-nowrap rounded-pill border border-amber-50 px-1.5 py-px font-mono text-[10px] font-medium leading-[normal] text-amber',
        freshNews && 'motion-safe:animate-pill-pulse',
      )}
    >
      {t('explore.newCount', { count })}
    </span>
  );
}

export interface ExploreHeaderProps {
  tab: ExploreTab;
  onTab: (tab: ExploreTab) => void;
  /** "N new" pills per tab (Following: new skins from follows; For you: from the lineups); hidden at 0. */
  newCounts: Partial<Record<ExploreTab, number>>;
  /** "1,284 results", or nothing. */
  meta: string;
  tabId: (tab: ExploreTab) => string;
  panelId: (tab: ExploreTab) => string;
}

/**
 * Tabs Explore / Following / For you (WAI-ARIA tabs, automatic activation: ←/→, Home/End) with
 * their "N new" pills, and the result count on the right (a status region, so filter changes are
 * announced). Bottom rule line-2; the active tab's 2px amber underline sits on it and slides to
 * the next tab.
 */
export function ExploreHeader({ tab, onTab, newCounts, meta, tabId, panelId }: ExploreHeaderProps) {
  const { t } = useTranslation();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const indicator = useTabIndicator(listRef, tab);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
        next = (i + 1) % TABS.length;
        break;
      case 'ArrowLeft':
        next = (i - 1 + TABS.length) % TABS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = TABS.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const target = TABS[next];
    if (!target) return;
    refs.current[next]?.focus();
    onTab(target);
  };

  return (
    <div className="flex items-end justify-between gap-4 border-b border-line-2">
      <div ref={listRef} role="tablist" aria-label={t('explore.tabs')} className="relative flex gap-5.5">
        {TABS.map((id, i) => {
          const selected = id === tab;
          return (
            <button
              key={id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={tabId(id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTab(id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 pb-2.5 pt-1.5 text-card leading-[normal] motion-safe:transition-colors motion-safe:duration-120',
                selected ? cn('text-ink-1', indicator ? 'border-transparent' : 'border-amber') : 'border-transparent text-ink-3 hover:text-ink-1',
              )}
            >
              {t(TAB_LABELS[id])}
              <NewPill count={newCounts[id] ?? 0} />
            </button>
          );
        })}
        <TabIndicator box={indicator} />
      </div>
      <span role="status" className="min-w-0 truncate pb-2.5 font-mono text-mono-sm leading-[normal] tracking-[.04em] text-ink-4">
        {meta}
      </span>
    </div>
  );
}
