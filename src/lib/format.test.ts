import { describe, expect, it } from 'vitest';
import { baseName, formatBytes, formatCompact, isArchive } from './format';

describe('format', () => {
  it('formats bytes like the UI copy', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(48 * 1024 ** 2)).toBe('48 MB');
    expect(formatBytes(3.8 * 1024 ** 3)).toBe('3.8 GB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB');
  });

  it('compacts counts', () => {
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(24120)).toBe('24.1k');
    expect(formatCompact(2000)).toBe('2k');
  });

  it('recognises archives case-insensitively', () => {
    expect(isArchive('skin.ZIP')).toBe(true);
    expect(isArchive('skin.7z')).toBe(true);
    expect(isArchive('skin.rar')).toBe(true);
    expect(isArchive('skin.dds')).toBe(false);
    expect(isArchive('zip')).toBe(false);
  });

  it('takes the last path segment on Windows and POSIX', () => {
    expect(baseName('C:\\Users\\you\\Downloads\\a b.zip')).toBe('a b.zip');
    expect(baseName('/tmp/x.7z')).toBe('x.7z');
  });
});
