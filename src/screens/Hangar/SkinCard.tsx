import { memo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/Checkbox';
import { cn } from '@/lib/cn';
import { useCardMotion } from '@/store/hangarMotion';
import { formatBytes } from '@/lib/format';
import {
  ActiveToggle,
  attentionText,
  EditableName,
  itemHandlers,
  RecheckLink,
  RenameButton,
  SkinPreview,
  UninstallButton,
  useSkinDescription,
  type SkinItemProps,
} from './SkinParts';

/**
 * My Hangar grid card. The card itself is a toggle button (pressed = selected): a WT Live skin opens
 * its Skin detail on click / Enter and selects with Space, a local skin selects with all three (see
 * `itemHandlers`); a hidden hint says which. It is drawn as a full-card hit area *under* the other
 * controls rather than as the card's own role, so the checkbox and buttons are not nested inside a
 * button (axe `nested-interactive`). The checkbox is not a tab stop: the card already selects from
 * the keyboard.
 */
export const SkinCard = memo(function SkinCard({ skin, selected, rechecking, onSelect, onToggleActive, onRecheck, onUninstall, onRename }: SkinItemProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const renameRef = useRef<HTMLButtonElement>(null);
  const endRename = () => {
    setEditing(false);
    requestAnimationFrame(() => renameRef.current?.focus());
  };
  const attention = attentionText(t, skin);
  const { attentionId, describedBy, title } = useSkinDescription(skin, attention);
  // Fading out on its way to the bin, or in after an Undo.
  const motion = useCardMotion(skin.id);

  return (
    <div
      data-skin-id={skin.id}
      // Focus comes back here from the Skin detail of the WT Live post it came from (useScreenFocus).
      data-source-id={skin.sourceId}
      // Names the card's inner controls ("Active", "Re-check"), which repeat on every skin.
      role="group"
      aria-label={skin.name}
      className={cn(
        'group relative flex min-w-0 flex-col rounded-card border motion-safe:transition-[color,background-color,border-color,transform] motion-safe:duration-150 motion-safe:ease-decel motion-safe:hover:-translate-y-px',
        selected ? 'border-amber bg-bg-hover' : 'border-line-2 bg-bg-3 hover:border-line-mark',
        motion,
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={skin.name}
        aria-describedby={describedBy}
        title={title}
        {...itemHandlers(skin, onSelect, onUninstall, () => setEditing(true))}
        className="absolute inset-0 cursor-pointer rounded-card"
      />
      {/* 16:9 picture: the WT Live post's, else one shipped in the skin's folder, else the stripes. */}
      <SkinPreview skin={skin} className="aspect-video rounded-t-[7px] bg-placeholder" />
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
        <div className="flex min-w-0 text-body font-medium leading-[normal] text-ink-1">
          <EditableName skin={skin} editing={editing} onRename={onRename} onDone={endRename} />
        </div>
        <div className="flex items-baseline justify-between gap-2 text-[11px] leading-[normal]">
          <span className={skin.origin === 'mine' ? 'text-amber' : 'text-ink-3'}>{t(`hangar.origin.${skin.origin}`)}</span>
          {/* ink-4 is 4.4:1 on the selected card's bg-hover; ink-3 keeps AA there. */}
          <span className={cn('font-mono text-[10px]', selected ? 'text-ink-3' : 'text-ink-4')}>{formatBytes(skin.sizeBytes)}</span>
        </div>
        {attention && (
          <div id={attentionId} className="text-[11px] leading-[normal] text-amber">
            {attention}
          </div>
        )}
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <ActiveToggle active={skin.active} onToggle={() => onToggleActive(skin)} />
          <span className="flex items-center gap-1.5">
            {attention && <RecheckLink busy={rechecking} onClick={() => onRecheck(skin)} />}
            <RenameButton ref={renameRef} onClick={() => setEditing(true)} />
            <UninstallButton onClick={() => onUninstall(skin)} />
          </span>
        </div>
      </div>
    </div>
  );
});
