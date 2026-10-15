import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { listenEvent } from '@/lib/events';
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
