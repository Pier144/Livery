import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@/components/chrome/ConfirmDialog';
import { Toaster } from '@/components/chrome/Toaster';
import { useLanguageSync } from '@/hooks/useLanguageSync';
import { useReduceMotion } from '@/hooks/useReduceMotion';
import i18n from '@/i18n';
import { DEFAULT_SETTINGS } from '@/queries/settings';
import { TOAST_DURATION_MS, useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { useUpdate } from '@/store/update';
import type { AppError, Backup, CutoutStatus, Settings as SettingsData, UpdateInfo, WtLiveStorage } from '@/types';
import { resetDecalUi, setCutoutBusy } from '../Atelier/decalUi';
import { version as PACKAGE_VERSION } from '../../../package.json';
import { Settings } from '../Settings';
import { SECTIONS, resetSettingsUi, useSettingsUi, type SettingsSection } from './settingsUi';
import { useFeedback } from '@/store/feedback';

type Args = Record<string, unknown>;

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  open: vi.fn<(options: unknown) => Promise<unknown>>(),
  getVersion: vi.fn<() => Promise<string>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  revealItemInDir: vi.fn<(path: string) => Promise<void>>(),
  /** A fake Windows Run entry: enable/disable flip it unless `fail` is set. */
  autostart: { enabled: false, fail: null as unknown },
  isEnabled: vi.fn<() => Promise<boolean>>(),
  enable: vi.fn<() => Promise<void>>(),
  disable: vi.fn<() => Promise<void>>(),
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

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => backend.openUrl(url),
  revealItemInDir: (path: string) => backend.revealItemInDir(path),
}));

vi.mock('@tauri-apps/plugin-autostart', () => ({
  isEnabled: () => backend.isEnabled(),
  enable: () => backend.enable(),
  disable: () => backend.disable(),
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
let storage: WtLiveStorage;
/** What `check_update` answers, or the error it throws. */
let updateFeed: UpdateInfo | AppError;
/** What `atelier_cutout_status` answers (null: the command fails, the row stays hidden). */
let cutout: CutoutStatus | null;

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
      case 'wtlive_storage':
        return storage;
      case 'wtlive_clear_cache':
        storage = { ...storage, cacheBytes: 0 };
        return storage;
      case 'wtlive_unhide_all':
        storage = { ...storage, hiddenCount: 0 };
        return storage;
      case 'check_update':
        if ('code' in updateFeed) throw updateFeed;
        return updateFeed;
      case 'install_update':
        // The real command closes Livery; here it just never answers.
        return new Promise(() => {});
      case 'atelier_cutout_status':
        if (!cutout) throw { code: 'internal', message: 'no cutout' } satisfies AppError;
        return cutout;
      case 'atelier_cutout_remove':
        cutout = { runtime: false, model: false, bytes: 0, downloadBytes: 236_069_933, pendingRemoval: true };
        return cutout;
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
      <ConfirmDialog />
    </>
  );
}

function renderSettings(section?: SettingsSection, initial: Partial<SettingsData> = {}, { strict = false } = {}) {
  settings = { ...DEFAULT_SETTINGS, onboarded: true, gamePath: GAME, gameSource: 'steam', ...initial };
  if (section) useSettingsUi.setState({ section });
  const user = userEvent.setup();
  const view = renderWithProviders(
    strict ? (
      <StrictMode>
        <Harness />
      </StrictMode>
    ) : (
      <Harness />
    ),
    { settings },
  );
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
  backend.openUrl.mockReset().mockResolvedValue(undefined);
  backend.revealItemInDir.mockReset().mockResolvedValue(undefined);
  backend.autostart.enabled = false;
  backend.autostart.fail = null;
  backend.isEnabled.mockReset().mockImplementation(() => Promise.resolve(backend.autostart.enabled));
  backend.enable.mockReset().mockImplementation(async () => {
    if (backend.autostart.fail) throw backend.autostart.fail;
    backend.autostart.enabled = true;
  });
  backend.disable.mockReset().mockImplementation(async () => {
    if (backend.autostart.fail) throw backend.autostart.fail;
    backend.autostart.enabled = false;
  });
  backups = [...BACKUPS];
  failSetSettings = null;
  storage = { cacheBytes: 12 * MB, hiddenCount: 3 };
  updateFeed = { current: '0.2.0', ready: false };
  cutout = null;
  resetDecalUi();
  setCutoutBusy(false);
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
    expect(tabs.map((t) => t.textContent)).toEqual(['General', 'Game', 'Conflicts', 'Backups', 'WT Live', 'Language', 'Updates', 'Atelier', 'About']);
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

  it('Start with Windows turns the Windows entry on and off, then saves the setting', async () => {
    const { user } = renderSettings('general');
    const toggle = screen.getByRole('switch', { name: 'Start with Windows' });
    expect(toggle).not.toHaveAttribute('aria-disabled');
    expect(toggle).toHaveAccessibleDescription('Livery opens when you sign in to Windows.');
    // Reconciled on open: the plugin and the setting agree, so nothing is saved.
    await waitFor(() => expect(backend.isEnabled).toHaveBeenCalledTimes(1));
    expect(calls('set_settings')).toHaveLength(0);

    await user.click(toggle);
    await waitFor(() => expect(settings.startWithWindows).toBe(true));
    expect(backend.enable).toHaveBeenCalledTimes(1);
    expect(backend.autostart.enabled).toBe(true);
    expect(calls('set_settings')).toEqual([['set_settings', { patch: { startWithWindows: true } }]]);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    await user.click(toggle);
    await waitFor(() => expect(settings.startWithWindows).toBe(false));
    expect(backend.disable).toHaveBeenCalledTimes(1);
    expect(backend.autostart.enabled).toBe(false);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });

  it('Start with Windows: the plugin wins over a stale setting when General opens', async () => {
    // Saved as on, but the Run entry was removed (Task Manager, Startup apps).
    renderSettings('general', { startWithWindows: true });
    await waitFor(() => expect(calls('set_settings')).toEqual([['set_settings', { patch: { startWithWindows: false } }]]));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Start with Windows' })).toHaveAttribute('aria-checked', 'false'));
    expect(settings.startWithWindows).toBe(false);
    expect(backend.enable).not.toHaveBeenCalled();
    expect(backend.disable).not.toHaveBeenCalled();
  });

  it('Start with Windows: the reconcile survives StrictMode’s double effects', async () => {
    renderSettings('general', { startWithWindows: true }, { strict: true });
    await waitFor(() => expect(calls('set_settings')).toEqual([['set_settings', { patch: { startWithWindows: false } }]]));
    expect(backend.isEnabled).toHaveBeenCalledTimes(1);
  });

  it('Start with Windows: a toggle made while the first read is in flight wins over that read', async () => {
    let answer: (enabled: boolean) => void = () => {};
    backend.isEnabled.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const { user } = renderSettings('general');
    await waitFor(() => expect(backend.isEnabled).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('switch', { name: 'Start with Windows' }));
    await waitFor(() => expect(settings.startWithWindows).toBe(true));
    // The read started before the toggle: it says "off", which is no longer true.
    await act(async () => answer(false));
    expect(calls('set_settings')).toEqual([['set_settings', { patch: { startWithWindows: true } }]]);
    expect(screen.getByRole('switch', { name: 'Start with Windows' })).toHaveAttribute('aria-checked', 'true');
  });

  it('Start with Windows: turning off an entry that is already gone counts as done', async () => {
    // Saved as on, the read failed (so no reconcile), and the Run entry is missing: disable fails.
    backend.isEnabled.mockRejectedValueOnce(new Error('registry unavailable'));
    backend.disable.mockRejectedValueOnce('The system cannot find the file specified. (os error 2)');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { user } = renderSettings('general', { startWithWindows: true });
    await waitFor(() => expect(backend.isEnabled).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('switch', { name: 'Start with Windows' }));
    await waitFor(() => expect(settings.startWithWindows).toBe(false));
    expect(messages()).toEqual([]);
    warn.mockRestore();
  });

  it('Start with Windows: a failure says so and the switch goes back', async () => {
    backend.autostart.fail = 'Access is denied. (os error 5)';
    const { user } = renderSettings('general');
    const toggle = screen.getByRole('switch', { name: 'Start with Windows' });
    await waitFor(() => expect(backend.isEnabled).toHaveBeenCalled());
    await user.click(toggle);
    await waitFor(() => expect(messages()).toEqual(['Couldn’t change Start with Windows: Access is denied. (os error 5)']));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(calls('set_settings')).toHaveLength(0);
    expect(settings.startWithWindows).toBe(false);
  });

  it('summarises the keyboard shortcuts with key caps (1–5 with Atelier hidden)', () => {
    renderSettings('general', { atelierEnabled: false });
    const list = screen.getByRole('list');
    expect(list.textContent?.replace(/\s+/g, ' ')).toBe(
      'Ctrl K search · 1–5 sections · [ ] sidebar · Ctrl + − interface size · Ctrl Z undo · Esc close',
    );
    expect(within(list).getByText('Ctrl K').tagName).toBe('KBD');
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  });

  it('Interface size: picks a step, kept in the UI store (not the backend settings)', async () => {
    const { user } = renderSettings('general');
    const group = screen.getByRole('radiogroup', { name: 'Interface size' });
    expect(group).toHaveAccessibleDescription(/Ctrl 0 resets/);
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['80%', '90%', '100%', '110%', '125%', '150%']);
    expect(within(group).getByRole('radio', { name: '100%' })).toBeChecked();
    await user.click(within(group).getByRole('radio', { name: '125%' }));
    expect(useUi.getState().zoom).toBe(1.25);
    expect(within(group).getByRole('radio', { name: '125%' })).toBeChecked();
    act(() => useUi.getState().setZoom(0.9));
    expect(within(group).getByRole('radio', { name: '90%' })).toBeChecked();
    expect(calls('set_settings')).toHaveLength(0);
  });

  it('counts Atelier among the sections while it is on', () => {
    renderSettings('general', { atelierEnabled: true });
    expect(screen.getByRole('list').textContent).toContain('1–6 sections');
  });
});

// ── Game ────────────────────────────────────────────────────────────────────

describe('Settings · Game', () => {
  it('turns reading data from the game off and on', async () => {
    const { user } = renderSettings('game');
    const read = await screen.findByRole('switch', { name: 'Read data from the game' });
    expect(read).toBeChecked();
    expect(read).toHaveAccessibleDescription(/without changing them/);
    await user.click(read);
    await waitFor(() => expect(settings.readGameData).toBe(false));
    expect(calls('set_settings')[0]?.[1]).toEqual({ patch: { readGameData: false } });
    expect(read).not.toBeChecked();
  });

  it('shows the install, hides its path until asked, and Change opens First run on the folder picker', async () => {
    const { user, unmount } = renderSettings('game');
    expect(screen.getByText('War Thunder · Steam')).toBeInTheDocument();
    expect(screen.getByText(GAME)).not.toBeVisible();
    expect(screen.getByText(GAME)).toHaveAttribute('data-selectable');
    const reveal = screen.getByRole('button', { name: 'Show path', description: 'War Thunder · Steam' });
    await user.click(reveal);
    expect(screen.getByText(GAME)).toBeVisible();
    expect(reveal).toHaveAttribute('aria-expanded', 'true');

    // Show in Explorer opens the folder without showing the path.
    await user.click(reveal);
    await user.click(screen.getByRole('button', { name: 'Show in Explorer', description: 'War Thunder · Steam' }));
    await waitFor(() => expect(backend.revealItemInDir).toHaveBeenCalledWith(GAME));
    expect(screen.getByText(GAME)).not.toBeVisible();

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
    await user.click(screen.getByRole('button', { name: 'Show in Explorer', description: 'Watched folder' }));
    await waitFor(() => expect(backend.revealItemInDir).toHaveBeenCalledWith('E:\\Skins\\Incoming'));
  });

  it('the default Downloads folder has no path to show; a folder that can’t be shown says so', async () => {
    backend.revealItemInDir.mockRejectedValue('The system cannot find the path specified.');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { user } = renderSettings('game');
    // Only the game row has the links.
    expect(screen.getAllByRole('button', { name: 'Show in Explorer' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Show in Explorer' }));
    await waitFor(() => expect(messages()).toEqual(['Couldn’t open that folder in Explorer.']));
    warn.mockRestore();
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
    expect(toggle).toHaveAccessibleDescription('Replaced skins are kept for 30 days, deleted ones until their Undo notice closes.');
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

// ── WT Live ─────────────────────────────────────────────────────────────────

describe('Settings · WT Live', () => {
  it('Browse WT Live patches wtliveEnabled', async () => {
    const { user } = renderSettings('wtlive');
    expect(within(panel()).getByRole('heading', { level: 2, name: 'WT Live' })).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Browse WT Live' });
    expect(toggle).toHaveAccessibleDescription(
      'Explore, Following and installs from WT Live. Turn it off and Livery sends no requests to WT Live.',
    );
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(settings.wtliveEnabled).toBe(false));
    await user.click(toggle);
    await waitFor(() => expect(settings.wtliveEnabled).toBe(true));
    expect(calls('set_settings')).toEqual([
      ['set_settings', { patch: { wtliveEnabled: false } }],
      ['set_settings', { patch: { wtliveEnabled: true } }],
    ]);
    expect(screen.getByText('Skins and images belong to their authors on WT Live.')).toBeInTheDocument();
  });

  it('shows the cache size and clears it with a plain toast (no Undo)', async () => {
    const { user } = renderSettings('wtlive');
    expect(await screen.findByText('12 MB')).toBeInTheDocument();
    expect(screen.getByText('Pages and archives fetched from WT Live are kept for up to 24 hours.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear cache' }));
    expect(await screen.findByText('0 B')).toBeInTheDocument();
    expect(calls('wtlive_clear_cache')).toHaveLength(1);
    expect(messages()).toEqual(['WT Live cache cleared']);
    expect(useToasts.getState().toasts[0]?.onUndo).toBeUndefined();
  });

  it('Show them again brings the hidden skins back, and is unavailable at 0', async () => {
    const { user } = renderSettings('wtlive');
    const showAgain = screen.getByRole('button', { name: 'Show them again' });
    // Unknown until the counts arrive.
    expect(showAgain).toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByText('3 skins')).toBeInTheDocument();
    expect(showAgain).not.toHaveAttribute('aria-disabled');
    await user.click(showAgain);
    expect(await screen.findByText('0 skins')).toBeInTheDocument();
    expect(messages()).toEqual(['Hidden skins are back in Explore']);
    expect(showAgain).toHaveAttribute('aria-disabled', 'true');
    // Stays focusable, and does nothing at 0.
    expect(showAgain).toHaveFocus();
    await user.click(showAgain);
    expect(calls('wtlive_unhide_all')).toHaveLength(1);
  });

  it('works without WT Live: the counts are local', async () => {
    renderSettings('wtlive', { wtliveEnabled: false });
    expect(screen.getByRole('switch', { name: 'Browse WT Live' })).not.toBeChecked();
    expect(await screen.findByText('3 skins')).toBeInTheDocument();
    expect(calls('wtlive_storage')).toHaveLength(1);
  });
});

// ── Atelier ─────────────────────────────────────────────────────────────────

const ATELIER_HELPER = 'Create skins on a 3D model of your vehicle. Turned off, Atelier leaves the sidebar and Livery doesn’t read the vehicles’ models.';

describe('Settings · Atelier', () => {
  it('Show Atelier is on by default and patches atelierEnabled', async () => {
    const { user, container } = renderSettings('atelier');
    expect(within(panel()).getByRole('heading', { level: 2, name: 'Atelier' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Atelier' })).toHaveAttribute('aria-selected', 'true');
    const toggle = screen.getByRole('switch', { name: 'Show Atelier' });
    expect(toggle).toHaveAccessibleDescription(ATELIER_HELPER);
    expect(toggle).toBeChecked();
    expect(screen.queryByText(/Experimental/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Game settings' })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(settings.atelierEnabled).toBe(false));
    expect(calls('set_settings')).toEqual([['set_settings', { patch: { atelierEnabled: false } }]]);
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('with Read data from the game off, explains why and links to Game', async () => {
    const { user } = renderSettings('atelier', { readGameData: false, atelierEnabled: true });
    const toggle = screen.getByRole('switch', { name: 'Show Atelier' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(`${ATELIER_HELPER} Atelier reads your vehicles’ models from the game: turn on Read data from the game to use it.`);
    await user.click(screen.getByRole('button', { name: 'Open Game settings' }));
    expect(useSettingsUi.getState().section).toBe('game');
    expect(useUi.getState().screen).toBe('settings');
    expect(screen.getByRole('tab', { name: 'Game' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Settings · Atelier · background removal files', () => {
  const READY: CutoutStatus = { runtime: true, model: true, bytes: 190 * MB, downloadBytes: 0, pendingRemoval: false };

  it('is not shown, nor queried, while Atelier is off; turning it on shows the row', async () => {
    cutout = READY;
    const { user } = renderSettings('atelier', { atelierEnabled: false });
    expect(screen.getByRole('switch', { name: 'Show Atelier' })).not.toBeChecked();
    expect(screen.queryByText('Background removal files')).not.toBeInTheDocument();
    expect(calls('atelier_cutout_status')).toHaveLength(0);
    await user.click(screen.getByRole('switch', { name: 'Show Atelier' }));
    expect(await screen.findByText('190 MB on this PC (ONNX Runtime and the isnet-anime model).')).toBeInTheDocument();
    expect(calls('atelier_cutout_status')).toHaveLength(1);
  });

  it('says the files aren’t downloaded yet, with nothing to remove', async () => {
    cutout = { runtime: false, model: false, bytes: 0, downloadBytes: 225 * MB, pendingRemoval: false };
    renderSettings('atelier', { atelierEnabled: true });
    expect(await screen.findByText('Not downloaded. Atelier asks before downloading them (225 MB) the first time you remove a background.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('shows their size and removes them after asking; a runtime in use finishes at the next start', async () => {
    cutout = READY;
    const { user, container } = renderSettings('atelier', { atelierEnabled: true });
    expect(await screen.findByText('190 MB on this PC (ONNX Runtime and the isnet-anime model).')).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const ask = screen.getByRole('alertdialog', { name: 'Remove the background-removal files?' });
    expect(ask).toHaveAccessibleDescription(/This frees 190 MB/);
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(calls('atelier_cutout_remove')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls('atelier_cutout_remove')).toHaveLength(1));
    expect(await within(panel()).findByText('Removed. This finishes the next time Livery starts.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('Remove waits while a download or a cutout runs', async () => {
    cutout = READY;
    setCutoutBusy(true);
    renderSettings('atelier', { atelierEnabled: true });
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeDisabled();
    act(() => setCutoutBusy(false));
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});

// ── Language ────────────────────────────────────────────────────────────────

describe('Settings · Language', () => {
  it('lists every language in itself and switches the UI at once', async () => {
    const { user } = renderSettings('language');
    const group = screen.getByRole('radiogroup', { name: 'Language' });
    const names = within(group).getAllByRole('radio').map((r) => r.textContent);
    expect(names).toEqual(['English', 'Italiano', 'Deutsch', 'Русский', 'Français', 'Español', 'Polski', 'Português (Brasil)', '简体中文']);
    expect(within(group).getByRole('radio', { name: 'English' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Deutsch' })).not.toHaveAccessibleDescription();
    expect(within(group).getByText('Русский')).toHaveAttribute('lang', 'ru');
    expect(within(group).getByText('简体中文')).toHaveAttribute('lang', 'zh-CN');

    await user.click(within(group).getByRole('radio', { name: 'Italiano' }));
    expect(await screen.findByRole('heading', { name: 'Lingua' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Generale' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('it');
    expect(settings.language).toBe('it');

    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('heading', { name: 'Sprache' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Allgemein' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Deutsch' })).toBeChecked();
    expect(document.documentElement.lang).toBe('de');
    expect(settings.language).toBe('de');
  });
});

// ── Updates ─────────────────────────────────────────────────────────────────

describe('Settings · Updates', () => {
  it('checks now and says when Livery is up to date', async () => {
    const { user } = renderSettings('updates');
    expect(await screen.findByText('Livery 0.2.0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Livery 0.2.0 · You’re up to date.')).toBeInTheDocument();
    expect(calls('check_update')).toHaveLength(1);
  });

  it('offers a newer version, then shows the download and the install', async () => {
    updateFeed = { current: '0.2.0', latest: '0.3.0', ready: false };
    const { user } = renderSettings('updates');
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Livery 0.3.0 is available')).toBeInTheDocument();
    const install = screen.getByRole('button', { name: 'Install and restart' });
    expect(install).toHaveAccessibleDescription('You have 0.2.0.');
    await user.click(install);
    expect(calls('install_update')).toHaveLength(1);
    expect(screen.getByText('Downloading Livery 0.3.0')).toBeInTheDocument();

    act(() => useUpdate.getState().progress({ downloaded: 450, total: 1000 }));
    const bar = screen.getByRole('progressbar', { name: 'Downloading Livery 0.3.0' });
    expect(bar).toHaveAttribute('aria-valuenow', '45');
    expect(screen.getByText('Livery closes and opens again when it’s done.')).toBeInTheDocument();

    act(() => useUpdate.getState().progress({ downloaded: 1000, total: 1000 }));
    expect(screen.getByText('Installing Livery 0.3.0…')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('a version downloaded in the background installs on restart or on close', async () => {
    const { user } = renderSettings('updates', { autoUpdate: true });
    await screen.findByText('Livery 0.2.0');
    act(() => useUpdate.getState().progress({ downloaded: 10, total: undefined }));
    expect(screen.getByText('In the background. It installs when you close Livery.')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');

    act(() => useUpdate.getState().ready('0.3.0'));
    expect(screen.getByText('Livery 0.3.0 is ready')).toBeInTheDocument();
    const restart = screen.getByRole('button', { name: 'Restart and update' });
    expect(restart).toHaveAccessibleDescription('It installs when you close Livery.');
    await user.click(restart);
    expect(calls('install_update')).toHaveLength(1);
    expect(screen.getByText('Installing Livery 0.3.0…')).toBeInTheDocument();
  });

  it('shows a failed check in the user’s words and lets them try again', async () => {
    updateFeed = { code: 'network', message: "Livery couldn't check for updates", detail: 'dns' };
    const { user } = renderSettings('updates');
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText("Livery couldn't check for updates")).toBeInTheDocument();
    updateFeed = { current: '0.2.0', ready: false };
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Livery 0.2.0 · You’re up to date.')).toBeInTheDocument();
  });

  it('turns automatic updates on and off', async () => {
    const { user } = renderSettings('updates', { autoUpdate: true });
    const auto = await screen.findByRole('switch', { name: 'Install updates automatically' });
    expect(auto).toBeChecked();
    expect(auto).toHaveAccessibleDescription('Downloads new versions in the background and installs them when you close Livery.');
    await user.click(auto);
    await waitFor(() => expect(settings.autoUpdate).toBe(false));
    expect(calls('set_settings')[0]?.[1]).toEqual({ patch: { autoUpdate: false } });
    expect(auto).not.toBeChecked();
  });

  it('falls back to the package version when the app version is unavailable', async () => {
    backend.getVersion.mockRejectedValue(new Error('no app'));
    renderSettings('updates');
    expect(await screen.findByText(`Livery ${PACKAGE_VERSION}`)).toBeInTheDocument();
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
    expect(source).not.toHaveAttribute('aria-disabled');
    expect(source).toHaveAccessibleDescription('Opens Livery’s repository on GitHub');
    expect(screen.getByRole('button', { name: 'Send feedback' })).toHaveAccessibleDescription('Report a bug or suggest an idea on GitHub');
    expect(panel()).toHaveTextContent('“Send feedback” only opens a GitHub page in your browser: nothing is sent until you submit it there.');
    expect(panel().querySelector('img, svg')).toBeNull();
  });

  it('Source code opens the GitHub repository; Send feedback opens the feedback dialog', async () => {
    const { user } = renderSettings('about');
    await user.click(screen.getByRole('button', { name: 'Source code' }));
    await waitFor(() => expect(backend.openUrl).toHaveBeenCalledWith('https://github.com/Pier144/Livery'));
    expect(useFeedback.getState().open).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(useFeedback.getState().open).toBe(true);
    expect(backend.openUrl).toHaveBeenCalledTimes(1);
    expect(messages()).toEqual([]);
    useFeedback.setState({ open: false });
  });

  it('lists every third-party licence from the generated files, read only when opened', async () => {
    const fetchMock = vi.fn(async (path: string) => ({
      ok: path === 'licenses/rust.txt',
      status: path === 'licenses/rust.txt' ? 200 : 404,
      text: async () => 'MIT License: 277 crate(s)',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { user } = renderSettings('about');
    await user.click(screen.getByRole('button', { name: 'Licenses' }));
    const dialog = screen.getByRole('dialog', { name: 'Licenses' });
    expect(within(dialog).getByText('Desktop app: every Rust crate')).toBeInTheDocument();
    const onDemand = within(dialog).getByRole('region', { name: 'Downloaded on demand' });
    expect(within(onDemand).getByText('ONNX Runtime · Microsoft')).toBeInTheDocument();
    expect(within(onDemand).getByText('Apache-2.0')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    const [rust, javascript] = within(dialog).getAllByRole('button', { name: 'Show license text' }).slice(-2) as [HTMLElement, HTMLElement];
    await user.click(rust);
    expect(fetchMock).toHaveBeenCalledWith('licenses/rust.txt');
    expect(await within(dialog).findByText('MIT License: 277 crate(s)')).toBeInTheDocument();
    await user.click(javascript);
    expect(
      await within(dialog).findByText('This list is generated when the app is built; it isn’t in this development build.'),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
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
    const toggles = within(dialog).getAllByRole('button', { name: 'Show license text' });
    expect(toggles).toHaveLength(7);
    const [geist, plex, zstd, awsLc, ooz, rust, javascript] = toggles as HTMLElement[] as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(within(dialog).getByText('AWS-LC · Amazon.com, Inc.')).toBeInTheDocument();
    for (const lib of ['reqwest · hyper', 'rustls']) expect(within(dialog).getByText(lib)).toBeInTheDocument();
    // The notices bundled native code requires: zstd's BSD text. No UnRAR code ships (RAR is
    // decoded by the user's 7-Zip or WinRAR), so there is no UnRAR licence either.
    expect(within(dialog).getByText('BSD-3-Clause')).toBeInTheDocument();
    expect(within(dialog).queryByText(/UnRAR/)).toBeNull();
    // ooz (via oozextract) is GPL-3.0-or-later, which is why Livery is too: both are stated.
    expect(within(dialog).getByText('ooz · Powzix (Rust port: oozextract)')).toBeInTheDocument();
    expect(within(dialog).getByText('GPL-3.0-or-later')).toBeInTheDocument();
    expect(within(dialog).getByText(/GNU General Public License v3\.0 or later/)).toBeInTheDocument();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(geist).toHaveFocus();
    await user.tab();
    expect(plex).toHaveFocus();
    await user.tab();
    expect(zstd).toHaveFocus();
    await user.tab();
    expect(awsLc).toHaveFocus();
    await user.tab();
    expect(ooz).toHaveFocus();
    await user.tab();
    expect(rust).toHaveFocus();
    await user.tab();
    expect(javascript).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(javascript).toHaveFocus();

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
