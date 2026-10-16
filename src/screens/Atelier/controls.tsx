import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Controls of the Properties panel (Base, Protected areas, image and text layers). */

/**
 * A colour well (`<input type="color">`). Every change while the picker is open merges into one
 * undo step; closing the picker (`change`) or leaving the field ends it.
 */
export function ColorSwatch({ value, label, onInput, onCommit }: { value: string; label: string; onInput: (hex: string) => void; onCommit: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const onChange = () => commit.current();
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }, []);
  return (
    <input
      ref={ref}
      type="color"
      value={value}
      aria-label={label}
      title={value}
      onChange={(e) => onInput(e.target.value)}
      onBlur={onCommit}
      className="block h-8 w-8 cursor-pointer appearance-none rounded-ctl border border-line-3 bg-transparent p-0.5 hover:border-line-4 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-menu [&::-webkit-color-swatch]:border-0"
    />
  );
}

// ── Controls ────────────────────────────────────────────────────────────────

/** A labelled block; `children` gets the label's id (for `aria-describedby`). */
export function Field({ label, children }: { label: string; children: (labelId: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="text-meta text-ink-3">
        {label}
      </span>
      {children(id)}
    </div>
  );
}

/** A range slider with its value; `onCommit` runs when a drag or key press ends. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  hint,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  /** A line under the slider (described by it). */
  hint?: string;
  onChange: (v: number) => void;
  onCommit?: () => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-meta text-ink-3">
          {label}
        </label>
        <span className="font-mono text-mono-sm text-ink-2">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={format(value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        className="h-4 w-full cursor-pointer accent-amber"
      />
      {hint && (
        <p id={`${id}-hint`} className="text-meta text-ink-4">
          {hint}
        </p>
      )}
    </div>
  );
}
