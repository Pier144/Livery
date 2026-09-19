import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost';
/** Control heights used across the spec (px). */
type Size = 26 | 28 | 30 | 32 | 34 | 36;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary: 'border-0 bg-amber font-semibold text-onAmber hover:bg-amber-hover',
  secondary: 'border border-line-3 bg-bg-4 font-medium text-ink-1 hover:border-line-4',
  ghost: 'border-0 bg-transparent font-normal text-ink-3 hover:text-ink-1',
};

// 26–32 carry 12px labels, 34–36 carry 13px labels.
const sizes: Record<Size, string> = {
  26: 'h-[26px] px-2.5 text-meta',
  28: 'h-ctl px-2.5 text-meta',
  30: 'h-btn px-3 text-meta',
  32: 'h-8 px-3.5 text-meta',
  34: 'h-[34px] px-4 text-body',
  36: 'h-btn-lg px-4 text-body',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 34, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex flex-none items-center justify-center gap-2 whitespace-nowrap rounded-ctl leading-none transition-colors duration-120 disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    />
  );
});
