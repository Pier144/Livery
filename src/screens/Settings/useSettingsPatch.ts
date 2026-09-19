import { useTranslation } from 'react-i18next';
import { errorText } from '@/lib/errors';
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
  const patch = (changes: Partial<Settings>) => update.mutate(changes, { onError: (e) => toast(errorText(e, t)) });
  return { settings, patch };
}
