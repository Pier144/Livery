import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/chrome/Toaster';
import { useLanguageSync } from '@/hooks/useLanguageSync';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import i18n from '@/i18n';
import { DEFAULT_SETTINGS } from '@/queries/settings';
import { TOAST_DURATION_MS, useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { AppError, Backup, Settings as SettingsData } from '@/types';
import { Settings } from '../Settings';
import { SECTIONS, resetSettingsUi, useSettingsUi, type SettingsSection } from './settingsUi';

type Args = Record<string, unknown>;

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  open: vi.fn<(options: unknown) => Promise<unknown>>(),
  getVersion: vi.fn<() => Promise<string>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (options: unknown) => backend.open(options),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: () => backend.getVersion(),
}));

// ── Fake backend ────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
const GAME = 'D:\\SteamLibrary\\steamapps\\common\\War Thunder';
const backup = (id: string, sizeBytes: number): Backup => ({
  id,
  skinId: `s-${id}`,
  name: `Skin ${id}`,
  sizeBytes,
  createdAt: '2026-09-18T10:00:00Z',
  reason: 'delete',
});
const BACKUPS = [backup('b1', 100 * MB), backup('b2', 40 * MB), backup('b3', 8 * MB)];

let settings: SettingsData;
let backups: Backup[];
let failSetSettings: AppError | null;

function installBackend() {
  backend.call.mockImplementation(async (cmd: string, args: Args = {}) => {
    switch (cmd) {
      case 'get_settings':
        return settings;
      case 'set_settings':
        if (failSetSettings) throw failSetSettings;
        settings = { ...settings, ...(args.patch as Partial<SettingsData>) };
        return settings;
      case 'watch_folder':
        settings = { ...settings, watchFolder: args.path as string, autoInstall: args.enabled as boolean };
        return settings;
      case 'list_backups':
        return backups;
      case 'clear_backups': {
        // `ids` absent → every kept backup; given → only those (unknown ids ignored).
        const ids = args.ids as string[] | undefined;
        backups = ids ? backups.filter((b) => !ids.includes(b.id)) : [];
        return null;
      }
      default:
        throw { code: 'internal', message: `unexpected command ${cmd}` } satisfies AppError;
    }
  });
}

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd);
const messages = () => useToasts.getState().toasts.map((t) => t.message);

/** Settings with the app-level hooks it drives (reduce motion, language) and the toast stack. */
function Harness() {
  useReduceMotion();
  useLanguageSync();
  return (
    <>
      <Settings />
      <Toaster />
    </>
  );
}

function renderSettings(section?: SettingsSection, initial: Partial<SettingsData> = {}) {
  settings = { ...DEFAULT_SETTINGS, onboarded: true, gamePath: GAME, gameSource: 'steam', ...initial };
  if (section) useSettingsUi.setState({ section });
  const user = userEvent.setup();
  const view = renderWithProviders(<Harness />, { settings });
  return { user, ...view };
}

const panel = () => screen.getByRole('tabpanel');

beforeEach(() => {
  resetStores();
  resetSettingsUi();
  backend.call.mockReset();
  backend.open.mockReset();
  backend.getVersion.mockReset();
  backend.getVersion.mockResolvedValue('0.2.0');
  backups = [...BACKUPS];
  failSetSettings = null;
  installBackend();
});

afterEach(async () => {
  vi.useRealTimers();
  delete document.documentElement.dataset.reduceMotion;
  document.head.querySelectorAll('style').forEach((s) => s.remove());
  await i18n.changeLanguage('en');
});

// ── Navigation ──────────────────────────────────────────────────────────────

describe('Settings · navigation', () => {
  it('lists the sections as a vertical tablist and moves between them with the keyboard', async () => {
    const { user, container } = renderSettings();
    const tablist = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['General', 'Game', 'Conflicts', 'Backups', 'Language', 'Updates', 'About']);
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveClass('bg-bg-hover', 'text-ink-1');
    expect(screen.getByRole('tab', { name: 'Game' })).toHaveClass('text-ink-3');
    // One tab stop: the selected tab.
    expect(tabs.filter((t) => t.tabIndex === 0)).toEqual([screen.getByRole('tab', { name: 'General' })]);
    expect(panel()).toHaveAccessibleName('General');
    expect(within(panel()).getByRole('heading', { level: 2, name: 'General' })).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);

    await user.tab();
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: 'Game' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Game' })).toHaveAttribute('aria-selected', 'true');
    expect(panel()).toHaveAccessibleName('Game');
    expect(within(panel()).getByRole('heading', { name: 'Game' })).toBeInTheDocument();

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'About' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('tab', { name: 'About' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();

    // Tab leaves the tablist for the panel's content.
    await user.tab();
    expect(screen.getByRole('tab', { name: 'General' })).not.toHaveFocus();
    expect(tablist).not.toContainElement(document.activeElement as HTMLElement);
  });

  it('remembers the open section while the app runs', async () => {
    const { user, unmount } = renderSettings();
    await user.click(screen.getByRole('tab', { name: 'Backups' }));
    expect(panel()).toHaveAccessibleName('Backups');
    unmount();
    renderSettings();
    expect(screen.getByRole('tab', { name: 'Backups' })).toHaveAttribute('aria-selected', 'true');
    expect(within(panel()).getByRole('heading', { name: 'Backups' })).toBeInTheDocument();
  });

  it.each(SECTIONS)('has no serious axe violations in %s', async (section) => {
    const { container } = renderSettings(section);
    if (section === 'backups') await screen.findByText('3 items · 148 MB');
    if (section === 'updates') await screen.findByText('Livery 0.2.0');
    expect(await seriousViolations(container)).toEqual([]);
  });
});

// ── General ─────────────────────────────────────────────────────────────────

describe('Settings · General', () => {
  it('Reduce motion saves the setting and drives the html data attribute', async () => {
    const { user } = renderSettings('general');
    const group = screen.getByRole('radiogroup', { name: 'Reduce motion' });
    expect(within(group).getByRole('radio', { name: 'System' })).toBeChecked();
    // The helper line describes the group.
    expect(group).toHaveAccessibleDescription('Follows your Windows setting by default.');
    expect(document.documentElement.dataset.reduceMotion).toBeUndefined();

    await user.click(within(group).getByRole('radio', { name: 'On' }));
    await waitFor(() => expect(document.documentElement.dataset.reduceMotion).toBe('true'));
    expect(calls('set_settings')).toEqual([['set_settings', { patch: { reduceMotion: 'on' } }]]);
    expect(settings.reduceMotion).toBe('on');

    // Arrow keys move and select.
    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: 'Off' })).toBeChecked();
    await waitFor(() => expect(document.documentElement.dataset.reduceMotion).toBe('false'));
    expect(document.head.querySelector('style[data-livery-motion]')).not.toBeNull();

    await user.keyboard('{Home}');
    await waitFor(() => expect(document.documentElement.dataset.reduceMotion).toBeUndefined());
    expect(settings.reduceMotion).toBe('system');
    expect(document.head.querySelector('style[data-livery-motion]')).toBeNull();
  });

  it('shows a failed save and falls back to the saved value', async () => {
    failSetSettings = { code: 'io', message: 'settings.json is read-only' };
    const { user } = renderSettings('general');
    await user.click(screen.getByRole('radio', { name: 'On' }));
    await waitFor(() => expect(messages()).toEqual(['settings.json is read-only']));
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
  });

  it('Start with Windows is unavailable for now and says why', async () => {
    const { user } = renderSettings('general');
    const toggle = screen.getByRole('switch', { name: 'Start with Windows' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription('Not available yet. It arrives in a later build.');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(calls('set_settings')).toHaveLength(0);
  });

  it('summarises the keyboard shortcuts with key caps', () => {
    renderSettings('general');
    const list = screen.getByRole('list');
    expect(list.textContent?.replace(/\s+/g, ' ')).toBe('Ctrl K search · 1–5 sections · [ ] sidebar · Ctrl Z undo · Esc close');
    expect(within(list).getByText('Ctrl K').tagName).toBe('KBD');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });
});

// ── Game ────────────────────────────────────────────────────────────────────

describe('Settings · Game', () => {
  it('shows the install, hides its path until asked, and Change opens First run on the folder picker', async () => {
    const { user, unmount } = renderSettings('game');
    expect(screen.getByText('War Thunder · Steam')).toBeInTheDocument();
    expect(screen.getByText(GAME)).not.toBeVisible();
    expect(screen.getByText(GAME)).toHaveAttribute('data-selectable');
    const reveal = screen.getByRole('button', { name: 'Show path', description: 'War Thunder · Steam' });
    await user.click(reveal);
    expect(screen.getByText(GAME)).toBeVisible();
    expect(reveal).toHaveAttribute('aria-expanded', 'true');

    const change = screen.getByRole('button', { name: 'Change', description: 'War Thunder · Steam' });
    await user.click(change);
    expect(useUi.getState().screen).toBe('firstRun');
    expect(useUi.getState().firstRun).toEqual({ step: 'choose', returnTo: 'settings' });

    // First run finishes and Settings comes back: focus returns to Change.
    unmount();
    act(() => useUi.getState().go('settings'));
    renderSettings();
    expect(screen.getByRole('button', { name: 'Change', description: 'War Thunder · Steam' })).toHaveFocus();
  });

  it('offers Choose when no game folder is set', async () => {
    const { user } = renderSettings('game', { gamePath: undefined, gameSource: undefined });
    expect(screen.getByText('No game folder set')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose' }));
    expect(useUi.getState().firstRun).toEqual({ step: 'choose', returnTo: 'settings' });
    expect(useUi.getState().screen).toBe('firstRun');
  });

  it('changes the watched folder through the picker and watch_folder, keeping watching as it was', async () => {
    const { user } = renderSettings('game', { autoInstall: true });
    expect(screen.getByText('Downloads (default)')).toBeInTheDocument();
    const change = screen.getByRole('button', { name: 'Change', description: 'Watched folder' });

    // Cancelled picker: nothing happens.
    backend.open.mockResolvedValueOnce(null);
    await user.click(change);
    expect(calls('watch_folder')).toHaveLength(0);

    backend.open.mockResolvedValueOnce('E:\\Skins\\Incoming');
    await user.click(change);
    expect(backend.open).toHaveBeenLastCalledWith(expect.objectContaining({ directory: true, title: 'Choose the folder to watch' }));
    await screen.findByText('Incoming');
    expect(calls('watch_folder')).toEqual([['watch_folder', { path: 'E:\\Skins\\Incoming', enabled: true }]]);
    // The full path stays hidden until asked for.
    expect(screen.getByText('E:\\Skins\\Incoming')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show path', description: 'Watched folder' }));
    expect(screen.getByText('E:\\Skins\\Incoming')).toBeVisible();
  });

  it('shows watch_folder errors as a toast', async () => {
    backend.call.mockImplementation(async (cmd: string) => {
      if (cmd === 'watch_folder') throw { code: 'invalidInput', message: 'That folder is inside UserSkins' } satisfies AppError;
      return settings;
    });
    const { user } = renderSettings('game');
    backend.open.mockResolvedValueOnce('D:\\SteamLibrary\\steamapps\\common\\War Thunder\\UserSkins');
    await user.click(screen.getByRole('button', { name: 'Change', description: 'Watched folder' }));
    await waitFor(() => expect(messages()).toEqual(['That folder is inside UserSkins']));
    expect(screen.getByText('Downloads (default)')).toBeInTheDocument();
  });
});

// ── Conflicts ───────────────────────────────────────────────────────────────

describe('Settings · Conflicts', () => {
  it('is a radio group of cards: arrows select, the choice is saved and survives a remount', async () => {
    const { user, unmount } = renderSettings('conflicts');
    const group = screen.getByRole('radiogroup', { name: 'Conflicts' });
    expect(group).toHaveAccessibleDescription('What to do when an archive has the same folder as an installed skin.');
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Ask every time', 'Replace and keep a backup', 'Install as a copy', 'Skip']);
    const ask = within(group).getByRole('radio', { name: 'Ask every time' });
    expect(ask).toBeChecked();
    expect(ask).toHaveClass('border-amber');
    expect(radios.filter((r) => r.tabIndex === 0)).toEqual([ask]);

    await user.click(ask);
    expect(calls('set_settings')).toHaveLength(0);
    await user.keyboard('{ArrowDown}');
    const replace = within(group).getByRole('radio', { name: 'Replace and keep a backup' });
    expect(replace).toHaveFocus();
    expect(replace).toBeChecked();
    expect(replace).toHaveClass('border-amber');
    expect(ask).toHaveClass('border-line-3');
    await waitFor(() => expect(settings.conflictPolicy).toBe('replace'));

    await user.keyboard('{End}');
    expect(within(group).getByRole('radio', { name: 'Skip' })).toBeChecked();
    await user.keyboard('{ArrowDown}');
    expect(within(group).getByRole('radio', { name: 'Ask every time' })).toBeChecked();
    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(settings.conflictPolicy).toBe('skip'));
    expect(calls('set_settings').map(([, a]) => (a as { patch: Partial<SettingsData> }).patch.conflictPolicy)).toEqual([
      'replace',
      'skip',
      'ask',
      'skip',
    ]);

    unmount();
    renderSettings('conflicts', { conflictPolicy: settings.conflictPolicy });
    expect(screen.getByRole('radio', { name: 'Skip' })).toBeChecked();
  });
});

// ── Backups ─────────────────────────────────────────────────────────────────

describe('Settings · Backups', () => {
  it('toggles keeping backups', async () => {
    const { user } = renderSettings('backups');
    const toggle = screen.getByRole('switch', { name: 'Keep a backup when replacing or deleting' });
    expect(toggle).toHaveAccessibleDescription('Lets you undo for 30 days.');
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(settings.backups).toBe(false));
    expect(calls('set_settings')).toEqual([['set_settings', { patch: { backups: false } }]]);
  });

  it('reads the backups on disk each time the section opens', async () => {
    const { user } = renderSettings('backups');
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByText('3 items · 148 MB')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'General' }));
    backups = BACKUPS.slice(0, 1);
    await user.click(screen.getByRole('tab', { name: 'Backups' }));
    expect(await screen.findByText('1 item · 100 MB')).toBeInTheDocument();
    expect(calls('list_backups')).toHaveLength(2);
  });

  it('Clear hides the backups at once; Undo brings them back without clearing anything', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    settings = { ...DEFAULT_SETTINGS, onboarded: true };
    useSettingsUi.setState({ section: 'backups' });
    renderWithProviders(<Harness />, { settings });

    await screen.findByText('3 items · 148 MB');
    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(clear).not.toHaveAttribute('aria-disabled');
    await user.click(clear);
    expect(screen.getByText('0 items · 0 B')).toBeInTheDocument();
    expect(clear).toHaveAttribute('aria-disabled', 'true');
    expect(clear).toHaveFocus();
    expect(messages()).toEqual(['Cleared 3 backups']);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('3 items · 148 MB')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(TOAST_DURATION_MS * 2));
    expect(calls('clear_backups')).toHaveLength(0);
    expect(backups).toHaveLength(3);
  });

  it('Clear commits with clear_backups when the toast expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    settings = { ...DEFAULT_SETTINGS, onboarded: true };
    useSettingsUi.setState({ section: 'backups' });
    renderWithProviders(<Harness />, { settings });

    await screen.findByText('3 items · 148 MB');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    // Clicking again while it waits does nothing.
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(messages()).toEqual(['Cleared 3 backups']);

    await act(() => vi.advanceTimersByTimeAsync(TOAST_DURATION_MS - 100));
    expect(calls('clear_backups')).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(200));
    await waitFor(() => expect(calls('clear_backups')).toHaveLength(1));
    // Exactly the backups that were listed when Clear was pressed.
    expect(calls('clear_backups')[0]).toEqual(['clear_backups', { ids: ['b1', 'b2', 'b3'] }]);
    expect(messages()).toEqual([]);
    await waitFor(() => expect(useSettingsUi.getState().clearingBackups).toBeNull());
    expect(screen.getByText('0 items · 0 B')).toBeInTheDocument();
    expect(backups).toEqual([]);
  });

  it('a backup made during the Undo window survives the Clear and shows up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    settings = { ...DEFAULT_SETTINGS, onboarded: true };
    useSettingsUi.setState({ section: 'backups' });
    const { client } = renderWithProviders(<Harness />, { settings });

    await screen.findByText('3 items · 148 MB');
    const clear = screen.getByRole('button', { name: 'Clear' });
    await user.click(clear);
    expect(screen.getByText('0 items · 0 B')).toBeInTheDocument();

    // A delete elsewhere makes a new backup; the list is read again (e.g. window focus).
    backups = [...backups, backup('b4', 2 * MB)];
    await act(() => client.refetchQueries({ queryKey: ['backups'] }));
    expect(await screen.findByText('1 item · 2 MB')).toBeInTheDocument();
    // One Clear at a time: the new backup waits for the pending one to finish.
    expect(clear).toHaveAttribute('aria-disabled', 'true');

    await act(() => vi.advanceTimersByTimeAsync(TOAST_DURATION_MS + 100));
    await waitFor(() => expect(calls('clear_backups')).toEqual([['clear_backups', { ids: ['b1', 'b2', 'b3'] }]]));
    expect(backups.map((b) => b.id)).toEqual(['b4']);
    await waitFor(() => expect(useSettingsUi.getState().clearingBackups).toBeNull());
    expect(await screen.findByText('1 item · 2 MB')).toBeInTheDocument();
    expect(clear).not.toHaveAttribute('aria-disabled');
  });

  it('keeps the backups and says so when clearing fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    installBackend();
    const base = backend.call.getMockImplementation()!;
    backend.call.mockImplementation(async (cmd, args) => {
      if (cmd === 'clear_backups') throw { code: 'io', message: 'Some backups could not be removed' } satisfies AppError;
      return base(cmd, args);
    });
    settings = { ...DEFAULT_SETTINGS, onboarded: true };
    useSettingsUi.setState({ section: 'backups' });
    renderWithProviders(<Harness />, { settings });

    await screen.findByText('3 items · 148 MB');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await act(() => vi.advanceTimersByTimeAsync(TOAST_DURATION_MS + 100));
    await waitFor(() => expect(messages()).toEqual(['Some backups could not be removed']));
    expect(await screen.findByText('3 items · 148 MB')).toBeInTheDocument();
  });
});

// ── Language ────────────────────────────────────────────────────────────────

describe('Settings · Language', () => {
  it('switches the UI language at once; untranslated languages say they show English', async () => {
    const { user } = renderSettings('language');
    const group = screen.getByRole('radiogroup', { name: 'Language' });
    const names = within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-labelledby'));
    expect(names).toHaveLength(5);
    expect(within(group).getByRole('radio', { name: 'English' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Italiano' })).not.toHaveAccessibleDescription();
    expect(within(group).getByRole('radio', { name: 'Deutsch' })).toHaveAccessibleDescription('English for now');
    expect(within(group).getByRole('radio', { name: 'Русский' })).toHaveAccessibleDescription('English for now');
    expect(within(group).getByRole('radio', { name: 'Français' })).toHaveAccessibleDescription('English for now');
    expect(within(group).getByText('Русский')).toHaveAttribute('lang', 'ru');

    await user.click(within(group).getByRole('radio', { name: 'Italiano' }));
    expect(await screen.findByRole('heading', { name: 'Lingua' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Generale' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Deutsch' })).toHaveAccessibleDescription('Per ora in inglese');
    expect(document.documentElement.lang).toBe('it');
    expect(settings.language).toBe('it');

    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('heading', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Deutsch' })).toBeChecked();
    expect(document.documentElement.lang).toBe('en');
    expect(settings.language).toBe('de');
  });
});

// ── Updates ─────────────────────────────────────────────────────────────────

describe('Settings · Updates', () => {
  it('shows the app version; checking and auto-install are unavailable for now', async () => {
    const { user } = renderSettings('updates', { autoUpdate: true });
    expect(await screen.findByText('Livery 0.2.0')).toBeInTheDocument();
    const check = screen.getByRole('button', { name: 'Check now' });
    expect(check).toHaveAttribute('aria-disabled', 'true');
    expect(check).toHaveAccessibleDescription(/arrive in a later build/);
    const auto = screen.getByRole('switch', { name: 'Install updates automatically' });
    expect(auto).toHaveAttribute('aria-disabled', 'true');
    expect(auto).toBeChecked();
    await user.click(auto);
    await user.click(check);
    expect(auto).toBeChecked();
    expect(calls('set_settings')).toHaveLength(0);
    expect(messages()).toEqual([]);
  });

  it('falls back to the package version when the app version is unavailable', async () => {
    backend.getVersion.mockRejectedValue(new Error('no app'));
    renderSettings('updates');
    expect(await screen.findByText('Livery 0.1.0')).toBeInTheDocument();
  });
});

// ── About ───────────────────────────────────────────────────────────────────

describe('Settings · About', () => {
  it('states the unofficial line, the version, and links that are honest about what works', async () => {
    renderSettings('about');
    expect(panel()).toHaveTextContent('Unofficial tool, not affiliated with Gaijin Entertainment.');
    expect(screen.getByText('LIVERY')).toBeInTheDocument();
    expect(await screen.findByText('0.2.0 · Windows x64')).toBeInTheDocument();
    expect(
      screen.getByText('A user skin manager for War Thunder. Browse WT Live, install with a click, keep your hangar tidy.'),
    ).toBeInTheDocument();
    const source = screen.getByRole('button', { name: 'Source code' });
    expect(source).toHaveAttribute('aria-disabled', 'true');
    expect(source).toHaveAttribute('title', 'The source code isn’t public yet.');
    expect(screen.getByRole('button', { name: 'Report a problem' })).toHaveAttribute('aria-disabled', 'true');
    expect(panel().querySelector('img, svg')).toBeNull();
  });

  it('Licenses opens a focus-trapped dialog; Escape closes only it and focus goes back', async () => {
    const { user, container } = renderSettings('about');
    const opener = screen.getByRole('button', { name: 'Licenses' });
    const windowKeys = vi.fn();
    window.addEventListener('keydown', windowKeys);

    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Licenses' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByText('Geist')).toBeInTheDocument();
    expect(within(dialog).getByText('IBM Plex Mono')).toBeInTheDocument();
    expect(within(dialog).getAllByText('SIL OFL 1.1')).toHaveLength(2);
    for (const lib of ['React', 'Tauri', 'Zustand', 'Lucide', 'Tailwind CSS']) expect(within(dialog).getByText(lib)).toBeInTheDocument();
    expect(within(dialog).getByText('ISC')).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);

    const close = within(dialog).getByRole('button', { name: 'Close' });
    const [geist, plex] = within(dialog).getAllByRole('button', { name: 'Show license text' }) as [HTMLElement, HTMLElement];
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(geist).toHaveFocus();
    await user.tab();
    expect(plex).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(plex).toHaveFocus();

    // The full OFL text ships with the app; once shown it is a focusable scroll region.
    await user.click(geist);
    const text = within(dialog).getByLabelText('Geist license text');
    expect(text).toBeVisible();
    expect(text).toHaveTextContent('SIL OPEN FONT LICENSE Version 1.1');
    await user.tab();
    expect(text).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(windowKeys).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
    window.removeEventListener('keydown', windowKeys);
  });

  it('closes the dialog with its Close button or a click outside', async () => {
    const { user } = renderSettings('about');
    await user.click(screen.getByRole('button', { name: 'Licenses' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Licenses' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Licenses' }));
    const overlay = screen.getByRole('dialog').parentElement!;
    await user.pointer({ keys: '[MouseLeft]', target: overlay });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
