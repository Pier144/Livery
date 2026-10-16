import type { TFunction } from 'i18next';
import { Check } from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatedCheck } from '@/components/ui/AnimatedCheck';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { useJustEntered } from '@/lib/motion';
import { useWtLiveInstall, type WtInstallState } from '@/store/installs';
import type { WtLiveSkin } from '@/types';
import { stepText, type StepName, type StepText } from './exploreModel';

/** Error codes with their own explanation; anything else shows the backend's message in the UI language (`errorText`). */
const ERROR_KEYS = {
  network: 'explore.card.errors.network',
  unsupported: 'explore.card.errors.unavailable',
  noBackend: 'explore.card.errors.unavailable',
  conflict: 'explore.card.errors.conflict',
  notFound: 'explore.card.errors.notFound',
} as const;

export function installErrorText(t: TFunction, code: string | undefined, message: string): string {
  const key = code !== undefined ? ERROR_KEYS[code as keyof typeof ERROR_KEYS] : undefined;
  if (key) return t(key);
  return message.trim() ? errorText({ code, message }, t) : t('explore.card.failed');
}

/** "Extracting 56%" / "Done": the current step as the progress bar's value text. */
export function stepNowText(t: TFunction, text: StepText): string {
  const step = t(`explore.card.stepsNow.${text.now}`);
  return text.pct === null ? step : t('explore.card.stepPct', { step, pct: text.pct });
}

const Tick = () => <Check size={10} strokeWidth={1.75} aria-hidden className="ml-0.5 inline-block align-[-1px]" />;

function StepList({ steps, ticked, t }: { steps: StepName[]; ticked: boolean; t: TFunction }) {
  return (
    <>
      {steps.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && ' · '}
          {t(`explore.card.steps.${s}`)}
          {ticked && <Tick />}
        </Fragment>
      ))}
    </>
  );
}

/** The step line under the progress bar: done steps (ink-3) · current step (amber) · next steps. */
function Steps({ text, t }: { text: StepText; t: TFunction }) {
  return (
    <div aria-hidden className="flex justify-between gap-2 font-mono text-[10px] leading-[normal]">
      <span className="min-w-0 truncate text-ink-3">
        <StepList steps={text.done} ticked t={t} />
      </span>
      <span className="flex-none whitespace-nowrap text-amber">
        {stepNowText(t, text)}
        {text.now === 'done' && <Tick />}
      </span>
      {/* ink-4, not the prototype's ink-5: 10px text needs 4.5:1 on bg-3. */}
      <span className="min-w-0 truncate text-ink-4">
        <StepList steps={text.next} ticked={false} t={t} />
      </span>
    </div>
  );
}

/**
 * The 3px install progress bar (the card's action row; For you's thumbnails). `text` is the
 * current step and its percentage (`stepText`).
 */
export function InstallProgressBar({ text, t, className }: { text: StepText; t: TFunction; className?: string }) {
  const pct = text.pct ?? 100;
  return (
    <div
      role="progressbar"
      aria-label={t('explore.card.progress')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={stepNowText(t, text)}
      className={cn('h-[3px] overflow-hidden rounded-[2px] bg-bg-5', className)}
    >
      <div className="h-full bg-amber motion-safe:transition-[width] motion-safe:duration-250 motion-safe:ease-decel" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * The card's install state in small, over a thumbnail (For you): the progress bar while it
 * installs, then "Installed" (or "Trying in game"), or "Install failed". Nothing before an
 * install. Passive: installing, retrying and the reason are on the Skin detail. Draw it inside a
 * `relative` box; it sits along the bottom edge.
 */
export function CompactInstallState({ skin }: { skin: Pick<WtLiveSkin, 'id'> }) {
  const { t } = useTranslation();
  const { state } = useWtLiveInstall(skin);
  const label = 'flex items-center gap-0.5 truncate rounded-menu px-1.5 py-0.5 font-mono text-[10px] font-medium leading-[normal]';
  switch (state.kind) {
    case 'idle':
      return null;
    case 'installing':
      return (
        <span className="absolute inset-x-1.5 bottom-1.5 block">
          <InstallProgressBar text={stepText(state.step === 'error' ? 'download' : state.step, state.pct)} t={t} />
        </span>
      );
    case 'installed':
      return (
        <span className="absolute bottom-1.5 left-1.5 right-1.5 flex">
          <span className={cn(label, 'border border-amber-35 bg-bg-tag text-amber')}>
            <span className="truncate">{state.temporary ? t('explore.card.trying') : t('explore.card.installed')}</span>
            {!state.temporary && <Check size={10} strokeWidth={1.75} aria-hidden className="flex-none" />}
          </span>
        </span>
      );
    case 'error':
      return (
        <span className="absolute bottom-1.5 left-1.5 right-1.5 flex">
          <span className={cn(label, 'border border-danger-40 bg-bg-tag text-danger')}>
            <span className="truncate">{t('explore.card.failed')}</span>
          </span>
        </span>
      );
  }
}

/** Screen reader announcement for install state changes (the finished install has its own toast). */
function announcement(t: TFunction, state: WtInstallState): string {
  if (state.kind === 'installing' && state.step !== 'done') return t('explore.card.progress');
  if (state.kind === 'error') return t('explore.card.failed');
  return '';
}

/**
 * The card's 30px action row, from `useWtLiveInstall`: Install → progress with steps → Installed
 * (or Trying in game), or Install failed with Retry / Install as a copy. The buttons sit above the
 * card's hit area and never open the detail; the passive states let clicks through to it.
 */
export function CardAction({ skin }: { skin: WtLiveSkin }) {
  const { t } = useTranslation();
  const { state, install } = useWtLiveInstall(skin);
  const statusRef = useRef<HTMLSpanElement>(null);
  // "Installed" reached while the card is on screen: its check pops in.
  const justInstalled = useJustEntered(state.kind === 'installed');

  // Install / Retry / Install as a copy go away once pressed: keep focus on the card, not the page.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const card = statusRef.current?.closest<HTMLElement>('[data-skin-id]');
    const active = document.activeElement;
    if (!card || (active && active !== document.body && card.contains(active))) return;
    card.querySelector<HTMLElement>('[role="button"]')?.focus();
  }, [state.kind]);

  const run = (conflict?: 'copy') => (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    refocus.current = document.activeElement === e.currentTarget;
    install(conflict);
  };

  let body: JSX.Element;
  switch (state.kind) {
    case 'idle':
      body = (
        <button
          type="button"
          onClick={run()}
          className="relative z-[1] mt-1 flex h-btn w-full items-center justify-center gap-2 rounded-ctl border border-line-3 bg-bg-4 text-meta font-medium leading-none text-ink-1 hover:border-amber hover:bg-amber hover:text-onAmber motion-safe:transition-colors motion-safe:duration-120"
        >
          {t('explore.card.install')}{' '}
          <span className="font-mono text-[10px] font-normal opacity-70">{formatBytes(skin.sizeBytes)}</span>
        </button>
      );
      break;
    case 'installing': {
      const text = stepText(state.step === 'error' ? 'download' : state.step, state.pct);
      body = (
        <div className="mt-1 flex h-btn flex-col justify-center gap-1.5">
          <InstallProgressBar text={text} t={t} />
          <Steps text={text} t={t} />
        </div>
      );
      break;
    }
    case 'installed':
      body = state.temporary ? (
        <div className="mt-1 flex flex-col gap-1.5">
          <div className="flex h-btn items-center rounded-ctl border border-amber-35 bg-amber-10 px-2.5 text-meta font-medium leading-[normal] text-amber">
            <span className="truncate">{t('explore.card.trying')}</span>
          </div>
          <p className="text-[11px] leading-[normal] text-ink-3">{t('explore.card.tryingHint')}</p>
        </div>
      ) : (
        <div className="mt-1 flex h-btn items-center justify-between gap-2 rounded-ctl border border-amber-35 bg-amber-10 px-2.5 text-meta font-medium leading-[normal] text-amber">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">{t('explore.card.installed')}</span>
            <AnimatedCheck size={12} animate={justInstalled} className="flex-none" />
          </span>
          <span className="flex-none font-mono text-[10px] font-normal text-ink-3">{t('explore.card.inHangar')}</span>
        </div>
      );
      break;
    case 'error': {
      const conflict = state.code === 'conflict';
      body = (
        <div className="mt-1 flex flex-col gap-1.5">
          <div className="flex h-btn items-center justify-between gap-2 rounded-ctl border border-danger-40 bg-danger-8 px-2.5 text-meta font-medium leading-[normal] text-danger">
            {/* Announced (and read) through the status region below. */}
            <span aria-hidden className="truncate">
              {t('explore.card.failed')}
            </span>
            <button
              type="button"
              onClick={run(conflict ? 'copy' : undefined)}
              className="relative z-[1] flex-none whitespace-nowrap text-meta font-medium text-ink-1 underline underline-offset-[3px] hover:text-amber motion-safe:transition-colors motion-safe:duration-120"
            >
              {conflict ? t('explore.card.installCopy') : t('explore.card.retry')}
            </button>
          </div>
          <p className="text-[11px] leading-[normal] text-ink-3">{installErrorText(t, state.code, state.message)}</p>
        </div>
      );
      break;
    }
  }

  return (
    <>
      {body}
      <span ref={statusRef} role="status" className="sr-only">
        {announcement(t, state)}
      </span>
    </>
  );
}
