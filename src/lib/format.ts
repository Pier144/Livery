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

const ARCHIVE_RE = /\.(zip|rar|7z)$/i;

export function isArchive(fileName: string): boolean {
  return ARCHIVE_RE.test(fileName);
}

/** Last path segment for both Windows and POSIX separators. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
