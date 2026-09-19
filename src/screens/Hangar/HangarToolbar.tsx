import { LayoutGrid, List } from 'lucide-react';
import { useMemo, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { ChipDropdown } from '@/components/ui/ChipDropdown';
import { SegmentedControl, type Segment } from '@/components/ui/SegmentedControl';
import { TextInput } from '@/components/ui/TextInput';
import { useHangarStore, type HangarView } from '@/store/hangar';
import type { HangarSkin } from '@/types';
import { presentValues } from './hangarModel';

interface HangarToolbarProps {
  /** The whole hangar: chip options list only values some skin has. */
  skins: readonly HangarSkin[];
  /** Skins the filters show, in on-screen order ("Select all" selects these). */
  visibleIds: readonly string[];
  /** Every visible skin is selected: the button becomes "Clear selection". */
  allVisibleSelected: boolean;
  selectAllRef?: Ref<HTMLButtonElement>;
}

/** Search (instant), Nation / Type / Origin chips, "Select all" and the grid/list switch. */
export function HangarToolbar({ skins, visibleIds, allVisibleSelected, selectAllRef }: HangarToolbarProps) {
  const { t } = useTranslation();
  const q = useHangarStore((s) => s.q);
  const filters = useHangarStore((s) => s.filters);
  const view = useHangarStore((s) => s.view);
  const setQuery = useHangarStore((s) => s.setQuery);
  const setFilter = useHangarStore((s) => s.setFilter);
  const setView = useHangarStore((s) => s.setView);
  const selectAll = useHangarStore((s) => s.selectAll);
  const clear = useHangarStore((s) => s.clear);

  const present = useMemo(() => presentValues(skins, filters), [skins, filters]);
  const viewOptions = useMemo<Segment<HangarView>[]>(
    () => [
      { value: 'grid', label: t('hangar.view.grid'), icon: LayoutGrid },
      { value: 'list', label: t('hangar.view.list'), icon: List },
    ],
    [t],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <TextInput
        value={q}
        onValueChange={setQuery}
        placeholder={t('hangar.search')}
        aria-label={t('hangar.searchLabel')}
        className="w-[260px]"
      />
      <ChipDropdown
        variant="label"
        label={t('hangar.filters.nation')}
        anyLabel={t('hangar.filters.anyNation')}
        value={filters.nation}
        options={present.nations.map((n) => ({ value: n, label: t(`hangar.nation.${n}`) }))}
        onChange={(v) => setFilter('nation', v)}
      />
      <ChipDropdown
        variant="label"
        label={t('hangar.filters.type')}
        anyLabel={t('hangar.filters.anyType')}
        value={filters.type}
        options={present.types.map((v) => ({ value: v, label: t(`hangar.type.${v}`) }))}
        onChange={(v) => setFilter('type', v)}
      />
      <ChipDropdown
        variant="label"
        label={t('hangar.filters.origin')}
        anyLabel={t('hangar.filters.anyOrigin')}
        value={filters.origin}
        options={present.origins.map((o) => ({ value: o, label: t(`hangar.origin.${o}`) }))}
        onChange={(v) => setFilter('origin', v)}
      />
      <div className="ml-auto flex items-center gap-2">
        <Button
          ref={selectAllRef}
          variant="ghost"
          size={28}
          disabled={visibleIds.length === 0}
          onClick={() => (allVisibleSelected ? clear() : selectAll(visibleIds))}
        >
          {allVisibleSelected ? t('hangar.clearSelection') : t('hangar.selectAll')}
        </Button>
        <SegmentedControl label={t('hangar.view.label')} value={view} options={viewOptions} onChange={setView} />
      </div>
    </div>
  );
}
