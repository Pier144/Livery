import { afterEach, describe, expect, it } from 'vitest';
import i18n, { resources, translated, withPluralForms } from '@/i18n';
import {
  checkAll,
  checkLanguage,
  flatten,
  layout,
  serialize,
  syncLanguage,
  unflatten,
  type Entry,
} from '../../scripts/i18n-check.mjs';
import en from './en.json';
import itJson from './it.json';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('i18n files', () => {
  // The same checks as `pnpm i18n:check`. After adding keys to en.json, run `pnpm i18n:sync`.
  it('it/de/ru/fr are consistent with en.json (pnpm i18n:check)', () => {
    expect(checkAll()).toEqual({});
  });

  it('no English or Italian text is empty', () => {
    expect(flatten(en).filter(([, s]) => !s.trim())).toEqual([]);
    expect(flatten(itJson).filter(([, s]) => !s.trim())).toEqual([]);
  });

  it('de/ru/fr are wired but only en and it count as translated', () => {
    expect(Object.keys(resources).sort()).toEqual(['de', 'en', 'fr', 'it', 'ru']);
    expect(translated).toEqual(['en', 'it']);
  });
});

describe('i18n runtime', () => {
  it('t() resolves in EN and IT', async () => {
    expect(i18n.t('common.nav.hangar')).toBe('My Hangar');
    await i18n.changeLanguage('it');
    expect(i18n.t('common.nav.hangar')).toBe('Il mio hangar');
  });

  it('shows English for untranslated languages', async () => {
    await i18n.changeLanguage('de');
    expect(i18n.t('common.nav.explore')).toBe('Explore');
  });

  it('Russian plural forms exist and read in English for now', async () => {
    await i18n.changeLanguage('ru');
    expect(i18n.t('common.nav.queueBadge', { count: 1 })).toBe('1 archive waiting');
    expect(i18n.t('common.nav.queueBadge', { count: 3 })).toBe('3 archives waiting'); // few
    expect(i18n.t('common.nav.queueBadge', { count: 5 })).toBe('5 archives waiting'); // many
  });

  it('Italian exact millions (CLDR "many") use the Italian plural, not English', async () => {
    await i18n.changeLanguage('it');
    expect(i18n.t('queue.meta.items', { count: 1_000_000 })).toBe('1000000 archivi');
  });

  it('formats counts in interpolations', () => {
    expect(i18n.t('common.status.online', { count: 2318 })).toBe('WT Live online · 2,318 skins');
    expect(i18n.t('common.nav.queueBadge', { count: 1 })).toBe('1 archive waiting');
    expect(i18n.t('common.nav.queueBadge', { count: 3 })).toBe('3 archives waiting');
  });
});

describe('withPluralForms', () => {
  it('fills the language’s missing plural forms from _other, nested too, keeping existing ones', () => {
    const dict = { a_one: 'one', a_other: 'many things', n: { b_other: 'bs', b_many: 'di bs' }, c: 'plain' };
    expect(withPluralForms('ru', dict)).toEqual({
      a_one: 'one',
      a_other: 'many things',
      a_few: 'many things',
      a_many: 'many things',
      n: { b_other: 'bs', b_many: 'di bs', b_one: 'bs', b_few: 'bs' },
      c: 'plain',
    });
    expect(withPluralForms('en', dict)).toEqual({ ...dict, n: { ...dict.n, b_one: 'bs' } });
  });
});

describe('i18n-check / i18n-sync rules', () => {
  const EN: Entry[] = [
    ['a.title', 'Title {{name}}'],
    ['a.items_one', '{{count}} item'],
    ['a.items_other', '{{count}} items'],
    ['a.body', 'See <b>this</b>'],
  ];

  it('expands plural groups per language, in place and in CLDR order', () => {
    expect(layout(EN, 'ru').map((s) => s.key)).toEqual([
      'a.title',
      'a.items_one',
      'a.items_few',
      'a.items_many',
      'a.items_other',
      'a.body',
    ]);
    expect(layout(EN, 'de').map((s) => s.key)).toEqual(EN.map(([k]) => k));
    // Italian must have English's forms; its own `many` is allowed, not required.
    const it = layout(EN, 'it');
    expect(it.filter((s) => s.required).map((s) => s.key)).toEqual(EN.map(([k]) => k));
    expect(it.find((s) => s.key === 'a.items_many')).toMatchObject({ required: false, source: 'a.items_other' });
  });

  it('sync fills a generated language with English, keeps its texts, drops stale keys, follows en order', () => {
    const ru: Entry[] = [
      ['a.body', 'Смотри <b>это</b>'],
      ['old', 'gone'],
      ['a.title', 'Заголовок {{name}}'],
    ];
    const { entries, added, removed, missing } = syncLanguage(EN, ru, 'ru');
    expect(entries).toEqual([
      ['a.title', 'Заголовок {{name}}'],
      ['a.items_one', '{{count}} item'],
      ['a.items_few', '{{count}} items'],
      ['a.items_many', '{{count}} items'],
      ['a.items_other', '{{count}} items'],
      ['a.body', 'Смотри <b>это</b>'],
    ]);
    expect(added).toEqual(['a.items_one', 'a.items_few', 'a.items_many', 'a.items_other']);
    expect(removed).toEqual(['old']);
    expect(missing).toEqual([]);
  });

  it('sync never invents Italian: missing keys are reported, not added', () => {
    const it: Entry[] = [
      ['a.items_other', '{{count}} elementi'],
      ['a.items_many', '{{count}} di elementi'],
      ['a.title', 'Titolo {{name}}'],
      ['stale', 'x'],
    ];
    const { entries, added, removed, missing } = syncLanguage(EN, it, 'it');
    expect(entries).toEqual([
      ['a.title', 'Titolo {{name}}'],
      ['a.items_many', '{{count}} di elementi'],
      ['a.items_other', '{{count}} elementi'],
    ]);
    expect(added).toEqual([]);
    expect(missing).toEqual(['a.items_one', 'a.body']);
    expect(removed).toEqual(['stale']);
  });

  it('check lists missing and extra keys, empty texts and placeholder or tag differences', () => {
    const it: Entry[] = [
      ['a.title', 'Titolo {{nome}}'],
      ['a.items_one', ' '],
      ['a.items_other', '{{count}} elementi'],
      ['extra', 'x'],
    ];
    expect(checkLanguage(EN, it, 'it')).toEqual([
      'missing key a.body',
      'extra key extra (not in en.json)',
      'placeholders differ for a.title: en has [name], it has [nome]',
      'empty text for a.items_one',
    ]);
    expect(checkLanguage(EN, [...EN.slice(0, 3), ['a.body', 'Vedi <i>questo</i>']], 'it')).toEqual([
      'tags differ for a.body: en has [</b>, <b>], it has [</i>, <i>]',
    ]);
  });

  it('check wants generated files exactly as sync writes them, order included', () => {
    const synced = syncLanguage(EN, [], 'de').entries;
    expect(checkLanguage(EN, synced, 'de')).toEqual([]);
    expect(checkLanguage(EN, [...synced].reverse(), 'de')).toEqual(['keys are not in en.json’s order']);
    expect(checkLanguage(EN, synced.slice(1), 'de')).toEqual(['missing key a.title']);
  });

  it('writes files the way they are stored (nested, 2 spaces, final newline)', () => {
    expect(serialize(unflatten(flatten(en)))).toBe(`${JSON.stringify(en, null, 2)}\n`);
  });
});
