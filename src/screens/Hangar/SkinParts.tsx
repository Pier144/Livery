import type { TFunction } from 'i18next';
import { Pencil, Trash2 } from 'lucide-react';
import { createContext, forwardRef, useContext, useId, useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { useUi } from '@/store/ui';
import type { HangarSkin } from '@/types';
import { useSkinPreview } from './useSkinPreview';

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
  /** Removes the skin from the game (undoable). */
  onUninstall: (skin: HangarSkin) => void;
  /** Renames the skin's folder (undoable). Resolves to false when the name was refused. */
  onRename: (skin: HangarSkin, name: string) => Promise<boolean>;
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
 * from the last toggled skin. Delete uninstalls it, F2 starts renaming it.
 */
export function itemHandlers(
  skin: HangarSkin,
  onSelect: SkinItemProps['onSelect'],
  onUninstall: SkinItemProps['onUninstall'],
  onStartRename: () => void,
) {
  const source = skin.sourceId;
  return {
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (source && !e.shiftKey && !e.ctrlKey && !e.metaKey) useUi.getState().openSkin(source);
      else onSelect(skin.id, e.shiftKey);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Delete' && !e.repeat) {
        e.preventDefault();
        onUninstall(skin);
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        onStartRename();
        return;
      }
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
 * What a card's or row's full-area button needs besides its handlers: the key hint and the
 * attention message (`attentionId` goes on the element showing it) in `aria-describedby`, and a
 * tooltip with the name and the message, which a narrow row truncates (the hit area sits on top of
 * the text, so the tooltip has to be its own).
 */
export function useSkinDescription(skin: HangarSkin, attention: string | null) {
  const hint = useSkinHint(skin);
  const attentionId = useId();
  const describedBy = [hint, attention ? attentionId : undefined].filter(Boolean).join(' ') || undefined;
  const title = attention ? `${skin.name}\n${attention}` : skin.name;
  return { attentionId, describedBy, title };
}

/**
 * 24px Active/Inactive toggle (README: Active text amber). `Inactive` uses ink-3: ink-4 on bg-4 is
 * 4.2:1, under AA for 11px text. The visible text follows the state, so screen readers get a
 * switch with a stable name ("Active in game, on / off") instead of a toggle button whose name
 * flips ("Inactive, not pressed" read as a contradiction). The card's group names the skin.
 */
export function ActiveToggle({ active, onToggle, className }: { active: boolean; onToggle: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={t('hangar.card.activeToggle')}
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

/**
 * 24px "Uninstall" icon button (Lucide `trash-2`): removes the skin's folder from the game, with a
 * backup and Undo in the toast. Danger colour on hover. The card's group names the skin.
 */
export function UninstallButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  const label = t('hangar.card.uninstall');
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-keyshortcuts="Delete"
      title={label}
      className="relative z-[1] flex h-6 w-6 flex-none items-center justify-center rounded-[5px] border border-line-3 bg-bg-4 text-ink-3 hover:border-danger-40 hover:text-danger motion-safe:transition-colors motion-safe:duration-120"
    >
      <Trash2 aria-hidden size={14} strokeWidth={1.75} />
    </button>
  );
}

/** 24px icon button next to Uninstall (Lucide `pencil`): edits the skin's name in place. */
export const RenameButton = forwardRef<HTMLButtonElement, { onClick: () => void }>(function RenameButton({ onClick }, ref) {
  const { t } = useTranslation();
  const label = t('hangar.card.rename');
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-keyshortcuts="F2"
      title={label}
      className="relative z-[1] flex h-6 w-6 flex-none items-center justify-center rounded-[5px] border border-line-3 bg-bg-4 text-ink-3 hover:border-line-4 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
    >
      <Pencil aria-hidden size={14} strokeWidth={1.75} />
    </button>
  );
});

/** Longest folder name Livery creates (archive/analyze.rs `MAX_FOLDER_CHARS`). */
export const MAX_SKIN_NAME = 120;

/** Why `name` can't be a skin folder (the same rules as the backend), or null when it can. */
export function folderNameProblem(name: string): 'empty' | 'chars' | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (/[<>:"/\\|?*]/.test(trimmed) || /\p{Cc}/u.test(trimmed) || trimmed.startsWith('.') || trimmed.endsWith('.')) return 'chars';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(trimmed)) return 'chars';
  return null;
}

/**
 * The skin's name, or a text field while renaming: Enter or leaving the field saves, Escape
 * cancels. A refused name keeps the field open. `onDone` runs once editing ends.
 */
export function EditableName({
  skin,
  editing,
  onRename,
  onDone,
  className,
}: {
  skin: HangarSkin;
  editing: boolean;
  onRename: SkinItemProps['onRename'];
  onDone: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const saving = useRef(false);
  if (!editing) return <span className={cn('truncate', className)}>{skin.name}</span>;
  const save = async (input: HTMLInputElement) => {
    if (saving.current) return;
    const next = input.value.trim();
    if (!next || next === skin.folder) return onDone();
    saving.current = true;
    const ok = await onRename(skin, next);
    saving.current = false;
    if (ok) onDone();
    else input.focus();
  };
  return (
    <input
      // Opened on purpose by Rename / F2.
      autoFocus
      defaultValue={skin.folder}
      maxLength={MAX_SKIN_NAME}
      aria-label={t('hangar.card.renameLabel', { name: skin.name })}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          void save(e.currentTarget);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDone();
        }
      }}
      onBlur={(e) => void save(e.currentTarget)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'relative z-[1] h-6 w-full min-w-0 rounded-[5px] border border-amber bg-bg-input px-1.5 text-body font-medium leading-none text-ink-1 outline-none',
        className,
      )}
    />
  );
}

/**
 * The skin's picture (see `useSkinPreview`) over the striped placeholder, which shows until it
 * loads and when there is none. Decorative: the card names the skin.
 */
export function SkinPreview({ skin, className }: { skin: HangarSkin; className?: string }) {
  const src = useSkinPreview(skin);
  return (
    <span aria-hidden className={cn('pointer-events-none relative block overflow-hidden', className)}>
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          // Inside a hovered card (`group`) the picture moves in a little.
          className="absolute inset-0 h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-250 motion-safe:ease-decel motion-safe:group-hover:scale-[1.03]"
        />
      )}
    </span>
  );
}
