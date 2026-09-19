import type { TFunction } from 'i18next';
import i18n, { translated } from '@/i18n';
import en from '@/i18n/en.json';
import type { AppError, Language } from '@/types';

/** Codes with a generic text under `common.errors.<code>`. Any other code reads as `internal`. */
export const GENERIC_ERROR_CODES = [
  'io',
  'notFound',
  'parse',
  'invalidInput',
  'conflict',
  'unsupported',
  'network',
  'noBackend',
  'internal',
] as const;
type GenericCode = (typeof GENERIC_ERROR_CODES)[number];

type BackendKey = keyof typeof en.common.errors.backend;

/**
 * The backend's messages Livery knows, exactly as the Rust code writes them: the English texts under
 * `common.errors.backend` in en.json ARE that table (message → key). `src/lib/errors.test.ts` reads
 * `src-tauri/src` and fails when a message there is neither in it nor deliberately left to the
 * generic text by code.
 */
const KNOWN = new Map<string, BackendKey>(
  Object.entries(en.common.errors.backend).map(([key, message]) => [message, key as BackendKey]),
);

type Pattern = { re: RegExp; text: (m: RegExpMatchArray, t: TFunction) => string };

/** Messages the backend builds with values (`format!`), and the frontend's own. */
const PATTERNS: Pattern[] = [
  // `error::unreadable_at_launch_message(file)`: a store file (settings.json, following.json, a
  // library index) that existed at launch but couldn't be read; the file name has no folders.
  {
    re: /^Livery couldn['’]t read (.+?) when it started, so it won['’]t overwrite it\b/,
    text: (m, t) => t('common.errors.templates.unreadableAtLaunch', { file: m[1] ?? '' }),
  },
  // `call()` outside the desktop app ("\"cmd\" needs the desktop app", "WT Live needs the desktop app").
  // Queue rows keep only the message, so it is matched here too.
  { re: /needs the desktop app$/, text: (_, t) => t('common.errors.noBackend') },
];

/**
 * Backend messages deliberately left to the generic text (vaguer than it: `From<io::Error>`,
 * `From<serde_json::Error>`, internal guards), with the code they come with. Queue rows keep only
 * the message, so without this they would show in English in a translated UI.
 */
export const GENERIC_MESSAGES: ReadonlyMap<string, GenericCode> = new Map<string, GenericCode>([
  ['File system error', 'io'],
  ['Could not read JSON', 'parse'],
  ['Background task failed', 'internal'],
  ["This library index can't be saved", 'internal'],
]);

function genericKey(code: string | undefined): `common.errors.${GenericCode}` {
  const known = GENERIC_ERROR_CODES.find((c) => c === code);
  return `common.errors.${known ?? 'internal'}`;
}

/** The language shown now (de/ru/fr show English, see `useLanguageSync`). */
function shownLanguage(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? 'en';
}

/** Whether errors are shown in another language than the backend's English. */
function localizes(lng: string): boolean {
  return lng !== 'en' && translated.includes(lng as Language);
}

/**
 * The text to show for a backend error (`AppError`), in the UI language:
 * - English (also de/ru/fr, which show English): the backend's message as it is;
 * - otherwise the message's own translation when it is one the backend is known to send;
 * - else a generic text for its `code` (an unknown code reads as `internal`).
 *
 * Without a `code` (queue rows keep only the message) an unknown message is shown as it is: it may
 * already be a localized fallback. `detail` is never shown.
 */
export function errorText(e: Pick<AppError, 'message'> & { code?: string | undefined }, t: TFunction, lng = shownLanguage()): string {
  const message = typeof e.message === 'string' ? e.message.trim() : '';
  if (!localizes(lng)) return message || t(genericKey(e.code));
  const known = KNOWN.get(message);
  if (known) return t(`common.errors.backend.${known}`);
  for (const { re, text } of PATTERNS) {
    const m = message.match(re);
    if (m) return text(m, t);
  }
  const code = e.code ?? GENERIC_MESSAGES.get(message);
  if (code === undefined && message) return message;
  return t(genericKey(code));
}
