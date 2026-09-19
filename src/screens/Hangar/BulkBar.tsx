import { ChevronDown, X } from 'lucide-react';
import { forwardRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { cn } from '@/lib/cn';
import { useCollections } from '@/queries/collections';
import type { Collection } from '@/types';

export interface BulkBarProps {
  /** Selected skins the bar acts on. */
  count: number;
  /** An action is running: the controls stay focusable but ignore clicks. */
  busy: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onMove: (collection: Collection) => void;
  onExport: () => void;
  onDelete: () => void;
  onClear: () => void;
}

/** Menu value of the "No collections yet" placeholder (cannot collide with a collection id). */
const NO_COLLECTIONS = ' none';

/** Marks the bar's own controls for ←/→ navigation (not the move menu's items). */
const CONTROL = { 'data-bulk-control': '' } as const;

const BUSY = 'aria-disabled:cursor-default aria-disabled:opacity-50';

/** 28px secondary-button look, for the controls that aren't `Button`s. */
const SECONDARY =
  'flex h-ctl flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border border-line-3 bg-bg-4 px-2.5 text-meta font-medium leading-none motion-safe:transition-colors motion-safe:duration-120';

/**
 * Floating bulk-action bar (README "Bulk bar"), shown while skins are selected. A `toolbar`: ←/→,
 * Home and End move between its controls; Escape clears the selection unless a menu is open (the
 * menu closes first). F6 jumps here from the list and back (My Hangar's `useBulkBarShortcut`).
 */
export const BulkBar = forwardRef<HTMLDivElement, BulkBarProps>(function BulkBar(
  { count, busy, onActivate, onDeactivate, onMove, onExport, onDelete, onClear },
  ref,
) {
  const { t } = useTranslation();
  const { data } = useCollections();
  const collections = data?.collections ?? [];
  const items: MenuItem[] =
    collections.length > 0
      ? collections.map((c) => ({ value: c.id, label: c.name }))
      : [{ value: NO_COLLECTIONS, label: t('hangar.bulk.noCollections'), disabled: true }];

  const guard = (action: () => void) => () => {
    if (!busy) action();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return;
      // Only this layer: nothing underneath (window shortcuts) sees it.
      e.preventDefault();
      e.stopPropagation();
      onClear();
      return;
    }
    const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-bulk-control]'));
    const at = controls.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
        next = (at + 1) % controls.length;
        break;
      case 'ArrowLeft':
        next = (at - 1 + controls.length) % controls.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = controls.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    controls[next]?.focus();
  };

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('hangar.bulk.label')}
      aria-keyshortcuts="F6"
      onKeyDown={onKeyDown}
      className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-card border border-line-4 bg-bg-3 py-2 pl-3.5 pr-2 shadow-dialog"
    >
      <span className="mr-2 text-meta font-medium leading-[normal] text-ink-1">{t('hangar.bulk.selected', { count })}</span>
      <Button {...CONTROL} size={28} aria-disabled={busy || undefined} onClick={guard(onActivate)} className={BUSY}>
        {t('hangar.bulk.activate')}
      </Button>
      <Button {...CONTROL} size={28} aria-disabled={busy || undefined} onClick={guard(onDeactivate)} className={BUSY}>
        {t('hangar.bulk.deactivate')}
      </Button>
      <Menu
        items={items}
        placement="top"
        menuWidthClass="min-w-[180px]"
        label={t('hangar.bulk.move')}
        onSelect={(id) => {
          const collection = collections.find((c) => c.id === id);
          if (collection && !busy) onMove(collection);
        }}
        renderTrigger={(props) => (
          <button {...props} {...CONTROL} aria-disabled={busy || undefined} className={cn(SECONDARY, 'text-ink-1 hover:border-line-4', BUSY)}>
            {t('hangar.bulk.move')}
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="text-ink-5" />
          </button>
        )}
      />
      <Button {...CONTROL} size={28} aria-disabled={busy || undefined} onClick={guard(onExport)} className={BUSY}>
        {t('hangar.bulk.export')}
      </Button>
      <button
        {...CONTROL}
        type="button"
        aria-disabled={busy || undefined}
        onClick={guard(onDelete)}
        className={cn(SECONDARY, 'text-danger hover:border-danger', BUSY)}
      >
        {t('hangar.bulk.delete')}
      </button>
      <button
        {...CONTROL}
        type="button"
        aria-label={t('hangar.clearSelection')}
        title={t('hangar.clearSelection')}
        onClick={onClear}
        className="flex h-ctl w-7 flex-none items-center justify-center rounded-ctl text-ink-3 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
});
