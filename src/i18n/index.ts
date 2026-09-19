import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Language } from '@/types';
import en from './en.json';
import it from './it.json';

export const resources = {
  en: { translation: en },
  it: { translation: it },
} as const;

/** Languages with a full translation; the rest (de/ru/fr, M6) fall back to English. */
export const translated: Language[] = ['en', 'it'];

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  initAsync: false,
});

export function setLanguage(lang: Language) {
  void i18n.changeLanguage(lang);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export default i18n;
