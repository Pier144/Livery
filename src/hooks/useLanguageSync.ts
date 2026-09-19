import { useEffect } from 'react';
import { setLanguage } from '@/i18n';
import { useSettings } from '@/queries/settings';

/** Applies `settings.language` to i18next and `<html lang>`. */
export function useLanguageSync() {
  const { data } = useSettings();
  const language = data?.language;
  useEffect(() => {
    if (language) setLanguage(language);
  }, [language]);
}
