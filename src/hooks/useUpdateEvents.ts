import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { listenEvent } from '@/lib/events';
import { isTauri } from '@/lib/tauri';
import { toast } from '@/store/toasts';
import { useUpdate } from '@/store/update';
import type { UpdateProgress, UpdateReady } from '@/types';

/** Feeds Settings → Updates from the backend and says when a background download is ready. */
export function useUpdateEvents() {
  const { t } = useTranslation();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void)[] = [];
    void Promise.all([
      listenEvent<UpdateProgress>('update://progress', (p) => useUpdate.getState().progress(p)),
      listenEvent<UpdateReady>('update://ready', ({ version }) => {
        useUpdate.getState().ready(version);
        toast(t('settings.updates.readyToast', { version }));
      }),
    ])
      .then((fns) => {
        if (disposed) fns.forEach((fn) => fn());
        else unlisten = fns;
      })
      .catch((e: unknown) => console.error('[livery] update listeners failed', e));
    return () => {
      disposed = true;
      unlisten.forEach((fn) => fn());
    };
  }, [t]);
}

/** How long after launch Livery asks the update feed (the first screen comes first). */
export const LAUNCH_CHECK_DELAY_MS = 3000;

/** Asks the update feed once, shortly after launch; a newer version opens UpdateDialog. */
export function useLaunchUpdateCheck() {
  useEffect(() => {
    if (!isTauri()) return;
    const timer = setTimeout(() => void useUpdate.getState().checkAtLaunch(), LAUNCH_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}
