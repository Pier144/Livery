import type { LucideIcon } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface Segment<V extends string = string> {
  value: V;
  /** Visible text, or the accessible name (and tooltip) of an icon-only segment. */
  label: string;
  /** Icon-only 34px segment (e.g. `LayoutGrid` / `List`). */
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  /** Accessible name of the radio group ("Vehicle type", "View"). */
  label: string;
  value: V;
  options: readonly Segment<V>[];
  onChange: (value: V) => void;
  /** Id(s) of text describing the whole group (e.g. a setting's helper line). */
  'aria-describedby'?: string;
  className?: string;
}

/**
 * 28px segmented control as a WAI-ARIA radio group: one tab stop (the checked segment);
 * ←/→ (and ↑/↓) move and select with wrap-around, Home/End jump to the ends.
 */
export function SegmentedControl<V extends string>({
  label,
  value,
  options,
  onChange,
  'aria-describedby': describedBy,
  className,
}: SegmentedControlProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  refs.current.length = options.length;

  const checkedIndex = options.findIndex((o) => o.value === value);
  const firstEnabled = options.findIndex((o) => !o.disabled);
  const tabStop = checkedIndex >= 0 && !options[checkedIndex]?.disabled ? checkedIndex : firstEnabled;

  const select = (i: number) => {
    const option = options[i];
    if (!option || option.disabled) return;
    refs.current[i]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  /** Next enabled index from `from` in `step` direction, wrapping; `from` itself when none. */
  const step = (from: number, dir: 1 | -1) => {
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (!options[i]?.disabled) return i;
    }
    return from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = step(i, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = step(i, -1);
        break;
      case 'Home':
        next = step(-1, 1);
        break;
      case 'End':
        next = step(options.length, -1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    select(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      className={cn('flex h-ctl flex-none items-stretch overflow-hidden rounded-ctl border border-line-3 bg-bg-chip', className)}
    >
      {options.map((option, i) => {
        const checked = i === checkedIndex;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={Icon ? option.label : undefined}
            title={Icon ? option.label : undefined}
            disabled={option.disabled}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => select(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              // Inset focus ring: the group clips anything drawn outside a segment.
              'flex items-center justify-center text-meta font-medium leading-[normal] focus-visible:-outline-offset-2 disabled:opacity-50 motion-safe:transition-colors motion-safe:duration-120',
              i > 0 && 'border-l border-line-3',
              Icon ? 'w-[34px]' : 'px-2.5',
              checked ? 'bg-bg-5 text-ink-1' : 'bg-transparent text-ink-3 enabled:hover:text-ink-1',
            )}
          >
            {Icon ? <Icon size={14} strokeWidth={1.75} aria-hidden /> : option.label}
          </button>
        );
      })}
    </div>
  );
}
