import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { CommandPalette } from './CommandPalette';

const open = () => act(() => useUi.getState().openPalette());
const dialog = () => screen.getByRole('dialog', { name: 'Command palette' });
const input = () => screen.getByRole('combobox', { name: 'Command' });
const options = () => within(screen.getByRole('listbox')).queryAllByRole('option');
const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true');

describe('CommandPalette', () => {
  beforeEach(() => resetStores());

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

  it('has no serious axe violations with results and with no matches', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<CommandPalette />);
    open();
    expect(await seriousViolations(container)).toEqual([]);
    await user.keyboard('zzzz');
    expect(await seriousViolations(container)).toEqual([]);
  });
});
