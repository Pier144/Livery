import { Check, X } from 'lucide-react';
import { memo, useId, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu } from '@/components/ui/Menu';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import type { InstallTrack } from '@/store/queue';
import type { QueueItem } from '@/types';
import { AMBER_OUTLINE_28, ICON_28, PRIMARY_28, SECONDARY_28 } from './controls';
import { rowLine, stepsView, STATUS_TONE } from './queueModel';

export interface QueueRowProps {
  item: QueueItem;
  /** Progress while installing. */
  track?: InstallTrack;
  /** Name of the installed skin a conflict row clashes with. */
  installedName: string;
  /** The clash is with another queued item (`queue:<id>`), not an installed skin. */
  conflictQueued?: boolean;
  /** Handlers must be stable (rows are memoized). */
  onInstall: (item: QueueItem) => void;
  onResolve: (item: QueueItem, trigger: HTMLElement) => void;
  onPickVehicle: (item: QueueItem, vehicleCode: string) => void;
  onRemove: (item: QueueItem) => void;
}

/**
 * One queue row (README §6): status dot · mono file name + size · "**Status** · Vehicle · note",
 * and the action for its status. `data-queue-row` / `data-row-action` / `data-row-remove` let the
 * screen move focus after a row changes or leaves.
 */
export const QueueRow = memo(function QueueRow({
  item,
  track,
  installedName,
  conflictQueued = false,
  onInstall,
  onResolve,
  onPickVehicle,
  onRemove,
}: QueueRowProps) {
  const { t } = useTranslation();
  const fileId = useId();
  const tone = STATUS_TONE[item.status];
  const line = rowLine(item, t, installedName, conflictQueued);
  const candidates = item.candidates ?? [];

  return (
    <li
      data-queue-row={item.id}
      tabIndex={-1}
      className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-card border border-line-2 bg-bg-3 px-3.5 py-3"
    >
      <span aria-hidden className={cn('h-2 w-2 rounded-full', tone.dot, tone.pulse && 'motion-safe:animate-pulse6')} />
      <div className="flex min-w-0 flex-col gap-[3px]">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span id={fileId} title={item.fileName} data-selectable className="truncate font-mono text-mono-data leading-[normal] text-ink-1">
            {item.fileName}
          </span>
          {item.sizeBytes > 0 && (
            <span className="flex-none font-mono text-[10px] leading-[normal] text-ink-4">{formatBytes(item.sizeBytes)}</span>
          )}
        </div>
        <p className="text-meta leading-[normal] text-ink-3">
          {line.label && <span className={cn('font-medium', tone.label)}>{line.label}</span>}
          {line.vehicle && (
            <>
              {line.label && ' · '}
              <span className="text-ink-2">{line.vehicle}</span>
            </>
          )}
          {line.note && (
            <>
              {(line.label || line.vehicle) && ' · '}
              {line.note}
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        {item.status === 'ready' && (
          <button type="button" data-row-action aria-describedby={fileId} onClick={() => onInstall(item)} className={PRIMARY_28}>
            {t('queue.action.install')}
          </button>
        )}
        {item.status === 'conflict' && (
          <button
            type="button"
            data-row-action
            aria-describedby={fileId}
            onClick={(e: MouseEvent<HTMLButtonElement>) => onResolve(item, e.currentTarget)}
            className={AMBER_OUTLINE_28}
          >
            {t('queue.action.resolve')}
          </button>
        )}
        {item.status === 'needsLook' && candidates.length > 0 && (
          <Menu
            items={candidates.map((v) => ({
              value: v.code,
              label: v.name,
              textValue: v.name,
              hint: <span className="font-mono text-[10px] text-ink-4">{v.code}</span>,
            }))}
            onSelect={(code) => onPickVehicle(item, code)}
            align="end"
            menuWidthClass="min-w-[240px]"
            renderTrigger={(props) => (
              <button {...props} data-row-action aria-describedby={fileId} className={SECONDARY_28}>
                {t('queue.action.pickVehicle')}
              </button>
            )}
          />
        )}
        {item.status === 'installing' && <InstallProgressBar name={item.fileName} track={track} />}
        {item.status === 'done' && (
          <span className="flex h-ctl items-center gap-1 px-1.5 text-meta font-medium leading-none text-amber">
            {t('queue.action.installed')}
            <Check size={14} strokeWidth={1.75} aria-hidden />
          </span>
        )}
        {item.status !== 'installing' && (
          <button
            type="button"
            data-row-remove
            aria-label={t('queue.action.remove', { name: item.fileName })}
            title={t('queue.action.remove', { name: item.fileName })}
            onClick={() => onRemove(item)}
            className={ICON_28}
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
    </li>
  );
});

/** 3px amber bar + mono steps, as on the Explore card ("Extract ✓ · Verifying 80% · Done"). */
function InstallProgressBar({ name, track }: { name: string; track?: InstallTrack }) {
  const { t } = useTranslation();
  const pct = Math.max(0, Math.min(100, track?.pct ?? 0));
  const steps = stepsView(track?.step ?? 'extract', pct, t);
  return (
    <div className="flex w-[220px] flex-col gap-1.5">
      <div
        role="progressbar"
        aria-label={t('queue.progress.label', { name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={steps.now}
        className="h-[3px] overflow-hidden rounded-sm bg-bg-5"
      >
        <div className="h-full bg-amber motion-safe:transition-[width] motion-safe:duration-150 motion-safe:ease-linear" style={{ width: `${pct}%` }} />
      </div>
      <div aria-hidden className="flex justify-between gap-2 font-mono text-[10px] leading-[normal]">
        <span className="flex min-w-0 items-center gap-1 truncate text-ink-3">
          {steps.done.map((s, i) => (
            <span key={s} className="inline-flex items-center gap-0.5">
              {i > 0 && '· '}
              {s}
              <Check size={10} strokeWidth={1.75} />
            </span>
          ))}
        </span>
        <span className="whitespace-nowrap text-amber">{steps.now}</span>
        <span className="min-w-0 truncate text-ink-4">{steps.next.join(' · ')}</span>
      </div>
    </div>
  );
}
