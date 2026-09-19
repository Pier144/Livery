import type { OpenDialogOptions } from '@tauri-apps/plugin-dialog';
import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, toAppError } from '@/lib/tauri';
import { toast } from '@/store/toasts';
import { TEXT_LINK } from './controls';
import { ARCHIVES_SUPPORTED, ARCHIVE_EXTENSIONS } from './queueModel';

interface DropZoneProps {
  /** Picked archives or folder (real paths). */
  onPaths: (paths: string[]) => void;
}

/** Native file/folder picker. Needs the desktop app: a no-op in the browser (no real paths there). */
async function pick(options: OpenDialogOptions): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open(options);
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch (e) {
    toast(toAppError(e).message);
    return [];
  }
}

/**
 * Dashed "Drop ZIP, RAR or 7z archives anywhere in the window" zone (the drop itself is window-wide, see
 * `useFileDrop`); clicking it browses for archives. "Choose a skin folder" picks a folder — the one kind of
 * source that installs while archive unpacking waits for its libraries (the mono note says so).
 */
export const DropZone = forwardRef<HTMLButtonElement, DropZoneProps>(function DropZone({ onPaths }, ref) {
  const { t } = useTranslation();

  const browse = async () => {
    const paths = await pick({
      multiple: true,
      title: t('queue.browseTitle'),
      filters: [{ name: t('queue.browseFilter'), extensions: ARCHIVE_EXTENSIONS }],
    });
    if (paths.length) onPaths(paths);
  };

  const chooseFolder = async () => {
    const paths = await pick({ directory: true, title: t('queue.chooseFolder') });
    if (paths.length) onPaths(paths);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <button
        ref={ref}
        type="button"
        onClick={() => void browse()}
        className="flex flex-col items-center gap-1 rounded-card border border-dashed border-line-4 bg-bg-input/60 p-4.5 text-center hover:border-amber motion-safe:transition-colors motion-safe:duration-120"
      >
        <span className="text-body font-medium leading-[normal] text-ink-1">{t('queue.dropZone')}</span>
        {/* ink-4, not the prototype's ink-5: 11px text needs 4.5:1. */}
        <span className="font-mono text-mono-sm leading-[normal] text-ink-4">{t('queue.browse')}</span>
      </button>
      <div className="flex items-baseline justify-between gap-4">
        {!ARCHIVES_SUPPORTED && <p className="font-mono text-mono-sm text-ink-4">{t('queue.foldersOnlyNote')}</p>}
        <button type="button" onClick={() => void chooseFolder()} className={`ml-auto flex-none ${TEXT_LINK}`}>
          {t('queue.chooseFolder')}
        </button>
      </div>
    </div>
  );
});
