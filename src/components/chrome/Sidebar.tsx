import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Compass, Download, Layers, Settings, Warehouse, type LucideIcon } from 'lucide-react';
import { Kbd } from '@/components/ui/Kbd';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { useHangarSummary } from '@/queries/hangar';
import { useSettings } from '@/queries/settings';
import { selectPendingCount, useQueue } from '@/store/queue';
import { useUi } from '@/store/ui';
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
  { id: 'settings', icon: Settings, hint: ',' },
];

export interface SidebarProps {
  /** WT Live skin count for the status line; available from M5. */
  liveSkinCount?: number;
}

/**
 * 216px section nav with the status card, or the 56px icon rail when collapsed (`[` / `]`).
 * Both variants share one element tree so focus survives a toggle.
 */
export function Sidebar({ liveSkinCount }: SidebarProps) {
  const { t } = useTranslation();
  const open = useUi((s) => s.sidebarOpen);
  const screen = useUi((s) => s.screen);
  const online = useUi((s) => s.online);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const pending = useQueue(selectPendingCount);
  const badgeId = useId();

  const liveText = !online
    ? t('common.status.offline')
    : liveSkinCount === undefined
      ? t('common.status.onlineNoCount')
      : t('common.status.online', { count: liveSkinCount });

  return (
    <nav
      aria-label={t('common.nav.label')}
      className={cn(
        'flex flex-none flex-col border-r border-line-1 bg-bg-1 pb-3 pt-3.5',
        open ? 'w-sidebar gap-0.5 px-2.5' : 'w-sidebar-c items-center gap-1',
      )}
    >
      {NAV.map((item) => (
        <NavItem
          key={item.id}
          {...item}
          collapsed={!open}
          // The Skin detail belongs to Explore (prototype).
          active={screen === item.id || (screen === 'detail' && item.id === 'explore')}
          badge={item.id === 'queue' ? pending : 0}
          describedBy={badgeId}
        />
      ))}
      <div className="flex-1" />
      {open ? (
        <StatusCard online={online} liveText={liveText} />
      ) : (
        <span
          role="img"
          aria-label={liveText}
          title={liveText}
          className={cn('mb-2.5 h-1.5 w-1.5 flex-none rounded-full', online ? 'bg-amber' : 'bg-ink-5')}
        />
      )}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-keyshortcuts={open ? '[' : ']'}
        aria-label={open ? undefined : t('common.nav.expand')}
        title={open ? undefined : t('common.nav.expand')}
        className={cn(
          // ink-4, not the prototype's ink-5: 11px text on bg-1 needs 4.5:1 (see DESIGN_NOTES).
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
  );
}

interface NavItemProps extends NavDef {
  collapsed: boolean;
  active: boolean;
  /** Pending queue count; 0 hides the badge. */
  badge: number;
  /** Id of the hidden text that spells out the badge for assistive tech. */
  describedBy: string;
}

function NavItem({ id, icon: Icon, hint, collapsed, active, badge, describedBy }: NavItemProps) {
  const { t } = useTranslation();
  const label = t(`common.nav.${id}`);

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
        'flex h-nav flex-none items-center rounded-ctl text-body font-medium hover:bg-bg-hover hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120',
        active ? 'bg-bg-hover text-ink-1' : 'text-ink-3',
        collapsed
          ? 'relative w-9 justify-center'
          : cn('w-full gap-2.5 border-l-2 px-2.5 text-left', active ? 'border-amber' : 'border-transparent'),
      )}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden />
      {collapsed ? (
        badge > 0 && <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber" />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {badge > 0 && (
            <span
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

function StatusCard({ online, liveText }: { online: boolean; liveText: string }) {
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
      <div className="flex items-center gap-1.5 font-mono text-mono-sm text-ink-3">
        <span aria-hidden className={cn('h-1.5 w-1.5 flex-none rounded-full', online ? 'bg-amber' : 'bg-ink-5')} />
        {liveText}
      </div>
      <div className="font-mono text-mono-sm text-ink-4">
        {t('common.status.hangar', { count: hangar.count, size: formatBytes(hangar.sizeBytes) })}
      </div>
    </div>
  );
}
