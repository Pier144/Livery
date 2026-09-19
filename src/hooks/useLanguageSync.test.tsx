import type { QueryClient } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '@/queries/settings';
import { renderWithProviders } from '@/test/render';
import type { Language } from '@/types';
import { shownLanguage, useLanguageSync } from './useLanguageSync';

function Probe() {
  useLanguageSync();
  return null;
}

/** Seeds a new language and lets the query observers (notified on a timeout) re-render. */
async function setLanguageSetting(client: QueryClient, language: Language) {
  await act(async () => {
    client.setQueryData(SETTINGS_KEY, { ...DEFAULT_SETTINGS, language });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  await i18n.changeLanguage('en');
  document.documentElement.lang = 'en';
});

describe('useLanguageSync', () => {
  it('maps untranslated languages to English', () => {
    expect((['en', 'it', 'de', 'ru', 'fr'] as Language[]).map(shownLanguage)).toEqual(['en', 'it', 'en', 'en', 'en']);
  });

  it('switches i18next and <html lang> when the setting changes', async () => {
    const { client } = renderWithProviders(<Probe />, { settings: { language: 'it' } });
    expect(i18n.language).toBe('it');
    expect(document.documentElement.lang).toBe('it');
    expect(i18n.t('common.nav.hangar')).toBe('Il mio hangar');

    await setLanguageSetting(client, 'en');
    expect(i18n.language).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('names English on <html> while Deutsch, Русский and Français fall back to it', async () => {
    const { client } = renderWithProviders(<Probe />, { settings: { language: 'it' } });
    for (const language of ['de', 'ru', 'fr'] as const) {
      await setLanguageSetting(client, 'it');
      expect(document.documentElement.lang).toBe('it');
      await setLanguageSetting(client, language);
      expect(document.documentElement.lang).toBe('en');
      expect(i18n.language).toBe('en');
      expect(i18n.t('common.nav.hangar')).toBe('My Hangar');
      // Numbers follow the text shown, not the German/Russian/French locale.
      expect(i18n.t('common.status.online', { count: 2318 })).toBe('WT Live online · 2,318 skins');
    }
  });
});
