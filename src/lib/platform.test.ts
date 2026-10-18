import { describe, expect, it } from 'vitest';
import { isLinuxAgent } from './platform';

describe('isLinuxAgent', () => {
  it('tells WebKitGTK from WebView2', () => {
    expect(isLinuxAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(true);
    expect(
      isLinuxAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Edg/141.0'),
    ).toBe(false);
  });

  it('is not fooled by Android or a jsdom agent', () => {
    expect(isLinuxAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36')).toBe(false);
    expect(isLinuxAgent('Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.1.0')).toBe(false);
  });
});
