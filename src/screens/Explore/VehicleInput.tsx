import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput } from '@/components/ui/TextInput';
import { vehicles as localVehicles } from '@/data/vehicles';
import { cn } from '@/lib/cn';
import { useExplore } from '@/store/explore';
import type { Vehicle } from '@/types';
import { findVehicle, matchVehicles, vehicleLabel } from './exploreModel';

/** The vehicle a typed text stands for: an exact name or code (case-insensitive). */
function exactVehicle(list: readonly Vehicle[], text: string): Vehicle | undefined {
  const needle = text.trim().toLowerCase();
  return findVehicle(list, needle) ?? list.find((v) => v.name.toLowerCase() === needle);
}

/**
 * 200×28 vehicle filter with an autocomplete menu (WAI-ARIA combobox with a listbox popup): name +
 * mono code, matching either, from the local vehicle list. Picking a suggestion sets the vehicle
 * code filter. Enter on text that names no suggestion searches it as a code (vehicles missing from
 * the local list). Escape closes only the menu (a second Escape clears the field and the filter);
 * leaving the field restores the filter's name, and leaving it empty clears the filter.
 */
export function VehicleInput({ list = localVehicles }: { list?: readonly Vehicle[] }) {
  const { t } = useTranslation();
  const vehicle = useExplore((s) => s.vehicle);
  const setVehicle = useExplore((s) => s.setVehicle);
  const display = vehicle ? vehicleLabel(list, vehicle) : '';

  const [text, setText] = useState(display);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // The filter changed elsewhere (a removed filter, Clear all, the palette, Following).
  useEffect(() => {
    setText(display);
    setOpen(false);
  }, [display]);

  const matches = useMemo(() => matchVehicles(list, text), [list, text]);
  const expanded = open && matches.length > 0;
  const current = Math.min(active, Math.max(0, matches.length - 1));

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const pick = (v: Vehicle) => {
    setVehicle(v.code);
    setText(v.name);
    setOpen(false);
  };

  const commitText = () => {
    const typed = text.trim();
    if (!typed) {
      setVehicle(null);
      return;
    }
    const exact = exactVehicle(list, typed);
    if (exact) pick(exact);
    else {
      setVehicle(typed);
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
        else commitText();
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
      if (vehicle) setVehicle(null);
    } else if (text !== display) setText(display);
  };

  return (
    <div className="relative">
      <TextInput
        type="text"
        clearable
        role="combobox"
        aria-label={t('explore.filters.vehicle')}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listboxId : undefined}
        aria-activedescendant={expanded ? optionId(current) : undefined}
        placeholder={t('explore.filters.vehiclePlaceholder')}
        value={text}
        onValueChange={(value) => {
          setText(value);
          setOpen(value.trim() !== '');
          setActive(0);
        }}
        onClear={() => setVehicle(null)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="w-[200px]"
      />
      {expanded && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('explore.filters.vehicleSuggestions')}
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
              <span className="min-w-0 truncate">{v.name}</span>
              {/* ink-4, not the prototype's ink-5: 10px text needs 4.5:1; ink-3 on the highlighted bg-4 (ink-4 is 4.25 there). */}
              <span className={cn('flex-none font-mono text-[10px]', i === current ? 'text-ink-3' : 'text-ink-4')}>{v.code}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
