import { Check } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from '@/lib/cn';

export interface MenuItem {
  /** Passed to `onSelect`; in radio menus it is also compared with `value` to draw the check. */
  value: string;
  label: ReactNode;
  /**
   * Right-aligned secondary content, e.g. a mono code or a count. The highlighted item is bg-4, where
   * ink-4 is 4.25:1: brighten small hints with `group-hover:text-ink-3 group-focus-visible:text-ink-3`.
   */
  hint?: ReactNode;
  /** Focusable (WAI-ARIA menu pattern) but not activatable. */
  disabled?: boolean;
  /** Text matched by type-ahead when `label` is not plain text. */
  textValue?: string;
}

/** Spread these onto the trigger element (a `<button>` or `Button`). */
export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement>;
  id: string;
  type: 'button';
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuProps {
  items: readonly MenuItem[];
  onSelect: (value: string) => void;
  /**
   * Renders the menu button. Clicks and the keys the menu owns (trigger and items) never bubble,
   * so a menu can sit inside a clickable card.
   */
  renderTrigger: (props: MenuTriggerProps, state: { open: boolean }) => ReactNode;
  /** `action`: plain `menuitem`s. `radio`: `menuitemradio`s with an amber check on `value`. */
  kind?: 'action' | 'radio';
  /** Checked item of a radio menu. */
  value?: string | null;
  /** Accessible name of the menu; defaults to the trigger's name. */
  label?: string;
  /** `bottom`: under a 28px control. `top`: above it (Hangar bulk bar). */
  placement?: 'bottom' | 'top';
  /** Which trigger edge the popover lines up with. */
  align?: 'start' | 'end';
  /** Controlled open state (keep one menu open at a time from the caller). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Wrapper classes (the wrapper is the popover's positioning context). */
  className?: string;
  /**
   * Popover width classes; replaces the default `min-w-[160px]`: the prototype's `min-width:150px` is
   * content-box (+8px padding +2px border). Explore's 160/170px menus are `min-w-[170px]` / `min-w-[180px]`.
   */
  menuWidthClass?: string;
}

type InitialFocus = 'start' | 'end';

/** Keys the trigger acts on (Escape only while open, via the wrapper). */
const TRIGGER_KEYS = new Set(['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Escape']);

/**
 * Menu button (WAI-ARIA APG): elevation-1 popover with 4px padding and 7×10 items.
 * ArrowDown / Enter / Space on the trigger open it on the checked (or first) item, ArrowUp on the last;
 * ↑ ↓ Home End and type-ahead move; Enter / Space activate; Escape closes only the menu and returns
 * focus to the trigger; Tab and an outside mousedown close it.
 */
export function Menu({
  items,
  onSelect,
  renderTrigger,
  kind = 'action',
  value,
  label,
  placement = 'bottom',
  align = 'start',
  open: openProp,
  onOpenChange,
  className,
  menuWidthClass = 'min-w-[160px]',
}: MenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const menuId = `${baseId}-menu`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  itemRefs.current.length = items.length;
  const initialFocus = useRef<InitialFocus>('start');

  const checkedIndex = kind === 'radio' ? items.findIndex((item) => item.value === value) : -1;

  const focusIndex = (i: number) => itemRefs.current[i]?.focus();
  const focusInitial = (where: InitialFocus) => {
    const last = itemRefs.current.length - 1;
    focusIndex(checkedIndex >= 0 ? checkedIndex : where === 'end' ? last : 0);
  };

  // Move focus into the menu when it opens (click, keyboard or controlled).
  const focusInitialRef = useRef(focusInitial);
  focusInitialRef.current = focusInitial;
  useEffect(() => {
    if (!open) return;
    focusInitialRef.current(initialFocus.current);
    initialFocus.current = 'start';
  }, [open]);

  // A mousedown anywhere outside the trigger and the popover closes without moving focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && wrapperRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, setOpen]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const activate = (item: MenuItem) => {
    if (item.disabled) return;
    close(true);
    onSelect(item.value);
  };

  const openWithKeyboard = (where: InitialFocus) => {
    if (open) focusInitial(where);
    else {
      initialFocus.current = where;
      setOpen(true);
    }
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      openWithKeyboard(e.key === 'ArrowDown' ? 'start' : 'end');
    } else if (e.key === 'Enter' || e.key === ' ') {
      // They reach onClick through the button's native activation; a parent card must not act on them.
      e.stopPropagation();
    }
  };

  // The keyups of keys the menu handled stay here too (Space activates on keyup; after Enter or Escape
  // on an item the keyup lands on the trigger).
  const onTriggerKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (TRIGGER_KEYS.has(e.key)) e.stopPropagation();
  };
  const onMenuKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') e.stopPropagation();
  };

  const typeAhead = (char: string) => {
    const els = itemRefs.current;
    const current = els.findIndex((el) => el === document.activeElement);
    const needle = char.toLowerCase();
    for (let step = 1; step <= els.length; step++) {
      const i = (current + step) % els.length;
      const text = items[i]?.textValue ?? els[i]?.textContent ?? '';
      if (text.trim().toLowerCase().startsWith(needle)) {
        focusIndex(i);
        return;
      }
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const count = itemRefs.current.length;
    if (count === 0) return;
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        next = (current + 1) % count;
        break;
      case 'ArrowUp':
        next = current <= 0 ? count - 1 : current - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      case 'Tab':
        // Hand focus back to the trigger first so the browser's Tab moves on from there.
        close(true);
        return;
      case 'Escape':
        // Handled (and stopped) by the wrapper, which also covers a focused trigger.
        return;
      case 'Enter':
      case ' ':
        // Native activation clicks the item; nothing underneath acts on the key.
        e.stopPropagation();
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Type-ahead owns printable keys while the menu has focus (no section shortcuts underneath).
          e.preventDefault();
          e.stopPropagation();
          typeAhead(e.key);
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    focusIndex(next);
  };

  // Escape closes only this layer: nothing underneath (dialogs, window shortcuts) sees it.
  const onWrapperKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };

  // Focus leaving for another element (not the window, not a click on the popover's padding) closes.
  const onWrapperBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget;
    if (open && to instanceof Node && !e.currentTarget.contains(to)) setOpen(false);
  };

  const triggerProps: MenuTriggerProps = {
    ref: triggerRef,
    id: triggerId,
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: (e) => {
      e.stopPropagation();
      if (!open) initialFocus.current = 'start';
      setOpen(!open);
    },
    onKeyDown: onTriggerKeyDown,
    onKeyUp: onTriggerKeyUp,
  };

  return (
    <div ref={wrapperRef} className={cn('relative inline-flex', className)} onKeyDown={onWrapperKeyDown} onBlur={onWrapperBlur}>
      {renderTrigger(triggerProps, { open })}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          aria-labelledby={label ? undefined : triggerId}
          onKeyDown={onMenuKeyDown}
          onKeyUp={onMenuKeyUp}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            // Keep focus on the current item when the popover's padding is clicked.
            if (e.target === e.currentTarget) e.preventDefault();
          }}
          className={cn(
            'absolute z-20 flex flex-col rounded-ctl border border-line-3 bg-bg-3 p-1 shadow-menu',
            placement === 'bottom' ? 'top-[32px]' : 'bottom-[34px]',
            align === 'start' ? 'left-0' : 'right-0',
            menuWidthClass,
          )}
        >
          {items.map((item, i) => {
            const checked = kind === 'radio' && i === checkedIndex;
            return (
              <button
                key={item.value}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role={kind === 'radio' ? 'menuitemradio' : 'menuitem'}
                aria-checked={kind === 'radio' ? checked : undefined}
                aria-disabled={item.disabled || undefined}
                tabIndex={-1}
                onClick={() => activate(item)}
                className={cn(
                  // `leading-[normal]` matches the prototype's `font:` shorthand (30px rows). `group`: a hint
                  // can brighten on the highlighted bg-4 (`group-hover:` / `group-focus-visible:`).
                  'group flex items-center justify-between gap-3 whitespace-nowrap rounded-menu px-2.5 py-[7px] text-left text-meta leading-[normal] focus-visible:-outline-offset-2',
                  item.disabled ? 'cursor-default text-ink-5' : 'text-ink-1 hover:bg-bg-4 focus-visible:bg-bg-4',
                )}
              >
                <span className="min-w-0">{item.label}</span>
                {(item.hint !== undefined || checked) && (
                  <span className="flex flex-none items-center gap-2">
                    {item.hint}
                    {checked && <Check size={14} strokeWidth={1.75} aria-hidden className="text-amber" />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
