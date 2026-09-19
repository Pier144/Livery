import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import en from '@/i18n/en.json';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '@/queries/settings';
import { toast } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';

const tauri = vi.hoisted(() => ({
  enabled: false,
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

// Off by default (browser behaviour); one test turns it on to make `get_settings` fail.
vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => tauri.enabled,
  call: (cmd: string, args?: Record<string, unknown>) => tauri.call(cmd, args),
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

// The shell is under test here, not the First run flow (it has its own tests).
vi.mock('@/screens/FirstRun/FirstRun', async () => {
  const { createElement } = await import('react');
  return { FirstRun: () => createElement('p', null, 'First run stub') };
});

const SECTION_AND_SIDEBAR_KEYS = ['1', '2', '3', '4', '5', ',', '[', ']'];

describe('App shell (M1 chrome)', () => {
  beforeEach(() => resetStores());

  it('renders the chrome landmarks and the Explore placeholder', () => {
    renderWithProviders(<App />, { settings: { onboarded: true } });
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByText('LIVERY')).toBeInTheDocument();
  });

  it('has no serious axe violations in the default, collapsed and offline states', async () => {
    const { container } = renderWithProviders(<App />, { settings: { onboarded: true } });
    expect(await seriousViolations(container)).toEqual([]);
    act(() => {
      useUi.getState().setSidebarOpen(false);
      useUi.getState().setOnline(false);
    });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('has no serious axe violations with the palette, a toast and the drop overlay visible', async () => {
    const { container } = renderWithProviders(<App />, { settings: { onboarded: true } });
    act(() => {
      useUi.getState().openPalette();
      useUi.getState().setDragActive(true);
      toast.undoable('Deleted 3 skins', () => {});
    });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('switches sections from the keyboard and from the sidebar', () => {
    renderWithProviders(<App />, { settings: { onboarded: true } });
    fireEvent.keyDown(window, { key: '2' });
    expect(useUi.getState().screen).toBe('hangar');
    expect(screen.getByRole('main')).toHaveAccessibleName('My Hangar');
    const nav = screen.getByRole('navigation');
    fireEvent.click(within(nav).getByRole('button', { name: /Install queue/ }));
    expect(useUi.getState().screen).toBe('queue');
  });

  it('opens the palette from the title bar search and jumps to a section', () => {
    renderWithProviders(<App />, { settings: { onboarded: true } });
    fireEvent.click(screen.getByRole('button', { name: /Search skins, vehicles, authors/ }));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'settings' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useUi.getState().screen).toBe('settings');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('App boot and First run gating (M2)', () => {
  beforeEach(() => resetStores());

  afterEach(() => {
    tauri.enabled = false;
    tauri.call.mockReset();
  });

  it('shows only the title bar and an empty ruled main while settings load', async () => {
    renderWithProviders(<App />);
    const main = screen.getByRole('main');
    expect(main).toHaveAccessibleName(en.common.loading);
    expect(main).toHaveAttribute('aria-busy', 'true');
    expect(main).toHaveClass('bg-grid');
    expect(main).toBeEmptyDOMElement();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    // Outside Tauri the settings are the defaults: a fresh install.
    await waitFor(() => expect(main).toHaveAccessibleName(en.firstRun.label));
    expect(main).not.toHaveAttribute('aria-busy');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('opens First run full-width on a fresh install', async () => {
    const { container } = renderWithProviders(<App />, { settings: {} });
    expect(useUi.getState().screen).toBe('firstRun');
    expect(screen.getByRole('main')).toHaveAccessibleName(en.firstRun.label);
    expect(screen.getByText('First run stub')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it.each([
    ['onboarding is done', { onboarded: true }],
    ['a game folder is already set', { gamePath: 'D:\\Games\\War Thunder' }],
  ])('opens on Explore when %s', (_, settings) => {
    renderWithProviders(<App />, { settings });
    expect(useUi.getState().screen).toBe('explore');
    expect(screen.getByRole('main')).toHaveAccessibleName('Explore');
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('ignores section and sidebar keys during First run; Ctrl+K and Esc still work', async () => {
    const { container } = renderWithProviders(<App />, { settings: {} });
    for (const key of SECTION_AND_SIDEBAR_KEYS) fireEvent.keyDown(window, { key });
    expect(useUi.getState().screen).toBe('firstRun');
    expect(useUi.getState().sidebarOpen).toBe(true);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks for the game folder in the drop overlay while First run registers a folder drop', async () => {
    const { container } = renderWithProviders(<App />, { settings: {} });
    act(() => {
      useUi.getState().setFolderDrop(() => {});
      useUi.getState().setDragActive(true);
    });
    expect(screen.getByText(en.firstRun.notFound.dropOverlay)).toBeInTheDocument();
    expect(screen.queryByText(en.common.drop.title)).not.toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('never overrides navigation after boot', () => {
    const { client } = renderWithProviders(<App />, { settings: {} });
    expect(useUi.getState().screen).toBe('firstRun');
    // First run finishing: onboarded is saved, then it goes to Explore.
    act(() => {
      client.setQueryData(SETTINGS_KEY, { ...DEFAULT_SETTINGS, onboarded: true, gamePath: 'D:\\WT' });
      useUi.getState().go('explore');
    });
    expect(screen.getByRole('main')).toHaveAccessibleName('Explore');
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    // Settings changing again later (e.g. the game folder cleared) keeps the user where they are.
    act(() => useUi.getState().go('hangar'));
    act(() => client.setQueryData(SETTINGS_KEY, { ...DEFAULT_SETTINGS }));
    expect(useUi.getState().screen).toBe('hangar');
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('shows First run without the sidebar when opened later (Settings → change game folder)', () => {
    renderWithProviders(<App />, { settings: { onboarded: true, gamePath: 'D:\\WT' } });
    act(() => useUi.getState().go('firstRun'));
    expect(screen.getByRole('main')).toHaveAccessibleName(en.firstRun.label);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    act(() => useUi.getState().go('settings'));
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('decides the start screen once, even when StrictMode replays effects', () => {
    const go = useUi.getState().go;
    const spy = vi.fn(go);
    useUi.setState({ go: spy });
    try {
      renderWithProviders(
        <StrictMode>
          <App />
        </StrictMode>,
        { settings: {} },
      );
      expect(spy.mock.calls).toEqual([['firstRun']]);
    } finally {
      useUi.setState({ go });
    }
  });

  it('opens the app instead of First run when settings cannot be read', async () => {
    tauri.enabled = true;
    tauri.call.mockRejectedValue({ code: 'io', message: 'settings.json unreadable' });
    renderWithProviders(<App />);
    await waitFor(() => expect(screen.getByRole('main')).toHaveAccessibleName('Explore'));
    expect(tauri.call).toHaveBeenCalledWith('get_settings', undefined);
    expect(useUi.getState().screen).toBe('explore');
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });
});
