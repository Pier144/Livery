import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '@/i18n';
import { RadioCards } from './RadioCards';
import { SectionTitle } from './SettingRow';
import { useSettingsPatch } from './useSettingsPatch';

/** Language: the UI switches as soon as the setting is saved (`useLanguageSync`). */
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
        }))}
        onChange={(language) => patch({ language })}
      />
    </>
  );
}
