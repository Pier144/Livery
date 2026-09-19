import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface KbdProps {
  children: ReactNode;
  /** `boxed`: bordered key cap (title bar, palette). `bare`: plain hint (sidebar). */
  variant?: 'boxed' | 'bare';
  /** Text color: ink-3 (title bar) or ink-5 (palette Esc, sidebar hints). */
  tone?: 'ink3' | 'ink5';
  className?: string;
}

/** Keyboard hint in 10px IBM Plex Mono. */
export function Kbd({ children, variant = 'boxed', tone = 'ink3', className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'font-mono text-[10px] leading-[1.4]',
        tone === 'ink3' ? 'text-ink-3' : 'text-ink-5',
        variant === 'boxed' && 'rounded-tag border border-line-3 px-[5px] py-px',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
