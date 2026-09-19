import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Section heading (500 20px) with an optional 13px ink-3 intro under it (Conflicts). */
export function SectionTitle({ children, id, intro, introId }: { children: ReactNode; id?: string; intro?: ReactNode; introId?: string }) {
  const heading = (
    // Line-height `normal` (26px) as the prototype's `font:` shorthand.
    <h2 id={id} className="text-title leading-[normal] text-ink-1">
      {children}
    </h2>
  );
  if (!intro) return heading;
  return (
    <div className="flex flex-col gap-1.5">
      {heading}
      <p id={introId} className="text-body text-ink-3">
        {intro}
      </p>
    </div>
  );
}

/** Card holding setting rows (bg-3, line-2 border, rows divided by line-2). */
export function SettingGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-col overflow-hidden rounded-card border border-line-2 bg-bg-3">{children}</div>;
}

export interface RowIds {
  labelId: string;
  /** Present when the row has a helper. */
  helperId?: string;
}

interface SettingRowProps {
  label: ReactNode;
  /** 11px ink-3 line under the label, or an 11px mono ink-4 value (paths, sizes) with `mono`. */
  helper?: ReactNode;
  mono?: boolean;
  /** Fixed ids, so content outside the control (or another row) can point at the label or helper. */
  labelId?: string;
  helperId?: string;
  /** Extra content under the helper (e.g. a hidden path and its "Show path" toggle). */
  details?: ReactNode;
  /** The control on the right; gets the ids to label and describe itself with. */
  children?: (ids: RowIds) => ReactNode;
}

/** One setting: 13px label + helper on the left, the control on the right (padding 14px 16px, gap 16). */
export function SettingRow({ label, helper, mono, labelId: fixedLabelId, helperId: fixedHelperId, details, children }: SettingRowProps) {
  const autoLabelId = useId();
  const autoHelperId = useId();
  const labelId = fixedLabelId ?? autoLabelId;
  const helperId = helper === undefined ? undefined : (fixedHelperId ?? autoHelperId);
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line-2 px-4 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="text-body leading-[normal] text-ink-1">
          {label}
        </span>
        {helper !== undefined && (
          <div
            id={helperId}
            className={cn('leading-[normal]', mono ? 'break-all font-mono text-mono-sm text-ink-4' : 'text-[11px] text-ink-3')}
          >
            {helper}
          </div>
        )}
        {details}
      </div>
      {children?.({ labelId, helperId })}
    </div>
  );
}

/** 11px underlined text button inside a row ("Show path"). */
export const ROW_LINK =
  'self-start text-[11px] leading-[normal] text-ink-3 underline underline-offset-[3px] hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120';

/** Controls that stay focusable while unavailable (their helper says why). */
export const UNAVAILABLE = 'aria-disabled:cursor-default aria-disabled:opacity-50';
