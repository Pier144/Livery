import { useEffect } from 'react';
import { setLanguage, translated } from '@/i18n';
import { useSettings } from '@/queries/settings';
import type { Language } from '@/types';

/**
 * The language the UI actually shows for a setting: languages without a translation yet
 * (de/ru/fr) show English, so i18next (numbers, plurals) and `<html lang>` say `en` for them.
 */
export function shownLanguage(language: Language): Language {
  return translated.includes(language) ? language : 'en';
}

/** Applies `settings.language` to i18next and `<html lang>`. */
export function useLanguageSync() {
  const { data } = useSettings();
  const language = data?.language;
  useEffect(() => {
    if (language) setLanguage(shownLanguage(language));
  }, [language]);
}
