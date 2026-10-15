import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useLeaving } from '@/lib/motion';
import { useConfirm, type ConfirmRequest } from '@/store/confirm';

/**
 * "Uninstall “Name”?" before a destructive action (`confirm()` in src/store/confirm.ts): Cancel
 * (focused, so a stray Enter after Delete doesn't remove anything) and the red action. Modal like
 * the conflict dialog: Escape or a click outside cancels, Tab cycles inside, keys don't reach the
 * screen underneath, focus goes back on close. It fades and scales in, and fades out once answered.
 */
export function ConfirmDialog() {
  // Kept a moment after it is answered, for the exit animation.
  const { value: request, leaving } = useLeaving(useConfirm((s) => s.request), 120);
  if (!request) return null;
  // Keyed by the request, so a second one starts fresh (focus, opener).
  return <ConfirmDialogBody key={`${request.title}|${request.body}`} request={request} leaving={leaving} />;
}

function ConfirmDialogBody({ request, leaving }: { request: ConfirmRequest; leaving: boolean }) {
  const { t } = useTranslation();
  const settle = useConfirm((s) => s.settle);
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Read during the first render, before Cancel takes focus.
  const [opener] = useState(() => document.activeElement);

  // Focus goes back as soon as the question is answered, not after the exit animation.
  const restored = useRef(false);
  const restore = useCallback(() => {
    if (restored.current) return;
    restored.current = true;
    if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
  }, [opener]);
  useEffect(() => {
    cancelRef.current?.focus();
    return restore;
  }, [restore]);
  useEffect(() => {
    if (leaving) restore();
  }, [leaving, restore]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (leaving) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      settle(false);
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
    }
    // Keys stay in the modal (section shortcuts, Delete on the card underneath); Ctrl/Cmd combos still reach the window.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  };

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) settle(false);
  };

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-overlay',
        leaving ? 'pointer-events-none motion-safe:animate-overlay-out' : 'motion-safe:animate-overlay-in',
      )}
      onMouseDown={onOverlayMouseDown}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        aria-hidden={leaving || undefined}
        className={cn(
          'flex w-[440px] max-w-[calc(100vw-32px)] flex-col gap-4 rounded-dialog border border-line-4 bg-bg-3 px-6 py-5.5 shadow-dialog outline-none',
          leaving ? 'motion-safe:animate-dialog-out' : 'motion-safe:animate-dialog-in',
        )}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="h-2 w-2 flex-none rounded-full bg-danger" />
            <h2 id={titleId} className="min-w-0 break-words text-heading-lg text-ink-1">
              {request.title}
            </h2>
          </div>
          <p id={bodyId} className="text-body text-ink-3">
            {request.body}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" size={32} onClick={() => settle(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size={32} onClick={() => settle(true)}>
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
