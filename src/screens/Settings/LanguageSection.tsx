import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { translated } from '@/i18n';
import type { Language } from '@/types';
import { RadioCards } from './RadioCards';
import { SectionTitle } from './SettingRow';
import { useSettingsPatch } from './useSettingsPatch';

const LANGUAGES: readonly Language[] = ['en', 'it', 'de', 'ru', 'fr'];

/**
 * Language: the UI switches as soon as the setting is saved (`useLanguageSync`). Only English and
 * Italian are translated; the others show English for now and say so.
 */
export function LanguageSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettingsPatch();
  const titleId = useId();
  return (
    <>
      <SectionTitle id={titleId}>{t('settings.nav.language')}</SectionTitle>
      <RadioCards
        labelledBy={titleId}
        value={settings.language}
        options={LANGUAGES.map((value) => ({
          value,
          // Each language is named in itself (endonym) and marked with its language.
          label: t(`settings.language.names.${value}`),
          lang: value,
          hint: translated.includes(value) ? undefined : t('settings.language.englishForNow'),
        }))}
        onChange={(language) => patch({ language })}
      />
    </>
  );
}
