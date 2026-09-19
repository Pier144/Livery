import { ArrowLeft } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useUi } from '@/store/ui';
import { DETAIL_TABS, rovingIndex, type DetailTab } from './detailModel';

export interface TabIds {
  tab: (tab: DetailTab) => string;
  panel: (tab: DetailTab) => string;
}

/** Horizontal tabs: ↑ ↓ are left to the page. */
const TAB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

interface DetailTopBarProps {
  /** Name and code; a skeleton (or nothing) while the post loads. */
  title?: ReactNode;
  /** Tabs appear once the skin is loaded. */
  tabs?: { active: DetailTab; ids: TabIds; onSelect: (tab: DetailTab) => void };
}

/**
 * Top bar (padding 12 24, bottom rule): "← Explore", name + mono code, and the Gallery / Textures /
 * Try in game tabs (WAI-ARIA tabs, automatic activation: ← → Home End move and select).
 */
export function DetailTopBar({ title, tabs }: DetailTopBarProps) {
  const { t } = useTranslation();
  const go = useUi((s) => s.go);
  const refs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!tabs || !TAB_KEYS.has(e.key)) return;
    const next = rovingIndex(e.key, DETAIL_TABS.indexOf(tabs.active), DETAIL_TABS.length);
    const tab = next === null ? undefined : DETAIL_TABS[next];
    if (!tab) return;
    e.preventDefault();
    tabs.onSelect(tab);
    refs.current[tab]?.focus();
  };

  return (
    <div className="flex flex-none items-center gap-3.5 border-b border-line-2 bg-bg-2/70 px-6 py-3">
      <Button size={28} aria-label={t('detail.backLabel')} onClick={() => go('explore')}>
        <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
        {t('detail.back')}
      </Button>
      <div className="flex min-w-0 flex-1 items-baseline gap-3">{title}</div>
      {tabs && (
        <div role="tablist" aria-label={t('detail.tabs.label')} className="flex flex-none gap-1" onKeyDown={onKeyDown}>
          {DETAIL_TABS.map((tab) => {
            const selected = tab === tabs.active;
            return (
              <button
                key={tab}
                ref={(el) => {
                  refs.current[tab] = el;
                }}
                type="button"
                role="tab"
                id={tabs.ids.tab(tab)}
                aria-selected={selected}
                // Only the shown panel exists in the DOM.
                aria-controls={selected ? tabs.ids.panel(tab) : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => tabs.onSelect(tab)}
                className={cn(
                  'h-ctl whitespace-nowrap border-b-2 px-3 text-body font-medium leading-none motion-safe:transition-colors motion-safe:duration-120',
                  selected ? 'border-amber text-ink-1' : 'border-transparent text-ink-3 hover:text-ink-1',
                )}
              >
                {t(`detail.tabs.${tab}`)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Skin name (500 16px) + mono code (11px ink-4). */
export function DetailTitle({ name, code }: { name: string; code: string }) {
  return (
    <>
      <h1 className="truncate text-heading" title={name}>
        {name}
      </h1>
      <span data-selectable className="flex-none font-mono text-mono-sm text-ink-4">
        {code}
      </span>
    </>
  );
}
