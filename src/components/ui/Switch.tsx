import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onClick' | 'role' | 'type' | 'aria-checked' | 'children'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name when there is no visible label to reference with `aria-labelledby`. */
  label?: string;
}

/** 34×18 toggle (Queue "Watch Downloads folder", Settings): line-3 when off, amber when on. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-4.5 w-[34px] flex-none rounded-pill p-0 disabled:opacity-50 motion-safe:transition-colors motion-safe:duration-150',
        // The off track gets an ink-5 inner ring so its outline reaches 3:1 (WCAG 1.4.11).
        checked ? 'bg-amber' : 'bg-line-3 ring-1 ring-inset ring-ink-5',
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          'absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-onAmber motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out',
          checked && 'translate-x-4',
        )}
      />
    </button>
  );
});
