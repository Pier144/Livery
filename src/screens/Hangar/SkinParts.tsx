import type { TFunction } from 'i18next';
import type { KeyboardEvent, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import type { HangarSkin } from '@/types';

/** What a grid card and a list row need from the screen. Handlers must be stable (the items are memoized). */
export interface SkinItemProps {
  skin: HangarSkin;
  selected: boolean;
  /** A re-check of this skin is running. */
  rechecking: boolean;
  /** `range`: Shift was held (select from the last toggled skin). */
  onSelect: (id: string, range: boolean) => void;
  onToggleActive: (skin: HangarSkin) => void;
  onRecheck: (skin: HangarSkin) => void;
}

/**
 * The first attention item in the UI language (the backend's English message is the fallback for
 * kinds this build doesn't know), plus "+N" when there are more.
 */
export function attentionText(t: TFunction, skin: HangarSkin): string | null {
  const list = skin.attention ?? [];
  const first = list[0];
  if (!first) return null;
  const message = t(`hangar.attention.${first.kind}`, { file: first.file ?? '', defaultValue: first.message });
  return list.length > 1 ? t('hangar.card.attentionMore', { message, count: list.length - 1 }) : message;
}

/**
 * Keyboard/click handlers for the element that selects a skin (`role=button`): Enter or Space
 * toggles, Shift extends from the last toggled skin.
 */
export function selectHandlers(id: string, onSelect: SkinItemProps['onSelect']) {
  return {
    onClick: (e: MouseEvent<HTMLElement>) => onSelect(id, e.shiftKey),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // Space would scroll the list; Enter would repeat while held.
      e.preventDefault();
      if (!e.repeat) onSelect(id, e.shiftKey);
    },
  };
}

/**
 * 24px Active/Inactive toggle (README: Active text amber). `Inactive` uses ink-3: ink-4 on bg-4 is
 * 4.2:1, under AA for 11px text.
 */
export function ActiveToggle({ active, onToggle, className }: { active: boolean; onToggle: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        'relative z-[1] h-6 flex-none whitespace-nowrap rounded-[5px] border border-line-3 bg-bg-4 px-2 text-[11px] font-medium leading-none hover:border-line-4 motion-safe:transition-colors motion-safe:duration-120',
        active ? 'text-amber' : 'text-ink-3',
        className,
      )}
    >
      {active ? t('hangar.card.active') : t('hangar.card.inactive')}
    </button>
  );
}

/** Underlined "Re-check" text button shown on skins that need attention. */
export function RecheckLink({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-disabled={busy || undefined}
      onClick={() => {
        if (!busy) onClick();
      }}
      className="relative z-[1] flex-none whitespace-nowrap text-[11px] leading-[normal] text-ink-3 underline underline-offset-[3px] hover:text-ink-1 aria-disabled:cursor-default aria-disabled:opacity-50 motion-safe:transition-colors motion-safe:duration-120"
    >
      {t('hangar.card.recheck')}
    </button>
  );
}
