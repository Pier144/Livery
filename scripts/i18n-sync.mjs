// Brings src/i18n/<lang>.json in line with en.json (rules in scripts/i18n-check.mjs):
// - key order follows en.json and existing texts are kept;
// - keys en.json no longer has, and plural forms the language doesn't use, are removed;
// - a missing plural form is filled from the same language's `_other` and listed for review;
// - no text is ever invented: other missing keys are listed for a translator.
// A file is written only when its content changes.
//
//   pnpm i18n:sync              write
//   pnpm i18n:sync --dry-run    only say what would change

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { I18N_DIR, TARGETS, readLocale, serialize, syncLanguage, unflatten } from './i18n-check.mjs';

const dryRun = process.argv.includes('--dry-run');
const en = readLocale('en').entries;
const list = (keys) => (keys.length > 6 ? `${keys.slice(0, 6).join(', ')} … (+${keys.length - 6})` : keys.join(', '));
const missingByLanguage = [];

for (const lng of TARGETS) {
  const file = resolve(I18N_DIR, `${lng}.json`);
  if (!existsSync(file)) {
    console.warn(`${lng}.json: missing, not created (write it by hand from en.json)`);
    continue;
  }
  const before = readFileSync(file, 'utf8');
  const { entries, filled, missing, removed } = syncLanguage(en, readLocale(lng).entries, lng);
  const after = serialize(unflatten(entries));
  const notes = [];
  if (filled.length) notes.push(`filled ${filled.length} plural form(s) from _other, review them: ${list(filled)}`);
  if (removed.length) notes.push(`removed ${removed.length}: ${list(removed)}`);
  if (after !== before && !filled.length && !removed.length) notes.push('reordered like en.json');
  if (missing.length) missingByLanguage.push([lng, missing]);
  if (after !== before && !dryRun) writeFileSync(file, after);
  console.log(`${lng}.json: ${notes.length ? notes.join('; ') : 'up to date'}${after !== before && dryRun ? ' (dry run, not written)' : ''}`);
}

for (const [lng, missing] of missingByLanguage) {
  console.warn(`\n${lng}.json misses ${missing.length} key(s); translate them by hand:`);
  for (const key of missing) console.warn(`  - ${key}`);
}
