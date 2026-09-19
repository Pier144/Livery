import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { errorText } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { useHangar } from '@/queries/hangar';
import { useHangarStore } from '@/store/hangar';
import { useUi } from '@/store/ui';
import type { Collection, HangarSkin } from '@/types';
import { BulkBar } from './Hangar/BulkBar';
import { HangarGrid } from './Hangar/HangarGrid';
import { filterSkins, groupSkins, hangarStats, hasFilters, orderedIds } from './Hangar/hangarModel';
import { HangarToolbar } from './Hangar/HangarToolbar';
import { useHangarActions } from './Hangar/useHangarActions';
import { ScreenFrame, ScreenHeader } from './ScreenHeader';

const NO_SKINS: HangarSkin[] = [];

/**
 * My Hangar (README §4): installed skins grouped by vehicle, grid or list, search + chip filters,
 * selection with a bulk bar (Activate, Deactivate, Move to collection, Export, undoable Delete).
 * Bulk actions only touch selected skins the current filters show.
 */
export function Hangar() {
  const { t } = useTranslation();
  const go = useUi((s) => s.go);
  const query = useHangar();

  const q = useHangarStore((s) => s.q);
  const filters = useHangarStore((s) => s.filters);
  const view = useHangarStore((s) => s.view);
  const selection = useHangarStore((s) => s.selection);
  const toggle = useHangarStore((s) => s.toggle);
  const selectRange = useHangarStore((s) => s.selectRange);
  const clear = useHangarStore((s) => s.clear);
  const clearFilters = useHangarStore((s) => s.clearFilters);

  // Focus goes back to the list (or "Select all") when a bulk action or Escape hides the bar.
  const barRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLButtonElement>(null);
  const lastListFocus = useRef<HTMLElement | null>(null);
  // `removed`: skins that are about to leave the list (deleted), so their elements can't take focus.
  const restoreFocus = useCallback((removed?: readonly string[]) => {
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (!lost && !barRef.current?.contains(active)) return;
    const last = lastListFocus.current;
    const lastId = last?.closest<HTMLElement>('[data-skin-id]')?.dataset.skinId;
    const usable = last?.isConnected && !(lastId !== undefined && removed?.includes(lastId));
    const target = usable ? last : selectAllRef.current;
    target?.focus();
  }, []);

  const actions = useHangarActions(restoreFocus);
  const { withPending } = actions;

  const skins = useMemo(() => withPending(query.data ?? NO_SKINS), [withPending, query.data]);
  const stats = useMemo(() => hangarStats(skins), [skins]);
  const visible = useMemo(() => filterSkins(skins, q, filters), [skins, q, filters]);
  const unknownTitle = t('hangar.unknownVehicle');
  const groups = useMemo(() => groupSkins(visible, unknownTitle), [visible, unknownTitle]);
  const visibleIds = useMemo(() => orderedIds(groups), [groups]);
  const selectedIds = useMemo(() => visibleIds.filter((id) => selection.has(id)), [visibleIds, selection]);
  const allVisibleSelected = visibleIds.length > 0 && selectedIds.length === visibleIds.length;

  // Stable item handlers (cards are memoized); they read the latest order through a ref.
  const order = useRef(visibleIds);
  order.current = visibleIds;
  const onSelect = useCallback((id: string, range: boolean) => (range ? selectRange(order.current, id) : toggle(id)), [selectRange, toggle]);

  const clearSelection = useCallback(() => {
    clear();
    restoreFocus();
  }, [clear, restoreFocus]);

  useBulkBarShortcut(selectedIds.length > 0, barRef, lastListFocus, selectAllRef);

  const loaded = query.data !== undefined;
  const empty = loaded && skins.length === 0;

  const meta = loaded
    ? [
        t('hangar.stats.skins', { count: stats.count }),
        t('hangar.stats.active', { count: stats.active }),
        t('hangar.stats.size', { size: formatBytes(stats.sizeBytes) }),
      ].join(' · ')
    : undefined;

  const attention =
    stats.attention > 0 ? (
      <span className="flex items-center gap-1.5 font-mono text-mono-sm leading-[normal] text-amber">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber" />
        {t('hangar.stats.attention', { count: stats.attention })}
      </span>
    ) : undefined;

  return (
    <ScreenFrame label={t('hangar.title')}>
      <ScreenHeader title={t('hangar.title')} meta={meta} right={attention} />
      {empty ? (
        <EmptyState
          title={t('hangar.emptyTitle')}
          body={t('hangar.emptyBody')}
          primary={{ label: t('hangar.emptyAction'), onClick: () => go('explore') }}
        />
      ) : (
        <>
          <HangarToolbar skins={skins} visibleIds={visibleIds} allVisibleSelected={allVisibleSelected} selectAllRef={selectAllRef} />
          <div className="relative min-h-0 flex-1">
            {/* Before the list in the DOM, so keyboard users reach it without tabbing through every card. */}
            {selectedIds.length > 0 && (
              <BulkBar
                ref={barRef}
                count={selectedIds.length}
                busy={actions.bulkBusy}
                onActivate={() => void actions.activateMany(selectedIds, true)}
                onDeactivate={() => void actions.activateMany(selectedIds, false)}
                onMove={(collection: Collection) => void actions.moveMany(selectedIds, collection)}
                onExport={() => void actions.exportMany(selectedIds)}
                onDelete={() => void actions.deleteMany(selectedIds)}
                onClear={clearSelection}
              />
            )}
            {!loaded ? (
              query.isError ? (
                <EmptyState
                  title={t('hangar.loadErrorTitle')}
                  body={errorText(query.error, t)}
                  primary={{ label: t('common.retry'), onClick: () => void query.refetch() }}
                  className="h-full"
                />
              ) : (
                <HangarSkeleton />
              )
            ) : visible.length === 0 ? (
              <EmptyState
                title={t('hangar.noResultsTitle')}
                body={t('hangar.noResultsBody')}
                primary={hasFilters(q, filters) ? { label: t('hangar.clearFilters'), onClick: clearFilters } : undefined}
                className="h-full"
              />
            ) : (
              <HangarGrid
                groups={groups}
                view={view}
                selection={selection}
                rechecking={actions.rechecking}
                resetKey={`${view}|${q}|${filters.nation}|${filters.type}|${filters.origin}`}
                lastFocus={lastListFocus}
                onSelect={onSelect}
                onToggleActive={actions.toggleActive}
                onRecheck={actions.recheck}
              />
            )}
          </div>
        </>
      )}
      {/* Selection changes are announced with the way to the bar (it appears silently, at the bottom). */}
      <div role="status" className="sr-only">
        {selectedIds.length > 0 ? `${t('hangar.bulk.selected', { count: selectedIds.length })}. ${t('hangar.bulk.f6Hint')}` : ''}
      </div>
    </ScreenFrame>
  );
}

/**
 * F6 (either direction, like moving between panes): while skins are selected, it moves focus from
 * anywhere in My Hangar to the bulk bar's first control, and from the bar back to the last focused
 * skin (or "Select all"). The bar comes before the list in the DOM, but it is drawn at the bottom:
 * without this, a keyboard user deep in the grid has to Shift+Tab back through every card.
 */
function useBulkBarShortcut(
  active: boolean,
  barRef: RefObject<HTMLDivElement>,
  lastListFocus: RefObject<HTMLElement | null>,
  selectAllRef: RefObject<HTMLButtonElement>,
) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F6' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const bar = barRef.current;
      // Not under the palette or a dialog.
      if (!bar || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      if (bar.contains(document.activeElement)) {
        const last = lastListFocus.current;
        (last?.isConnected ? last : selectAllRef.current)?.focus();
      } else {
        bar.querySelector<HTMLElement>('[data-bulk-control]')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, barRef, lastListFocus, selectAllRef]);
}

/** Loading: a header bar and eight shimmering cards in the Hangar grid (minmax 220, gap 12). */
function HangarSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2.5">
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden className="h-[25px] py-1.5">
        <div className="h-3 w-40 rounded-tag bg-bg-skel" />
      </div>
      <div className="grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {Array.from({ length: 8 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
