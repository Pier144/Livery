import { useId, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import type { WtLiveSkin } from '@/types';

interface CompareProps {
  /** The skin of the page (pane A). */
  a: WtLiveSkin;
  /** Pane B. */
  b: WtLiveSkin;
  /** Other skins of the same vehicle (the "compare with" buttons). */
  candidates: readonly WtLiveSkin[];
  onPick: (id: string) => void;
  onExit: () => void;
  /** Receives the pressed "compare with" button (focus lands there on entering compare). */
  activeRef: RefObject<HTMLButtonElement>;
}

/**
 * Compare mode: A (amber-60 border) and B side by side, then "COMPARE WITH · same vehicle" with a
 * toggle button per other skin (the one in pane B amber) and "Exit compare". Escape also exits.
 */
export function Compare({ a, b, candidates, onPick, onExit, activeRef }: CompareProps) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <>
      <div className="grid min-h-[200px] flex-1 grid-cols-2 gap-3">
        <ComparePane skin={a} caption={t('detail.gallery.compareA', { name: a.name })} highlight />
        <ComparePane skin={b} caption={t('detail.gallery.compareB', { name: b.name, author: b.author.name })} />
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <span id={labelId} className="font-mono text-mono-label text-ink-4">
          {t('detail.gallery.compareWith')}
        </span>
        <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2.5">
          {candidates.map((c) => {
            const active = c.id === b.id;
            return (
              <button
                key={c.id}
                ref={active ? activeRef : undefined}
                type="button"
                aria-pressed={active}
                onClick={() => onPick(c.id)}
                className={cn(
                  'h-[26px] max-w-[240px] truncate rounded-ctl border border-line-3 bg-bg-4 px-2.5 text-meta leading-none hover:border-line-4 motion-safe:transition-colors motion-safe:duration-120',
                  active ? 'text-amber' : 'text-ink-3',
                )}
              >
                {c.name}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onExit}
          className="ml-auto h-[26px] px-2.5 text-meta text-ink-3 underline underline-offset-[3px] hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
        >
          {t('detail.gallery.exitCompare')}
        </button>
      </div>
    </>
  );
}

function ComparePane({ skin, caption, highlight = false }: { skin: WtLiveSkin; caption: string; highlight?: boolean }) {
  const { t } = useTranslation();
  const src = skin.images[0];
  return (
    <figure
      className={cn(
        'relative m-0 flex min-w-0 items-center justify-center overflow-hidden rounded-card border',
        highlight ? 'border-amber-60 bg-placeholder-stage' : 'border-line-2 bg-placeholder-stage-alt',
      )}
    >
      {src ? (
        <img src={src} alt="" draggable={false} className="h-full w-full object-contain" />
      ) : (
        <span aria-hidden className="truncate px-4 font-mono text-mono-data text-ink-4">
          {t('detail.gallery.comparePlaceholder', { name: skin.name })}
        </span>
      )}
      <figcaption className="absolute left-2.5 top-2.5 max-w-[calc(100%-20px)] truncate rounded-menu bg-bg-0/85 px-1.5 py-0.5 font-mono text-[10px] leading-[normal] text-ink-2">
        {caption}
      </figcaption>
    </figure>
  );
}
