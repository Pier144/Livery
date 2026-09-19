import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import en from '@/i18n/en.json';
import itJson from '@/i18n/it.json';
import { GENERIC_ERROR_CODES, GENERIC_MESSAGES, errorText } from './errors';

const t = i18n.t;

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('errorText', () => {
  it('shows the backend message as it is in English', () => {
    expect(errorText({ code: 'io', message: 'Could not delete the skin' }, t)).toBe('Could not delete the skin');
    expect(errorText({ code: 'io', message: 'Something new went wrong' }, t)).toBe('Something new went wrong');
    // Nothing to show: the generic text for the code.
    expect(errorText({ code: 'network', message: '  ' }, t)).toBe(en.common.errors.network);
  });

  it('shows English for languages without a translation yet (de/ru/fr)', async () => {
    await i18n.changeLanguage('de');
    expect(errorText({ code: 'invalidInput', message: 'No game folder set' }, t)).toBe('No game folder set');
    expect(errorText({ code: 'io', message: 'Unknown' }, t)).toBe('Unknown');
  });

  it('translates a message the backend is known to send', async () => {
    await i18n.changeLanguage('it');
    expect(errorText({ code: 'invalidInput', message: 'No game folder set' }, t)).toBe('Nessuna cartella del gioco impostata');
    expect(errorText({ code: 'unsupported', message: en.common.errors.backend.archivesUnsupported }, t)).toBe(
      itJson.common.errors.backend.archivesUnsupported,
    );
    // Surrounding spaces don't matter.
    expect(errorText({ code: 'notFound', message: ' The file or folder can\'t be found\n' }, t)).toBe(
      'Impossibile trovare il file o la cartella',
    );
  });

  it('falls back to a generic text for the code', async () => {
    await i18n.changeLanguage('it');
    expect(errorText({ code: 'io', message: 'Disk on fire' }, t)).toBe(itJson.common.errors.io);
    expect(errorText({ code: 'conflict', message: 'Clash' }, t)).toBe(itJson.common.errors.conflict);
    expect(errorText({ code: 'noBackend', message: 'x' }, t)).toBe(itJson.common.errors.noBackend);
  });

  it('reads an unknown code as internal', async () => {
    await i18n.changeLanguage('it');
    expect(errorText({ code: 'somethingNew', message: 'Unknown thing' }, t)).toBe(itJson.common.errors.internal);
    // A known message still wins over the code.
    expect(errorText({ code: 'somethingNew', message: 'Pick a vehicle first' }, t)).toBe('Prima scegli un veicolo');
  });

  it('without a code (queue rows), translates known messages and keeps the others as they are', async () => {
    await i18n.changeLanguage('it');
    expect(errorText({ message: "No .blk file inside, so the game can't use it" }, t)).toBe(
      itJson.common.errors.backend.noBlk,
    );
    // The store's own fallback is already localized.
    expect(errorText({ message: itJson.queue.note.error }, t)).toBe(itJson.queue.note.error);
    expect(errorText({ message: '' }, t)).toBe(itJson.common.errors.internal);
    // Backend messages left to the generic text read as the text for the code they come with.
    expect(errorText({ message: 'File system error' }, t)).toBe(itJson.common.errors.io);
    expect(errorText({ message: 'Background task failed' }, t)).toBe(itJson.common.errors.internal);
  });

  it('matches messages the backend builds with values', async () => {
    await i18n.changeLanguage('it');
    const unreadable =
      "Livery couldn't read following.json when it started, so it won't overwrite it. Close other programs using it and restart Livery.";
    expect(errorText({ code: 'io', message: unreadable }, t)).toBe(
      'Livery non è riuscito a leggere following.json all’avvio, quindi non lo sovrascriverà. Chiudi gli altri programmi che lo usano e riavvia Livery.',
    );
    expect(errorText({ message: '"add_to_queue" needs the desktop app' }, t)).toBe(itJson.common.errors.noBackend);
    expect(errorText({ code: 'noBackend', message: 'WT Live needs the desktop app' }, t)).toBe(itJson.common.errors.noBackend);
  });
});

// ── The table against the Rust sources ──────────────────────────────────────

// Not `new URL(…, import.meta.url)`: Vite rewrites that pattern into an asset URL.
const RUST_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src-tauri/src');

/**
 * Messages deliberately left to the generic text by code: vaguer than it, only a frontend bug
 * can show them, or they fail the launch before there is a window.
 */
const GENERIC_ON_PURPOSE: (string | RegExp)[] = [
  // `From<io::Error>` / `From<serde_json::Error>`: the generic io / notFound / parse text says more.
  'File system error',
  'Could not read JSON',
  // Internal guards.
  'Background task failed',
  "This library index can't be saved",
  // Contract checks on command arguments.
  'A collection needs an id',
  'Not an RFC 3339 time',
  'Pass exactly one of a skin id, a queue id or a WT Live id',
  'Pass the id of a WT Live skin',
  'Pass the id of the vehicle or author to follow',
  'Pass the name of the vehicle or author to follow',
  // Launch (src-tauri/src/startup.rs, lib.rs setup): no window yet.
  /^The (LIVERY_DATA_DIR|app data) folder can't be (created|found)$/,
];

function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return rustFiles(path);
    return path.endsWith('.rs') ? [path] : [];
  });
}

const LITERAL = String.raw`"(?:[^"\\]|\\[\s\S])*"`;

/** A Rust string literal's text (quotes, `\"`, `\\` and line continuations). */
function decode(literal: string): string {
  return literal
    .slice(1, -1)
    .replace(/\\\r?\n\s*/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\(["\\'])/g, '$1');
}

/** Code outside `#[cfg(test)]` modules (they sit at the end of each file). */
const sources = () => rustFiles(RUST_SRC).map((file) => ({ file, code: readFileSync(file, 'utf8').split('#[cfg(test)]')[0]! }));

/** Every literal message an `AppError` can carry, from `AppError::new(code, "…" | CONST | message)`. */
function backendMessages(): { messages: Set<string>; unresolved: string[] } {
  const consts = new Map<string, string>();
  const uses: { file: string; arg: string }[] = [];
  for (const { file, code } of sources()) {
    for (const m of code.matchAll(new RegExp(String.raw`const\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*(${LITERAL})`, 'g'))) {
      consts.set(m[1]!, decode(m[2]!));
    }
    for (const m of code.matchAll(new RegExp(String.raw`AppError::new\(\s*[\w:]+\s*,\s*(${LITERAL}|[A-Za-z_][\w:]*)`, 'g'))) {
      uses.push({ file, arg: m[1]! });
    }
    // `let message = "…"` / `if … { "…" } else { "…" }`, then `AppError::new(code, message)`.
    for (const m of code.matchAll(/let\s+message\s*=\s*([^;]*);/g)) {
      for (const lit of m[1]!.matchAll(new RegExp(LITERAL, 'g'))) uses.push({ file, arg: lit[0] });
    }
    for (const m of code.matchAll(new RegExp(String.raw`AppError\s*\{\s*message:\s*(${LITERAL})`, 'g'))) {
      uses.push({ file, arg: m[1]! });
    }
  }
  const messages = new Set<string>();
  const unresolved: string[] = [];
  for (const { file, arg } of uses) {
    if (arg.startsWith('"')) messages.add(decode(arg));
    else {
      const name = arg.split('::').pop()!;
      const value = consts.get(name);
      if (value !== undefined) messages.add(value);
      // A lowercase name is a variable or a function (`message` is read above; see the
      // `unreadable_at_launch_message` test for the one built with `format!`).
      else if (/^[A-Z]/.test(name)) unresolved.push(`${file}: ${arg}`);
    }
  }
  return { messages, unresolved };
}

describe('errorText table vs src-tauri/src', () => {
  const known = new Set(Object.values(en.common.errors.backend));
  const onPurpose = (m: string) => GENERIC_ON_PURPOSE.some((p) => (typeof p === 'string' ? p === m : p.test(m)));

  it('knows every message the backend sends (or leaves it to the code on purpose)', () => {
    const { messages, unresolved } = backendMessages();
    expect(unresolved).toEqual([]);
    expect(messages.size).toBeGreaterThan(40);
    const unknown = [...messages].filter((m) => !known.has(m) && !onPurpose(m));
    // Add each one to common.errors.backend in en.json (exact text) and it.json, or to GENERIC_ON_PURPOSE.
    expect(unknown).toEqual([]);
  });

  it('has no message the backend no longer sends', () => {
    const { messages } = backendMessages();
    expect([...known].filter((m) => !messages.has(m))).toEqual([]);
    expect([...GENERIC_MESSAGES.keys()].filter((m) => !messages.has(m) || !onPurpose(m))).toEqual([]);
  });

  it('matches the message error::unreadable_at_launch_message builds', async () => {
    const code = readFileSync(join(RUST_SRC, 'error.rs'), 'utf8');
    const fn = code.match(new RegExp(String.raw`fn unreadable_at_launch_message[\s\S]*?format!\(\s*(${LITERAL})`));
    expect(fn, 'unreadable_at_launch_message in src-tauri/src/error.rs').not.toBeNull();
    const message = decode(fn![1]!).replace('{file}', 'settings.json');
    await i18n.changeLanguage('it');
    expect(errorText({ code: 'io', message }, t)).toBe(
      i18n.t('common.errors.templates.unreadableAtLaunch', { file: 'settings.json' }),
    );
  });

  it('has a generic text for every backend error code', () => {
    const code = readFileSync(join(RUST_SRC, 'error.rs'), 'utf8');
    const variants = code.match(/pub enum ErrorCode \{([\s\S]*?)\}/)?.[1] ?? '';
    const codes = [...variants.matchAll(/^\s*([A-Z]\w*),/gm)].map((m) => m[1]![0]!.toLowerCase() + m[1]!.slice(1));
    expect(codes.length).toBeGreaterThan(5);
    expect(codes.filter((c) => !(GENERIC_ERROR_CODES as readonly string[]).includes(c))).toEqual([]);
  });
});
