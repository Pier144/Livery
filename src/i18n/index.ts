import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Language } from '@/types';
import de from './de.json';
import en from './en.json';
import es from './es.json';
import fr from './fr.json';
import it from './it.json';
import pl from './pl.json';
import ptBR from './pt-BR.json';
import ru from './ru.json';
import zhCN from './zh-CN.json';

type Dict = { [key: string]: string | Dict };

/**
 * i18next picks `key_<category>` by the language's CLDR plural rules and, when that form is missing,
 * shows the English text instead. Every language file carries all of its own forms (checked by
 * scripts/i18n-check.mjs); should one be missing anyway, it is filled here from the same language's
 * `_other`, never from English.
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
  es: { translation: withPluralForms('es', es) },
  pl: { translation: withPluralForms('pl', pl) },
  'pt-BR': { translation: withPluralForms('pt-BR', ptBR) },
  'zh-CN': { translation: withPluralForms('zh-CN', zhCN) },
} as const;

/** Every UI language, in the order Settings → Language lists them (scripts/i18n-check.mjs too). */
export const LANGUAGES: readonly Language[] = ['en', 'it', 'de', 'ru', 'fr', 'es', 'pl', 'pt-BR', 'zh-CN'];

/**
 * The UI language for the system's preferred languages (`navigator.languages`, which WebView2 takes
 * from the Windows display language), used once on the first launch. A tag matches exactly, then by
 * its base language: any Portuguese reads Brazilian Portuguese, Simplified Chinese (zh, zh-CN,
 * zh-SG, zh-Hans…) reads zh-CN, Traditional Chinese doesn't match. English when nothing matches.
 */
export function detectLanguage(preferred: readonly string[]): Language {
  for (const raw of preferred) {
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    const exact = LANGUAGES.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const [base, ...rest] = tag.split('-');
    if (base === 'zh') {
      const traditional = rest.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part));
      if (!traditional) return 'zh-CN';
      continue;
    }
    if (base === 'pt') return 'pt-BR';
    const byBase = LANGUAGES.find((l) => l === base);
    if (byBase) return byBase;
  }
  return 'en';
}

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
