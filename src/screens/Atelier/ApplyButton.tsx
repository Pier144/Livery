import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import type { ApplyState } from './useApply';

/**
 * Apply to game, the editor's one primary button. While an apply runs the same button stays (so
 * focus stays on it) but does nothing (`aria-disabled`): it shows the current step (Bake per
 * part, then Encode, Write, Install) with a progress bar under it.
 */
export function ApplyButton({ state, blocked, onApply }: { state: ApplyState; blocked: string | null; onApply: () => void }) {
  const { t } = useTranslation();
  const stepText = !state.running
    ? null
    : state.step === 'bake'
      ? t('atelier.apply.step.bake', { part: state.part ?? '' })
      : t(`atelier.apply.step.${state.step}`);
  return (
    <div className="relative flex-none">
      <Button
        variant="primary"
        size={30}
        onClick={() => {
          if (!state.running) onApply();
        }}
        disabled={!state.running && blocked !== null}
        aria-disabled={state.running || undefined}
        aria-busy={state.running || undefined}
        title={!state.running ? (blocked ?? undefined) : undefined}
        className={cn(state.running && 'w-[188px] cursor-default justify-between opacity-50 hover:bg-amber')}
      >
        {state.running ? (
          <>
            <span className="min-w-0 truncate">{stepText}</span>
            <span className="flex-none font-mono text-mono-sm">{state.pct}%</span>
          </>
        ) : (
          <>
            <Upload size={14} strokeWidth={1.75} aria-hidden />
            {t('atelier.apply.button')}
          </>
        )}
      </Button>
      {state.running && (
        <div
          role="progressbar"
          aria-label={t('atelier.apply.progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.pct}
          aria-valuetext={stepText ?? undefined}
          className="absolute inset-x-0 -bottom-[7px] h-[3px] overflow-hidden rounded-sm bg-bg-5"
        >
          <div className="h-full bg-amber motion-safe:transition-[width] motion-safe:duration-250 motion-safe:ease-decel" style={{ width: `${state.pct}%` }} />
        </div>
      )}
    </div>
  );
}
