import { afterEach, describe, expect, it } from 'vitest';
import i18n, { LANGUAGES, detectLanguage, resources, withPluralForms } from '@/i18n';
import {
  checkAll,
  checkLanguage,
  flatten,
  layout,
  serialize,
  syncLanguage,
  TARGETS,
  unflatten,
  type Entry,
} from '../../scripts/i18n-check.mjs';
import en from './en.json';
import itJson from './it.json';
import pl from './pl.json';
import ru from './ru.json';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('i18n files', () => {
  // The same checks as `pnpm i18n:check`. After adding keys to en.json, run `pnpm i18n:sync`.
  it('every language is consistent with en.json (pnpm i18n:check)', () => {
    expect(checkAll()).toEqual({});
  });

  it('no English or Italian text is empty', () => {
    expect(flatten(en).filter(([, s]) => !s.trim())).toEqual([]);
    expect(flatten(itJson).filter(([, s]) => !s.trim())).toEqual([]);
  });

  it('every language is wired, and the check covers the same ones', () => {
    expect(Object.keys(resources).sort()).toEqual([...LANGUAGES].sort());
    expect(['en', ...TARGETS].sort()).toEqual([...LANGUAGES].sort());
  });
});

describe('i18n runtime', () => {
  it('t() resolves in EN and IT', async () => {
    expect(i18n.t('common.nav.hangar')).toBe('My Hangar');
    await i18n.changeLanguage('it');
    expect(i18n.t('common.nav.hangar')).toBe('Il mio hangar');
  });

  it('Russian and Polish pick their own plural forms', async () => {
    const badge = (text: string, n: number) => text.replace('{{count}}', String(n));
    await i18n.changeLanguage('ru');
    const ruBadge = ru.common.nav;
    expect(i18n.t('common.nav.queueBadge', { count: 1 })).toBe(badge(ruBadge.queueBadge_one, 1));
    expect(i18n.t('common.nav.queueBadge', { count: 21 })).toBe(badge(ruBadge.queueBadge_one, 21));
    expect(i18n.t('common.nav.queueBadge', { count: 3 })).toBe(badge(ruBadge.queueBadge_few, 3));
    expect(i18n.t('common.nav.queueBadge', { count: 5 })).toBe(badge(ruBadge.queueBadge_many, 5));
    await i18n.changeLanguage('pl');
    const plBadge = pl.common.nav;
    expect(i18n.t('common.nav.queueBadge', { count: 1 })).toBe(badge(plBadge.queueBadge_one, 1));
    expect(i18n.t('common.nav.queueBadge', { count: 22 })).toBe(badge(plBadge.queueBadge_few, 22));
    expect(i18n.t('common.nav.queueBadge', { count: 21 })).toBe(badge(plBadge.queueBadge_many, 21));
  });

  it('no text in any language has an em dash', () => {
    for (const lng of LANGUAGES) {
      const texts = flatten(resources[lng].translation as object).map(([, v]) => v);
      expect(texts.filter((v) => v.includes('\u2014')), lng).toEqual([]);
    }
  });

  it('Italian exact millions (CLDR "many") use the Italian plural, not English', async () => {
    await i18n.changeLanguage('it');
    expect(i18n.t('queue.meta.items', { count: 1_000_000 })).toBe('1000000 archivi');
  });

  it('formats counts in interpolations', () => {
    expect(i18n.t('common.status.hangar', { count: 2318, size: '3.8 GB' })).toBe('Hangar 2,318 · 3.8 GB');
    expect(i18n.t('common.nav.queueBadge', { count: 1 })).toBe('1 archive waiting');
    expect(i18n.t('common.nav.queueBadge', { count: 3 })).toBe('3 archives waiting');
  });
});

describe('detectLanguage', () => {
  it('matches exactly, then by base language, else English', () => {
    expect(detectLanguage(['it-IT'])).toBe('it');
    expect(detectLanguage(['de-AT', 'en-US'])).toBe('de');
    expect(detectLanguage(['es-419'])).toBe('es');
    expect(detectLanguage(['pt-PT'])).toBe('pt-BR');
    expect(detectLanguage(['PT-br'])).toBe('pt-BR');
    expect(detectLanguage(['zh-CN'])).toBe('zh-CN');
    expect(detectLanguage(['zh-SG'])).toBe('zh-CN');
    expect(detectLanguage(['zh'])).toBe('zh-CN');
    expect(detectLanguage(['zh-TW', 'ja-JP'])).toBe('en');
    expect(detectLanguage(['zh-Hant-HK', 'fr-CA'])).toBe('fr');
    expect(detectLanguage(['uk-UA'])).toBe('en');
    expect(detectLanguage([])).toBe('en');
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

  it('expands plural groups to each language’s own forms, in place and in CLDR order', () => {
    expect(layout(EN, 'ru').map((s) => s.key)).toEqual([
      'a.title',
      'a.items_one',
      'a.items_few',
      'a.items_many',
      'a.items_other',
      'a.body',
    ]);
    expect(layout(EN, 'de').map((s) => s.key)).toEqual(EN.map(([k]) => k));
    expect(layout(EN, 'zh-CN').map((s) => s.key)).toEqual(['a.title', 'a.items_other', 'a.body']);
    // A form English doesn't have is checked against English's `_other`.
    expect(layout(EN, 'it').find((s) => s.key === 'a.items_many')).toMatchObject({ source: 'a.items_other' });
  });

  it('sync keeps texts, drops stale keys, follows en order, fills plural forms from the same language', () => {
    const ru: Entry[] = [
      ['a.body', 'Смотри <b>это</b>'],
      ['old', 'gone'],
      ['a.items_other', '{{count}} элемента'],
      ['a.title', 'Заголовок {{name}}'],
    ];
    const { entries, filled, removed, missing } = syncLanguage(EN, ru, 'ru');
    expect(entries).toEqual([
      ['a.title', 'Заголовок {{name}}'],
      ['a.items_one', '{{count}} элемента'],
      ['a.items_few', '{{count}} элемента'],
      ['a.items_many', '{{count}} элемента'],
      ['a.items_other', '{{count}} элемента'],
      ['a.body', 'Смотри <b>это</b>'],
    ]);
    expect(filled).toEqual(['a.items_one', 'a.items_few', 'a.items_many']);
    expect(removed).toEqual(['old']);
    expect(missing).toEqual([]);
  });

  it('sync never invents text: missing keys are reported, not added', () => {
    const it: Entry[] = [
      ['a.items_one', '{{count}} elemento'],
      ['a.title', 'Titolo {{name}}'],
      ['a.items_few', 'stale form'],
    ];
    const { entries, filled, removed, missing } = syncLanguage(EN, it, 'it');
    expect(entries).toEqual([
      ['a.title', 'Titolo {{name}}'],
      ['a.items_one', '{{count}} elemento'],
    ]);
    expect(filled).toEqual([]);
    expect(missing).toEqual(['a.items_many', 'a.items_other', 'a.body']);
    expect(removed).toEqual(['a.items_few']);
  });

  it('check lists missing and extra keys, empty texts, em dashes and placeholder or tag differences', () => {
    const de: Entry[] = [
      ['a.title', 'Titel {{nome}}'],
      ['a.items_one', ' '],
      ['a.items_other', '{{count}} Dinge \u2014 viele'],
      ['extra', 'x'],
    ];
    expect(checkLanguage(EN, de, 'de')).toEqual([
      'missing key a.body',
      'extra key extra (not in en.json)',
      'placeholders differ for a.title: en has [name], de has [nome]',
      'empty text for a.items_one',
      'em dash in a.items_other',
    ]);
    expect(checkLanguage(EN, [...EN.slice(0, 3), ['a.body', 'Siehe <i>das</i>']], 'de')).toEqual([
      'tags differ for a.body: en has [</b>, <b>], de has [</i>, <i>]',
    ]);
  });

  it('check wants the keys in en.json’s order', () => {
    const ru = layout(EN, 'ru').map((s): Entry => [s.key, s.key.includes('items') ? '{{count}} x' : EN.find(([k]) => k === s.key)![1]]);
    expect(checkLanguage(EN, ru, 'ru')).toEqual([]);
    expect(checkLanguage(EN, [...ru].reverse(), 'ru')).toEqual(['keys are not in en.json’s order']);
    expect(checkLanguage(EN, ru.slice(1), 'ru')).toEqual(['missing key a.title']);
  });

  it('writes files the way they are stored (nested, 2 spaces, final newline)', () => {
    expect(serialize(unflatten(flatten(en)))).toBe(`${JSON.stringify(en, null, 2)}\n`);
  });
});
