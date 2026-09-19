import { ChevronDown } from 'lucide-react';
import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChipDropdown } from '@/components/ui/ChipDropdown';
import { Menu } from '@/components/ui/Menu';
import { SegmentedControl, type Segment } from '@/components/ui/SegmentedControl';
import { vehicles } from '@/data/vehicles';
import { useExplore } from '@/store/explore';
import type { SortOrder, VehicleType } from '@/types';
import { classOptions, EXPLORE_CATEGORIES, EXPLORE_NATIONS, EXPLORE_SORTS, EXPLORE_TYPES } from './exploreModel';
import { VehicleInput } from './VehicleInput';

type TypeValue = VehicleType | 'all';

/**
 * Explore filter row (28px controls, gap 8, wraps): Nation · Type · Class · Vehicle · Category,
 * Sort on the right. Everything applies at once and combines (AND).
 */
export const FilterRow = forwardRef<HTMLDivElement>(function FilterRow(_, ref) {
  const { t } = useTranslation();
  const nation = useExplore((s) => s.nation);
  const type = useExplore((s) => s.type);
  const klass = useExplore((s) => s.class);
  const category = useExplore((s) => s.category);
  const sort = useExplore((s) => s.sort);
  const setNation = useExplore((s) => s.setNation);
  const setType = useExplore((s) => s.setType);
  const setClass = useExplore((s) => s.setClass);
  const setCategory = useExplore((s) => s.setCategory);
  const setSort = useExplore((s) => s.setSort);

  const typeOptions: Segment<TypeValue>[] = [
    { value: 'all', label: t('explore.filters.allTypes') },
    ...EXPLORE_TYPES.map((v) => ({ value: v, label: t(`hangar.type.${v}`) })),
  ];

  return (
    <div ref={ref} role="group" aria-label={t('explore.filters.label')} className="flex flex-wrap items-center gap-2">
      <ChipDropdown
        label={t('explore.filters.nation')}
        value={nation}
        options={EXPLORE_NATIONS.map((n) => ({ value: n, label: t(`hangar.nation.${n}`) }))}
        onChange={setNation}
        menuWidthClass="min-w-[170px]"
      />
      <SegmentedControl<TypeValue>
        label={t('explore.filters.type')}
        value={type ?? 'all'}
        options={typeOptions}
        onChange={(v) => setType(v === 'all' ? null : v)}
      />
      <ChipDropdown
        label={t('explore.filters.class')}
        value={klass}
        options={classOptions(vehicles, type, klass).map((c) => ({ value: c, label: c }))}
        onChange={setClass}
        menuWidthClass="min-w-[180px]"
      />
      <VehicleInput />
      <ChipDropdown
        label={t('explore.filters.category')}
        value={category}
        options={EXPLORE_CATEGORIES.map((c) => ({ value: c, label: t(`explore.category.${c}`) }))}
        onChange={setCategory}
        menuWidthClass="min-w-[180px]"
      />
      <Menu
        kind="radio"
        className="ml-auto"
        align="end"
        label={t('explore.filters.sort')}
        value={sort}
        items={EXPLORE_SORTS.map((s) => ({ value: s, label: t(`explore.sort.${s}`) }))}
        onSelect={(v) => setSort(v as SortOrder)}
        menuWidthClass="min-w-[180px]"
        renderTrigger={(props) => (
          <button
            {...props}
            className="flex h-ctl items-center gap-2 whitespace-nowrap rounded-ctl px-2.5 text-meta leading-[normal] text-ink-3 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
          >
            {t('explore.filters.sort')} <span className="text-ink-1">{t(`explore.sort.${sort}`)}</span>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="flex-none text-ink-5" />
          </button>
        )}
      />
    </div>
  );
});
