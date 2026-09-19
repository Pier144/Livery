import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import type { QueueItem } from '@/types';
import type { ConflictTarget } from './queueModel';

export type ConflictChoice = 'replace' | 'copy' | 'skip';

interface ConflictDialogProps {
  item: QueueItem;
  installed: ConflictTarget;
  onChoose: (choice: ConflictChoice) => void;
  onCancel: () => void;
  /** Where focus goes on close when the element that opened the dialog is gone (e.g. the row now installs). */
  fallbackFocus: () => HTMLElement | null;
}

/**
 * "This skin is already installed" (README §6): Replace (default, Enter) / Install as a copy / Skip, Cancel.
 * Modal: focus starts on Replace, Tab cycles inside, Escape cancels only this layer, and focus goes back
 * to the opener on close.
 */
export function ConflictDialog({ item, installed, onChoose, onCancel, fallbackFocus }: ConflictDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);

  // Read during the first render, before Replace takes focus.
  const [opener] = useState(() => document.activeElement);
  const fallbackRef = useRef(fallbackFocus);
  fallbackRef.current = fallbackFocus;
  useEffect(() => {
    replaceRef.current?.focus();
    return () => {
      // Passive cleanup: the DOM is final, so a Resolve button replaced by a progress bar reads as gone.
      // A row that took focus while its install was refused isn't the right target either: its Resolve is.
      const usable =
        opener instanceof HTMLElement && opener !== document.body && opener.isConnected && opener.dataset.queueRow === undefined;
      if (usable) opener.focus();
      else fallbackRef.current()?.focus();
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && dialogRef.current?.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first?.focus();
      }
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      // Enter anywhere but on another option replaces (the default action).
      e.preventDefault();
      onChoose('replace');
    }
    // Keys stay in the modal: section shortcuts (1–5, [ ]) must not change the screen underneath.
    // Ctrl/Cmd combos (palette, undo) still reach the window.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  };

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  const values = { file: item.fileName, installed: installed.name, vehicle: installed.vehicle };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay" onMouseDown={onOverlayMouseDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex w-[520px] max-w-[calc(100vw-32px)] flex-col gap-4 rounded-dialog border border-line-4 bg-bg-3 px-6 py-5.5 shadow-dialog outline-none"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="h-2 w-2 flex-none rounded-full bg-amber" />
            <h2 id={titleId} className="text-heading-lg text-ink-1">
              {t('queue.conflict.title')}
            </h2>
          </div>
          <p id={bodyId} className="text-body text-ink-3">
            <Trans
              t={t}
              i18nKey={installed.vehicle ? 'queue.conflict.body' : 'queue.conflict.bodyNoVehicle'}
              values={values}
              components={{ file: <span data-selectable className="break-all font-mono text-mono-data text-ink-2" /> }}
            />
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Option
            ref={replaceRef}
            title={t('queue.conflict.replace')}
            help={t('queue.conflict.replaceHelp')}
            primary
            onClick={() => onChoose('replace')}
          />
          <Option title={t('queue.conflict.copy')} help={t('queue.conflict.copyHelp')} onClick={() => onChoose('copy')} />
          <Option title={t('queue.conflict.skip')} help={t('queue.conflict.skipHelp')} onClick={() => onChoose('skip')} />
        </div>
        <div className="flex items-center justify-between gap-3">
          {/* ink-4, not the prototype's ink-5: 11px text needs 4.5:1. */}
          <span className="text-[11px] leading-[normal] text-ink-4">{t('queue.conflict.footer')}</span>
          <Button variant="ghost" size={28} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface OptionProps {
  title: string;
  help: string;
  /** Replace: amber tint, ↵ hint. */
  primary?: boolean;
  onClick: () => void;
}

/** Full-width option: 13px title, 11px helper. */
const Option = forwardRef<HTMLButtonElement, OptionProps>(function Option({ title, help, primary, onClick }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-keyshortcuts={primary ? 'Enter' : undefined}
      className={cn(
        'flex items-center justify-between gap-3 rounded-card border px-3.5 py-3 text-left text-ink-1 motion-safe:transition-colors motion-safe:duration-120',
        primary ? 'border-amber-60 bg-amber-10 hover:bg-amber-18' : 'border-line-3 bg-bg-4 hover:border-line-mark',
      )}
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-body font-medium leading-[normal]">{title}</span>
        <span className="text-[11px] leading-[normal] text-ink-3">{help}</span>
      </span>
      {primary && (
        <span aria-hidden className="font-mono text-[10px] leading-[normal] text-ink-4">
          ↵
        </span>
      )}
    </button>
  );
});
