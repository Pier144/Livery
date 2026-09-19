import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import type { GameSource } from '@/types';
import { SOURCES, rowState, type FirstRunState, type RowState } from './firstRunMachine';
import { StepIntro } from './StepTracker';

interface DetectStepProps {
  state: FirstRunState;
  headingRef: Ref<HTMLHeadingElement>;
}

/** 01 DETECT: one row per place Livery looks, with a paced 2px progress bar. */
export function DetectStep({ state, headingRef }: DetectStepProps) {
  const { t } = useTranslation();
  return (
    <>
      <StepIntro headingRef={headingRef} title={t('firstRun.detect.title')} body={t('firstRun.detect.body')} />
      <ul className="flex flex-col overflow-hidden rounded-card border border-line-2 bg-bg-3">
        {SOURCES.map((source) => (
          <DetectRow key={source} source={source} state={rowState(state, source)} />
        ))}
      </ul>
      <div
        role="progressbar"
        aria-label={t('firstRun.detect.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={state.progress}
        className="h-0.5 overflow-hidden rounded-[1px] bg-line-2"
      >
        <div
          className="h-full bg-amber motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-linear"
          style={{ width: `${state.progress}%` }}
        />
      </div>
    </>
  );
}

type StateKey = 'queued' | 'checking' | 'found' | 'notFound' | 'notInstalled' | 'skipped';

/** A missing standalone launcher reads "not installed"; everything else uses its own state. */
function stateKey(source: GameSource, state: RowState): StateKey {
  return state === 'notFound' && source === 'standalone' ? 'notInstalled' : state;
}

const DOT: Record<RowState, string> = {
  queued: 'bg-line-4',
  checking: 'bg-ink-5 motion-safe:animate-pulse6',
  found: 'bg-amber',
  notFound: 'bg-ink-5',
  skipped: 'bg-line-4',
};

function DetectRow({ source, state }: { source: GameSource; state: RowState }) {
  const { t } = useTranslation();
  const active = state === 'checking' || state === 'found';
  return (
    <li
      className={cn(
        'flex items-center gap-3 border-b border-line-2 px-3.5 py-3 text-body leading-[normal] last:border-b-0',
        active ? 'text-ink-1' : 'text-ink-2',
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 flex-none rounded-full', DOT[state])} />
      <span className="flex-1">{t(`firstRun.detect.sources.${source}`)}</span>
      <span className={cn('font-mono text-mono-sm leading-[normal]', state === 'found' ? 'text-amber' : 'text-ink-4')}>
        {t(`firstRun.detect.state.${stateKey(source, state)}`)}
      </span>
    </li>
  );
}
