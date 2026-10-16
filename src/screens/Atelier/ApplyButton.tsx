import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { ApplyState } from './useApply';

/**
 * Apply to game, the editor's one primary button. While an apply runs it is disabled, shows the
 * current step (Bake per part, then Encode, Write, Install) and a progress bar under it.
 */
export function ApplyButton({ state, blocked, onApply }: { state: ApplyState; blocked: string | null; onApply: () => void }) {
  const { t } = useTranslation();
  if (!state.running) {
    return (
      <Button variant="primary" size={30} onClick={onApply} disabled={blocked !== null} title={blocked ?? undefined}>
        <Upload size={14} strokeWidth={1.75} aria-hidden />
        {t('atelier.apply.button')}
      </Button>
    );
  }
  const stepText = state.step === 'bake' ? t('atelier.apply.step.bake', { part: state.part ?? '' }) : t(`atelier.apply.step.${state.step}`);
  return (
    <div className="relative flex-none">
      <Button variant="primary" size={30} disabled aria-busy className="w-[188px] justify-between">
        <span className="min-w-0 truncate">{stepText}</span>
        <span className="flex-none font-mono text-mono-sm">{state.pct}%</span>
      </Button>
      <div
        role="progressbar"
        aria-label={t('atelier.apply.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={state.pct}
        aria-valuetext={stepText}
        className="absolute inset-x-0 -bottom-[7px] h-[3px] overflow-hidden rounded-sm bg-bg-5"
      >
        <div className="h-full bg-amber motion-safe:transition-[width] motion-safe:duration-250 motion-safe:ease-decel" style={{ width: `${state.pct}%` }} />
      </div>
    </div>
  );
}
