import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { errorText } from '@/lib/errors';
import { isTauri, toAppError } from '@/lib/tauri';
import { useWatchFolder } from '@/queries/queue';
import { useSettings } from '@/queries/settings';
import { toast } from '@/store/toasts';
import { TEXT_LINK } from './controls';

/**
 * "Watch Downloads folder" card: the switch starts/stops the watcher (`watch_folder`, whose reply is the
 * new settings); "Show folder" reveals the watched path (hidden by default); "Change" picks another folder
 * and turns watching on.
 */
export function WatchCard() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { mutateAsync: watchFolder } = useWatchFolder();
  const titleId = useId();
  const helperId = useId();
  const pathId = useId();
  const [showFolder, setShowFolder] = useState(false);
  // The switch flips at once; the backend's settings take over when it answers (newest request wins).
  const [pending, setPending] = useState<boolean | null>(null);
  const token = useRef(0);

  const enabled = pending ?? settings?.autoInstall ?? false;
  const folder = settings?.watchFolder || t('queue.watch.defaultFolder');

  const toggle = async (next: boolean) => {
    const mine = ++token.current;
    setPending(next);
    try {
      await watchFolder({ enabled: next });
    } catch (e) {
      toast(errorText(toAppError(e), t));
    } finally {
      if (token.current === mine) setPending(null);
    }
  };

  const change = async () => {
    if (!isTauri()) return;
    let path: string | null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, title: t('queue.watch.pickTitle'), defaultPath: settings?.watchFolder });
      path = typeof picked === 'string' ? picked : null;
    } catch (e) {
      toast(errorText(toAppError(e), t));
      return;
    }
    if (!path) return;
    const mine = ++token.current;
    setPending(true);
    try {
      await watchFolder({ path, enabled: true });
    } catch (e) {
      toast(errorText(toAppError(e), t));
    } finally {
      if (token.current === mine) setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-line-2 bg-bg-3 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span id={titleId} className="text-body font-medium leading-[normal] text-ink-1">
            {t('queue.watch.title')}
          </span>
          <span id={helperId} className="text-[11px] leading-[1.4] text-ink-3">
            {t('queue.watch.helper')}
          </span>
        </div>
        <Switch checked={enabled} onChange={(next) => void toggle(next)} aria-labelledby={titleId} aria-describedby={helperId} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setShowFolder((v) => !v)}
          aria-expanded={showFolder}
          aria-controls={pathId}
          className={`self-start ${TEXT_LINK}`}
        >
          {showFolder ? t('queue.watch.hideFolder') : t('queue.watch.showFolder')}
        </button>
        <Button variant="secondary" size={26} onClick={() => void change()} aria-describedby={titleId}>
          {t('queue.watch.change')}
        </Button>
      </div>
      {/* Paths are hidden by default everywhere. */}
      <p id={pathId} hidden={!showFolder} data-selectable className="break-all font-mono text-mono-sm leading-[normal] text-ink-4">
        {folder}
      </p>
    </div>
  );
}
