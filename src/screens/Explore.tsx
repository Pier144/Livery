import { useCallback, useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonGrid } from '@/components/ui/Skeleton';
import { useLineups } from '@/queries/game';
import { useWtLiveEnabled } from '@/queries/settings';
import { isOfflineError, useFollowing, useFollowingNew, useForYouNew, useWtLiveSearchPages } from '@/queries/wtlive';
import { useExplore, type ExploreTab } from '@/store/explore';
import { toast } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { ActiveFilters } from './Explore/ActiveFilters';
import { ExploreHeader } from './Explore/ExploreHeader';
import { toSearchParams } from './Explore/exploreModel';
import { FilterRow } from './Explore/FilterRow';
import { Following } from './Explore/Following';
import { ForYou } from './Explore/ForYou';
import { forYouSections, forYouVehicles, totalNew } from './Explore/forYouModel';
import { SkinGrid } from './Explore/SkinGrid';
import { ScreenFrame } from './ScreenHeader';
import { openSettingsAt } from './Settings/settingsUi';

/** Filters → `wtlive_search` params (memoized on the individual filter values). */
function useSearchParams() {
  const q = useExplore((s) => s.q);
  const nation = useExplore((s) => s.nation);
  const type = useExplore((s) => s.type);
  const klass = useExplore((s) => s.class);
  const vehicle = useExplore((s) => s.vehicle);
  const category = useExplore((s) => s.category);
  const sort = useExplore((s) => s.sort);
  return useMemo(
    () => toSearchParams({ q, nation, type, class: klass, vehicle, category }, sort),
    [q, nation, type, klass, vehicle, category, sort],
  );
}

/**
 * Explore (README §2): WT Live skins with filters, a virtual grid and install-from-card, plus the
 * Following and For you tabs. WT Live pages come from `useWtLiveSearchPages`. The header count comes from the
 * last loaded page ("75+ results" while it is only a lower bound), the query time from the first.
 * With Browse WT Live off, Explore and Following show the "turned off" state and nothing asks WT
 * Live; For you still lists the lineups (local data).
 */
export function Explore() {
  const { t } = useTranslation();
  const tab = useExplore((s) => s.tab);
  const setTab = useExplore((s) => s.setTab);
  const params = useSearchParams();
  const search = useWtLiveSearchPages(params);
  const following = useFollowing();
  // The pill reads what the Following tab fetched: opening Explore doesn't ask WT Live for every follow.
  const fresh = useFollowingNew(following.data, { fetch: tab === 'following' });
  // The profile is read only while For you is open; elsewhere the lineups and the pill come from
  // what that tab already read and fetched (no request to draw the pill).
  const lineups = useLineups({ enabled: tab === 'forYou' });
  const forYouList = useMemo(() => forYouVehicles(forYouSections(lineups.data)), [lineups.data]);
  const forYouNew = useForYouNew(forYouList, { fetch: false });
  const enabled = useWtLiveEnabled();
  const newCounts = useMemo(
    () => (enabled ? { following: fresh.data?.length ?? 0, forYou: totalNew(forYouNew.data) } : {}),
    [enabled, fresh.data, forYouNew.data],
  );

  const baseId = useId();
  const tabId = useCallback((id: ExploreTab) => `${baseId}-tab-${id}`, [baseId]);
  const panelId = useCallback((id: ExploreTab) => `${baseId}-panel-${id}`, [baseId]);

  const meta = useResultsMeta(search, tab === 'explore' && enabled);

  return (
    <ScreenFrame label={t('explore.title')}>
      {/* The tabs name the screen visually; screen readers get a level-one heading (focus target, not a tab stop). */}
      <h1 tabIndex={-1} className="sr-only">
        {t('explore.title')}
      </h1>
      <ExploreHeader tab={tab} onTab={setTab} newCounts={newCounts} meta={meta} tabId={tabId} panelId={panelId} />
      {/* Keyed by the tab: the new view fades in. */}
      <div
        key={tab}
        role="tabpanel"
        id={panelId(tab)}
        aria-labelledby={tabId(tab)}
        className="flex min-h-0 flex-1 flex-col gap-3.5 motion-safe:animate-panel-in"
      >
        {/* For you first: its lineups are local data, listed even with WT Live off. */}
        {tab === 'forYou' ? (
          <ForYou />
        ) : !enabled ? (
          <WtLiveOff />
        ) : tab === 'explore' ? (
          <ExploreTabPanel search={search} params={params} />
        ) : (
          <Following />
        )}
      </div>
    </ScreenFrame>
  );
}

type Search = ReturnType<typeof useWtLiveSearchPages>;

/**
 * "1,284 results": the count from the last loaded page (WT Live's feed has no total count, so
 * unless `totalExact` it is a lower bound that grows as pages load: "75+ results"). Empty unless results are on screen (not over the offline / error state).
 */
function useResultsMeta(search: Search, show: boolean): string {
  const { t } = useTranslation();
  const pages = search.data?.pages;
  const first = pages?.[0];
  const last = pages?.[pages.length - 1];
  const failed = search.isError && !search.isFetchNextPageError;
  if (!show || !first || !last || failed) return '';
  const values = { count: last.total };
  return last.totalExact ? t('explore.results', values) : t('explore.resultsAtLeast', values);
}

/** Browse WT Live is off (Settings → WT Live): no request is made; the library works as usual. */
function WtLiveOff() {
  const { t } = useTranslation();
  return (
    <EmptyState
      dot
      title={t('explore.off.title')}
      body={t('explore.off.body')}
      primary={{ label: t('explore.off.settings'), onClick: () => openSettingsAt('wtlive') }}
      className="pb-6"
    />
  );
}

function ExploreTabPanel({ search, params }: { search: Search; params: ReturnType<typeof useSearchParams> }) {
  const filterRowRef = useRef<HTMLDivElement>(null);
  const focusFilters = useCallback(() => filterRowRef.current?.querySelector<HTMLElement>('button, input')?.focus(), []);
  return (
    <>
      <FilterRow ref={filterRowRef} />
      <ActiveFilters onEmpty={focusFilters} />
      <Results search={search} resetKey={JSON.stringify(params)} filtered={Object.keys(params).some((k) => k !== 'sort')} />
    </>
  );
}

/** Grid, or the loading / no results / offline / error state. */
function Results({ search, resetKey, filtered }: { search: Search; resetKey: string; filtered: boolean }) {
  const { t } = useTranslation();
  const go = useUi((s) => s.go);
  const openSkin = useUi((s) => s.openSkin);
  const clearAll = useExplore((s) => s.clearAll);

  const { data, error, isPending, isError, isPlaceholderData, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, refetch } =
    search;
  const skins = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const loadMore = useCallback(() => void fetchNextPage().catch(() => undefined), [fetchNextPage]);

  const retry = async () => {
    const result = await refetch();
    if (result.isError && isOfflineError(result.error)) toast(t('explore.offline.stillOffline'));
  };

  if (isPending) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <SkeletonGrid count={8} />
      </div>
    );
  }

  if (!data || (isError && !isFetchNextPageError)) {
    if (isOfflineError(error)) {
      return (
        <EmptyState
          dot
          title={t('explore.offline.title')}
          body={t('explore.offline.body')}
          primary={{ label: t('explore.offline.hangar'), onClick: () => go('hangar') }}
          secondary={{ label: t('common.retry'), onClick: () => void retry() }}
          className="pb-6"
        />
      );
    }
    return (
      <EmptyState
        title={t('explore.error.title')}
        body={t('explore.error.body')}
        primary={{ label: t('common.retry'), onClick: () => void retry() }}
        className="pb-6"
      />
    );
  }

  if (skins.length === 0) {
    return (
      <EmptyState
        title={t('explore.empty.title')}
        body={t('explore.empty.body')}
        secondary={filtered ? { label: t('explore.empty.clear'), onClick: clearAll } : undefined}
        className="pb-6"
      />
    );
  }

  return (
    <div className="relative min-h-0 flex-1" aria-busy={isPlaceholderData || undefined}>
      <SkinGrid
        skins={skins}
        // The previous filters' pages stay on screen (keepPreviousData, marked aria-busy) until the
        // new first page lands: don't page on from them.
        hasMore={hasNextPage && !isPlaceholderData}
        loadingMore={isFetchingNextPage}
        moreFailed={isFetchNextPageError}
        onLoadMore={loadMore}
        resetKey={resetKey}
        onOpen={openSkin}
      />
    </div>
  );
}
