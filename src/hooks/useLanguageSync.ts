import { useLayoutEffect } from 'react';
import { detectLanguage, setLanguage } from '@/i18n';
import { useSettings } from '@/queries/settings';
import type { Language, Settings } from '@/types';

/**
 * Applies `settings.language` to i18next (texts, plurals, number formats) and `<html lang>`, before
 * paint, so a screen never shows a frame in the previous language.
 */
export function useLanguageSync() {
  const { data } = useSettings();
  const language = data?.language;
  useLayoutEffect(() => {
    if (language) setLanguage(language);
  }, [language]);
}

/** Set once the first-launch detection has run, so a language the user picks later always wins. */
const DETECTED_KEY = 'livery.languageDetected';

function detectedBefore(): boolean {
  try {
    return localStorage.getItem(DETECTED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Records that the first-launch detection ran (best effort: without storage it may run again). */
export function markLanguageDetected() {
  try {
    localStorage.setItem(DETECTED_KEY, '1');
  } catch {
    // Storage unavailable.
  }
}

/**
 * The language to save when the app opens on First run: the Windows display language
 * (`navigator.languages` in WebView2) when Livery has it and the settings still hold the default
 * English, the first time only. Null when there is nothing to change. Upgraded installs never get
 * here (`onboarded`).
 */
export function firstRunLanguage(
  settings: Settings,
  preferred: readonly string[] = systemLanguages(),
  ranBefore: boolean = detectedBefore(),
): Language | null {
  if (ranBefore || settings.onboarded || settings.gamePath || settings.language !== 'en') return null;
  const detected = detectLanguage(preferred);
  return detected === 'en' ? null : detected;
}

function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}
