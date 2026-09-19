import { defaultRangeExtractor, useVirtualizer, type Range, type Virtualizer } from '@tanstack/react-virtual';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type MutableRefObject,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import type { HangarView } from '@/store/hangar';
import type { HangarSkin } from '@/types';
import {
  BOTTOM_PADDING,
  buildRows,
  columnsFor,
  estimateRowSize,
  GRID_GAP,
  HEADER_HEIGHT,
  type HangarRow,
  type SkinGroup,
} from './hangarModel';
import { SkinCard } from './SkinCard';
import { SkinRow } from './SkinRow';
import type { SkinItemProps } from './SkinParts';

type ItemHandlers = Pick<SkinItemProps, 'onSelect' | 'onToggleActive' | 'onRecheck'>;

export interface HangarGridProps extends ItemHandlers {
  groups: readonly SkinGroup[];
  view: HangarView;
  selection: ReadonlySet<string>;
  /** Skin whose re-check is running. */
  rechecking: string | null;
  /** Changes when the search, filters or view change: the list scrolls back to the top. */
  resetKey: string;
  /** Receives the last element focused inside the list (focus goes back there after bulk actions). */
  lastFocus: MutableRefObject<HTMLElement | null>;
}

/** Rows rendered above and below the viewport. */
const OVERSCAN = 4;

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
 * Virtualized My Hangar content (TanStack Virtual): a flat list of group-header rows and card
 * lines (grid) or skin rows (list), measured as they render. The current group's header stays
 * pinned at the top. The row holding keyboard focus stays mounted while scrolled away, so focus is
 * never dropped; Tab moves through the overscan rows and the browser scrolls them into view.
 */
export function HangarGrid({ groups, view, selection, rechecking, resetKey, lastFocus, onSelect, onToggleActive, onRecheck }: HangarGridProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useContentWidth(scrollRef);
  const cols = view === 'grid' ? columnsFor(width) : 1;
  const rows = useMemo(() => buildRows(groups, view, cols), [groups, view, cols]);

  // The focused row is always rendered, even far outside the visible range.
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
  const estimateSize = useCallback((index: number) => {
    const row = rows[index];
    return row ? estimateRowSize(row, width, cols) : HEADER_HEIGHT;
  }, [rows, width, cols]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    paddingStart: FOCUS_ROOM,
    paddingEnd: BOTTOM_PADDING,
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

  // New search / filters / view: start from the top.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    virtualizer.scrollToOffset(0);
  }, [virtualizer, resetKey]);

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLElement)) return;
    lastFocus.current = e.target;
    const key = e.target.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey ?? null;
    setFocusedKey(key);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget;
    if (!(to instanceof Node) || !e.currentTarget.contains(to)) setFocusedKey(null);
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      aria-label={t('hangar.skins')}
      role="region"
      onFocus={onFocus}
      onBlur={onBlur}
      // Pulled out by FOCUS_ROOM on three sides and padded back (rows keep their place). Focus
      // scrolling keeps clear of the pinned header and the bulk bar.
      className="absolute -left-1 -right-1 -top-1 bottom-0 overflow-y-auto px-1 scroll-pb-20 scroll-pt-7"
    >
      <PinnedHeader rows={rows} groups={groups} virtualizer={virtualizer} scrollRef={scrollRef} />
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
              <RowView
                row={row}
                group={groups[row.groupIndex]}
                cols={cols}
                selection={selection}
                rechecking={rechecking}
                onSelect={onSelect}
                onToggleActive={onToggleActive}
                onRecheck={onRecheck}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RowViewProps extends ItemHandlers {
  row: HangarRow;
  group: SkinGroup | undefined;
  cols: number;
  selection: ReadonlySet<string>;
  rechecking: string | null;
}

function RowView({ row, group, cols, selection, rechecking, ...handlers }: RowViewProps) {
  switch (row.kind) {
    case 'header':
      return group ? (
        <div className="pb-2.5">
          <GroupHeader group={group} />
        </div>
      ) : null;
    case 'cards':
      return (
        <div
          className={cn('grid', row.lastInGroup ? (row.gapAfter ? 'pb-5.5' : '') : 'pb-3')}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, columnGap: GRID_GAP }}
        >
          {row.skins.map((skin) => (
            <SkinCard key={skin.id} {...itemProps(skin, selection, rechecking)} {...handlers} />
          ))}
        </div>
      );
    case 'item':
      return (
        <div className={cn(row.gapAfter && 'pb-5.5')}>
          {/* The group's bordered list container, drawn one row at a time. */}
          <div
            className={cn(
              'overflow-hidden border-x border-line-2 bg-bg-3',
              row.firstInGroup && 'rounded-t-card border-t',
              row.lastInGroup && 'rounded-b-card border-b',
            )}
          >
            <SkinRow {...itemProps(row.skin, selection, rechecking)} {...handlers} />
          </div>
        </div>
      );
  }
}

function itemProps(skin: HangarSkin, selection: ReadonlySet<string>, rechecking: string | null) {
  return { skin, selected: selection.has(skin.id), rechecking: rechecking === skin.id };
}

/** Vehicle name (500 13px), mono code, mono "3 skins" on the right; 25px tall (4 + 17 + 4) on the canvas color. */
const GroupHeader = memo(function GroupHeader({ group, className, as: Title = 'h2' }: { group: SkinGroup; className?: string; as?: 'h2' | 'span' }) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex h-[25px] items-baseline gap-2.5 bg-bg-2 py-1 leading-[normal]', className)}>
      <Title className="min-w-0 truncate text-body font-medium leading-[normal] text-ink-1">{group.title}</Title>
      {group.code && <span className="min-w-0 truncate font-mono text-[10px] text-ink-4">{group.code}</span>}
      <span className="ml-auto flex-none font-mono text-mono-sm leading-[normal] text-ink-4">
        {t('hangar.groupCount', { count: group.skins.length })}
      </span>
    </div>
  );
});

interface PinnedHeaderProps {
  rows: readonly HangarRow[];
  groups: readonly SkinGroup[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollRef: RefObject<HTMLDivElement>;
}

/**
 * The current group's header, pinned at the top of the scroll area (a sticky overlay that takes no
 * space). The next group's header pushes it up, like CSS sticky headers in separate containers.
 * Hidden while the group's own header is fully in view; decorative for assistive tech (the real
 * headings are in the rows). Position is written to the DOM on scroll, without a React render.
 */
function PinnedHeader({ rows, groups, virtualizer, scrollRef }: PinnedHeaderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [groupIndex, setGroupIndex] = useState(-1);

  const update = useCallback(() => {
    const el = ref.current;
    const scroller = scrollRef.current;
    if (!el || !scroller) return;
    const top = scroller.scrollTop;
    const items = virtualizer.getVirtualItems();
    const first = items.find((item) => item.end > top);
    const firstRow = first ? rows[first.index] : undefined;
    if (!first || !firstRow || (firstRow.kind === 'header' && first.start >= top)) {
      el.style.visibility = 'hidden';
      return;
    }
    const next = items.find((item) => item.index > first.index && rows[item.index]?.kind === 'header');
    const push = next ? Math.min(0, next.start - top - HEADER_HEIGHT) : 0;
    el.style.visibility = 'visible';
    el.style.transform = push ? `translateY(${push}px)` : '';
    setGroupIndex(firstRow.groupIndex);
  }, [rows, virtualizer, scrollRef]);

  useLayoutEffect(update);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [scrollRef, update]);

  const group = groups[groupIndex];
  return (
    <div ref={ref} aria-hidden className="invisible sticky top-0 z-[2] -mb-[25px] h-[25px]">
      {group && <GroupHeader group={group} as="span" />}
    </div>
  );
}
