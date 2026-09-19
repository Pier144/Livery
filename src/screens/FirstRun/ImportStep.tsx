import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import type { HangarSkin } from '@/types';
import { importSummary, importTag, type ImportTag } from './firstRunMachine';
import { StepIntro } from './StepTracker';

/** Rows listed before "+ N more". */
const PREVIEW_ROWS = 5;
const BUSY = 'aria-disabled:cursor-default aria-disabled:opacity-50';

interface ImportStepProps {
  /** `scan_user_skins` result; undefined while scanning or after a failed scan. */
  skins: HangarSkin[] | undefined;
  scanning: boolean;
  scanFailed: boolean;
  busy: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onImport: () => void;
  onSkip: () => void;
  onRetry: () => void;
}

/** 03 IMPORT: what is already in UserSkins, with the option to add it to My Hangar. */
export function ImportStep({ skins, scanning, scanFailed, busy, headingRef, onImport, onSkip, onRetry }: ImportStepProps) {
  const { t } = useTranslation();
  const ready = !!skins && !scanning;

  return (
    <>
      <StepIntro headingRef={headingRef} title={t('firstRun.import.title')} body={t('firstRun.import.body')} />
      {ready ? (
        <ImportCard skins={skins} />
      ) : scanFailed ? (
        <div className="flex items-center justify-between gap-3 rounded-card border border-line-2 bg-bg-3 px-3.5 py-3">
          <p className="flex items-center gap-2 text-meta text-ink-2">
            <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-amber" />
            {t('firstRun.import.scanFailed')}
          </p>
          <Button variant="secondary" size={28} onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <ImportSkeleton />
      )}
      <div className="flex items-center gap-2.5">
        <Button variant="primary" size={34} onClick={onImport} aria-disabled={busy || !ready || undefined} className={BUSY}>
          {t('firstRun.import.import')}
        </Button>
        <Button variant="secondary" size={34} onClick={onSkip} aria-disabled={busy || undefined} className={BUSY}>
          {t('firstRun.import.skip')}
        </Button>
      </div>
    </>
  );
}

const TAG_COLOR: Record<ImportTag, string> = { attention: 'text-amber', mine: 'text-ink-4', ok: 'text-ink-4' };

function ImportCard({ skins }: { skins: HangarSkin[] }) {
  const { t } = useTranslation();
  const summary = importSummary(skins);
  const more = skins.length - PREVIEW_ROWS;

  return (
    <div className="overflow-hidden rounded-card border border-line-2 bg-bg-3">
      <div className="grid grid-cols-3 border-b border-line-2">
        <Stat value={summary.skins} label={t('firstRun.import.stats.skins')} />
        <Stat value={summary.vehicles} label={t('firstRun.import.stats.vehicles')} className="border-l border-line-2" />
        <Stat value={summary.attention} label={t('firstRun.import.stats.attention')} className="border-l border-line-2" accent />
      </div>
      {skins.length > 0 && (
        <ul>
          {skins.slice(0, PREVIEW_ROWS).map((skin) => (
            <ImportRow key={skin.id} skin={skin} />
          ))}
        </ul>
      )}
      {more > 0 && (
        <p className="border-t border-line-grid px-3.5 py-2 font-mono text-mono-sm leading-[normal] text-ink-4">
          {t('firstRun.import.more', { count: more })}
        </p>
      )}
    </div>
  );
}

function Stat({ value, label, accent, className }: { value: number; label: string; accent?: boolean; className?: string }) {
  return (
    <div className={cn('px-3.5 py-3', className)}>
      <div className={cn('text-[22px] font-medium leading-[normal]', accent && 'text-amber')}>{value}</div>
      <div className="text-[11px] leading-[normal] text-ink-3">{label}</div>
    </div>
  );
}

function ImportRow({ skin }: { skin: HangarSkin }) {
  const { t } = useTranslation();
  const tag = importTag(skin);
  // Why it needs attention, for screen readers and as a tooltip.
  const reasons = (skin.attention ?? [])
    .map((a) => {
      // Kinds that name a file fall back to the backend's message when it has none.
      const namesFile = a.kind === 'missingTexture' || a.kind === 'unknownBlkBlock';
      return namesFile && !a.file ? a.message : t(`hangar.attention.${a.kind}`, { file: a.file ?? '' });
    })
    .join('; ');

  return (
    <li className="flex items-center gap-2.5 border-b border-line-grid px-3.5 py-2 text-meta leading-[normal] last:border-b-0">
      <span aria-hidden className="h-[22px] w-9 flex-none rounded-tag bg-placeholder-thumb" />
      <span className="min-w-0 flex-1 truncate text-ink-1" title={skin.name}>
        {skin.name}
      </span>
      <span className="max-w-[40%] truncate text-ink-3">{skin.vehicle.name}</span>
      <span
        title={reasons || undefined}
        className={cn('min-w-[90px] flex-none text-right font-mono text-[10px] leading-[normal]', TAG_COLOR[tag])}
      >
        {t(`firstRun.import.tag.${tag}`)}
        {reasons && <span className="sr-only">: {reasons}</span>}
      </span>
    </li>
  );
}

/** Shown while `scan_user_skins` runs: stat and row placeholders (no spinner). */
function ImportSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className="overflow-hidden rounded-card border border-line-2 bg-bg-3">
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden className="grid grid-cols-3 border-b border-line-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn('flex flex-col gap-2 px-3.5 py-3', i > 0 && 'border-l border-line-2')}>
            <Skeleton className="h-[22px] w-8 rounded-tag" />
            <Skeleton className="h-2.5 w-14 rounded-tag" />
          </div>
        ))}
      </div>
      <div aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2.5 border-b border-line-grid px-3.5 py-2 last:border-b-0">
            <Skeleton className="h-[22px] w-9 flex-none rounded-tag" />
            <Skeleton className="h-2.5 flex-1 rounded-tag" />
            <Skeleton className="h-2.5 w-16 rounded-tag" />
          </div>
        ))}
      </div>
    </div>
  );
}
