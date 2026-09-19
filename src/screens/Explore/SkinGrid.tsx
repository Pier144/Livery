import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';
import type { WtLiveSkin } from '@/types';
import { buildRows, columnsFor, estimateRowSize, GRID_BOTTOM_PADDING, GRID_GAP, PREFETCH_ROWS, type GridRow } from './exploreModel';
import { SkinCard } from './SkinCard';

export interface SkinGridProps {
  skins: readonly WtLiveSkin[];
  /** More pages exist on WT Live. */
  hasMore: boolean;
  /** The next page is on its way (a row of skeleton cards shows at the end). */
  loadingMore: boolean;
  /** The next page failed (a Retry line shows at the end; nothing loads by itself until then). */
  moreFailed: boolean;
  onLoadMore: () => void;
  /** Changes when the filters or the sort change: the grid scrolls back to the top. */
  resetKey: string;
  /** Stable. */
  onOpen: (id: string) => void;
}

/** Rows rendered above and below the viewport. */
const OVERSCAN = 3;

/**
 * Room around the rows (px) for the cards' focus ring (2px, offset 2), which the scroll area would
 * otherwise clip at its edges. The scroll area is pulled out by the same amount, so nothing moves.
 */
const FOCUS_ROOM = 4;

/** Width of the rows (the scroll area minus scrollbar and focus room), kept up to date with a ResizeObserver when available. */
function useContentWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.max(0, el.clientWidth - 2 * FOCUS_ROOM));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Virtualized Explore grid (TanStack Virtual): lines of `auto-fill, minmax(250px, 1fr)` cards
 * chunked by the container width, measured as they render. When the last rendered line comes
 * within PREFETCH_ROWS of the end, the next WT Live page is asked for (DESIGN_NOTES "Explore
 * paging"). The line holding keyboard focus stays mounted while scrolled away.
 */
export function SkinGrid({ skins, hasMore, loadingMore, moreFailed, onLoadMore, resetKey, onOpen }: SkinGridProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useContentWidth(scrollRef);
  const cols = columnsFor(width);
  const tail = loadingMore ? 'loading' : moreFailed ? 'moreFailed' : null;
  const rows = useMemo(() => buildRows(skins, cols, tail), [skins, cols, tail]);

  // The focused line is always rendered, even far outside the visible range.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focusedIndex = useMemo(() => (focusedKey === null ? -1 : rows.findIndex((r) => r.key === focusedKey)), [rows, focusedKey]);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusedIndex < 0 || indexes.includes(focusedIndex)) return indexes;
      return [...indexes, focusedIndex].sort((a, b) => a - b);
    },
    [focusedIndex],
  );

  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows]);
  const estimateSize = useCallback((index: number) => estimateRowSize(rows[index], width, cols), [rows, width, cols]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    paddingStart: FOCUS_ROOM,
    // Every line carries its 16px gap below it (pb-4), the last one too: 24px under the last card.
    paddingEnd: GRID_BOTTOM_PADDING - GRID_GAP,
    rangeExtractor,
  });

  // A width change resizes every card (16:9 images): drop cached sizes, then re-measure what's mounted.
  const measuredWidth = useRef(width);
  useLayoutEffect(() => {
    if (measuredWidth.current === width) return;
    measuredWidth.current = width;
    virtualizer.measure();
    virtualizer.elementsCache.forEach((el) => virtualizer.measureElement(el));
  }, [virtualizer, width]);

  // New filters / sort: start from the top.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    virtualizer.scrollToOffset(0);
  }, [virtualizer, resetKey]);

  const items = virtualizer.getVirtualItems();
  // The visible range plus overscan (a focused line kept far away doesn't count).
  const visible = virtualizer.calculateRange();
  const lastIndex = visible ? Math.min(rows.length - 1, visible.endIndex + OVERSCAN) : -1;
  useEffect(() => {
    if (lastIndex < 0 || !hasMore || loadingMore || moreFailed) return;
    if (lastIndex >= rows.length - 1 - PREFETCH_ROWS) onLoadMore();
  }, [lastIndex, rows.length, hasMore, loadingMore, moreFailed, onLoadMore]);

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLElement)) return;
    setFocusedKey(e.target.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey ?? null);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget;
    if (!(to instanceof Node) || !e.currentTarget.contains(to)) setFocusedKey(null);
  };

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={t('explore.grid.label')}
      onFocus={onFocus}
      onBlur={onBlur}
      // Pulled out by FOCUS_ROOM on three sides and padded back (rows keep their place).
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
              data-row-key={row.key}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <RowView row={row} cols={cols} onOpen={onOpen} onLoadMore={onLoadMore} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowView({ row, cols, onOpen, onLoadMore }: { row: GridRow; cols: number; onOpen: (id: string) => void; onLoadMore: () => void }) {
  const { t } = useTranslation();
  const columns = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
  switch (row.kind) {
    case 'cards':
      return (
        <div className="grid gap-x-4 pb-4" style={columns}>
          {row.skins.map((skin) => (
            <SkinCard key={skin.id} skin={skin} onOpen={onOpen} />
          ))}
        </div>
      );
    case 'loading':
      return (
        <div role="status" aria-busy="true" className="grid gap-x-4 pb-4" style={columns}>
          <span className="sr-only">{t('common.loading')}</span>
          {Array.from({ length: cols }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      );
    case 'moreFailed':
      return (
        <div className="flex items-center justify-center gap-3 pb-4 pt-1 text-meta leading-[normal] text-ink-3">
          <span>{t('explore.grid.moreFailed')}</span>
          <Button variant="secondary" size={26} onClick={onLoadMore}>
            {t('common.retry')}
          </Button>
        </div>
      );
  }
}
