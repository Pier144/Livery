import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface KbdProps {
  children: ReactNode;
  /** `boxed`: bordered key cap (title bar, palette). `bare`: plain hint (sidebar). */
  variant?: 'boxed' | 'bare';
  /** Text color: ink-3 (title bar), ink-4 (palette Esc: 4.5:1 on bg-3) or ink-5 (sidebar hints, aria-hidden). */
  tone?: 'ink3' | 'ink4' | 'ink5';
  className?: string;
}

/** Keyboard hint in 10px IBM Plex Mono. */
export function Kbd({ children, variant = 'boxed', tone = 'ink3', className }: KbdProps) {
  return (
    <kbd
      className={cn(
        // Line-height `normal` matches the prototype's `font:` shorthand (17px boxed cap).
        'font-mono text-[10px] leading-[normal]',
        tone === 'ink3' ? 'text-ink-3' : tone === 'ink4' ? 'text-ink-4' : 'text-ink-5',
        variant === 'boxed' && 'rounded-tag border border-line-3 px-[5px] py-px',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
