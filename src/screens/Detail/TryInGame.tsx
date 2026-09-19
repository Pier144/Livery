import { useId, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { formatBytes } from '@/lib/format';
import { isOfflineError, useFinalizeTry } from '@/queries/wtlive';
import { useInstalls, type WtInstall } from '@/store/installs';
import { toast } from '@/store/toasts';
import type { HangarSkin, WtLiveSkin } from '@/types';
import type { TryState } from './detailModel';
import { useFocusFallback } from './useFocusFallback';

interface TryInGameProps {
  skin: WtLiveSkin;
  state: TryState;
  hangarSkin: HangarSkin | undefined;
  track: WtInstall | undefined;
}

const TITLE = 'text-[22px] font-medium leading-[1.2] text-ink-1 focus:outline-none';
const BODY = 'text-body leading-[1.55] text-ink-3';
const BOLD = <b className="font-medium text-ink-1" />;
const DISABLED = 'aria-disabled:cursor-default aria-disabled:opacity-50';
const STEPS = ['step1', 'step2', 'step3'] as const;

/**
 * Try in game: idle (how it works + "Try in game · 48 MB") → installing (indeterminate amber bar)
 * → active (Keep / Discard). Keep turns the temporary install into a normal hangar skin; Discard
 * removes it and restores the game files, so it is itself the undo of the try (no extra Undo).
 */
export function TryInGame({ skin, state, hangarSkin, track }: TryInGameProps) {
  const { t } = useTranslation();
  const start = useInstalls((s) => s.start);
  const finalize = useFinalizeTry();
  const busyId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The pressed button leaves with its view: the new view's heading takes focus (and is read out).
  useFocusFallback(state, headingRef);

  const size = formatBytes(skin.sizeBytes);
  const failed = track?.mode === 'temporary' && track.step === 'error' ? track : undefined;
  // A normal install of this skin is running (side panel): one install at a time.
  const busy = track?.mode === 'normal' && track.step !== 'error';

  const finish = (keep: boolean) => {
    if (finalize.isPending) return;
    // The toast also comes when the user has left the screen meanwhile (mutateAsync, not mutate).
    finalize.mutateAsync({ skinId: skin.id, keep }).then(
      () => toast(keep ? t('detail.try.kept', { name: skin.name }) : t('detail.try.discarded', { name: skin.name })),
      (e: { message: string }) => toast(t('detail.try.finalizeFailed', { message: e.message })),
    );
  };

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-5">
      <div className="flex w-full max-w-[560px] flex-col gap-5">
        {state === 'idle' && (
          <>
            <div className="flex flex-col gap-2">
              <h2 ref={headingRef} tabIndex={-1} className={TITLE}>
                {t('detail.try.idleTitle')}
              </h2>
              <p className={BODY}>{t('detail.try.idleBody')}</p>
            </div>
            <ol aria-label={t('detail.try.steps')} className="flex flex-col overflow-hidden rounded-card border border-line-2 bg-bg-3">
              {STEPS.map((step, i) => (
                <li key={step} className="flex gap-3 border-b border-line-2 px-3.5 py-3 text-body last:border-b-0">
                  <span aria-hidden className="min-w-5 font-mono text-mono-sm leading-[1.7] text-ink-4">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="text-ink-2">
                    <Trans i18nKey={`detail.try.${step}`} components={{ b: BOLD }} />
                  </span>
                </li>
              ))}
            </ol>
            {failed && (
              <p role="alert" className="text-meta text-danger">
                {isOfflineError({ code: failed.errorCode ?? 'internal', message: failed.error ?? '' })
                  ? t('detail.try.offline')
                  : t('detail.try.failed', { message: failed.error ?? '' })}
              </p>
            )}
            <div className="flex flex-col items-start gap-2">
              <Button
                variant="primary"
                size={34}
                aria-disabled={busy || undefined}
                aria-describedby={busy ? busyId : undefined}
                onClick={() => {
                  if (!busy) void start(skin.id, 'temporary');
                }}
                className={DISABLED}
              >
                {t('detail.try.start', { size })}
              </Button>
              {busy && (
                <p id={busyId} className="text-meta text-ink-3">
                  {t('detail.try.busy')}
                </p>
              )}
            </div>
          </>
        )}

        {state === 'installing' && (
          <>
            <div className="flex flex-col gap-2">
              <h2 ref={headingRef} tabIndex={-1} className={TITLE}>
                {t('detail.try.installingTitle')}
              </h2>
              <p className={BODY}>{t('detail.try.installingBody', { size })}</p>
            </div>
            {/* Indeterminate: slides under motion-safe, a still 40% bar under reduced motion. */}
            <div role="progressbar" aria-label={t('detail.try.installingLabel')} className="h-[3px] overflow-hidden rounded-[2px] bg-bg-5">
              <div className="h-full w-2/5 bg-amber motion-safe:animate-indeterminate" />
            </div>
          </>
        )}

        {state === 'active' && (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2.5">
                <span aria-hidden className="h-2 w-2 flex-none rounded-full bg-amber motion-safe:animate-pulse6" />
                <h2 ref={headingRef} tabIndex={-1} className={TITLE}>
                  {t('detail.try.activeTitle')}
                </h2>
              </div>
              <p className={BODY}>
                <Trans i18nKey="detail.try.activeBody" values={{ vehicle: skin.vehicle.name, name: skin.name }} components={{ b: BOLD }} />
              </p>
            </div>
            <div className="flex flex-col gap-1.5 rounded-card border border-amber-35 bg-amber-10 px-4 py-3.5">
              <span className="font-mono text-mono-label uppercase text-ink-3">{t('detail.try.temporary')}</span>
              <span data-selectable className="break-all font-mono text-mono-data text-ink-2">
                {`UserSkins/${hangarSkin?.folder ?? ''}/`}
              </span>
            </div>
            <div className="flex gap-2.5">
              <Button
                variant="primary"
                size={34}
                aria-disabled={finalize.isPending || undefined}
                onClick={() => finish(true)}
                className={DISABLED}
              >
                {t('detail.try.keep')}
              </Button>
              <Button
                variant="secondary"
                size={34}
                aria-disabled={finalize.isPending || undefined}
                onClick={() => finish(false)}
                className={DISABLED}
              >
                {t('detail.try.discard')}
              </Button>
            </div>
          </>
        )}

        {state === 'kept' && (
          <div className="flex flex-col gap-2">
            <h2 ref={headingRef} tabIndex={-1} className={TITLE}>
              {t('detail.try.keptTitle')}
            </h2>
            <p className={BODY}>
              <Trans i18nKey="detail.try.keptBody" values={{ vehicle: skin.vehicle.name, name: skin.name }} components={{ b: BOLD }} />
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
