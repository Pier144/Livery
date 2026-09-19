import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type FocusEvent, type MouseEvent, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useToasts, type Toast } from '@/store/toasts';

/**
 * Bottom-right toast stack (README “Toasts”). Always mounted so the polite live region
 * exists before the first toast; stable keys keep remaining toasts from being re-announced.
 */
export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToasts((s) => s.toasts);
  // Where keyboard focus was before it entered the stack, to hand it back when the last toast closes.
  const returnFocus = useRef<HTMLElement | null>(null);

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const from = e.relatedTarget;
    if (from instanceof Node && e.currentTarget.contains(from)) return;
    returnFocus.current = from instanceof HTMLElement ? from : null;
  };

  return (
    <section
      aria-label={t('common.toasts.region')}
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      onFocus={onFocus}
      className="pointer-events-none fixed bottom-5 right-5 z-[70] flex flex-col items-end gap-2"
    >
      {toasts.map((item) => (
        <ToastItem key={item.id} toast={item} returnFocus={returnFocus} />
      ))}
    </section>
  );
}

interface ToastItemProps {
  toast: Toast;
  returnFocus: MutableRefObject<HTMLElement | null>;
}

function ToastItem({ toast: item, returnFocus }: ToastItemProps) {
  const { t } = useTranslation();
  const messageId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);

  // WCAG 2.2.1: the 6 s countdown stops while the pointer is over the toast or focus is inside it.
  const syncTimer = () => {
    const { pause, resume } = useToasts.getState();
    if (hovered.current || focused.current) pause(item.id);
    else resume(item.id);
  };

  // Removed while focus is inside without a keyboard hand-off (dropped on overflow, dismissed by code):
  // return focus to where it came from instead of letting it fall to <body>. Runs before the node detaches.
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      const back = returnFocus.current;
      if (el?.contains(document.activeElement) && back?.isConnected) back.focus();
    };
  }, [returnFocus]);

  // Keyboard activation (click.detail === 0) would otherwise drop focus to <body> when this toast unmounts.
  const handOffFocus = (e: MouseEvent) => {
    const el = ref.current;
    if (!el || e.detail !== 0 || !el.contains(document.activeElement)) return;
    const sibling = el.nextElementSibling ?? el.previousElementSibling;
    const target = sibling?.querySelector<HTMLElement>('[data-toast-dismiss]') ?? returnFocus.current;
    if (target?.isConnected) target.focus();
  };

  return (
    <div
      ref={ref}
      onPointerEnter={() => {
        hovered.current = true;
        syncTimer();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        syncTimer();
      }}
      onFocus={() => {
        focused.current = true;
        syncTimer();
      }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        focused.current = false;
        syncTimer();
      }}
      className="pointer-events-auto flex max-w-[420px] items-center gap-3.5 rounded-card border border-line-4 bg-bg-hover py-2.5 pl-3.5 pr-3 text-body text-ink-1 shadow-menu motion-safe:animate-toastIn"
    >
      <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-amber" />
      <span id={messageId} className="min-w-0 flex-1 break-words">
        {item.message}
      </span>
      {item.onUndo && (
        <button
          type="button"
          aria-describedby={messageId}
          onClick={(e) => {
            handOffFocus(e);
            void useToasts.getState().undo(item.id);
          }}
          className="inline-flex h-[26px] flex-none items-center justify-center whitespace-nowrap rounded-[5px] border border-line-4 bg-bg-5 px-2.5 text-meta font-medium text-ink-1 hover:border-amber motion-safe:transition-colors motion-safe:duration-120"
        >
          {t('common.undo')}
        </button>
      )}
      <button
        type="button"
        data-toast-dismiss
        aria-label={t('common.dismiss')}
        aria-describedby={messageId}
        onClick={(e) => {
          handOffFocus(e);
          useToasts.getState().dismiss(item.id);
        }}
        className="inline-flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[5px] text-ink-4 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
      >
        <X aria-hidden size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}
