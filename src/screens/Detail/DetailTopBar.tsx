import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
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
  /** The loaded skin: its name is the page's `<h1>` (500 16px), then the mono code (11px ink-4). */
  skin?: { name: string; code: string };
  /** Shown instead of the name while the post loads (a skeleton); the `<h1>` is then "Skin detail". */
  placeholder?: ReactNode;
  /** Tabs appear once the skin is loaded. */
  tabs?: { active: DetailTab; ids: TabIds; onSelect: (tab: DetailTab) => void };
}

/**
 * Top bar (padding 12 24, bottom rule): the back button, name + mono code, and the Gallery /
 * Textures / Try in game tabs (WAI-ARIA tabs, automatic activation: ← → Home End move and select).
 *
 * Every variant (loading, loaded, offline, error) has an `<h1>`. Opening the detail, another skin
 * or the loaded post removes the control that had focus (the Explore card, the skeleton's heading,
 * Retry); the heading then takes it, so screen readers announce the page and Tab starts from it.
 */
export function DetailTopBar({ skin, placeholder, tabs }: DetailTopBarProps) {
  const { t } = useTranslation();
  const refs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});
  const headingRef = useRef<HTMLHeadingElement>(null);
  const skinId = useUi((s) => s.detailSkinId);

  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus({ preventScroll: true });
  }, [skinId]);

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
      <BackButton />
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        {skin ? (
          <>
            <h1 ref={headingRef} tabIndex={-1} className="truncate text-heading outline-none" title={skin.name}>
              {skin.name}
            </h1>
            <span data-selectable className="flex-none font-mono text-mono-sm text-ink-4">
              {skin.code}
            </span>
          </>
        ) : (
          <>
            <h1 ref={headingRef} tabIndex={-1} className="sr-only">
              {t('detail.label')}
            </h1>
            {placeholder}
          </>
        )}
      </div>
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

/**
 * "← {section}": back to where the detail was opened from (`ui.detailReturnTo`, Explore by
 * default), named with the sidebar label; the accessible name reads "Back to {section}". Focus
 * returns to the skin's card there (`ui.leaveDetail`, `useScreenFocus`).
 */
function BackButton() {
  const { t } = useTranslation();
  const leaveDetail = useUi((s) => s.leaveDetail);
  const returnTo = useUi((s) => s.detailReturnTo);
  return (
    <Button size={28} aria-label={t(`detail.backTo.${returnTo}`)} onClick={leaveDetail}>
      <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
      {t(`common.nav.${returnTo}`)}
    </Button>
  );
}
