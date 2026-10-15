import { useTranslation } from 'react-i18next';
import { errorText } from '@/lib/errors';
import { play } from '@/lib/motion';
import { DEFAULT_SETTINGS, useSettings, useUpdateSettings } from '@/queries/settings';
import { toast } from '@/store/toasts';
import type { Settings } from '@/types';

/**
 * Settings as the controls show them: the saved values with the change in flight on top, so a click
 * shows at once; the backend's answer replaces them (`useUpdateSettings` writes the query). A failed
 * save shows its message and the control falls back to the saved value.
 */
export function useSettingsPatch() {
  const { t } = useTranslation();
  const { data } = useSettings();
  const update = useUpdateSettings();
  const saved = data ?? DEFAULT_SETTINGS;
  const settings: Settings = update.isPending && update.variables ? { ...saved, ...update.variables } : saved;
  const patch = (changes: Partial<Settings>) => {
    // The row whose control made the change shows "Saved" for a moment once it is stored.
    const row = document.activeElement?.closest<HTMLElement>('[data-setting-row]');
    update.mutate(changes, { onError: (e) => toast(errorText(e, t)), onSuccess: () => flashSaved(row) });
  };
  return { settings, patch };
}

/** Fades a row's "Saved" in and out (1.6 s); nothing with motion reduced. */
function flashSaved(row: HTMLElement | null | undefined) {
  play(
    row?.querySelector('[data-saved]'),
    [
      { opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { opacity: 1, offset: 0.75 },
      { opacity: 0 },
    ],
    { duration: 1600, easing: 'ease' },
  );
}
