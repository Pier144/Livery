import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

interface Action {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  title: string;
  body: ReactNode;
  primary?: Action;
  secondary?: Action;
  /** Grey status dot above the title (offline state). */
  dot?: boolean;
  className?: string;
}

/** Centered empty/offline/no-results message: 18px title, 13px body, up to two 32px buttons. */
export function EmptyState({ title, body, primary, secondary, dot, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-1 items-center justify-center', className)}>
      <div className="flex max-w-[380px] flex-col items-center gap-3 text-center">
        {dot && <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-ink-5" />}
        <h2 className="text-heading-lg">{title}</h2>
        <p className="text-body text-ink-3">{body}</p>
        {(primary || secondary) && (
          <div className="mt-1 flex gap-2.5">
            {primary && (
              <Button variant="primary" size={32} onClick={primary.onClick}>
                {primary.label}
              </Button>
            )}
            {secondary && (
              <Button variant="secondary" size={32} onClick={secondary.onClick}>
                {secondary.label}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
