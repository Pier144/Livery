import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/cn';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';

interface AtelierDialogProps {
  title: string;
  /** Escape, the × and a click outside; ignored while `locked`. */
  onDismiss: () => void;
  /** Work is running: the dialog can't be dismissed (its own Cancel stops the work). */
  locked?: boolean;
  /** Label of the × button. */
  closeLabel: string;
  /** Element to focus first (else the dialog itself). */
  initialFocus?: RefObject<HTMLElement>;
  describedBy?: string;
  busy?: boolean;
  widthClass?: string;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The editor's modal frame (Remove background, Refine edge), like Licenses and New project: focus
 * starts inside, Tab cycles inside, Escape or a click outside dismisses (not while locked), keys
 * don't reach the editor underneath (Ctrl combos still reach the window), focus goes back to the opener.
 */
export function AtelierDialog({ title, onDismiss, locked = false, closeLabel, initialFocus, describedBy, busy, widthClass = 'w-[480px]', footer, children }: AtelierDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => document.activeElement);
  useEffect(() => {
    (initialFocus?.current ?? dialogRef.current)?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
    };
    // Focus once, when the dialog opens.
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!locked) onDismiss();
      return;
    }
    if (e.key === 'Tab') {
      const dialog = dialogRef.current;
      const focusables = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => !el.closest('[hidden]'));
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && !!dialog?.contains(active) && active !== dialog;
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first?.focus();
      }
    }
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  };

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !locked) onDismiss();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 motion-safe:animate-overlay-in" onMouseDown={onOverlayMouseDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'flex max-h-[calc(100vh-80px)] max-w-full flex-col overflow-hidden rounded-dialog border border-line-4 bg-bg-3 shadow-dialog outline-none motion-safe:animate-dialog-in',
          widthClass,
        )}
      >
        <div className="flex flex-none items-center justify-between gap-3 border-b border-line-2 py-3.5 pl-6 pr-4">
          <h2 id={titleId} className="text-heading-lg text-ink-1">
            {title}
          </h2>
          <button
            type="button"
            onClick={onDismiss}
            disabled={locked}
            aria-label={closeLabel}
            title={closeLabel}
            className="grid h-7 w-7 flex-none place-items-center rounded-ctl text-ink-3 hover:bg-bg-hover hover:text-ink-1 disabled:opacity-50 motion-safe:transition-colors motion-safe:duration-120"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-none items-center justify-end gap-2 border-t border-line-2 px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

/** A labelled progress bar (`value` 0..1; null shows an empty track). */
export function ProgressBar({ label, value, valueText }: { label: string; value: number | null; valueText?: string }) {
  const pct = value === null ? 0 : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={valueText}
      className="h-[4px] w-full overflow-hidden rounded-sm bg-bg-5"
    >
      <div className="h-full bg-amber motion-safe:transition-[width] motion-safe:duration-250 motion-safe:ease-decel" style={{ width: `${pct}%` }} />
    </div>
  );
}
