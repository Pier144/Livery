// Brings src/i18n/{it,de,ru,fr}.json in line with en.json (rules in scripts/i18n-check.mjs):
// - key order follows en.json and existing texts are kept;
// - keys en.json no longer has are removed;
// - de/ru/fr get missing keys with the English text, plural forms included (ru: _one/_few/_many/_other,
//   the new forms start from the English `_other`);
// - it.json never gets invented Italian: its missing keys are listed for a translator.
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
let missingItalian = [];

for (const lng of TARGETS) {
  const file = resolve(I18N_DIR, `${lng}.json`);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const current = before ? readLocale(lng).entries : [];
  const { entries, added, missing, removed } = syncLanguage(en, current, lng);
  const after = serialize(unflatten(entries));
  const notes = [];
  if (!before) notes.push('created');
  if (added.length) notes.push(`added ${added.length} (English): ${list(added)}`);
  if (removed.length) notes.push(`removed ${removed.length}: ${list(removed)}`);
  if (before && after !== before && !added.length && !removed.length) notes.push('reordered like en.json');
  if (missing.length) missingItalian = missing;
  if (after !== before && !dryRun) writeFileSync(file, after);
  console.log(`${lng}.json: ${notes.length ? notes.join('; ') : 'up to date'}${after !== before && dryRun ? ' (dry run, not written)' : ''}`);
}

if (missingItalian.length) {
  console.warn(`\nit.json misses ${missingItalian.length} key(s); write the Italian by hand:`);
  for (const key of missingItalian) console.warn(`  - ${key}`);
}
