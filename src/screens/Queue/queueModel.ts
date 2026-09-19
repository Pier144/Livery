import type { TFunction } from 'i18next';
import { errorText } from '@/lib/errors';
import type { HangarSkin, InstallStep, QueueItem, QueueStatus } from '@/types';

/**
 * ZIP/RAR/7z unpacking waits for its crates to be approved (DESIGN_NOTES, M4): until then dropped archives
 * become error rows and the drop zone says that skin folders install now. Flip when the readers land.
 */
export const ARCHIVES_SUPPORTED = false;

/** Browse dialog filter. */
export const ARCHIVE_EXTENSIONS = ['zip', 'rar', '7z'];

/** Statuses the legend explains, in its order. */
export const LEGEND_STATUSES = ['ready', 'conflict', 'needsLook', 'done', 'error'] as const;

/**
 * Dot and label colors per status (README §6). "Needs a look" labels use ink-4 instead of the
 * prototype's ink-5 (AA); the dot keeps ink-5, the label carries the meaning.
 */
export const STATUS_TONE: Record<QueueStatus, { dot: string; label: string; pulse?: boolean }> = {
  analyzing: { dot: 'bg-ink-5', label: 'text-ink-3', pulse: true },
  ready: { dot: 'bg-ink-2', label: 'text-ink-2' },
  conflict: { dot: 'bg-amber', label: 'text-amber' },
  needsLook: { dot: 'bg-ink-5', label: 'text-ink-4' },
  installing: { dot: 'bg-amber', label: 'text-ink-1', pulse: true },
  done: { dot: 'bg-amber', label: 'text-amber' },
  error: { dot: 'bg-danger', label: 'text-danger' },
};

const ARCHIVE_EXT = /\.(zip|rar|7z)$/i;

/** The skin's name once installed: its folder (the game shows folder names), else the file name without extension. */
export function skinName(item: QueueItem): string {
  return item.targetFolder || item.fileName.replace(ARCHIVE_EXT, '') || item.fileName;
}

export interface ConflictTarget {
  /** Name of the installed skin that uses the same folder. */
  name: string;
  /** Its vehicle, when known. */
  vehicle?: string;
  /** The clash is with another item still in the queue, not with an installed skin. */
  queued?: boolean;
}

/**
 * The installed skin a conflict row clashes with: a My Hangar skin (`conflictWith` = its id), a folder on
 * disk that isn't in the library yet (`disk:<folder>`), or — while the hangar is loading — the target folder.
 */
export function conflictTarget(
  item: QueueItem,
  hangar: readonly HangarSkin[] | undefined,
  queued?: readonly QueueItem[],
): ConflictTarget {
  const id = item.conflictWith;
  if (id?.startsWith('disk:')) return { name: id.slice('disk:'.length), vehicle: item.vehicle?.name };
  // Another queued item will install under the same folder name.
  if (id?.startsWith('queue:')) {
    const other = queued?.find((q) => q.id === id.slice('queue:'.length));
    return { name: other ? skinName(other) : skinName(item), vehicle: other?.vehicle?.name ?? item.vehicle?.name, queued: true };
  }
  const skin = id ? hangar?.find((s) => s.id === id) : undefined;
  if (skin) return { name: skin.name, vehicle: skin.vehicle.name };
  return { name: skinName(item), vehicle: item.vehicle?.name };
}

export interface RowLine {
  /** Colored status label; absent while analysing (the note says it). */
  label?: string;
  vehicle?: string;
  note?: string;
}

/** "6 files · 2 textures · skin.blk ok" from the analysis fields; the backend's note when there are none. */
export function detailsNote(item: QueueItem, t: TFunction): string | undefined {
  const parts: string[] = [];
  if (item.files?.length) parts.push(t('queue.note.files', { count: item.files.length }));
  if (item.textureCount !== undefined) parts.push(t('queue.note.textures', { count: item.textureCount }));
  if (item.blkOk !== undefined) parts.push(t(item.blkOk ? 'queue.note.blkOk' : 'queue.note.blkBad'));
  return parts.length ? parts.join(' · ') : item.note || undefined;
}

/** The row's second line: "**Status** · Vehicle · note". */
export function rowLine(item: QueueItem, t: TFunction, installedName: string, conflictQueued = false): RowLine {
  const label = t(`queue.status.${item.status}`);
  const vehicle = item.vehicle?.name;
  switch (item.status) {
    case 'analyzing':
      // Folders are analysed too, so not "Analyzing archive…".
      return { note: t('queue.note.analyzing') };
    case 'ready':
      return { label, vehicle, note: detailsNote(item, t) };
    case 'conflict':
      return {
        label,
        vehicle,
        note: t(conflictQueued ? 'queue.note.conflictQueued' : 'queue.note.conflict', { installed: installedName }),
      };
    case 'needsLook':
      return { label, vehicle, note: t('queue.note.needsLook', { count: item.candidates?.length ?? 0 }) };
    case 'installing':
      return { label, vehicle };
    case 'done':
      return { label, vehicle, note: t('queue.note.installed') };
    case 'error':
      // Rows keep only the backend's message (no code): known ones read in the UI language.
      return { label, vehicle, note: item.error ? errorText({ message: item.error }, t) : t('queue.note.error') };
  }
}

const STEPS = ['extract', 'verify', 'done'] as const;

export interface StepsView {
  /** Finished steps, each drawn with a check. */
  done: string[];
  /** Current step with its percentage (amber). */
  now: string;
  next: string[];
}

/** Mono steps under the progress bar, as on the Explore card: "Extract ✓ · Verifying 80% · Done". */
export function stepsView(step: InstallStep, pct: number, t: TFunction): StepsView {
  // Archives have no download step; it reads as extraction.
  const index = step === 'verify' ? 1 : step === 'done' ? 2 : 0;
  const pctText = Math.round(Math.max(0, Math.min(100, pct)));
  const now =
    index === 0
      ? t('queue.progress.extracting', { pct: pctText })
      : index === 1
        ? t('queue.progress.verifying', { pct: pctText })
        : t('queue.progress.done');
  return {
    done: STEPS.slice(0, index).map((s) => t(`queue.progress.${s}`)),
    now,
    next: STEPS.slice(index + 1).map((s) => t(`queue.progress.${s}`)),
  };
}

/** Header meta: "{n} archives · {ready} ready". */
export function headerMeta(items: readonly QueueItem[], t: TFunction): string {
  const ready = items.filter((i) => i.status === 'ready').length;
  return `${t('queue.meta.items', { count: items.length })} · ${t('queue.meta.ready', { count: ready })}`;
}
