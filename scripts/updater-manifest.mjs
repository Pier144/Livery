// Writes the update feed (`latest.json`) that Livery's updater reads from the latest published
// GitHub release (tauri.conf.json → plugins.updater.endpoints). See docs/release.md, "Updates".
//
//   node scripts/updater-manifest.mjs <installer.exe> <out.json> [repo] [notes]
//
// The installer's `.sig` (written by `tauri build` with TAURI_SIGNING_PRIVATE_KEY) must sit next
// to it. The version comes from tauri.conf.json; the download URL is the release asset.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const [installer, out, repo = 'Pier144/Livery', notes] = process.argv.slice(2);
if (!installer || !out) {
  console.error('usage: node scripts/updater-manifest.mjs <installer.exe> <out.json> [repo] [notes]');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const name = basename(installer);
if (!name.includes(`_${version}_`)) {
  console.error(`${name} isn't the installer of ${version} (tauri.conf.json).`);
  process.exit(1);
}
const signature = readFileSync(`${installer}.sig`, 'utf8').trim();
if (!signature) {
  console.error(`${name}.sig is empty.`);
  process.exit(1);
}

const tag = `v${version}`;
const manifest = {
  version,
  notes: notes || `See https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
    },
  },
};
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${out}: Livery ${version} → ${manifest.platforms['windows-x86_64'].url}`);
