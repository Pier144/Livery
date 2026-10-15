import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { useLeaving } from '@/lib/motion';
import { openLink, REPO_URL } from '@/lib/opener';
import { useAppVersion } from '@/screens/Settings/useAppVersion';
import { useUpdate } from '@/store/update';

/**
 * "Livery X is available", opened by the check at launch (`useLaunchUpdateCheck`): Install and
 * restart (focused) / Later (Escape, or a click outside). After Install it stays open with the
 * download's progress until Livery closes; a failure shows the error and offers Later. Modal like
 * the conflict dialog: Tab cycles inside, keys don't reach the screen underneath, focus goes back
 * on close.
 */
export function UpdateDialog() {
  // Kept a moment after "Later", for the exit animation.
  const { value: prompt, leaving } = useLeaving(useUpdate((s) => s.prompt) ?? null, 120);
  if (!prompt) return null;
  return <UpdateDialogBody version={prompt} leaving={leaving} />;
}

function UpdateDialogBody({ version, leaving }: { version: string; leaving: boolean }) {
  const { t } = useTranslation();
  const current = useAppVersion();
  const { phase, pct, requested, install, dismissPrompt } = useUpdate();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const installRef = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement);

  // Focus goes back as soon as the popup closes, not after its exit animation.
  const restored = useRef(false);
  const restore = useCallback(() => {
    if (restored.current) return;
    restored.current = true;
    if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
  }, [opener]);
  useEffect(() => {
    installRef.current?.focus();
    return restore;
  }, [restore]);
  useEffect(() => {
    if (leaving) restore();
  }, [leaving, restore]);

  const working = requested && (phase === 'downloading' || phase === 'installing');
  const failed = requested === false && phase === 'error';

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!working) dismissPrompt();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && dialogRef.current?.contains(active);
      if (!first) {
        e.preventDefault();
        dialogRef.current?.focus();
      } else if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  };

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !working) dismissPrompt();
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
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onKeyDown={leaving ? undefined : onKeyDown}
        aria-hidden={leaving || undefined}
        className={cn(
          'flex w-[460px] max-w-[calc(100vw-32px)] flex-col gap-4 rounded-dialog border border-line-4 bg-bg-3 px-6 py-5.5 shadow-dialog outline-none',
          leaving ? 'motion-safe:animate-dialog-out' : 'motion-safe:animate-dialog-in',
        )}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="h-2 w-2 flex-none rounded-full bg-amber shadow-glow" />
            <h2 id={titleId} className="text-heading-lg text-ink-1">
              {t('common.update.title', { version })}
            </h2>
          </div>
          <p id={bodyId} role="status" className="text-body text-ink-3">
            {phase === 'installing' && requested
              ? t('settings.updates.installingHelper')
              : phase === 'downloading' && requested
                ? t('settings.updates.downloading', { version })
                : t('common.update.body', { current })}
          </p>
        </div>
        {working && (
          <div
            role="progressbar"
            aria-labelledby={titleId}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase === 'installing' ? 100 : pct}
            className="flex flex-col gap-1.5"
          >
            <div className="h-[3px] overflow-hidden rounded-[2px] bg-bg-5">
              {pct === undefined && phase !== 'installing' ? (
                <div className="h-full w-2/5 bg-amber motion-safe:animate-indeterminate" />
              ) : (
                <div
                  className="h-full bg-amber motion-safe:transition-[width] motion-safe:duration-150 motion-safe:ease-linear"
                  style={{ width: `${phase === 'installing' ? 100 : (pct ?? 0)}%` }}
                />
              )}
            </div>
          </div>
        )}
        {failed && <UpdateError />}
        {!working && (
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => void openLink(`${REPO_URL}/releases/tag/v${version}`, t)}
              className="text-[11px] leading-[normal] text-ink-3 underline underline-offset-[3px] hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
            >
              {t('common.update.whatsNew')}
            </button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size={30} onClick={dismissPrompt}>
                {t('common.update.later')}
              </Button>
              <Button ref={installRef} variant="primary" size={30} onClick={() => void install()}>
                {phase === 'ready' ? t('settings.updates.restart') : t('settings.updates.install')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UpdateError() {
  const { t } = useTranslation();
  const error = useUpdate((s) => s.error);
  if (!error) return null;
  return <p className="text-[11px] leading-[normal] text-danger">{errorText(error, t)}</p>;
}
