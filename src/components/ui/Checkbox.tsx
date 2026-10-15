import { Minus } from 'lucide-react';
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type MouseEvent } from 'react';
import { cn } from '@/lib/cn';
import { play, POP, useJustEntered } from '@/lib/motion';
import { AnimatedCheck } from './AnimatedCheck';

export interface CheckboxProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onClick' | 'role' | 'type' | 'aria-checked' | 'children'> {
  checked: boolean;
  /** Called with the next state; the click event carries modifiers (e.g. Shift for range selection). */
  onChange: (checked: boolean, event: MouseEvent<HTMLButtonElement>) => void;
  /** Shown as a dash with `aria-checked="mixed"`; a click then checks. */
  indeterminate?: boolean;
  /** Accessible name (no visible label); or pass `aria-labelledby`. */
  label?: string;
  /** Keep clicks and Space/Enter from reaching a clickable parent (e.g. a card that opens on click). */
  stopPropagation?: boolean;
}

/**
 * 18px checkbox (`role=checkbox` button): Space toggles, Enter does nothing (as a native checkbox).
 * An invisible 3px halo brings the hit area to 24px without changing the look.
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { checked, onChange, indeterminate = false, label, stopPropagation = false, className, onKeyDown, onKeyUp, ...rest },
  ref,
) {
  const on = checked || indeterminate;
  // Checked by the user (not mounted checked): a small pop while the check draws itself.
  const justChecked = useJustEntered(checked && !indeterminate);
  const own = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (justChecked) play(own.current, ...POP);
  }, [justChecked]);

  const guardKey = (e: KeyboardEvent<HTMLButtonElement>) => stopPropagation && (e.key === ' ' || e.key === 'Enter');

  return (
    <button
      ref={(el) => {
        own.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onChange(indeterminate ? true : !checked, e);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key === 'Enter') e.preventDefault();
        if (guardKey(e)) e.stopPropagation();
      }}
      onKeyUp={(e) => {
        onKeyUp?.(e);
        if (guardKey(e)) e.stopPropagation();
      }}
      className={cn(
        "relative inline-flex h-4.5 w-4.5 flex-none items-center justify-center rounded-menu border p-0 before:absolute before:-inset-[3px] before:content-[''] disabled:opacity-50 motion-safe:transition-colors motion-safe:duration-120",
        // Unchecked border ink-5, not the prototype line-4: 3:1 non-text contrast (WCAG 1.4.11).
        on ? 'border-amber bg-amber text-onAmber' : 'border-ink-5 bg-transparent',
        className,
      )}
      {...rest}
    >
      {indeterminate ? (
        <Minus size={12} strokeWidth={2.5} aria-hidden />
      ) : checked ? (
        <AnimatedCheck size={12} strokeWidth={2.5} animate={justChecked} />
      ) : null}
    </button>
  );
});
