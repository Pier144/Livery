// i18n consistency between src/i18n/en.json (the source) and the other languages.
//
//   pnpm i18n:check   exits 1 with a readable list when something is off
//   pnpm i18n:sync    fixes what can be fixed without a translator (scripts/i18n-sync.mjs)
//
// Rules:
// - it.json is translated by hand: it must have exactly en.json's keys. It may also carry the extra
//   plural forms Italian has (`_many`); src/i18n/index.ts fills a missing one from `_other`.
// - de/ru/fr are generated, translation-ready copies: en.json's keys in en.json's order, with every
//   plural form their language uses (ru: _one/_few/_many/_other). New keys get the English text.
// - A key's {{placeholders}} and <tags> must be the ones en.json uses for it; no text may be empty.
//
// This module is also imported by src/i18n/i18n.test.ts (the same checks run under `pnpm test`)
// and by scripts/i18n-sync.mjs. It has no dependencies.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Not `new URL(…, import.meta.url)`: Vite (Vitest) rewrites that pattern into an asset URL.
export const I18N_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/i18n');

/** Translated by hand. */
export const HAND_TRANSLATED = ['it'];
/** English copies until someone translates them (keys present, English fallback). */
export const GENERATED = ['de', 'ru', 'fr'];
export const TARGETS = [...HAND_TRANSLATED, ...GENERATED];

/** CLDR order, used inside a plural group. */
const CATEGORY_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLURAL_KEY = /^(.*)_(zero|one|two|few|many|other)$/;

/** Nested JSON → ordered `[dotted key, text]` pairs. */
export function flatten(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]],
  );
}

/** Ordered `[dotted key, text]` pairs → nested JSON (insertion order kept). */
export function unflatten(entries) {
  const root = {};
  for (const [key, value] of entries) {
    const parts = key.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = value;
  }
  return root;
}

/** What the file looks like on disk: 2-space JSON and a final newline. */
export const serialize = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

/** Plural categories i18next looks up for a language (`Intl.PluralRules`, like i18next itself). */
export function pluralCategories(lng) {
  return new Intl.PluralRules(lng).resolvedOptions().pluralCategories;
}

const byCategory = (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b);

/** English plural groups: base key → categories en.json has (a group is any base with `_other`). */
export function pluralGroups(enEntries) {
  const keys = new Set(enEntries.map(([k]) => k));
  const groups = new Map();
  for (const [key] of enEntries) {
    const m = key.match(PLURAL_KEY);
    if (m && keys.has(`${m[1]}_other`)) groups.set(m[1], [...(groups.get(m[1]) ?? []), m[2]]);
  }
  return groups;
}

/** `{ base, category }` when `key` is a plural form of an English plural group. */
function pluralOf(key, groups) {
  const m = key.match(PLURAL_KEY);
  return m && groups.has(m[1]) ? { base: m[1], category: m[2] } : null;
}

/**
 * The keys a language's file should have, in file order: en.json's order, with each plural group
 * expanded in place. `required` must be there; the others may be (it.json's extra plural forms).
 * `source` is the English text a new key starts from and the one its placeholders are checked against.
 */
export function layout(enEntries, lng) {
  const groups = pluralGroups(enEntries);
  const generated = GENERATED.includes(lng);
  const own = pluralCategories(lng);
  const slots = [];
  const done = new Set();
  for (const [key] of enEntries) {
    const plural = pluralOf(key, groups);
    if (!plural) {
      slots.push({ key, required: true, source: key });
      continue;
    }
    if (done.has(plural.base)) continue;
    done.add(plural.base);
    const english = groups.get(plural.base);
    for (const category of [...new Set([...english, ...own])].sort(byCategory)) {
      const inEnglish = english.includes(category);
      slots.push({
        key: `${plural.base}_${category}`,
        // Generated files carry every form; the hand-translated one must have English's forms.
        required: inEnglish || generated,
        source: inEnglish ? `${plural.base}_${category}` : `${plural.base}_other`,
      });
    }
  }
  return slots;
}

/**
 * The synced version of one language: keys follow en.json, existing texts are kept, keys en.json no
 * longer has are removed. Missing generated keys get the English text; missing Italian ones are only
 * reported (no invented Italian).
 */
export function syncLanguage(enEntries, targetEntries, lng) {
  const en = new Map(enEntries);
  const target = new Map(targetEntries);
  const generated = GENERATED.includes(lng);
  const slots = layout(enEntries, lng);
  const entries = [];
  const added = [];
  const missing = [];
  for (const slot of slots) {
    if (target.has(slot.key)) {
      entries.push([slot.key, target.get(slot.key)]);
    } else if (slot.required && generated) {
      entries.push([slot.key, en.get(slot.source)]);
      added.push(slot.key);
    } else if (slot.required) {
      missing.push(slot.key);
    }
  }
  const allowed = new Set(slots.map((s) => s.key));
  const removed = targetEntries.map(([k]) => k).filter((k) => !allowed.has(k));
  return { entries, added, missing, removed };
}

const PLACEHOLDER = /\{\{\s*([^\s,}]+)[^}]*\}\}/g;
const TAG = /<\/?[A-Za-z][\w-]*\s*\/?>/g;
const placeholders = (text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();
const tags = (text) => [...text.matchAll(TAG)].map((m) => m[0]).sort();
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Every problem between en.json and one language, as readable lines (empty = fine). */
export function checkLanguage(enEntries, targetEntries, lng) {
  const problems = [];
  const en = new Map(enEntries);
  const slots = layout(enEntries, lng);
  const bySlot = new Map(slots.map((s) => [s.key, s]));
  const generated = GENERATED.includes(lng);
  const { added, missing, removed } = syncLanguage(enEntries, targetEntries, lng);
  for (const key of generated ? added : missing) problems.push(`missing key ${key}`);
  for (const key of removed) problems.push(`extra key ${key} (not in en.json)`);
  if (generated && !added.length && !removed.length) {
    const want = slots.map((s) => s.key);
    if (!sameList(want, targetEntries.map(([k]) => k))) problems.push('keys are not in en.json’s order');
  }
  for (const [key, text] of targetEntries) {
    if (typeof text !== 'string' || !text.trim()) {
      problems.push(`empty text for ${key}`);
      continue;
    }
    const slot = bySlot.get(key);
    const source = slot ? en.get(slot.source) : undefined;
    if (typeof source !== 'string') continue;
    for (const [what, read] of [
      ['placeholders', placeholders],
      ['tags', tags],
    ]) {
      const want = read(source);
      const have = read(text);
      if (!sameList(want, have)) {
        problems.push(`${what} differ for ${key}: en has [${want.join(', ')}], ${lng} has [${have.join(', ')}]`);
      }
    }
  }
  return problems;
}

/** Problems in en.json itself. */
export function checkSource(enEntries) {
  return enEntries.filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => `empty text for ${k}`);
}

export function readLocale(lng, dir = I18N_DIR) {
  const file = resolve(dir, `${lng}.json`);
  const text = readFileSync(file, 'utf8');
  return { file, text, entries: flatten(JSON.parse(text)) };
}

/** All problems, by file name (no entry = fine). */
export function checkAll(dir = I18N_DIR) {
  const report = {};
  const en = readLocale('en', dir).entries;
  const source = checkSource(en);
  if (source.length) report['en.json'] = source;
  for (const lng of TARGETS) {
    let problems;
    try {
      problems = checkLanguage(en, readLocale(lng, dir).entries, lng);
    } catch (e) {
      problems = [`can’t be read: ${e instanceof Error ? e.message : String(e)}`];
    }
    if (problems.length) report[`${lng}.json`] = problems;
  }
  return report;
}

function main() {
  const report = checkAll();
  const files = Object.keys(report);
  if (!files.length) {
    console.log(`i18n: ${TARGETS.map((l) => `${l}.json`).join(', ')} match en.json.`);
    return;
  }
  for (const file of files) {
    console.error(`\n${file}`);
    for (const line of report[file]) console.error(`  - ${line}`);
  }
  const hints = [];
  if (files.some((f) => GENERATED.some((l) => f === `${l}.json`))) hints.push('Run `pnpm i18n:sync` to update de/ru/fr.');
  if (report['it.json']) hints.push('Italian texts are written by hand in src/i18n/it.json (`pnpm i18n:sync` only drops stale keys).');
  console.error(`\ni18n check failed. ${hints.join(' ')}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
