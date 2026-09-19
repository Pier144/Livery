import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/Checkbox';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import type { HangarSkin } from '@/types';
import { ActiveToggle, attentionText, itemHandlers, RecheckLink, useSkinDescription, type SkinItemProps } from './SkinParts';

function authorOf(skin: HangarSkin, you: string, none: string): string {
  if (skin.author?.name) return skin.author.name;
  return skin.origin === 'mine' ? you : none;
}

/**
 * My Hangar list row: checkbox, thumb, name (+ attention line and Re-check), origin, author, size,
 * Active toggle. Opening and selection work like the grid card (full-row hit area under the controls).
 */
export const SkinRow = memo(function SkinRow({ skin, selected, rechecking, onSelect, onToggleActive, onRecheck }: SkinItemProps) {
  const { t } = useTranslation();
  const attention = attentionText(t, skin);
  const { attentionId, describedBy, title } = useSkinDescription(skin, attention);

  return (
    <div
      data-skin-id={skin.id}
      // Focus comes back here from the Skin detail of the WT Live post it came from (useScreenFocus).
      data-source-id={skin.sourceId}
      // Names the card's inner controls ("Active", "Re-check"), which repeat on every skin.
      role="group"
      aria-label={skin.name}
      className={cn(
        'group relative grid grid-cols-[28px_44px_minmax(0,2fr)_1fr_1fr_80px_80px] items-center gap-3 border-b border-line-grid px-3 py-2 motion-safe:transition-colors motion-safe:duration-120',
        selected ? 'bg-bg-hover' : 'hover:bg-bg-hover',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={skin.name}
        aria-describedby={describedBy}
        // The attention line truncates in a narrow window (Italian at 1100px): the tooltip has it all.
        title={title}
        {...itemHandlers(skin, onSelect)}
        className="absolute inset-0 cursor-pointer focus-visible:-outline-offset-2"
      />
      <Checkbox
        checked={selected}
        onChange={(_, e) => onSelect(skin.id, e.shiftKey)}
        label={t('hangar.card.select', { name: skin.name })}
        stopPropagation
        tabIndex={-1}
        className="relative z-[1]"
      />
      <span aria-hidden className="h-[26px] w-11 rounded-tag bg-placeholder-thumb" />
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-body font-medium leading-[normal] text-ink-1">{skin.name}</span>
        {attention && (
          <span className="flex min-w-0 items-baseline gap-2 text-[11px] leading-[normal]">
            <span id={attentionId} className="min-w-0 truncate text-amber">
              {attention}
            </span>
            <RecheckLink busy={rechecking} onClick={() => onRecheck(skin)} />
          </span>
        )}
      </span>
      <span className={cn('truncate text-meta leading-[normal]', skin.origin === 'mine' ? 'text-amber' : 'text-ink-3')}>
        {t(`hangar.origin.${skin.origin}`)}
      </span>
      <span className="truncate text-meta leading-[normal] text-ink-3">
        {authorOf(skin, t('hangar.card.authorYou'), t('hangar.card.noAuthor'))}
      </span>
      {/* ink-4 is 4.39:1 on bg-hover (selected or hovered row): ink-3 there. */}
      <span className={cn('text-right font-mono text-mono-sm leading-[normal]', selected ? 'text-ink-3' : 'text-ink-4 group-hover:text-ink-3')}>
        {formatBytes(skin.sizeBytes)}
      </span>
      <span className="flex">
        <ActiveToggle active={skin.active} onToggle={() => onToggleActive(skin)} />
      </span>
    </div>
  );
});
