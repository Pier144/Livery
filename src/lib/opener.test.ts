import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { useToasts } from '@/store/toasts';
import { ISSUES_URL, REPO_URL, isAllowedUrl, isWtLiveUrl, openExternalUrl, openLink, revealInExplorer, showInExplorer } from './opener';

const env = vi.hoisted(() => ({
  tauri: true,
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  revealItemInDir: vi.fn<(path: string) => Promise<void>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => env.tauri,
  hasBackend: () => env.tauri,
  call: () => Promise.reject(new Error('no commands here')),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => env.openUrl(url),
  revealItemInDir: (path: string) => env.revealItemInDir(path),
}));

const t = i18n.t.bind(i18n);
const messages = () => useToasts.getState().toasts.map((x) => x.message);
let clipboard: string | null;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  env.tauri = true;
  env.openUrl.mockReset().mockResolvedValue(undefined);
  env.revealItemInDir.mockReset().mockResolvedValue(undefined);
  clipboard = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn((text: string) => {
        clipboard = text;
        return Promise.resolve();
      }),
    },
  });
  useToasts.getState().clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.restoreAllMocks();
});

describe('opener · allow-list', () => {
  it.each([
    'https://live.warthunder.com/post/1043217/en/',
    'https://live.warthunder.com/user/12345/',
    'https://live.warthunder.com',
    REPO_URL,
    `${REPO_URL}/`,
    ISSUES_URL,
    `${REPO_URL}/issues/new?labels=bug`,
    'https://LIVE.WarThunder.com/post/1/',
    'https://live.warthunder.com:443/post/1/',
  ])('allows %s', (url) => {
    expect(isAllowedUrl(url)).toBe(true);
  });

  it.each([
    'http://live.warthunder.com/post/1/',
    'https://live.warthunder.com.evil.example/post/1/',
    'https://evil-live.warthunder.com/',
    'https://warthunder.com/',
    'https://market.gaijin.net/',
    'https://user:pass@live.warthunder.com/',
    'https://live.warthunder.com:8443/post/1/',
    'https://github.com/Pier144/LiveryEvil',
    'https://github.com/Pier144/Livery/../Other',
    'https://github.com/Pier144/Livery/%2e%2e/Other',
    'https://github.com/Pier144/Livery.evil',
    'https://github.com/Pier144/LiveryX',
    'https://github.com/pier144/livery',
    'https://github.com@evil.example/Pier144/Livery',
    'https://github.com:443@evil.example/Pier144/Livery',
    'https://live.warthunder.com./post/1/',
    'https://live.warthunder.com%2eevil.example/',
    'https://evil.example\\.live.warthunder.com/',
    // Cyrillic і, which the parser turns into punycode.
    'https://lіve.warthunder.com/',
    'https://xn--lve-6lad.warthunder.com/',
    'HTTP://live.warthunder.com/',
    ' javascript:alert(1)//https://live.warthunder.com/',
    'https://github.com/Pier144',
    'https://gist.github.com/Pier144/Livery',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    '/post/1/',
    '',
  ])('refuses %s', (url) => {
    expect(isAllowedUrl(url)).toBe(false);
  });

  it('the WT Live scope refuses the repository', () => {
    expect(isAllowedUrl(REPO_URL, 'wtlive')).toBe(false);
    expect(isAllowedUrl('https://live.warthunder.com/post/1/', 'wtlive')).toBe(true);
    expect(isWtLiveUrl(ISSUES_URL)).toBe(false);
    expect(isWtLiveUrl('https://live.warthunder.com/user/1/')).toBe(true);
  });
});

describe('opener · links', () => {
  it('opens an allowed link through the plugin', async () => {
    await expect(openExternalUrl(ISSUES_URL)).resolves.toBe('opened');
    expect(env.openUrl).toHaveBeenCalledWith(ISSUES_URL);
    expect(clipboard).toBeNull();
  });

  it('hands the plugin the normalised URL it checked', async () => {
    await expect(openExternalUrl('https://LIVE.WarThunder.com:443/post/1/', 'wtlive')).resolves.toBe('opened');
    expect(env.openUrl).toHaveBeenCalledWith('https://live.warthunder.com/post/1/');
  });

  it('never hands a refused link to the plugin or the clipboard', async () => {
    await expect(openLink('https://evil.example/', t, 'wtlive')).resolves.toBe('refused');
    await expect(openLink(REPO_URL, t, 'wtlive')).resolves.toBe('refused');
    expect(env.openUrl).not.toHaveBeenCalled();
    expect(clipboard).toBeNull();
    expect(messages()).toEqual([
      'That link doesn’t lead to WT Live, so Livery didn’t open it.',
      'That link doesn’t lead to WT Live, so Livery didn’t open it.',
    ]);
  });

  it('copies the link and says so when the browser can’t be opened', async () => {
    env.openUrl.mockRejectedValue(new Error('no browser'));
    await expect(openLink('https://live.warthunder.com/post/7/en/', t, 'wtlive')).resolves.toBe('copied');
    expect(clipboard).toBe('https://live.warthunder.com/post/7/en/');
    expect(messages()).toEqual(['Livery couldn’t open your browser, so the link is on the clipboard. Paste it there.']);
  });

  it('shows the link when neither the browser nor the clipboard works', async () => {
    env.openUrl.mockRejectedValue(new Error('no browser'));
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'));
    await expect(openLink(REPO_URL, t)).resolves.toBe('failed');
    expect(messages()).toEqual([`Couldn’t open the link: ${REPO_URL}`]);
  });

  it('outside the desktop app opens a new tab with no opener', async () => {
    env.tauri = false;
    const tab = { opener: window as Window | null } as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    await expect(openExternalUrl(REPO_URL)).resolves.toBe('opened');
    expect(open).toHaveBeenCalledWith(REPO_URL, '_blank');
    expect(tab.opener).toBeNull();
    expect(env.openUrl).not.toHaveBeenCalled();

    // A blocked pop-up falls back to the clipboard.
    open.mockReturnValue(null);
    await expect(openExternalUrl(REPO_URL)).resolves.toBe('copied');
    expect(clipboard).toBe(REPO_URL);
  });
});

describe('opener · Show in Explorer', () => {
  const GAME = 'D:\\SteamLibrary\\steamapps\\common\\War Thunder';

  it('reveals a backend path through the plugin', async () => {
    await expect(showInExplorer(GAME, t)).resolves.toBe(true);
    expect(env.revealItemInDir).toHaveBeenCalledWith(GAME);
    expect(messages()).toEqual([]);
  });

  it('says so when the folder can’t be shown', async () => {
    env.revealItemInDir.mockRejectedValue('path not found');
    await expect(showInExplorer(GAME, t)).resolves.toBe(false);
    expect(messages()).toEqual(['Couldn’t open that folder in Explorer.']);
  });

  it('does nothing outside the desktop app or without a path', async () => {
    await expect(revealInExplorer('')).resolves.toBe(false);
    env.tauri = false;
    await expect(revealInExplorer(GAME)).resolves.toBe(false);
    expect(env.revealItemInDir).not.toHaveBeenCalled();
  });
});
