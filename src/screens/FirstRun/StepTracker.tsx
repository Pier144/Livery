import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

const STEPS = ['detect', 'confirm', 'import'] as const;

/**
 * "01 DETECT · 02 CONFIRM · 03 IMPORT": current step amber, past ink-3, future ink-4 (the current
 * one is also `aria-current`). The README asks for ink-5 on future steps, but they are 10px text
 * naming the steps: ink-5 is 3.57:1 on bg-2, ink-4 is 4.81:1 (docs/a11y.md; the same call as the
 * Explore card's upcoming install steps). The separators stay ink-5: they are decoration.
 */
export function StepTracker({ current }: { current: 0 | 1 | 2 }) {
  const { t } = useTranslation();
  return (
    <ol aria-label={t('firstRun.steps.label')} className="flex gap-2 font-mono text-mono-label leading-[normal] text-ink-5">
      {STEPS.map((step, i) => (
        <li key={step} aria-current={i === current ? 'step' : undefined} className="flex gap-2">
          {i > 0 && <span aria-hidden>·</span>}
          <span className={cn(i === current ? 'text-amber' : i < current ? 'text-ink-3' : 'text-ink-4')}>
            {t(`firstRun.steps.${step}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface StepIntroProps {
  title: string;
  body: string;
  /** Focused when the step changes so screen readers hear the new step (not a tab stop). */
  headingRef: Ref<HTMLHeadingElement>;
}

/** Display title + 14px body opening every step. */
export function StepIntro({ title, body, headingRef }: StepIntroProps) {
  return (
    <div className="flex flex-col gap-2.5">
      <h1 ref={headingRef} tabIndex={-1} className="text-display outline-none">
        {title}
      </h1>
      <p className="text-[14px] leading-normal text-ink-3">{body}</p>
    </div>
  );
}
