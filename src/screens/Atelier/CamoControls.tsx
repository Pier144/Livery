import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CAMO_PATTERNS, MIN_CAMO_WEIGHT, type BaseLayer, type CamoPattern } from '@/atelier/project';
import { cn } from '@/lib/cn';
import { drawCamoThumbnail, THUMB_H, THUMB_W } from './camoThumbnail';
import { equalShares, moveShareDivider } from './editorModel';

/** Controls of the Base's camo: the style picker and the colour shares bar. */

/** The style a Base is drawn with: its `pattern` when this version knows it, else organic. */
export function camoPatternOf(base: BaseLayer): CamoPattern {
  return (CAMO_PATTERNS as readonly string[]).includes(base.pattern ?? '') ? (base.pattern as CamoPattern) : 'organic';
}

/** One style tile's thumbnail, redrawn at most once per frame when the Base changes. */
function Thumbnail({ base, pattern }: { base: BaseLayer; pattern: CamoPattern }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const ctx = ref.current?.getContext('2d');
      if (ctx) drawCamoThumbnail(ctx, base, pattern);
    });
    return () => cancelAnimationFrame(frame);
  }, [base, pattern]);
  return <canvas ref={ref} width={THUMB_W} height={THUMB_H} aria-hidden className="block aspect-[8/5] w-full rounded-menu bg-bg-3" />;
}

/**
 * The camo styles as a WAI-ARIA radio group of tiles (3 × 2): one tab stop (the checked tile);
 * arrow keys move and select with wrap-around, Home/End jump to the ends.
 */
export function CamoStylePicker({ base, labelId, onChange }: { base: BaseLayer; labelId: string; onChange: (pattern: CamoPattern) => void }) {
  const { t } = useTranslation();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const value = camoPatternOf(base);
  const select = (i: number) => {
    const pattern = CAMO_PATTERNS[i]!;
    refs.current[i]?.focus();
    if (pattern !== value) onChange(pattern);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = CAMO_PATTERNS.length;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (i + 1) % n
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    select(next);
  };
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-3 gap-2">
      {CAMO_PATTERNS.map((pattern, i) => {
        const checked = pattern === value;
        return (
          <button
            key={pattern}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => select(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'flex min-w-0 flex-col gap-1 rounded-ctl border p-1 text-left motion-safe:transition-colors motion-safe:duration-120',
              checked ? 'border-amber bg-bg-4' : 'border-line-3 hover:border-line-4',
            )}
          >
            <Thumbnail base={base} pattern={pattern} />
            <span className={cn('truncate px-0.5 text-meta', checked ? 'text-ink-1' : 'text-ink-3')}>{t(`atelier.props.camoStyles.${pattern}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

const percent = (v: number) => Math.round(v * 100);

/**
 * The colour shares as one bar split into the camo colours, each as wide as its share, with the
 * percentages under it. The dividers are sliders (drag, ←/→ 1 %, Page keys 10 %); no share goes
 * under MIN_CAMO_WEIGHT; double-clicking the bar makes the shares equal again (no field).
 */
export function CamoSharesBar({
  base,
  labelId,
  onChange,
  onCommit,
}: {
  base: BaseLayer;
  labelId: string;
  /** New shares (undefined = equal), as one gesture until `onCommit`. */
  onChange: (weights: number[] | undefined) => void;
  onCommit: () => void;
}) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement>(null);
  const count = base.colors.length;
  const weights = base.weights && base.weights.length === count ? base.weights : equalShares(count);
  const bounds = weights.slice(0, -1).map((_, i) => weights.slice(0, i + 1).reduce((a, b) => a + b, 0));

  const move = (i: number, position: number) => onChange(moveShareDivider(base.weights, i, position, count));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>, i: number) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    move(i, (e.clientX - rect.left) / rect.width);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const step = { ArrowRight: 0.01, ArrowUp: 0.01, ArrowLeft: -0.01, ArrowDown: -0.01, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    move(i, bounds[i]! + step);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={bar}
        aria-labelledby={labelId}
        role="group"
        onDoubleClick={() => {
          onChange(undefined);
          onCommit();
        }}
        className="relative flex h-6 overflow-hidden rounded-ctl border border-line-3"
      >
        {weights.map((w, i) => (
          // Project colours (data, not styling).
          <div key={i} className="h-full" style={{ width: `${w * 100}%`, backgroundColor: base.colors[i] }} />
        ))}
        {bounds.map((b, i) => (
          <div
            key={i}
            role="slider"
            tabIndex={0}
            aria-label={t('atelier.props.shareDivider', { a: i + 1, b: i + 2 })}
            aria-valuemin={percent(MIN_CAMO_WEIGHT)}
            aria-valuemax={100 - percent(MIN_CAMO_WEIGHT)}
            aria-valuenow={percent(b)}
            aria-valuetext={t('atelier.props.shareValues', { a: i + 1, b: i + 2, first: percent(weights[i]!), second: percent(weights[i + 1]!) })}
            onPointerDown={onPointerDown}
            onPointerMove={(e) => onPointerMove(e, i)}
            onPointerUp={onCommit}
            onKeyDown={(e) => onKeyDown(e, i)}
            onKeyUp={onCommit}
            onBlur={onCommit}
            style={{ left: `${b * 100}%` }}
            className="group absolute inset-y-0 -ml-1.5 flex w-3 cursor-ew-resize touch-none justify-center"
          >
            <span className="h-full w-0.5 bg-bg-0 group-hover:w-1 group-focus-visible:w-1" />
          </div>
        ))}
      </div>
      <div className="flex font-mono text-mono-sm text-ink-3" aria-hidden>
        {weights.map((w, i) => (
          <span key={i} className="overflow-visible whitespace-nowrap text-center" style={{ width: `${w * 100}%` }}>
            {percent(w)}%
          </span>
        ))}
      </div>
    </div>
  );
}
