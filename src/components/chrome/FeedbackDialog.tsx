import { X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { focusScreenHeading } from '@/hooks/useScreenFocus';
import { cn } from '@/lib/cn';
import { FEEDBACK_KINDS, MAX_TEXT, draftFeedback } from '@/lib/feedback';
import { useLeaving } from '@/lib/motion';
import { openLink } from '@/lib/opener';
import { useFeedbackDiagnostics } from '@/queries/feedback';
import { useAppVersion } from '@/screens/Settings/useAppVersion';
import { closeFeedback, useFeedback } from '@/store/feedback';
import { toast } from '@/store/toasts';
import type { FeedbackKind } from '@/types';

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/**
 * Send feedback (Settings → About, the palette): kind, message, "attach technical details", and a
 * preview of exactly what the GitHub page will hold. "Continue on GitHub" opens the pre-filled page
 * in the browser (`@/lib/feedback`); nothing is sent until the user submits it there. Modal like the
 * other dialogs: focus starts in the message, Tab cycles inside, Escape or a click outside closes,
 * focus goes back to the opener (or the screen heading when the opener is gone, e.g. the palette).
 */
export function FeedbackDialog() {
  const open = useFeedback((s) => s.open);
  const { value, leaving } = useLeaving(open ? true : null, 120);
  if (!value) return null;
  return <FeedbackDialogBody leaving={leaving} />;
}

function FeedbackDialogBody({ leaving }: { leaving: boolean }) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const introId = useId();
  const messageId = useId();
  const attachId = useId();
  const attachHelpId = useId();
  const previewId = useId();
  const statusId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [text, setText] = useState('');
  const [attach, setAttach] = useState(true);
  const diagnostics = useFeedbackDiagnostics(attach);
  const version = useAppVersion();
  const language = i18n.resolvedLanguage ?? i18n.language;

  // Without a backend (plain browser) the version is still known; Windows and the log aren't.
  const details = diagnostics.data ?? (diagnostics.isPending && diagnostics.fetchStatus === 'fetching' ? undefined : { appVersion: version, os: '–', logTail: [] });
  const loading = attach && !details;
  const draft = useMemo(
    () => draftFeedback({ kind, text, attach, diagnostics: details, language }),
    [kind, text, attach, details, language],
  );
  const empty = text.trim() === '';
  const canOpen = !empty && !draft.tooLong && !loading && !leaving;

  // Read during the first render, before the message takes focus.
  const [opener] = useState(() => document.activeElement);
  const restored = useRef(false);
  const restore = useCallback(() => {
    if (restored.current) return;
    restored.current = true;
    if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
    else focusScreenHeading();
  }, [opener]);
  useEffect(() => {
    messageRef.current?.focus();
    return restore;
  }, [restore]);
  useEffect(() => {
    if (leaving) restore();
  }, [leaving, restore]);

  const submit = async () => {
    if (!canOpen) return;
    const outcome = await openLink(draft.url, t);
    if (outcome === 'opened') toast(t('common.feedback.opened'));
    if (outcome === 'opened' || outcome === 'copied') closeFeedback();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (leaving) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFeedback();
      return;
    }
    if (e.key === 'Tab') {
      const dialog = dialogRef.current;
      const focusables = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
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
    // Ctrl+Enter sends from the message field, as in chat apps.
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      void submit();
    }
    // Keys stay in the modal (section shortcuts, Delete on a card underneath); Ctrl/Cmd combos still reach the window.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  };

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closeFeedback();
  };

  let status: string | null = null;
  if (draft.tooLong) status = t('common.feedback.tooLong');
  else if (attach && draft.droppedLines > 0) status = t('common.feedback.dropped', { count: draft.droppedLines });

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4',
        leaving ? 'pointer-events-none motion-safe:animate-overlay-out' : 'motion-safe:animate-overlay-in',
      )}
      onMouseDown={onOverlayMouseDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        aria-hidden={leaving || undefined}
        className={cn(
          'flex max-h-[calc(100vh-80px)] w-[600px] max-w-full flex-col overflow-hidden rounded-dialog border border-line-4 bg-bg-3 shadow-dialog outline-none',
          leaving ? 'motion-safe:animate-dialog-out' : 'motion-safe:animate-dialog-in',
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-2 py-3.5 pl-6 pr-4">
          <h2 id={titleId} className="text-heading-lg text-ink-1">
            {t('common.feedback.title')}
          </h2>
          <button
            type="button"
            onClick={closeFeedback}
            aria-label={t('common.feedback.close')}
            title={t('common.feedback.close')}
            className="grid h-7 w-7 flex-none place-items-center rounded-ctl text-ink-3 hover:bg-bg-hover hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5">
          <p id={introId} className="text-body text-ink-3">
            {t('common.feedback.intro')}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl
              label={t('common.feedback.kindLabel')}
              value={kind}
              options={FEEDBACK_KINDS.map((value) => ({ value, label: t(`common.feedback.kind.${value}`) }))}
              onChange={setKind}
            />
            <span className="text-meta text-ink-4">{t(kind === 'idea' ? 'common.feedback.whereIdea' : 'common.feedback.whereIssue')}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={messageId} className="text-meta font-medium text-ink-2">
              {t('common.feedback.message')}
            </label>
            <textarea
              ref={messageRef}
              id={messageId}
              value={text}
              maxLength={MAX_TEXT}
              rows={5}
              placeholder={t(`common.feedback.placeholder.${kind}`)}
              aria-describedby={empty ? statusId : undefined}
              onChange={(e) => setText(e.target.value)}
              className="min-h-[96px] w-full resize-y rounded-ctl border border-line-3 bg-bg-input px-2.5 py-2 text-body leading-[1.5] text-ink-1 placeholder:text-ink-4"
            />
          </div>
          <div className="flex items-start gap-2.5">
            <Checkbox
              id={attachId}
              checked={attach}
              onChange={setAttach}
              aria-labelledby={`${attachId}-label`}
              aria-describedby={attachHelpId}
              className="mt-px"
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span id={`${attachId}-label`} className="cursor-pointer text-body text-ink-1" onClick={() => setAttach(!attach)}>
                {t('common.feedback.attach')}
              </span>
              <span id={attachHelpId} className="text-meta text-ink-4">
                {t('common.feedback.attachHelper')}
              </span>
            </div>
          </div>
          <section aria-labelledby={previewId} className="flex flex-col gap-1.5">
            <h3 id={previewId} className="font-mono text-mono-label uppercase text-ink-4">
              {t('common.feedback.preview')}
            </h3>
            {loading ? (
              <div aria-busy="true" aria-label={t('common.loading')} className="flex flex-col gap-2 rounded-card border border-line-2 bg-bg-2 p-3">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            ) : (
              <pre
                tabIndex={0}
                aria-labelledby={previewId}
                className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-card border border-line-2 bg-bg-2 p-3 font-mono text-mono-sm leading-[1.5] text-ink-3"
              >
                {`${draft.title}\n\n${draft.body}`}
              </pre>
            )}
          </section>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line-2 px-6 py-3.5">
          <p id={statusId} role="status" className={cn('min-w-0 text-meta', draft.tooLong ? 'text-danger' : 'text-ink-4')}>
            {status ?? (empty ? t('common.feedback.needText') : '')}
          </p>
          <div className="flex flex-none items-center gap-2">
            <Button variant="ghost" size={32} onClick={closeFeedback}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size={32} disabled={!canOpen} onClick={() => void submit()}>
              {t('common.feedback.open')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
