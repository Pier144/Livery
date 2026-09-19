import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/Checkbox';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { ActiveToggle, attentionText, itemHandlers, RecheckLink, useSkinHint, type SkinItemProps } from './SkinParts';

/**
 * My Hangar grid card. The card itself is a toggle button (pressed = selected): a WT Live skin opens
 * its Skin detail on click / Enter and selects with Space, a local skin selects with all three (see
 * `itemHandlers`); a hidden hint says which. It is drawn as a full-card hit area *under* the other
 * controls rather than as the card's own role, so the checkbox and buttons are not nested inside a
 * button (axe `nested-interactive`). The checkbox is not a tab stop: the card already selects from
 * the keyboard.
 */
export const SkinCard = memo(function SkinCard({ skin, selected, rechecking, onSelect, onToggleActive, onRecheck }: SkinItemProps) {
  const { t } = useTranslation();
  const attention = attentionText(t, skin);
  const hint = useSkinHint(skin);

  return (
    <div
      data-skin-id={skin.id}
      // Names the card's inner controls ("Active", "Re-check"), which repeat on every skin.
      role="group"
      aria-label={skin.name}
      className={cn(
        'relative flex min-w-0 flex-col rounded-card border motion-safe:transition-colors motion-safe:duration-120',
        selected ? 'border-amber bg-bg-hover' : 'border-line-2 bg-bg-3 hover:border-line-mark',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={skin.name}
        aria-describedby={hint}
        title={skin.name}
        {...itemHandlers(skin, onSelect)}
        className="absolute inset-0 cursor-pointer rounded-card"
      />
      {/* 16:9 image area; the real screenshot arrives with WT Live data (M5). */}
      <div aria-hidden className="aspect-video rounded-t-[7px] bg-placeholder" />
      {/* Positioned by a wrapper: the checkbox is `relative` itself (its hit-area halo). */}
      <span className="absolute left-2 top-2 z-[1] flex">
        <Checkbox
          checked={selected}
          onChange={(_, e) => onSelect(skin.id, e.shiftKey)}
          label={t('hangar.card.select', { name: skin.name })}
          stopPropagation
          tabIndex={-1}
        />
      </span>
      {attention && (
        <span className="pointer-events-none absolute right-2 top-2 rounded-menu bg-amber px-1.5 py-0.5 font-mono text-[10px] font-medium leading-[normal] text-onAmber">
          {t('hangar.card.needsAttention')}
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-[5px] px-3 py-2.5">
        <div className="truncate text-body font-medium leading-[normal] text-ink-1">{skin.name}</div>
        <div className="flex items-baseline justify-between gap-2 text-[11px] leading-[normal]">
          <span className={skin.origin === 'mine' ? 'text-amber' : 'text-ink-3'}>{t(`hangar.origin.${skin.origin}`)}</span>
          {/* ink-4 is 4.4:1 on the selected card's bg-hover; ink-3 keeps AA there. */}
          <span className={cn('font-mono text-[10px]', selected ? 'text-ink-3' : 'text-ink-4')}>{formatBytes(skin.sizeBytes)}</span>
        </div>
        {attention && <div className="text-[11px] leading-[normal] text-amber">{attention}</div>}
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <ActiveToggle active={skin.active} onToggle={() => onToggleActive(skin)} />
          {attention && <RecheckLink busy={rechecking} onClick={() => onRecheck(skin)} />}
        </div>
      </div>
    </div>
  );
});
