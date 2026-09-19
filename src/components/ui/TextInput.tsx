import { X, type LucideIcon } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, type InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'size' | 'className'> {
  value: string;
  onValueChange: (value: string) => void;
  /** `search` (default) has searchbox semantics; `text` for plain fields such as names. */
  type?: 'search' | 'text';
  /** Leading 14px icon in ink-5, e.g. `Search`. */
  icon?: LucideIcon;
  /** Clear button (and Escape-to-clear) while the value is non-empty. Defaults to true for `search`. */
  clearable?: boolean;
  /** Called after the clear button or Escape emptied the field. */
  onClear?: () => void;
  /** Wrapper classes: set the width here (`w-[260px]`). */
  className?: string;
  inputClassName?: string;
}

/**
 * 28px text field (Explore vehicle, Hangar search). The native search "×" is hidden in favour of a
 * Lucide `X` button; Escape in a non-empty field clears it and stops there (it closes nothing else).
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { value, onValueChange, type = 'search', icon: Icon, clearable, onClear, className, inputClassName, onKeyDown, ...rest },
  ref,
) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);

  const canClear = clearable ?? type === 'search';
  const showClear = canClear && value !== '' && !rest.disabled && !rest.readOnly;

  const clear = () => {
    onValueChange('');
    onClear?.();
  };

  return (
    <div className={cn('relative inline-flex items-center', className)}>
      {Icon && <Icon size={14} strokeWidth={1.75} aria-hidden className="pointer-events-none absolute left-2.5 text-ink-5" />}
      <input
        ref={inputRef}
        type={type}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing || value === '') return;
          // Chromium empties search fields on Escape by itself; keep that behind `clearable`.
          e.preventDefault();
          if (!showClear) return;
          e.stopPropagation();
          clear();
        }}
        className={cn(
          'h-ctl w-full min-w-0 rounded-ctl border border-line-3 bg-bg-input text-meta leading-[normal] text-ink-1 placeholder:text-ink-4 disabled:opacity-50',
          '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none',
          Icon ? 'pl-[30px]' : 'pl-2.5',
          showClear ? 'pr-7' : 'pr-2.5',
          inputClassName,
        )}
        {...rest}
      />
      {showClear && (
        <button
          type="button"
          aria-label={t('common.clear')}
          title={t('common.clear')}
          onClick={() => {
            clear();
            inputRef.current?.focus();
          }}
          className="absolute right-0.5 flex h-6 w-6 items-center justify-center rounded-menu text-ink-4 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </div>
  );
});
