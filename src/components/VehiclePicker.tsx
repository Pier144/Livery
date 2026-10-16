import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { TextInput } from '@/components/ui/TextInput';
import { cn } from '@/lib/cn';
import { localNameLower, localVehicleName, type VehicleNames } from '@/lib/vehicleNames';
import { useVehicleNames } from '@/queries/vehicles';
import { findVehicle, matchVehicles, vehicleLabel } from '@/screens/Explore/exploreModel';
import type { Vehicle, VehicleType } from '@/types';

export interface VehiclePickerProps {
  /** The chosen vehicle code (with free text, any code the user typed), or null. */
  value: string | null;
  onChange: (code: string | null) => void;
  list: readonly Vehicle[];
  /** Only these vehicle types are suggested (and accepted). */
  types?: readonly VehicleType[];
  /** Enter on text that names no listed vehicle keeps it as a code (Explore's filter). */
  allowFreeText?: boolean;
  /** The input's id, for a `<label htmlFor>`. */
  id?: string;
  'aria-labelledby'?: string;
  /** Accessible name when there is no `aria-labelledby`. */
  label?: string;
  placeholder?: string;
  /** Accessible name of the suggestions list (defaults to the field's). */
  suggestionsLabel?: string;
  /** Classes of the field (its width). */
  className?: string;
}

/** The vehicle a typed text stands for: an exact code, English name or local name (case-insensitive). */
function exactVehicle(list: readonly Vehicle[], text: string, names: VehicleNames): Vehicle | undefined {
  const needle = text.trim().toLowerCase();
  return (
    findVehicle(list, needle) ??
    list.find((v) => v.name.toLowerCase() === needle || localNameLower(names, v) === needle)
  );
}

/**
 * Controlled vehicle field with an autocomplete menu (WAI-ARIA combobox with a listbox popup):
 * name in the UI language + mono code, matching the code, the English name or the local one.
 * Picking a suggestion chooses its code. With `allowFreeText`, Enter on text that names no
 * suggestion keeps the text as a code (vehicles missing from the list); without it, Enter accepts
 * only a highlighted suggestion. Escape closes only the menu (a second Escape clears the field and
 * the value); leaving the field puts back the chosen vehicle's name, and leaving it empty clears
 * the value.
 */
export function VehiclePicker({
  value,
  onChange,
  list,
  types,
  allowFreeText = false,
  id,
  'aria-labelledby': labelledBy,
  label,
  placeholder,
  suggestionsLabel,
  className,
}: VehiclePickerProps) {
  const names = useVehicleNames();
  const offered = useMemo(() => (types ? list.filter((v) => types.includes(v.type)) : list), [list, types]);
  const display = value ? vehicleLabel(list, value, names) : '';

  const [text, setText] = useState(display);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // The value changed elsewhere: show it. Only the shown name changed (the local names arrived,
  // the language changed): update the text unless the user is typing in the field.
  const inputRef = useRef<HTMLInputElement>(null);
  const shownFor = useRef(value);
  useEffect(() => {
    const valueChanged = shownFor.current !== value;
    shownFor.current = value;
    if (!valueChanged && document.activeElement === inputRef.current) return;
    setText(display);
    setOpen(false);
  }, [display, value]);

  const matches = useMemo(() => matchVehicles(offered, text, undefined, names), [offered, text, names]);
  const expanded = open && matches.length > 0;
  const current = Math.min(active, Math.max(0, matches.length - 1));

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const pick = (v: Vehicle) => {
    onChange(v.code);
    setText(localVehicleName(names, v));
    setOpen(false);
  };

  /** Enter with no highlighted suggestion (free text only). */
  const commitText = () => {
    const typed = text.trim();
    if (!typed) {
      onChange(null);
      return;
    }
    const exact = exactVehicle(offered, typed, names);
    if (exact) pick(exact);
    else {
      onChange(typed);
      setOpen(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = matches.length;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (n === 0) return;
        e.preventDefault();
        const down = e.key === 'ArrowDown';
        if (!expanded) {
          setOpen(true);
          setActive(down ? 0 : n - 1);
        } else setActive(down ? (current + 1) % n : (current - 1 + n) % n);
        return;
      }
      case 'Enter': {
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        const chosen = expanded ? matches[current] : undefined;
        if (chosen) pick(chosen);
        else if (allowFreeText) commitText();
        return;
      }
      case 'Escape':
        // Closes only the menu; with the menu closed TextInput clears the field (onClear).
        if (!expanded) return;
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      case 'Tab':
        setOpen(false);
        return;
    }
  };

  const onBlur = () => {
    setOpen(false);
    if (text.trim() === '') {
      if (value) onChange(null);
    } else if (text !== display) setText(display);
  };

  return (
    <div className="relative">
      <TextInput
        ref={inputRef}
        id={id}
        type="text"
        clearable
        role="combobox"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listboxId : undefined}
        aria-activedescendant={expanded ? optionId(current) : undefined}
        placeholder={placeholder}
        value={text}
        onValueChange={(next) => {
          setText(next);
          setOpen(next.trim() !== '');
          setActive(0);
        }}
        onClear={() => onChange(null)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className={className}
      />
      {expanded && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={suggestionsLabel ?? (labelledBy ? undefined : label)}
          aria-labelledby={suggestionsLabel || !labelledBy ? undefined : labelledBy}
          className="absolute left-0 top-[32px] z-20 flex min-w-[260px] flex-col rounded-ctl border border-line-3 bg-bg-3 p-1 shadow-menu"
        >
          {matches.map((v, i) => (
            <div
              key={v.code}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              // Keep focus (and the caret) in the input.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(v)}
              onMouseMove={() => {
                if (i !== current) setActive(i);
              }}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 whitespace-nowrap rounded-menu px-2.5 py-[7px] text-meta leading-[normal] text-ink-1',
                i === current && 'bg-bg-4',
              )}
            >
              <span className="min-w-0 truncate">{localVehicleName(names, v)}</span>
              {/* ink-4, not the prototype's ink-5: 10px text needs 4.5:1; ink-3 on the highlighted bg-4 (ink-4 is 4.25 there). */}
              <span className={cn('flex-none font-mono text-[10px]', i === current ? 'text-ink-3' : 'text-ink-4')}>{v.code}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
