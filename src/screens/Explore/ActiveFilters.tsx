import { X } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { vehicles } from '@/data/vehicles';
import { cn } from '@/lib/cn';
import { useExplore, type ExploreFilterKey } from '@/store/explore';
import { activeFilters, vehicleLabel } from './exploreModel';

/**
 * "3 filters combined | Germany × Ground × Historical × Clear all" (mono 11px). Hidden (not
 * unmounted) when no filter is set, so focus can move on after the last one is removed:
 * to the next filter, else the previous one, else `onEmpty` (the filter row).
 */
export function ActiveFilters({ onEmpty }: { onEmpty: () => void }) {
  const { t } = useTranslation();
  const q = useExplore((s) => s.q);
  const nation = useExplore((s) => s.nation);
  const type = useExplore((s) => s.type);
  const klass = useExplore((s) => s.class);
  const vehicle = useExplore((s) => s.vehicle);
  const category = useExplore((s) => s.category);
  const clear = useExplore((s) => s.clear);
  const clearAll = useExplore((s) => s.clearAll);

  const list = activeFilters(
    { q, nation, type, class: klass, vehicle, category },
    {
      nation: (n) => t(`hangar.nation.${n}`),
      type: (v) => t(`hangar.type.${v}`),
      category: (c) => t(`explore.category.${c}`),
      vehicle: (code) => vehicleLabel(vehicles, code),
      query: (text) => t('explore.filters.query', { q: text }),
    },
  );

  const ref = useRef<HTMLDivElement>(null);
  /** Index of the filter button that was just removed (−1: Clear all), until focus has moved. */
  const pendingFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingFocus.current;
    if (at === null) return;
    pendingFocus.current = null;
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[data-filter]') ?? [])];
    const next = at >= 0 ? (buttons[at] ?? buttons[buttons.length - 1]) : undefined;
    if (next) next.focus();
    else onEmpty();
  });

  const remove = (key: ExploreFilterKey, index: number) => {
    pendingFocus.current = index;
    clear(key);
  };

  return (
    <div
      ref={ref}
      hidden={list.length === 0}
      // The class, not only the attribute: Tailwind's `flex` would override `[hidden]`.
      className={cn('flex-wrap items-center gap-2 font-mono text-mono-sm leading-[normal] text-ink-4', list.length === 0 ? 'hidden' : 'flex')}
    >
      <span>{t('explore.filters.active', { count: list.length })}</span>
      <span aria-hidden className="text-line-3">
        |
      </span>
      {list.map((f, i) => (
        <button
          key={f.key}
          type="button"
          data-filter={f.key}
          aria-label={t('explore.filters.remove', { label: f.label })}
          onClick={() => remove(f.key, i)}
          className="inline-flex items-center gap-1 text-ink-2 hover:text-amber motion-safe:transition-colors motion-safe:duration-120"
        >
          {f.label}
          <X size={12} strokeWidth={1.75} aria-hidden />
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          pendingFocus.current = -1;
          clearAll();
        }}
        className="ml-1.5 text-amber hover:text-amber-hover motion-safe:transition-colors motion-safe:duration-120"
      >
        {t('explore.filters.clearAll')}
      </button>
    </div>
  );
}
