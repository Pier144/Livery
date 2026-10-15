import type { QueryClient } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '@/queries/settings';
import { renderWithProviders } from '@/test/render';
import type { Language } from '@/types';
import { firstRunLanguage, useLanguageSync } from './useLanguageSync';

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
  it('switches i18next and <html lang> when the setting changes', async () => {
    const { client } = renderWithProviders(<Probe />, { settings: { language: 'it' } });
    expect(i18n.language).toBe('it');
    expect(document.documentElement.lang).toBe('it');
    expect(i18n.t('common.nav.hangar')).toBe('Il mio hangar');

    await setLanguageSetting(client, 'en');
    expect(i18n.language).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('shows every language in itself, numbers included', async () => {
    const { client } = renderWithProviders(<Probe />, { settings: { language: 'en' } });
    for (const language of ['de', 'ru', 'fr', 'es', 'pl', 'pt-BR', 'zh-CN'] as const) {
      await setLanguageSetting(client, language);
      expect(document.documentElement.lang).toBe(language);
      expect(i18n.language).toBe(language);
      expect(i18n.t('common.nav.hangar')).not.toBe('My Hangar');
      // Numbers use the language's own format (2.318 in German, 2 318 in Russian…).
      const grouped = new Intl.NumberFormat(language).format(2318);
      expect(i18n.t('common.status.hangar', { count: 2318, size: '3.8 GB' })).toContain(grouped);
    }
  });
});

describe('firstRunLanguage', () => {
  const fresh = { ...DEFAULT_SETTINGS };

  it('takes the Windows display language on a fresh install', () => {
    expect(firstRunLanguage(fresh, ['it-IT', 'en-US'], false)).toBe('it');
    expect(firstRunLanguage(fresh, ['pt-BR'], false)).toBe('pt-BR');
    expect(firstRunLanguage(fresh, ['zh-Hans-CN'], false)).toBe('zh-CN');
  });

  it('runs only once per install', () => {
    expect(firstRunLanguage(fresh, ['de-DE'], true)).toBeNull();
  });

  it('changes nothing for English, unknown languages or settings already made', () => {
    expect(firstRunLanguage(fresh, ['en-GB'], false)).toBeNull();
    expect(firstRunLanguage(fresh, ['ja-JP'], false)).toBeNull();
    expect(firstRunLanguage(fresh, [], false)).toBeNull();
    expect(firstRunLanguage({ ...fresh, onboarded: true }, ['de-DE'], false)).toBeNull();
    expect(firstRunLanguage({ ...fresh, gamePath: 'D:\WT' }, ['de-DE'], false)).toBeNull();
    expect(firstRunLanguage({ ...fresh, language: 'fr' }, ['de-DE'], false)).toBeNull();
  });
});
