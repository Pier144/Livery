import { useEffect } from 'react';
import { detectLanguage, setLanguage } from '@/i18n';
import { useSettings } from '@/queries/settings';
import type { Language, Settings } from '@/types';

/** Applies `settings.language` to i18next (texts, plurals, number formats) and `<html lang>`. */
export function useLanguageSync() {
  const { data } = useSettings();
  const language = data?.language;
  useEffect(() => {
    if (language) setLanguage(language);
  }, [language]);
}

/**
 * The language to save when the app opens on First run: the Windows display language
 * (`navigator.languages` in WebView2) when Livery has it and the settings still hold the default
 * English. Null when there is nothing to change. Upgraded installs never get here (`onboarded`).
 */
export function firstRunLanguage(settings: Settings, preferred: readonly string[] = systemLanguages()): Language | null {
  if (settings.onboarded || settings.gamePath || settings.language !== 'en') return null;
  const detected = detectLanguage(preferred);
  return detected === 'en' ? null : detected;
}

function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}
