import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Language } from '@/types';
import de from './de.json';
import en from './en.json';
import fr from './fr.json';
import it from './it.json';
import ru from './ru.json';

type Dict = { [key: string]: string | Dict };

/**
 * i18next picks `key_<category>` by the language's CLDR plural rules and, when that form is missing,
 * shows the English text instead. it.json carries only English's `_one`/`_other` (see
 * scripts/i18n-check.mjs), but Italian also has `many` (exact millions: "1.000.000 di …"): a missing
 * form is filled here from the same language's `_other`. de/ru/fr files carry every form already.
 */
export function withPluralForms(lng: string, dict: Dict): Dict {
  const categories = new Intl.PluralRules(lng).resolvedOptions().pluralCategories;
  const out: Dict = {};
  for (const [key, value] of Object.entries(dict)) {
    out[key] = typeof value === 'string' ? value : withPluralForms(lng, value);
  }
  for (const [key, value] of Object.entries(dict)) {
    if (typeof value !== 'string' || !key.endsWith('_other')) continue;
    const base = key.slice(0, -'_other'.length);
    for (const category of categories) out[`${base}_${category}`] ??= value;
  }
  return out;
}

export const resources = {
  en: { translation: en },
  it: { translation: withPluralForms('it', it) },
  de: { translation: withPluralForms('de', de) },
  ru: { translation: withPluralForms('ru', ru) },
  fr: { translation: withPluralForms('fr', fr) },
} as const;

/**
 * Languages with a full translation. de/ru/fr have every key (English texts, kept in sync by
 * `pnpm i18n:sync`) but show English until they are translated and listed here.
 */
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
