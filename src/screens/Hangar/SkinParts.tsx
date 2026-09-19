import type { TFunction } from 'i18next';
import { createContext, useContext, useId, useMemo, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { useUi } from '@/store/ui';
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
 * Keyboard/click handlers for a card's full-area button (`role=button`, `aria-pressed` = selected).
 * A skin that came from WT Live (`sourceId`) opens its Skin detail on click or Enter, as in the
 * prototype; Space, Ctrl/Cmd+click and the checkbox select it. A local skin has no page: click,
 * Enter and Space toggle its selection. Shift (click, Enter or Space) always extends the selection
 * from the last toggled skin.
 */
export function itemHandlers(skin: HangarSkin, onSelect: SkinItemProps['onSelect']) {
  const source = skin.sourceId;
  return {
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (source && !e.shiftKey && !e.ctrlKey && !e.metaKey) useUi.getState().openSkin(source);
      else onSelect(skin.id, e.shiftKey);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // Space would scroll the list; Enter would repeat while held.
      e.preventDefault();
      if (e.repeat) return;
      if (source && e.key === 'Enter' && !e.shiftKey) useUi.getState().openSkin(source);
      else onSelect(skin.id, e.shiftKey);
    },
  };
}

/** Ids of the two hidden hints that tell screen-reader users what a card's keys do. */
interface SkinHintIds {
  /** WT Live skin: Enter opens the Skin detail, Space selects. */
  open: string;
  /** Local skin: Enter or Space selects (there is no page to open). */
  select: string;
}

const SkinHintContext = createContext<SkinHintIds | null>(null);

/** Renders the hints once for every card below it (the cards point at them with aria-describedby). */
export function SkinHints({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const base = useId();
  const ids = useMemo(() => ({ open: `${base}-open`, select: `${base}-select` }), [base]);
  return (
    <SkinHintContext.Provider value={ids}>
      <span id={ids.open} hidden>
        {t('hangar.card.hintOpen')}
      </span>
      <span id={ids.select} hidden>
        {t('hangar.card.hintSelect')}
      </span>
      {children}
    </SkinHintContext.Provider>
  );
}

/** `aria-describedby` for a card's full-area button (none outside `SkinHints`). */
export function useSkinHint(skin: HangarSkin): string | undefined {
  const ids = useContext(SkinHintContext);
  if (!ids) return undefined;
  return skin.sourceId ? ids.open : ids.select;
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
