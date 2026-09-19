import { useId, useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface RadioCardOption<V extends string> {
  value: V;
  label: string;
  /** Small mono note on the right (e.g. "English for now"); read as the option's description. */
  hint?: string;
  /** Language of the label when it differs from the UI (language names). */
  lang?: string;
}

interface RadioCardsProps<V extends string> {
  /** Id of the visible heading that names the group. */
  labelledBy: string;
  describedBy?: string;
  value: V;
  options: readonly RadioCardOption<V>[];
  onChange: (value: V) => void;
}

/**
 * Full-width radio cards (Settings → Conflicts, Language) as a WAI-ARIA radio group: one tab stop
 * (the checked card); arrow keys move and select with wrap-around, Home/End jump to the ends.
 * Card: bg-3, line-3 border (amber when selected, line-mark on hover), ring with an 8px amber dot.
 */
export function RadioCards<V extends string>({ labelledBy, describedBy, value, options, onChange }: RadioCardsProps<V>) {
  const baseId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  refs.current.length = options.length;
  const checkedIndex = options.findIndex((o) => o.value === value);
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0;

  const select = (i: number) => {
    const option = options[i];
    if (!option) return;
    refs.current[i]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length;
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (i + 1) % n;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (i - 1 + n) % n;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    select(next);
  };

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex flex-col gap-2">
      {options.map((option, i) => {
        const checked = i === checkedIndex;
        const labelId = `${baseId}-${option.value}`;
        const hintId = `${baseId}-${option.value}-hint`;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-labelledby={labelId}
            aria-describedby={option.hint ? hintId : undefined}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => select(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'flex items-center gap-3 rounded-card border bg-bg-3 px-3.5 py-3 text-left text-body leading-[normal] text-ink-1 motion-safe:transition-colors motion-safe:duration-120',
              checked ? 'border-amber' : 'border-line-3 hover:border-line-mark',
            )}
          >
            {/* 14px ring inside a 1px border (16px, as the prototype renders it); ink-5 reaches 3:1 on the card (WCAG 1.4.11). */}
            <span aria-hidden className="flex h-4 w-4 flex-none items-center justify-center rounded-full border border-ink-5">
              <span className={cn('h-2 w-2 rounded-full', checked && 'bg-amber')} />
            </span>
            <span id={labelId} lang={option.lang}>
              {option.label}
            </span>
            {option.hint && (
              <span id={hintId} className="ml-auto font-mono text-mono-sm leading-[normal] text-ink-4">
                {option.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
