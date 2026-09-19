import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import type { ExploreTab } from '@/store/explore';

const TABS: readonly ExploreTab[] = ['explore', 'following'];

export interface ExploreHeaderProps {
  tab: ExploreTab;
  onTab: (tab: ExploreTab) => void;
  /** New skins from follows (the Following tab's pill; hidden at 0). */
  newCount: number;
  /** "1,284 results · 24 ms", or nothing. */
  meta: string;
  tabId: (tab: ExploreTab) => string;
  panelId: (tab: ExploreTab) => string;
}

/**
 * Tabs Explore / Following (WAI-ARIA tabs, automatic activation: ←/→, Home/End) with the "N new"
 * pill, and the result count + query time on the right (a status region, so filter changes are
 * announced). Bottom rule line-2; the active tab's 2px amber underline sits on it.
 */
export function ExploreHeader({ tab, onTab, newCount, meta, tabId, panelId }: ExploreHeaderProps) {
  const { t } = useTranslation();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

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
      <div role="tablist" aria-label={t('explore.tabs')} className="flex gap-5.5">
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
                selected ? 'border-amber text-ink-1' : 'border-transparent text-ink-3 hover:text-ink-1',
              )}
            >
              {id === 'explore' ? t('explore.title') : t('explore.following')}
              {id === 'following' && newCount > 0 && (
                <span className="whitespace-nowrap rounded-pill border border-amber-50 px-1.5 py-px font-mono text-[10px] font-medium leading-[normal] text-amber">
                  {t('explore.newCount', { count: newCount })}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <span role="status" className="min-w-0 truncate pb-2.5 font-mono text-mono-sm leading-[normal] tracking-[.04em] text-ink-4">
        {meta}
      </span>
    </div>
  );
}
