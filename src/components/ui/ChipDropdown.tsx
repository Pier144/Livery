import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { Menu, type MenuItem } from './Menu';

export interface ChipOption<V extends string = string> {
  value: V;
  label: string;
}

export interface ChipDropdownProps<V extends string> {
  /** Filter name: "Nation", "Class", "Origin"… Also the menu's accessible name. */
  label: string;
  /** Selected option, or `null` for "Any" / "All". */
  value: V | null;
  options: readonly ChipOption<V>[];
  onChange: (value: V | null) => void;
  /**
   * `labelValue` (Explore): label + value ("Any" in ink-3, the choice in amber).
   * `label` (My Hangar): the label alone in ink-3, replaced by the choice in amber when set.
   */
  variant?: 'labelValue' | 'label';
  /** Text of the clearing option (and the unset value in `labelValue`). Defaults to `common.any`. */
  anyLabel?: string;
  align?: 'start' | 'end';
  /** Controlled open state, to keep one menu open at a time. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  menuWidthClass?: string;
  className?: string;
}

/** Menu value of the clearing option; cannot collide with a real option value. */
const ANY = '\u0000any';

/** 28px filter chip that opens a radio menu (Explore filters, My Hangar toolbar). */
export function ChipDropdown<V extends string>({
  label,
  value,
  options,
  onChange,
  variant = 'labelValue',
  anyLabel,
  align,
  open,
  onOpenChange,
  menuWidthClass,
  className,
}: ChipDropdownProps<V>) {
  const { t } = useTranslation();
  const anyText = anyLabel ?? t('common.any');
  const selected = value === null ? undefined : options.find((o) => o.value === value);

  const items: MenuItem[] = [{ value: ANY, label: anyText }, ...options.map((o) => ({ value: o.value, label: o.label }))];
  const byValue = new Map<string, V>(options.map((o) => [o.value, o.value]));

  return (
    <Menu
      kind="radio"
      items={items}
      value={selected ? selected.value : ANY}
      label={label}
      align={align}
      open={open}
      onOpenChange={onOpenChange}
      menuWidthClass={menuWidthClass}
      onSelect={(v) => onChange(byValue.get(v) ?? null)}
      renderTrigger={(props) => (
        <button
          {...props}
          className={cn(
            'flex h-ctl items-center gap-2 whitespace-nowrap rounded-ctl border bg-bg-chip px-2.5 text-meta leading-[normal] text-ink-1 motion-safe:transition-colors motion-safe:duration-120',
            selected ? 'border-amber-60' : 'border-line-3 hover:border-line-4',
            className,
          )}
        >
          {variant === 'labelValue' ? (
            <>
              <span>{label}</span>{' '}
              <span className={selected ? 'text-amber' : 'text-ink-3'}>{selected ? selected.label : anyText}</span>
            </>
          ) : selected ? (
            <>
              {/* The chip shows only the choice; screen readers still hear which filter it is. */}
              <span className="sr-only">{`${label}:`}</span>{' '}
              <span className="text-amber">{selected.label}</span>
            </>
          ) : (
            <span className="text-ink-3">{label}</span>
          )}
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="flex-none text-ink-5" />
        </button>
      )}
    />
  );
}
