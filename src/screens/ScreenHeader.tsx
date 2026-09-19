import type { ReactNode } from 'react';

interface ScreenHeaderProps {
  title: string;
  /** Mono meta next to the title, e.g. "214 skins · 180 active · 3.8 GB on disk". */
  meta?: ReactNode;
  right?: ReactNode;
}

/** Title row shared by Hangar / Queue: 14px title + 11px mono meta, bottom rule. */
export function ScreenHeader({ title, meta, right }: ScreenHeaderProps) {
  return (
    <div className="flex items-end justify-between border-b border-line-2 pb-2.5">
      <div className="flex items-baseline gap-4">
        <h1 className="text-card">{title}</h1>
        {meta && <span className="font-mono text-mono-sm text-ink-4">{meta}</span>}
      </div>
      {right}
    </div>
  );
}

/** Standard screen frame: padding 18px top / 24px sides, 14px gap. */
export function ScreenFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex h-full min-h-0 flex-col gap-3.5 px-6 pt-4.5">
      {children}
    </section>
  );
}
