import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import en from './en.json';
import itJson from './it.json';

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('i18n', () => {
  it('Italian has exactly the English keys', () => {
    expect(keys(itJson).sort()).toEqual(keys(en).sort());
  });

  it('no translation is empty', () => {
    const flat = (o: object): string[] => Object.values(o).flatMap((v) => (typeof v === 'object' ? flat(v as object) : [v as string]));
    expect(flat(en).filter((s) => !s.trim())).toEqual([]);
    expect(flat(itJson).filter((s) => !s.trim())).toEqual([]);
  });

  it('t() resolves in EN and IT', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('common.nav.hangar')).toBe('My Hangar');
    await i18n.changeLanguage('it');
    expect(i18n.t('common.nav.hangar')).toBe('Il mio hangar');
    await i18n.changeLanguage('en');
  });

  it('falls back to English for untranslated languages', async () => {
    await i18n.changeLanguage('de');
    expect(i18n.t('common.nav.explore')).toBe('Explore');
    await i18n.changeLanguage('en');
  });

  it('formats counts in interpolations', () => {
    expect(i18n.t('common.status.online', { count: 2318 })).toBe('WT Live online · 2,318 skins');
    expect(i18n.t('common.drop.added', { count: 1 })).toBe('Added 1 archive to the install queue');
    expect(i18n.t('common.drop.added', { count: 3 })).toBe('Added 3 archives to the install queue');
  });
});
