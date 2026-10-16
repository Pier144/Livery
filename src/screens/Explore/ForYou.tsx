import { useQueries } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowRight } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { formatSavedAt } from '@/lib/format';
import { useLineups } from '@/queries/game';
import { useWtLiveEnabled } from '@/queries/settings';
import { useVehicleName, useVehicles } from '@/queries/vehicles';
import { isOfflineError, useForYouNew, useMarkForYouSeen, useVehicleTop, vehicleTopQuery } from '@/queries/wtlive';
import { openSettingsAt } from '@/screens/Settings/settingsUi';
import { useExplore } from '@/store/explore';
import { useUi } from '@/store/ui';
import type { WtLiveSkin } from '@/types';
import { CompactInstallState } from './CardAction';
import { forYouRows, forYouSections, forYouVehicles, newCounts, type ForYouSection } from './forYouModel';
import { SkinImage } from './SkinCard';

/** Top skins per vehicle row (the 4th column holds "All →"). */
const TOP = 3;
/** Rows rendered above and below the viewport. */
const OVERSCAN = 4;
/** Room around the rows for focus rings (the scroll area is pulled out by as much). */
const FOCUS_ROOM = 4;
/** `wtlive_for_you_new` waits for the visible rows' top skins, but never longer than this. */
export const FOR_YOU_NEW_DELAY_MS = 15_000;

/**
 * Marking seen waits a tick after the tab goes away, so React's StrictMode remount (and a quick
 * remount in general) cancels it. Its own timer: Following's is separate.
 */
let pendingMark: ReturnType<typeof setTimeout> | null = null;

/**
 * For you tab (spec 2026-10-16 §3): the vehicles of the player's lineups, read from the War
 * Thunder profile (local data, listed with WT Live off or offline too), each with its 3 most
 * downloaded WT Live skins and how many skins are new since the last visit. The list is virtual
 * and each mounted row asks for its own top skins, so requests follow the scroll; the new skins
 * are asked for once the visible rows have loaded (or after 15 s). Leaving the tab counts as
 * having seen it (`for_you_mark_seen`), not opening a skin from it.
 */
export function ForYou() {
  const { t } = useTranslation();
  const lineups = useLineups({ enabled: true });
  const enabled = useWtLiveEnabled();
  const markSeen = useMarkForYouSeen();

  // ── Mark seen on leaving the tab ──
  const mark = useRef(markSeen.mutateAsync);
  mark.current = markSeen.mutateAsync;
  // Nothing could be seen with WT Live off: its new skins stay new for when it is turned on.
  const wtlive = useRef(enabled);
  wtlive.current = enabled;
  useEffect(() => {
    if (pendingMark !== null) {
      clearTimeout(pendingMark);
      pendingMark = null;
    }
    return () => {
      pendingMark = setTimeout(() => {
        pendingMark = null;
        if (!wtlive.current || useUi.getState().screen === 'detail') return;
        void mark.current().catch((e: unknown) => console.error('[livery] for_you_mark_seen failed', e));
      }, 0);
    };
  }, []);

  const sections = useMemo(() => forYouSections(lineups.data), [lineups.data]);

  if (lineups.isPending) return <LoadingRows />;

  if (lineups.isError) {
    return (
      <EmptyState
        title={t('explore.forYou.error.title')}
        body={errorText(lineups.error, t)}
        primary={{ label: t('common.retry'), onClick: () => void lineups.refetch() }}
        className="pb-6"
      />
    );
  }

  switch (lineups.data.status) {
    case 'off':
      return (
        <EmptyState
          title={t('explore.forYou.off.title')}
          body={t('explore.forYou.off.body')}
          primary={{ label: t('explore.forYou.off.settings'), onClick: () => openSettingsAt('game') }}
          className="pb-6"
        />
      );
    case 'noProfile':
      return <EmptyState title={t('explore.forYou.noProfile.title')} body={t('explore.forYou.noProfile.body')} className="pb-6" />;
    default:
      if (sections.length === 0) {
        return <EmptyState title={t('explore.forYou.noLineups.title')} body={t('explore.forYou.noLineups.body')} className="pb-6" />;
      }
      return <Lineups sections={sections} savedAt={lineups.data.savedAt ?? undefined} current={lineups.data.current ?? undefined} />;
  }
}

/** While the profile is read: a title bar and a few rows of skeleton thumbnails. */
function LoadingRows() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden pt-6">
      <span className="sr-only">{t('common.loading')}</span>
      <Skeleton className="mb-1 h-4 w-48 rounded-tag" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid grid-cols-[130px_minmax(0,1fr)] items-center gap-2.5 border-t border-line-1 py-1.5">
          <Skeleton className="h-3 w-24 rounded-tag" />
          <ThumbSkeletons />
        </div>
      ))}
    </div>
  );
}

function ThumbSkeletons() {
  return (
    <div aria-hidden className="grid grid-cols-4 gap-2">
      {Array.from({ length: TOP }, (_, i) => (
        <Skeleton key={i} className="aspect-video rounded-ctl" />
      ))}
    </div>
  );
}

interface LineupsProps {
  sections: ForYouSection[];
  savedAt?: string;
  current?: string;
}

/** The profile's save time, then the virtual list of sections and vehicle rows. */
function Lineups({ sections, savedAt, current }: LineupsProps) {
  const { t, i18n } = useTranslation();
  const enabled = useWtLiveEnabled();
  const rows = useMemo(() => forYouRows(sections), [sections]);
  const vehicles = useMemo(() => forYouVehicles(sections), [sections]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows]);
  const estimateSize = useCallback((index: number) => (rows[index]?.kind === 'header' ? 44 : 84), [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    paddingStart: FOCUS_ROOM,
    paddingEnd: 24,
  });
  const items = virtualizer.getVirtualItems();

  // ── New skins: once no mounted row's top skins are loading, or FOR_YOU_NEW_DELAY_MS after opening ──
  // The mounted rows' codes as a string: `items` is a new array on every render.
  const mountedKey = JSON.stringify(
    items.map((item) => rows[item.index]).flatMap((row) => (row?.kind === 'vehicle' ? [row.code] : [])),
  );
  const rowQueries = useMemo(
    () => (JSON.parse(mountedKey) as string[]).map((code) => ({ ...vehicleTopQuery(code), enabled })),
    [mountedKey, enabled],
  );
  const rowsLoading = useQueries({ queries: rowQueries, combine: (results) => results.some((r) => r.isPending) });
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!started && rowQueries.length > 0 && !rowsLoading) setStarted(true);
  }, [started, rowQueries.length, rowsLoading]);
  useEffect(() => {
    const timer = setTimeout(() => setStarted(true), FOR_YOU_NEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const fresh = useForYouNew(vehicles, { fetch: started });
  const counts = useMemo(() => newCounts(fresh.data, vehicles), [fresh.data, vehicles]);
  const newIds = useMemo(() => new Set(fresh.data?.items.map((i) => i.skin.id)), [fresh.data]);
  const saved = savedAt ? formatSavedAt(savedAt, i18n.language) : null;

  return (
    <>
      {saved && (
        <p className="text-right font-mono text-mono-sm uppercase leading-[normal] tracking-[.04em] text-ink-4">
          {t('explore.forYou.savedAt', { time: saved })}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          role="region"
          aria-label={t('explore.forYou.label')}
          className="absolute -left-1 -right-1 -top-1 bottom-0 overflow-y-auto px-1"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === 'header' ? (
                    <SectionHeader section={row.section} first={item.index === 0} />
                  ) : (
                    <VehicleRow code={row.code} selected={row.code === current} newCount={counts.get(row.code) ?? 0} newIds={newIds} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

/** "USSR · Main" and, on the right, "ACTIVE · 2 VEHICLES". */
function SectionHeader({ section, first }: { section: ForYouSection; first: boolean }) {
  const { t } = useTranslation();
  const preset = section.presetName.trim() || t('explore.forYou.presetFallback', { n: section.presetIndex + 1 });
  const count = t('explore.forYou.count', { count: section.vehicles.length });
  return (
    <div className={cn('flex items-baseline justify-between gap-4 pb-2', first ? 'pt-1' : 'pt-3.5')}>
      <h2 className="min-w-0 truncate text-card text-ink-1">
        {t(`hangar.nation.${section.nation}`)} · {preset}
      </h2>
      <span className="flex-none whitespace-nowrap font-mono text-mono-sm uppercase leading-[normal] tracking-[.04em] text-ink-4">
        {section.active ? `${t('explore.forYou.active')} · ${count}` : count}
      </span>
    </div>
  );
}

interface VehicleRowProps {
  code: string;
  selected: boolean;
  newCount: number;
  /** Skins new since the last visit (their thumbnails carry the NEW badge). */
  newIds: ReadonlySet<string>;
}

/** One lineup vehicle: its name, selected now / N new, its top skins and "All →". */
const VehicleRow = memo(function VehicleRow({ code, selected, newCount, newIds }: VehicleRowProps) {
  const { t } = useTranslation();
  const enabled = useWtLiveEnabled();
  const top = useVehicleTop(code);
  const applyVehicle = useExplore((s) => s.applyVehicle);
  const openSkin = useUi((s) => s.openSkin);
  const name = useLineupVehicleName(code);

  let skins: JSX.Element;
  if (!enabled || top.isError) {
    const note = !enabled
      ? t('explore.forYou.offNote')
      : isOfflineError(top.error)
        ? t('explore.forYou.offline')
        : t('explore.forYou.topFailed');
    skins = <p className="text-meta leading-[normal] text-ink-3">{note}</p>;
  } else if (top.isPending) {
    skins = <ThumbSkeletons />;
  } else if (top.data.length === 0) {
    skins = (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta leading-[normal]">
        <span className="text-ink-3">{t('explore.forYou.noSkins')}</span>
        <LinkButton onClick={() => applyVehicle(code)} label={t('explore.forYou.searchFor', { vehicle: name })}>
          {t('explore.forYou.searchInExplore')}
        </LinkButton>
      </div>
    );
  } else {
    skins = (
      <div className="grid grid-cols-4 items-center gap-2">
        {top.data.map((skin) => (
          <Thumb key={skin.id} skin={newIds.has(skin.id) ? { ...skin, isNew: true } : skin} onOpen={openSkin} />
        ))}
        {Array.from({ length: TOP - top.data.length }, (_, i) => (
          <span key={`gap-${i}`} aria-hidden />
        ))}
        <LinkButton onClick={() => applyVehicle(code)} label={t('explore.forYou.allFor', { vehicle: name })}>
          {t('explore.forYou.all')}
        </LinkButton>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)] items-center gap-2.5 border-t border-line-1 py-1.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-meta leading-[normal] text-ink-1" title={name}>
          {name}
        </span>
        {(selected || newCount > 0) && (
          <span className="truncate font-mono text-mono-sm leading-[normal]">
            {selected && (
              <span className="text-ink-4">
                <span aria-hidden>● </span>
                {t('explore.forYou.selectedNow')}
              </span>
            )}
            {selected && newCount > 0 && <span className="text-ink-4"> · </span>}
            {newCount > 0 && <span className="text-amber">{t('explore.forYou.new', { count: newCount })}</span>}
          </span>
        )}
      </div>
      {skins}
    </div>
  );
});

/** A lineup code's name in the UI language; unknown codes show as they are. */
function useLineupVehicleName(code: string): string {
  const vehicles = useVehicles();
  const vehicleName = useVehicleName();
  const lower = code.toLowerCase();
  const known = useMemo(() => vehicles.find((v) => v.code.toLowerCase() === lower), [vehicles, lower]);
  return vehicleName({ code, name: known?.name ?? code });
}

/** A top skin: its picture with the card's install state; opens the Skin detail. */
function Thumb({ skin, onOpen }: { skin: WtLiveSkin; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      data-skin-id={skin.id}
      title={skin.name}
      onClick={() => onOpen(skin.id)}
      className="group relative block min-w-0 overflow-hidden rounded-ctl border border-line-2 hover:border-amber motion-safe:transition-colors motion-safe:duration-120"
    >
      <span className="sr-only">{skin.name}</span>
      <SkinImage skin={skin} showCategory={false} />
      <CompactInstallState skin={skin} />
    </button>
  );
}

/** The rows' ghost link ("All →", "Search in Explore"), with a name that says which vehicle. */
function LinkButton({ onClick, label, children }: { onClick: () => void; label: string; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex w-fit items-center gap-1 whitespace-nowrap rounded-menu text-meta leading-[normal] text-ink-3 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
    >
      {children}
      <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
