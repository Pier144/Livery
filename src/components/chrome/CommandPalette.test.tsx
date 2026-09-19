import { act, screen, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useScreenFocus } from '@/hooks/useScreenFocus';
import { createQueryClient } from '@/queries/client';
import { WTLIVE_KEY } from '@/queries/wtlive';
import { useExplore } from '@/store/explore';
import { useUi } from '@/store/ui';
import type { SearchResult, WtLiveSkin } from '@/types';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { CommandPalette } from './CommandPalette';

const open = () => act(() => useUi.getState().openPalette());
const dialog = () => screen.getByRole('dialog', { name: 'Command palette' });
const input = () => screen.getByRole('combobox', { name: 'Command' });
const options = () => within(screen.getByRole('listbox')).queryAllByRole('option');
const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true');

const wtSkin = (id: string, name: string): WtLiveSkin => ({
  id,
  name,
  vehicle: { code: 'germ_leopard_2a6', name: 'Leopard 2A6', nation: 'GER', type: 'ground', class: 'MBT' },
  author: { id: 'kessler_wolf', name: 'Kessler_Wolf', url: 'https://example.invalid' },
  category: 'Historical',
  downloads: 1,
  likes: 1,
  postedAt: '2026-04-18T10:00:00Z',
  sizeBytes: 1,
  images: [],
  postUrl: '',
  downloadUrl: '',
});

describe('CommandPalette', () => {
  beforeEach(() => {
    resetStores();
  });

  it('a vehicle result opens Explore filtered by that vehicle', async () => {
    const user = userEvent.setup();
    act(() => useUi.getState().go('hangar'));
    renderWithProviders(<CommandPalette />);
    open();
    await user.keyboard('ariete{Enter}');
    expect(useUi.getState().screen).toBe('explore');
    expect(useExplore.getState()).toMatchObject({ tab: 'explore', vehicle: 'it_c1_ariete' });
  });

  it('skin results come from the cached WT Live results and open the Skin detail', async () => {
    const user = userEvent.setup();
    const client = createQueryClient();
    const page: SearchResult = { items: [wtSkin('s4', 'Bundeswehr Flecktarn'), wtSkin('s14', 'Baltic Winter')], total: 2, tookMs: 20 };
    client.setQueryData([...WTLIVE_KEY, 'search-pages', { sort: 'downloads' }], { pages: [page], pageParams: [0] });
    renderWithProviders(<CommandPalette />, { client });
    open();
    await user.keyboard('leopard');
    expect(options().map((o) => o.textContent)).toEqual([
      'SkinBundeswehr FlecktarnLeopard 2A6 · Kessler_Wolf',
      'SkinBaltic WinterLeopard 2A6 · Kessler_Wolf',
      'VehicleLeopard 2A6germ_leopard_2a6',
    ]);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(useUi.getState()).toMatchObject({ screen: 'detail', detailSkinId: 's14' });
    expect(useUi.getState().palette.open).toBe(false);
  });

  it('renders only while open', () => {
    renderWithProviders(<CommandPalette />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    open();
    expect(dialog()).toHaveAttribute('aria-modal', 'true');
    act(() => useUi.getState().closePalette());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('focuses the input and shows 5 actions + 4 vehicles for an empty query', () => {
    renderWithProviders(<CommandPalette />);
    open();
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('placeholder', 'Jump to a vehicle, skin or action…');
    expect(options()).toHaveLength(9);
    expect(options()[0]).toHaveTextContent('Go to Explore');
    expect(selected()).toBe(options()[0]);
    expect(screen.getByText('↑↓ navigate')).toBeInTheDocument();
  });

  it('filters as you type and Enter runs the match', async () => {
    const user = userEvent.setup();
    act(() => useUi.getState().go('settings'));
    renderWithProviders(<CommandPalette />);
    open();
    await user.keyboard('leo');
    expect(useUi.getState().palette.query).toBe('leo');
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent('Leopard 2A6');
    expect(options()[0]).toHaveTextContent('germ_leopard_2a6');
    await user.keyboard('{Enter}');
    expect(useUi.getState().screen).toBe('explore');
    expect(useUi.getState().palette.open).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ArrowDown/ArrowUp move the active row (clamped) and aria-activedescendant follows it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    open();
    expect(input()).toHaveAttribute('aria-activedescendant', options()[0]?.id);
    await user.keyboard('{ArrowUp}');
    expect(selected()).toBe(options()[0]);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(selected()).toHaveTextContent('Go to Collections');
    expect(input()).toHaveAttribute('aria-activedescendant', selected()?.id);
    await user.keyboard('{ArrowDown>12/}');
    expect(selected()).toBe(options()[8]);
    await user.keyboard('{ArrowUp}');
    expect(selected()).toBe(options()[7]);
    expect(input()).toHaveAttribute('aria-activedescendant', options()[7]?.id);
  });

  it('ArrowDown ×n + Enter navigates and closes the palette', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    open();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    expect(useUi.getState().screen).toBe('queue');
    expect(useUi.getState().palette.open).toBe(false);
  });

  it('Escape closes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    open();
    await user.keyboard('{Escape}');
    expect(useUi.getState().palette.open).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape inside the palette does not reach window-level handlers', async () => {
    const user = userEvent.setup();
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      renderWithProviders(<CommandPalette />);
      open();
      await user.keyboard('{Escape}');
      expect(useUi.getState().palette.open).toBe(false);
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('shows the section shortcut as the action hint and the code as the vehicle hint', () => {
    renderWithProviders(<CommandPalette />);
    open();
    expect(options()[0]).toHaveTextContent(/Action\s*Go to Explore\s*1/);
    expect(options()[5]).toHaveTextContent('Vehicle');
  });

  it('a click on the overlay closes; a click on the panel does not and keeps focus in the input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    open();
    await user.click(dialog());
    await user.click(screen.getByText('↵ open'));
    expect(useUi.getState().palette.open).toBe(true);
    expect(input()).toHaveFocus();
    await user.click(dialog().parentElement as HTMLElement);
    expect(useUi.getState().palette.open).toBe(false);
  });

  it('hovering a row makes it active; clicking it runs it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    open();
    const settings = screen.getByRole('option', { name: /Open Settings/ });
    await user.hover(settings);
    expect(selected()).toBe(settings);
    expect(input()).toHaveAttribute('aria-activedescendant', settings.id);
    await user.click(settings);
    expect(useUi.getState().screen).toBe('settings');
    expect(useUi.getState().palette.open).toBe(false);
  });

  it('shows "No matches" and no active descendant when nothing matches', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    open();
    await user.keyboard('zzzz');
    expect(options()).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('No matches');
    expect(input()).not.toHaveAttribute('aria-activedescendant');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(useUi.getState().palette.open).toBe(true);
    expect(useUi.getState().palette.index).toBe(0);
  });

  it('Tab and Shift+Tab keep focus in the input', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <button type="button">Outside</button>
        <CommandPalette />
      </>,
    );
    open();
    await user.tab();
    expect(input()).toHaveFocus();
    await user.tab({ shift: true });
    expect(input()).toHaveFocus();
  });

  it('returns focus to the element that opened it', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <button type="button" onClick={() => useUi.getState().openPalette()}>
          Search
        </button>
        <CommandPalette />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Search' });
    await user.click(opener);
    expect(input()).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('moves focus to the new screen’s heading after a result navigates, not back to the opener', async () => {
    const user = userEvent.setup();
    // App's shell in miniature: a heading per screen, the screen-focus hook and a persistent opener.
    function Shell() {
      useScreenFocus();
      const current = useUi((s) => s.screen);
      return (
        <>
          <button type="button" onClick={() => useUi.getState().openPalette()}>
            Search
          </button>
          <main>
            <h1 tabIndex={-1}>{`heading:${current}`}</h1>
          </main>
          <CommandPalette />
        </>
      );
    }
    renderWithProviders(<Shell />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.keyboard('settings{Enter}');
    expect(useUi.getState().screen).toBe('settings');
    expect(screen.getByRole('heading', { name: 'heading:settings' })).toHaveFocus();

    // Same screen, nothing opened: Escape hands focus back to the opener as before.
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus();
  });

  it('falls back to the screen heading when the opener is gone', async () => {
    const user = userEvent.setup();
    function Shell() {
      const [opener, setOpener] = useState(true);
      return (
        <>
          {opener && (
            <button type="button" onClick={() => useUi.getState().openPalette()}>
              Search
            </button>
          )}
          <main>
            <h1 tabIndex={-1}>Explore</h1>
          </main>
          <button type="button" onClick={() => setOpener(false)}>
            Drop opener
          </button>
          <CommandPalette />
        </>
      );
    }
    renderWithProviders(<Shell />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    act(() => screen.getByRole('button', { name: 'Drop opener' }).click());
    await user.keyboard('{Escape}');
    expect(screen.getByRole('heading', { name: 'Explore' })).toHaveFocus();
  });

  it('keeps the kind column and hints at 4.5:1: ink-4, and ink-3 on the highlighted row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    open();
    await user.keyboard('{ArrowDown}');
    const [first, second] = options();
    const kind = (o: HTMLElement | undefined) => o?.querySelector('span');
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(kind(second)).toHaveClass('text-ink-3');
    expect(kind(first)).toHaveClass('text-ink-4');
    expect(kind(first)).not.toHaveClass('text-ink-5');
    // The shortcut hint of the highlighted action brightens too.
    expect(within(second!).getByText('2')).toHaveClass('text-ink-3');
    expect(within(first!).getByText('1')).toHaveClass('text-ink-4');
    // Footer and Esc key cap: ink-4 on bg-3 (4.59:1), not ink-5 (3.4:1).
    expect(screen.getByText('↑↓ navigate').parentElement).toHaveClass('text-ink-4');
    expect(within(dialog()).getByText('Esc')).toHaveClass('text-ink-4');
  });

  it('has no serious axe violations with results and with no matches', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<CommandPalette />);
    open();
    expect(await seriousViolations(container)).toEqual([]);
    await user.keyboard('zzzz');
    expect(await seriousViolations(container)).toEqual([]);
  });
});
