import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/queries/settings';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { AppError, DetectEvent, GameDetection, HangarSkin, Settings, Vehicle } from '@/types';
import { FirstRun } from './FirstRun';

type DetectHandler = (event: { payload: DetectEvent }) => void;
type Args = Record<string, unknown> | undefined;

const backend = vi.hoisted(() => ({
  handler: undefined as ((event: { payload: unknown }) => void) | undefined,
  unlisten: vi.fn(),
  call: vi.fn(),
  open: vi.fn(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_event: string, handler: DetectHandler) => {
    backend.handler = handler as typeof backend.handler;
    return backend.unlisten;
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (options: unknown) => backend.open(options),
}));

const STEAM_PATH = 'D:\\SteamLibrary\\steamapps\\common\\War Thunder';
const FOUND: GameDetection = { found: true, source: 'steam', path: STEAM_PATH, version: '2.59.0.13', existingSkins: 7 };
const NONE: GameDetection = { found: false, existingSkins: 0 };
const STEAM_EVENTS: DetectEvent[] = [
  { source: 'steam', state: 'checking' },
  { source: 'steam', state: 'found' },
  { source: 'standalone', state: 'notFound' },
  { source: 'custom', state: 'skipped' },
];
const NONE_EVENTS: DetectEvent[] = [
  { source: 'steam', state: 'notFound' },
  { source: 'standalone', state: 'notFound' },
  { source: 'custom', state: 'skipped' },
];

const vehicle = (code: string, name: string): Vehicle => ({ code, name, nation: 'USSR', type: 'ground', class: 'Medium tank' });
const T34 = vehicle('ussr_t_34_85_d_5t', 'T-34-85 (D-5T)');
const TIGER = vehicle('germ_pzkpfw_VI_ausf_e_tiger', 'Tiger H1');
const IS2 = vehicle('ussr_is_2_1944', 'IS-2 (1944)');
const skin = (folder: string, v: Vehicle, extra: Partial<HangarSkin> = {}): HangarSkin => ({
  id: folder,
  folder,
  name: folder,
  vehicle: v,
  origin: 'imported',
  sizeBytes: 1024,
  active: true,
  installedAt: '2026-09-19T10:00:00Z',
  ...extra,
});
const SKINS: HangarSkin[] = [
  skin('Winter whitewash', T34, { attention: [{ kind: 'missingTexture', message: 'missing', file: 't34_c.dds' }] }),
  skin('template_ussr_t_34_85_d_5t', T34, { origin: 'mine' }),
  skin('Desert tan', TIGER),
  skin('Ambush', TIGER),
  skin('Berlin 1945', IS2),
  skin('Kursk', T34),
  skin('Normandy', TIGER),
];

interface Fake {
  detect?: { events: DetectEvent[]; result: GameDetection } | { error: AppError };
  setGamePath?: (args: { path: string; source?: string }) => GameDetection;
  scan?: () => HangarSkin[] | Promise<HangarSkin[]>;
  importSkins?: (folders: string[]) => HangarSkin[];
}

let settings: Settings;

/** Answers `call(cmd, args)` like the Rust commands; throw an AppError object to reject. */
function fakeBackend(fake: Fake) {
  backend.call.mockImplementation(async (cmd: string, args: Args) => {
    switch (cmd) {
      case 'detect_game': {
        const detect = fake.detect ?? { events: NONE_EVENTS, result: NONE };
        if ('error' in detect) throw detect.error;
        detect.events.forEach((payload) => backend.handler?.({ payload }));
        return detect.result;
      }
      case 'set_game_path':
        return (fake.setGamePath ?? (() => FOUND))(args as { path: string; source?: string });
      case 'get_settings':
        return settings;
      case 'set_settings':
        settings = { ...settings, ...(args?.patch as Partial<Settings>) };
        return settings;
      case 'scan_user_skins':
        return (fake.scan ?? (() => SKINS))();
      case 'import_skins':
        return (fake.importSkins ?? ((folders) => SKINS.filter((s) => folders.includes(s.folder))))(args?.folders as string[]);
      default:
        throw { code: 'internal', message: `unexpected command ${cmd}` } satisfies AppError;
    }
  });
}

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd);
const messages = () => useToasts.getState().toasts.map((t) => t.message);
const row = (label: string) => screen.getByText(label).closest('li')!;

/** Mounts First run and lets detection run to its auto-advance. */
async function renderDetected(fake: Fake) {
  fakeBackend(fake);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = renderWithProviders(<FirstRun />, { settings: {} });
  await vi.waitFor(() => expect(calls('detect_game')).toHaveLength(1));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  return { user, ...view };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetStores();
  useUi.getState().go('firstRun');
  settings = { ...DEFAULT_SETTINGS };
  backend.handler = undefined;
  backend.call.mockReset();
  backend.open.mockReset();
  backend.unlisten.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('FirstRun · detect', () => {
  it('paces the detection rows and the progress bar, then announces the outcome', async () => {
    fakeBackend({ detect: { events: STEAM_EVENTS, result: FOUND } });
    const { container } = renderWithProviders(<FirstRun />, { settings: {} });

    expect(screen.getByRole('heading', { level: 1, name: 'Looking for War Thunder' })).toBeInTheDocument();
    const tracker = screen.getByRole('list', { name: 'Setup steps' });
    expect(within(tracker).getByText('01 DETECT').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(within(tracker).getByText('02 CONFIRM').closest('li')).not.toHaveAttribute('aria-current');
    expect(row('Steam library')).toHaveTextContent('checking…');
    expect(row('Standalone launcher')).toHaveTextContent('queued');
    expect(row('Custom location')).toHaveTextContent('queued');
    const progress = screen.getByRole('progressbar', { name: 'Detection progress' });
    expect(progress).toHaveAttribute('aria-valuenow', '0');

    await vi.waitFor(() => expect(calls('detect_game')).toHaveLength(1));
    // Results are in, but Steam is revealed only at ~30 %.
    expect(row('Steam library')).toHaveTextContent('checking…');
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(row('Steam library')).toHaveTextContent('found');
    // Found reads amber; a row being checked pulses only when motion is allowed.
    expect(within(row('Steam library')).getByText('found')).toHaveClass('text-amber');
    expect(row('Standalone launcher')).toHaveTextContent('checking…');
    expect(row('Standalone launcher').querySelector('[aria-hidden]')).toHaveClass('motion-safe:animate-pulse6');
    expect(progress.firstElementChild).toHaveClass('bg-amber', 'motion-safe:transition-[width]');
    expect(Number(progress.getAttribute('aria-valuenow'))).toBeGreaterThan(30);
    expect(await seriousViolations(container)).toEqual([]);

    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(row('Standalone launcher')).toHaveTextContent('not installed');
    expect(row('Custom location')).toHaveTextContent('skipped');
    expect(backend.unlisten).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('heading', { name: 'Found War Thunder' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Detection finished. War Thunder found: Steam library.');
    expect(within(tracker).getByText('02 CONFIRM').closest('li')).toHaveAttribute('aria-current', 'step');
    // README: current amber, past ink-3; future ink-4, not the README's ink-5 (10px text needs 4.5:1, docs/a11y.md).
    expect(within(tracker).getByText('01 DETECT')).toHaveClass('text-ink-3');
    expect(within(tracker).getByText('02 CONFIRM')).toHaveClass('text-amber');
    expect(within(tracker).getByText('03 IMPORT')).toHaveClass('text-ink-4');
  });

  it('labels a missing standalone launcher "not installed" and falls through to not found', async () => {
    fakeBackend({ detect: { events: NONE_EVENTS, result: NONE } });
    renderWithProviders(<FirstRun />, { settings: {} });
    await vi.waitFor(() => expect(calls('detect_game')).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(1100));
    expect(row('Steam library')).toHaveTextContent('not found');
    expect(row('Standalone launcher')).toHaveTextContent('not installed');
    expect(row('Custom location')).toHaveTextContent('skipped');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('heading', { name: "Can't find War Thunder" })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent("War Thunder wasn't found in the usual places.");
  });

  it('shows the error and the folder picker when detection fails', async () => {
    await renderDetected({ detect: { error: { code: 'io', message: 'Registry unreadable' } } });
    expect(screen.getByRole('heading', { name: "Can't find War Thunder" })).toBeInTheDocument();
    expect(messages()).toEqual(['Registry unreadable']);
  });
});

describe('FirstRun · found', () => {
  it('uses the detected install, imports existing skins and opens Explore', async () => {
    const { user, container } = await renderDetected({ detect: { events: STEAM_EVENTS, result: FOUND } });

    expect(screen.getByText('STEAM')).toBeInTheDocument();
    expect(screen.getByText('STEAM').closest('.rounded-card')).toHaveClass('border-amber-60');
    expect(screen.getByText('Version 2.59 · 7 skins already in UserSkins')).toBeInTheDocument();
    // Paths are hidden until asked for.
    expect(screen.getByText(STEAM_PATH)).not.toBeVisible();
    const toggle = screen.getByRole('button', { name: 'Show path' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByText(STEAM_PATH)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide path' })).toHaveAttribute('aria-expanded', 'true');
    expect(useUi.getState().folderDrop).toBeNull();
    expect(await seriousViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Use this install' }));
    expect(await screen.findByRole('heading', { name: 'Skins already on disk' })).toHaveFocus();
    expect(calls('set_game_path')).toEqual([['set_game_path', { path: STEAM_PATH, source: 'steam' }]]);
    // The toast is for folders chosen by hand only.
    expect(messages()).not.toContain('Game folder set');

    expect(await screen.findByText('+ 2 more')).toBeInTheDocument();
    expect(screen.getByText('skins').parentElement).toHaveTextContent('7skins');
    expect(screen.getByText('vehicles').parentElement).toHaveTextContent('3vehicles');
    expect(screen.getByText('need attention').parentElement).toHaveTextContent('1need attention');
    const rows = within(screen.getByRole('list', { name: '' })).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Winter whitewash');
    expect(rows[0]).toHaveTextContent('T-34-85 (D-5T)');
    expect(rows[0]).toHaveTextContent('needs attention: t34_c.dds is missing');
    expect(rows[1]).toHaveTextContent('created by you');
    expect(rows[2]).toHaveTextContent(/ok$/);
    expect(await seriousViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Import and continue' }));
    await vi.waitFor(() => expect(useUi.getState().screen).toBe('explore'));
    expect(calls('import_skins')).toEqual([['import_skins', { folders: SKINS.map((s) => s.folder) }]]);
    expect(calls('set_settings')).toEqual([['set_settings', { patch: { onboarded: true } }]]);
    expect(settings.onboarded).toBe(true);
    expect(messages()).toEqual(['7 skins added to My Hangar']);
  });

  it('finishes straight away when UserSkins is empty', async () => {
    const empty = { ...FOUND, existingSkins: 0 };
    const { user } = await renderDetected({ detect: { events: STEAM_EVENTS, result: empty }, setGamePath: () => empty });
    expect(screen.getByText('Version 2.59 · 0 skins already in UserSkins')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use this install' }));
    await vi.waitFor(() => expect(useUi.getState().screen).toBe('explore'));
    expect(calls('scan_user_skins')).toHaveLength(0);
    expect(settings.onboarded).toBe(true);
    expect(messages()).toEqual([]);
  });

  it('omits the version when the game has none', async () => {
    const noVersion = { ...FOUND, version: undefined, existingSkins: 1 };
    await renderDetected({ detect: { events: STEAM_EVENTS, result: noVersion } });
    expect(screen.getByText('1 skin already in UserSkins')).toBeInTheDocument();
  });

  it('shows backend errors as a toast and stays', async () => {
    const { user } = await renderDetected({
      detect: { events: STEAM_EVENTS, result: FOUND },
      setGamePath: () => {
        throw { code: 'io', message: 'Access denied' } satisfies AppError;
      },
    });
    await user.click(screen.getByRole('button', { name: 'Use this install' }));
    await vi.waitFor(() => expect(messages()).toEqual(['Access denied']));
    expect(screen.getByRole('heading', { name: 'Found War Thunder' })).toBeInTheDocument();
    expect(useUi.getState().screen).toBe('firstRun');
  });

  it('registers the folder drop only while the not-found view is shown', async () => {
    const { user } = await renderDetected({ detect: { events: STEAM_EVENTS, result: FOUND } });
    expect(useUi.getState().folderDrop).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Choose another folder' }));
    expect(screen.getByRole('heading', { name: "Can't find War Thunder" })).toHaveFocus();
    expect(useUi.getState().folderDrop).toBeTypeOf('function');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Found War Thunder' })).toHaveFocus();
    expect(useUi.getState().folderDrop).toBeNull();
    expect(calls('detect_game')).toHaveLength(1);
  });
});

describe('FirstRun · not found', () => {
  it('rejects a folder that is not the game, then accepts the right one', async () => {
    const custom: GameDetection = { found: true, source: 'custom', path: 'C:\\Games\\War Thunder', existingSkins: 0 };
    const { user, container } = await renderDetected({
      setGamePath: ({ path }) => {
        if (path === 'C:\\Games\\War Thunder') return custom;
        throw { code: 'invalidInput', message: 'Not a War Thunder folder' } satisfies AppError;
      },
    });
    expect(screen.getByRole('heading', { name: "Can't find War Thunder" })).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);

    backend.open.mockResolvedValueOnce('C:\\Games\\Nope');
    const choose = screen.getByRole('button', { name: /Choose game folder/ });
    await user.click(choose);
    expect(backend.open).toHaveBeenCalledWith({ directory: true, title: 'Choose the War Thunder folder' });
    expect(await screen.findByRole('alert')).toHaveTextContent("That folder doesn't look like War Thunder.");
    expect(choose).toHaveAccessibleDescription(/doesn't look like War Thunder/);
    expect(messages()).toEqual([]);
    expect(await seriousViolations(container)).toEqual([]);

    // A cancelled dialog changes nothing.
    backend.open.mockResolvedValueOnce(null);
    await user.click(choose);
    expect(calls('set_game_path')).toHaveLength(1);

    backend.open.mockResolvedValueOnce('C:\\Games\\War Thunder');
    await user.click(choose);
    await vi.waitFor(() => expect(useUi.getState().screen).toBe('explore'));
    expect(calls('set_game_path').at(-1)).toEqual(['set_game_path', { path: 'C:\\Games\\War Thunder' }]);
    expect(settings.onboarded).toBe(true);
    expect(messages()).toEqual(['Game folder set']);
  });

  it('takes a folder dropped on the window and goes on to Import', async () => {
    const dropped: GameDetection = { found: true, source: 'custom', path: 'E:\\WT', existingSkins: 2 };
    const { user, container } = await renderDetected({
      setGamePath: () => dropped,
      scan: () => SKINS.slice(2, 4),
    });

    act(() => useUi.getState().folderDrop?.(['E:\\WT', 'E:\\other']));
    expect(await screen.findByRole('heading', { name: 'Skins already on disk' })).toHaveFocus();
    expect(calls('set_game_path')).toEqual([['set_game_path', { path: 'E:\\WT' }]]);
    expect(useUi.getState().folderDrop).toBeNull();
    expect(messages()).toEqual(['Game folder set']);
    expect(await screen.findByText('Desert tan')).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Skip import' }));
    await vi.waitFor(() => expect(useUi.getState().screen).toBe('explore'));
    expect(calls('import_skins')).toHaveLength(0);
    expect(settings.onboarded).toBe(true);
  });

  it('"Skip for now" finishes first run without a game folder', async () => {
    const { user } = await renderDetected({});
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await vi.waitFor(() => expect(useUi.getState().screen).toBe('explore'));
    expect(settings.onboarded).toBe(true);
    expect(calls('set_game_path')).toHaveLength(0);
    expect(messages()).toEqual(['You can set the game folder later in Settings']);
  });

  it('"Back" looks for the game again when nothing was found', async () => {
    const { user } = await renderDetected({});
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Looking for War Thunder' })).toHaveFocus();
    expect(useUi.getState().folderDrop).toBeNull();
    await vi.waitFor(() => expect(calls('detect_game')).toHaveLength(2));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('heading', { name: "Can't find War Thunder" })).toBeInTheDocument();
  });
});

describe('FirstRun · import', () => {
  it('shows skeletons while scanning, and keeps the step when importing fails', async () => {
    let resolveScan: (skins: HangarSkin[]) => void = () => {};
    const { user, container } = await renderDetected({
      detect: { events: STEAM_EVENTS, result: FOUND },
      scan: () => new Promise((resolve) => (resolveScan = resolve)),
      importSkins: () => {
        throw { code: 'io', message: 'Index is locked' } satisfies AppError;
      },
    });
    await user.click(screen.getByRole('button', { name: 'Use this install' }));
    await screen.findByRole('heading', { name: 'Skins already on disk' });
    const loading = screen.getByRole('status', { busy: true });
    expect(loading).toHaveTextContent('Loading');
    expect(await seriousViolations(container)).toEqual([]);

    // Not importable before the scan answers.
    const importButton = screen.getByRole('button', { name: 'Import and continue' });
    expect(importButton).toHaveAttribute('aria-disabled', 'true');
    await user.click(importButton);
    expect(calls('import_skins')).toHaveLength(0);

    await act(async () => resolveScan(SKINS));
    expect(await screen.findByText('+ 2 more')).toBeInTheDocument();
    await user.click(importButton);
    await vi.waitFor(() => expect(messages()).toEqual(['Index is locked']));
    expect(screen.getByRole('heading', { name: 'Skins already on disk' })).toBeInTheDocument();
    expect(useUi.getState().screen).toBe('firstRun');
    expect(settings.onboarded).toBe(false);
  });

  it('offers a retry when the scan fails', async () => {
    let fail = true;
    const { user } = await renderDetected({
      detect: { events: STEAM_EVENTS, result: FOUND },
      scan: () => {
        if (fail) throw { code: 'io', message: 'UserSkins is unreadable' } satisfies AppError;
        return SKINS.slice(0, 1);
      },
    });
    await user.click(screen.getByRole('button', { name: 'Use this install' }));
    expect(await screen.findByText("Couldn't read the UserSkins folder.")).toBeInTheDocument();
    expect(messages()).toEqual(['UserSkins is unreadable']);

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Winter whitewash')).toBeInTheDocument();
    expect(calls('scan_user_skins')).toHaveLength(2);
  });
});

describe('FirstRun · from Settings (choose entry)', () => {
  const fromSettings = () => {
    act(() => useUi.getState().startFirstRun({ step: 'choose', returnTo: 'settings' }));
    settings = { ...DEFAULT_SETTINGS, onboarded: true, gamePath: STEAM_PATH, gameSource: 'steam' };
  };

  it('opens straight on the folder picker, without detecting, and returns to Settings', async () => {
    fromSettings();
    const custom: GameDetection = { found: true, source: 'custom', path: 'E:\WT', existingSkins: 0 };
    fakeBackend({ setGamePath: () => custom });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = renderWithProviders(<FirstRun />, { settings });

    expect(screen.getByRole('heading', { name: "Can't find War Thunder" })).toHaveFocus();
    expect(useUi.getState().folderDrop).toBeTypeOf('function');
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(calls('detect_game')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: "Can't find War Thunder" })).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);

    backend.open.mockResolvedValueOnce('E:\WT');
    await user.click(screen.getByRole('button', { name: /Choose game folder/ }));
    await vi.waitFor(() => expect(useUi.getState().screen).toBe('settings'));
    expect(calls('set_game_path')).toEqual([['set_game_path', { path: 'E:\WT' }]]);
    expect(messages()).toEqual(['Game folder set']);
  });

  it('offers "Back to Settings" instead of "Skip for now" and "Back"', () => {
    fromSettings();
    fakeBackend({});
    renderWithProviders(<FirstRun />, { settings });
    expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('"Back to Settings" cancels: no detection, no settings write, no toast', async () => {
    fromSettings();
    fakeBackend({});
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<FirstRun />, { settings });
    await user.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(useUi.getState().screen).toBe('settings');
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(calls('detect_game')).toHaveLength(0);
    expect(calls('set_game_path')).toHaveLength(0);
    expect(calls('set_settings')).toHaveLength(0);
    expect(messages()).toEqual([]);
  });

  it('a picked folder with skins goes on to Import, then back to Settings', async () => {
    fromSettings();
    fakeBackend({});
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<FirstRun />, { settings });

    backend.open.mockResolvedValueOnce(STEAM_PATH);
    await user.click(screen.getByRole('button', { name: /Choose game folder/ }));
    await screen.findByText('+ 2 more');
    await user.click(screen.getByRole('button', { name: 'Import and continue' }));
    await vi.waitFor(() => expect(useUi.getState().screen).toBe('settings'));
    expect(calls('detect_game')).toHaveLength(0);
    expect(messages()).toEqual(['Game folder set', '7 skins added to My Hangar']);
  });
});
