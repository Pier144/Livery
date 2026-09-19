const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 1024-based sizes as shown in the UI: "48 MB", "3.8 GB", "2 KB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // MB and below are shown as integers; GB and above keep one decimal.
  const text = unit >= 3 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${text} ${UNITS[unit]}`;
}

/** Compact counts: 24120 → "24.1k". */
export function formatCompact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

const SHORT_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

/**
 * Post dates: "12 Jun 2026" in English (the prototype's day-month-year with en-US month names;
 * en-GB would write "Sept"), the language's own short form otherwise ("12 giu 2026").
 * Returns null for a date that can't be read.
 */
export function formatShortDate(iso: string, language: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (!language.startsWith('en')) return new Intl.DateTimeFormat(language, SHORT_DATE).format(date);
  const parts = new Intl.DateTimeFormat('en-US', SHORT_DATE).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}

const ARCHIVE_RE = /\.(zip|rar|7z)$/i;

export function isArchive(fileName: string): boolean {
  return ARCHIVE_RE.test(fileName);
}

/** Last path segment for both Windows and POSIX separators. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
