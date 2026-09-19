import 'i18next';
import type en from './en.json';

// Typed keys: `t('common.nav.explore')` is checked against en.json at compile time.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
