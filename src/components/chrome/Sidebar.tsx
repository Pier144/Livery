import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Compass, Download, Layers, Paintbrush, Settings, Warehouse, type LucideIcon } from 'lucide-react';
import { Kbd } from '@/components/ui/Kbd';
import { Skeleton } from '@/components/ui/Skeleton';
import { useActiveBox } from '@/components/ui/TabIndicator';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { play, POP } from '@/lib/motion';
import { useHangarSummary } from '@/queries/hangar';
import { useSettings } from '@/queries/settings';
import { selectPendingCount, useQueue } from '@/store/queue';
import { clampSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useUi } from '@/store/ui';
import type { Section } from '@/types';

interface NavDef {
  id: Section;
  icon: LucideIcon;
  /** Shortcut handled by useKeyboardShortcuts; shown as the right-hand hint. */
  hint: string;
}

const NAV: NavDef[] = [
  { id: 'explore', icon: Compass, hint: '1' },
  { id: 'hangar', icon: Warehouse, hint: '2' },
  { id: 'collections', icon: Layers, hint: '3' },
  { id: 'queue', icon: Download, hint: '4' },
  // Only with Settings → Atelier → Show Atelier on.
  { id: 'atelier', icon: Paintbrush, hint: '6' },
  { id: 'settings', icon: Settings, hint: ',' },
];

/** Arrow keys on the resize handle move the edge this much (Shift: `KEY_STEP_LARGE`). */
const KEY_STEP = 8;
const KEY_STEP_LARGE = 40;
/** Dragging the edge this far left of the minimum collapses the sidebar to the rail. */
const COLLAPSE_SLACK = 64;
/** The open sidebar never takes more than this share of the window (small windows, large zoom). */
const MAX_SHARE = 0.35;

/** Widest the sidebar may be in the current window. */
function maxWidth(): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(window.innerWidth * MAX_SHARE)));
}

/**
 * Section nav with the status card (216px by default; its right edge drags between 184 and 360px),
 * or the 56px icon rail when collapsed (`[` / `]`). Both variants share one element tree so focus
 * survives a toggle.
 */
export function Sidebar() {
  const { t } = useTranslation();
  const open = useUi((s) => s.sidebarOpen);
  const storedWidth = useUi((s) => s.sidebarWidth);
  const [resizing, setResizing] = useState(false);
  const navId = useId();
  const screen = useUi((s) => s.screen);
  const detailFrom = useUi((s) => s.detailReturnTo);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const pending = useQueue(selectPendingCount);
  const atelierEnabled = useSettings().data?.atelierEnabled === true;
  const items = atelierEnabled ? NAV : NAV.filter((item) => item.id !== 'atelier');
  const badgeId = useId();
  // The active section's background slides from item to item (drawn under the buttons).
  const navRef = useRef<HTMLElement>(null);
  const activeId = items.find((item) => screen === item.id || (screen === 'detail' && item.id === detailFrom))?.id ?? '';
  const highlight = useActiveBox(navRef, '[aria-current="page"]', `${activeId}|${open}`);
  useWindowWidth();
  // A window too narrow for the stored width (or a large zoom) shows it narrower; the choice is kept.
  const width = Math.min(storedWidth, maxWidth());

  return (
    <div className="relative flex flex-none">
      <nav
        ref={navRef}
        id={navId}
        aria-label={t('common.nav.label')}
        style={open ? { width } : undefined}
        className={cn(
          'relative flex flex-none flex-col border-r border-line-1 bg-bg-1 pb-3 pt-3.5',
          open ? 'gap-0.5 px-2.5' : 'w-sidebar-c items-center gap-1',
        )}
      >
        {highlight && (
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute left-0 top-0 rounded-ctl bg-bg-hover',
              // While the edge is dragged the highlight follows at once instead of sliding behind.
              !resizing && 'motion-safe:transition-[transform,width,height] motion-safe:duration-200 motion-safe:ease-decel',
              open && 'shadow-[inset_2px_0_0_theme(colors.amber.DEFAULT)]',
            )}
            style={{ width: highlight.width, height: highlight.height, transform: `translate(${highlight.left}px, ${highlight.top}px)` }}
          />
        )}
        {items.map((item) => (
          <NavItem
            key={item.id}
            {...item}
            slid={highlight !== null}
            collapsed={!open}
            // The Skin detail belongs to the section it was opened from.
            active={screen === item.id || (screen === 'detail' && item.id === detailFrom)}
            badge={item.id === 'queue' ? pending : 0}
            describedBy={badgeId}
          />
        ))}
        <div className="flex-1" />
        {open && <StatusCard />}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-keyshortcuts={open ? '[' : ']'}
          aria-label={open ? undefined : t('common.nav.expand')}
          title={open ? undefined : t('common.nav.expand')}
          className={cn(
            // ink-4, not the prototype's ink-5: 11px text on bg-1 needs 4.5:1.
            'text-ink-4 hover:text-ink-2 motion-safe:transition-colors motion-safe:duration-120',
            open
              ? 'px-2.5 pt-2 text-left text-[11px] leading-[1.4]'
              : // 36×24 hit area; the negative margins keep the glyph where the prototype puts it.
                '-my-1 flex h-6 w-9 flex-none items-center justify-center rounded-ctl font-mono text-mono-sm',
          )}
        >
          {open ? (
            <>
              {t('common.nav.collapse')}{' '}
              <span aria-hidden className="font-mono text-[10px]">
                [
              </span>
            </>
          ) : (
            <span aria-hidden>]</span>
          )}
        </button>
        {pending > 0 && (
          <span id={badgeId} hidden>
            {t('common.nav.queueBadge', { count: pending })}
          </span>
        )}
      </nav>
      {open && <ResizeHandle width={width} controls={navId} onResizing={setResizing} />}
    </div>
  );
}

/** Re-renders on window resizes, so the sidebar's cap (`maxWidth`) follows the window. */
function useWindowWidth() {
  const [, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
}

interface ResizeHandleProps {
  /** Width shown now. */
  width: number;
  /** Id of the nav it resizes. */
  controls: string;
  onResizing: (resizing: boolean) => void;
}

/**
 * The open sidebar's right edge (WAI-ARIA window splitter): drag it, or focus it and use ←/→
 * (Shift for bigger steps) and Home/End for the narrowest/widest; a double click or Enter goes back
 * to 216px. Dragging well past the narrowest collapses the sidebar to the rail, like `[`.
 */
function ResizeHandle({ width, controls, onResizing }: ResizeHandleProps) {
  const { t } = useTranslation();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // While dragging, the cursor stays a resize cursor over the whole window and nothing gets selected.
  useEffect(() => {
    onResizing(dragging);
    if (!dragging) return;
    const root = document.documentElement;
    root.style.cursor = 'col-resize';
    root.style.userSelect = 'none';
    return () => {
      root.style.cursor = '';
      root.style.userSelect = '';
      onResizing(false);
    };
  }, [dragging, onResizing]);

  const resize = (next: number) => useUi.getState().setSidebarWidth(Math.min(clampSidebarWidth(next), maxWidth()));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = drag.current.width + e.clientX - drag.current.x;
    if (next < SIDEBAR_MIN - COLLAPSE_SLACK) {
      // Reopening (`]`) brings back the width the drag started from, not the narrowest.
      resize(drag.current.width);
      drag.current = null;
      setDragging(false);
      useUi.getState().setSidebarOpen(false);
      return;
    }
    resize(next);
  };
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const keys: Record<string, number> = {
      ArrowLeft: width - step,
      ArrowRight: width + step,
      Home: SIDEBAR_MIN,
      End: SIDEBAR_MAX,
      Enter: SIDEBAR_DEFAULT,
    };
    const next = keys[e.key];
    if (next === undefined) return;
    e.preventDefault();
    resize(next);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('common.nav.resize')}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={maxWidth()}
      title={t('common.nav.resizeHint')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => resize(SIDEBAR_DEFAULT)}
      onKeyDown={onKeyDown}
      // A 7px hit area centred on the border; its 2px line shows on hover, focus and while dragging.
      className="group absolute -right-1 bottom-0 top-0 z-10 flex w-[7px] cursor-col-resize justify-center focus-visible:outline-none"
    >
      <span
        aria-hidden
        className={cn(
          'h-full w-0.5 group-hover:bg-amber-50 group-focus-visible:bg-amber motion-safe:transition-colors motion-safe:duration-120',
          dragging && 'bg-amber',
        )}
      />
    </div>
  );
}

interface NavItemProps extends NavDef {
  collapsed: boolean;
  /** The sliding highlight draws the active background and stripe: the item doesn't. */
  slid: boolean;
  active: boolean;
  /** Pending queue count; 0 hides the badge. */
  badge: number;
  /** Id of the hidden text that spells out the badge for assistive tech. */
  describedBy: string;
}

function NavItem({ id, icon: Icon, hint, collapsed, slid, active, badge, describedBy }: NavItemProps) {
  const { t } = useTranslation();
  const label = t(`common.nav.${id}`);
  // A count that grows gives a little bump (a file was added to the queue).
  const badgeRef = useRef<HTMLSpanElement>(null);
  const lastBadge = useRef(badge);
  useEffect(() => {
    if (badge > lastBadge.current) play(badgeRef.current, ...POP);
    lastBadge.current = badge;
  }, [badge]);

  return (
    <button
      type="button"
      onClick={() => useUi.getState().go(id)}
      aria-current={active ? 'page' : undefined}
      aria-keyshortcuts={hint}
      aria-describedby={badge > 0 ? describedBy : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        'relative flex h-nav flex-none items-center rounded-ctl text-body font-medium hover:bg-bg-hover hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120',
        active ? cn('text-ink-1', !slid && 'bg-bg-hover') : 'text-ink-3',
        collapsed
          ? 'w-9 justify-center'
          : cn('w-full gap-2.5 border-l-2 px-2.5 text-left', active && !slid ? 'border-amber' : 'border-transparent'),
      )}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden />
      {collapsed ? (
        badge > 0 && <span ref={badgeRef} aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber" />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {badge > 0 && (
            <span
              ref={badgeRef}
              aria-hidden
              className="rounded-pill bg-amber px-1.5 py-0.5 font-mono text-[10px] font-medium leading-[1.3] text-onAmber"
            >
              {badge}
            </span>
          )}
          {/* The shortcut is exposed via aria-keyshortcuts; the hint is visual only. */}
          <span aria-hidden className="flex">
            <Kbd variant="bare" tone="ink5">
              {hint}
            </Kbd>
          </span>
        </>
      )}
    </button>
  );
}

function StatusCard() {
  const { t } = useTranslation();
  const { data: settings, isPending } = useSettings();
  const hangar = useHangarSummary();
  const source = settings?.gameSource;

  return (
    <div className="flex flex-col gap-1.5 rounded-ctl border border-line-1 bg-bg-status p-2.5">
      <div className="flex justify-between text-meta text-ink-2">
        <span>{t('common.status.game')}</span>
        {isPending ? (
          <Skeleton className="h-2.5 w-10 self-center rounded-tag" />
        ) : (
          <span className="font-mono text-[10px] leading-[1.4] text-ink-4">
            {source ? t(`common.status.source.${source}`) : t('common.status.source.none')}
          </span>
        )}
      </div>
      <div className="font-mono text-mono-sm text-ink-4">
        {t('common.status.hangar', { count: hangar.count, size: formatBytes(hangar.sizeBytes) })}
      </div>
    </div>
  );
}
