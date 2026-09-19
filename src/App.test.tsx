import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { toast } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';

describe('App shell (M1 chrome)', () => {
  beforeEach(() => resetStores());

  it('renders the chrome landmarks and the Explore placeholder', () => {
    renderWithProviders(<App />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByText('LIVERY')).toBeInTheDocument();
  });

  it('has no serious axe violations in the default, collapsed and offline states', async () => {
    const { container } = renderWithProviders(<App />);
    expect(await seriousViolations(container)).toEqual([]);
    act(() => {
      useUi.getState().setSidebarOpen(false);
      useUi.getState().setOnline(false);
    });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('has no serious axe violations with the palette, a toast and the drop overlay visible', async () => {
    const { container } = renderWithProviders(<App />);
    act(() => {
      useUi.getState().openPalette();
      useUi.getState().setDragActive(true);
      toast.undoable('Deleted 3 skins', () => {});
    });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('switches sections from the keyboard and from the sidebar', () => {
    renderWithProviders(<App />);
    fireEvent.keyDown(window, { key: '2' });
    expect(useUi.getState().screen).toBe('hangar');
    expect(screen.getByRole('main')).toHaveAccessibleName('My Hangar');
    const nav = screen.getByRole('navigation');
    fireEvent.click(within(nav).getByRole('button', { name: /Install queue/ }));
    expect(useUi.getState().screen).toBe('queue');
  });

  it('opens the palette from the title bar search and jumps to a section', () => {
    renderWithProviders(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Search skins, vehicles, authors/ }));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'settings' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useUi.getState().screen).toBe('settings');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
